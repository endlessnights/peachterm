use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::security::credentials::{CredentialStatus, connection_account};
use crate::security::known_hosts::KnownHost;
use crate::security::secret::SecretString;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
pub async fn credentials_status(state: AppStateRef<'_>) -> AppResult<CredentialStatus> {
    let app = Arc::clone(&state);
    super::blocking(move || Ok(app.credentials.status())).await
}

/// Write-only: the secret enters Rust here and is never sent back.
#[tauri::command]
pub async fn credentials_set_password(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    secret: SecretString,
) -> AppResult<()> {
    let connection = state.connections.get(connection_id)?;
    if !connection.save_password {
        return Err(AppError::Validation(
            "Password saving is disabled for this connection".into(),
        ));
    }
    if secret.is_empty() {
        return Err(AppError::Validation("Password is empty".into()));
    }
    let app = Arc::clone(&state);
    super::blocking(move || {
        app.credentials
            .set(&connection_account(&connection_id), &secret)
    })
    .await?;
    state.connections.set_has_stored_secret(connection_id, true)
}

#[tauri::command]
pub async fn credentials_clear(state: AppStateRef<'_>, connection_id: Uuid) -> AppResult<()> {
    state.connections.get(connection_id)?;
    let app = Arc::clone(&state);
    super::blocking(move || app.credentials.delete(&connection_account(&connection_id))).await?;
    state
        .connections
        .set_has_stored_secret(connection_id, false)
}

#[derive(Serialize)]
pub struct ClearedCount {
    cleared: usize,
}

#[tauri::command]
pub async fn credentials_clear_all(state: AppStateRef<'_>) -> AppResult<ClearedCount> {
    let tree = state.connections.load()?;
    let ids: Vec<Uuid> = tree
        .connections
        .iter()
        .filter(|c| c.has_stored_secret)
        .map(|c| c.id)
        .collect();
    let app = Arc::clone(&state);
    let cleared = super::blocking(move || {
        // Attempt every entry, also those without the flag, in case the flag
        // and the keychain drifted apart.
        for connection in &tree.connections {
            app.credentials
                .delete(&connection_account(&connection.id))?;
        }
        Ok(ids.len())
    })
    .await?;
    state.connections.clear_all_secret_flags()?;
    Ok(ClearedCount { cleared })
}

#[tauri::command]
pub async fn known_hosts_list(state: AppStateRef<'_>) -> AppResult<Vec<KnownHost>> {
    state.known_hosts.list()
}

#[tauri::command]
pub async fn known_hosts_remove(state: AppStateRef<'_>, host: String, port: u16) -> AppResult<()> {
    state.known_hosts.remove(&host, port).map(|_| ())
}
