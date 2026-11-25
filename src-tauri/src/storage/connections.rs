// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Saved connections and folders.
//!
//! The document holds metadata only. Passwords live in the OS credential store
//! (see `security::credentials`); `has_stored_secret` merely records that one
//! was saved so the sidebar does not query the keychain for every entry.

use super::atomic::{
    ConfigIssue, backup_before_migration, ensure_backup, load_json_value, parse_entries, save_json,
};
use super::tree_ops::{DeletePlan, FolderDeleteMode, ItemRef, MAX_FOLDER_DEPTH};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

/// 2: added manual ordering (`sortOrder`). Version-1 files load unchanged.
const DOC_VERSION: u32 = 2;
pub(crate) const MAX_NAME: usize = 128;
pub(crate) const MAX_HOST: usize = 255;
pub(crate) const MAX_USER: usize = 256;
pub(crate) const MAX_PATH: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    #[default]
    Password,
    PublicKey,
    KeyboardInteractive,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
    pub save_password: bool,
    pub has_stored_secret: bool,
    pub timeout_secs: u32,
    pub initial_directory: Option<String>,
    pub folder_id: Option<Uuid>,
    /// Manual position among siblings; equal values fall back to name order.
    #[serde(default)]
    pub sort_order: i64,
    /// Live resource monitor preference of this connection.
    #[serde(default)]
    pub monitoring: MonitorMode,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Per-connection choice for the live resource monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MonitorMode {
    /// Follow Settings → SSH → Server Monitoring.
    #[default]
    Inherit,
    Enabled,
    Disabled,
}

/// What the renderer may send. `id: None` creates a new connection.
/// `has_stored_secret`, timestamps and ids are owned by Rust.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<Uuid>,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub save_password: bool,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    #[serde(default)]
    pub initial_directory: Option<String>,
    #[serde(default)]
    pub folder_id: Option<Uuid>,
    #[serde(default)]
    pub monitoring: Option<MonitorMode>,
}

fn default_port() -> u16 {
    22
}
fn default_timeout() -> u32 {
    15
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
    #[serde(default = "yes")]
    pub expanded: bool,
    #[serde(default)]
    pub sort_order: i64,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInput {
    pub id: Option<Uuid>,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<Uuid>,
    #[serde(default = "yes")]
    pub expanded: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTree {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn optional_text(
    value: Option<String>,
    max: usize,
    field: &str,
) -> AppResult<Option<String>> {
    match value.map(|v| v.trim().to_owned()) {
        Some(v) if v.is_empty() => Ok(None),
        Some(v) if v.chars().count() > max => {
            Err(AppError::Validation(format!("{field} is too long")))
        }
        Some(v) if v.contains('\0') => Err(AppError::Validation(format!("{field} is invalid"))),
        other => Ok(other),
    }
}

pub(crate) fn required_text(value: &str, max: usize, field: &str) -> AppResult<String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(AppError::Validation(format!("{field} is required")));
    }
    if v.chars().count() > max || v.contains('\0') {
        return Err(AppError::Validation(format!("{field} is invalid")));
    }
    Ok(v.to_owned())
}

/// Longest accepted folder path ("a/b/c" typed into the New Folder dialog).
pub(crate) const MAX_FOLDER_PATH: usize = 3 * MAX_NAME + 8;

/// Splits a relative folder path (`ops/docker`) into validated names.
/// Rejects absolute paths, empty segments, `.`/`..`, over-long input and more
/// segments than the folder depth allows. Nothing is created here.
pub(crate) fn parse_folder_path(path: &str) -> AppResult<Vec<String>> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation_key(
            "folders.pathEmpty",
            "Folder name is required",
        ));
    }
    if trimmed.chars().count() > MAX_FOLDER_PATH || trimmed.contains('\0') {
        return Err(AppError::validation_key(
            "folders.pathInvalid",
            "The folder path is invalid",
        ));
    }
    let mut names = Vec::new();
    for raw in trimmed.split('/') {
        let name = raw.trim();
        // Absolute paths ("/x"), "a//b" and a trailing "/" all produce an empty segment.
        if name.is_empty() || name == "." || name == ".." {
            return Err(AppError::validation_key(
                "folders.pathInvalid",
                "The folder path is invalid: use names separated by /, without empty parts, . or ..",
            ));
        }
        if name.chars().any(char::is_control) {
            return Err(AppError::validation_key(
                "folders.pathInvalid",
                "The folder path is invalid",
            ));
        }
        names.push(required_text(name, MAX_NAME, "Folder name")?);
    }
    if names.len() > MAX_FOLDER_DEPTH {
        return Err(AppError::validation_key(
            "folders.tooDeep",
            format!("Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep."),
        )
        .with_param("max", MAX_FOLDER_DEPTH));
    }
    Ok(names)
}

/// Host names, IPv4 and IPv6 literals (optionally bracketed). No whitespace or
/// characters that could be mistaken for user/port/path separators.
pub(crate) fn validate_host(raw: &str) -> AppResult<String> {
    let host = required_text(raw, MAX_HOST, "Host")?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host)
        .to_owned();
    let ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'));
    if ok {
        Ok(host)
    } else {
        Err(AppError::Validation(
            "Host contains invalid characters".into(),
        ))
    }
}

impl ConnectionTree {
    fn folder_exists(&self, id: Uuid) -> bool {
        self.folders.iter().any(|f| f.id == id)
    }

    fn check_folder_ref(&self, id: Option<Uuid>) -> AppResult<()> {
        match id {
            Some(id) if !self.folder_exists(id) => Err(AppError::NotFound("folder".into())),
            _ => Ok(()),
        }
    }

    /// Position that places a new item after its siblings.
    pub(crate) fn next_order(&self, parent: Option<Uuid>, folders: bool) -> i64 {
        let max = if folders {
            self.folders
                .iter()
                .filter(|f| f.parent_id == parent)
                .map(|f| f.sort_order)
                .max()
        } else {
            self.connections
                .iter()
                .filter(|c| c.folder_id == parent)
                .map(|c| c.sort_order)
                .max()
        };
        max.map_or(0, |m| m.saturating_add(1))
    }
}

/// Thread-safe owner of `connections.json`.
pub struct ConnectionStore {
    path: PathBuf,
    doc: Mutex<ConnectionTree>,
    issues: Vec<ConfigIssue>,
}

impl ConnectionStore {
    /// Never fails because of file contents: damaged entries are skipped, a
    /// backup of the original is kept and the problem is reported via
    /// [`ConnectionStore::issues`].
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let mut issues = Vec::new();
        let mut doc = ConnectionTree::default();
        match load_json_value(&path, &mut issues) {
            Some(Value::Object(obj)) => {
                let before = issues.len();
                doc.folders = parse_entries(obj.get("folders"), &path, "folders", &mut issues);
                doc.connections =
                    parse_entries(obj.get("connections"), &path, "connections", &mut issues);
                if doc.repair_references() > 0 {
                    issues.push(ConfigIssue {
                        file: super::atomic::file_label(&path),
                        kind: "repaired_references",
                        field: None,
                        backed_up: false,
                    });
                }
                ensure_backup(&path, &mut issues, before);
                // An older layout is rewritten (as version 2) on the next save:
                // keep what was on disk first.
                let from = obj.get("version").and_then(Value::as_u64).unwrap_or(1) as u32;
                if from < DOC_VERSION && (!doc.folders.is_empty() || !doc.connections.is_empty()) {
                    backup_before_migration(&path, from);
                }
            }
            Some(_) => {
                issues.push(ConfigIssue {
                    file: super::atomic::file_label(&path),
                    kind: "not_an_object",
                    field: None,
                    backed_up: false,
                });
                let at = issues.len() - 1;
                ensure_backup(&path, &mut issues, at);
            }
            None => {}
        }
        doc.version = DOC_VERSION;
        Ok(Self {
            path,
            doc: Mutex::new(doc),
            issues,
        })
    }

    pub fn issues(&self) -> &[ConfigIssue] {
        &self.issues
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    fn with_doc<R>(&self, f: impl FnOnce(&mut ConnectionTree) -> AppResult<R>) -> AppResult<R> {
        let mut guard = self
            .doc
            .lock()
            .map_err(|_| AppError::Storage("connection store lock poisoned".into()))?;
        // Work on a copy so a failed validation or a failed write leaves the
        // in-memory state identical to the file on disk.
        let mut draft = guard.clone();
        let result = f(&mut draft)?;
        if draft != *guard {
            save_json(&self.path, &draft)?;
            *guard = draft;
        }
        Ok(result)
    }

    /// Replace the whole document, but only if it is still exactly `expected`
    /// (so a restore never overwrites an edit made after it was planned).
    /// One atomic file write; on failure memory and disk are unchanged.
    pub fn replace_if_unchanged(
        &self,
        expected: &ConnectionTree,
        mut new: ConnectionTree,
    ) -> AppResult<()> {
        new.version = DOC_VERSION;
        self.with_doc(|doc| {
            if doc != expected {
                return Err(AppError::Validation(
                    "Your connections changed while the operation was prepared. Nothing was changed; please try again.".into(),
                ));
            }
            *doc = new;
            Ok(())
        })
    }

    pub fn load(&self) -> AppResult<ConnectionTree> {
        self.with_doc(|doc| Ok(doc.clone()))
    }

    pub fn get(&self, id: Uuid) -> AppResult<Connection> {
        self.with_doc(|doc| {
            doc.connections
                .iter()
                .find(|c| c.id == id)
                .cloned()
                .ok_or_else(|| AppError::NotFound("connection".into()))
        })
    }

    pub fn save_connection(&self, input: ConnectionInput) -> AppResult<Connection> {
        let name = required_text(&input.name, MAX_NAME, "Name")?;
        let host = validate_host(&input.host)?;
        if input.port == 0 {
            return Err(AppError::Validation(
                "Port must be between 1 and 65535".into(),
            ));
        }
        let username = input.username.trim().to_owned();
        if username.chars().count() > MAX_USER || username.contains(['\0', '@', ' ']) {
            return Err(AppError::Validation("Username is invalid".into()));
        }
        if !(1..=300).contains(&input.timeout_secs) {
            return Err(AppError::Validation(
                "Timeout must be between 1 and 300 seconds".into(),
            ));
        }
        let key_path = optional_text(input.key_path, MAX_PATH, "Key path")?;
        if input.auth == AuthMethod::PublicKey && key_path.is_none() {
            return Err(AppError::Validation(
                "A private key file is required for public-key authentication".into(),
            ));
        }
        let initial_directory = optional_text(input.initial_directory, MAX_PATH, "Directory")?;

        self.with_doc(|doc| {
            doc.check_folder_ref(input.folder_id)?;
            let now = now_millis();
            match input.id {
                Some(id) => {
                    let existing = doc
                        .connections
                        .iter_mut()
                        .find(|c| c.id == id)
                        .ok_or_else(|| AppError::NotFound("connection".into()))?;
                    existing.name = name;
                    existing.host = host;
                    existing.port = input.port;
                    existing.username = username;
                    existing.auth = input.auth;
                    existing.key_path = key_path;
                    existing.save_password = input.save_password;
                    existing.timeout_secs = input.timeout_secs;
                    existing.initial_directory = initial_directory;
                    existing.folder_id = input.folder_id;
                    if let Some(m) = input.monitoring {
                        existing.monitoring = m;
                    }
                    existing.updated_at = now;
                    Ok(existing.clone())
                }
                None => {
                    let connection = Connection {
                        id: Uuid::new_v4(),
                        name,
                        host,
                        port: input.port,
                        username,
                        auth: input.auth,
                        key_path,
                        save_password: input.save_password,
                        has_stored_secret: false,
                        timeout_secs: input.timeout_secs,
                        initial_directory,
                        folder_id: input.folder_id,
                        sort_order: doc.next_order(input.folder_id, false),
                        monitoring: input.monitoring.unwrap_or_default(),
                        created_at: now,
                        updated_at: now,
                    };
                    doc.connections.push(connection.clone());
                    Ok(connection)
                }
            }
        })
    }

    pub fn delete_connection(&self, id: Uuid) -> AppResult<Connection> {
        self.with_doc(|doc| {
            let index = doc
                .connections
                .iter()
                .position(|c| c.id == id)
                .ok_or_else(|| AppError::NotFound("connection".into()))?;
            Ok(doc.connections.remove(index))
        })
    }

    /// Copies metadata only. The copy never inherits a stored secret.
    pub fn duplicate_connection(&self, id: Uuid) -> AppResult<Connection> {
        self.with_doc(|doc| {
            let source = doc
                .connections
                .iter()
                .find(|c| c.id == id)
                .cloned()
                .ok_or_else(|| AppError::NotFound("connection".into()))?;
            let now = now_millis();
            let mut copy = source;
            copy.id = Uuid::new_v4();
            copy.name = format!("{} (copy)", copy.name);
            copy.name.truncate(MAX_NAME);
            copy.has_stored_secret = false;
            copy.sort_order = copy.sort_order.saturating_add(1);
            copy.created_at = now;
            copy.updated_at = now;
            doc.connections.push(copy.clone());
            Ok(copy)
        })
    }

    pub fn move_connection(&self, id: Uuid, folder_id: Option<Uuid>) -> AppResult<()> {
        self.with_doc(|doc| {
            doc.check_folder_ref(folder_id)?;
            let connection = doc
                .connections
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or_else(|| AppError::NotFound("connection".into()))?;
            connection.folder_id = folder_id;
            Ok(())
        })
    }

    /// Change only the display name. Host, port, user and credentials are
    /// not touched.
    pub fn rename_connection(&self, id: Uuid, name: &str) -> AppResult<Connection> {
        let name = required_text(name, MAX_NAME, "Name")?;
        self.with_doc(|doc| {
            let c = doc
                .connections
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or_else(|| AppError::NotFound("connection".into()))?;
            if c.name != name {
                c.name = name;
                c.updated_at = now_millis();
            }
            Ok(c.clone())
        })
    }

    pub fn rename_folder(&self, id: Uuid, name: &str) -> AppResult<Folder> {
        let name = required_text(name, MAX_NAME, "Folder name")?;
        self.with_doc(|doc| {
            let f = doc
                .folders
                .iter_mut()
                .find(|f| f.id == id)
                .ok_or_else(|| AppError::NotFound("folder".into()))?;
            f.name = name;
            Ok(f.clone())
        })
    }

    /// Move/reorder items; see `ConnectionTree::move_items`. Atomic: on any
    /// validation error nothing changes.
    pub fn move_items(
        &self,
        items: &[ItemRef],
        target: Option<Uuid>,
        before: Option<ItemRef>,
    ) -> AppResult<ConnectionTree> {
        self.with_doc(|doc| {
            doc.move_items(items, target, before)?;
            Ok(doc.clone())
        })
    }

    pub fn check_move(&self, items: &[ItemRef], target: Option<Uuid>) -> AppResult<()> {
        self.with_doc(|doc| doc.validate_move(items, target).map(|_| ()))
    }

    pub fn plan_delete(&self, items: &[ItemRef], mode: FolderDeleteMode) -> AppResult<DeletePlan> {
        self.with_doc(|doc| doc.plan_delete(items, mode))
    }

    /// Delete connections/folders as one atomic change. The returned plan names
    /// exactly the connections whose credentials the caller must delete.
    pub fn delete_items(&self, items: &[ItemRef], mode: FolderDeleteMode) -> AppResult<DeletePlan> {
        self.with_doc(|doc| doc.delete_items(items, mode))
    }

    pub fn set_has_stored_secret(&self, id: Uuid, value: bool) -> AppResult<()> {
        self.with_doc(|doc| {
            let connection = doc
                .connections
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or_else(|| AppError::NotFound("connection".into()))?;
            connection.has_stored_secret = value;
            Ok(())
        })
    }

    pub fn clear_all_secret_flags(&self) -> AppResult<Vec<Uuid>> {
        self.with_doc(|doc| {
            let mut ids = Vec::new();
            for connection in doc.connections.iter_mut() {
                ids.push(connection.id);
                connection.has_stored_secret = false;
            }
            Ok(ids)
        })
    }

    pub fn save_folder(&self, input: FolderInput) -> AppResult<Folder> {
        let name = required_text(&input.name, MAX_NAME, "Folder name")?;
        self.with_doc(|doc| {
            doc.check_folder_ref(input.parent_id)?;
            match input.id {
                Some(id) => {
                    let current_parent = doc
                        .folders
                        .iter()
                        .find(|f| f.id == id)
                        .ok_or_else(|| AppError::NotFound("folder".into()))?
                        .parent_id;
                    // Re-parenting goes through the same cycle and depth rules as a move.
                    if current_parent != input.parent_id {
                        doc.move_items(&[ItemRef::Folder { id }], input.parent_id, None)?;
                    }
                    let folder = doc
                        .folders
                        .iter_mut()
                        .find(|f| f.id == id)
                        .ok_or_else(|| AppError::NotFound("folder".into()))?;
                    folder.name = name;
                    folder.expanded = input.expanded;
                    Ok(folder.clone())
                }
                None => {
                    let level = input.parent_id.map(|p| doc.folder_level(p)).unwrap_or(0);
                    if level + 1 > MAX_FOLDER_DEPTH {
                        return Err(AppError::Validation(format!(
                            "Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep."
                        )));
                    }
                    let folder = Folder {
                        id: Uuid::new_v4(),
                        name,
                        parent_id: input.parent_id,
                        expanded: input.expanded,
                        sort_order: doc.next_order(input.parent_id, true),
                    };
                    doc.folders.push(folder.clone());
                    Ok(folder)
                }
            }
        })
    }

    /// Creates `path` (e.g. `ops/docker`) below `parent`, reusing every folder
    /// that already exists. Everything is validated first and written in one
    /// atomic save: on any failure nothing is created. Existing folders are not
    /// renamed, moved or deleted; they are only expanded so the result is visible.
    /// Returns the whole chain, top first, and how many folders are new.
    pub fn create_folder_path(
        &self,
        parent: Option<Uuid>,
        path: &str,
    ) -> AppResult<(Vec<Folder>, usize)> {
        let names = parse_folder_path(path)?;
        self.with_doc(|doc| {
            doc.check_folder_ref(parent)?;
            let base = parent.map(|p| doc.folder_level(p)).unwrap_or(0);
            if base + names.len() > MAX_FOLDER_DEPTH {
                return Err(AppError::validation_key(
                    "folders.tooDeep",
                    format!("Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep."),
                )
                .with_param("max", MAX_FOLDER_DEPTH));
            }
            let mut chain = Vec::new();
            let mut created = 0;
            let mut current = parent;
            for name in names {
                let existing = doc
                    .folders
                    .iter()
                    .position(|f| f.parent_id == current && f.name == name);
                let index = match existing {
                    Some(i) => i,
                    None => {
                        let folder = Folder {
                            id: Uuid::new_v4(),
                            name,
                            parent_id: current,
                            expanded: true,
                            sort_order: doc.next_order(current, true),
                        };
                        doc.folders.push(folder);
                        created += 1;
                        doc.folders.len() - 1
                    }
                };
                // Parents stay open so the final folder is visible.
                doc.folders[index].expanded = true;
                current = Some(doc.folders[index].id);
                chain.push(doc.folders[index].clone());
            }
            if let Some(p) = parent
                && let Some(f) = doc.folders.iter_mut().find(|f| f.id == p)
            {
                f.expanded = true;
            }
            Ok((chain, created))
        })
    }

    /// Deletes a folder; its sub-folders and connections move to its parent.
    pub fn delete_folder(&self, id: Uuid) -> AppResult<()> {
        self.with_doc(|doc| {
            let index = doc
                .folders
                .iter()
                .position(|f| f.id == id)
                .ok_or_else(|| AppError::NotFound("folder".into()))?;
            let removed = doc.folders.remove(index);
            for folder in doc.folders.iter_mut() {
                if folder.parent_id == Some(id) {
                    folder.parent_id = removed.parent_id;
                }
            }
            for connection in doc.connections.iter_mut() {
                if connection.folder_id == Some(id) {
                    connection.folder_id = removed.parent_id;
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> ConnectionInput {
        ConnectionInput {
            monitoring: None,
            id: None,
            name: name.into(),
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
            auth: AuthMethod::Password,
            key_path: None,
            save_password: false,
            timeout_secs: 15,
            initial_directory: None,
            folder_id: None,
        }
    }

    fn store() -> (tempfile::TempDir, ConnectionStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::open(dir.path().join("connections.json")).unwrap();
        (dir, store)
    }

    #[test]
    fn persists_across_reopen() {
        let (dir, store) = store();
        let folder = store
            .save_folder(FolderInput {
                id: None,
                name: "Prod".into(),
                parent_id: None,
                expanded: true,
            })
            .unwrap();
        let mut i = input("web-1");
        i.folder_id = Some(folder.id);
        let saved = store.save_connection(i).unwrap();

        let reopened = ConnectionStore::open(dir.path().join("connections.json")).unwrap();
        let tree = reopened.load().unwrap();
        assert_eq!(tree.folders, vec![folder]);
        assert_eq!(tree.connections, vec![saved]);
        assert_eq!(tree.version, DOC_VERSION);
    }

    #[test]
    fn handles_hundreds_of_connections() {
        let (_dir, store) = store();
        for n in 0..500 {
            store.save_connection(input(&format!("host-{n}"))).unwrap();
        }
        assert_eq!(store.load().unwrap().connections.len(), 500);
    }

    #[test]
    fn rejects_invalid_input_without_writing() {
        let (dir, store) = store();
        let mut bad = input("x");
        bad.host = "evil host;rm".into();
        assert!(store.save_connection(bad).is_err());
        let mut bad = input("x");
        bad.port = 0;
        assert!(store.save_connection(bad).is_err());
        let mut bad = input("x");
        bad.auth = AuthMethod::PublicKey;
        assert!(store.save_connection(bad).is_err());
        let mut bad = input("x");
        bad.folder_id = Some(Uuid::new_v4());
        assert!(store.save_connection(bad).is_err());
        assert!(!dir.path().join("connections.json").exists());
    }

    #[test]
    fn accepts_ipv6_and_strips_brackets() {
        let (_dir, store) = store();
        let mut i = input("v6");
        i.host = "[2001:db8::1]".into();
        assert_eq!(store.save_connection(i).unwrap().host, "2001:db8::1");
    }

    #[test]
    fn duplicate_never_copies_secret_flag() {
        let (_dir, store) = store();
        let original = store.save_connection(input("db")).unwrap();
        store.set_has_stored_secret(original.id, true).unwrap();
        let copy = store.duplicate_connection(original.id).unwrap();
        assert_ne!(copy.id, original.id);
        assert!(!copy.has_stored_secret);
        assert_eq!(copy.name, "db (copy)");
    }

    #[test]
    fn deleting_folder_reparents_children() {
        let (_dir, store) = store();
        let outer = store
            .save_folder(FolderInput {
                id: None,
                name: "outer".into(),
                parent_id: None,
                expanded: true,
            })
            .unwrap();
        let inner = store
            .save_folder(FolderInput {
                id: None,
                name: "inner".into(),
                parent_id: Some(outer.id),
                expanded: true,
            })
            .unwrap();
        let mut i = input("c");
        i.folder_id = Some(inner.id);
        let c = store.save_connection(i).unwrap();
        store.delete_folder(inner.id).unwrap();
        let tree = store.load().unwrap();
        assert_eq!(tree.connections[0].id, c.id);
        assert_eq!(tree.connections[0].folder_id, Some(outer.id));
    }

    #[test]
    fn folder_cycles_are_rejected() {
        let (_dir, store) = store();
        let a = store
            .save_folder(FolderInput {
                id: None,
                name: "a".into(),
                parent_id: None,
                expanded: true,
            })
            .unwrap();
        let b = store
            .save_folder(FolderInput {
                id: None,
                name: "b".into(),
                parent_id: Some(a.id),
                expanded: true,
            })
            .unwrap();
        let result = store.save_folder(FolderInput {
            id: Some(a.id),
            name: "a".into(),
            parent_id: Some(b.id),
            expanded: true,
        });
        assert!(result.is_err());
    }

    #[test]
    fn file_never_contains_password_fields() {
        let (dir, store) = store();
        let mut i = input("p");
        i.save_password = true;
        store.save_connection(i).unwrap();
        let text = std::fs::read_to_string(dir.path().join("connections.json")).unwrap();
        assert!(!text.to_lowercase().contains("\"password\":"));
        assert!(!text.contains("secret\":\""));
    }

    fn folder_in(store: &ConnectionStore, name: &str, parent: Option<Uuid>) -> Folder {
        store
            .save_folder(FolderInput {
                id: None,
                name: name.into(),
                parent_id: parent,
                expanded: true,
            })
            .unwrap()
    }

    #[test]
    fn rename_changes_only_the_display_name() {
        let (dir, store) = store();
        let mut i = input("old-name");
        i.port = 2200;
        i.username = "deploy".into();
        i.save_password = true;
        let saved = store.save_connection(i).unwrap();
        store.set_has_stored_secret(saved.id, true).unwrap();

        let renamed = store.rename_connection(saved.id, "  New name  ").unwrap();
        assert_eq!(renamed.name, "New name");
        let mut expected = saved.clone();
        expected.name = "New name".into();
        expected.has_stored_secret = true;
        expected.updated_at = renamed.updated_at;
        assert_eq!(
            renamed, expected,
            "host, port, user and credentials untouched"
        );

        // persisted immediately
        let reopened = ConnectionStore::open(dir.path().join("connections.json")).unwrap();
        assert_eq!(reopened.get(saved.id).unwrap().name, "New name");
    }

    #[test]
    fn rename_validation_keeps_the_original_name() {
        let (_dir, store) = store();
        let saved = store.save_connection(input("keep")).unwrap();
        for bad in ["", "   ", &"x".repeat(129), "nul\0byte"] {
            assert!(store.rename_connection(saved.id, bad).is_err(), "{bad:?}");
        }
        assert_eq!(store.get(saved.id).unwrap().name, "keep");
        assert_eq!(
            store
                .rename_connection(Uuid::new_v4(), "x")
                .unwrap_err()
                .code(),
            "not_found"
        );
        let folder = folder_in(&store, "Prod", None);
        assert_eq!(
            store.rename_folder(folder.id, "Production").unwrap().name,
            "Production"
        );
        assert!(store.rename_folder(folder.id, "").is_err());
        assert_eq!(store.load().unwrap().folders[0].name, "Production");
    }

    #[test]
    fn folder_depth_is_enforced_by_the_store() {
        let (_dir, store) = store();
        let a = folder_in(&store, "A", None);
        let b = folder_in(&store, "B", Some(a.id));
        let c = folder_in(&store, "C", Some(b.id));
        let err = store
            .save_folder(FolderInput {
                id: None,
                name: "D".into(),
                parent_id: Some(c.id),
                expanded: true,
            })
            .unwrap_err();
        assert!(err.to_string().contains("at most 3 levels"), "{err}");
        // re-parenting through save_folder obeys the same rules
        let x = folder_in(&store, "X", None);
        let err = store
            .save_folder(FolderInput {
                id: Some(x.id),
                name: "X".into(),
                parent_id: Some(c.id),
                expanded: true,
            })
            .unwrap_err();
        assert_eq!(err.code(), "validation");
        assert_eq!(store.load().unwrap().folders.len(), 4);
    }

    #[test]
    fn move_and_delete_persist_and_failed_operations_change_nothing() {
        let (dir, store) = store();
        let a = folder_in(&store, "A", None);
        let b = folder_in(&store, "B", Some(a.id));
        let c = folder_in(&store, "C", Some(b.id));
        let top = folder_in(&store, "Top", None);
        let conn = store.save_connection(input("srv")).unwrap();

        let tree = store
            .move_items(&[ItemRef::Connection { id: conn.id }], Some(c.id), None)
            .unwrap();
        assert_eq!(tree.connections[0].folder_id, Some(c.id));

        let before = std::fs::read(dir.path().join("connections.json")).unwrap();
        assert!(
            store
                .move_items(&[ItemRef::Folder { id: top.id }], Some(c.id), None)
                .is_err()
        );
        assert_eq!(
            std::fs::read(dir.path().join("connections.json")).unwrap(),
            before
        );

        let plan = store
            .delete_items(
                &[ItemRef::Folder { id: a.id }],
                FolderDeleteMode::DeleteContents,
            )
            .unwrap();
        assert_eq!(plan.connection_ids, vec![conn.id]);
        let reopened = ConnectionStore::open(dir.path().join("connections.json")).unwrap();
        let tree = reopened.load().unwrap();
        assert_eq!(tree.folders.len(), 1);
        assert!(tree.connections.is_empty());
    }

    #[test]
    fn manual_order_survives_a_restart() {
        let (dir, store) = store();
        let a = store.save_connection(input("alpha")).unwrap();
        let b = store.save_connection(input("bravo")).unwrap();
        let c = store.save_connection(input("charlie")).unwrap();
        store
            .move_items(
                &[ItemRef::Connection { id: c.id }],
                None,
                Some(ItemRef::Connection { id: a.id }),
            )
            .unwrap();
        let reopened = ConnectionStore::open(dir.path().join("connections.json")).unwrap();
        let tree = reopened.load().unwrap();
        let order: Vec<_> = tree
            .sorted_children(None, false)
            .into_iter()
            .map(|i| i.id())
            .collect();
        assert_eq!(order, vec![c.id, a.id, b.id]);
    }

    #[test]
    fn a_version_1_file_loads_intact_and_is_backed_up_before_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let folder_id = "4f3653b1-1f94-4a43-a430-3db9ca1877f9";
        let conn_id = "6b4ae199-eefd-4e3b-8f90-a8772682c026";
        let v1 = format!(
            r#"{{"version":1,"folders":[{{"id":"{folder_id}","name":"Lab","parentId":null,"expanded":false}}],
               "connections":[{{"id":"{conn_id}","name":"web","host":"h.example.com","port":2222,"username":"u",
               "auth":"publicKey","keyPath":"/k","savePassword":true,"hasStoredSecret":true,"timeoutSecs":20,
               "initialDirectory":"/srv","folderId":"{folder_id}","createdAt":5,"updatedAt":6}}]}}"#
        );
        std::fs::write(&path, &v1).unwrap();

        let store = ConnectionStore::open(path.clone()).unwrap();
        assert!(store.issues().is_empty());
        let tree = store.load().unwrap();
        assert_eq!(tree.version, DOC_VERSION);
        let c = &tree.connections[0];
        assert_eq!((c.name.as_str(), c.port, c.sort_order), ("web", 2222, 0));
        assert!(c.has_stored_secret && c.save_password);
        assert_eq!(c.folder_id, Some(folder_id.parse().unwrap()));
        assert!(!tree.folders[0].expanded);

        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".pre-v1-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(backups[0].path()).unwrap(), v1);

        // Re-opening does not pile up backups, and saving upgrades the file.
        drop(store);
        let store = ConnectionStore::open(path.clone()).unwrap();
        store.rename_connection(c.id, "web2").unwrap();
        let upgraded = std::fs::read_to_string(&path).unwrap();
        assert!(upgraded.contains("\"version\": 2") && upgraded.contains("sortOrder"));
        let count = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".pre-v1-"))
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn dangling_and_circular_references_are_repaired_on_load_without_deleting_anything() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        let ghost = "33333333-3333-4333-8333-333333333333";
        let conn = "44444444-4444-4444-8444-444444444444";
        std::fs::write(
            &path,
            format!(
                r#"{{"version":2,"folders":[{{"id":"{a}","name":"A","parentId":"{b}"}},{{"id":"{b}","name":"B","parentId":"{a}"}}],
                   "connections":[{{"id":"{conn}","name":"x","host":"h","port":22,"username":"","auth":"password","keyPath":null,
                   "savePassword":false,"hasStoredSecret":false,"timeoutSecs":15,"initialDirectory":null,"folderId":"{ghost}",
                   "createdAt":0,"updatedAt":0}}]}}"#
            ),
        )
        .unwrap();
        let store = ConnectionStore::open(path).unwrap();
        let tree = store.load().unwrap();
        assert_eq!((tree.folders.len(), tree.connections.len()), (2, 1));
        assert_eq!(tree.connections[0].folder_id, None);
        assert!(tree.folders.iter().any(|f| f.parent_id.is_none()));
        assert!(tree.too_deep_folders().is_empty());
        assert!(
            store
                .issues()
                .iter()
                .any(|i| i.kind == "repaired_references" && i.backed_up)
        );
    }

    // ---- nested folder paths ("ops/docker") ----

    fn names(tree: &ConnectionTree) -> Vec<(String, Option<Uuid>)> {
        let mut v: Vec<_> = tree
            .folders
            .iter()
            .map(|f| (f.name.clone(), f.parent_id))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn a_single_name_creates_one_folder() {
        let (_d, store) = store();
        let (chain, created) = store.create_folder_path(None, "Docker").unwrap();
        assert_eq!((chain.len(), created), (1, 1));
        assert_eq!(chain[0].name, "Docker");
        assert_eq!(chain[0].parent_id, None);
    }

    #[test]
    fn two_and_three_level_paths_create_the_whole_hierarchy() {
        let (_d, store) = store();
        let (chain, created) = store.create_folder_path(None, "ops/docker").unwrap();
        assert_eq!(created, 2);
        assert_eq!(chain[1].parent_id, Some(chain[0].id));
        let (chain3, created3) = store.create_folder_path(None, "a/b/c").unwrap();
        assert_eq!((chain3.len(), created3), (3, 3));
        assert_eq!(chain3[2].parent_id, Some(chain3[1].id));
        let tree = store.load().unwrap();
        assert_eq!(tree.folders.len(), 5);
        assert!(tree.folders.iter().all(|f| f.expanded));
    }

    #[test]
    fn existing_folders_are_reused_never_duplicated() {
        let (_d, store) = store();
        let (first, _) = store.create_folder_path(None, "ops").unwrap();
        let (chain, created) = store
            .create_folder_path(None, "ops/docker/production")
            .unwrap();
        assert_eq!(created, 2);
        assert_eq!(chain[0].id, first[0].id);
        // the full path again: nothing new, the same ids come back
        let (again, created) = store
            .create_folder_path(None, "ops/docker/production")
            .unwrap();
        assert_eq!(created, 0);
        assert_eq!(
            again.iter().map(|f| f.id).collect::<Vec<_>>(),
            chain.iter().map(|f| f.id).collect::<Vec<_>>()
        );
        assert_eq!(store.load().unwrap().folders.len(), 3);
    }

    #[test]
    fn paths_start_at_the_selected_parent_and_respect_the_depth_limit() {
        let (_d, store) = store();
        let (top, _) = store.create_folder_path(None, "a").unwrap();
        let (chain, _) = store.create_folder_path(Some(top[0].id), "b/c").unwrap();
        assert_eq!(chain[0].parent_id, Some(top[0].id));
        // a/b/c is level 3: one more level is refused, below any parent depth
        let err = store
            .create_folder_path(Some(chain[1].id), "d")
            .unwrap_err();
        assert!(matches!(
            &err,
            AppError::Keyed {
                key: "folders.tooDeep",
                ..
            }
        ));
        let err = store.create_folder_path(None, "w/x/y/z").unwrap_err();
        assert!(matches!(
            &err,
            AppError::Keyed {
                key: "folders.tooDeep",
                ..
            }
        ));
        let err = store
            .create_folder_path(Some(top[0].id), "x/y/z")
            .unwrap_err();
        assert!(matches!(
            &err,
            AppError::Keyed {
                key: "folders.tooDeep",
                ..
            }
        ));
    }

    #[test]
    fn invalid_paths_are_rejected_and_create_nothing() {
        let (dir, store) = store();
        store.create_folder_path(None, "keep").unwrap();
        let before = std::fs::read(dir.path().join("connections.json")).unwrap();
        let long = "x".repeat(MAX_NAME + 1);
        for bad in [
            "", "   ", "/", "/abs", "a//b", "a/", "/a/b", "./a", "a/./b", "../a", "a/../b", "..",
            ".", "a/ /b", "a b", "tab	here", &long, "a/b/c/d",
        ] {
            assert!(
                store.create_folder_path(None, bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        // a failure half way (second segment too long) leaves no first segment behind
        let half = format!("fine/{long}");
        assert!(store.create_folder_path(None, &half).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("connections.json")).unwrap(),
            before
        );
        assert_eq!(
            names(&store.load().unwrap()),
            vec![("keep".to_string(), None)]
        );
    }

    #[test]
    fn an_unknown_parent_is_refused_and_connections_are_untouched() {
        let (_d, store) = store();
        let mut i = input("web");
        let saved = store.save_connection(i.clone()).unwrap();
        i.name = "db".into();
        let other = store.save_connection(i).unwrap();
        let before = store.load().unwrap().connections;
        assert!(store.create_folder_path(Some(Uuid::new_v4()), "x").is_err());
        store.create_folder_path(None, "ops/docker").unwrap();
        let after = store.load().unwrap().connections;
        assert_eq!(before, after);
        assert_eq!(
            after.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![saved.id, other.id]
        );
    }

    #[test]
    fn names_with_slashes_in_the_old_single_folder_api_are_not_reinterpreted() {
        // ordinary single-folder validation is unchanged
        let (_d, store) = store();
        let f = store
            .save_folder(FolderInput {
                id: None,
                name: "legacy/name".into(),
                parent_id: None,
                expanded: true,
            })
            .unwrap();
        assert_eq!(f.name, "legacy/name");
    }

    #[test]
    fn a_failed_write_creates_no_partial_hierarchy() {
        let (dir, store) = store();
        store.create_folder_path(None, "ok").unwrap();
        // make the data file unwritable by replacing it with a directory
        let path = dir.path().join("connections.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(store.create_folder_path(None, "ops/docker").is_err());
        // in-memory state still matches what was last written
        assert_eq!(
            names(&store.load().unwrap()),
            vec![("ok".to_string(), None)]
        );
    }
}
