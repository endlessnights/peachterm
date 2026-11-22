use crate::AppState;
use crate::error::AppResult;
use crate::storage::settings::Settings;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn settings_load(state: State<'_, Arc<AppState>>) -> AppResult<Settings> {
    state.settings.get()
}

#[tauri::command]
pub async fn settings_save(
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> AppResult<Settings> {
    state.settings.save(settings)
}
