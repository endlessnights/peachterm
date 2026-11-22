//! One running SSH terminal session and the set of all of them.
//!
//! Data path (see docs/architecture.md): russh channel → coalescing task →
//! `Sink` (a Tauri `Channel` in the app) → xterm.js. The renderer acknowledges
//! what it has written; the task stops reading from the SSH channel while more
//! than [`MAX_OUTSTANDING`] bytes are unacknowledged, which makes russh stop
//! consuming from the socket, so a slow UI throttles the remote end instead of
//! growing memory without bound.

use super::client::{self, Connected, Deps, SshError, Target};
use super::{SessionState, TerminalEvent};
use crate::sessions::SessionId;
use base64::Engine;
use russh::ChannelMsg;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, OnceCell, mpsc};
use tokio::time::Instant;
use uuid::Uuid;

/// Unacknowledged bytes after which reading from the SSH channel pauses.
pub const MAX_OUTSTANDING: usize = 512 * 1024;
/// Output is batched up to this size or [`BATCH_DELAY`], whichever comes first.
pub const BATCH_BYTES: usize = 64 * 1024;
pub const BATCH_DELAY: Duration = Duration::from_millis(8);
/// While the application is locked, output is held (newest bytes win) up to this
/// size instead of reaching the renderer, and delivered after unlocking.
pub const HELD_LIMIT: usize = 256 * 1024;
const HOLD_RECHECK: Duration = Duration::from_millis(250);

pub trait Sink: Send + Sync + 'static {
    fn send(&self, event: TerminalEvent);
}

impl Sink for tauri::ipc::Channel<TerminalEvent> {
    fn send(&self, event: TerminalEvent) {
        let _ = tauri::ipc::Channel::send(self, event);
    }
}

pub fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn decode(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// Flow-control credit shared between the output task and `ssh_ack`.
#[derive(Default)]
pub struct Credits {
    outstanding: AtomicUsize,
    wake: Notify,
}

impl Credits {
    pub fn add(&self, n: usize) {
        self.outstanding.fetch_add(n, Ordering::SeqCst);
    }
    pub fn ack(&self, n: usize) {
        let mut cur = self.outstanding.load(Ordering::SeqCst);
        while let Err(actual) = self.outstanding.compare_exchange(
            cur,
            cur.saturating_sub(n),
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            cur = actual;
        }
        self.wake.notify_waiters();
    }
    pub fn outstanding(&self) -> usize {
        self.outstanding.load(Ordering::SeqCst)
    }
    fn has_room(&self) -> bool {
        self.outstanding() < MAX_OUTSTANDING
    }
}

pub enum Control {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

pub struct SshSession {
    pub id: SessionId,
    pub connection_id: Uuid,
    control: mpsc::Sender<Control>,
    pub credits: Arc<Credits>,
    /// Set once authenticated; SFTP opens its own channel on this transport.
    pub transport: OnceCell<Arc<client::Handle>>,
    state: Mutex<SessionState>,
    pub sftp: crate::sftp::SftpSlot,
}

impl SshSession {
    pub fn state(&self) -> SessionState {
        *self.state.lock().unwrap()
    }
    fn set_state(&self, s: SessionState) {
        *self.state.lock().unwrap() = s;
    }
    /// Never blocks the UI: input is queued (bounded) for the session task.
    pub async fn write(&self, data: Vec<u8>) -> bool {
        self.control.send(Control::Write(data)).await.is_ok()
    }
    pub async fn resize(&self, cols: u16, rows: u16) -> bool {
        let size = super::TerminalSize { cols, rows }.sanitized();
        self.control
            .send(Control::Resize {
                cols: size.cols,
                rows: size.rows,
            })
            .await
            .is_ok()
    }
    pub async fn close(&self) {
        let _ = self.control.send(Control::Close).await;
    }
}

pub struct StartParams {
    pub id: SessionId,
    pub connection_id: Uuid,
    pub target: Target,
    pub deps: Deps,
    pub cols: u16,
    pub rows: u16,
    /// Typed into the shell once it is up (`cd -- '<dir>'`), if configured.
    pub initial_directory: Option<String>,
    pub sink: Arc<dyn Sink>,
    /// Output is not forwarded to the renderer while this says "locked".
    pub lock: crate::lock::LockFlag,
    /// Called once the server accepted the credentials (not when merely connecting).
    pub on_authenticated: Arc<dyn Fn(SessionId) + Send + Sync>,
    /// Called exactly once when the session ends for any reason.
    pub on_end: Arc<dyn Fn(SessionId) + Send + Sync>,
}

/// Quote for a POSIX shell: `'` becomes `'\''`. Control characters are refused.
pub fn shell_quote(text: &str) -> Option<String> {
    if text.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(format!("'{}'", text.replace('\'', "'\\''")))
}

pub fn start(params: StartParams) -> Arc<SshSession> {
    let (tx, rx) = mpsc::channel(256);
    let session = Arc::new(SshSession {
        id: params.id,
        connection_id: params.connection_id,
        control: tx,
        credits: Arc::new(Credits::default()),
        transport: OnceCell::new(),
        state: Mutex::new(SessionState::Connecting),
        sftp: crate::sftp::SftpSlot::default(),
    });
    let task_session = session.clone();
    tokio::spawn(async move {
        let sink = params.sink.clone();
        let id = params.id;
        let reason = run(
            task_session.clone(),
            params.target,
            params.deps.clone(),
            params.cols,
            params.rows,
            params.initial_directory,
            sink.clone(),
            params.lock.clone(),
            params.on_authenticated.clone(),
            rx,
        )
        .await;
        let (state, text) = match reason {
            Ok(()) => (SessionState::Disconnected, None),
            Err(e) => (SessionState::Failed, Some(e.token().to_owned())),
        };
        task_session.set_state(state);
        params.deps.prompts.cancel_session(id.uuid());
        sink.send(TerminalEvent::Status { state });
        sink.send(TerminalEvent::Closed {
            reason: text.clone(),
        });
        tracing::info!(
            event = "ssh.disconnected",
            session_id = %id,
            reason = text.as_deref().unwrap_or("none"),
        );
        tracing::debug!(event = "ssh.session_cleanup", session_id = %id);
        (params.on_end)(id);
    });
    session
}

#[allow(clippy::too_many_arguments)]
async fn run(
    session: Arc<SshSession>,
    target: Target,
    deps: Deps,
    cols: u16,
    rows: u16,
    initial_directory: Option<String>,
    sink: Arc<dyn Sink>,
    lock: crate::lock::LockFlag,
    on_authenticated: Arc<dyn Fn(SessionId) + Send + Sync>,
    mut control: mpsc::Receiver<Control>,
) -> Result<(), SshError> {
    sink.send(TerminalEvent::Status {
        state: SessionState::Connecting,
    });
    tracing::info!(event = "ssh.connect_started", session_id = %session.id);
    let Connected { handle, .. } = tokio::select! {
        result = client::connect(&target, &deps) => result.inspect_err(|e| {
            tracing::warn!(event = "ssh.connect_failed", session_id = %session.id, reason = e.token());
        })?,
        // Closing while still connecting aborts the attempt.
        _ = wait_for_close(&mut control) => return Err(SshError::Cancelled),
    };
    on_authenticated(session.id);
    let handle = Arc::new(handle);
    let size = super::TerminalSize { cols, rows }.sanitized();
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(SshError::from)?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            u32::from(size.cols),
            u32::from(size.rows),
            0,
            0,
            &[],
        )
        .await
        .map_err(SshError::from)?;
    channel.request_shell(true).await.map_err(SshError::from)?;
    let _ = session.transport.set(handle.clone());
    session.set_state(SessionState::Connected);
    sink.send(TerminalEvent::Status {
        state: SessionState::Connected,
    });
    tracing::info!(event = "ssh.connected", session_id = %session.id);
    tokio::spawn(crate::sftp::init(session.clone(), sink.clone()));

    if let Some(dir) = initial_directory.as_deref().and_then(shell_quote) {
        let _ = channel
            .data_bytes(format!("cd -- {dir}\n").into_bytes())
            .await;
    }

    let mut batch: Vec<u8> = Vec::new();
    let mut deadline: Option<Instant> = None;
    // Output that arrived while the application was locked (bounded).
    let mut held: Vec<u8> = Vec::new();
    // Returns true while output is being held back.
    let flush = |batch: &mut Vec<u8>, held: &mut Vec<u8>| -> bool {
        if lock.is_locked() {
            held.extend_from_slice(batch);
            batch.clear();
            if held.len() > HELD_LIMIT {
                let excess = held.len() - HELD_LIMIT;
                held.drain(..excess);
            }
            return !held.is_empty();
        }
        if !held.is_empty() {
            let mut all = std::mem::take(held);
            all.extend_from_slice(batch);
            *batch = all;
        }
        if batch.is_empty() {
            return false;
        }
        session.credits.add(batch.len());
        sink.send(TerminalEvent::Data {
            data: encode(batch),
        });
        batch.clear();
        false
    };
    let outcome = loop {
        let room = session.credits.has_room();
        tokio::select! {
            biased;
            cmd = control.recv() => match cmd {
                Some(Control::Write(bytes)) => {
                    if channel.data_bytes(bytes).await.is_err() { break Ok(()); }
                }
                Some(Control::Resize { cols, rows }) => {
                    let _ = channel.window_change(u32::from(cols), u32::from(rows), 0, 0).await;
                }
                Some(Control::Close) | None => break Ok(()),
            },
            _ = async { tokio::time::sleep_until(deadline.unwrap()).await }, if deadline.is_some() => {
                deadline = flush(&mut batch, &mut held).then(|| Instant::now() + HOLD_RECHECK);
            }
            // Unacknowledged output reached the limit: stop reading until the UI catches up.
            _ = session.credits.wake.notified(), if !room => {}
            msg = channel.wait(), if room => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if batch.is_empty() { deadline = Some(Instant::now() + BATCH_DELAY); }
                    batch.extend_from_slice(&data);
                    if batch.len() >= BATCH_BYTES {
                        deadline = flush(&mut batch, &mut held).then(|| Instant::now() + HOLD_RECHECK);
                    }
                }
                Some(ChannelMsg::Close) | None => break Ok(()),
                Some(_) => {}
            },
        }
    };
    flush(&mut batch, &mut held);
    let _ = channel.close().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    outcome
}

async fn wait_for_close(rx: &mut mpsc::Receiver<Control>) {
    loop {
        match rx.recv().await {
            Some(Control::Close) | None => return,
            Some(_) => {}
        }
    }
}

/// All live SSH sessions of this process (in memory only).
#[derive(Default)]
pub struct SshManager {
    sessions: Mutex<HashMap<SessionId, Arc<SshSession>>>,
}

impl SshManager {
    pub fn insert(&self, session: Arc<SshSession>) {
        if let Ok(mut s) = self.sessions.lock() {
            s.insert(session.id, session);
        }
    }
    pub fn get(&self, id: SessionId) -> Option<Arc<SshSession>> {
        self.sessions.lock().ok().and_then(|s| s.get(&id).cloned())
    }
    pub fn remove(&self, id: SessionId) -> Option<Arc<SshSession>> {
        self.sessions.lock().ok().and_then(|mut s| s.remove(&id))
    }
    pub fn count(&self) -> usize {
        self.sessions.lock().map(|s| s.len()).unwrap_or(0)
    }
    pub fn all(&self) -> Vec<Arc<SshSession>> {
        self.sessions
            .lock()
            .map(|s| s.values().cloned().collect())
            .unwrap_or_default()
    }
}
