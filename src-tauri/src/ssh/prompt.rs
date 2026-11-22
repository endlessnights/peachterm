//! Questions the SSH layer must ask the user while connecting: "do you trust
//! this host key?" and credential prompts (password, key passphrase,
//! keyboard-interactive). Each question is an event for the renderer plus a
//! one-shot answer channel; the connection task awaits the answer.
//!
//! Answers are matched by an unguessable prompt id that is single-use and tied
//! to the session that asked, and every question times out, so a missing UI can
//! never leave a connection half-open forever.

use crate::security::secret::SecretString;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use uuid::Uuid;

pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyDecision {
    /// Trust this key for this connection only (nothing is stored).
    TrustOnce,
    /// Trust and remember (known hosts).
    TrustAndSave,
    /// A changed key: replace the stored one. Only valid for a `changed` prompt.
    Replace,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptLine {
    pub text: String,
    pub echo: bool,
}

/// What the renderer is asked. Contains no secrets (only the question).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PromptEvent {
    HostKey {
        prompt_id: Uuid,
        session_id: Uuid,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
        /// Fingerprint stored before; present when the key CHANGED.
        previous_fingerprint: Option<String>,
    },
    Auth {
        prompt_id: Uuid,
        session_id: Uuid,
        /// `password`, `passphrase` or `keyboardInteractive`.
        method: &'static str,
        name: String,
        instructions: String,
        prompts: Vec<AuthPromptLine>,
        /// Previous attempt failed.
        retry: bool,
    },
}

pub enum Answer {
    HostKey(HostKeyDecision),
    /// `None` = the user cancelled.
    Secrets(Option<Vec<SecretString>>),
}

pub type Emitter = Arc<dyn Fn(PromptEvent) + Send + Sync>;

type PendingMap = HashMap<Uuid, (Uuid, oneshot::Sender<Answer>)>;

#[derive(Clone)]
pub struct Prompts {
    pending: Arc<Mutex<PendingMap>>,
    emit: Emitter,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AskError {
    Timeout,
    Cancelled,
}

impl Prompts {
    pub fn new(emit: Emitter) -> Self {
        Self {
            pending: Arc::default(),
            emit,
        }
    }

    /// Register a question and tell the UI. Returns the receiver to await.
    fn register(
        &self,
        make: impl FnOnce(Uuid) -> PromptEvent,
        session: Uuid,
    ) -> (Uuid, oneshot::Receiver<Answer>) {
        let id = Uuid::new_v4();
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, (session, tx));
        }
        (self.emit)(make(id));
        (id, rx)
    }

    async fn wait(&self, id: Uuid, rx: oneshot::Receiver<Answer>) -> Result<Answer, AskError> {
        let result = tokio::time::timeout(PROMPT_TIMEOUT, rx).await;
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
        match result {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Err(AskError::Cancelled),
            Err(_) => Err(AskError::Timeout),
        }
    }

    pub async fn ask_host_key(
        &self,
        session: Uuid,
        host: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
        previous: Option<&str>,
    ) -> Result<HostKeyDecision, AskError> {
        let (id, rx) = self.register(
            |prompt_id| PromptEvent::HostKey {
                prompt_id,
                session_id: session,
                host: host.to_owned(),
                port,
                algorithm: algorithm.to_owned(),
                fingerprint: fingerprint.to_owned(),
                previous_fingerprint: previous.map(str::to_owned),
            },
            session,
        );
        match self.wait(id, rx).await? {
            Answer::HostKey(d) => Ok(d),
            Answer::Secrets(_) => Err(AskError::Cancelled),
        }
    }

    /// `None` = cancelled by the user.
    pub async fn ask_secrets(
        &self,
        session: Uuid,
        method: &'static str,
        name: &str,
        instructions: &str,
        prompts: Vec<AuthPromptLine>,
        retry: bool,
    ) -> Result<Option<Vec<SecretString>>, AskError> {
        let (id, rx) = self.register(
            |prompt_id| PromptEvent::Auth {
                prompt_id,
                session_id: session,
                method,
                name: name.to_owned(),
                instructions: instructions.to_owned(),
                prompts,
                retry,
            },
            session,
        );
        match self.wait(id, rx).await? {
            Answer::Secrets(s) => Ok(s),
            Answer::HostKey(_) => Err(AskError::Cancelled),
        }
    }

    /// Deliver the user's answer. Returns false for unknown, already answered
    /// or expired ids (single use).
    pub fn answer(&self, prompt_id: Uuid, answer: Answer) -> bool {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut p| p.remove(&prompt_id));
        match sender {
            Some((_, tx)) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// Drop every question of a session (it was closed): waiters see `Cancelled`.
    pub fn cancel_session(&self, session: Uuid) {
        if let Ok(mut p) = self.pending.lock() {
            p.retain(|_, (s, _)| *s != session);
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|p| p.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collecting() -> (Prompts, Arc<Mutex<Vec<PromptEvent>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (
            Prompts::new(Arc::new(move |e| sink.lock().unwrap().push(e))),
            seen,
        )
    }

    fn id_of(e: &PromptEvent) -> Uuid {
        match e {
            PromptEvent::HostKey { prompt_id, .. } | PromptEvent::Auth { prompt_id, .. } => {
                *prompt_id
            }
        }
    }

    #[tokio::test]
    async fn host_key_question_is_answered_once() {
        let (p, seen) = collecting();
        let s = Uuid::new_v4();
        let p2 = p.clone();
        let asker = tokio::spawn(async move {
            p2.ask_host_key(s, "h", 22, "ssh-ed25519", "SHA256:x", None)
                .await
        });
        while seen.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let id = id_of(&seen.lock().unwrap()[0]);
        assert!(p.answer(id, Answer::HostKey(HostKeyDecision::TrustOnce)));
        assert!(
            !p.answer(id, Answer::HostKey(HostKeyDecision::TrustAndSave)),
            "single use"
        );
        assert_eq!(asker.await.unwrap(), Ok(HostKeyDecision::TrustOnce));
        assert_eq!(p.pending_count(), 0);
    }

    #[tokio::test]
    async fn unknown_ids_are_ignored_and_closing_a_session_cancels_its_questions() {
        let (p, seen) = collecting();
        assert!(!p.answer(Uuid::new_v4(), Answer::Secrets(None)));
        let s = Uuid::new_v4();
        let p2 = p.clone();
        let asker = tokio::spawn(async move {
            p2.ask_secrets(
                s,
                "password",
                "",
                "",
                vec![AuthPromptLine {
                    text: "Password".into(),
                    echo: false,
                }],
                false,
            )
            .await
        });
        while seen.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        p.cancel_session(s);
        assert!(matches!(asker.await.unwrap(), Err(AskError::Cancelled)));
    }

    #[test]
    fn events_never_carry_secrets_and_use_camel_case() {
        let json = serde_json::to_value(PromptEvent::HostKey {
            prompt_id: Uuid::nil(),
            session_id: Uuid::nil(),
            host: "h".into(),
            port: 22,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:x".into(),
            previous_fingerprint: None,
        })
        .unwrap();
        assert_eq!(json["kind"], "hostKey");
        assert!(json.get("promptId").is_some() && json.get("previousFingerprint").is_some());
    }
}
