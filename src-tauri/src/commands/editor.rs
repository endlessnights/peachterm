use crate::AppState;
use crate::editor::policy::UserAnswer;
use crate::editor::service::{ConflictChoice, OpenParams, OpenedEdit};
use crate::editor::{launcher, temp_root};
use crate::error::{AppError, AppResult};
use crate::sessions::SessionId;
use crate::sftp::ops;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

/// Download a remote file to a private copy, start the external editor on it
/// and watch for changes. Nothing is ever uploaded without the policy's
/// authorisation (see `editor::service`).
#[tauri::command]
pub async fn editor_open_remote(
    state: AppStateRef<'_>,
    session_id: String,
    remote_path: String,
) -> AppResult<OpenedEdit> {
    state.lock.guard()?;
    ops::validate_path(&remote_path)?;
    let session = SessionId::parse(&session_id)
        .and_then(|id| state.ssh.get(id))
        .ok_or_else(|| AppError::NotFound("session".into()))?;
    let client = session
        .sftp
        .client()
        .ok_or(crate::sftp::SftpError::Unavailable)?;
    let settings = state.settings.get()?;
    let opened = state
        .editor
        .open_remote(OpenParams {
            session: session.id,
            client,
            remote_path,
            temp_root: temp_root(&settings.editor),
            launch: launcher(&settings.editor),
        })
        .await?;
    Ok(opened)
}

/// Answer a "Remote file modified" prompt. Ignored unless that prompt is open.
#[tauri::command]
pub async fn editor_answer(
    state: AppStateRef<'_>,
    edit_id: Uuid,
    answer: UserAnswer,
) -> AppResult<bool> {
    state.lock.guard()?;
    Ok(state.editor.answer(edit_id, answer))
}

#[tauri::command]
pub async fn editor_resolve_conflict(
    state: AppStateRef<'_>,
    edit_id: Uuid,
    choice: ConflictChoice,
) -> AppResult<bool> {
    state.lock.guard()?;
    Ok(state.editor.resolve_conflict(edit_id, choice))
}

#[tauri::command]
pub async fn editor_retry(state: AppStateRef<'_>, edit_id: Uuid) -> AppResult<bool> {
    state.lock.guard()?;
    Ok(state.editor.retry(edit_id))
}

#[tauri::command]
pub async fn editor_stop(state: AppStateRef<'_>, edit_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    state.editor.stop(edit_id);
    Ok(())
}
