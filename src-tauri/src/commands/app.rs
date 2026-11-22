use crate::AppState;
use crate::editor::{self, EditorPreset};
use crate::error::AppResult;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    /// Recoverable start-up problems (secret-free, no paths).
    issues: Vec<String>,
}

#[tauri::command]
pub async fn app_info(state: State<'_, Arc<AppState>>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: "PeachTerm",
        version: env!("CARGO_PKG_VERSION"),
        os: crate::platform::os_name(),
        arch: std::env::consts::ARCH,
        issues: state.startup_issues.clone(),
    })
}

#[tauri::command]
pub async fn editor_presets() -> AppResult<Vec<EditorPreset>> {
    super::blocking(|| Ok(editor::presets())).await
}
