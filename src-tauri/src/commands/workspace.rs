// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use crate::AppState;
use crate::error::AppResult;
use crate::storage::settings::StartupBehavior;
use crate::storage::workspace::{Layout, layout_to_keep, retain_existing};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

fn existing_connections(state: &AppState) -> AppResult<HashSet<Uuid>> {
    Ok(state
        .connections
        .load()?
        .connections
        .iter()
        .map(|c| c.id)
        .collect())
}

/// The saved layout for restoring tabs (metadata only). Empty unless the user
/// chose to restore tabs; tabs of deleted saved connections are left out.
#[tauri::command]
pub async fn workspace_load(state: AppStateRef<'_>) -> AppResult<Layout> {
    state.lock.guard()?;
    if state.settings.get()?.general.startup != StartupBehavior::RestoreTabs {
        return Ok(Layout::default());
    }
    let layout = state.workspace.layout()?;
    Ok(retain_existing(layout, &existing_connections(&state)?))
}

/// Remember the layout of the open tabs. When tab restoration is off nothing
/// about the tabs is kept (an empty layout replaces whatever was stored).
#[tauri::command]
pub async fn workspace_save(state: AppStateRef<'_>, layout: Layout) -> AppResult<()> {
    state.lock.guard()?;
    let restore = state.settings.get()?.general.startup == StartupBehavior::RestoreTabs;
    state.workspace.save_layout(layout_to_keep(restore, layout))
}

/// Recent saved connections, newest first, limited by the setting.
#[tauri::command]
pub async fn recent_list(state: AppStateRef<'_>) -> AppResult<Vec<Uuid>> {
    state.lock.guard()?;
    let limit = state.settings.get()?.general.recent_sessions_limit as usize;
    state
        .workspace
        .recent(limit, &existing_connections(&state)?)
}

/// Forget the history only: saved connections, credentials and open sessions stay.
#[tauri::command]
pub async fn recent_clear(state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.guard()?;
    state.workspace.clear_recent()
}
