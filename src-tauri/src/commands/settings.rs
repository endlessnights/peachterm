use crate::AppState;
use crate::error::AppResult;
use crate::storage::settings::Settings;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn settings_load(state: State<'_, Arc<AppState>>) -> AppResult<Settings> {
    state.settings.get()
}

/// Saving is validated and normalised by Rust. Logging preferences take effect
/// immediately; a bad log directory never fails the save (the status reports it).
#[tauri::command]
pub async fn settings_save(
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> AppResult<Settings> {
    let previous = state.settings.get()?;
    let saved = state.settings.save(settings)?;

    if previous != saved {
        // Sidebar drags save the layout often; keep those out of the Info log.
        let layout_only = Settings {
            ui: previous.ui.clone(),
            ..saved.clone()
        } == previous;
        if layout_only {
            tracing::debug!(event = "config.saved", file = "settings.json");
        } else {
            tracing::info!(event = "config.saved", file = "settings.json");
        }
    }
    if previous.diagnostics != saved.diagnostics {
        let app = Arc::clone(&state);
        let diagnostics = saved.diagnostics.clone();
        super::blocking(move || {
            app.logging.apply(&diagnostics);
            Ok(())
        })
        .await?;
    }
    Ok(saved)
}
