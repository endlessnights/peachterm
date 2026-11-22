use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::logging::export::{self, ExportEntry, ExportMeta, ExportPreview};
use crate::logging::{LoggingStatus, level_token};
use serde::Serialize;
use std::sync::Arc;
use std::time::SystemTime;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
pub async fn logging_status(state: AppStateRef<'_>) -> AppResult<LoggingStatus> {
    state.lock.guard()?;
    let app = Arc::clone(&state);
    super::blocking(move || Ok(app.logging.status())).await
}

/// Opens the *effective* log directory (never a renderer-supplied path).
#[tauri::command]
pub async fn logging_open_dir(state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.guard()?;
    let app = Arc::clone(&state);
    super::blocking(move || {
        let dir = app.logging.effective_dir();
        std::fs::create_dir_all(&dir)?;
        crate::platform::open_folder(&dir)?;
        Ok(())
    })
    .await
}

/// Which files an export would contain, so the user can review it first.
#[tauri::command]
pub async fn logging_export_preview(state: AppStateRef<'_>) -> AppResult<ExportPreview> {
    state.lock.guard()?;
    let app = Arc::clone(&state);
    super::blocking(move || {
        app.logging.flush();
        Ok(export::preview(&app.logging.effective_dir()))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    /// `None` when the user cancelled the save dialog.
    pub saved_to: Option<String>,
    pub entries: Vec<ExportEntry>,
    pub archive_bytes: u64,
}

/// The destination is chosen in a native save dialog opened from Rust, so the
/// renderer cannot make the backend write to an arbitrary path.
#[tauri::command]
pub async fn logging_export(app: AppHandle, state: AppStateRef<'_>) -> AppResult<ExportOutcome> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        shared.logging.flush();
        let stamp = crate::logging::clock::format_date(crate::logging::clock::day_number(
            SystemTime::now(),
        ));
        let picked = app
            .dialog()
            .file()
            .set_title("Export diagnostic logs")
            .set_file_name(format!("peachterm-diagnostics-{stamp}.zip"))
            .add_filter("Zip archive", &["zip"])
            .blocking_save_file();
        let Some(picked) = picked else {
            return Ok(ExportOutcome {
                saved_to: None,
                entries: Vec::new(),
                archive_bytes: 0,
            });
        };
        let mut dest = picked
            .into_path()
            .map_err(|_| AppError::Validation("Unsupported save location".into()))?;
        if dest
            .extension()
            .is_none_or(|e| !e.eq_ignore_ascii_case("zip"))
        {
            dest.set_extension("zip");
        }
        let resolved = shared.logging.resolved();
        let meta = ExportMeta {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            os: crate::platform::os_name().to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            log_level: resolved
                .as_ref()
                .map(|r| level_token(r.level).to_owned())
                .unwrap_or_default(),
            retention_days: resolved.as_ref().map(|r| r.retention_days).unwrap_or(0),
        };
        let result = export::build_archive(
            &shared.logging.effective_dir(),
            &dest,
            &meta,
            SystemTime::now(),
        )
        .map_err(|e| {
            let kind = crate::logging::writer::io_error_kind(&e);
            tracing::warn!(event = "logging.export_failed", reason = kind);
            AppError::Storage(format!("Could not write the archive ({kind})"))
        })?;
        tracing::info!(
            event = "logging.exported",
            files = result.entries.len() as u64,
            bytes = result.archive_bytes
        );
        let saved_to = dest.to_string_lossy().into_owned();
        if let Ok(mut last) = shared.last_export.lock() {
            *last = Some(dest);
        }
        Ok(ExportOutcome {
            saved_to: Some(saved_to),
            entries: result.entries,
            archive_bytes: result.archive_bytes,
        })
    })
    .await
}

/// Show the most recent archive's folder (only the path remembered by Rust).
#[tauri::command]
pub async fn logging_reveal_export(state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.guard()?;
    let last = state.last_export.lock().ok().and_then(|l| l.clone());
    let Some(folder) = last.and_then(|p| p.parent().map(|d| d.to_path_buf())) else {
        return Err(AppError::NotFound("exported archive".into()));
    };
    super::blocking(move || Ok(crate::platform::open_folder(&folder)?)).await
}
