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
use crate::notes::portable::NotesPreview;
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
    /// Server notes; `None` where the feature is not in play (some tests).
    pub notes: Option<&'a crate::notes::NotesStore>,
}

/// What a connections export does with server notes (default: nothing).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesExport {
    #[serde(default)]
    pub include: bool,
    /// Offline snapshots of web documents, only with a second explicit choice.
    #[serde(default)]
    pub snapshots: bool,
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
    pub notes: usize,
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
    /// Present when the file carries server notes.
    pub notes: Option<NotesPreview>,
    pub notes_invalid: usize,
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
    /// Present when the backup carries server notes.
    pub notes: Option<NotesPreview>,
    pub notes_invalid: usize,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOptions {
    pub include_settings: bool,
    pub include_credentials: bool,
    #[serde(default)]
    pub include_notes: bool,
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

/// Counts only. Every incoming profile counts as taking part, so the numbers show what the file holds.
fn notes_preview_of(
    stores: &Stores,
    notes: &[crate::notes::portable::PortableNote],
    set: &profiles::IncomingSet,
    key: impl Fn(&profiles::IncomingConnection) -> Option<Uuid>,
) -> AppResult<Option<NotesPreview>> {
    let Some(store) = stores.notes else {
        return Ok(None);
    };
    if notes.is_empty() {
        return Ok(None);
    }
    let mapping: std::collections::HashMap<Uuid, Uuid> = set
        .connections
        .iter()
        .filter_map(|c| key(c).map(|k| (k, k)))
        .collect();
    crate::notes::portable::preview(store, notes, &mapping).map(Some)
}

fn notes_preview(
    stores: &Stores,
    parsed: &profiles::Parsed,
    key: impl Fn(&profiles::IncomingConnection) -> Option<Uuid>,
) -> AppResult<Option<NotesPreview>> {
    notes_preview_of(stores, &parsed.notes, &parsed.incoming, key)
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
        notes: NotesExport,
    ) -> AppResult<ExportOutcome> {
        stores.lock.guard()?;
        let tree = stores.connections.load()?;
        let selected: Option<HashSet<Uuid>> = ids.map(|i| i.iter().copied().collect());
        let (mut doc, stats) = profiles::build_export(
            &tree,
            selected.as_ref(),
            include_key_paths,
            crate::logging::clock::format_timestamp(std::time::SystemTime::now()),
        );
        // Server notes only on explicit request, and only for the exported connections.
        // Connections are named by their public id, exactly like in the profile list.
        if notes.include
            && let Some(store) = stores.notes
        {
            let exported: HashSet<Uuid> = tree
                .connections
                .iter()
                .map(|c| c.id)
                .filter(|id| selected.as_ref().is_none_or(|s| s.contains(id)))
                .collect();
            doc.notes = store.export_notes(
                &|c| exported.contains(&c).then(|| profiles::public_id(c)),
                notes.snapshots,
            )?;
        }
        let note_count = doc.notes.len();
        let bytes = profiles::export_to_bytes(&doc)?;
        stores.lock.guard()?;
        fsio::write_atomic(dest, &bytes, true)?;
        Ok(ExportOutcome {
            saved_to: Some(dest.to_string_lossy().into_owned()),
            connections: stats.connections,
            folders: stats.folders,
            key_paths: stats.key_paths,
            notes: note_count,
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
            notes: notes_preview(stores, &parsed, |c| c.stable_hint)?,
            notes_invalid: parsed.notes_invalid,
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
        import_notes: bool,
    ) -> AppResult<RestoreResult> {
        let staged = self.staging.take(token, Kind::Import, stores.lock)?;
        let Staged::Import { parsed } = staged else {
            return Err(AppError::validation_key(
                "portability.startAgain",
                "Please start again.",
            ));
        };
        if update
            .iter()
            .any(|&i| i >= parsed.incoming.connections.len())
        {
            self.staging.put_back(token, Staged::Import { parsed });
            return Err(AppError::validation_key(
                "portability.unknownProfile",
                "Unknown profile selected.",
            ));
        }
        let update_set: HashSet<usize> = update.iter().copied().collect();
        match restore::commit_import(
            stores,
            &parsed.incoming,
            DuplicatePolicy::from(duplicates),
            &update_set,
            now_millis(),
            if import_notes { &parsed.notes } else { &[] },
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
            return Err(AppError::validation_key(
                "portability.passphraseMismatch",
                "The passphrases do not match.",
            ));
        }
        envelope::check_passphrase(passphrase.expose())?;
        let staged = self.staging.take(token, Kind::Destination, stores.lock)?;
        let Staged::Destination { path } = staged else {
            return Err(AppError::validation_key(
                "portability.startAgain",
                "Please start again.",
            ));
        };
        // The destination stays usable if writing fails (disk full, etc.).
        let result = backup::create_backup(
            stores,
            &path,
            CreateOptions {
                include_settings: options.include_settings,
                include_credentials: options.include_credentials,
                include_notes: options.include_notes,
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
            return Err(AppError::validation_key(
                "portability.startAgain",
                "Please start again.",
            ));
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
            notes: notes_preview_of(stores, &opened.notes, &opened.parsed.incoming, |c| {
                c.id_hint
            })?,
            notes_invalid: opened.notes_invalid,
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
            return Err(AppError::validation_key(
                "portability.startAgain",
                "Please start again.",
            ));
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
