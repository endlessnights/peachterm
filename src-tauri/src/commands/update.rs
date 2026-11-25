// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! In-app updates (official Tauri updater plugin). Checking, downloading and
//! installing are three explicit steps; every command refuses while locked.

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::update::{self, Platform, Verdict};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

/// Reasonable limit for the one small `latest.json` request.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    /// Release notes as published; shown as plain text.
    notes: Option<String>,
    /// RFC 3339 publication date, if the manifest has one.
    date: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: &'static str,
    /// An update public key is built in (official builds); otherwise checks are unavailable.
    configured: bool,
    platform: Platform,
    /// This installation can be updated in place (not a `.deb`).
    can_install: bool,
    last_check_at: Option<u64>,
    pending: Option<UpdateInfo>,
    downloaded: bool,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CheckOutcome {
    UpToDate,
    Available {
        info: UpdateInfo,
    },
    /// Another check is already running.
    Busy,
    /// Not configured, or the check failed; `reason` is a fixed token.
    Unavailable {
        reason: &'static str,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DownloadEvent {
    /// `total` is unknown when the server does not announce a length.
    Started {
        total: Option<u64>,
    },
    Progress {
        downloaded: u64,
    },
    Finished,
}

fn info_of(update: &tauri_plugin_updater::Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone().map(|b| b.chars().take(4000).collect()),
        date: update.date.map(|d| d.to_string()),
    }
}

#[tauri::command]
pub async fn update_status(state: AppStateRef<'_>) -> AppResult<UpdateStatus> {
    state.lock.guard()?;
    let platform = Platform::detect();
    Ok(UpdateStatus {
        current_version: env!("CARGO_PKG_VERSION"),
        configured: state.update.configured(),
        platform,
        can_install: platform.can_install(),
        last_check_at: state.update.last_check_at(),
        pending: state.update.pending().as_ref().map(info_of),
        downloaded: state.update.has_downloaded(),
    })
}

/// Ask GitHub Releases whether a newer stable version exists. The only request
/// is a GET of `latest.json`; no identifiers are sent.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: AppStateRef<'_>) -> AppResult<CheckOutcome> {
    state.lock.guard()?;
    if !state.update.configured() {
        return Ok(CheckOutcome::Unavailable {
            reason: "not_configured",
        });
    }
    let Some(_guard) = state.update.begin_check() else {
        return Ok(CheckOutcome::Busy);
    };
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        // stable channel; never a downgrade (see update::judge)
        .version_comparator(|current, remote| {
            update::judge(&current.to_string(), &remote.version.to_string(), false)
                == Verdict::Newer
        })
        .build();
    let updater = match updater {
        Ok(u) => u,
        Err(e) => {
            return Ok(CheckOutcome::Unavailable {
                reason: update::classify(&e),
            });
        }
    };
    match updater.check().await {
        Ok(found) => {
            state.update.record_check(update::now_secs());
            tracing::info!(event = "update.checked", available = found.is_some());
            let info = found.as_ref().map(info_of);
            state.update.set_pending(found);
            Ok(match info {
                Some(info) => CheckOutcome::Available { info },
                None => CheckOutcome::UpToDate,
            })
        }
        Err(e) => {
            let reason = update::classify(&e);
            tracing::info!(event = "update.check_failed", reason);
            Ok(CheckOutcome::Unavailable { reason })
        }
    }
}

/// Download and verify the package; nothing is installed. Progress is real:
/// `total` is only reported when the server announced a length.
#[tauri::command]
pub async fn update_download(
    state: AppStateRef<'_>,
    on_event: Channel<DownloadEvent>,
) -> AppResult<()> {
    state.lock.guard()?;
    if !Platform::detect().can_install() {
        return Err(AppError::validation_key(
            "update.noInPlace",
            "This installation cannot be updated in place. Download the new version from GitHub.",
        ));
    }
    let update = state
        .update
        .pending()
        .ok_or_else(|| AppError::NotFound("update".into()))?;
    let mut downloaded: u64 = 0;
    let mut started = false;
    let events = on_event.clone();
    let bytes = update
        .download(
            |chunk, total| {
                if !started {
                    started = true;
                    let _ = events.send(DownloadEvent::Started { total });
                }
                downloaded += chunk as u64;
                let _ = events.send(DownloadEvent::Progress { downloaded });
            },
            || {},
        )
        .await
        .map_err(|e| {
            let reason = update::classify(&e);
            tracing::info!(event = "update.download_failed", reason);
            AppError::Remote(
                match reason {
                    "signature" => "signature",
                    "network" | "timeout" => "network",
                    "no_package" => "no_package",
                    _ => "failed",
                },
                "The update could not be downloaded.",
            )
        })?;
    // The plugin has verified the minisign signature of these bytes.
    state.update.set_downloaded(bytes);
    let _ = on_event.send(DownloadEvent::Finished);
    tracing::info!(event = "update.downloaded");
    Ok(())
}

/// Install the downloaded update and restart. The renderer confirms first when
/// sessions, tunnels, transfers or unsaved work would be lost; this command does
/// not restore live connections.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.guard()?;
    if !Platform::detect().can_install() {
        return Err(AppError::validation_key(
            "update.noInPlace",
            "This installation cannot be updated in place. Download the new version from GitHub.",
        ));
    }
    let update = state
        .update
        .pending()
        .ok_or_else(|| AppError::NotFound("update".into()))?;
    let bytes = state.update.take_downloaded().ok_or_else(|| {
        AppError::validation_key("update.downloadFirst", "Download the update first.")
    })?;
    // Ends sessions and tunnels through their normal teardown before the
    // installer replaces the program (nothing is typed into any shell).
    let shared = Arc::clone(&state);
    super::blocking(move || {
        shared.local.close_all();
        Ok(())
    })
    .await?;
    state.tunnel_engine.stop_all().await;
    for session in state.ssh.all() {
        session.close().await;
    }
    tracing::info!(event = "update.installing");
    let result = tauri::async_runtime::spawn_blocking(move || update.install(&bytes))
        .await
        .map_err(|e| AppError::Storage(format!("background task failed: {e}")))?;
    match result {
        Ok(()) => {
            // Windows: the installer takes over and the process exits by itself.
            app.restart();
        }
        Err(e) => {
            let reason = update::classify(&e);
            tracing::warn!(event = "update.install_failed", reason);
            Err(AppError::Remote(
                "install_failed",
                "The update could not be installed. Your current version is unchanged.",
            ))
        }
    }
}

#[tauri::command]
pub async fn update_open_notes(state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.guard()?;
    let url = match state.update.pending() {
        Some(u) => update::notes_url(&u.version),
        None => update::notes_url(""),
    };
    super::blocking(move || {
        crate::platform::open_url(&url)?;
        Ok(())
    })
    .await
}
