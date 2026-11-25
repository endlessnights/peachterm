// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Applying a decrypted backup (or a validated JSON import) to this machine.
//!
//! # Failure model (what is and is not atomic)
//!
//! The OS credential store has no transactions, and JSON files and the vault
//! cannot be committed together. The commit therefore runs in a fixed order
//! with compensation:
//!
//! 1. Everything is validated and the new state is computed in memory. Nothing
//!    has changed yet; any error here leaves the machine untouched.
//! 2. Credentials are written one by one. For each, the previous value is
//!    remembered. A single credential that cannot be written is *reported as
//!    failed* and does not abort the restore.
//! 3. `connections.json` is replaced in one atomic file write, and only if it
//!    is still exactly what the plan was based on.
//! 4. `settings.json` is replaced in one atomic file write.
//!
//! If step 3 or 4 fails, every credential written in step 2 is put back to its
//! previous value (or deleted if it did not exist) and, after step 4, the
//! connections file is restored too. If a *compensating* action itself fails,
//! the error says so honestly. We never claim an atomicity the platform
//! cannot provide; what is guaranteed is that each file is either fully old or
//! fully new, and that failures are reported with exact counts.

use super::Stores;
use super::backup::OpenedBackup;
use super::profiles::{
    DuplicatePolicy, IncomingSet, Match, MergeRequest, Outcome, classify, merge,
};
use crate::error::{AppError, AppResult};
use crate::notes::portable::{NotesMergeResult, PortableNote};
use crate::security::credentials::connection_account;
use crate::security::secret::SecretString;
use crate::storage::connections::ConnectionTree;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    /// Add to what exists; duplicates follow the chosen policy.
    Merge,
    /// Only the chosen profiles, otherwise like merge.
    Selected,
    /// Make this machine's connections match the backup.
    Replace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DuplicateChoice {
    Skip,
    Copy,
    Update,
}

impl From<DuplicateChoice> for DuplicatePolicy {
    fn from(c: DuplicateChoice) -> Self {
        match c {
            DuplicateChoice::Skip => DuplicatePolicy::Skip,
            DuplicateChoice::Copy => DuplicatePolicy::Copy,
            DuplicateChoice::Update => DuplicatePolicy::Update,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CredentialConflict {
    /// Never touch a secret that already exists (default).
    #[default]
    Keep,
    /// Overwrite existing secrets. Needs explicit confirmation.
    Replace,
    /// Restore no secrets for profiles that already exist.
    Skip,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    pub mode: RestoreMode,
    #[serde(default)]
    pub selected: Vec<usize>,
    pub duplicates: DuplicateChoice,
    #[serde(default)]
    pub update: Vec<usize>,
    #[serde(default)]
    pub restore_settings: bool,
    #[serde(default)]
    pub restore_credentials: bool,
    /// Restore the server notes of the backup (they are only ever added; existing
    /// notes are never overwritten).
    #[serde(default)]
    pub restore_notes: bool,
    #[serde(default)]
    pub credential_conflict: CredentialConflict,
    #[serde(default)]
    pub confirm_replace_credentials: bool,
    /// Required for [`RestoreMode::Replace`].
    #[serde(default)]
    pub confirm_replace_all: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialCounts {
    pub restored: usize,
    pub replaced: usize,
    pub kept_existing: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub created: usize,
    pub copied: usize,
    pub updated: usize,
    pub skipped: usize,
    /// Records in the backup that were invalid and therefore not restored.
    pub failed: usize,
    pub folders_created: usize,
    pub settings_restored: bool,
    pub credentials: CredentialCounts,
    /// A copy of the previous connections file was kept (Replace mode).
    pub safety_copy: bool,
    pub warnings: Vec<String>,
    /// What happened to the notes, when they were part of this run.
    pub notes: Option<NotesMergeResult>,
}

/// The local connection each incoming profile ended up as (created, copied,
/// updated, or the existing profile a skipped duplicate matched). `None` = the
/// profile did not take part (not selected, or no counterpart).
fn connection_targets(
    before: &ConnectionTree,
    set: &IncomingSet,
    outcomes: &[Outcome],
) -> Vec<Option<Uuid>> {
    set.connections
        .iter()
        .zip(outcomes)
        .map(|(c, outcome)| match outcome {
            Outcome::NotSelected => None,
            Outcome::SkippedDuplicate(_) | Outcome::SkippedChanged(_) => {
                match classify(before, c) {
                    Match::Duplicate(id) | Match::Changed(id) => Some(id),
                    Match::New => None,
                }
            }
            other => other.final_id(),
        })
        .collect()
}

/// `key` = the id a note uses for this profile inside the document.
fn notes_mapping(
    set: &IncomingSet,
    targets: &[Option<Uuid>],
    key: impl Fn(&super::profiles::IncomingConnection) -> Option<Uuid>,
) -> std::collections::HashMap<Uuid, Uuid> {
    set.connections
        .iter()
        .zip(targets)
        .filter_map(|(c, t)| Some((key(c)?, (*t)?)))
        .collect()
}

struct Written {
    account: String,
    previous: Option<Zeroizing<String>>,
}

/// Put credentials back as they were. Returns how many could not be reverted.
fn roll_back(stores: &Stores, written: &[Written]) -> usize {
    let mut failures = 0;
    for w in written.iter().rev() {
        let result = match &w.previous {
            Some(old) => stores
                .credentials
                .set(&w.account, &SecretString::new(old.to_string())),
            None => stores.credentials.delete(&w.account),
        };
        if result.is_err() {
            failures += 1;
        }
    }
    failures
}

/// A restore step failed after the previous state was (or was not) put back.
/// `which` selects the localized sentence (`restore.<which>Clean` / `Rollback`).
fn failure(which: &'static str, message: &str, rollback_failures: usize) -> AppError {
    let (clean, rolled) = match which {
        "connections" => ("restore.connectionsClean", "restore.connectionsRollback"),
        "settings" => ("restore.settingsClean", "restore.settingsRollback"),
        _ => ("restore.notesClean", "restore.notesRollback"),
    };
    if rollback_failures == 0 {
        AppError::storage_key(clean, format!("{message} Nothing was changed."))
    } else {
        AppError::storage_key(
            rolled,
            format!(
                "{message} {rollback_failures} saved password(s) could not be put back to their previous value; check your saved passwords."
            ),
        )
        .with_param("count", rollback_failures)
    }
}

fn validate_options(set: &IncomingSet, opts: &RestoreOptions) -> AppResult<()> {
    let n = set.connections.len();
    if opts.selected.iter().chain(&opts.update).any(|&i| i >= n) {
        return Err(AppError::validation_key(
            "portability.unknownProfile",
            "Unknown profile selected.",
        ));
    }
    if opts.mode == RestoreMode::Replace && !opts.confirm_replace_all {
        return Err(AppError::validation_key(
            "restore.confirmReplaceAll",
            "Replacing the existing configuration needs explicit confirmation. Nothing was changed.",
        ));
    }
    if opts.restore_credentials
        && opts.credential_conflict == CredentialConflict::Replace
        && !opts.confirm_replace_credentials
    {
        return Err(AppError::validation_key(
            "restore.confirmReplaceCredentials",
            "Replacing existing saved passwords needs explicit confirmation. Nothing was changed.",
        ));
    }
    Ok(())
}

/// Keep a copy of the connections file before it is replaced wholesale.
fn safety_copy(stores: &Stores, now: u64) -> bool {
    let path = stores.connections.path();
    if !path.exists() {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prefix = format!("{name}.pre-restore-");
    if std::fs::copy(path, parent.join(format!("{prefix}{}", now / 1000))).is_err() {
        return false;
    }
    let mut copies: Vec<_> = std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| e.path())
        .collect();
    copies.sort();
    while copies.len() > 3 {
        let _ = std::fs::remove_file(copies.remove(0));
    }
    true
}

/// Apply `backup` according to `opts`. See the module documentation.
pub fn commit(
    stores: &Stores,
    backup: &OpenedBackup,
    opts: &RestoreOptions,
    now: u64,
) -> AppResult<RestoreResult> {
    stores.lock.guard()?;
    let set = &backup.parsed.incoming;
    validate_options(set, opts)?;

    let old_tree = stores.connections.load()?;
    let old_settings = stores.settings.get()?;

    let wants_secrets = opts.restore_credentials && !backup.secrets.is_empty();
    if wants_secrets && !stores.credentials.status().available {
        return Err(AppError::Validation(
            "Secure credential storage is not available on this computer, so saved passwords cannot be restored. Nothing was changed. Restore again without saved passwords, or fix the credential store first."
                .into(),
        ));
    }

    // ---- 1. compute the new state (pure) ---------------------------------
    let selected: Option<HashSet<usize>> = match opts.mode {
        RestoreMode::Selected => Some(opts.selected.iter().copied().collect()),
        _ => None,
    };
    let update: HashSet<usize> = opts.update.iter().copied().collect();
    let replace = opts.mode == RestoreMode::Replace;
    let base = if replace {
        ConnectionTree::default()
    } else {
        old_tree.clone()
    };
    let merged = merge(
        &base,
        &MergeRequest {
            incoming: set,
            selected: selected.as_ref(),
            policy: if replace {
                DuplicatePolicy::Skip
            } else {
                opts.duplicates.into()
            },
            update: &update,
            preserve_ids: true,
            now,
        },
    )?;
    let mut new_tree = merged.tree;

    // In Replace mode a profile that keeps its id *and* its host/port/user
    // keeps the secret saved on this machine; anything else loses it (the
    // secret belonged to a different server).
    let mut orphaned: Vec<Uuid> = Vec::new();
    if replace {
        for old in old_tree.connections.iter().filter(|c| c.has_stored_secret) {
            match new_tree.connections.iter_mut().find(|c| c.id == old.id) {
                Some(kept)
                    if kept.host.eq_ignore_ascii_case(&old.host)
                        && kept.port == old.port
                        && kept.username == old.username =>
                {
                    kept.has_stored_secret = true;
                }
                _ => orphaned.push(old.id),
            }
        }
    }

    let mut result = RestoreResult {
        failed: backup.parsed.invalid.len(),
        folders_created: merged.folders_created,
        ..RestoreResult::default()
    };
    for outcome in &merged.outcomes {
        match outcome {
            Outcome::Created(_) => result.created += 1,
            Outcome::Copied(_) => result.copied += 1,
            Outcome::Updated(_) => result.updated += 1,
            Outcome::SkippedDuplicate(_) | Outcome::SkippedChanged(_) => result.skipped += 1,
            Outcome::NotSelected => {}
        }
    }

    // ---- 2. credentials ---------------------------------------------------
    let mut written: Vec<Written> = Vec::new();
    if opts.restore_credentials {
        for (index, outcome) in merged.outcomes.iter().enumerate() {
            let Some(final_id) = outcome.final_id() else {
                continue;
            };
            let Some(source) = set.connections[index].id_hint else {
                continue;
            };
            let Some(secret) = backup.secrets.get(&source) else {
                continue;
            };
            let Some(target) = new_tree.connections.iter().find(|c| c.id == final_id) else {
                continue;
            };
            if !target.save_password {
                result.credentials.skipped += 1;
                continue;
            }
            let existed_before = old_tree
                .connections
                .iter()
                .find(|c| c.id == final_id)
                .is_some_and(|c| c.has_stored_secret)
                || (replace && target.has_stored_secret);
            let is_existing_profile = matches!(outcome, Outcome::Updated(_));
            if is_existing_profile || replace {
                match (opts.credential_conflict, existed_before) {
                    (CredentialConflict::Skip, _) if is_existing_profile => {
                        result.credentials.skipped += 1;
                        continue;
                    }
                    (CredentialConflict::Keep, true) | (CredentialConflict::Skip, true) => {
                        result.credentials.kept_existing += 1;
                        continue;
                    }
                    _ => {}
                }
            }
            let account = connection_account(&final_id);
            let previous = match stores.credentials.get(&account) {
                Ok(p) => p.map(|s| Zeroizing::new(s.expose().to_owned())),
                Err(_) => {
                    result.credentials.failed += 1;
                    continue;
                }
            };
            match stores
                .credentials
                .set(&account, &SecretString::new(secret.to_string()))
            {
                Ok(()) => {
                    if previous.is_some() && existed_before {
                        result.credentials.replaced += 1;
                    } else {
                        result.credentials.restored += 1;
                    }
                    written.push(Written { account, previous });
                    if let Some(c) = new_tree.connections.iter_mut().find(|c| c.id == final_id) {
                        c.has_stored_secret = true;
                    }
                }
                Err(_) => result.credentials.failed += 1,
            }
        }
    }

    // ---- 3. connections.json ---------------------------------------------
    stores.lock.guard().inspect_err(|_| {
        roll_back(stores, &written);
    })?;
    if replace {
        result.safety_copy = safety_copy(stores, now);
        if !result.safety_copy && !old_tree.connections.is_empty() {
            result
                .warnings
                .push("A safety copy of the previous connections could not be made.".into());
        }
    }
    if new_tree != old_tree
        && let Err(e) = stores
            .connections
            .replace_if_unchanged(&old_tree, new_tree.clone())
    {
        let failures = roll_back(stores, &written);
        return Err(match e {
            e if e.is_validation() => e,
            _ => failure(
                "connections",
                "The connections could not be saved.",
                failures,
            ),
        });
    }

    // ---- 4. settings.json -------------------------------------------------
    if opts.restore_settings
        && let Some(portable) = &backup.settings
    {
        let wanted = portable.apply_to(old_settings.clone());
        if let Err(e) = stores.settings.save(wanted) {
            // Compensate: previous connections, previous secrets.
            let tree_reverted = new_tree == old_tree
                || stores
                    .connections
                    .replace_if_unchanged(&new_tree, old_tree)
                    .is_ok();
            let failures = roll_back(stores, &written);
            let msg = if tree_reverted {
                failure("settings", "The settings could not be saved.", failures)
            } else {
                AppError::storage_key(
                    "restore.settingsPartial",
                    "The settings could not be saved and the previous connections could not be fully restored. A copy of your previous connections is kept next to connections.json.",
                )
            };
            return Err(match e {
                e if e.is_validation() => e,
                _ => msg,
            });
        }
        result.settings_restored = true;
    }

    // ---- 4b. server notes (additive; the last step that can fail) ----------
    if opts.restore_notes
        && !backup.notes.is_empty()
        && let Some(notes) = stores.notes
    {
        let targets = connection_targets(&old_tree, set, &merged.outcomes);
        let mapping = notes_mapping(set, &targets, |c| c.id_hint);
        match notes.merge(&backup.notes, &mapping) {
            Ok(r) => result.notes = Some(r),
            Err(e) => {
                // Put everything back: settings, connections, saved passwords.
                if result.settings_restored {
                    let _ = stores.settings.save(old_settings);
                }
                let tree_reverted = new_tree == old_tree
                    || stores
                        .connections
                        .replace_if_unchanged(&new_tree, old_tree)
                        .is_ok();
                let failures = roll_back(stores, &written);
                return Err(match e {
                    e if e.is_validation() => e,
                    _ if tree_reverted => {
                        failure("notes", "The notes could not be restored.", failures)
                    }
                    _ => AppError::storage_key(
                        "restore.notesPartial",
                        "The notes could not be restored and the previous connections could not be fully put back. A copy of your previous connections is kept next to connections.json.",
                    ),
                });
            }
        }
    }
    // Replace mode removed connections: their notes stay as unattached notes, never deleted.
    if replace && let Some(notes) = stores.notes {
        for gone in old_tree
            .connections
            .iter()
            .filter(|c| !new_tree.connections.iter().any(|n| n.id == c.id))
        {
            let _ = notes.detach_connection(gone.id);
        }
    }

    // ---- 5. clean up secrets that no longer belong to anything ------------
    for id in orphaned {
        if stores.credentials.delete(&connection_account(&id)).is_err() {
            result
                .warnings
                .push("Some saved passwords of replaced connections could not be removed.".into());
            break;
        }
    }
    if result.credentials.failed > 0 {
        result.warnings.push(format!(
            "{} saved password(s) could not be restored; those profiles will ask for the password.",
            result.credentials.failed
        ));
    }
    Ok(result)
}

/// Apply a credential-free JSON import. No secret is read, written or removed.
pub fn commit_import(
    stores: &Stores,
    set: &IncomingSet,
    policy: DuplicatePolicy,
    update: &HashSet<usize>,
    now: u64,
    notes: &[PortableNote],
) -> AppResult<RestoreResult> {
    stores.lock.guard()?;
    let old = stores.connections.load()?;
    let merged = merge(
        &old,
        &MergeRequest {
            incoming: set,
            selected: None,
            policy,
            update,
            preserve_ids: false,
            now,
        },
    )?;
    let new_tree = merged.tree.clone();
    if new_tree != old {
        stores
            .connections
            .replace_if_unchanged(&old, new_tree.clone())?;
    }
    let mut result = RestoreResult {
        folders_created: merged.folders_created,
        ..RestoreResult::default()
    };
    if !notes.is_empty()
        && let Some(store) = stores.notes
    {
        let targets = connection_targets(&old, set, &merged.outcomes);
        let mapping = notes_mapping(set, &targets, |c| c.stable_hint);
        match store.merge(notes, &mapping) {
            Ok(r) => result.notes = Some(r),
            Err(e) => {
                let reverted = new_tree == old
                    || stores
                        .connections
                        .replace_if_unchanged(&new_tree, old)
                        .is_ok();
                return Err(match e {
                    e if e.is_validation() => e,
                    _ if reverted => AppError::storage_key(
                        "restore.notesImportClean",
                        "The notes could not be imported. Nothing was changed.",
                    ),
                    _ => AppError::storage_key(
                        "restore.notesImportPartial",
                        "The notes could not be imported and the previous connections could not be fully put back.",
                    ),
                });
            }
        }
    }
    for outcome in merged.outcomes {
        match outcome {
            Outcome::Created(_) => result.created += 1,
            Outcome::Copied(_) => result.copied += 1,
            Outcome::Updated(_) => result.updated += 1,
            Outcome::SkippedDuplicate(_) | Outcome::SkippedChanged(_) => result.skipped += 1,
            Outcome::NotSelected => {}
        }
    }
    Ok(result)
}
