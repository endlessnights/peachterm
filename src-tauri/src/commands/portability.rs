// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! IPC adapters for connection export/import and encrypted backups.
//!
//! SECURITY: no command accepts a file path. Paths come from native dialogs
//! opened *here*, so a compromised renderer cannot read or overwrite arbitrary
//! files. Secrets travel renderer → Rust only (the backup passphrase) and never
//! back. Every command enforces the Application Lock in Rust, and the service
//! re-checks it after each blocking step (dialogs can stay open for minutes).

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::portability::backup::BackupSummary;
use crate::portability::restore::{DuplicateChoice, RestoreOptions, RestoreResult};
use crate::portability::{
    BackupFileInfo, BackupOptions, Destination, ExportOutcome, ImportPreview, RestorePreview,
    Stores,
};
use crate::security::secret::SecretString;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

/// Run `f` with the stores of `app`.
fn with_stores<T>(
    app: &AppState,
    f: impl FnOnce(&crate::portability::PortabilityService, &Stores) -> AppResult<T>,
) -> AppResult<T> {
    let lock = app.lock.flag();
    let stores = Stores {
        connections: &app.connections,
        settings: &app.settings,
        credentials: app.credentials.as_ref(),
        lock: &lock,
    };
    f(&app.portability, &stores)
}

fn picked(path: Option<FilePath>) -> AppResult<Option<PathBuf>> {
    path.map(|p| {
        p.into_path()
            .map_err(|_| AppError::Validation("Unsupported file location".into()))
    })
    .transpose()
}

fn today() -> String {
    crate::logging::clock::format_date(crate::logging::clock::day_number(
        std::time::SystemTime::now(),
    ))
}

/// The failure itself is shown to the user; the log only learns that one happened.
fn log_failure(_error: &AppError) {
    tracing::warn!(event = "portability.failed", reason = "failed");
}

#[tauri::command]
pub async fn connections_export(
    app: AppHandle,
    state: AppStateRef<'_>,
    ids: Option<Vec<Uuid>>,
    include_key_paths: bool,
) -> AppResult<ExportOutcome> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        let dest = app
            .dialog()
            .file()
            .set_title("Export connections")
            .set_file_name(format!("peachterm-connections-{}.json", today()))
            .add_filter("PeachTerm connections", &["json"])
            .blocking_save_file();
        let Some(dest) = picked(dest)? else {
            return Ok(ExportOutcome {
                saved_to: None,
                connections: 0,
                folders: 0,
                key_paths: 0,
            });
        };
        let dest = crate::portability::fsio::with_extension(dest, "json");
        let outcome = with_stores(&shared, |service, stores| {
            service.write_connections_export(stores, &dest, ids.as_deref(), include_key_paths)
        })
        .inspect_err(log_failure)?;
        tracing::info!(
            event = "portability.connections_exported",
            count = outcome.connections as u64
        );
        Ok(outcome)
    })
    .await
}

/// Choose a file, validate it and stage it. `None` = the dialog was cancelled.
#[tauri::command]
pub async fn connections_import_pick(
    app: AppHandle,
    state: AppStateRef<'_>,
) -> AppResult<Option<ImportPreview>> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        let file = app
            .dialog()
            .file()
            .set_title("Import connections")
            .add_filter("PeachTerm connections", &["json"])
            .blocking_pick_file();
        let Some(path) = picked(file)? else {
            return Ok(None);
        };
        with_stores(&shared, |service, stores| {
            service.stage_import(stores, &path)
        })
        .inspect_err(log_failure)
        .map(Some)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub duplicates: DuplicateChoice,
    #[serde(default)]
    pub update: Vec<usize>,
}

#[tauri::command]
pub async fn connections_import_apply(
    state: AppStateRef<'_>,
    token: Uuid,
    options: ImportOptions,
) -> AppResult<RestoreResult> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    let result = super::blocking(move || {
        with_stores(&shared, |service, stores| {
            service.apply_import(stores, token, options.duplicates, &options.update)
        })
    })
    .await
    .inspect_err(log_failure)?;
    tracing::info!(
        event = "portability.connections_imported",
        count = (result.created + result.copied + result.updated) as u64
    );
    Ok(result)
}

#[tauri::command]
pub async fn backup_choose_destination(
    app: AppHandle,
    state: AppStateRef<'_>,
) -> AppResult<Option<Destination>> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        let dest = app
            .dialog()
            .file()
            .set_title("Save encrypted backup")
            .set_file_name(format!("peachterm-backup-{}.peachbackup", today()))
            .add_filter("PeachTerm encrypted backup", &["peachbackup"])
            .blocking_save_file();
        let Some(dest) = picked(dest)? else {
            return Ok(None);
        };
        with_stores(&shared, |service, stores| {
            service.choose_backup_destination(stores, &dest)
        })
        .map(Some)
    })
    .await
}

#[tauri::command]
pub async fn backup_create(
    state: AppStateRef<'_>,
    token: Uuid,
    options: BackupOptions,
    passphrase: SecretString,
    confirm: SecretString,
) -> AppResult<BackupSummary> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    let summary = super::blocking(move || {
        with_stores(&shared, |service, stores| {
            service.create_backup(stores, token, options, &passphrase, &confirm)
        })
    })
    .await
    .inspect_err(log_failure)?;
    tracing::info!(
        event = "portability.backup_created",
        count = summary.connections as u64,
        files = summary.credentials_included as u64
    );
    Ok(summary)
}

#[tauri::command]
pub async fn restore_pick(
    app: AppHandle,
    state: AppStateRef<'_>,
) -> AppResult<Option<BackupFileInfo>> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        let file = app
            .dialog()
            .file()
            .set_title("Restore encrypted backup")
            .add_filter("PeachTerm encrypted backup", &["peachbackup"])
            .blocking_pick_file();
        let Some(path) = picked(file)? else {
            return Ok(None);
        };
        with_stores(&shared, |service, stores| {
            service.stage_backup_file(stores, &path)
        })
        .inspect_err(log_failure)
        .map(Some)
    })
    .await
}

/// Decrypts in Rust and answers with a redacted preview only.
#[tauri::command]
pub async fn restore_unlock(
    state: AppStateRef<'_>,
    token: Uuid,
    passphrase: SecretString,
) -> AppResult<RestorePreview> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        with_stores(&shared, |service, stores| {
            service.unlock_backup(stores, token, &passphrase)
        })
    })
    .await
}

#[tauri::command]
pub async fn restore_apply(
    state: AppStateRef<'_>,
    token: Uuid,
    options: RestoreOptions,
) -> AppResult<RestoreResult> {
    state.lock.guard()?;
    let shared = Arc::clone(&state);
    let diagnostics_before = state.settings.get()?.diagnostics;
    let result = super::blocking(move || {
        with_stores(&shared, |service, stores| {
            service.restore_backup(stores, token, &options)
        })
    })
    .await
    .inspect_err(log_failure)?;
    if result.settings_restored {
        let diagnostics = state.settings.get()?.diagnostics;
        if diagnostics != diagnostics_before {
            let app = Arc::clone(&state);
            super::blocking(move || {
                app.logging.apply(&diagnostics);
                Ok(())
            })
            .await?;
        }
    }
    tracing::info!(
        event = "portability.backup_restored",
        count = (result.created + result.copied + result.updated) as u64,
        files = result.credentials.restored as u64
    );
    Ok(result)
}

#[tauri::command]
pub async fn portability_cancel(state: AppStateRef<'_>, token: Uuid) -> AppResult<()> {
    state.lock.guard()?; // (locking already discards everything that was staged)
    state.portability.cancel(token);
    Ok(())
}
