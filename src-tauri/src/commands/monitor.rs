// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Live server resource monitor. Whether monitoring is on is decided here, in
//! Rust, from the saved settings and the connection's own preference; the
//! renderer only asks "start for this session" and receives sanitized numbers.

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::monitor::parse::Wanted;
use crate::monitor::{MonitorConfig, MonitorEvent, normalize_interval};
use crate::sessions::SessionId;
use crate::storage::connections::MonitorMode;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tauri::ipc::Channel;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

/// Start (or restart) the poller of one session. Returns whether monitoring is
/// active for it (`false`: disabled by the settings or the connection override).
#[tauri::command]
pub async fn monitor_start(
    state: AppStateRef<'_>,
    session_id: String,
    on_event: Channel<MonitorEvent>,
) -> AppResult<bool> {
    state.lock.guard()?;
    let session = SessionId::parse(&session_id)
        .and_then(|id| state.ssh.get(id))
        .ok_or_else(|| AppError::NotFound("session".into()))?;
    let settings = state.settings.get()?.monitoring;
    let mode = state
        .connections
        .get(session.connection_id)
        .map(|c| c.monitoring)
        .unwrap_or_default();
    let on = match mode {
        MonitorMode::Inherit => settings.enabled,
        MonitorMode::Enabled => true,
        MonitorMode::Disabled => false,
    };
    let wanted = Wanted {
        cpu: settings.cpu,
        ram: settings.ram,
        disk: settings.disk,
        uptime: settings.uptime,
    };
    if !on || !wanted.any() {
        state.monitor.stop(session.id);
        return Ok(false);
    }
    state.monitor.start(
        session,
        MonitorConfig {
            interval: Duration::from_secs(normalize_interval(u64::from(settings.interval_secs))),
            timeout: crate::monitor::POLL_TIMEOUT,
            wanted,
        },
        Arc::new(on_event),
    );
    Ok(true)
}

#[tauri::command]
pub async fn monitor_stop(state: AppStateRef<'_>, session_id: String) -> AppResult<()> {
    if let Some(id) = SessionId::parse(&session_id) {
        state.monitor.stop(id);
    }
    Ok(())
}
