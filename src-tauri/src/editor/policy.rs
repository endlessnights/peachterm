// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Remote-write confirmation policy for external-editor uploads.
//!
//! INVARIANTS (security-critical, covered by tests below and in `sessions`):
//!
//! 1. Every connection session starts with [`RemoteWritePolicy::AlwaysAsk`].
//! 2. [`RemoteWritePolicy`] implements neither `Serialize` nor `Deserialize`
//!    (checked at compile time below), so an override can never be written to
//!    settings, workspace-restore data, or sent/received over IPC.
//! 3. An upload needs an [`UploadAuthorization`]. Its fields are private and
//!    the only constructors are in this module: [`evaluate`] (when the
//!    in-memory session override is active) and [`apply_answer`] (after an
//!    explicit user answer). Nothing else can produce one.

use crate::sessions::SessionId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RemoteWritePolicy {
    /// Ask before every upload. The only possible initial state.
    #[default]
    AlwaysAsk,
    /// User chose "Yes to all" for *this* connection session. In memory only.
    AutoUploadThisSession,
}

/// The user's answer to a "Remote file modified" prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserAnswer {
    Yes,
    YesToAll,
    No,
    Cancel,
}

/// What is about to be written: bound to one session, one remote path and the
/// exact content that the user saw change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteRequest {
    pub session: SessionId,
    pub remote_path: String,
    pub content_sha256: [u8; 32],
}

/// Proof that a specific upload was authorised. Not `Clone`: one upload each.
#[derive(Debug, PartialEq, Eq)]
pub struct UploadAuthorization {
    session: SessionId,
    remote_path: String,
    content_sha256: [u8; 32],
}

impl UploadAuthorization {
    pub fn session(&self) -> SessionId {
        self.session
    }
    pub fn remote_path(&self) -> &str {
        &self.remote_path
    }
    /// The uploader must re-hash the bytes it sends and compare.
    pub fn covers(&self, content_sha256: &[u8; 32]) -> bool {
        &self.content_sha256 == content_sha256
    }

    fn for_request(request: &WriteRequest) -> Self {
        Self {
            session: request.session,
            remote_path: request.remote_path.clone(),
            content_sha256: request.content_sha256,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Upload may proceed without a prompt (session override active).
    Upload(UploadAuthorization),
    /// A confirmation prompt must be shown.
    Prompt,
}

pub fn evaluate(policy: RemoteWritePolicy, request: &WriteRequest) -> Decision {
    match policy {
        RemoteWritePolicy::AlwaysAsk => Decision::Prompt,
        RemoteWritePolicy::AutoUploadThisSession => {
            Decision::Upload(UploadAuthorization::for_request(request))
        }
    }
}

/// Apply an explicit answer. "Yes to all" upgrades the *session's* in-memory
/// policy; "No"/"Cancel" never authorise anything.
pub fn apply_answer(
    policy: &mut RemoteWritePolicy,
    answer: UserAnswer,
    request: &WriteRequest,
) -> Option<UploadAuthorization> {
    match answer {
        UserAnswer::Yes => Some(UploadAuthorization::for_request(request)),
        UserAnswer::YesToAll => {
            *policy = RemoteWritePolicy::AutoUploadThisSession;
            Some(UploadAuthorization::for_request(request))
        }
        UserAnswer::No | UserAnswer::Cancel => None,
    }
}

// --- compile-time proof that the policy cannot be (de)serialised -----------
// Same technique as `static_assertions::assert_not_impl_any!`: if
// `RemoteWritePolicy` implemented Serialize or Deserialize, the type parameter
// of `AmbiguousIfImpl` could not be inferred and this would fail to compile.
#[allow(dead_code)]
trait AmbiguousIfImpl<A> {
    fn some_item() {}
}
impl<T: ?Sized> AmbiguousIfImpl<()> for T {}
#[allow(dead_code)]
struct InvalidSer;
impl<T: ?Sized + serde::Serialize> AmbiguousIfImpl<InvalidSer> for T {}
#[allow(dead_code)]
struct InvalidDe;
impl<T: for<'de> serde::Deserialize<'de>> AmbiguousIfImpl<InvalidDe> for T {}
const _: fn() = || {
    let _ = <RemoteWritePolicy as AmbiguousIfImpl<_>>::some_item;
};

#[cfg(test)]
mod tests {
    use super::*;

    fn request(session: SessionId) -> WriteRequest {
        WriteRequest {
            session,
            remote_path: "/etc/ssh/sshd_config".into(),
            content_sha256: [7; 32],
        }
    }

    #[test]
    fn default_is_always_ask() {
        assert_eq!(RemoteWritePolicy::default(), RemoteWritePolicy::AlwaysAsk);
    }

    #[test]
    fn always_ask_never_authorises_without_answer() {
        let r = request(SessionId::new());
        assert_eq!(evaluate(RemoteWritePolicy::AlwaysAsk, &r), Decision::Prompt);
    }

    #[test]
    fn yes_authorises_once_without_changing_policy() {
        let r = request(SessionId::new());
        let mut policy = RemoteWritePolicy::AlwaysAsk;
        let auth = apply_answer(&mut policy, UserAnswer::Yes, &r).unwrap();
        assert!(auth.covers(&[7; 32]));
        assert!(!auth.covers(&[8; 32]));
        assert_eq!(policy, RemoteWritePolicy::AlwaysAsk);
        assert_eq!(evaluate(policy, &r), Decision::Prompt);
    }

    #[test]
    fn yes_to_all_switches_session_policy() {
        let r = request(SessionId::new());
        let mut policy = RemoteWritePolicy::AlwaysAsk;
        assert!(apply_answer(&mut policy, UserAnswer::YesToAll, &r).is_some());
        assert_eq!(policy, RemoteWritePolicy::AutoUploadThisSession);
        assert!(matches!(evaluate(policy, &r), Decision::Upload(_)));
    }

    #[test]
    fn no_and_cancel_never_authorise() {
        let r = request(SessionId::new());
        for answer in [UserAnswer::No, UserAnswer::Cancel] {
            let mut policy = RemoteWritePolicy::AlwaysAsk;
            assert!(apply_answer(&mut policy, answer, &r).is_none());
            assert_eq!(policy, RemoteWritePolicy::AlwaysAsk);
        }
    }

    #[test]
    fn authorization_is_bound_to_session_and_path() {
        let s = SessionId::new();
        let auth = match evaluate(RemoteWritePolicy::AutoUploadThisSession, &request(s)) {
            Decision::Upload(a) => a,
            Decision::Prompt => unreachable!(),
        };
        assert_eq!(auth.session(), s);
        assert_eq!(auth.remote_path(), "/etc/ssh/sshd_config");
    }
}
