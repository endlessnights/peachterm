// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Running local port forwards (`ssh -L`).
//!
//! Ownership model: a running tunnel is owned by ONE live SSH session (its
//! authenticated transport). Every accepted local connection opens its own
//! `direct-tcpip` channel on that transport, so shells and SFTP on the same
//! transport are never touched. When the session ends (tab closed, disconnect,
//! network loss, application exit) its tunnels are stopped: nothing outlives
//! the transport and nothing re-authenticates behind the user's back.
//!
//! Lock policy: while the application is locked no new forwarded connection is
//! accepted (the local socket is closed at once) and no tunnel can be started or
//! changed. Streams that were already open run to their natural end; they carry
//! data between two programs and expose nothing of PeachTerm itself.
//!
//! Payload bytes are never logged. Only counts and fixed tokens are.

use super::model::TunnelDef;
use crate::error::{AppError, AppResult};
use crate::lock::LockFlag;
use crate::ssh::SessionState;
use crate::ssh::session::SshSession;
use russh::{ChannelMsg, ChannelOpenFailure};
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};
use uuid::Uuid;

/// Simultaneous forwarded connections per tunnel; further ones are refused.
pub const MAX_CONNECTIONS: usize = 128;
/// How long the server gets to open the remote side of one connection.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// Copy buffer per direction: bounded memory, natural backpressure.
const BUFFER: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TunnelState {
    Stopped,
    Starting,
    /// The local socket is bound. This does NOT mean the remote service answers.
    Listening,
    /// The SSH connection that carries the tunnel is gone or not ready.
    ConnectionUnavailable,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub state: TunnelState,
    /// The SSH session (tab) that owns the running listener.
    pub owner_session: Option<Uuid>,
    pub active_connections: usize,
    /// Why the most recent forwarded connection failed, in one sentence.
    pub last_error: Option<&'static str>,
}

impl TunnelStatus {
    pub fn stopped() -> Self {
        Self {
            state: TunnelState::Stopped,
            owner_session: None,
            active_connections: 0,
            last_error: None,
        }
    }
}

struct Shared {
    active: AtomicUsize,
    last_error: Mutex<Option<&'static str>>,
    transport_lost: std::sync::atomic::AtomicBool,
}

struct Running {
    session: Arc<SshSession>,
    endpoint: SocketAddr,
    shared: Arc<Shared>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}

pub struct TunnelEngine {
    running: Mutex<HashMap<Uuid, Running>>,
    lock: LockFlag,
}

fn fail(text: impl Into<String>) -> AppError {
    AppError::Validation(text.into())
}

fn classify(failure: &ChannelOpenFailure) -> &'static str {
    match failure {
        ChannelOpenFailure::AdministrativelyProhibited => {
            "The SSH server does not allow port forwarding (AllowTcpForwarding)."
        }
        ChannelOpenFailure::ConnectFailed => {
            "The SSH server could not reach the remote destination."
        }
        ChannelOpenFailure::ResourceShortage => "The SSH server is out of resources for forwards.",
        _ => "The SSH server refused the forwarded connection.",
    }
}

impl TunnelEngine {
    pub fn new(lock: LockFlag) -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
            lock,
        }
    }

    fn map(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<Uuid, Running>>> {
        self.running
            .lock()
            .map_err(|_| AppError::Storage("tunnel registry lock poisoned".into()))
    }

    /// Bind the local socket and start forwarding over `session`'s transport.
    /// The requested port is used exactly as asked; there is no silent fallback.
    pub fn start(&self, def: &TunnelDef, session: &Arc<SshSession>) -> AppResult<()> {
        self.lock.guard()?;
        if session.state() != SessionState::Connected {
            return Err(fail(
                "The SSH connection is not ready. Start the tunnel once it is connected.",
            ));
        }
        let handle = session
            .transport
            .get()
            .cloned()
            .ok_or_else(|| fail("The SSH connection is not ready."))?;
        let ip: IpAddr = def
            .bind_address
            .parse()
            .ok()
            .filter(IpAddr::is_loopback)
            .ok_or_else(|| fail("Tunnels can only listen on a loopback address."))?;
        let endpoint = SocketAddr::new(ip, def.local_port);

        let mut running = self.map()?;
        if let Some(existing) = running.get(&def.id) {
            return Err(fail(if existing.session.id == session.id {
                "This tunnel is already running."
            } else {
                "This tunnel is already running in another session of this connection. Stop it there first."
            }));
        }
        if running.values().any(|r| r.endpoint == endpoint) {
            return Err(fail(format!(
                "The local port {} is already used by another running tunnel.",
                def.local_port
            )));
        }
        let std_listener = std::net::TcpListener::bind(endpoint).map_err(|e| {
            fail(match e.kind() {
                std::io::ErrorKind::AddrInUse => format!(
                    "The local port {} is already in use by another program. Choose a different port.",
                    def.local_port
                ),
                std::io::ErrorKind::PermissionDenied => format!(
                    "Windows or the system does not allow listening on port {}. Choose a port above 1024.",
                    def.local_port
                ),
                _ => format!("Could not listen on port {}.", def.local_port),
            })
        })?;
        std_listener
            .set_nonblocking(true)
            .map_err(|_| fail("Could not listen on the local port."))?;
        let listener = TcpListener::from_std(std_listener)
            .map_err(|_| fail("Could not listen on the local port."))?;

        let shared = Arc::new(Shared {
            active: AtomicUsize::new(0),
            last_error: Mutex::new(None),
            transport_lost: Default::default(),
        });
        let (cancel, cancel_rx) = watch::channel(false);
        let task = tokio::spawn(accept_loop(
            listener,
            handle,
            def.remote_host.clone(),
            u32::from(def.remote_port),
            shared.clone(),
            cancel_rx,
            self.lock.clone(),
        ));
        tracing::info!(
            event = "tunnel.started",
            tunnel_id = %def.id,
            session_id = %session.id,
        );
        running.insert(
            def.id,
            Running {
                session: session.clone(),
                endpoint,
                shared,
                cancel,
                task,
            },
        );
        Ok(())
    }

    pub fn status(&self, id: Uuid) -> TunnelStatus {
        let Ok(running) = self.map() else {
            return TunnelStatus::stopped();
        };
        let Some(r) = running.get(&id) else {
            return TunnelStatus::stopped();
        };
        let state = if r.session.state() != SessionState::Connected
            || r.shared.transport_lost.load(Ordering::SeqCst)
        {
            TunnelState::ConnectionUnavailable
        } else if r.task.is_finished() {
            TunnelState::Error
        } else {
            TunnelState::Listening
        };
        TunnelStatus {
            state,
            owner_session: Some(r.session.id.uuid()),
            active_connections: r.shared.active.load(Ordering::SeqCst),
            last_error: r.shared.last_error.lock().ok().and_then(|g| *g),
        }
    }

    pub fn owner(&self, id: Uuid) -> Option<Uuid> {
        self.map()
            .ok()
            .and_then(|m| m.get(&id).map(|r| r.session.id.uuid()))
    }

    pub fn endpoint(&self, id: Uuid) -> Option<SocketAddr> {
        self.map().ok().and_then(|m| m.get(&id).map(|r| r.endpoint))
    }

    /// Stop one tunnel and wait until its port is released.
    pub async fn stop(&self, id: Uuid) {
        let removed = self.map().ok().and_then(|mut m| m.remove(&id));
        if let Some(r) = removed {
            finish(r).await;
            tracing::info!(event = "tunnel.stopped", tunnel_id = %id);
        }
    }

    /// Stop every tunnel owned by an ended session (called from its teardown).
    pub fn stop_session(&self, session: Uuid) {
        let owned: Vec<Running> = match self.map() {
            Ok(mut m) => {
                let ids: Vec<Uuid> = m
                    .iter()
                    .filter(|(_, r)| r.session.id.uuid() == session)
                    .map(|(id, _)| *id)
                    .collect();
                ids.into_iter().filter_map(|id| m.remove(&id)).collect()
            }
            Err(_) => return,
        };
        for r in owned {
            let _ = r.cancel.send(true);
            tracing::info!(event = "tunnel.stopped_with_session", session_id = %session);
        }
    }

    pub async fn stop_all(&self) {
        let all: Vec<Running> = self
            .map()
            .map(|mut m| m.drain().map(|(_, r)| r).collect())
            .unwrap_or_default();
        for r in all {
            finish(r).await;
        }
    }

    pub fn running_count(&self) -> usize {
        self.map().map(|m| m.len()).unwrap_or(0)
    }

    pub fn running_for_session(&self, session: Uuid) -> usize {
        self.map()
            .map(|m| {
                m.values()
                    .filter(|r| r.session.id.uuid() == session)
                    .count()
            })
            .unwrap_or(0)
    }
}

async fn finish(r: Running) {
    let _ = r.cancel.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(3), r.task).await;
}

struct ActiveGuard(Arc<Shared>);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn accept_loop(
    listener: TcpListener,
    handle: Arc<crate::ssh::client::Handle>,
    remote_host: String,
    remote_port: u32,
    shared: Arc<Shared>,
    mut cancel: watch::Receiver<bool>,
    lock: LockFlag,
) {
    // Dropping the set aborts every forwarding task: no task outlives the tunnel.
    let mut connections: JoinSet<()> = JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.changed() => break,
            // reap finished forwards so the set does not grow
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => {
                let (socket, peer) = match accepted {
                    Ok(pair) => pair,
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                if lock.is_locked() || shared.active.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    drop(socket);
                    continue;
                }
                shared.active.fetch_add(1, Ordering::SeqCst);
                let guard = ActiveGuard(shared.clone());
                let handle = handle.clone();
                let host = remote_host.clone();
                let shared = shared.clone();
                let mut cancel = cancel.clone();
                connections.spawn(async move {
                    let _guard = guard;
                    tokio::select! {
                        _ = cancel.changed() => {}
                        _ = forward(socket, peer, &handle, &host, remote_port, &shared) => {}
                    }
                });
            }
        }
    }
    connections.shutdown().await;
}

async fn forward(
    socket: TcpStream,
    peer: SocketAddr,
    handle: &crate::ssh::client::Handle,
    host: &str,
    port: u32,
    shared: &Shared,
) {
    let opened = tokio::time::timeout(
        OPEN_TIMEOUT,
        handle.channel_open_direct_tcpip(host, port, peer.ip().to_string(), u32::from(peer.port())),
    )
    .await;
    let channel = match opened {
        Ok(Ok(channel)) => {
            set_error(shared, None);
            channel
        }
        Ok(Err(error)) => {
            if handle.is_closed() {
                shared.transport_lost.store(true, Ordering::SeqCst);
            }
            let message = match &error {
                russh::Error::ChannelOpenFailure(failure) => classify(failure),
                _ => "The SSH connection could not carry this forwarded connection.",
            };
            set_error(shared, Some(message));
            tracing::info!(event = "tunnel.open_failed");
            return;
        }
        Err(_) => {
            set_error(
                shared,
                Some("The SSH server did not answer in time for the remote destination."),
            );
            tracing::info!(event = "tunnel.open_timeout");
            return;
        }
    };
    // Explicit loops over the two halves: bounded buffers (one read buffer per
    // direction), natural backpressure (a write waits for the peer), and
    // half-close is propagated in both directions.
    let (mut remote_rx, remote_tx) = channel.split();
    let (mut local_rx, mut local_tx) = socket.into_split();
    let upstream = async {
        let mut buf = vec![0u8; BUFFER];
        loop {
            match local_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if remote_tx.data(&buf[..n]).await.is_err() {
                        return;
                    }
                }
            }
        }
        // the local program is done sending; the server may still answer
        let _ = remote_tx.eof().await;
    };
    let downstream = async {
        while let Some(message) = remote_rx.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if local_tx.write_all(&data).await.is_err() {
                        return;
                    }
                }
                ChannelMsg::Eof => {
                    // the remote service is done sending: close our write side only
                    let _ = local_tx.shutdown().await;
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = local_tx.shutdown().await;
    };
    tokio::pin!(upstream, downstream);
    let mut upstream_done = false;
    loop {
        tokio::select! {
            _ = &mut upstream, if !upstream_done => upstream_done = true,
            _ = &mut downstream => break,
        }
    }
    let _ = remote_tx.close().await;
}

fn set_error(shared: &Shared, message: Option<&'static str>) {
    if let Ok(mut slot) = shared.last_error.lock() {
        *slot = message;
    }
}
