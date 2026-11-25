// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! SSH local port forwarding: saved definitions and running instances.
//! Every command refuses while the application is locked.

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::sessions::SessionId;
use crate::ssh::session::SshSession;
use crate::tunnel::{TunnelDef, TunnelInput, TunnelState, TunnelStatus};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelView {
    #[serde(flatten)]
    def: TunnelDef,
    status: TunnelStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelCounts {
    running: usize,
}

fn session_of(state: &AppState, id: &str) -> AppResult<Arc<SshSession>> {
    SessionId::parse(id)
        .and_then(|id| state.ssh.get(id))
        .ok_or_else(|| AppError::NotFound("session".into()))
}

/// The saved tunnels of the connection behind `session_id`, with their live state.
#[tauri::command]
pub async fn tunnel_list(
    state: AppStateRef<'_>,
    connection_id: Uuid,
) -> AppResult<Vec<TunnelView>> {
    state.lock.guard()?;
    Ok(state
        .tunnels
        .for_connection(connection_id)?
        .into_iter()
        .map(|def| {
            let status = state.tunnel_engine.status(def.id);
            TunnelView { def, status }
        })
        .collect())
}

#[tauri::command]
pub async fn tunnel_save(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    input: TunnelInput,
) -> AppResult<TunnelDef> {
    state.lock.guard()?;
    state.connections.get(connection_id)?;
    if let Some(id) = input.id
        && state.tunnel_engine.status(id).state != TunnelState::Stopped
    {
        return Err(AppError::validation_key(
            "tunnels.stopFirst",
            "Stop the tunnel before editing it.",
        ));
    }
    state.tunnels.save(connection_id, input)
}

#[tauri::command]
pub async fn tunnel_delete(state: AppStateRef<'_>, tunnel_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    state.tunnel_engine.stop(tunnel_id).await;
    state.tunnels.delete(tunnel_id)
}

/// Start a saved tunnel on the SSH session (tab) the user is looking at.
#[tauri::command]
pub async fn tunnel_start(
    state: AppStateRef<'_>,
    session_id: String,
    tunnel_id: Uuid,
) -> AppResult<()> {
    state.lock.guard()?;
    let session = session_of(&state, &session_id)?;
    let def = state.tunnels.get(tunnel_id)?;
    if def.connection_id != session.connection_id {
        return Err(AppError::validation_key(
            "tunnels.otherConnection",
            "This tunnel belongs to a different connection.",
        ));
    }
    state.tunnel_engine.start(&def, &session)
}

#[tauri::command]
pub async fn tunnel_stop(state: AppStateRef<'_>, tunnel_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    state.tunnel_engine.stop(tunnel_id).await;
    Ok(())
}

/// Open the local address of a RUNNING tunnel in the default browser. Only an
/// explicit user action calls this, and only for a tunnel that is listening.
#[tauri::command]
pub async fn tunnel_open_browser(state: AppStateRef<'_>, tunnel_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    if state.tunnel_engine.status(tunnel_id).state != TunnelState::Listening {
        return Err(AppError::validation_key(
            "tunnels.notRunning",
            "The tunnel is not running.",
        ));
    }
    let endpoint = state
        .tunnel_engine
        .endpoint(tunnel_id)
        .ok_or_else(|| AppError::NotFound("tunnel".into()))?;
    let url = format!("http://{endpoint}/");
    super::blocking(move || {
        crate::platform::open_url(&url)?;
        Ok(())
    })
    .await
}

/// How many tunnels are running (for the "this will close…" confirmations).
#[tauri::command]
pub async fn tunnel_counts(state: AppStateRef<'_>) -> AppResult<TunnelCounts> {
    // Allowed while locked (a bare number): quitting or updating must still warn.
    Ok(TunnelCounts {
        running: state.tunnel_engine.running_count(),
    })
}
