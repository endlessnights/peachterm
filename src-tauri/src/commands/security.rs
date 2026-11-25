// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::security::clear::{Refusal, clear_all};
use crate::security::credentials::{CredentialStatus, connection_account};
use crate::security::known_hosts::KnownHost;
use crate::security::secret::SecretString;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
pub async fn credentials_status(state: AppStateRef<'_>) -> AppResult<CredentialStatus> {
    state.lock.guard()?;
    let app = Arc::clone(&state);
    super::blocking(move || Ok(app.credentials.status())).await
}

/// Write-only: the secret enters Rust here and is never sent back.
#[tauri::command]
pub async fn credentials_set_password(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    secret: SecretString,
) -> AppResult<()> {
    state.lock.guard()?;
    let connection = state.connections.get(connection_id)?;
    if !connection.save_password {
        return Err(AppError::validation_key(
            "credentials.savingDisabled",
            "Password saving is disabled for this connection",
        ));
    }
    if secret.is_empty() {
        return Err(AppError::validation_key(
            "credentials.empty",
            "Password is empty",
        ));
    }
    let app = Arc::clone(&state);
    super::blocking(move || {
        app.credentials
            .set(&connection_account(&connection_id), &secret)
    })
    .await?;
    state
        .connections
        .set_has_stored_secret(connection_id, true)?;
    tracing::info!(event = "credentials.saved", connection_id = %connection_id);
    Ok(())
}

#[tauri::command]
pub async fn credentials_clear(state: AppStateRef<'_>, connection_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    state.connections.get(connection_id)?;
    let app = Arc::clone(&state);
    super::blocking(move || app.credentials.delete(&connection_account(&connection_id))).await?;
    state
        .connections
        .set_has_stored_secret(connection_id, false)?;
    tracing::info!(event = "credentials.cleared", connection_id = %connection_id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearChallenge {
    token: Uuid,
    question: String,
    expires_in_secs: u64,
    /// Saved passwords / key passphrases that would be deleted.
    count: usize,
}

/// Stage 2 of "clear all saved passwords": Rust creates a short-lived,
/// single-use confirmation (token + small arithmetic question). Nothing is
/// deleted here.
#[tauri::command]
pub async fn credentials_clear_begin(state: AppStateRef<'_>) -> AppResult<ClearChallenge> {
    state.lock.guard()?;
    let count = state
        .connections
        .load()?
        .connections
        .iter()
        .filter(|c| c.has_stored_secret)
        .count();
    let challenge = state.credential_clear.begin();
    Ok(ClearChallenge {
        token: challenge.token,
        question: challenge.question,
        expires_in_secs: challenge.expires_in_secs,
        count,
    })
}

#[tauri::command]
pub async fn credentials_clear_cancel(state: AppStateRef<'_>) -> AppResult<()> {
    state.lock.guard()?;
    state.credential_clear.cancel();
    Ok(())
}

/// Deletes PeachTerm's saved passwords and passphrases, but only with a valid
/// confirmation from [`credentials_clear_begin`] and the right answer; the
/// renderer cannot skip that check. Every entry is attempted, failures are
/// counted, nothing but counts is logged.
#[tauri::command]
pub async fn credentials_clear_all(
    state: AppStateRef<'_>,
    token: Uuid,
    answer: i64,
) -> AppResult<ClearedCount> {
    state.lock.guard()?;
    state.credential_clear.verify(token, answer).map_err(|r| {
        tracing::warn!(
            event = "credentials.clear_refused",
            reason = match r {
                Refusal::Expired => "timeout",
                Refusal::TooManyAttempts | Refusal::WrongAnswer => "rejected",
                Refusal::Unknown => "invalid",
            }
        );
        match r {
            Refusal::WrongAnswer => AppError::validation_key(
                "credentials.clearWrong",
                "That is not the right answer. Nothing was deleted.",
            ),
            Refusal::Expired => AppError::validation_key(
                "credentials.clearExpired",
                "The confirmation expired. Nothing was deleted.",
            ),
            Refusal::TooManyAttempts => AppError::validation_key(
                "credentials.clearTooMany",
                "Too many wrong answers. Nothing was deleted; start again.",
            ),
            Refusal::Unknown => AppError::validation_key(
                "credentials.clearUnknown",
                "There is no pending confirmation. Nothing was deleted.",
            ),
        }
    })?;
    let tree = state.connections.load()?;
    let entries: Vec<(Uuid, bool)> = tree
        .connections
        .iter()
        .map(|c| (c.id, c.has_stored_secret))
        .collect();
    let app = Arc::clone(&state);
    let outcome = super::blocking(move || {
        let mut deleted = Vec::new();
        let outcome = clear_all(app.credentials.as_ref(), &entries, |id| deleted.push(id));
        for id in deleted {
            app.connections.set_has_stored_secret(id, false)?;
        }
        Ok(outcome)
    })
    .await?;
    tracing::info!(
        event = "credentials.cleared_all",
        count = outcome.deleted as u64,
        files = outcome.failed as u64,
    );
    Ok(ClearedCount {
        deleted: outcome.deleted,
        failed: outcome.failed,
    })
}

#[derive(Serialize)]
pub struct ClearedCount {
    deleted: usize,
    failed: usize,
}

#[tauri::command]
pub async fn known_hosts_list(state: AppStateRef<'_>) -> AppResult<Vec<KnownHost>> {
    state.lock.guard()?;
    state.known_hosts.list()
}

#[tauri::command]
pub async fn known_hosts_remove(state: AppStateRef<'_>, host: String, port: u16) -> AppResult<()> {
    state.lock.guard()?;
    let removed = state.known_hosts.remove(&host, port)?;
    tracing::info!(event = "known_hosts.removed", count = removed as u64);
    Ok(())
}
