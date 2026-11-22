// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::local::profiles::{self, Probe, Profile, SystemProbe};
use crate::local::session::{self, StartParams};
use crate::sessions::SessionId;
use crate::ssh::session::decode;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tauri::ipc::Channel;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProfiles {
    profiles: Vec<Profile>,
    /// The profile a plain click on `+` starts.
    default: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedLocal {
    session_id: Uuid,
}

fn session_of(state: &AppState, id: &str) -> AppResult<Arc<session::LocalSession>> {
    SessionId::parse(id)
        .and_then(|id| state.local.get(id))
        .ok_or_else(|| AppError::NotFound("session".into()))
}

/// Shells available on this machine (detected again on every call, which is
/// also what "Refresh profiles" uses).
#[tauri::command]
pub async fn local_profiles(state: AppStateRef<'_>) -> AppResult<LocalProfiles> {
    state.lock.guard()?;
    let settings = state.settings.get()?.terminal;
    super::blocking(move || {
        let probe = SystemProbe;
        let entries = profiles::discover(&probe, &settings);
        let default = profiles::default_id(&entries, &settings, probe.os());
        Ok(LocalProfiles {
            profiles: entries.into_iter().map(|e| e.profile).collect(),
            default,
        })
    })
    .await
}

/// Start a local shell. `profile_id` must be one of the ids from `local_profiles`.
#[tauri::command]
pub async fn local_open(
    state: AppStateRef<'_>,
    profile_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<crate::ssh::TerminalEvent>,
) -> AppResult<OpenedLocal> {
    state.lock.guard()?;
    let settings = state.settings.get()?.terminal;
    let wanted = profile_id.clone();
    let (spec, cwd) = super::blocking(move || {
        let entries = profiles::discover(&SystemProbe, &settings);
        let entry = entries
            .into_iter()
            .find(|e| e.profile.id == wanted)
            .ok_or_else(|| AppError::NotFound("shell profile".into()))?;
        let dir = settings
            .start_dir
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && SystemProbe.is_dir(p));
        Ok(profiles::with_start_dir(&entry.spec, dir.as_deref()))
    })
    .await?;
    let id = SessionId::new();
    let app = Arc::clone(&state);
    let started = session::start(StartParams {
        id,
        spec,
        cwd,
        cols,
        rows,
        sink: Arc::new(on_event),
        lock: state.lock.flag(),
        on_end: Arc::new(move |ended| {
            app.local.remove(ended);
        }),
    });
    match started {
        Ok(session) => {
            state.local.insert(session);
            Ok(OpenedLocal {
                session_id: id.uuid(),
            })
        }
        Err(e) => {
            tracing::warn!(event = "local.start_failed", reason = "launch_failed");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn local_write(
    state: AppStateRef<'_>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    state.lock.guard()?;
    let bytes =
        decode(&data).ok_or_else(|| AppError::Validation("Invalid input encoding".into()))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::Validation("Input is too large".into()));
    }
    session_of(&state, &session_id)?.write(bytes);
    Ok(())
}

#[tauri::command]
pub async fn local_resize(
    state: AppStateRef<'_>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.lock.guard()?;
    session_of(&state, &session_id)?.resize(cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn local_ack(state: AppStateRef<'_>, session_id: String, bytes: usize) -> AppResult<()> {
    state.lock.guard()?;
    session_of(&state, &session_id)?.credits.ack(bytes);
    Ok(())
}

#[tauri::command]
pub async fn local_close(state: AppStateRef<'_>, session_id: String) -> AppResult<()> {
    state.lock.guard()?;
    if let Ok(session) = session_of(&state, &session_id) {
        let app = Arc::clone(&state);
        super::blocking(move || {
            session.close();
            app.local.remove(session.id);
            Ok(())
        })
        .await?;
    }
    Ok(())
}
