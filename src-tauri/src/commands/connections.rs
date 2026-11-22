use crate::AppState;
use crate::error::AppResult;
use crate::security::credentials::connection_account;
use crate::storage::connections::{
    Connection, ConnectionInput, ConnectionTree, Folder, FolderInput,
};
use crate::storage::tree_ops::{DeletePlan, FolderDeleteMode, ItemRef};
use serde::Serialize;
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
    let created = connection.id.is_none();
    let saved = state.connections.save_connection(connection)?;
    tracing::info!(
        event = if created { "connection.created" } else { "connection.updated" },
        connection_id = %saved.id
    );
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
    tracing::info!(event = "connection.deleted", connection_id = %id);
    let app = Arc::clone(&state);
    super::blocking(move || app.credentials.delete(&connection_account(&id))).await
}

#[tauri::command]
pub async fn connections_duplicate(state: AppStateRef<'_>, id: Uuid) -> AppResult<Connection> {
    let copy = state.connections.duplicate_connection(id)?;
    tracing::info!(event = "connection.duplicated", connection_id = %copy.id);
    Ok(copy)
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
    let saved = state.connections.save_folder(folder)?;
    tracing::debug!(event = "folder.saved");
    Ok(saved)
}

#[tauri::command]
pub async fn folders_delete(state: AppStateRef<'_>, id: Uuid) -> AppResult<()> {
    state.connections.delete_folder(id)?;
    tracing::info!(event = "folder.deleted");
    Ok(())
}

#[tauri::command]
pub async fn connections_rename(
    state: AppStateRef<'_>,
    id: Uuid,
    name: String,
) -> AppResult<Connection> {
    let renamed = state.connections.rename_connection(id, &name)?;
    tracing::info!(event = "connection.updated", connection_id = %id);
    Ok(renamed)
}

#[tauri::command]
pub async fn folders_rename(state: AppStateRef<'_>, id: Uuid, name: String) -> AppResult<Folder> {
    let renamed = state.connections.rename_folder(id, &name)?;
    tracing::debug!(event = "folder.saved");
    Ok(renamed)
}

/// Move and/or reorder any mix of connections and folders. Validation (cycles,
/// the three-level folder limit) happens here, not in the renderer.
#[tauri::command]
pub async fn tree_move(
    state: AppStateRef<'_>,
    items: Vec<ItemRef>,
    target_folder_id: Option<Uuid>,
    before: Option<ItemRef>,
) -> AppResult<ConnectionTree> {
    let tree = state
        .connections
        .move_items(&items, target_folder_id, before)?;
    tracing::info!(event = "connection.updated", count = items.len() as u64);
    Ok(tree)
}

#[tauri::command]
pub async fn tree_delete_preview(
    state: AppStateRef<'_>,
    items: Vec<ItemRef>,
    mode: FolderDeleteMode,
) -> AppResult<DeletePlan> {
    state.connections.plan_delete(&items, mode)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub plan: DeletePlan,
    /// Keychain entries that could not be removed (the definitions are gone).
    pub credential_failures: usize,
    pub tree: ConnectionTree,
}

/// Bulk delete. Only the credentials of the connections that were actually
/// deleted are removed, one account each; nothing else is touched.
#[tauri::command]
pub async fn tree_delete(
    state: AppStateRef<'_>,
    items: Vec<ItemRef>,
    mode: FolderDeleteMode,
) -> AppResult<DeleteOutcome> {
    let plan = state.connections.delete_items(&items, mode)?;
    let app = Arc::clone(&state);
    let ids = plan.connection_ids.clone();
    let credential_failures = super::blocking(move || {
        Ok(ids
            .iter()
            .filter(|id| app.credentials.delete(&connection_account(id)).is_err())
            .count())
    })
    .await?;
    tracing::info!(
        event = "connection.deleted",
        count = plan.connection_ids.len() as u64
    );
    if !plan.folder_ids.is_empty() {
        tracing::info!(
            event = "folder.deleted",
            count = plan.folder_ids.len() as u64
        );
    }
    Ok(DeleteOutcome {
        plan,
        credential_failures,
        tree: state.connections.load()?,
    })
}
