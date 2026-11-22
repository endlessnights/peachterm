// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Optional application lock, enforced in Rust.
//!
//! * The lock state lives here ([`LockFlag`]); the renderer overlay is only a
//!   view of it. Every protected IPC command calls [`LockService::guard`], and
//!   the session registry shares the flag, so a compromised or buggy UI cannot
//!   operate a locked application.
//! * The password is never stored: only an Argon2id PHC string (random salt) in
//!   `lock.json`, together with the failed-attempt counter and lock-out
//!   deadline, so restarting the app does not reset the rate limit.
//! * The unlock state is never persisted: with the lock enabled the process
//!   always starts locked.
//! * Inactivity locking runs on a Rust timer thread that sleeps until the
//!   deadline (no polling).
//!
//! An in-app lock does not replace locking the operating system and does not
//! protect against a fully compromised user session (see docs/lock.md).

use crate::error::{AppError, AppResult};
use crate::security::secret::SecretString;
use crate::storage::atomic::save_json;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MIN_PASSWORD_CHARS: usize = 8;
const FREE_ATTEMPTS: u32 = 3;
const MAX_LOCKOUT_SECS: u64 = 15 * 60;

/// Shared, cheap handle to "is the application locked?".
#[derive(Clone, Default)]
pub struct LockFlag(Arc<AtomicBool>);

impl LockFlag {
    pub fn is_locked(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub(crate) fn set(&self, locked: bool) {
        self.0.store(locked, Ordering::SeqCst);
    }
    /// For other services: refuse while locked.
    pub fn guard(&self) -> AppResult<()> {
        if self.is_locked() {
            Err(AppError::Locked)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LockFile {
    version: u32,
    /// Argon2id PHC string. Absent = no password configured.
    verifier: Option<String>,
    failed_attempts: u32,
    lockout_until: u64,
}

struct Inner {
    file: LockFile,
    enabled: bool,
    inactivity: Option<Duration>,
    deadline: Option<Instant>,
}

/// Cost parameters; tests use a cheap profile.
#[derive(Clone, Copy)]
pub struct Kdf {
    memory_kib: u32,
    iterations: u32,
}
impl Kdf {
    /// OWASP-recommended Argon2id minimum (19 MiB, t=2, p=1).
    pub const STRONG: Kdf = Kdf {
        memory_kib: 19 * 1024,
        iterations: 2,
    };
    #[cfg(test)]
    pub const FAST: Kdf = Kdf {
        memory_kib: 64,
        iterations: 1,
    };
    fn argon(self) -> Argon2<'static> {
        let params = Params::new(self.memory_kib, self.iterations, 1, None).expect("valid params");
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    pub enabled: bool,
    /// A password exists, so the lock can actually be enabled.
    pub configured: bool,
    pub locked: bool,
    pub lockout_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "result"
)]
pub enum UnlockOutcome {
    Unlocked,
    Wrong {
        attempts_left_before_delay: u32,
        lockout_seconds: u64,
    },
    LockedOut {
        lockout_seconds: u64,
    },
}

type Notify = Box<dyn Fn(bool) + Send + Sync>;

pub struct LockService {
    path: PathBuf,
    kdf: Kdf,
    flag: LockFlag,
    inner: Mutex<Inner>,
    wake: Condvar,
    notify: Mutex<Option<Notify>>,
    clock: fn() -> u64,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Delay after `failed` consecutive wrong passwords.
pub fn lockout_for(failed: u32) -> u64 {
    if failed < FREE_ATTEMPTS {
        0
    } else {
        (5u64 << (failed - FREE_ATTEMPTS).min(16)).min(MAX_LOCKOUT_SECS)
    }
}

impl LockService {
    /// Never fails because of the file's contents: an unreadable lock file means
    /// "no password configured" (and is reported by the caller).
    pub fn open(path: PathBuf, kdf: Kdf) -> Arc<Self> {
        Self::open_with_clock(path, kdf, unix_now)
    }

    fn open_with_clock(path: PathBuf, kdf: Kdf, clock: fn() -> u64) -> Arc<Self> {
        let file: LockFile = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Arc::new(Self {
            path,
            kdf,
            flag: LockFlag::default(),
            inner: Mutex::new(Inner {
                file,
                enabled: false,
                inactivity: None,
                deadline: None,
            }),
            wake: Condvar::new(),
            notify: Mutex::new(None),
            clock,
        })
    }

    pub fn flag(&self) -> LockFlag {
        self.flag.clone()
    }

    pub fn set_notifier(&self, notify: Notify) {
        if let Ok(mut n) = self.notify.lock() {
            *n = Some(notify);
        }
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit(&self, locked: bool) {
        if let Ok(guard) = self.notify.lock()
            && let Some(f) = guard.as_ref()
        {
            f(locked);
        }
    }

    pub fn guard(&self) -> AppResult<()> {
        self.flag.guard()
    }

    pub fn is_locked(&self) -> bool {
        self.flag.is_locked()
    }

    pub fn has_password(&self) -> bool {
        self.inner().file.verifier.is_some()
    }

    fn persist(&self, file: &LockFile) -> AppResult<()> {
        save_json(&self.path, file)
    }

    /// Apply the user's choices. The lock is only ever on while a password
    /// exists. Called at start-up (which locks) and after settings are saved.
    pub fn configure(&self, enabled: bool, inactivity_minutes: u32, at_startup: bool) -> bool {
        let mut inner = self.inner();
        let effective = enabled && inner.file.verifier.is_some();
        inner.enabled = effective;
        inner.inactivity = (effective && inactivity_minutes > 0)
            .then(|| Duration::from_secs(u64::from(inactivity_minutes) * 60));
        inner.deadline = inner.inactivity.map(|d| Instant::now() + d);
        if !effective {
            self.flag.set(false);
        } else if at_startup {
            self.flag.set(true); // never auto-unlocked after a restart
        }
        drop(inner);
        self.wake.notify_all();
        effective
    }

    pub fn status(&self) -> LockStatus {
        let inner = self.inner();
        LockStatus {
            enabled: inner.enabled,
            configured: inner.file.verifier.is_some(),
            locked: self.flag.is_locked(),
            lockout_seconds: inner.file.lockout_until.saturating_sub((self.clock)()),
        }
    }

    /// Lock now. Refused (not silently ignored) when no password is configured.
    pub fn lock(&self) -> AppResult<()> {
        {
            let inner = self.inner();
            if !inner.enabled {
                return Err(AppError::Validation(
                    "Application lock is not set up. Set a lock password first.".into(),
                ));
            }
        }
        let was = self.flag.0.swap(true, Ordering::SeqCst);
        if !was {
            tracing::info!(event = "lock.locked");
            self.emit(true);
        }
        Ok(())
    }

    pub fn set_password(
        &self,
        new: &SecretString,
        current: Option<&SecretString>,
    ) -> AppResult<()> {
        if new.expose().chars().count() < MIN_PASSWORD_CHARS {
            return Err(AppError::Validation(format!(
                "The lock password must have at least {MIN_PASSWORD_CHARS} characters."
            )));
        }
        let has = self.has_password();
        if has {
            let current = current
                .ok_or_else(|| AppError::Validation("Enter the current lock password.".into()))?;
            if !self.verify_only(current)? {
                return Err(AppError::Validation(
                    "The current lock password is wrong.".into(),
                ));
            }
        }
        let salt = SaltString::generate(&mut OsRng);
        let hash = self
            .kdf
            .argon()
            .hash_password(new.expose().as_bytes(), &salt)
            .map_err(|_| AppError::Credentials("could not derive the lock key".into()))?
            .to_string();
        let mut inner = self.inner();
        let mut file = LockFile {
            version: 1,
            verifier: Some(hash),
            failed_attempts: 0,
            lockout_until: 0,
        };
        std::mem::swap(&mut inner.file, &mut file);
        if let Err(e) = self.persist(&inner.file) {
            std::mem::swap(&mut inner.file, &mut file);
            return Err(e);
        }
        tracing::info!(event = "lock.password_set");
        Ok(())
    }

    /// Remove the password (and with it the lock). Requires the current one.
    pub fn remove_password(&self, current: &SecretString) -> AppResult<()> {
        if !self.verify_only(current)? {
            return Err(AppError::Validation("The lock password is wrong.".into()));
        }
        let mut inner = self.inner();
        let file = LockFile {
            version: 1,
            ..LockFile::default()
        };
        self.persist(&file)?;
        inner.file = file;
        inner.enabled = false;
        inner.deadline = None;
        self.flag.set(false);
        tracing::info!(event = "lock.password_removed");
        Ok(())
    }

    fn verify_only(&self, password: &SecretString) -> AppResult<bool> {
        let phc = self.inner().file.verifier.clone();
        let Some(phc) = phc else { return Ok(false) };
        let parsed = PasswordHash::new(&phc)
            .map_err(|_| AppError::Credentials("lock data is damaged".into()))?;
        Ok(self
            .kdf
            .argon()
            .verify_password(password.expose().as_bytes(), &parsed)
            .is_ok())
    }

    /// Check a password with rate limiting. Wrong attempts and the lock-out
    /// deadline are persisted, so a restart does not reset them.
    pub fn unlock(&self, password: &SecretString) -> AppResult<UnlockOutcome> {
        let now = (self.clock)();
        {
            let inner = self.inner();
            if !self.flag.is_locked() {
                return Ok(UnlockOutcome::Unlocked);
            }
            if inner.file.lockout_until > now {
                return Ok(UnlockOutcome::LockedOut {
                    lockout_seconds: inner.file.lockout_until - now,
                });
            }
        }
        let ok = self.verify_only(password)?;
        let mut inner = self.inner();
        if ok {
            inner.file.failed_attempts = 0;
            inner.file.lockout_until = 0;
            let _ = self.persist(&inner.file);
            inner.deadline = inner.inactivity.map(|d| Instant::now() + d);
            self.flag.set(false);
            drop(inner);
            self.wake.notify_all();
            tracing::info!(event = "lock.unlocked");
            self.emit(false);
            return Ok(UnlockOutcome::Unlocked);
        }
        inner.file.failed_attempts = inner.file.failed_attempts.saturating_add(1);
        let delay = lockout_for(inner.file.failed_attempts);
        inner.file.lockout_until = if delay > 0 { now + delay } else { 0 };
        let attempts = inner.file.failed_attempts;
        let _ = self.persist(&inner.file);
        tracing::warn!(event = "lock.unlock_failed", attempt = u64::from(attempts));
        Ok(UnlockOutcome::Wrong {
            attempts_left_before_delay: FREE_ATTEMPTS.saturating_sub(attempts),
            lockout_seconds: delay,
        })
    }

    /// User activity: pushes the inactivity deadline out.
    pub fn touch(&self) {
        let mut inner = self.inner();
        if let (Some(d), false) = (inner.inactivity, self.flag.is_locked()) {
            inner.deadline = Some(Instant::now() + d);
            drop(inner);
            self.wake.notify_all();
        }
    }

    /// Start the inactivity timer thread. It sleeps until the deadline; there is
    /// no polling.
    pub fn spawn_timer(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        let _ = std::thread::Builder::new()
            .name("peachterm-lock-timer".into())
            .spawn(move || {
                loop {
                    let Some(service) = me.upgrade() else { return };
                    let mut inner = service.inner();
                    loop {
                        match (inner.deadline, service.flag.is_locked()) {
                            (Some(deadline), false) => {
                                let now = Instant::now();
                                if now >= deadline {
                                    inner.deadline = None;
                                    drop(inner);
                                    let _ = service.lock();
                                    break;
                                }
                                inner = service
                                    .wake
                                    .wait_timeout(inner, deadline - now)
                                    .unwrap_or_else(|p| p.into_inner())
                                    .0;
                            }
                            _ => {
                                inner = service
                                    .wake
                                    .wait_timeout(inner, Duration::from_secs(3600))
                                    .unwrap_or_else(|p| p.into_inner())
                                    .0;
                                if Arc::strong_count(&service) == 1 {
                                    return;
                                }
                            }
                        }
                    }
                }
            });
    }

    #[cfg(test)]
    fn set_inactivity_for_test(&self, d: Duration) {
        let mut inner = self.inner();
        inner.inactivity = Some(d);
        inner.deadline = Some(Instant::now() + d);
        drop(inner);
        self.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn pw(s: &str) -> SecretString {
        SecretString::new(s.to_owned())
    }

    fn service(dir: &std::path::Path) -> Arc<LockService> {
        LockService::open(dir.join("lock.json"), Kdf::FAST)
    }

    fn enabled(dir: &std::path::Path) -> Arc<LockService> {
        let s = service(dir);
        s.set_password(&pw("correct horse"), None).unwrap();
        assert!(s.configure(true, 0, false));
        s
    }

    #[test]
    fn disabled_by_default_and_cannot_lock_without_a_password() {
        let dir = tempfile::tempdir().unwrap();
        let s = service(dir.path());
        assert!(!s.status().enabled && !s.status().configured && !s.is_locked());
        assert!(s.lock().is_err());
        // enabling without a password is ignored: no ineffective lock
        assert!(!s.configure(true, 5, true));
        assert!(!s.is_locked() && s.guard().is_ok());
    }

    #[test]
    fn password_is_hashed_never_stored_and_must_be_long_enough() {
        let dir = tempfile::tempdir().unwrap();
        let s = service(dir.path());
        assert!(s.set_password(&pw("short"), None).is_err());
        s.set_password(&pw("correct horse"), None).unwrap();
        let text = std::fs::read_to_string(dir.path().join("lock.json")).unwrap();
        assert!(!text.contains("correct horse"));
        assert!(text.contains("$argon2id$"));
        // random salt: the same password hashes differently
        let other = tempfile::tempdir().unwrap();
        let t = service(other.path());
        t.set_password(&pw("correct horse"), None).unwrap();
        assert_ne!(
            text,
            std::fs::read_to_string(other.path().join("lock.json")).unwrap()
        );
    }

    #[test]
    fn lock_and_unlock_with_the_right_password_only() {
        let dir = tempfile::tempdir().unwrap();
        let s = enabled(dir.path());
        assert!(s.guard().is_ok());
        s.lock().unwrap();
        assert!(s.is_locked());
        assert_eq!(s.guard().unwrap_err().code(), "locked");
        assert!(matches!(
            s.unlock(&pw("wrong")).unwrap(),
            UnlockOutcome::Wrong { .. }
        ));
        assert!(s.is_locked());
        assert_eq!(
            s.unlock(&pw("correct horse")).unwrap(),
            UnlockOutcome::Unlocked
        );
        assert!(s.guard().is_ok());
    }

    #[test]
    fn always_starts_locked_after_a_restart_even_if_it_was_unlocked() {
        let dir = tempfile::tempdir().unwrap();
        let s = enabled(dir.path());
        assert!(!s.is_locked());
        drop(s);
        let restarted = service(dir.path());
        restarted.configure(true, 0, true);
        assert!(
            restarted.is_locked(),
            "unlock state must not survive a restart"
        );
        assert!(restarted.guard().is_err());
    }

    #[test]
    fn rate_limit_grows_and_survives_a_restart() {
        static NOW: AtomicU64 = AtomicU64::new(1_000_000);
        fn clock() -> u64 {
            NOW.load(Ordering::SeqCst)
        }
        let dir = tempfile::tempdir().unwrap();
        let s = LockService::open_with_clock(dir.path().join("lock.json"), Kdf::FAST, clock);
        s.set_password(&pw("correct horse"), None).unwrap();
        s.configure(true, 0, false);
        s.lock().unwrap();
        for _ in 0..3 {
            assert!(matches!(
                s.unlock(&pw("nope")).unwrap(),
                UnlockOutcome::Wrong { .. }
            ));
        }
        // third failure triggered a delay: even the right password is refused now
        match s.unlock(&pw("correct horse")).unwrap() {
            UnlockOutcome::LockedOut { lockout_seconds } => assert!(lockout_seconds > 0),
            other => panic!("expected lock-out, got {other:?}"),
        }
        // restart: the lock-out is still in force
        drop(s);
        let again = LockService::open_with_clock(dir.path().join("lock.json"), Kdf::FAST, clock);
        again.configure(true, 0, true);
        assert!(matches!(
            again.unlock(&pw("correct horse")).unwrap(),
            UnlockOutcome::LockedOut { .. }
        ));
        // after the delay the right password works and resets the counter
        NOW.fetch_add(60, Ordering::SeqCst);
        assert_eq!(
            again.unlock(&pw("correct horse")).unwrap(),
            UnlockOutcome::Unlocked
        );
        assert_eq!(again.status().lockout_seconds, 0);
    }

    #[test]
    fn lockout_schedule_is_exponential_and_capped() {
        assert_eq!([0, 1, 2].map(lockout_for), [0, 0, 0]);
        assert_eq!([3, 4, 5].map(lockout_for), [5, 10, 20]);
        assert_eq!(lockout_for(100), MAX_LOCKOUT_SECS);
    }

    #[test]
    fn changing_or_removing_the_password_needs_the_current_one() {
        let dir = tempfile::tempdir().unwrap();
        let s = enabled(dir.path());
        assert!(s.set_password(&pw("another long one"), None).is_err());
        assert!(
            s.set_password(&pw("another long one"), Some(&pw("bad")))
                .is_err()
        );
        s.set_password(&pw("another long one"), Some(&pw("correct horse")))
            .unwrap();
        assert!(s.remove_password(&pw("correct horse")).is_err());
        s.lock().unwrap();
        assert_eq!(
            s.unlock(&pw("another long one")).unwrap(),
            UnlockOutcome::Unlocked
        );
        s.remove_password(&pw("another long one")).unwrap();
        assert!(!s.has_password() && !s.status().enabled && s.guard().is_ok());
    }

    #[test]
    fn inactivity_locks_from_the_rust_timer_and_activity_defers_it() {
        let dir = tempfile::tempdir().unwrap();
        let s = enabled(dir.path());
        s.spawn_timer();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        s.set_notifier(Box::new(move |l| sink.lock().unwrap().push(l)));
        s.set_inactivity_for_test(Duration::from_millis(300));
        std::thread::sleep(Duration::from_millis(150));
        s.touch(); // activity pushes the deadline out
        std::thread::sleep(Duration::from_millis(200));
        assert!(!s.is_locked(), "touch must defer the lock");
        std::thread::sleep(Duration::from_millis(400));
        assert!(s.is_locked(), "timer must lock after inactivity");
        assert_eq!(*events.lock().unwrap(), vec![true]);
    }

    #[test]
    fn a_damaged_lock_file_means_no_password_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("lock.json"), b"{ garbage").unwrap();
        let s = service(dir.path());
        assert!(!s.has_password());
    }

    #[test]
    fn wire_format_is_camel_case() {
        let wrong = serde_json::to_value(UnlockOutcome::Wrong {
            attempts_left_before_delay: 2,
            lockout_seconds: 0,
        })
        .unwrap();
        assert_eq!(wrong["result"], "wrong");
        assert_eq!(wrong["attemptsLeftBeforeDelay"], 2);
        let out = serde_json::to_value(UnlockOutcome::LockedOut { lockout_seconds: 5 }).unwrap();
        assert_eq!(
            (out["result"].as_str(), out["lockoutSeconds"].as_u64()),
            (Some("lockedOut"), Some(5))
        );
    }
}
