// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! "Clear all saved passwords", made hard to do by accident.
//!
//! Rust, not the renderer, owns the second confirmation: [`ClearGuard::begin`]
//! creates a short-lived, single-use token together with a small arithmetic
//! question; deletion only happens when the token and the right answer come
//! back to [`ClearGuard::verify`]. The question is an accidental-deletion
//! safeguard, not authentication.
//!
//! Only PeachTerm's own entries (`connection:<id>` accounts) are ever touched.

use super::credentials::{CredentialStore, connection_account};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const TOKEN_LIFETIME: Duration = Duration::from_secs(60);
pub const MAX_WRONG_ANSWERS: u8 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub token: Uuid,
    /// For example `7 + 5` (the user types the result).
    pub question: String,
    pub expires_in_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No confirmation is pending, or it belongs to another operation.
    Unknown,
    Expired,
    WrongAnswer,
    /// Too many wrong answers: ask for a new confirmation.
    TooManyAttempts,
}

struct Pending {
    token: Uuid,
    answer: i64,
    expires: Instant,
    wrong: u8,
}

#[derive(Default)]
pub struct ClearGuard {
    pending: Mutex<Option<Pending>>,
}

impl ClearGuard {
    pub fn begin(&self) -> Challenge {
        self.begin_at(Instant::now())
    }

    pub(crate) fn begin_at(&self, now: Instant) -> Challenge {
        let bytes = *Uuid::new_v4().as_bytes();
        let a = i64::from(bytes[0] % 10) + 3; // 3..=12
        let b = i64::from(bytes[1] % 10) + 3;
        let (question, answer) = if bytes[2].is_multiple_of(2) {
            (format!("{a} + {b}"), a + b)
        } else {
            (format!("{a} × {b}"), a * b)
        };
        let token = Uuid::new_v4();
        *self.pending.lock().unwrap() = Some(Pending {
            token,
            answer,
            expires: now + TOKEN_LIFETIME,
            wrong: 0,
        });
        Challenge {
            token,
            question,
            expires_in_secs: TOKEN_LIFETIME.as_secs(),
        }
    }

    pub fn verify(&self, token: Uuid, answer: i64) -> Result<(), Refusal> {
        self.verify_at(Instant::now(), token, answer)
    }

    pub(crate) fn verify_at(&self, now: Instant, token: Uuid, answer: i64) -> Result<(), Refusal> {
        let mut guard = self.pending.lock().unwrap();
        let Some(pending) = guard.as_mut() else {
            return Err(Refusal::Unknown);
        };
        if pending.token != token {
            return Err(Refusal::Unknown);
        }
        if now >= pending.expires {
            *guard = None;
            return Err(Refusal::Expired);
        }
        if pending.answer != answer {
            pending.wrong += 1;
            if pending.wrong >= MAX_WRONG_ANSWERS {
                *guard = None;
                return Err(Refusal::TooManyAttempts);
            }
            return Err(Refusal::WrongAnswer);
        }
        *guard = None; // single use
        Ok(())
    }

    pub fn cancel(&self) {
        *self.pending.lock().unwrap() = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Outcome {
    pub deleted: usize,
    pub failed: usize,
}

/// Delete PeachTerm's saved secrets. Every entry is attempted: a failure on one
/// does not stop the others. `entries` are (saved connection id, "a secret is
/// recorded for it"); `on_deleted` is called for each recorded secret that is
/// gone so the caller can update its flag. Entries without a record are still
/// deleted if present (the record and the store may have drifted apart) but are
/// not counted.
pub fn clear_all(
    store: &dyn CredentialStore,
    entries: &[(Uuid, bool)],
    mut on_deleted: impl FnMut(Uuid),
) -> Outcome {
    let mut outcome = Outcome {
        deleted: 0,
        failed: 0,
    };
    for (id, recorded) in entries {
        match store.delete(&connection_account(id)) {
            Ok(()) if *recorded => {
                outcome.deleted += 1;
                on_deleted(*id);
            }
            Ok(()) => {}
            Err(_) if *recorded => outcome.failed += 1,
            Err(_) => {}
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{AppError, AppResult};
    use crate::security::credentials::{CredentialStatus, MemoryCredentialStore};
    use crate::security::secret::SecretString;
    use std::collections::HashSet;

    fn solve(question: &str) -> i64 {
        let parts: Vec<&str> = question.split(' ').collect();
        let (a, b): (i64, i64) = (parts[0].parse().unwrap(), parts[2].parse().unwrap());
        match parts[1] {
            "+" => a + b,
            "×" => a * b,
            other => panic!("unexpected operator {other}"),
        }
    }

    #[test]
    fn the_right_answer_with_the_right_token_is_accepted_exactly_once() {
        let guard = ClearGuard::default();
        let c = guard.begin();
        assert_eq!(c.expires_in_secs, 60);
        assert_eq!(guard.verify(c.token, solve(&c.question)), Ok(()));
        assert_eq!(
            guard.verify(c.token, solve(&c.question)),
            Err(Refusal::Unknown),
            "single use"
        );
    }

    #[test]
    fn questions_are_small_sums_and_products() {
        let guard = ClearGuard::default();
        let mut seen_plus = false;
        let mut seen_times = false;
        for _ in 0..200 {
            let c = guard.begin();
            let answer = solve(&c.question);
            assert!((6..=144).contains(&answer), "{}", c.question);
            seen_plus |= c.question.contains('+');
            seen_times |= c.question.contains('×');
        }
        assert!(seen_plus && seen_times);
    }

    #[test]
    fn a_wrong_answer_does_not_delete_and_three_invalidate_the_token() {
        let guard = ClearGuard::default();
        let c = guard.begin();
        let right = solve(&c.question);
        assert_eq!(guard.verify(c.token, right + 1), Err(Refusal::WrongAnswer));
        assert_eq!(guard.verify(c.token, -1), Err(Refusal::WrongAnswer));
        assert_eq!(guard.verify(c.token, 0), Err(Refusal::TooManyAttempts));
        // even the right answer no longer works: a new confirmation is needed
        assert_eq!(guard.verify(c.token, right), Err(Refusal::Unknown));
    }

    #[test]
    fn tokens_expire() {
        let guard = ClearGuard::default();
        let start = Instant::now();
        let c = guard.begin_at(start);
        let late = start + TOKEN_LIFETIME + Duration::from_secs(1);
        assert_eq!(
            guard.verify_at(late, c.token, solve(&c.question)),
            Err(Refusal::Expired)
        );
        assert_eq!(
            guard.verify_at(start, c.token, solve(&c.question)),
            Err(Refusal::Unknown)
        );
    }

    #[test]
    fn a_made_up_or_old_token_is_refused_and_a_new_challenge_replaces_the_old() {
        let guard = ClearGuard::default();
        assert_eq!(guard.verify(Uuid::new_v4(), 1), Err(Refusal::Unknown));
        let first = guard.begin();
        let second = guard.begin();
        assert_ne!(first.token, second.token);
        assert_eq!(
            guard.verify(first.token, solve(&first.question)),
            Err(Refusal::Unknown)
        );
        assert_eq!(guard.verify(second.token, solve(&second.question)), Ok(()));
    }

    #[test]
    fn cancelling_forgets_the_confirmation() {
        let guard = ClearGuard::default();
        let c = guard.begin();
        guard.cancel();
        assert_eq!(
            guard.verify(c.token, solve(&c.question)),
            Err(Refusal::Unknown)
        );
    }

    struct FlakyStore {
        inner: MemoryCredentialStore,
        failing: HashSet<String>,
    }

    impl CredentialStore for FlakyStore {
        fn status(&self) -> CredentialStatus {
            self.inner.status()
        }
        fn set(&self, account: &str, secret: &SecretString) -> AppResult<()> {
            self.inner.set(account, secret)
        }
        fn get(&self, account: &str) -> AppResult<Option<SecretString>> {
            self.inner.get(account)
        }
        fn delete(&self, account: &str) -> AppResult<()> {
            if self.failing.contains(account) {
                return Err(AppError::Credentials("simulated failure".into()));
            }
            self.inner.delete(account)
        }
    }

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn deletes_only_peachterm_entries_and_reports_partial_failures() {
        let store = FlakyStore {
            inner: MemoryCredentialStore::new(),
            failing: [connection_account(&id(2))].into(),
        };
        let secret = SecretString::new("s3cret".into());
        for n in 1..=3 {
            store.set(&connection_account(&id(n)), &secret).unwrap();
        }
        // not ours: another application's credential in the same store
        store.set("other-app:work", &secret).unwrap();
        store.set("connection-not-ours", &secret).unwrap();

        let mut cleared = Vec::new();
        let outcome = clear_all(
            &store,
            &[(id(1), true), (id(2), true), (id(3), true)],
            |i| cleared.push(i),
        );
        assert_eq!(
            outcome,
            Outcome {
                deleted: 2,
                failed: 1
            }
        );
        assert_eq!(
            cleared,
            [id(1), id(3)],
            "flags are cleared only for deleted ones"
        );
        assert!(store.get(&connection_account(&id(1))).unwrap().is_none());
        assert!(
            store.get(&connection_account(&id(2))).unwrap().is_some(),
            "the failed entry is still there (and still flagged)"
        );
        assert!(store.get(&connection_account(&id(3))).unwrap().is_none());
        assert!(store.get("other-app:work").unwrap().is_some());
        assert!(store.get("connection-not-ours").unwrap().is_some());
    }

    #[test]
    fn unrecorded_leftovers_are_removed_but_not_counted() {
        let store = MemoryCredentialStore::new();
        let secret = SecretString::new("x".into());
        store.set(&connection_account(&id(1)), &secret).unwrap();
        store.set(&connection_account(&id(2)), &secret).unwrap();
        let outcome = clear_all(&store, &[(id(1), true), (id(2), false)], |_| {});
        assert_eq!(
            outcome,
            Outcome {
                deleted: 1,
                failed: 0
            }
        );
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn nothing_is_deleted_without_calling_clear_all() {
        // verify() alone never touches the store
        let store = MemoryCredentialStore::new();
        store
            .set(&connection_account(&id(1)), &SecretString::new("x".into()))
            .unwrap();
        let guard = ClearGuard::default();
        let c = guard.begin();
        let _ = guard.verify(c.token, 0);
        assert_eq!(store.len(), 1);
    }
}
