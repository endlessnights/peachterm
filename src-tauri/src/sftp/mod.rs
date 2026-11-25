// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Integrated SFTP.
//!
//! SFTP runs as a second channel on the already authenticated SSH transport of
//! a session (no extra login). It is initialised right after the shell starts;
//! if the server refuses the subsystem the session records
//! [`SftpState::Unavailable`] and the terminal keeps working untouched.
//!
//! * [`ops`] browsing and file operations, [`put_file`] the safe-replace upload
//!   shared with the external-editor flow.
//! * [`transfer`] progress/cancel plumbing for user-visible transfers.

pub mod ops;
pub mod put;
pub mod transfer;
pub mod tree;

use crate::ssh::TerminalEvent;
use crate::ssh::session::{Sink, SshSession};
use russh::Channel;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::OnceCell;

pub type Client = russh_sftp::client::SftpSession;

/// How long the server gets to answer the `sftp` subsystem request and the
/// protocol handshake before SFTP is declared unavailable.
const INIT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpState {
    Pending,
    Ready,
    Unavailable,
}

/// The per-session SFTP client, filled in once initialisation succeeds.
pub struct SftpSlot {
    state: Mutex<SftpState>,
    client: OnceCell<Arc<Client>>,
}

impl Default for SftpSlot {
    fn default() -> Self {
        Self {
            state: Mutex::new(SftpState::Pending),
            client: OnceCell::new(),
        }
    }
}

impl SftpSlot {
    pub fn state(&self) -> SftpState {
        *self.state.lock().unwrap()
    }
    pub fn client(&self) -> Option<Arc<Client>> {
        self.client.get().cloned()
    }
    fn set_state(&self, state: SftpState) {
        *self.state.lock().unwrap() = state;
    }
}

/// Open the `sftp` subsystem on a new channel of the session's transport.
/// Never fails the session: the outcome is stored and announced to the UI.
pub async fn init(session: Arc<SshSession>, sink: Arc<dyn Sink>) {
    let Some(handle) = session.transport.get().cloned() else {
        return;
    };
    tracing::info!(event = "sftp.init_started", session_id = %session.id);
    let outcome = tokio::time::timeout(INIT_TIMEOUT, async {
        let channel: Channel<russh::client::Msg> =
            handle.channel_open_session().await.map_err(|_| "channel")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|_| "subsystem_refused")?;
        Client::new(channel.into_stream())
            .await
            .map_err(|_| "handshake")
    })
    .await;
    let state = match outcome {
        Ok(Ok(client)) => {
            let _ = session.sftp.client.set(Arc::new(client));
            tracing::info!(event = "sftp.ready", session_id = %session.id);
            SftpState::Ready
        }
        Ok(Err(reason)) => {
            tracing::info!(event = "sftp.unsupported", session_id = %session.id, reason = reason);
            SftpState::Unavailable
        }
        Err(_) => {
            tracing::info!(event = "sftp.unsupported", session_id = %session.id, reason = "timeout");
            SftpState::Unavailable
        }
    };
    session.sftp.set_state(state);
    sink.send(TerminalEvent::Sftp { state });
}

/// Remote paths are always POSIX-style, independent of the local OS.
pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!(
            "{}/{}",
            dir.trim_end_matches('/'),
            name.trim_start_matches('/')
        )
    }
}

pub fn parent_remote(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(i) => trimmed[..i].to_owned(),
    }
}

/// Why an SFTP operation failed. Only these fixed tokens reach logs and UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SftpError {
    Unavailable,
    NotFound,
    PermissionDenied,
    AlreadyExists,
    InvalidPath,
    NotADirectory,
    IsADirectory,
    NotEmpty,
    Timeout,
    Cancelled,
    /// The remote file changed after it was read (conflict).
    RemoteChanged,
    /// A local file could not be read or written.
    LocalIo,
    /// Too many (or too deeply nested) items for one upload.
    TooMany,
    Failed,
}

impl SftpError {
    pub fn token(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::NotFound => "not_found",
            Self::PermissionDenied => "permission_denied",
            Self::AlreadyExists => "already_exists",
            Self::InvalidPath => "invalid_path",
            Self::NotADirectory => "not_a_directory",
            Self::IsADirectory => "is_a_directory",
            Self::NotEmpty => "not_empty",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::RemoteChanged => "remote_changed",
            Self::LocalIo => "local_io",
            Self::TooMany => "limit_reached",
            Self::Failed => "failed",
        }
    }

    /// A fixed, user-facing sentence.
    pub fn message(self) -> &'static str {
        match self {
            Self::Unavailable => "SFTP is not available on this connection",
            Self::NotFound => "No such file or directory",
            Self::PermissionDenied => "Permission denied on the server",
            Self::AlreadyExists => "An item with that name already exists",
            Self::InvalidPath => "That path or name is not valid",
            Self::NotADirectory => "Not a directory",
            Self::IsADirectory => "That is a directory",
            Self::NotEmpty => "The directory is not empty",
            Self::Timeout => "The server did not answer in time",
            Self::Cancelled => "Cancelled",
            Self::RemoteChanged => "The file was changed on the server in the meantime",
            Self::LocalIo => "A local file could not be read or written",
            Self::TooMany => "Too many items to upload at once",
            Self::Failed => "The server could not complete the operation",
        }
    }
}

impl From<russh_sftp::client::error::Error> for SftpError {
    fn from(error: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as E;
        use russh_sftp::protocol::StatusCode as C;
        match error {
            E::Status(status) => match status.status_code {
                C::NoSuchFile => Self::NotFound,
                C::PermissionDenied => Self::PermissionDenied,
                C::NoConnection | C::ConnectionLost => Self::Unavailable,
                _ => Self::Failed,
            },
            E::Timeout => Self::Timeout,
            E::IO(_) => Self::Unavailable,
            _ => Self::Failed,
        }
    }
}

impl From<std::io::Error> for SftpError {
    fn from(_: std::io::Error) -> Self {
        Self::LocalIo
    }
}

impl From<SftpError> for crate::error::AppError {
    fn from(error: SftpError) -> Self {
        crate::error::AppError::Remote(error.token(), error.message())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_are_posix() {
        assert_eq!(join_remote("/", "etc"), "/etc");
        assert_eq!(join_remote("/etc/", "ssh"), "/etc/ssh");
        assert_eq!(parent_remote("/etc/ssh/sshd_config"), "/etc/ssh");
        assert_eq!(parent_remote("/etc"), "/");
        assert_eq!(parent_remote("/"), "/");
    }

    #[test]
    fn every_error_has_a_distinct_token_and_a_sentence() {
        let all = [
            SftpError::Unavailable,
            SftpError::NotFound,
            SftpError::PermissionDenied,
            SftpError::AlreadyExists,
            SftpError::InvalidPath,
            SftpError::NotADirectory,
            SftpError::IsADirectory,
            SftpError::NotEmpty,
            SftpError::Timeout,
            SftpError::Cancelled,
            SftpError::RemoteChanged,
            SftpError::LocalIo,
            SftpError::Failed,
        ];
        let tokens: std::collections::HashSet<_> = all.iter().map(|e| e.token()).collect();
        assert_eq!(tokens.len(), all.len());
        for e in all {
            assert!(!e.message().is_empty());
            assert!(
                crate::logging::fields::IDENT_VOCABULARY.contains(&e.token()),
                "{} must be in the logging vocabulary",
                e.token()
            );
        }
    }
}

#[cfg(test)]
mod integration_tests;
