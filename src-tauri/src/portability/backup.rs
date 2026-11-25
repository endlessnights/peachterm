// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Creating and opening encrypted backups.
//!
//! The decrypted payload exists only in memory (never in a temporary file) and
//! is zeroised on drop on a best-effort basis. It is never returned over IPC:
//! the renderer only ever sees redacted counts and profile summaries.

use super::Stores;
use super::envelope::{self, BackupError, KdfParams};
use super::fsio;
use super::profiles::{Parsed, parse_tree};
use crate::error::{AppError, AppResult};
use crate::security::credentials::connection_account;
use crate::security::secret::SecretString;
use crate::storage::settings::{
    AppearanceSettings, CopyMode, DiagnosticsSettings, GeneralSettings, LinuxHelpSettings,
    LogLevel, Settings, SftpSettings, SshSettings, UiState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const PAYLOAD_FORMAT: &str = "peachterm-backup-payload";
/// Backups without notes keep this version, so older PeachTerm versions can still restore them.
pub const PAYLOAD_VERSION: u32 = 1;
/// Backups that carry notes.
pub const PAYLOAD_VERSION_NOTES: u32 = 2;
const MAX_PAYLOAD_VERSION: u32 = PAYLOAD_VERSION_NOTES;
const MAX_SECRET_CHARS: usize = 4096;

// ---------------------------------------------------------------------------
// Portable settings (explicit allowlist)
// ---------------------------------------------------------------------------

/// Settings that make sense on another machine and cannot run anything.
///
/// Deliberately **excluded**: `editor` (program and arguments are launched),
/// `terminal` (custom shell programs, WSL, start directory), `security`
/// (Application Lock state belongs to `lock.json`), the diagnostics log
/// folder, and anything path-like. A backup can never plant an executable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PortableSettings {
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub ssh: SshSettings,
    pub sftp: SftpSettings,
    pub diagnostics: PortableDiagnostics,
    pub shortcuts: BTreeMap<String, String>,
    pub ui: UiState,
    /// The only part of `terminal` that is safe to carry: it cannot start a program.
    pub copy_mode: CopyMode,
    /// Offline help preferences: they cannot run or reach anything.
    pub linux_help: LinuxHelpSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PortableDiagnostics {
    pub file_logging: bool,
    pub level: LogLevel,
    pub retention_days: u32,
    pub max_total_mb: u32,
}

impl Default for PortableDiagnostics {
    fn default() -> Self {
        let d = DiagnosticsSettings::default();
        Self {
            file_logging: d.file_logging,
            level: d.level,
            retention_days: d.retention_days,
            max_total_mb: d.max_total_mb,
        }
    }
}

impl PortableSettings {
    pub fn from_settings(s: &Settings) -> Self {
        Self {
            general: s.general.clone(),
            appearance: s.appearance.clone(),
            ssh: s.ssh.clone(),
            sftp: s.sftp.clone(),
            diagnostics: PortableDiagnostics {
                file_logging: s.diagnostics.file_logging,
                level: s.diagnostics.level,
                retention_days: s.diagnostics.retention_days,
                max_total_mb: s.diagnostics.max_total_mb,
            },
            shortcuts: s.shortcuts.clone(),
            ui: s.ui.clone(),
            copy_mode: s.terminal.copy_mode,
            linux_help: s.linux_help.clone(),
        }
    }

    /// Everything not listed above is kept exactly as it is on this machine.
    pub fn apply_to(&self, mut current: Settings) -> Settings {
        current.general = self.general.clone();
        current.appearance = self.appearance.clone();
        current.ssh = self.ssh.clone();
        current.sftp = self.sftp.clone();
        current.diagnostics.file_logging = self.diagnostics.file_logging;
        current.diagnostics.level = self.diagnostics.level;
        current.diagnostics.retention_days = self.diagnostics.retention_days;
        current.diagnostics.max_total_mb = self.diagnostics.max_total_mb;
        current.shortcuts = self.shortcuts.clone();
        current.ui = self.ui.clone();
        current.terminal.copy_mode = self.copy_mode;
        current.linux_help = self.linux_help.clone();
        current
    }
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// A saved password or key passphrase. Never `Debug`-printable, wiped on drop.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCredential {
    pub connection_id: Uuid,
    pub secret: Zeroizing<String>,
}

impl std::fmt::Debug for BackupCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BackupCredential([redacted])")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutFolder<'a> {
    id: Uuid,
    name: &'a str,
    parent: Option<Uuid>,
    order: i64,
    expanded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutConnection<'a> {
    id: Uuid,
    name: &'a str,
    protocol: &'static str,
    host: &'a str,
    port: u16,
    username: &'a str,
    auth: crate::storage::connections::AuthMethod,
    folder: Option<Uuid>,
    order: i64,
    save_password: bool,
    timeout_secs: u32,
    initial_directory: Option<&'a str>,
    key_path: Option<&'a str>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutPayload<'a> {
    format: &'static str,
    payload_version: u32,
    created_at: String,
    app_version: &'static str,
    folders: Vec<OutFolder<'a>>,
    connections: Vec<OutConnection<'a>>,
    settings: Option<PortableSettings>,
    credentials_requested: bool,
    credentials: Vec<BackupCredential>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notes: Vec<crate::notes::portable::PortableNote>,
}

/// What a decrypted payload looks like before validation.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InPayload {
    #[serde(default)]
    format: String,
    #[serde(default)]
    payload_version: u32,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    app_version: String,
    #[serde(default)]
    folders: Vec<Value>,
    #[serde(default)]
    connections: Vec<Value>,
    #[serde(default)]
    settings: Option<Value>,
    #[serde(default)]
    credentials_requested: bool,
    #[serde(default)]
    credentials: Vec<BackupCredential>,
    #[serde(default)]
    notes: Vec<Value>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CreateOptions {
    pub include_settings: bool,
    pub include_credentials: bool,
    pub include_notes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub saved_to: String,
    pub connections: usize,
    pub folders: usize,
    pub settings_included: bool,
    pub credentials_requested: bool,
    pub credentials_included: usize,
    pub credentials_skipped: usize,
    /// Of the skipped ones: stored in the OS vault but could not be read.
    pub credentials_unreadable: usize,
    /// The user asked for server notes.
    pub notes_requested: bool,
    pub notes_included: usize,
    /// Offline snapshots of web documents that were included.
    pub snapshots_included: usize,
    /// Linked local files: only their PATHS are in the backup, never their contents.
    pub linked_files: usize,
    pub format_version: u16,
    pub size_bytes: u64,
    /// The written file was read back and decrypted successfully.
    pub verified: bool,
}

struct Collected {
    bytes: Zeroizing<Vec<u8>>,
    connections: usize,
    folders: usize,
    included: usize,
    skipped: usize,
    unreadable: usize,
    notes: usize,
    snapshots: usize,
    linked_files: usize,
}

fn build_payload(stores: &Stores, opts: CreateOptions) -> AppResult<Collected> {
    stores.lock.guard()?;
    let tree = stores.connections.load()?;
    let settings = if opts.include_settings {
        Some(PortableSettings::from_settings(&stores.settings.get()?))
    } else {
        None
    };

    let mut credentials: Vec<BackupCredential> = Vec::new();
    let (mut skipped, mut unreadable) = (0usize, 0usize);
    if opts.include_credentials {
        let available = stores.credentials.status().available;
        for c in tree.connections.iter().filter(|c| c.has_stored_secret) {
            if !available {
                skipped += 1;
                unreadable += 1;
                continue;
            }
            match stores.credentials.get(&connection_account(&c.id)) {
                Ok(Some(secret)) if !secret.is_empty() => credentials.push(BackupCredential {
                    connection_id: c.id,
                    secret: Zeroizing::new(secret.expose().to_owned()),
                }),
                Ok(_) => skipped += 1, // flagged but no longer in the vault
                Err(_) => {
                    skipped += 1;
                    unreadable += 1;
                }
            }
        }
    }
    let included = credentials.len();

    let folders: Vec<OutFolder> = tree
        .folders
        .iter()
        .map(|f| OutFolder {
            id: f.id,
            name: &f.name,
            parent: f.parent_id,
            order: f.sort_order,
            expanded: f.expanded,
        })
        .collect();
    let connections: Vec<OutConnection> = tree
        .connections
        .iter()
        .map(|c| OutConnection {
            id: c.id,
            name: &c.name,
            protocol: "ssh",
            host: &c.host,
            port: c.port,
            username: &c.username,
            auth: c.auth,
            folder: c.folder_id,
            order: c.sort_order,
            save_password: c.save_password,
            timeout_secs: c.timeout_secs,
            initial_directory: c.initial_directory.as_deref(),
            key_path: c.key_path.as_deref(),
            created_at: c.created_at,
            updated_at: c.updated_at,
        })
        .collect();
    // Server notes: everything PeachTerm itself stores (internal notes, relations,
    // URLs, linked-file paths and explicitly saved offline snapshots). Nothing is
    // fetched and linked files are not read.
    let notes = match (opts.include_notes, stores.notes) {
        (true, Some(store)) => store.export_notes(&Some, true)?,
        _ => Vec::new(),
    };
    let snapshots = notes.iter().filter(|n| n.snapshot.is_some()).count();
    let linked_files = notes
        .iter()
        .filter(|n| n.kind == crate::notes::NoteKind::LocalFile)
        .count();
    let notes_count = notes.len();
    let payload = OutPayload {
        format: PAYLOAD_FORMAT,
        payload_version: if notes.is_empty() {
            PAYLOAD_VERSION
        } else {
            PAYLOAD_VERSION_NOTES
        },
        created_at: crate::logging::clock::format_timestamp(std::time::SystemTime::now()),
        app_version: env!("CARGO_PKG_VERSION"),
        folders,
        connections,
        settings,
        credentials_requested: opts.include_credentials,
        credentials,
        notes,
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&payload)?);
    Ok(Collected {
        bytes,
        connections: tree.connections.len(),
        folders: tree.folders.len(),
        included,
        skipped,
        unreadable,
        notes: notes_count,
        snapshots,
        linked_files,
    })
}

/// Encrypt the current configuration into `dest`.
///
/// Nothing but ciphertext is written. The file is staged under a temporary
/// name, read back and decrypted to prove it is good, and only then renamed to
/// its final name.
pub fn create_backup(
    stores: &Stores,
    dest: &Path,
    opts: CreateOptions,
    passphrase: &SecretString,
    params: KdfParams,
    overwrite: bool,
) -> AppResult<BackupSummary> {
    envelope::check_passphrase(passphrase.expose())?;
    let collected = build_payload(stores, opts)?;
    let sealed = envelope::seal(&collected.bytes, passphrase.expose(), params)?;
    stores.lock.guard()?; // the user may have locked while we were deriving the key
    let temp = fsio::stage(dest, &sealed)?;

    // Verify what is really on disk before it gets its final name.
    let verified = (|| -> AppResult<bool> {
        let on_disk = fsio::read_capped(&temp, envelope::MAX_FILE_BYTES)?;
        let reopened = envelope::open(&on_disk, passphrase.expose())?;
        Ok(reopened.as_slice() == collected.bytes.as_slice())
    })();
    match verified {
        Ok(true) => {}
        Ok(false) | Err(_) => {
            fsio::discard(&temp);
            return Err(AppError::storage_key(
                "backup.verifyFailed",
                "The backup could not be verified after writing, so it was discarded. Nothing was saved.",
            ));
        }
    }
    stores.lock.guard().inspect_err(|_| fsio::discard(&temp))?;
    fsio::publish(&temp, dest, overwrite)?;
    Ok(BackupSummary {
        saved_to: dest.to_string_lossy().into_owned(),
        connections: collected.connections,
        folders: collected.folders,
        settings_included: opts.include_settings,
        credentials_requested: opts.include_credentials,
        credentials_included: collected.included,
        credentials_skipped: collected.skipped,
        credentials_unreadable: collected.unreadable,
        notes_requested: opts.include_notes,
        notes_included: collected.notes,
        snapshots_included: collected.snapshots,
        linked_files: collected.linked_files,
        format_version: envelope::FORMAT_VERSION,
        size_bytes: sealed.len() as u64,
        verified: true,
    })
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/// A decrypted, validated backup held in backend memory.
pub struct OpenedBackup {
    pub parsed: Parsed,
    pub settings: Option<PortableSettings>,
    /// Secrets by *source* connection id, only for valid profiles.
    pub secrets: HashMap<Uuid, Zeroizing<String>>,
    pub created_at: String,
    pub app_version: String,
    pub credentials_requested: bool,
    /// Valid notes of the backup (empty for backups made without notes).
    pub notes: Vec<crate::notes::portable::PortableNote>,
    pub notes_invalid: usize,
}

impl OpenedBackup {
    pub fn credential_count(&self) -> usize {
        self.secrets.len()
    }
}

pub fn open_backup(file: &[u8], passphrase: &SecretString) -> Result<OpenedBackup, BackupError> {
    let plain = envelope::open(file, passphrase.expose())?;
    let payload: InPayload =
        serde_json::from_slice(&plain).map_err(|_| BackupError::InvalidContent)?;
    drop(plain);
    if payload.format != PAYLOAD_FORMAT {
        return Err(BackupError::InvalidContent);
    }
    if payload.payload_version == 0 || payload.payload_version > MAX_PAYLOAD_VERSION {
        return Err(BackupError::UnsupportedVersion);
    }
    if payload.folders.len() > super::profiles::MAX_FOLDERS
        || payload.connections.len() > super::profiles::MAX_CONNECTIONS
        || payload.credentials.len() > super::profiles::MAX_CONNECTIONS
    {
        return Err(BackupError::InvalidContent);
    }
    let mut parsed = Parsed::default();
    parsed.format_version = payload.payload_version as u64;
    parse_tree(&payload.folders, &payload.connections, true, &mut parsed);
    // Notes exist from payload version 2 on; a version 1 payload has none, whatever it contains.
    if payload.payload_version >= PAYLOAD_VERSION_NOTES {
        super::profiles::parse_notes(&payload.notes, &mut parsed);
    }

    let valid: std::collections::HashSet<Uuid> = parsed
        .incoming
        .connections
        .iter()
        .filter_map(|c| c.id_hint)
        .collect();
    let mut secrets = HashMap::new();
    for c in payload.credentials {
        if valid.contains(&c.connection_id)
            && !c.secret.is_empty()
            && c.secret.chars().count() <= MAX_SECRET_CHARS
        {
            secrets.insert(c.connection_id, c.secret);
        }
    }
    let settings = payload
        .settings
        .and_then(|v| serde_json::from_value::<PortableSettings>(v).ok());
    let notes = std::mem::take(&mut parsed.notes);
    let notes_invalid = parsed.notes_invalid;
    Ok(OpenedBackup {
        parsed,
        notes,
        notes_invalid,
        settings,
        secrets,
        created_at: payload.created_at.chars().take(40).collect(),
        app_version: payload.app_version.chars().take(40).collect(),
        credentials_requested: payload.credentials_requested,
    })
}
