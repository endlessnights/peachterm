//! Connection sessions: one per *connection attempt*.
//!
//! A session is the unit that owns the SSH transport (Phase 2), the SFTP
//! channel (Phase 3) and the in-memory remote-write policy (Phase 4).
//! Reconnecting never reuses a session: it creates a new one with a new id and
//! therefore a fresh `RemoteWritePolicy::AlwaysAsk`. Nothing in this module is
//! persisted.

use crate::editor::policy::{self, Decision, RemoteWritePolicy, UserAnswer, WriteRequest};
use crate::error::{AppError, AppResult};
use crate::lock::LockFlag;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct SessionId(Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn uuid(&self) -> Uuid {
        self.0
    }

    pub fn parse(text: &str) -> Option<Self> {
        Uuid::parse_str(text).ok().map(Self)
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug)]
#[allow(dead_code)] // id and connection_id are read by the SSH service (Phase 2)
pub struct ConnectionSession {
    pub id: SessionId,
    pub connection_id: Uuid,
    write_policy: RemoteWritePolicy,
}

#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<SessionId, ConnectionSession>>,
    lock: LockFlag,
}

#[allow(dead_code)] // driven by the SSH service from Phase 2 on
impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registry whose operations are refused while the application is locked.
    pub fn with_lock(lock: LockFlag) -> Self {
        Self {
            sessions: Mutex::default(),
            lock,
        }
    }

    /// Called when the application locks: every "Yes to all" override is
    /// dropped, so uploads need a fresh confirmation after unlocking.
    pub fn reset_write_policies(&self) -> AppResult<()> {
        for session in self.lock()?.values_mut() {
            session.write_policy = RemoteWritePolicy::AlwaysAsk;
        }
        Ok(())
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<SessionId, ConnectionSession>>> {
        self.sessions
            .lock()
            .map_err(|_| AppError::Storage("session registry lock poisoned".into()))
    }

    /// Start a new session. The policy is always `AlwaysAsk`; there is no
    /// parameter to start in any other state.
    pub fn open(&self, connection_id: Uuid) -> AppResult<SessionId> {
        self.lock.guard()?;
        let id = SessionId::new();
        self.lock()?.insert(
            id,
            ConnectionSession {
                id,
                connection_id,
                write_policy: RemoteWritePolicy::AlwaysAsk,
            },
        );
        Ok(id)
    }

    /// Dropping the session discards any in-memory override with it.
    pub fn close(&self, id: SessionId) -> AppResult<bool> {
        Ok(self.lock()?.remove(&id).is_some())
    }

    pub fn write_policy(&self, id: SessionId) -> AppResult<RemoteWritePolicy> {
        self.lock()?
            .get(&id)
            .map(|s| s.write_policy)
            .ok_or_else(|| AppError::NotFound("session".into()))
    }

    pub fn evaluate_write(&self, request: &WriteRequest) -> AppResult<Decision> {
        self.lock.guard()?;
        let policy = self.write_policy(request.session)?;
        Ok(policy::evaluate(policy, request))
    }

    pub fn answer_write(
        &self,
        request: &WriteRequest,
        answer: UserAnswer,
    ) -> AppResult<Option<policy::UploadAuthorization>> {
        self.lock.guard()?;
        let mut sessions = self.lock()?;
        let session = sessions
            .get_mut(&request.session)
            .ok_or_else(|| AppError::NotFound("session".into()))?;
        Ok(policy::apply_answer(
            &mut session.write_policy,
            answer,
            request,
        ))
    }

    pub fn count(&self) -> usize {
        self.lock().map(|s| s.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(session: SessionId) -> WriteRequest {
        WriteRequest {
            session,
            remote_path: "/etc/hosts".into(),
            content_sha256: [1; 32],
        }
    }

    /// Model of the mandatory security regression test (steps 1–8); the full
    /// end-to-end version with real uploads lands in Phase 4.
    #[test]
    fn yes_to_all_does_not_survive_reconnect() {
        let registry = SessionRegistry::new();
        let server_a = Uuid::new_v4();

        // 1–3: connect, edit, "Yes to all"
        let first = registry.open(server_a).unwrap();
        assert_eq!(
            registry.evaluate_write(&req(first)).unwrap(),
            Decision::Prompt
        );
        assert!(
            registry
                .answer_write(&req(first), UserAnswer::YesToAll)
                .unwrap()
                .is_some()
        );
        // 4: further saves in the same session upload without prompting
        assert!(matches!(
            registry.evaluate_write(&req(first)).unwrap(),
            Decision::Upload(_)
        ));

        // 5–6: disconnect and reconnect to the same server
        assert!(registry.close(first).unwrap());
        let second = registry.open(server_a).unwrap();
        assert_ne!(first, second);

        // 7–8: confirmation is required again
        assert_eq!(
            registry.write_policy(second).unwrap(),
            RemoteWritePolicy::AlwaysAsk
        );
        assert_eq!(
            registry.evaluate_write(&req(second)).unwrap(),
            Decision::Prompt
        );
        // The closed session can no longer authorise anything.
        assert!(registry.evaluate_write(&req(first)).is_err());
    }

    #[test]
    fn parallel_sessions_to_same_server_are_independent() {
        let registry = SessionRegistry::new();
        let server = Uuid::new_v4();
        let a = registry.open(server).unwrap();
        let b = registry.open(server).unwrap();
        registry
            .answer_write(&req(a), UserAnswer::YesToAll)
            .unwrap();
        assert_eq!(
            registry.write_policy(b).unwrap(),
            RemoteWritePolicy::AlwaysAsk
        );
    }

    #[test]
    fn fresh_registry_models_app_restart() {
        // Steps 9–11: a restart creates a new registry; nothing is loaded
        // from disk, so every restored session starts with AlwaysAsk.
        let registry = SessionRegistry::new();
        let restored = registry.open(Uuid::new_v4()).unwrap();
        assert_eq!(
            registry.write_policy(restored).unwrap(),
            RemoteWritePolicy::AlwaysAsk
        );
    }

    #[test]
    fn unknown_session_cannot_be_answered() {
        let registry = SessionRegistry::new();
        assert!(
            registry
                .answer_write(&req(SessionId::new()), UserAnswer::Yes)
                .is_err()
        );
    }

    #[test]
    fn locking_blocks_session_operations_and_forgets_yes_to_all() {
        let lock = crate::lock::LockService::open(
            std::env::temp_dir().join(format!("peachterm-lock-{}.json", Uuid::new_v4())),
            crate::lock::Kdf::FAST,
        );
        lock.set_password(
            &crate::security::secret::SecretString::new("correct horse".into()),
            None,
        )
        .unwrap();
        lock.configure(true, 0, false);
        let registry = SessionRegistry::with_lock(lock.flag());
        let id = registry.open(Uuid::new_v4()).unwrap();
        registry
            .answer_write(&req(id), UserAnswer::YesToAll)
            .unwrap();
        assert!(matches!(
            registry.evaluate_write(&req(id)).unwrap(),
            Decision::Upload(_)
        ));

        lock.lock().unwrap();
        registry.reset_write_policies().unwrap();
        assert_eq!(
            registry.evaluate_write(&req(id)).unwrap_err().code(),
            "locked"
        );
        assert_eq!(
            registry
                .answer_write(&req(id), UserAnswer::Yes)
                .unwrap_err()
                .code(),
            "locked"
        );
        assert_eq!(registry.open(Uuid::new_v4()).unwrap_err().code(), "locked");

        lock.unlock(&crate::security::secret::SecretString::new(
            "correct horse".into(),
        ))
        .unwrap();
        // after unlocking, a fresh confirmation is required again
        assert_eq!(
            registry.write_policy(id).unwrap(),
            RemoteWritePolicy::AlwaysAsk
        );
        assert_eq!(registry.evaluate_write(&req(id)).unwrap(), Decision::Prompt);
    }
}
