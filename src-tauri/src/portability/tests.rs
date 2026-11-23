// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! End-to-end tests of the portability flows with fake stores. Every secret in
//! here is a made-up string; nothing touches a real credential store.

use super::*;
use crate::security::credentials::{CredentialStatus, connection_account};
use crate::storage::connections::{AuthMethod, Connection, ConnectionInput, FolderInput};
use restore::{CredentialConflict, RestoreMode};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const PASS: &str = "correct horse battery staple";
const SECRET_A: &str = "FAKE-PASSWORD-alpha-1";
const SECRET_B: &str = "FAKE-PASSPHRASE-bravo-2";
const SECRET_C: &str = "FAKE-PASSWORD-charlie-3";

/// A scriptable in-memory credential vault.
#[derive(Default)]
struct Vault {
    entries: Mutex<HashMap<String, String>>,
    unavailable: AtomicBool,
    fail_get: Mutex<HashSet<String>>,
    /// 1-based numbers of `set` calls that fail.
    fail_set_calls: Mutex<HashSet<usize>>,
    set_calls: AtomicUsize,
    get_calls: AtomicUsize,
    fail_delete: AtomicBool,
}

impl Vault {
    fn put(&self, account: &str, value: &str) {
        self.entries
            .lock()
            .unwrap()
            .insert(account.into(), value.into());
    }
    fn value(&self, account: &str) -> Option<String> {
        self.entries.lock().unwrap().get(account).cloned()
    }
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
    fn snapshot(&self) -> HashMap<String, String> {
        self.entries.lock().unwrap().clone()
    }
}

impl CredentialStore for Vault {
    fn status(&self) -> CredentialStatus {
        CredentialStatus {
            available: !self.unavailable.load(Ordering::SeqCst),
            backend: "test",
            detail: None,
        }
    }
    fn set(&self, account: &str, secret: &SecretString) -> AppResult<()> {
        let n = self.set_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(AppError::CredentialsUnavailable("test".into()));
        }
        if self.fail_set_calls.lock().unwrap().contains(&n) {
            return Err(AppError::Credentials("simulated write failure".into()));
        }
        self.put(account, secret.expose());
        Ok(())
    }
    fn get(&self, account: &str) -> AppResult<Option<SecretString>> {
        self.get_calls.fetch_add(1, Ordering::SeqCst);
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(AppError::CredentialsUnavailable("test".into()));
        }
        if self.fail_get.lock().unwrap().contains(account) {
            return Err(AppError::Credentials("simulated read failure".into()));
        }
        Ok(self.value(account).map(SecretString::new))
    }
    fn delete(&self, account: &str) -> AppResult<()> {
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(AppError::Credentials("simulated delete failure".into()));
        }
        self.entries.lock().unwrap().remove(account);
        Ok(())
    }
}

struct Env {
    dir: tempfile::TempDir,
    connections: ConnectionStore,
    settings: SettingsStore,
    vault: Vault,
    lock: LockFlag,
    service: PortabilityService,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        Self {
            connections: ConnectionStore::open(dir.path().join("connections.json")).unwrap(),
            settings: SettingsStore::open(dir.path().join("settings.json")).unwrap(),
            vault: Vault::default(),
            lock: LockFlag::default(),
            service: PortabilityService::new(KdfParams::MINIMUM),
            dir,
        }
    }
    fn stores(&self) -> Stores<'_> {
        Stores {
            connections: &self.connections,
            settings: &self.settings,
            credentials: &self.vault,
            lock: &self.lock,
        }
    }
    fn add(&self, name: &str, host: &str, user: &str) -> Connection {
        self.connections
            .save_connection(ConnectionInput {
                id: None,
                name: name.into(),
                host: host.into(),
                port: 22,
                username: user.into(),
                auth: AuthMethod::Password,
                key_path: None,
                save_password: true,
                timeout_secs: 15,
                initial_directory: None,
                folder_id: None,
            })
            .unwrap()
    }
    fn add_with_secret(&self, name: &str, host: &str, user: &str, secret: &str) -> Connection {
        let c = self.add(name, host, user);
        self.vault.put(&connection_account(&c.id), secret);
        self.connections.set_has_stored_secret(c.id, true).unwrap();
        self.connections.get(c.id).unwrap()
    }
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
    fn backup(&self, file: &str, credentials: bool) -> BackupSummary {
        let dest = self
            .service
            .choose_backup_destination(&self.stores(), &self.path(file))
            .unwrap();
        let pass = SecretString::new(PASS.into());
        self.service
            .create_backup(
                &self.stores(),
                dest.token,
                BackupOptions {
                    include_settings: true,
                    include_credentials: credentials,
                },
                &pass,
                &SecretString::new(PASS.into()),
            )
            .unwrap()
    }
    fn open_backup(&self, file: &str) -> RestorePreview {
        let info = self
            .service
            .stage_backup_file(&self.stores(), &self.path(file))
            .unwrap();
        self.service
            .unlock_backup(&self.stores(), info.token, &SecretString::new(PASS.into()))
            .unwrap()
    }
}

use std::path::PathBuf;

fn opts(mode: RestoreMode) -> RestoreOptions {
    RestoreOptions {
        mode,
        selected: vec![],
        duplicates: DuplicateChoice::Skip,
        update: vec![],
        restore_settings: false,
        restore_credentials: false,
        credential_conflict: CredentialConflict::Keep,
        confirm_replace_credentials: false,
        confirm_replace_all: false,
    }
}

fn names(env: &Env) -> Vec<String> {
    let mut v: Vec<String> = env
        .connections
        .load()
        .unwrap()
        .connections
        .iter()
        .map(|c| c.name.clone())
        .collect();
    v.sort();
    v
}

// ---- connection export / import ------------------------------------------------

#[test]
fn export_file_contains_no_secrets_and_import_preview_changes_nothing() {
    let a = Env::new();
    let c = a.add_with_secret("Prod", "10.0.0.5", "root", SECRET_A);
    let file = a.path("out.json");
    let out = a
        .service
        .write_connections_export(&a.stores(), &file, None, false)
        .unwrap();
    assert_eq!(out.connections, 1);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(!text.contains(SECRET_A));
    assert!(!text.contains(&c.id.to_string()));

    let b = Env::new();
    b.add_with_secret("Mine", "other.example.org", "me", SECRET_B);
    let before_tree = b.connections.load().unwrap();
    let before_vault = b.vault.snapshot();
    let preview = b.service.stage_import(&b.stores(), &file).unwrap();
    assert_eq!(
        (
            preview.connection_count,
            preview.new_count,
            preview.duplicate_count
        ),
        (1, 1, 0)
    );
    assert_eq!(
        b.connections.load().unwrap(),
        before_tree,
        "selecting a file never modifies data"
    );
    assert_eq!(b.vault.snapshot(), before_vault);
}

#[test]
fn import_is_credentials_free_and_leaves_existing_secrets_alone() {
    let a = Env::new();
    a.add_with_secret("Prod", "10.0.0.5", "root", SECRET_A);
    let file = a.path("out.json");
    a.service
        .write_connections_export(&a.stores(), &file, None, false)
        .unwrap();

    // Same machine re-import of the same file: a duplicate, skipped.
    let preview = a.service.stage_import(&a.stores(), &file).unwrap();
    assert_eq!(preview.duplicate_count, 1);
    let before = a.vault.snapshot();
    let result = a
        .service
        .apply_import(&a.stores(), preview.token, DuplicateChoice::Skip, &[])
        .unwrap();
    assert_eq!((result.created, result.skipped), (0, 1));
    assert_eq!(a.vault.snapshot(), before);
    assert_eq!(a.vault.set_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        a.vault.get_calls.load(Ordering::SeqCst),
        0,
        "an import never reads secrets"
    );

    // As copy: a new profile without any secret.
    let preview = a.service.stage_import(&a.stores(), &file).unwrap();
    let result = a
        .service
        .apply_import(&a.stores(), preview.token, DuplicateChoice::Copy, &[])
        .unwrap();
    assert_eq!(result.copied, 1);
    let tree = a.connections.load().unwrap();
    assert_eq!(tree.connections.len(), 2);
    assert_eq!(
        tree.connections
            .iter()
            .filter(|c| c.has_stored_secret)
            .count(),
        1
    );
    assert_eq!(a.vault.snapshot(), before);
}

#[test]
fn import_tokens_are_single_use_and_cancel_works() {
    let a = Env::new();
    let file = a.path("x.json");
    std::fs::write(&file, br#"{"format":"peachterm-connections","formatVersion":1,"connections":[{"name":"n","host":"h"}]}"#).unwrap();
    let p = a.service.stage_import(&a.stores(), &file).unwrap();
    a.service.cancel(p.token);
    assert!(
        a.service
            .apply_import(&a.stores(), p.token, DuplicateChoice::Skip, &[])
            .is_err()
    );
    assert!(names(&a).is_empty(), "cancelled import changed nothing");
    let p = a.service.stage_import(&a.stores(), &file).unwrap();
    a.service
        .apply_import(&a.stores(), p.token, DuplicateChoice::Skip, &[])
        .unwrap();
    assert!(
        a.service
            .apply_import(&a.stores(), p.token, DuplicateChoice::Skip, &[])
            .is_err()
    );
    assert_eq!(names(&a), ["n"]);
}

#[test]
fn oversized_and_invalid_files_are_refused_before_parsing() {
    let a = Env::new();
    let big = a.path("big.json");
    std::fs::write(&big, vec![b' '; (profiles::MAX_IMPORT_BYTES + 1) as usize]).unwrap();
    assert!(a.service.stage_import(&a.stores(), &big).is_err());
    let bad = a.path("bad.json");
    std::fs::write(&bad, b"{ nope").unwrap();
    assert!(a.service.stage_import(&a.stores(), &bad).is_err());
    assert!(
        a.service.stage_import(&a.stores(), a.dir.path()).is_err(),
        "a folder is not a file"
    );
}

#[test]
fn failed_import_persistence_changes_nothing_and_can_be_retried() {
    let a = Env::new();
    a.add("keep", "k.example.org", "u");
    let file = a.path("x.json");
    std::fs::write(&file, br#"{"format":"peachterm-connections","formatVersion":1,"connections":[{"name":"n","host":"h"}]}"#).unwrap();
    let p = a.service.stage_import(&a.stores(), &file).unwrap();
    // Break persistence: connections.json becomes a directory.
    let cj = a.path("connections.json");
    let saved = std::fs::read(&cj).unwrap();
    std::fs::remove_file(&cj).unwrap();
    std::fs::create_dir(&cj).unwrap();
    assert!(
        a.service
            .apply_import(&a.stores(), p.token, DuplicateChoice::Skip, &[])
            .is_err()
    );
    assert_eq!(
        names(&a),
        ["keep"],
        "memory still matches the last good state"
    );
    std::fs::remove_dir(&cj).unwrap();
    std::fs::write(&cj, saved).unwrap();
    // The staged import survived the failure.
    a.service
        .apply_import(&a.stores(), p.token, DuplicateChoice::Skip, &[])
        .unwrap();
    assert_eq!(names(&a), ["keep", "n"]);
}

#[test]
fn update_import_changes_selected_profiles_only() {
    let a = Env::new();
    let c = a.add_with_secret("Old name", "h.example.org", "u", SECRET_A);
    let file = a.path("x.json");
    std::fs::write(&file, br#"{"format":"peachterm-connections","formatVersion":1,"connections":[{"name":"New name","host":"h.example.org","username":"u","timeoutSecs":77}]}"#).unwrap();
    let p = a.service.stage_import(&a.stores(), &file).unwrap();
    assert_eq!(p.duplicate_count, 1);
    let r = a
        .service
        .apply_import(&a.stores(), p.token, DuplicateChoice::Update, &[0])
        .unwrap();
    assert_eq!(r.updated, 1);
    let now = a.connections.get(c.id).unwrap();
    assert_eq!((now.name.as_str(), now.timeout_secs), ("New name", 77));
    assert!(now.has_stored_secret);
    assert_eq!(
        a.vault.value(&connection_account(&c.id)).as_deref(),
        Some(SECRET_A)
    );
}

// ---- encrypted backup: create ---------------------------------------------------

#[test]
fn backup_round_trip_restores_connections_folders_settings_and_credentials_on_another_machine() {
    let a = Env::new();
    let folder = a
        .connections
        .save_folder(FolderInput {
            id: None,
            name: "Продакшен".into(),
            parent_id: None,
            expanded: true,
        })
        .unwrap();
    let mut input = ConnectionInput {
        id: None,
        name: "Сервер".into(),
        host: "2001:db8::7".into(),
        port: 2200,
        username: "админ".into(),
        auth: AuthMethod::Password,
        key_path: None,
        save_password: true,
        timeout_secs: 20,
        initial_directory: Some("/srv".into()),
        folder_id: Some(folder.id),
    };
    let c1 = a.connections.save_connection(input.clone()).unwrap();
    input.name = "Второй".into();
    input.host = "b.example.org".into();
    let c2 = a.connections.save_connection(input).unwrap();
    for (c, s) in [(&c1, SECRET_A), (&c2, SECRET_B)] {
        a.vault.put(&connection_account(&c.id), s);
        a.connections.set_has_stored_secret(c.id, true).unwrap();
    }
    let mut s = a.settings.get().unwrap();
    s.appearance.terminal_font_size = 19;
    s.editor.program = Some("/usr/bin/evil".into());
    s.terminal.start_dir = Some("/home/a".into());
    a.settings.save(s).unwrap();

    let summary = a.backup("b.peachbackup", true);
    assert_eq!(
        (
            summary.connections,
            summary.folders,
            summary.credentials_included,
            summary.credentials_skipped
        ),
        (2, 1, 2, 0)
    );
    assert!(summary.verified);
    assert_eq!(summary.format_version, 1);
    let bytes = std::fs::read(a.path("b.peachbackup")).unwrap();
    for needle in [
        SECRET_A,
        SECRET_B,
        "Сервер",
        "2001:db8",
        "админ",
        "Продакшен",
    ] {
        assert!(
            !bytes.windows(needle.len()).any(|w| w == needle.as_bytes()),
            "{needle} visible in the backup file"
        );
    }

    // A different machine with an empty vault.
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let preview = b.open_backup("b.peachbackup");
    assert_eq!(
        (
            preview.connection_count,
            preview.folder_count,
            preview.credential_count
        ),
        (2, 1, 2)
    );
    assert!(preview.settings_included);
    let mut o = opts(RestoreMode::Merge);
    o.restore_settings = true;
    o.restore_credentials = true;
    let r = b
        .service
        .restore_backup(&b.stores(), preview.token, &o)
        .unwrap();
    assert_eq!(
        (r.created, r.credentials.restored, r.credentials.failed),
        (2, 2, 0)
    );
    assert!(r.settings_restored);

    let tree = b.connections.load().unwrap();
    assert_eq!(tree.folders.len(), 1);
    let restored = tree
        .connections
        .iter()
        .find(|c| c.name == "Сервер")
        .unwrap();
    assert_eq!(
        (
            restored.host.as_str(),
            restored.port,
            restored.username.as_str()
        ),
        ("2001:db8::7", 2200, "админ")
    );
    assert_eq!(restored.initial_directory.as_deref(), Some("/srv"));
    assert!(restored.has_stored_secret);
    assert_eq!(
        b.vault.value(&connection_account(&restored.id)).as_deref(),
        Some(SECRET_A)
    );
    assert_eq!(b.vault.len(), 2);
    let s = b.settings.get().unwrap();
    assert_eq!(s.appearance.terminal_font_size, 19);
    assert_eq!(
        s.editor.program, None,
        "executable settings are never carried by a backup"
    );
    assert_eq!(s.terminal.start_dir, None);
}

#[test]
fn backup_without_credentials_contains_none_and_never_reads_the_vault() {
    let a = Env::new();
    a.add_with_secret("x", "h", "u", SECRET_A);
    let summary = a.backup("b.peachbackup", false);
    assert_eq!(
        (
            summary.credentials_requested,
            summary.credentials_included,
            summary.credentials_skipped
        ),
        (false, 0, 0)
    );
    assert_eq!(a.vault.get_calls.load(Ordering::SeqCst), 0);
    let preview = a.open_backup("b.peachbackup");
    assert_eq!(preview.credential_count, 0);
}

#[test]
fn unreadable_credentials_are_reported_as_skipped_not_hidden() {
    let a = Env::new();
    let c1 = a.add_with_secret("one", "h1", "u", SECRET_A);
    a.add_with_secret("two", "h2", "u", SECRET_B);
    let stale = a.add("stale", "h3", "u");
    a.connections.set_has_stored_secret(stale.id, true).unwrap(); // flagged, but not in the vault
    a.vault
        .fail_get
        .lock()
        .unwrap()
        .insert(connection_account(&c1.id));
    let s = a.backup("b.peachbackup", true);
    assert_eq!(
        (
            s.credentials_included,
            s.credentials_skipped,
            s.credentials_unreadable
        ),
        (1, 2, 1)
    );
}

#[test]
fn unavailable_credential_store_skips_everything_loudly() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    a.vault.unavailable.store(true, Ordering::SeqCst);
    let s = a.backup("b.peachbackup", true);
    assert_eq!(
        (
            s.credentials_included,
            s.credentials_skipped,
            s.credentials_unreadable
        ),
        (0, 1, 1)
    );
}

#[test]
fn passphrase_rules_are_enforced_in_rust() {
    let a = Env::new();
    a.add("x", "h", "u");
    let dest = a
        .service
        .choose_backup_destination(&a.stores(), &a.path("b.peachbackup"))
        .unwrap();
    let opt = BackupOptions {
        include_settings: true,
        include_credentials: false,
    };
    let short = SecretString::new("short".into());
    assert!(
        a.service
            .create_backup(
                &a.stores(),
                dest.token,
                opt,
                &short,
                &SecretString::new("short".into())
            )
            .is_err()
    );
    let good = SecretString::new(PASS.into());
    assert!(
        a.service
            .create_backup(
                &a.stores(),
                dest.token,
                opt,
                &good,
                &SecretString::new("different passphrase!".into())
            )
            .is_err()
    );
    assert!(!a.path("b.peachbackup").exists());
    // The destination survived the failed attempts.
    a.service
        .create_backup(
            &a.stores(),
            dest.token,
            opt,
            &good,
            &SecretString::new(PASS.into()),
        )
        .unwrap();
    assert!(a.path("b.peachbackup").exists());
}

#[test]
fn failed_backup_write_leaves_no_files_behind() {
    let a = Env::new();
    a.add("x", "h", "u");
    let dest = a
        .service
        .choose_backup_destination(&a.stores(), &a.path("no-such-dir/b.peachbackup"))
        .unwrap();
    let good = SecretString::new(PASS.into());
    let r = a.service.create_backup(
        &a.stores(),
        dest.token,
        BackupOptions {
            include_settings: true,
            include_credentials: false,
        },
        &good,
        &SecretString::new(PASS.into()),
    );
    assert!(r.is_err());
    let leftovers: Vec<_> = std::fs::read_dir(a.dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        leftovers
            .iter()
            .all(|n| n == "connections.json" || n == "settings.json"),
        "{leftovers:?}"
    );
}

#[test]
fn backup_destination_gets_the_right_extension() {
    let a = Env::new();
    let d = a
        .service
        .choose_backup_destination(&a.stores(), &a.path("mybackup"))
        .unwrap();
    assert!(d.path.ends_with("mybackup.peachbackup"));
}

// ---- restore -------------------------------------------------------------------

#[test]
fn wrong_passphrase_corruption_and_garbage_never_change_state() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);
    let tree = a.connections.load().unwrap();
    let vault = a.vault.snapshot();

    let info = a
        .service
        .stage_backup_file(&a.stores(), &a.path("b.peachbackup"))
        .unwrap();
    let err = a
        .service
        .unlock_backup(
            &a.stores(),
            info.token,
            &SecretString::new("not the passphrase".into()),
        )
        .unwrap_err();
    assert!(err.to_string().contains("passphrase is wrong"));
    assert!(
        !err.to_string().to_lowercase().contains("argon"),
        "no implementation details"
    );
    // The file stays staged, so the user can simply try again.
    a.service
        .unlock_backup(&a.stores(), info.token, &SecretString::new(PASS.into()))
        .unwrap();

    let mut bytes = std::fs::read(a.path("b.peachbackup")).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    std::fs::write(a.path("bad.peachbackup"), &bytes).unwrap();
    let info = a
        .service
        .stage_backup_file(&a.stores(), &a.path("bad.peachbackup"))
        .unwrap();
    assert!(
        a.service
            .unlock_backup(&a.stores(), info.token, &SecretString::new(PASS.into()))
            .is_err()
    );

    std::fs::write(a.path("trunc.peachbackup"), &bytes[..bytes.len() / 2]).unwrap();
    // A truncated file is recognised from its header alone, before any passphrase.
    assert!(
        a.service
            .stage_backup_file(&a.stores(), &a.path("trunc.peachbackup"))
            .is_err()
    );

    std::fs::write(a.path("junk.peachbackup"), b"definitely not a backup").unwrap();
    assert!(
        a.service
            .stage_backup_file(&a.stores(), &a.path("junk.peachbackup"))
            .is_err()
    );

    assert_eq!(a.connections.load().unwrap(), tree);
    assert_eq!(a.vault.snapshot(), vault);
}

#[test]
fn too_many_wrong_attempts_drop_the_staged_file() {
    let a = Env::new();
    a.add("one", "h1", "u");
    a.backup("b.peachbackup", false);
    let info = a
        .service
        .stage_backup_file(&a.stores(), &a.path("b.peachbackup"))
        .unwrap();
    for _ in 0..staging::MAX_UNLOCK_ATTEMPTS {
        assert!(
            a.service
                .unlock_backup(
                    &a.stores(),
                    info.token,
                    &SecretString::new("wrong wrong wrong".into())
                )
                .is_err()
        );
    }
    let err = a
        .service
        .unlock_backup(&a.stores(), info.token, &SecretString::new(PASS.into()))
        .unwrap_err();
    assert!(err.to_string().contains("expired"));
}

#[test]
fn merge_keeps_existing_profiles_and_secrets_by_default() {
    let a = Env::new();
    let c = a.add_with_secret("Mine", "h1", "u", SECRET_A);
    a.add_with_secret("Other", "h2", "u", SECRET_B);
    a.backup("b.peachbackup", true);

    // Machine B already has h1/u with a different password, and a profile "Extra".
    let b = Env::new();
    let existing = b.add_with_secret("Local name", "h1", "u", SECRET_C);
    b.add("Extra", "h9", "u");
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    assert_eq!((p.new_count, p.duplicate_count), (1, 1));
    let mut o = opts(RestoreMode::Merge);
    o.restore_credentials = true;
    let r = b.service.restore_backup(&b.stores(), p.token, &o).unwrap();
    assert_eq!((r.created, r.skipped), (1, 1));
    assert_eq!(
        b.vault.value(&connection_account(&existing.id)).as_deref(),
        Some(SECRET_C),
        "existing password untouched"
    );
    assert_eq!(names(&b), ["Extra", "Local name", "Other"]);
    let _ = c;
}

#[test]
fn credential_conflicts_follow_the_chosen_policy() {
    let a = Env::new();
    a.add_with_secret("Mine", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);

    let run = |conflict: CredentialConflict,
               confirm: bool|
     -> (AppResult<RestoreResult>, Option<String>, Env) {
        let b = Env::new();
        let existing = b.add_with_secret("Local", "h1", "u", SECRET_C);
        std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
        let p = b.open_backup("b.peachbackup");
        let mut o = opts(RestoreMode::Merge);
        o.duplicates = DuplicateChoice::Update;
        o.update = vec![0];
        o.restore_credentials = true;
        o.credential_conflict = conflict;
        o.confirm_replace_credentials = confirm;
        let r = b.service.restore_backup(&b.stores(), p.token, &o);
        let v = b.vault.value(&connection_account(&existing.id));
        (r, v, b)
    };
    let (r, v, _) = run(CredentialConflict::Keep, false);
    assert_eq!(
        (r.unwrap().credentials.kept_existing, v.as_deref()),
        (1, Some(SECRET_C))
    );
    let (r, v, _) = run(CredentialConflict::Skip, false);
    assert_eq!(
        (r.unwrap().credentials.skipped, v.as_deref()),
        (1, Some(SECRET_C))
    );
    let (r, v, _) = run(CredentialConflict::Replace, false);
    assert!(r.is_err(), "replacing needs explicit confirmation");
    assert_eq!(v.as_deref(), Some(SECRET_C));
    let (r, v, _) = run(CredentialConflict::Replace, true);
    assert_eq!(
        (r.unwrap().credentials.replaced, v.as_deref()),
        (1, Some(SECRET_A))
    );
}

#[test]
fn credentials_are_not_restored_unless_asked() {
    let a = Env::new();
    a.add_with_secret("Mine", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    let r = b
        .service
        .restore_backup(&b.stores(), p.token, &opts(RestoreMode::Merge))
        .unwrap();
    assert_eq!(r.created, 1);
    assert_eq!(b.vault.len(), 0);
    assert_eq!(b.vault.set_calls.load(Ordering::SeqCst), 0);
    assert!(
        b.connections
            .load()
            .unwrap()
            .connections
            .iter()
            .all(|c| !c.has_stored_secret)
    );
}

#[test]
fn unavailable_vault_refuses_credential_restore_without_plaintext_fallback_or_changes() {
    let a = Env::new();
    a.add_with_secret("Mine", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    assert!(p.credential_store_available);
    b.vault.unavailable.store(true, Ordering::SeqCst);
    let mut o = opts(RestoreMode::Merge);
    o.restore_credentials = true;
    let err = b
        .service
        .restore_backup(&b.stores(), p.token, &o)
        .unwrap_err();
    assert!(err.to_string().contains("not available"));
    assert!(b.connections.load().unwrap().connections.is_empty());
    for f in std::fs::read_dir(b.dir.path()).unwrap().flatten() {
        if let Ok(text) = std::fs::read_to_string(f.path()) {
            assert!(
                !text.contains(SECRET_A),
                "secret must never reach a plain file"
            );
        }
    }
    // Without credentials the same staged backup still restores.
    b.vault.unavailable.store(false, Ordering::SeqCst);
    b.service
        .restore_backup(&b.stores(), p.token, &opts(RestoreMode::Merge))
        .unwrap();
}

#[test]
fn a_failing_credential_write_is_counted_and_the_profile_still_restores() {
    let a = Env::new();
    for (i, s) in [SECRET_A, SECRET_B, SECRET_C].iter().enumerate() {
        a.add_with_secret(&format!("c{i}"), &format!("h{i}"), "u", s);
    }
    a.backup("b.peachbackup", true);
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    b.vault.fail_set_calls.lock().unwrap().insert(2);
    let p = b.open_backup("b.peachbackup");
    let mut o = opts(RestoreMode::Merge);
    o.restore_credentials = true;
    let r = b.service.restore_backup(&b.stores(), p.token, &o).unwrap();
    assert_eq!(
        (r.created, r.credentials.restored, r.credentials.failed),
        (3, 2, 1)
    );
    assert!(!r.warnings.is_empty());
    let tree = b.connections.load().unwrap();
    assert_eq!(
        tree.connections
            .iter()
            .filter(|c| c.has_stored_secret)
            .count(),
        2,
        "flags match reality"
    );
    for c in &tree.connections {
        assert_eq!(
            c.has_stored_secret,
            b.vault.value(&connection_account(&c.id)).is_some()
        );
    }
}

#[test]
fn failed_connection_save_rolls_every_credential_back() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    a.add_with_secret("two", "h2", "u", SECRET_B);
    a.backup("b.peachbackup", true);

    let b = Env::new();
    b.add("local", "local", "u");
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    // connections.json can no longer be replaced.
    let cj = b.path("connections.json");
    std::fs::remove_file(&cj).unwrap();
    std::fs::create_dir(&cj).unwrap();
    let mut o = opts(RestoreMode::Merge);
    o.restore_credentials = true;
    let err = b
        .service
        .restore_backup(&b.stores(), p.token, &o)
        .unwrap_err();
    assert!(err.to_string().contains("Nothing was changed"), "{err}");
    assert_eq!(
        b.vault.len(),
        0,
        "credentials written before the failure were removed again"
    );
    assert_eq!(names(&b), ["local"]);
}

#[test]
fn failed_settings_save_restores_connections_and_credentials() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);
    let b = Env::new();
    b.add("local", "local", "u");
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    let before = b.connections.load().unwrap();
    let sj = b.path("settings.json");
    let _ = std::fs::remove_file(&sj);
    std::fs::create_dir(&sj).unwrap();
    let mut o = opts(RestoreMode::Merge);
    o.restore_credentials = true;
    o.restore_settings = true;
    assert!(b.service.restore_backup(&b.stores(), p.token, &o).is_err());
    assert_eq!(
        b.connections.load().unwrap(),
        before,
        "connections rolled back"
    );
    assert_eq!(b.vault.len(), 0, "credentials rolled back");
}

#[test]
fn rollback_restores_overwritten_secrets_to_their_previous_value() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);
    let b = Env::new();
    let local = b.add_with_secret("Local", "h1", "u", SECRET_C);
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    let cj = b.path("connections.json");
    // Update changes the tree, so persisting must fail.
    std::fs::remove_file(&cj).unwrap();
    std::fs::create_dir(&cj).unwrap();
    let mut o = opts(RestoreMode::Merge);
    o.duplicates = DuplicateChoice::Update;
    o.update = vec![0];
    o.restore_credentials = true;
    o.credential_conflict = CredentialConflict::Replace;
    o.confirm_replace_credentials = true;
    assert!(b.service.restore_backup(&b.stores(), p.token, &o).is_err());
    assert_eq!(
        b.vault.value(&connection_account(&local.id)).as_deref(),
        Some(SECRET_C)
    );
}

#[test]
fn replace_requires_confirmation_and_swaps_the_configuration() {
    let a = Env::new();
    a.add_with_secret("from backup", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);

    let b = Env::new();
    let old = b.add_with_secret("old", "old.example.org", "u", SECRET_C);
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");

    assert!(
        b.service
            .restore_backup(&b.stores(), p.token, &opts(RestoreMode::Replace))
            .is_err()
    );
    assert_eq!(names(&b), ["old"], "unconfirmed replace changes nothing");

    let mut o = opts(RestoreMode::Replace);
    o.confirm_replace_all = true;
    let r = b.service.restore_backup(&b.stores(), p.token, &o).unwrap();
    assert_eq!(r.created, 1);
    assert!(r.safety_copy);
    assert_eq!(names(&b), ["from backup"]);
    assert_eq!(
        b.vault.value(&connection_account(&old.id)),
        None,
        "secret of a removed connection is removed too"
    );
    let kept: Vec<_> = std::fs::read_dir(b.dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains("pre-restore"))
        .collect();
    assert_eq!(kept.len(), 1);
}

#[test]
fn replace_never_hands_a_local_secret_to_a_different_server() {
    // Same connection id, but the backup points at another host.
    let a = Env::new();
    let c = a.add_with_secret("srv", "trusted.example.org", "u", SECRET_A);
    a.backup("b.peachbackup", false);
    let bytes = std::fs::read(a.path("b.peachbackup")).unwrap();

    let b = Env::new();
    // Machine B has the *same id* but a different host with its own secret.
    let tree = crate::storage::connections::ConnectionTree {
        connections: vec![Connection {
            host: "other.example.org".into(),
            has_stored_secret: true,
            ..c.clone()
        }],
        ..Default::default()
    };
    b.connections
        .replace_if_unchanged(&b.connections.load().unwrap(), tree)
        .unwrap();
    b.vault.put(&connection_account(&c.id), SECRET_B);
    std::fs::write(b.path("b.peachbackup"), bytes).unwrap();
    let p = b.open_backup("b.peachbackup");
    let mut o = opts(RestoreMode::Replace);
    o.confirm_replace_all = true;
    b.service.restore_backup(&b.stores(), p.token, &o).unwrap();
    let now = b.connections.get(c.id).unwrap();
    assert_eq!(now.host, "trusted.example.org");
    assert!(
        !now.has_stored_secret,
        "the secret belonged to another server"
    );
    assert_eq!(b.vault.value(&connection_account(&c.id)), None);
}

#[test]
fn restoring_selected_profiles_only() {
    let a = Env::new();
    for i in 0..4 {
        a.add(&format!("c{i}"), &format!("h{i}"), "u");
    }
    a.backup("b.peachbackup", false);
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    let pick: Vec<usize> = p
        .items
        .iter()
        .filter(|i| i.name == "c1" || i.name == "c3")
        .map(|i| i.index)
        .collect();
    let mut o = opts(RestoreMode::Selected);
    o.selected = pick;
    let r = b.service.restore_backup(&b.stores(), p.token, &o).unwrap();
    assert_eq!(r.created, 2);
    assert_eq!(names(&b), ["c1", "c3"]);
}

#[test]
fn cancelled_restore_changes_nothing_and_drops_decrypted_data() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    b.service.cancel(p.token);
    assert!(
        b.service
            .restore_backup(&b.stores(), p.token, &opts(RestoreMode::Merge))
            .is_err()
    );
    assert!(b.connections.load().unwrap().connections.is_empty());
    assert_eq!(b.vault.len(), 0);
}

#[test]
fn the_same_backup_cannot_be_applied_twice() {
    let a = Env::new();
    a.add("one", "h1", "u");
    a.backup("b.peachbackup", false);
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    b.service
        .restore_backup(&b.stores(), p.token, &opts(RestoreMode::Merge))
        .unwrap();
    assert!(
        b.service
            .restore_backup(&b.stores(), p.token, &opts(RestoreMode::Merge))
            .is_err()
    );
}

#[test]
fn restored_settings_are_validated_like_any_other_settings() {
    let a = Env::new();
    a.add("one", "h1", "u");
    a.backup("b.peachbackup", false);
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p = b.open_backup("b.peachbackup");
    let mut o = opts(RestoreMode::Merge);
    o.restore_settings = true;
    let r = b.service.restore_backup(&b.stores(), p.token, &o).unwrap();
    assert!(r.settings_restored);
    assert_eq!(
        b.settings.get().unwrap().security,
        a.settings.get().unwrap().security
    );
}

// ---- Application Lock -----------------------------------------------------------

#[test]
fn every_operation_is_refused_while_locked_and_does_nothing() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    a.backup("b.peachbackup", true);
    let export = a.path("e.json");
    a.service
        .write_connections_export(&a.stores(), &export, None, false)
        .unwrap();

    // Stage real operations first, then lock.
    let import = a.service.stage_import(&a.stores(), &export).unwrap();
    let info = a
        .service
        .stage_backup_file(&a.stores(), &a.path("b.peachbackup"))
        .unwrap();
    let opened = a.open_backup("b.peachbackup");
    let dest = a
        .service
        .choose_backup_destination(&a.stores(), &a.path("new.peachbackup"))
        .unwrap();
    let tree = a.connections.load().unwrap();
    let vault = a.vault.snapshot();
    let gets = a.vault.get_calls.load(Ordering::SeqCst);
    let sets = a.vault.set_calls.load(Ordering::SeqCst);

    a.lock.set(true);
    let locked = |e: AppError| assert_eq!(e.code(), "locked", "{e}");
    locked(
        a.service
            .write_connections_export(&a.stores(), &a.path("e2.json"), None, false)
            .unwrap_err(),
    );
    locked(a.service.stage_import(&a.stores(), &export).unwrap_err());
    locked(
        a.service
            .apply_import(&a.stores(), import.token, DuplicateChoice::Copy, &[])
            .unwrap_err(),
    );
    locked(
        a.service
            .choose_backup_destination(&a.stores(), &a.path("n.peachbackup"))
            .unwrap_err(),
    );
    let good = SecretString::new(PASS.into());
    locked(
        a.service
            .create_backup(
                &a.stores(),
                dest.token,
                BackupOptions {
                    include_settings: true,
                    include_credentials: true,
                },
                &good,
                &SecretString::new(PASS.into()),
            )
            .unwrap_err(),
    );
    locked(
        a.service
            .stage_backup_file(&a.stores(), &a.path("b.peachbackup"))
            .unwrap_err(),
    );
    locked(
        a.service
            .unlock_backup(&a.stores(), info.token, &good)
            .unwrap_err(),
    );
    let mut o = opts(RestoreMode::Merge);
    o.restore_credentials = true;
    locked(
        a.service
            .restore_backup(&a.stores(), opened.token, &o)
            .unwrap_err(),
    );

    assert!(
        !a.path("e2.json").exists()
            && !a.path("new.peachbackup").exists()
            && !a.path("n.peachbackup").exists()
    );
    assert_eq!(a.connections.load().unwrap(), tree);
    assert_eq!(a.vault.snapshot(), vault);
    assert_eq!(
        a.vault.get_calls.load(Ordering::SeqCst),
        gets,
        "no credential was read while locked"
    );
    assert_eq!(a.vault.set_calls.load(Ordering::SeqCst), sets);

    // Unlocking does not resurrect staged operations: they must be restarted.
    a.lock.set(false);
    assert!(
        a.service
            .restore_backup(&a.stores(), opened.token, &o)
            .is_err()
    );
}

#[test]
fn locking_during_an_operation_stops_it_before_anything_is_written() {
    let a = Env::new();
    a.add("one", "h1", "u");
    let dest = a
        .service
        .choose_backup_destination(&a.stores(), &a.path("n.peachbackup"))
        .unwrap();
    a.lock.set(true);
    let good = SecretString::new(PASS.into());
    assert!(
        a.service
            .create_backup(
                &a.stores(),
                dest.token,
                BackupOptions {
                    include_settings: true,
                    include_credentials: false
                },
                &good,
                &SecretString::new(PASS.into())
            )
            .is_err()
    );
    assert!(!a.path("n.peachbackup").exists());
}

// ---- no leakage -------------------------------------------------------------------

#[test]
fn nothing_sent_to_the_renderer_contains_a_secret() {
    let a = Env::new();
    a.add_with_secret("one", "h1", "u", SECRET_A);
    let summary = a.backup("b.peachbackup", true);
    let preview = a.open_backup("b.peachbackup");
    let mut o = opts(RestoreMode::Merge);
    o.restore_credentials = true;
    let b = Env::new();
    std::fs::copy(a.path("b.peachbackup"), b.path("b.peachbackup")).unwrap();
    let p2 = b.open_backup("b.peachbackup");
    let result = b.service.restore_backup(&b.stores(), p2.token, &o).unwrap();
    for json in [
        serde_json::to_string(&summary).unwrap(),
        serde_json::to_string(&preview).unwrap(),
        serde_json::to_string(&p2).unwrap(),
        serde_json::to_string(&result).unwrap(),
        format!("{result:?}"),
        format!("{summary:?}"),
    ] {
        assert!(!json.contains(SECRET_A), "secret leaked: {json}");
    }
}

#[test]
fn backup_credential_debug_output_is_redacted() {
    let c = backup::BackupCredential {
        connection_id: Uuid::nil(),
        secret: zeroize::Zeroizing::new(SECRET_A.into()),
    };
    assert!(!format!("{c:?}").contains(SECRET_A));
}
