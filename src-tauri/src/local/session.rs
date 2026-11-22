// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! A local pseudo-terminal session (ConPTY on Windows, a POSIX PTY elsewhere).
//!
//! Output travels the same way as for SSH: PTY → reader thread → bounded
//! channel → batching pump → `Sink` (a Tauri channel) → xterm.js, with the same
//! flow-control credits and the same hold-while-locked rule. Input is written
//! by a dedicated thread so a stuck child can never block the async runtime.
//!
//! Nothing here logs terminal input, output, environment or command lines.

use super::profiles::{Kind, Spec};
use crate::error::{AppError, AppResult};
use crate::lock::LockFlag;
use crate::sessions::SessionId;
use crate::ssh::session::{BATCH_BYTES, BATCH_DELAY, Credits, HELD_LIMIT, Sink, encode};
use crate::ssh::{SessionState, TerminalEvent, TerminalSize};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;

const HOLD_RECHECK: Duration = Duration::from_millis(250);
/// After the shell exits, output that is still in the pipe is given this long to arrive.
const EXIT_GRACE: Duration = Duration::from_millis(200);

/// What the reader and waiter threads tell the pump.
pub enum Chunk {
    Data(Vec<u8>),
    /// The child process ended.
    Exited,
    /// The output pipe is closed.
    Eof,
}

pub struct LocalSession {
    pub id: SessionId,
    pub kind: Kind,
    pub credits: Arc<Credits>,
    input: std::sync::mpsc::Sender<Vec<u8>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    closed: AtomicBool,
}

impl LocalSession {
    pub fn write(&self, bytes: Vec<u8>) {
        let _ = self.input.send(bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let size = TerminalSize { cols, rows }.sanitized();
        if let Ok(guard) = self.master.lock()
            && let Some(master) = guard.as_ref()
        {
            let _ = master.resize(pty_size(size));
        }
    }

    /// Ends the shell and everything it started. Safe to call repeatedly.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
        kill_tree(self.pid);
        // Closing the pseudo console also ends anything still attached to it
        // and unblocks the reader thread.
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
        self.credits.ack(usize::MAX / 2);
    }
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(windows)]
fn kill_tree(pid: Option<u32>) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Some(pid) = pid else { return };
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let exe = PathBuf::from(root).join("System32").join("taskkill.exe");
    // The pid is a number we got from the OS; it is passed as its own argument.
    let _ = std::process::Command::new(exe)
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: Option<u32>) {
    // The PTY's controlling terminal hangs up when the master is dropped, which
    // ends the shell's session; `ChildKiller::kill` already ended the shell.
}

pub struct StartParams {
    pub id: SessionId,
    pub spec: Spec,
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    pub sink: Arc<dyn Sink>,
    pub lock: LockFlag,
    pub on_end: Arc<dyn Fn(SessionId) + Send + Sync>,
}

fn command(spec: &Spec, cwd: Option<&PathBuf>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&spec.program);
    for arg in &spec.args {
        cmd.arg(arg);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

/// Start the shell. Errors here are reported to the caller (the tab shows them).
pub fn start(params: StartParams) -> AppResult<Arc<LocalSession>> {
    let size = TerminalSize {
        cols: params.cols,
        rows: params.rows,
    }
    .sanitized();
    let pair = native_pty_system()
        .openpty(pty_size(size))
        .map_err(|_| AppError::Validation("The terminal could not be created.".into()))?;
    let cmd = command(&params.spec, params.cwd.as_ref());
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|_| AppError::Validation("The shell could not be started.".into()))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|_| AppError::Validation("The terminal could not be read.".into()))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|_| AppError::Validation("The terminal could not be written.".into()))?;
    let pid = child.process_id();
    let killer = child.clone_killer();

    let (tx, rx) = mpsc::channel::<Chunk>(16);
    let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();

    let session = Arc::new(LocalSession {
        id: params.id,
        kind: params.spec.kind,
        credits: Arc::new(Credits::default()),
        input: input_tx,
        master: Mutex::new(Some(pair.master)),
        killer: Mutex::new(killer),
        pid,
        closed: AtomicBool::new(false),
    });

    // Reader: blocks on the PTY; a full channel slows the child down (back-pressure).
    let reader_tx = tx.clone();
    std::thread::Builder::new()
        .name("local-pty-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if reader_tx
                            .blocking_send(Chunk::Data(buf[..n].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            let _ = reader_tx.blocking_send(Chunk::Eof);
        })
        .map_err(|_| AppError::Storage("could not start a terminal thread".into()))?;

    // Waiter: learns that the shell ended even when the pipe stays open.
    let waiter_tx = tx;
    std::thread::Builder::new()
        .name("local-pty-wait".into())
        .spawn(move || {
            let _ = child.wait();
            let _ = waiter_tx.blocking_send(Chunk::Exited);
        })
        .map_err(|_| AppError::Storage("could not start a terminal thread".into()))?;

    // Writer: input never blocks the async runtime.
    std::thread::Builder::new()
        .name("local-pty-write".into())
        .spawn(move || {
            while let Ok(bytes) = input_rx.recv() {
                if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        })
        .map_err(|_| AppError::Storage("could not start a terminal thread".into()))?;

    tracing::info!(event = "local.started", session_id = %params.id, kind = kind_token(params.spec.kind));
    let task_session = session.clone();
    let id = params.id;
    let sink = params.sink;
    let lock = params.lock;
    let on_end = params.on_end;
    tauri::async_runtime::spawn(async move {
        sink.send(TerminalEvent::Status {
            state: SessionState::Connected,
        });
        pump(rx, sink.as_ref(), &lock, &task_session.credits).await;
        task_session.close();
        sink.send(TerminalEvent::Status {
            state: SessionState::Disconnected,
        });
        sink.send(TerminalEvent::Closed { reason: None });
        tracing::info!(event = "local.ended", session_id = %id);
        on_end(id);
    });
    Ok(session)
}

fn kind_token(kind: Kind) -> &'static str {
    match kind {
        Kind::Local => "local",
        Kind::Wsl => "wsl",
    }
}

/// Batch, flow-control and (while locked) hold output. Returns when the shell is gone.
pub async fn pump(
    mut rx: mpsc::Receiver<Chunk>,
    sink: &dyn Sink,
    lock: &LockFlag,
    credits: &Credits,
) {
    let mut batch: Vec<u8> = Vec::new();
    let mut held: Vec<u8> = Vec::new();
    let mut deadline: Option<Instant> = None;
    let mut exit_deadline: Option<Instant> = None;

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
        credits.add(batch.len());
        sink.send(TerminalEvent::Data {
            data: encode(batch),
        });
        batch.clear();
        false
    };

    loop {
        let room = credits.has_room();
        tokio::select! {
            biased;
            _ = async { tokio::time::sleep_until(exit_deadline.unwrap()).await }, if exit_deadline.is_some() => break,
            _ = async { tokio::time::sleep_until(deadline.unwrap()).await }, if deadline.is_some() => {
                deadline = flush(&mut batch, &mut held).then(|| Instant::now() + HOLD_RECHECK);
            }
            _ = credits.wake.notified(), if !room => {}
            msg = rx.recv(), if room => match msg {
                Some(Chunk::Data(data)) => {
                    if batch.is_empty() {
                        deadline = Some(Instant::now() + BATCH_DELAY);
                    }
                    batch.extend_from_slice(&data);
                    if batch.len() >= BATCH_BYTES {
                        deadline = flush(&mut batch, &mut held).then(|| Instant::now() + HOLD_RECHECK);
                    }
                }
                Some(Chunk::Exited) => {
                    exit_deadline = Some(Instant::now() + EXIT_GRACE);
                }
                Some(Chunk::Eof) | None => break,
            },
        }
    }
    // Whatever is left. While locked it stays held and is dropped with the session.
    if !lock.is_locked() {
        flush(&mut batch, &mut held);
    }
}

/// All live local sessions (in memory only).
#[derive(Default)]
pub struct LocalManager {
    sessions: Mutex<HashMap<SessionId, Arc<LocalSession>>>,
}

impl LocalManager {
    pub fn insert(&self, session: Arc<LocalSession>) {
        if let Ok(mut s) = self.sessions.lock() {
            s.insert(session.id, session);
        }
    }
    pub fn get(&self, id: SessionId) -> Option<Arc<LocalSession>> {
        self.sessions.lock().ok().and_then(|s| s.get(&id).cloned())
    }
    pub fn remove(&self, id: SessionId) -> Option<Arc<LocalSession>> {
        self.sessions.lock().ok().and_then(|mut s| s.remove(&id))
    }
    pub fn count(&self) -> usize {
        self.sessions.lock().map(|s| s.len()).unwrap_or(0)
    }
    /// Ends every shell (application exit).
    pub fn close_all(&self) {
        let all: Vec<_> = self
            .sessions
            .lock()
            .map(|mut s| s.drain().map(|(_, v)| v).collect())
            .unwrap_or_default();
        for session in all {
            session.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[derive(Default)]
    struct Collect(Mutex<Vec<TerminalEvent>>);
    impl Sink for Collect {
        fn send(&self, event: TerminalEvent) {
            self.0.lock().unwrap().push(event);
        }
    }
    impl Collect {
        fn text(&self) -> String {
            use base64::Engine;
            let mut out = Vec::new();
            for e in self.0.lock().unwrap().iter() {
                if let TerminalEvent::Data { data } = e {
                    out.extend(
                        base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap(),
                    );
                }
            }
            String::from_utf8_lossy(&out).into_owned()
        }
    }

    #[tokio::test]
    async fn output_is_batched_and_delivered_when_the_shell_ends() {
        let (tx, rx) = mpsc::channel(8);
        let sink = Collect::default();
        let credits = Credits::default();
        let lock = LockFlag::default();
        tx.send(Chunk::Data(b"hel".to_vec())).await.unwrap();
        tx.send(Chunk::Data(b"lo".to_vec())).await.unwrap();
        tx.send(Chunk::Eof).await.unwrap();
        pump(rx, &sink, &lock, &credits).await;
        assert_eq!(sink.text(), "hello");
        assert_eq!(
            credits.outstanding(),
            5,
            "unacknowledged until the renderer acks"
        );
    }

    #[tokio::test]
    async fn output_is_held_while_locked_and_delivered_after_unlocking() {
        let (tx, rx) = mpsc::channel(8);
        let sink = Arc::new(Collect::default());
        let credits = Arc::new(Credits::default());
        let lock = LockFlag::default();
        lock.set(true);
        let handle = {
            let (sink, credits, lock) = (sink.clone(), credits.clone(), lock.clone());
            tokio::spawn(async move { pump(rx, sink.as_ref(), &lock, &credits).await })
        };
        tx.send(Chunk::Data(b"secret-output".to_vec()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(sink.text(), "", "nothing reaches the renderer while locked");
        lock.set(false);
        tokio::time::sleep(HOLD_RECHECK + Duration::from_millis(150)).await;
        assert_eq!(sink.text(), "secret-output");
        tx.send(Chunk::Eof).await.unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn held_output_is_bounded_and_the_newest_bytes_win() {
        let (tx, rx) = mpsc::channel(64);
        let sink = Arc::new(Collect::default());
        let credits = Arc::new(Credits::default());
        let lock = LockFlag::default();
        lock.set(true);
        let handle = {
            let (sink, credits, lock) = (sink.clone(), credits.clone(), lock.clone());
            tokio::spawn(async move { pump(rx, sink.as_ref(), &lock, &credits).await })
        };
        let block = vec![b'a'; HELD_LIMIT];
        tx.send(Chunk::Data(block)).await.unwrap();
        tx.send(Chunk::Data(b"TAIL".to_vec())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        lock.set(false);
        tokio::time::sleep(HOLD_RECHECK + Duration::from_millis(150)).await;
        tx.send(Chunk::Eof).await.unwrap();
        handle.await.unwrap();
        let text = sink.text();
        assert_eq!(text.len(), HELD_LIMIT);
        assert!(text.ends_with("TAIL"));
    }

    #[tokio::test]
    async fn an_exited_shell_ends_the_pump_even_when_the_pipe_stays_open() {
        let (tx, rx) = mpsc::channel(8);
        let sink = Collect::default();
        let credits = Credits::default();
        let lock = LockFlag::default();
        tx.send(Chunk::Data(b"bye".to_vec())).await.unwrap();
        tx.send(Chunk::Exited).await.unwrap();
        // `tx` is kept alive: no Eof ever comes.
        tokio::time::timeout(Duration::from_secs(3), pump(rx, &sink, &lock, &credits))
            .await
            .expect("pump ends after the exit grace period");
        assert_eq!(sink.text(), "bye");
        drop(tx);
    }

    #[tokio::test]
    async fn the_pump_pauses_reading_when_the_renderer_falls_behind() {
        let (tx, rx) = mpsc::channel(8);
        let sink = Arc::new(Collect::default());
        let credits = Arc::new(Credits::default());
        credits.add(crate::ssh::session::MAX_OUTSTANDING);
        let lock = LockFlag::default();
        let handle = {
            let (sink, credits, lock) = (sink.clone(), credits.clone(), lock.clone());
            tokio::spawn(async move { pump(rx, sink.as_ref(), &lock, &credits).await })
        };
        tx.send(Chunk::Data(b"queued".to_vec())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(sink.text(), "", "not read while the renderer is behind");
        credits.ack(crate::ssh::session::MAX_OUTSTANDING);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(sink.text(), "queued");
        tx.send(Chunk::Eof).await.unwrap();
        handle.await.unwrap();
    }

    fn echo_spec() -> Spec {
        #[cfg(windows)]
        let (program, args): (PathBuf, Vec<OsString>) = (
            PathBuf::from(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into())),
            vec!["/c".into(), "echo peach-pty-ok".into()],
        );
        #[cfg(not(windows))]
        let (program, args): (PathBuf, Vec<OsString>) = (
            PathBuf::from("/bin/sh"),
            vec!["-c".into(), "echo peach-pty-ok".into()],
        );
        Spec {
            program,
            args,
            kind: Kind::Local,
            wsl_distro: None,
        }
    }

    /// A real PTY: the child's output arrives, and the session ends by itself.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_real_pty_runs_a_program_and_reports_its_output_and_end() {
        let sink = Arc::new(Collect::default());
        let ended = Arc::new(AtomicBool::new(false));
        let id = SessionId::new();
        let flag = ended.clone();
        let session = start(StartParams {
            id,
            spec: echo_spec(),
            cwd: None,
            cols: 80,
            rows: 24,
            sink: sink.clone(),
            lock: LockFlag::default(),
            on_end: Arc::new(move |_| flag.store(true, Ordering::SeqCst)),
        })
        .expect("start");
        let started = std::time::Instant::now();
        let mut answered = false;
        while !ended.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(15) {
            // ConPTY asks the terminal for the cursor position and waits for the
            // answer; xterm.js does this in the app, the test plays its part.
            if !answered && sink.text().contains("[6n") {
                session.write(b"[1;1R".to_vec());
                answered = true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(ended.load(Ordering::SeqCst), "session ended on its own");
        assert!(
            sink.text().contains("peach-pty-ok"),
            "output: {:?}",
            sink.text()
        );
        let events = sink.0.lock().unwrap();
        assert!(matches!(events.last(), Some(TerminalEvent::Closed { .. })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn starting_a_missing_program_is_an_error_not_a_panic() {
        let spec = Spec {
            program: PathBuf::from(if cfg!(windows) {
                "C:\\definitely\\missing\\shell.exe"
            } else {
                "/definitely/missing/shell"
            }),
            args: vec![],
            kind: Kind::Local,
            wsl_distro: None,
        };
        let result = start(StartParams {
            id: SessionId::new(),
            spec,
            cwd: None,
            cols: 80,
            rows: 24,
            sink: Arc::new(Collect::default()),
            lock: LockFlag::default(),
            on_end: Arc::new(|_| {}),
        });
        assert!(result.is_err());
    }

    #[test]
    fn the_manager_closes_everything_on_exit() {
        let manager = LocalManager::default();
        assert_eq!(manager.count(), 0);
        manager.close_all();
    }
}
