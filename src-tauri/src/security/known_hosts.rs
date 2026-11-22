// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Known SSH host keys.
//!
//! Policy (enforced by the SSH service in Phase 2):
//! * `Matched`  → continue the handshake.
//! * `Unknown`  → stop before authentication and ask the user.
//! * `Changed`  → stop before authentication and show a distinct warning;
//!   replacing the stored key requires a separate explicit action.
//!
//! Nothing here ever trusts a key implicitly: `check` is read-only, and only
//! `trust` (called after an explicit user decision) writes.

use crate::error::{AppError, AppResult};
use crate::storage::atomic::{
    ConfigIssue, ensure_backup, file_label, load_json_value, parse_entries, save_json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    /// e.g. `ssh-ed25519`
    pub algorithm: String,
    /// `SHA256:<base64>` as printed by OpenSSH.
    pub fingerprint: String,
    pub added_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    Matched,
    Unknown,
    Changed { previous: KnownHost },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostsDoc {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    hosts: Vec<KnownHost>,
}

/// Canonical form: lowercase, IPv6 brackets removed.
pub fn normalize_host(host: &str) -> String {
    let h = host.trim();
    h.strip_prefix('[')
        .and_then(|x| x.strip_suffix(']'))
        .unwrap_or(h)
        .to_ascii_lowercase()
}

pub struct KnownHostsStore {
    path: PathBuf,
    doc: Mutex<KnownHostsDoc>,
    issues: Vec<ConfigIssue>,
}

impl KnownHostsStore {
    /// Damaged entries are skipped (the host is simply asked about again) and
    /// a backup of the original file is kept.
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let mut issues = Vec::new();
        let mut doc = KnownHostsDoc::default();
        match load_json_value(&path, &mut issues) {
            Some(Value::Object(obj)) => {
                let before = issues.len();
                doc.hosts = parse_entries(obj.get("hosts"), &path, "hosts", &mut issues);
                ensure_backup(&path, &mut issues, before);
            }
            Some(_) => {
                issues.push(ConfigIssue {
                    file: file_label(&path),
                    kind: "not_an_object",
                    field: None,
                    backed_up: false,
                });
                let at = issues.len() - 1;
                ensure_backup(&path, &mut issues, at);
            }
            None => {}
        }
        doc.version = 1;
        Ok(Self {
            path,
            doc: Mutex::new(doc),
            issues,
        })
    }

    pub fn issues(&self) -> &[ConfigIssue] {
        &self.issues
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, KnownHostsDoc>> {
        self.doc
            .lock()
            .map_err(|_| AppError::Storage("known hosts lock poisoned".into()))
    }

    pub fn list(&self) -> AppResult<Vec<KnownHost>> {
        Ok(self.lock()?.hosts.clone())
    }

    /// Read-only comparison of a presented key with the stored one.
    /// A host may have several keys of different algorithms; a key of an
    /// algorithm not yet seen for that host counts as `Unknown`, while a
    /// different fingerprint for a known algorithm is `Changed`.
    #[allow(dead_code)] // called from the SSH handshake in Phase 2
    pub fn check(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
    ) -> AppResult<HostKeyStatus> {
        let host = normalize_host(host);
        let doc = self.lock()?;
        let mut same_host = doc
            .hosts
            .iter()
            .filter(|k| k.host == host && k.port == port);
        if same_host
            .clone()
            .any(|k| k.algorithm == algorithm && k.fingerprint == fingerprint)
        {
            return Ok(HostKeyStatus::Matched);
        }
        match same_host.find(|k| k.algorithm == algorithm) {
            Some(previous) => Ok(HostKeyStatus::Changed {
                previous: previous.clone(),
            }),
            None => Ok(HostKeyStatus::Unknown),
        }
    }

    /// Store a key after an explicit user decision. With `replace == false`
    /// an existing, different key for the same algorithm is *not* overwritten.
    #[allow(dead_code)] // called from `known_hosts_decide` in Phase 2
    pub fn trust(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
        replace: bool,
    ) -> AppResult<()> {
        let host = normalize_host(host);
        let mut doc = self.lock()?;
        let existing = doc
            .hosts
            .iter()
            .position(|k| k.host == host && k.port == port && k.algorithm == algorithm);
        let entry = KnownHost {
            host,
            port,
            algorithm: algorithm.to_owned(),
            fingerprint: fingerprint.to_owned(),
            added_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        };
        match existing {
            Some(i) if doc.hosts[i].fingerprint == fingerprint => return Ok(()),
            Some(_) if !replace => {
                return Err(AppError::Validation(
                    "A different key is already trusted for this host; replacing it requires explicit confirmation".into(),
                ));
            }
            Some(i) => doc.hosts[i] = entry,
            None => doc.hosts.push(entry),
        }
        save_json(&self.path, &*doc)
    }

    pub fn remove(&self, host: &str, port: u16) -> AppResult<usize> {
        let host = normalize_host(host);
        let mut doc = self.lock()?;
        let before = doc.hosts.len();
        doc.hosts.retain(|k| !(k.host == host && k.port == port));
        let removed = before - doc.hosts.len();
        if removed > 0 {
            save_json(&self.path, &*doc)?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP_A: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const FP_B: &str = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    fn store() -> (tempfile::TempDir, KnownHostsStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = KnownHostsStore::open(dir.path().join("known_hosts.json")).unwrap();
        (dir, s)
    }

    #[test]
    fn unknown_until_explicitly_trusted() {
        let (_d, s) = store();
        assert_eq!(
            s.check("Example.COM", 22, "ssh-ed25519", FP_A).unwrap(),
            HostKeyStatus::Unknown
        );
        // check() never writes
        assert!(s.list().unwrap().is_empty());
        s.trust("example.com", 22, "ssh-ed25519", FP_A, false)
            .unwrap();
        assert_eq!(
            s.check("EXAMPLE.com", 22, "ssh-ed25519", FP_A).unwrap(),
            HostKeyStatus::Matched
        );
    }

    #[test]
    fn changed_key_is_reported_and_not_silently_replaced() {
        let (_d, s) = store();
        s.trust("h", 22, "ssh-ed25519", FP_A, false).unwrap();
        match s.check("h", 22, "ssh-ed25519", FP_B).unwrap() {
            HostKeyStatus::Changed { previous } => assert_eq!(previous.fingerprint, FP_A),
            other => panic!("expected Changed, got {other:?}"),
        }
        assert!(s.trust("h", 22, "ssh-ed25519", FP_B, false).is_err());
        assert_eq!(s.list().unwrap()[0].fingerprint, FP_A);
        s.trust("h", 22, "ssh-ed25519", FP_B, true).unwrap();
        assert_eq!(
            s.check("h", 22, "ssh-ed25519", FP_B).unwrap(),
            HostKeyStatus::Matched
        );
    }

    #[test]
    fn port_and_algorithm_are_part_of_identity() {
        let (_d, s) = store();
        s.trust("h", 22, "ssh-ed25519", FP_A, false).unwrap();
        assert_eq!(
            s.check("h", 2222, "ssh-ed25519", FP_A).unwrap(),
            HostKeyStatus::Unknown
        );
        assert_eq!(
            s.check("h", 22, "rsa-sha2-512", FP_B).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn persists_and_removes() {
        let (dir, s) = store();
        s.trust("[2001:db8::1]", 22, "ssh-ed25519", FP_A, false)
            .unwrap();
        let reopened = KnownHostsStore::open(dir.path().join("known_hosts.json")).unwrap();
        assert_eq!(reopened.list().unwrap()[0].host, "2001:db8::1");
        assert_eq!(reopened.remove("2001:DB8::1", 22).unwrap(), 1);
        assert!(reopened.list().unwrap().is_empty());
    }
}
