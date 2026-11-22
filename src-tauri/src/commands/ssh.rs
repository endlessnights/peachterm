use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::security::credentials::connection_account;
use crate::security::secret::SecretString;
use crate::sessions::SessionId;
use crate::ssh::TerminalEvent;
use crate::ssh::client::{Deps, Target};
use crate::ssh::prompt::{Answer, HostKeyDecision};
use crate::ssh::session::{self, SshSession, StartParams, decode};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tauri::ipc::Channel;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    session_id: Uuid,
}

fn session_of(state: &AppState, id: &str) -> AppResult<Arc<SshSession>> {
    SessionId::parse(id)
        .and_then(|id| state.ssh.get(id))
        .ok_or_else(|| AppError::NotFound("session".into()))
}

/// Start a new SSH session for a saved connection. Every call creates a new
/// backend session (new id, `RemoteWritePolicy::AlwaysAsk`), also when it is a
/// reconnect of an existing tab.
#[tauri::command]
pub async fn ssh_open(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
    attempt: Option<u32>,
) -> AppResult<OpenedSession> {
    state.lock.guard()?;
    let connection = state.connections.get(connection_id)?;
    let settings = state.settings.get()?;
    let id = state.sessions.open(connection_id)?;
    if let Some(n) = attempt.filter(|n| *n > 0) {
        tracing::info!(event = "ssh.reconnect_attempt", session_id = %id, attempt = u64::from(n));
    }
    let keepalive = settings.ssh.keepalive_secs;
    let target = Target {
        host: connection.host.clone(),
        port: connection.port,
        username: if connection.username.is_empty() {
            settings.ssh.default_username
        } else {
            connection.username.clone()
        },
        auth: connection.auth,
        key_path: connection.key_path.clone(),
        connect_timeout: Duration::from_secs(u64::from(connection.timeout_secs.max(1))),
        keepalive: (keepalive > 0).then(|| Duration::from_secs(u64::from(keepalive))),
        secret_account: (connection.save_password && connection.has_stored_secret)
            .then(|| connection_account(&connection_id)),
    };
    let deps = Deps {
        known_hosts: state.known_hosts.clone(),
        credentials: state.credentials.clone(),
        prompts: state.prompts.clone(),
        session: id.uuid(),
    };
    let app = Arc::clone(&state);
    let on_end: Arc<dyn Fn(SessionId) + Send + Sync> = Arc::new(move |ended| {
        app.ssh.remove(ended);
        app.editor.end_session(ended);
        let _ = app.sessions.close(ended);
    });
    let session = session::start(StartParams {
        id,
        connection_id,
        target,
        deps,
        cols,
        rows,
        initial_directory: connection.initial_directory,
        sink: Arc::new(on_event),
        lock: state.lock.flag(),
        on_authenticated: Arc::new({
            let app = Arc::clone(&state);
            move |_| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = app.workspace.record_recent(connection_id, now);
            }
        }),
        on_end,
    });
    state.ssh.insert(session);
    Ok(OpenedSession {
        session_id: id.uuid(),
    })
}

/// Keyboard input / paste, base64-encoded.
#[tauri::command]
pub async fn ssh_write(state: AppStateRef<'_>, session_id: String, data: String) -> AppResult<()> {
    state.lock.guard()?;
    let bytes =
        decode(&data).ok_or_else(|| AppError::Validation("Invalid input encoding".into()))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::Validation("Input is too large".into()));
    }
    let session = session_of(&state, &session_id)?;
    session.write(bytes).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: AppStateRef<'_>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.lock.guard()?;
    session_of(&state, &session_id)?.resize(cols, rows).await;
    Ok(())
}

/// The renderer has written `bytes` of output to the terminal (flow control).
#[tauri::command]
pub async fn ssh_ack(state: AppStateRef<'_>, session_id: String, bytes: usize) -> AppResult<()> {
    state.lock.guard()?;
    session_of(&state, &session_id)?.credits.ack(bytes);
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(state: AppStateRef<'_>, session_id: String) -> AppResult<()> {
    state.lock.guard()?;
    if let Ok(session) = session_of(&state, &session_id) {
        session.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_answer_host_key(
    state: AppStateRef<'_>,
    prompt_id: Uuid,
    decision: HostKeyDecision,
) -> AppResult<()> {
    state.lock.guard()?;
    if state.prompts.answer(prompt_id, Answer::HostKey(decision)) {
        Ok(())
    } else {
        Err(AppError::NotFound("question".into()))
    }
}

/// `answers: null` = the user cancelled the prompt.
#[tauri::command]
pub async fn ssh_answer_auth(
    state: AppStateRef<'_>,
    prompt_id: Uuid,
    answers: Option<Vec<SecretString>>,
) -> AppResult<()> {
    state.lock.guard()?;
    if state.prompts.answer(prompt_id, Answer::Secrets(answers)) {
        Ok(())
    } else {
        Err(AppError::NotFound("question".into()))
    }
}
