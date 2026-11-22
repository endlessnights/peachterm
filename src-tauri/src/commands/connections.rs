use crate::AppState;
use crate::error::AppResult;
use crate::security::credentials::connection_account;
use crate::storage::connections::{
    Connection, ConnectionInput, ConnectionTree, Folder, FolderInput,
};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
pub async fn connections_load(state: AppStateRef<'_>) -> AppResult<ConnectionTree> {
    state.connections.load()
}

#[tauri::command]
pub async fn connections_save(
    state: AppStateRef<'_>,
    connection: ConnectionInput,
) -> AppResult<Connection> {
    let saved = state.connections.save_connection(connection)?;
    // Turning "save password" off must also remove what was stored.
    if !saved.save_password && saved.has_stored_secret {
        let app = Arc::clone(&state);
        let id = saved.id;
        super::blocking(move || app.credentials.delete(&connection_account(&id))).await?;
        state.connections.set_has_stored_secret(id, false)?;
        return state.connections.get(id);
    }
    Ok(saved)
}

#[tauri::command]
pub async fn connections_delete(state: AppStateRef<'_>, id: Uuid) -> AppResult<()> {
    state.connections.delete_connection(id)?;
    let app = Arc::clone(&state);
    super::blocking(move || app.credentials.delete(&connection_account(&id))).await
}

#[tauri::command]
pub async fn connections_duplicate(state: AppStateRef<'_>, id: Uuid) -> AppResult<Connection> {
    state.connections.duplicate_connection(id)
}

#[tauri::command]
pub async fn connections_move(
    state: AppStateRef<'_>,
    id: Uuid,
    folder_id: Option<Uuid>,
) -> AppResult<()> {
    state.connections.move_connection(id, folder_id)
}

#[tauri::command]
pub async fn folders_save(state: AppStateRef<'_>, folder: FolderInput) -> AppResult<Folder> {
    state.connections.save_folder(folder)
}

#[tauri::command]
pub async fn folders_delete(state: AppStateRef<'_>, id: Uuid) -> AppResult<()> {
    state.connections.delete_folder(id)
}
