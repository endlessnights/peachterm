//! Connecting and authenticating (russh). Everything here is platform
//! independent except locating the SSH agent.
//!
//! Security rules enforced here:
//! * The host key is verified before any credential is sent. Unknown and
//!   changed keys stop the handshake until the user decides (`Prompts`); a
//!   changed key can only be accepted with an explicit `Replace`.
//! * Secrets live in `SecretString`, are never logged, and prompts carry only
//!   the question.
//! * All failures are reported as fixed tokens ([`SshError::token`]).

use super::prompt::{AskError, AuthPromptLine, HostKeyDecision, Prompts};
use crate::security::credentials::CredentialStore;
use crate::security::known_hosts::{HostKeyStatus, KnownHostsStore};
use crate::storage::connections::AuthMethod;
use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKeyWithHashAlg, load_secret_key};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshError {
    ConnectFailed,
    Timeout,
    HostKeyRejected,
    AuthFailed,
    Cancelled,
    KeyUnreadable,
    AgentUnavailable,
    Protocol,
}

impl SshError {
    /// Fixed vocabulary for logs and the UI (see `logging::fields`).
    pub fn token(self) -> &'static str {
        match self {
            SshError::ConnectFailed => "connect_failed",
            SshError::Timeout => "timeout",
            SshError::HostKeyRejected => "host_key_rejected",
            SshError::AuthFailed => "auth_failed",
            SshError::Cancelled => "cancelled",
            SshError::KeyUnreadable => "key_unreadable",
            SshError::AgentUnavailable => "agent_unavailable",
            SshError::Protocol => "protocol_error",
        }
    }
}

impl From<AskError> for SshError {
    fn from(e: AskError) -> Self {
        match e {
            AskError::Timeout => SshError::Timeout,
            AskError::Cancelled => SshError::Cancelled,
        }
    }
}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        match e {
            russh::Error::UnknownKey => SshError::HostKeyRejected,
            russh::Error::ConnectionTimeout
            | russh::Error::KeepaliveTimeout
            | russh::Error::InactivityTimeout => SshError::Timeout,
            russh::Error::IO(_) | russh::Error::Disconnect | russh::Error::HUP => {
                SshError::ConnectFailed
            }
            _ => SshError::Protocol,
        }
    }
}

/// Where and how to connect.
#[derive(Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
    pub connect_timeout: Duration,
    pub keepalive: Option<Duration>,
    /// Keychain account of the saved password / key passphrase, if any.
    pub secret_account: Option<String>,
}

#[derive(Clone)]
pub struct Deps {
    pub known_hosts: Arc<KnownHostsStore>,
    pub credentials: Arc<dyn CredentialStore>,
    pub prompts: Prompts,
    pub session: Uuid,
}

/// How the host key was settled (for logs and tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyOutcome {
    Matched,
    TrustedOnce,
    Saved,
    Replaced,
}

pub struct Handler {
    deps: Deps,
    host: String,
    port: u16,
    outcome: Arc<Mutex<Option<HostKeyOutcome>>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let algorithm = key.algorithm().to_string();
        let fingerprint = super::fingerprint_sha256(&key);
        let status = self
            .deps
            .known_hosts
            .check(&self.host, self.port, &algorithm, &fingerprint)
            .map_err(|_| russh::Error::UnknownKey)?;
        let (previous, changed) = match &status {
            HostKeyStatus::Matched => {
                tracing::info!(event = "ssh.host_key_checked", session_id = %self.deps.session, host_key_status = "matched");
                *self.outcome.lock().unwrap() = Some(HostKeyOutcome::Matched);
                return Ok(true);
            }
            HostKeyStatus::Unknown => (None, false),
            HostKeyStatus::Changed { previous } => (Some(previous.fingerprint.clone()), true),
        };
        // Nothing is trusted implicitly: ask, with the fingerprint in front of the user.
        let decision = self
            .deps
            .prompts
            .ask_host_key(
                self.deps.session,
                &self.host,
                self.port,
                &algorithm,
                &fingerprint,
                previous.as_deref(),
            )
            .await
            .unwrap_or(HostKeyDecision::Reject);
        let status_token = if changed { "changed" } else { "unknown" };
        let accept = match (decision, changed) {
            (HostKeyDecision::TrustOnce, false) => Some(HostKeyOutcome::TrustedOnce),
            (HostKeyDecision::TrustAndSave, false) => Some(HostKeyOutcome::Saved),
            (HostKeyDecision::Replace, true) => Some(HostKeyOutcome::Replaced),
            // Anything else — including "trust" answers to a CHANGED key — is a rejection.
            _ => None,
        };
        let Some(outcome) = accept else {
            tracing::warn!(event = "ssh.host_key_checked", session_id = %self.deps.session, host_key_status = "rejected", reason = status_token);
            return Ok(false);
        };
        if matches!(outcome, HostKeyOutcome::Saved | HostKeyOutcome::Replaced)
            && self
                .deps
                .known_hosts
                .trust(&self.host, self.port, &algorithm, &fingerprint, changed)
                .is_err()
        {
            return Ok(false);
        }
        tracing::info!(event = "ssh.host_key_checked", session_id = %self.deps.session, host_key_status = "trusted", reason = status_token);
        *self.outcome.lock().unwrap() = Some(outcome);
        Ok(true)
    }
}

pub type Handle = client::Handle<Handler>;

#[cfg_attr(not(test), allow(dead_code))]
pub struct Connected {
    pub handle: Handle,
    pub host_key: Option<HostKeyOutcome>,
    pub auth_kind: &'static str,
}

fn config(target: &Target) -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: target.keepalive,
        keepalive_max: 3,
        inactivity_timeout: None,
        ..Default::default()
    })
}

/// Connect, verify the host key, authenticate.
pub async fn connect(target: &Target, deps: &Deps) -> Result<Connected, SshError> {
    let outcome = Arc::new(Mutex::new(None));
    let handler = Handler {
        deps: deps.clone(),
        host: target.host.clone(),
        port: target.port,
        outcome: outcome.clone(),
    };
    let address = (target.host.as_str(), target.port);
    // The timeout covers TCP connect and key exchange, but NOT the time the user
    // spends on the host-key dialog (that has its own, longer timeout).
    let mut handle = tokio::time::timeout(
        target.connect_timeout + super::prompt::PROMPT_TIMEOUT,
        client::connect(config(target), address, handler),
    )
    .await
    .map_err(|_| SshError::Timeout)?
    .map_err(SshError::from)?;
    let auth_kind = authenticate(&mut handle, target, deps).await?;
    let host_key = *outcome.lock().unwrap();
    Ok(Connected {
        handle,
        host_key,
        auth_kind,
    })
}

const MAX_TRIES: usize = 3;

async fn authenticate(
    handle: &mut Handle,
    target: &Target,
    deps: &Deps,
) -> Result<&'static str, SshError> {
    let result = match target.auth {
        AuthMethod::Password => auth_password(handle, target, deps)
            .await
            .map(|()| "password"),
        AuthMethod::PublicKey => auth_public_key(handle, target, deps)
            .await
            .map(|()| "public_key"),
        AuthMethod::KeyboardInteractive => auth_keyboard(handle, target, deps)
            .await
            .map(|()| "keyboard_interactive"),
        AuthMethod::Agent => auth_agent(handle, target).await.map(|()| "agent"),
    };
    match &result {
        Ok(kind) => {
            tracing::info!(event = "ssh.auth_succeeded", session_id = %deps.session, auth_kind = *kind)
        }
        Err(e) => {
            tracing::warn!(event = "ssh.auth_failed", session_id = %deps.session, reason = e.token())
        }
    }
    result
}

fn saved_secret(deps: &Deps, target: &Target) -> Option<crate::security::secret::SecretString> {
    let account = target.secret_account.as_deref()?;
    deps.credentials.get(account).ok().flatten()
}

async fn ask_one(
    deps: &Deps,
    method: &'static str,
    text: &str,
    retry: bool,
) -> Result<crate::security::secret::SecretString, SshError> {
    let line = AuthPromptLine {
        text: text.to_owned(),
        echo: false,
    };
    let answer = deps
        .prompts
        .ask_secrets(deps.session, method, "", "", vec![line], retry)
        .await?;
    answer
        .and_then(|mut v| (!v.is_empty()).then(|| v.remove(0)))
        .ok_or(SshError::Cancelled)
}

async fn auth_password(handle: &mut Handle, target: &Target, deps: &Deps) -> Result<(), SshError> {
    if let Some(saved) = saved_secret(deps, target)
        && handle
            .authenticate_password(&target.username, saved.expose())
            .await?
            .success()
    {
        return Ok(());
    }
    let mut retry = false;
    for _ in 0..MAX_TRIES {
        let pw = ask_one(deps, "password", "Password", retry).await?;
        if handle
            .authenticate_password(&target.username, pw.expose())
            .await?
            .success()
        {
            return Ok(());
        }
        retry = true;
    }
    Err(SshError::AuthFailed)
}

async fn auth_public_key(
    handle: &mut Handle,
    target: &Target,
    deps: &Deps,
) -> Result<(), SshError> {
    let path = target.key_path.as_deref().ok_or(SshError::KeyUnreadable)?;
    let key = match load_secret_key(path, None) {
        Ok(key) => key,
        Err(russh::keys::Error::KeyIsEncrypted) => {
            let mut retry = false;
            let mut loaded = None;
            let saved = saved_secret(deps, target);
            for attempt in 0..MAX_TRIES {
                let pass = match (&saved, attempt) {
                    (Some(s), 0) => {
                        crate::security::secret::SecretString::new(s.expose().to_owned())
                    }
                    _ => ask_one(deps, "passphrase", "Key passphrase", retry).await?,
                };
                match load_secret_key(path, Some(pass.expose())) {
                    Ok(k) => {
                        loaded = Some(k);
                        break;
                    }
                    Err(_) => retry = true,
                }
            }
            loaded.ok_or(SshError::AuthFailed)?
        }
        Err(_) => return Err(SshError::KeyUnreadable),
    };
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
    match handle
        .authenticate_publickey(&target.username, with_hash)
        .await?
    {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(SshError::AuthFailed),
    }
}

async fn auth_keyboard(handle: &mut Handle, target: &Target, deps: &Deps) -> Result<(), SshError> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(&target.username, None)
        .await?;
    let mut rounds = 0;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Err(SshError::AuthFailed),
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                rounds += 1;
                if rounds > 8 {
                    return Err(SshError::Protocol);
                }
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else {
                    let lines = prompts
                        .iter()
                        .map(|p| AuthPromptLine {
                            text: p.prompt.clone(),
                            echo: p.echo,
                        })
                        .collect();
                    let secrets = deps
                        .prompts
                        .ask_secrets(
                            deps.session,
                            "keyboardInteractive",
                            &name,
                            &instructions,
                            lines,
                            rounds > 1,
                        )
                        .await?
                        .ok_or(SshError::Cancelled)?;
                    if secrets.len() != prompts.len() {
                        return Err(SshError::Protocol);
                    }
                    secrets.iter().map(|s| s.expose().to_owned()).collect()
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}

async fn try_agent_identities<S>(
    handle: &mut Handle,
    user: &str,
    mut agent: russh::keys::agent::client::AgentClient<S>,
) -> Result<(), SshError>
where
    S: russh::keys::agent::client::AgentStream + Unpin + Send + 'static,
{
    use russh::keys::agent::AgentIdentity;
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| SshError::AgentUnavailable)?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let result = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await;
        if matches!(result, Ok(AuthResult::Success)) {
            return Ok(());
        }
    }
    Err(SshError::AuthFailed)
}

/// Use the system SSH agent (`SSH_AUTH_SOCK` on Unix, the OpenSSH named pipe or
/// Pageant on Windows). Never prompts; fails cleanly when no agent exists.
async fn auth_agent(handle: &mut Handle, target: &Target) -> Result<(), SshError> {
    use russh::keys::agent::client::AgentClient;
    #[cfg(unix)]
    {
        let agent = AgentClient::connect_env()
            .await
            .map_err(|_| SshError::AgentUnavailable)?;
        try_agent_identities(handle, &target.username, agent).await
    }
    #[cfg(windows)]
    {
        if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
            && try_agent_identities(handle, &target.username, agent)
                .await
                .is_ok()
        {
            return Ok(());
        }
        let agent = AgentClient::connect_pageant()
            .await
            .map_err(|_| SshError::AgentUnavailable)?;
        try_agent_identities(handle, &target.username, agent).await
    }
}
