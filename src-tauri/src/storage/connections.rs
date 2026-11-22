//! Saved connections and folders.
//!
//! The document holds metadata only. Passwords live in the OS credential store
//! (see `security::credentials`); `has_stored_secret` merely records that one
//! was saved so the sidebar does not query the keychain for every entry.

use super::atomic::{ConfigIssue, ensure_backup, load_json_value, parse_entries, save_json};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

const DOC_VERSION: u32 = 1;
const MAX_NAME: usize = 128;
const MAX_HOST: usize = 255;
const MAX_USER: usize = 256;
const MAX_PATH: usize = 4096;

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
    pub created_at: u64,
    pub updated_at: u64,
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

fn optional_text(value: Option<String>, max: usize, field: &str) -> AppResult<Option<String>> {
    match value.map(|v| v.trim().to_owned()) {
        Some(v) if v.is_empty() => Ok(None),
        Some(v) if v.chars().count() > max => {
            Err(AppError::Validation(format!("{field} is too long")))
        }
        Some(v) if v.contains('\0') => Err(AppError::Validation(format!("{field} is invalid"))),
        other => Ok(other),
    }
}

fn required_text(value: &str, max: usize, field: &str) -> AppResult<String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(AppError::Validation(format!("{field} is required")));
    }
    if v.chars().count() > max || v.contains('\0') {
        return Err(AppError::Validation(format!("{field} is invalid")));
    }
    Ok(v.to_owned())
}

/// Host names, IPv4 and IPv6 literals (optionally bracketed). No whitespace or
/// characters that could be mistaken for user/port/path separators.
fn validate_host(raw: &str) -> AppResult<String> {
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

    /// Would placing `folder` under `new_parent` create a cycle?
    fn creates_cycle(&self, folder: Uuid, new_parent: Option<Uuid>) -> bool {
        let mut seen = HashSet::new();
        let mut cursor = new_parent;
        while let Some(id) = cursor {
            if id == folder || !seen.insert(id) {
                return true;
            }
            cursor = self
                .folders
                .iter()
                .find(|f| f.id == id)
                .and_then(|f| f.parent_id);
        }
        false
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
                ensure_backup(&path, &mut issues, before);
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
                    if doc.creates_cycle(id, input.parent_id) {
                        return Err(AppError::Validation(
                            "A folder cannot be moved into itself".into(),
                        ));
                    }
                    let folder = doc
                        .folders
                        .iter_mut()
                        .find(|f| f.id == id)
                        .ok_or_else(|| AppError::NotFound("folder".into()))?;
                    folder.name = name;
                    folder.parent_id = input.parent_id;
                    folder.expanded = input.expanded;
                    Ok(folder.clone())
                }
                None => {
                    let folder = Folder {
                        id: Uuid::new_v4(),
                        name,
                        parent_id: input.parent_id,
                        expanded: input.expanded,
                    };
                    doc.folders.push(folder.clone());
                    Ok(folder)
                }
            }
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
}
