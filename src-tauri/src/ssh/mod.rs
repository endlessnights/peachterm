//! SSH service interface (implementation: Phase 2, `russh`).
//!
//! Design recap (see docs/architecture.md §5):
//! * One Tokio task per session; output is pushed to the renderer through a
//!   per-session `tauri::ipc::Channel`, coalesced and bounded.
//! * Host keys are checked with `security::known_hosts` *before* any
//!   credential is sent; unknown or changed keys stop the handshake.
//! * Secrets are fetched from the credential store inside Rust only.

pub mod client;
#[cfg(test)]
pub mod integration;
pub mod prompt;
pub mod session;
#[cfg(test)]
pub mod testserver;
#[cfg(test)]
pub mod testsftp;

use serde::{Deserialize, Serialize};

/// Terminal geometry in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    /// Clamp renderer-supplied sizes to something a PTY request accepts.
    pub fn sanitized(self) -> Self {
        Self {
            cols: self.cols.clamp(2, 1000),
            rows: self.rows.clamp(1, 500),
        }
    }
}

/// Lifecycle states reported to the tab bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Connecting,
    AwaitingHostKey,
    Authenticating,
    Connected,
    Disconnected,
    Failed,
}

/// Messages streamed to xterm.js over a `tauri::ipc::Channel`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// Base64 of the raw terminal bytes (compact over IPC).
    Data {
        data: String,
    },
    Status {
        state: SessionState,
    },
    Closed {
        reason: Option<String>,
    },
    /// SFTP availability for this session (initialised after login).
    Sftp {
        state: crate::sftp::SftpState,
    },
}

/// OpenSSH-style SHA-256 fingerprint (`SHA256:<base64, no padding>`).
pub fn fingerprint_sha256(key: &russh::keys::PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public test vector: an ed25519 *public* key generated for this test (the
    // private half was discarded). Expected value from `ssh-keygen -lf`.
    const ED25519_PUB: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINqubSYwPU5qAUtvuoX50M3j8qo0U9e+2JMFPhY13rJi";
    const ED25519_FP: &str = "SHA256:RRS6RWG3/zbvi2KyqllAUrFEuB64q8kwBs3lOogP8Xg";

    #[test]
    fn fingerprint_matches_openssh() {
        let key = russh::keys::PublicKey::from_openssh(ED25519_PUB).unwrap();
        assert_eq!(fingerprint_sha256(&key), ED25519_FP);
    }

    #[test]
    fn terminal_size_is_clamped() {
        let s = TerminalSize {
            cols: 0,
            rows: 9999,
        }
        .sanitized();
        assert_eq!((s.cols, s.rows), (2, 500));
    }

    #[test]
    fn terminal_event_wire_format() {
        let json = serde_json::to_value(TerminalEvent::Status {
            state: SessionState::Connected,
        })
        .unwrap();
        assert_eq!(json["kind"], "status");
        assert_eq!(json["state"], "connected");
    }
}
