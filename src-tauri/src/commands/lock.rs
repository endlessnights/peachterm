// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use crate::AppState;
use crate::error::AppResult;
use crate::lock::{LockStatus, UnlockOutcome};
use crate::security::secret::SecretString;
use crate::storage::settings::{Accent, ThemeMode};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockView {
    #[serde(flatten)]
    status: LockStatus,
    inactivity_minutes: u32,
    /// Only what the lock screen needs to look right; nothing sensitive.
    theme: ThemeMode,
    accent: Accent,
}

/// Always available, also while locked: the lock screen needs it.
#[tauri::command]
pub async fn lock_status(state: AppStateRef<'_>) -> AppResult<LockView> {
    let settings = state.settings.get()?;
    Ok(LockView {
        status: state.lock.status(),
        inactivity_minutes: settings.security.app_lock.inactivity_minutes,
        theme: settings.appearance.theme,
        accent: settings.appearance.accent,
    })
}

/// Always available while locked. Verification runs off the async workers and
/// is rate-limited by the backend; the password is never logged or echoed.
#[tauri::command]
pub async fn lock_unlock(
    state: AppStateRef<'_>,
    password: SecretString,
) -> AppResult<UnlockOutcome> {
    let app = Arc::clone(&state);
    super::blocking(move || app.lock.unlock(&password)).await
}

#[tauri::command]
pub async fn lock_now(state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.lock()?;
    state.sessions.reset_write_policies()
}

#[tauri::command]
pub async fn lock_set_password(
    state: AppStateRef<'_>,
    new_password: SecretString,
    current_password: Option<SecretString>,
) -> AppResult<LockStatus> {
    state.lock.guard()?;
    let app = Arc::clone(&state);
    super::blocking(move || {
        app.lock
            .set_password(&new_password, current_password.as_ref())
    })
    .await?;
    Ok(state.lock.status())
}

#[tauri::command]
pub async fn lock_remove_password(
    state: AppStateRef<'_>,
    current_password: SecretString,
) -> AppResult<LockStatus> {
    state.lock.guard()?;
    let app = Arc::clone(&state);
    super::blocking(move || app.lock.remove_password(&current_password)).await?;
    // Without a password the lock cannot stay enabled.
    let mut settings = state.settings.get()?;
    settings.security.app_lock.enabled = false;
    state.settings.save(settings)?;
    Ok(state.lock.status())
}

/// User activity (throttled by the renderer): defers the inactivity lock.
#[tauri::command]
pub async fn lock_touch(state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.touch();
    Ok(())
}
