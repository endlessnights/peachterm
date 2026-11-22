// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::sessions::SessionId;
use crate::sftp::ops::{self, Listing};
use crate::sftp::transfer::{PickedFile, TransferEvent, run_download, run_upload};
use crate::sftp::{Client, SftpError, SftpState};
use crate::ssh::session::SshSession;
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

fn session_of(state: &AppState, id: &str) -> AppResult<Arc<SshSession>> {
    SessionId::parse(id)
        .and_then(|id| state.ssh.get(id))
        .ok_or_else(|| AppError::NotFound("session".into()))
}

fn client_of(state: &AppState, id: &str) -> AppResult<(Arc<SshSession>, Arc<Client>)> {
    let session = session_of(state, id)?;
    let client = session.sftp.client().ok_or(SftpError::Unavailable)?;
    Ok((session, client))
}

/// Log a failed operation with a fixed vocabulary only.
fn failed<T>(op: &'static str, session: &SshSession, result: Result<T, SftpError>) -> AppResult<T> {
    result.map_err(|error| {
        tracing::warn!(event = "sftp.op_failed", session_id = %session.id, kind = op, reason = error.token());
        error.into()
    })
}

#[tauri::command]
pub async fn sftp_status(state: AppStateRef<'_>, session_id: String) -> AppResult<SftpState> {
    state.lock.guard()?;
    Ok(session_of(&state, &session_id)?.sftp.state())
}

/// `path: null` lists the login directory.
#[tauri::command]
pub async fn sftp_list(
    state: AppStateRef<'_>,
    session_id: String,
    path: Option<String>,
) -> AppResult<Listing> {
    state.lock.guard()?;
    let (session, client) = client_of(&state, &session_id)?;
    let result = ops::list(&client, path.as_deref()).await;
    if let Err(error) = &result {
        tracing::warn!(event = "sftp.list_failed", session_id = %session.id, reason = error.token());
    }
    Ok(result?)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: AppStateRef<'_>,
    session_id: String,
    parent: String,
    name: String,
) -> AppResult<String> {
    state.lock.guard()?;
    let (session, client) = client_of(&state, &session_id)?;
    failed("mkdir", &session, ops::mkdir(&client, &parent, &name).await)
}

/// Creates an empty file in `parent` (SFTP only, never a shell command).
#[tauri::command]
pub async fn sftp_create_file(
    state: AppStateRef<'_>,
    session_id: String,
    parent: String,
    name: String,
) -> AppResult<String> {
    state.lock.guard()?;
    let (session, client) = client_of(&state, &session_id)?;
    failed(
        "create",
        &session,
        ops::create_file(&client, &parent, &name).await,
    )
}

#[tauri::command]
pub async fn sftp_rename(
    state: AppStateRef<'_>,
    session_id: String,
    path: String,
    new_name: String,
) -> AppResult<String> {
    state.lock.guard()?;
    let (session, client) = client_of(&state, &session_id)?;
    failed(
        "rename",
        &session,
        ops::rename(&client, &path, &new_name).await,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    removed: u64,
}

/// The renderer confirms with the user first; symlinks are removed, never followed.
#[tauri::command]
pub async fn sftp_delete(
    state: AppStateRef<'_>,
    session_id: String,
    path: String,
) -> AppResult<Deleted> {
    state.lock.guard()?;
    let (session, client) = client_of(&state, &session_id)?;
    let removed = failed("delete", &session, ops::delete(&client, &path).await)?;
    Ok(Deleted { removed })
}

/// Asks where to save in a native dialog opened by Rust, then downloads in the
/// background. Returns `false` when the user cancelled the dialog.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: AppStateRef<'_>,
    session_id: String,
    remote_path: String,
    on_event: Channel<TransferEvent>,
) -> AppResult<bool> {
    state.lock.guard()?;
    let (session, client) = client_of(&state, &session_id)?;
    ops::validate_path(&remote_path)?;
    let suggested = remote_path
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("download")
        .to_owned();
    let picked = super::blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("Save remote file as")
            .set_file_name(suggested)
            .blocking_save_file())
    })
    .await?;
    let Some(picked) = picked else {
        return Ok(false);
    };
    let dest = picked
        .into_path()
        .map_err(|_| AppError::Validation("Unsupported save location".into()))?;
    let app_state = Arc::clone(&state);
    let id = session.id.uuid();
    tauri::async_runtime::spawn(async move {
        let emit = move |event: TransferEvent| {
            let _ = on_event.send(event);
        };
        let _ = run_download(&client, &app_state.sftp, id, &remote_path, &dest, &emit).await;
    });
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pick_id: Uuid,
    files: Vec<PickedFile>,
}

/// Native "open files" dialog. The local paths stay in Rust; the renderer gets
/// an opaque single-use id plus names and sizes to show.
#[tauri::command]
pub async fn sftp_pick_upload(
    app: AppHandle,
    state: AppStateRef<'_>,
    session_id: String,
) -> AppResult<Option<Picked>> {
    state.lock.guard()?;
    client_of(&state, &session_id)?;
    let picked = super::blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("Choose files to upload")
            .blocking_pick_files())
    })
    .await?;
    let Some(files) = picked else {
        return Ok(None);
    };
    let paths: Vec<_> = files
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .collect();
    if paths.is_empty() {
        return Ok(None);
    }
    let (pick_id, files) = state.sftp.remember_pick(paths);
    Ok(Some(Picked { pick_id, files }))
}

#[tauri::command]
pub async fn sftp_upload(
    state: AppStateRef<'_>,
    session_id: String,
    pick_id: Uuid,
    remote_dir: String,
    overwrite: bool,
    on_event: Channel<TransferEvent>,
) -> AppResult<()> {
    state.lock.guard()?;
    let (session, client) = client_of(&state, &session_id)?;
    ops::validate_path(&remote_dir)?;
    let files = state
        .sftp
        .take_pick(pick_id)
        .ok_or_else(|| AppError::NotFound("selection".into()))?;
    let app_state = Arc::clone(&state);
    let id = session.id.uuid();
    tauri::async_runtime::spawn(async move {
        let emit = move |event: TransferEvent| {
            let _ = on_event.send(event);
        };
        run_upload(
            &client,
            &app_state.sftp,
            id,
            &files,
            &remote_dir,
            overwrite,
            &emit,
        )
        .await;
    });
    Ok(())
}

#[tauri::command]
pub async fn sftp_cancel(state: AppStateRef<'_>, transfer_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    state.sftp.cancel(transfer_id);
    Ok(())
}
