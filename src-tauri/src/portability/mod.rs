// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Data portability: connection JSON export/import and encrypted backups.
//!
//! Everything privileged lives here, in Rust, behind the Application Lock:
//! the renderer never supplies a file path, never receives a secret and never
//! sees decrypted backup content (only redacted summaries). See
//! `docs/import-export.md` and `docs/backup-format.md`.
//!
//! [`PortabilityService`] takes its collaborators as [`Stores`] so the whole
//! flow (including Application Lock enforcement and failure recovery) is unit
//! testable without a Tauri runtime.

pub mod backup;
pub mod envelope;
pub mod fsio;
pub mod profiles;
pub mod restore;
pub mod staging;

use crate::error::{AppError, AppResult};
use crate::lock::LockFlag;
use crate::security::credentials::CredentialStore;
use crate::security::secret::SecretString;
use crate::storage::connections::ConnectionStore;
use crate::storage::settings::SettingsStore;
use backup::{BackupSummary, CreateOptions};
use envelope::KdfParams;
use profiles::{
    DuplicatePolicy, InvalidEntry, KeyPathState, Match, classify, folder_path, key_path_state,
};
use restore::{DuplicateChoice, RestoreOptions, RestoreResult};
use serde::{Deserialize, Serialize};
use staging::{Kind, MAX_UNLOCK_ATTEMPTS, Staged, Staging};
use std::collections::HashSet;
use std::path::Path;
use uuid::Uuid;

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What the service operates on.
pub struct Stores<'a> {
    pub connections: &'a ConnectionStore,
    pub settings: &'a SettingsStore,
    pub credentials: &'a dyn CredentialStore,
    pub lock: &'a LockFlag,
}

const MAX_LISTED_ITEMS: usize = 2000;
const MAX_LISTED_INVALID: usize = 50;

// ---------------------------------------------------------------------------
// Wire types (all redacted: no secrets, no file contents beyond summaries)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    /// `None` when the user cancelled the save dialog.
    pub saved_to: Option<String>,
    pub connections: usize,
    pub folders: usize,
    pub key_paths: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    New,
    Duplicate,
    Changed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub index: usize,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub folder_path: String,
    pub status: ItemStatus,
    pub existing_name: Option<String>,
    pub key_path: KeyPathState,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub token: Uuid,
    pub file_name: String,
    pub format_version: u64,
    pub exported_at: Option<String>,
    pub folder_count: usize,
    pub connection_count: usize,
    pub new_count: usize,
    pub duplicate_count: usize,
    pub changed_count: usize,
    pub invalid_count: usize,
    pub relocated_count: usize,
    pub unsupported_fields: Vec<String>,
    pub key_paths_present: usize,
    pub key_paths_missing: usize,
    /// Profiles that use key authentication but name no key file.
    pub needs_key: usize,
    pub invalid: Vec<InvalidEntry>,
    pub items: Vec<PreviewItem>,
    pub items_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub token: Uuid,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileInfo {
    pub token: Uuid,
    pub file_name: String,
    pub size_bytes: u64,
    pub format_version: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub token: Uuid,
    pub created_at: String,
    pub app_version: String,
    pub connection_count: usize,
    pub folder_count: usize,
    pub invalid_count: usize,
    pub new_count: usize,
    pub duplicate_count: usize,
    pub changed_count: usize,
    pub settings_included: bool,
    pub credentials_requested: bool,
    pub credential_count: usize,
    pub credential_store_available: bool,
    pub key_paths_present: usize,
    pub key_paths_missing: usize,
    pub needs_key: usize,
    pub unsupported_fields: Vec<String>,
    pub items: Vec<PreviewItem>,
    pub items_truncated: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOptions {
    pub include_settings: bool,
    pub include_credentials: bool,
}

pub struct PortabilityService {
    staging: Staging,
    kdf: KdfParams,
}

impl Default for PortabilityService {
    fn default() -> Self {
        Self::new(KdfParams::DEFAULT)
    }
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().chars().take(120).collect())
        .unwrap_or_default()
}

fn preview_items(
    stores: &Stores,
    set: &profiles::IncomingSet,
    secrets: Option<&std::collections::HashMap<Uuid, zeroize::Zeroizing<String>>>,
) -> AppResult<(Vec<PreviewItem>, [usize; 3], [usize; 3])> {
    let tree = stores.connections.load()?;
    let mut counts = [0usize; 3]; // new, duplicate, changed
    let mut keys = [0usize; 3]; // present, missing, needs key
    let mut items = Vec::new();
    for (index, c) in set.connections.iter().enumerate() {
        let (status, existing) = match classify(&tree, c) {
            Match::New => (ItemStatus::New, None),
            Match::Duplicate(id) => (ItemStatus::Duplicate, Some(id)),
            Match::Changed(id) => (ItemStatus::Changed, Some(id)),
        };
        counts[match status {
            ItemStatus::New => 0,
            ItemStatus::Duplicate => 1,
            ItemStatus::Changed => 2,
        }] += 1;
        let key = key_path_state(c.key_path.as_deref());
        match key {
            KeyPathState::Present => keys[0] += 1,
            KeyPathState::Missing => keys[1] += 1,
            _ => {}
        }
        if c.auth == crate::storage::connections::AuthMethod::PublicKey && c.key_path.is_none() {
            keys[2] += 1;
        }
        if items.len() < MAX_LISTED_ITEMS {
            items.push(PreviewItem {
                index,
                name: c.name.clone(),
                host: c.host.clone(),
                port: c.port,
                username: c.username.clone(),
                folder_path: folder_path(set, c.folder.as_deref()),
                status,
                existing_name: existing
                    .and_then(|id| tree.connections.iter().find(|e| e.id == id))
                    .map(|e| e.name.clone()),
                key_path: key,
                has_credential: secrets
                    .zip(c.id_hint)
                    .is_some_and(|(s, id)| s.contains_key(&id)),
            });
        }
    }
    Ok((items, counts, keys))
}

impl PortabilityService {
    pub fn new(kdf: KdfParams) -> Self {
        Self {
            staging: Staging::new(staging::DEFAULT_TTL),
            kdf,
        }
    }

    /// Forget every staged operation (called when the application locks).
    pub fn clear(&self) {
        self.staging.clear();
    }

    pub fn cancel(&self, token: Uuid) {
        self.staging.cancel(token);
    }

    // ---- connection export --------------------------------------------------

    /// Build and atomically write the connections JSON. `dest` comes from the
    /// native save dialog, which has already confirmed replacing a file.
    pub fn write_connections_export(
        &self,
        stores: &Stores,
        dest: &Path,
        ids: Option<&[Uuid]>,
        include_key_paths: bool,
    ) -> AppResult<ExportOutcome> {
        stores.lock.guard()?;
        let tree = stores.connections.load()?;
        let selected: Option<HashSet<Uuid>> = ids.map(|i| i.iter().copied().collect());
        let (doc, stats) = profiles::build_export(
            &tree,
            selected.as_ref(),
            include_key_paths,
            crate::logging::clock::format_timestamp(std::time::SystemTime::now()),
        );
        let bytes = profiles::export_to_bytes(&doc)?;
        stores.lock.guard()?;
        fsio::write_atomic(dest, &bytes, true)?;
        Ok(ExportOutcome {
            saved_to: Some(dest.to_string_lossy().into_owned()),
            connections: stats.connections,
            folders: stats.folders,
            key_paths: stats.key_paths,
        })
    }

    // ---- connection import --------------------------------------------------

    /// Read, validate and stage a file. Changes nothing.
    pub fn stage_import(&self, stores: &Stores, path: &Path) -> AppResult<ImportPreview> {
        stores.lock.guard()?;
        let bytes = fsio::read_capped(path, profiles::MAX_IMPORT_BYTES)?;
        let parsed = profiles::parse_document(&bytes)?;
        stores.lock.guard()?;
        let (items, counts, keys) = preview_items(stores, &parsed.incoming, None)?;
        let preview = ImportPreview {
            token: Uuid::nil(),
            file_name: file_label(path),
            format_version: parsed.format_version,
            exported_at: parsed.exported_at.clone(),
            folder_count: parsed.incoming.folders.len(),
            connection_count: parsed.incoming.connections.len(),
            new_count: counts[0],
            duplicate_count: counts[1],
            changed_count: counts[2],
            invalid_count: parsed.invalid.len(),
            relocated_count: parsed.relocated,
            unsupported_fields: parsed.unsupported_fields.iter().take(30).cloned().collect(),
            key_paths_present: keys[0],
            key_paths_missing: keys[1],
            needs_key: keys[2],
            invalid: parsed
                .invalid
                .iter()
                .take(MAX_LISTED_INVALID)
                .cloned()
                .collect(),
            items_truncated: parsed.incoming.connections.len() > items.len(),
            items,
        };
        let token = self.staging.insert(Staged::Import { parsed });
        Ok(ImportPreview { token, ..preview })
    }

    pub fn apply_import(
        &self,
        stores: &Stores,
        token: Uuid,
        duplicates: DuplicateChoice,
        update: &[usize],
    ) -> AppResult<RestoreResult> {
        let staged = self.staging.take(token, Kind::Import, stores.lock)?;
        let Staged::Import { parsed } = staged else {
            return Err(AppError::Validation("Please start again.".into()));
        };
        if update
            .iter()
            .any(|&i| i >= parsed.incoming.connections.len())
        {
            self.staging.put_back(token, Staged::Import { parsed });
            return Err(AppError::Validation("Unknown profile selected.".into()));
        }
        let update_set: HashSet<usize> = update.iter().copied().collect();
        match restore::commit_import(
            stores,
            &parsed.incoming,
            DuplicatePolicy::from(duplicates),
            &update_set,
            now_millis(),
        ) {
            Ok(mut result) => {
                result.failed = parsed.invalid.len();
                Ok(result)
            }
            Err(e) => {
                self.staging.put_back(token, Staged::Import { parsed });
                Err(e)
            }
        }
    }

    // ---- encrypted backup: create -----------------------------------------

    pub fn choose_backup_destination(
        &self,
        stores: &Stores,
        path: &Path,
    ) -> AppResult<Destination> {
        stores.lock.guard()?;
        let path = fsio::with_extension(path.to_path_buf(), "peachbackup");
        let shown = path.to_string_lossy().into_owned();
        let token = self.staging.insert(Staged::Destination { path });
        Ok(Destination { token, path: shown })
    }

    pub fn create_backup(
        &self,
        stores: &Stores,
        token: Uuid,
        options: BackupOptions,
        passphrase: &SecretString,
        confirm: &SecretString,
    ) -> AppResult<BackupSummary> {
        stores.lock.guard()?;
        if passphrase.expose() != confirm.expose() {
            return Err(AppError::Validation("The passphrases do not match.".into()));
        }
        envelope::check_passphrase(passphrase.expose())?;
        let staged = self.staging.take(token, Kind::Destination, stores.lock)?;
        let Staged::Destination { path } = staged else {
            return Err(AppError::Validation("Please start again.".into()));
        };
        // The destination stays usable if writing fails (disk full, etc.).
        let result = backup::create_backup(
            stores,
            &path,
            CreateOptions {
                include_settings: options.include_settings,
                include_credentials: options.include_credentials,
            },
            passphrase,
            self.kdf,
            true,
        );
        if result.is_err() {
            self.staging.put_back(token, Staged::Destination { path });
        }
        result
    }

    // ---- encrypted backup: restore -----------------------------------------

    pub fn stage_backup_file(&self, stores: &Stores, path: &Path) -> AppResult<BackupFileInfo> {
        stores.lock.guard()?;
        let bytes = fsio::read_capped(path, envelope::MAX_FILE_BYTES)?;
        let format_version = envelope::inspect(&bytes)?;
        let size_bytes = bytes.len() as u64;
        let token = self
            .staging
            .insert(Staged::BackupFile { bytes, attempts: 0 });
        Ok(BackupFileInfo {
            token,
            file_name: file_label(path),
            size_bytes,
            format_version,
        })
    }

    /// Authenticate and decrypt. Returns only a redacted preview.
    pub fn unlock_backup(
        &self,
        stores: &Stores,
        token: Uuid,
        passphrase: &SecretString,
    ) -> AppResult<RestorePreview> {
        let staged = self.staging.take(token, Kind::BackupFile, stores.lock)?;
        let Staged::BackupFile { bytes, attempts } = staged else {
            return Err(AppError::Validation("Please start again.".into()));
        };
        let opened = match backup::open_backup(&bytes, passphrase) {
            Ok(o) => o,
            Err(e) => {
                if e == envelope::BackupError::Authentication && attempts + 1 < MAX_UNLOCK_ATTEMPTS
                {
                    self.staging.put_back(
                        token,
                        Staged::BackupFile {
                            bytes,
                            attempts: attempts + 1,
                        },
                    );
                }
                return Err(e.into());
            }
        };
        if stores.lock.guard().is_err() {
            self.staging.clear();
            return Err(AppError::Locked);
        }
        let (items, counts, keys) =
            preview_items(stores, &opened.parsed.incoming, Some(&opened.secrets))?;
        let preview = RestorePreview {
            token,
            created_at: opened.created_at.clone(),
            app_version: opened.app_version.clone(),
            connection_count: opened.parsed.incoming.connections.len(),
            folder_count: opened.parsed.incoming.folders.len(),
            invalid_count: opened.parsed.invalid.len(),
            new_count: counts[0],
            duplicate_count: counts[1],
            changed_count: counts[2],
            settings_included: opened.settings.is_some(),
            credentials_requested: opened.credentials_requested,
            credential_count: opened.credential_count(),
            credential_store_available: stores.credentials.status().available,
            key_paths_present: keys[0],
            key_paths_missing: keys[1],
            needs_key: keys[2],
            unsupported_fields: opened
                .parsed
                .unsupported_fields
                .iter()
                .take(30)
                .cloned()
                .collect(),
            items_truncated: opened.parsed.incoming.connections.len() > items.len(),
            items,
        };
        self.staging.put_back(
            token,
            Staged::Opened {
                backup: Box::new(opened),
            },
        );
        Ok(preview)
    }

    pub fn restore_backup(
        &self,
        stores: &Stores,
        token: Uuid,
        options: &RestoreOptions,
    ) -> AppResult<RestoreResult> {
        let staged = self.staging.take(token, Kind::Opened, stores.lock)?;
        let Staged::Opened { backup } = staged else {
            return Err(AppError::Validation("Please start again.".into()));
        };
        let outcome: AppResult<RestoreResult> =
            restore::commit(stores, &backup, options, now_millis());
        match outcome {
            Ok(result) => Ok(result),
            Err(e) => {
                // Validation/precondition problems can be fixed by the user and
                // retried without decrypting again; the lock wipes everything.
                if !matches!(e, AppError::Locked) {
                    self.staging.put_back(token, Staged::Opened { backup });
                }
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests;
