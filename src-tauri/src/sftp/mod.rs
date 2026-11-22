//! SFTP service interface (implementation: Phase 3, `russh-sftp`).
//!
//! SFTP runs as a second channel on the already authenticated SSH transport.
//! If the server refuses the `sftp` subsystem the session records
//! [`SftpAvailability::Unsupported`] and the terminal keeps working.

#![allow(dead_code)] // contract types; the service lands in Phase 3

use serde::Serialize;

/// The SFTP client type the Phase 3 service will hold per session.
pub type SftpClient = russh_sftp::client::SftpSession;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SftpAvailability {
    Initializing,
    Ready,
    Unsupported { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Seconds since the Unix epoch, if the server reported it.
    pub modified: Option<u64>,
    /// POSIX permission bits, if reported.
    pub permissions: Option<u32>,
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
}
