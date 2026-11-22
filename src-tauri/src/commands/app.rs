use crate::editor::{self, EditorPreset};
use crate::error::AppResult;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
pub async fn app_info() -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: "PeachTerm",
        version: env!("CARGO_PKG_VERSION"),
        os: crate::platform::os_name(),
        arch: std::env::consts::ARCH,
    })
}

#[tauri::command]
pub async fn editor_presets() -> AppResult<Vec<EditorPreset>> {
    super::blocking(|| Ok(editor::presets())).await
}
