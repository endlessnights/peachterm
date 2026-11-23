// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Backend-managed state for multi-step operations.
//!
//! Each wizard step hands the renderer an opaque, single-purpose token. What
//! the token stands for (a validated import, a chosen destination, a decrypted
//! backup) stays in Rust memory; the renderer can neither read nor forge it.
//! Entries expire, there is one slot per kind (starting a new import discards
//! the old one) and everything is dropped (and zeroised) when the application
//! locks.

use super::backup::OpenedBackup;
use super::profiles::Parsed;
use crate::error::{AppError, AppResult};
use crate::lock::LockFlag;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const DEFAULT_TTL: Duration = Duration::from_secs(15 * 60);
/// Wrong-passphrase attempts before the staged backup file is dropped.
pub const MAX_UNLOCK_ATTEMPTS: u32 = 10;

pub enum Staged {
    Import { parsed: Parsed },
    Destination { path: PathBuf },
    BackupFile { bytes: Vec<u8>, attempts: u32 },
    Opened { backup: Box<OpenedBackup> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Import,
    Destination,
    BackupFile,
    Opened,
}

/// Contents are deliberately never printed.
impl std::fmt::Debug for Staged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Staged({:?}, [redacted])", self.kind())
    }
}

impl Staged {
    pub fn kind(&self) -> Kind {
        match self {
            Staged::Import { .. } => Kind::Import,
            Staged::Destination { .. } => Kind::Destination,
            Staged::BackupFile { .. } => Kind::BackupFile,
            Staged::Opened { .. } => Kind::Opened,
        }
    }
}

struct Slot {
    token: Uuid,
    created: Instant,
    staged: Staged,
}

pub struct Staging {
    ttl: Duration,
    slots: Mutex<Vec<Slot>>,
}

fn expired() -> AppError {
    AppError::Validation("This step has expired or was cancelled. Please start again.".into())
}

impl Staging {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            slots: Mutex::new(Vec::new()),
        }
    }

    fn slots(&self) -> std::sync::MutexGuard<'_, Vec<Slot>> {
        // A poisoned lock only means another thread panicked; the data is a
        // plain list, so keep going.
        self.slots.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Store `staged` under a new token. A backup file and its opened form
    /// share the "restore" slot, so starting a restore discards the previous one.
    pub fn insert(&self, staged: Staged) -> Uuid {
        let token = Uuid::new_v4();
        let mut slots = self.slots();
        let group = group_of(staged.kind());
        slots.retain(|s| group_of(s.staged.kind()) != group);
        slots.push(Slot {
            token,
            created: Instant::now(),
            staged,
        });
        token
    }

    /// Re-insert under the *same* token (after a recoverable failure or a step
    /// that turns one staged value into the next).
    pub fn put_back(&self, token: Uuid, staged: Staged) {
        let mut slots = self.slots();
        let group = group_of(staged.kind());
        slots.retain(|s| group_of(s.staged.kind()) != group);
        slots.push(Slot {
            token,
            created: Instant::now(),
            staged,
        });
    }

    /// Remove and return the entry. Refuses while locked (and drops everything).
    pub fn take(&self, token: Uuid, kind: Kind, lock: &LockFlag) -> AppResult<Staged> {
        if lock.is_locked() {
            self.clear();
            return Err(AppError::Locked);
        }
        let mut slots = self.slots();
        let now = Instant::now();
        slots.retain(|s| now.duration_since(s.created) <= self.ttl);
        let index = slots
            .iter()
            .position(|s| s.token == token && s.staged.kind() == kind)
            .ok_or_else(expired)?;
        Ok(slots.remove(index).staged)
    }

    pub fn cancel(&self, token: Uuid) {
        self.slots().retain(|s| s.token != token);
    }

    pub fn clear(&self) {
        self.slots().clear();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.slots().len()
    }
}

fn group_of(kind: Kind) -> u8 {
    match kind {
        Kind::Import => 0,
        Kind::Destination => 1,
        Kind::BackupFile | Kind::Opened => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dest() -> Staged {
        Staged::Destination {
            path: PathBuf::from("/x"),
        }
    }

    #[test]
    fn tokens_are_single_use_and_kind_bound() {
        let s = Staging::new(DEFAULT_TTL);
        let flag = LockFlag::default();
        let t = s.insert(dest());
        assert!(s.take(t, Kind::Import, &flag).is_err(), "wrong kind");
        assert!(
            s.take(Uuid::new_v4(), Kind::Destination, &flag).is_err(),
            "unknown token"
        );
        assert!(s.take(t, Kind::Destination, &flag).is_ok());
        assert!(s.take(t, Kind::Destination, &flag).is_err(), "single use");
    }

    #[test]
    fn a_new_operation_replaces_the_previous_one_of_its_kind() {
        let s = Staging::new(DEFAULT_TTL);
        let flag = LockFlag::default();
        let a = s.insert(dest());
        let b = s.insert(dest());
        assert!(s.take(a, Kind::Destination, &flag).is_err());
        assert!(s.take(b, Kind::Destination, &flag).is_ok());
    }

    #[test]
    fn entries_expire() {
        let s = Staging::new(Duration::from_millis(0));
        let flag = LockFlag::default();
        let t = s.insert(dest());
        std::thread::sleep(Duration::from_millis(5));
        assert!(s.take(t, Kind::Destination, &flag).is_err());
    }

    #[test]
    fn locking_refuses_and_wipes_everything() {
        let s = Staging::new(DEFAULT_TTL);
        let flag = LockFlag::default();
        let t = s.insert(dest());
        let other = s.insert(Staged::BackupFile {
            bytes: vec![1],
            attempts: 0,
        });
        flag.set(true);
        assert_eq!(
            s.take(t, Kind::Destination, &flag).unwrap_err().code(),
            "locked"
        );
        assert_eq!(s.len(), 0, "decrypted data does not outlive the lock");
        flag.set(false);
        assert!(s.take(other, Kind::BackupFile, &flag).is_err());
    }

    #[test]
    fn cancel_discards() {
        let s = Staging::new(DEFAULT_TTL);
        let flag = LockFlag::default();
        let t = s.insert(dest());
        s.cancel(t);
        assert!(s.take(t, Kind::Destination, &flag).is_err());
    }
}
