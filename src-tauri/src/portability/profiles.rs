// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Connection profiles as portable data: the `peachterm-connections` JSON
//! document, the validated "incoming" staging model shared with encrypted
//! backups, duplicate detection and the merge engine.
//!
//! Nothing here touches disk or the credential store. Everything is a pure
//! function of its inputs, which is what makes it exhaustively testable.
//!
//! SECURITY: the JSON schema is an explicit allowlist. Passwords, passphrases,
//! key contents, credential-store accounts and the real connection ids
//! (which *are* the credential-store account names) never appear in it.

use crate::error::{AppError, AppResult};
use crate::storage::connections::{
    AuthMethod, Connection, ConnectionTree, Folder, MAX_NAME, MAX_PATH, MAX_USER, optional_text,
    required_text, validate_host,
};
use crate::storage::tree_ops::{ItemRef, MAX_FOLDER_DEPTH};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use uuid::Uuid;

pub const FORMAT: &str = "peachterm-connections";
pub const FORMAT_VERSION: u64 = 1;
pub const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_CONNECTIONS: usize = 10_000;
pub const MAX_FOLDERS: usize = 2_000;
const MAX_ID_LEN: usize = 64;
const MAX_REPORTED: usize = 200;

// ---------------------------------------------------------------------------
// Public identifiers
// ---------------------------------------------------------------------------

/// A stable, shareable identifier for a local id. One-way (SHA-256), so the
/// exported value cannot be used as a credential-store account name, yet the
/// same profile always exports with the same value (duplicate detection).
pub fn public_id(local: Uuid) -> Uuid {
    let mut hasher = Sha256::new();
    hasher.update(b"peachterm/export-id/v1");
    hasher.update(local.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes).into_uuid()
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDoc {
    pub format: &'static str,
    pub format_version: u64,
    pub application: &'static str,
    pub exported_at: String,
    pub folders: Vec<ExportFolder>,
    pub connections: Vec<ExportConnection>,
    /// Only present when the user opted in ("Include server notes").
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<crate::notes::portable::PortableNote>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFolder {
    pub id: Uuid,
    pub name: String,
    pub parent: Option<Uuid>,
    pub order: i64,
    pub expanded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConnection {
    pub id: Uuid,
    pub name: String,
    pub protocol: &'static str,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub folder: Option<Uuid>,
    pub order: i64,
    pub save_password: bool,
    pub timeout_secs: u32,
    pub initial_directory: Option<String>,
    /// Present only when the user explicitly opted in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExportStats {
    pub connections: usize,
    pub folders: usize,
    pub key_paths: usize,
}

/// Build the export document. `selected == None` exports everything.
pub fn build_export(
    tree: &ConnectionTree,
    selected: Option<&HashSet<Uuid>>,
    include_key_paths: bool,
    exported_at: String,
) -> (ExportDoc, ExportStats) {
    let included: HashSet<Uuid> = tree
        .connections
        .iter()
        .map(|c| c.id)
        .filter(|id| selected.is_none_or(|s| s.contains(id)))
        .collect();
    // Folders: all of them, or only the ancestors of what is exported.
    let mut folder_ids: HashSet<Uuid> = HashSet::new();
    if selected.is_none() {
        folder_ids.extend(tree.folders.iter().map(|f| f.id));
    } else {
        for c in tree.connections.iter().filter(|c| included.contains(&c.id)) {
            let mut cursor = c.folder_id;
            while let Some(id) = cursor {
                if !folder_ids.insert(id) {
                    break;
                }
                cursor = tree
                    .folders
                    .iter()
                    .find(|f| f.id == id)
                    .and_then(|f| f.parent_id);
            }
        }
    }

    // Depth-first in display order, so array order is the display order too.
    struct Walk<'a> {
        tree: &'a ConnectionTree,
        folder_ids: &'a HashSet<Uuid>,
        included: &'a HashSet<Uuid>,
        include_key_paths: bool,
        folders: Vec<ExportFolder>,
        connections: Vec<ExportConnection>,
    }
    impl Walk<'_> {
        fn visit(&mut self, parent: Option<Uuid>, depth: usize) {
            if depth > 16 {
                return; // corrupt data guard; the tree limit is 3
            }
            let tree = self.tree;
            let mut order = 0i64;
            for item in tree.sorted_children(parent, true) {
                let ItemRef::Folder { id } = item else {
                    continue;
                };
                if !self.folder_ids.contains(&id) {
                    continue;
                }
                if let Some(f) = tree.folders.iter().find(|f| f.id == id) {
                    self.folders.push(ExportFolder {
                        id: public_id(f.id),
                        name: f.name.clone(),
                        parent: parent.map(public_id),
                        order,
                        expanded: f.expanded,
                    });
                    order += 1;
                }
            }
            let mut order = 0i64;
            for item in tree.sorted_children(parent, false) {
                let ItemRef::Connection { id } = item else {
                    continue;
                };
                if !self.included.contains(&id) {
                    continue;
                }
                if let Some(c) = tree.connections.iter().find(|c| c.id == id) {
                    self.connections.push(ExportConnection {
                        id: public_id(c.id),
                        name: c.name.clone(),
                        protocol: "ssh",
                        host: c.host.clone(),
                        port: c.port,
                        username: c.username.clone(),
                        auth: c.auth,
                        folder: parent.map(public_id),
                        order,
                        save_password: c.save_password,
                        timeout_secs: c.timeout_secs,
                        initial_directory: c.initial_directory.clone(),
                        key_path: self.include_key_paths.then(|| c.key_path.clone()).flatten(),
                    });
                    order += 1;
                }
            }
            for item in tree.sorted_children(parent, true) {
                if let ItemRef::Folder { id } = item
                    && self.folder_ids.contains(&id)
                {
                    self.visit(Some(id), depth + 1);
                }
            }
        }
    }
    let mut walk = Walk {
        tree,
        folder_ids: &folder_ids,
        included: &included,
        include_key_paths,
        folders: Vec::new(),
        connections: Vec::new(),
    };
    walk.visit(None, 0);
    let Walk {
        folders,
        connections,
        ..
    } = walk;
    let stats = ExportStats {
        connections: connections.len(),
        folders: folders.len(),
        key_paths: connections.iter().filter(|c| c.key_path.is_some()).count(),
    };
    (
        ExportDoc {
            format: FORMAT,
            format_version: FORMAT_VERSION,
            application: "PeachTerm",
            exported_at,
            folders,
            connections,
            notes: Vec::new(),
        },
        stats,
    )
}

pub fn export_to_bytes(doc: &ExportDoc) -> AppResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(doc)?;
    bytes.push(b'\n');
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Incoming (staged) model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct IncomingFolder {
    /// Key used by `parent` / `folder` references inside the document.
    pub key: String,
    pub parent: Option<String>,
    pub name: String,
    pub expanded: bool,
    pub order: i64,
    /// Backups keep the original id when it is still free.
    pub id_hint: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IncomingConnection {
    /// Original local id (encrypted backups only).
    pub id_hint: Option<Uuid>,
    /// `public_id` of the source profile (JSON exports and backups).
    pub stable_hint: Option<Uuid>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
    pub save_password: bool,
    pub timeout_secs: u32,
    pub initial_directory: Option<String>,
    pub folder: Option<String>,
    pub order: i64,
    pub created_at: Option<u64>,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct IncomingSet {
    pub folders: Vec<IncomingFolder>,
    pub connections: Vec<IncomingConnection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidEntry {
    /// `"connection"` or `"folder"`.
    pub kind: &'static str,
    /// Position in the file (0-based).
    pub index: usize,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub incoming: IncomingSet,
    pub invalid: Vec<InvalidEntry>,
    /// Field names that are not part of the schema (names only, never values).
    pub unsupported_fields: BTreeSet<String>,
    /// Connections moved out of an unusable folder.
    pub relocated: usize,
    pub exported_at: Option<String>,
    pub format_version: u64,
    /// Valid notes of the document (never fetched, never executed).
    pub notes: Vec<crate::notes::portable::PortableNote>,
    pub notes_invalid: usize,
    /// Raw parent links of every well-formed folder (valid or not), used to
    /// find the nearest usable ancestor of a connection.
    raw_parents: HashMap<String, Option<String>>,
}

fn reject(msg: &str) -> AppError {
    AppError::Validation(msg.into())
}

fn note_unknown(obj: &Map<String, Value>, known: &[&str], scope: &str, out: &mut BTreeSet<String>) {
    for key in obj.keys() {
        if !known.contains(&key.as_str()) && out.len() < MAX_REPORTED {
            let clean: String = key
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                .take(40)
                .collect();
            out.insert(format!("{scope}{clean}"));
        }
    }
}

fn get_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(format!("\"{key}\" must be text")),
    }
}

fn get_bool(obj: &Map<String, Value>, key: &str, default: bool) -> Result<bool, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("\"{key}\" must be true or false")),
    }
}

fn get_int(obj: &Map<String, Value>, key: &str) -> Result<Option<i64>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("\"{key}\" must be a whole number")),
        Some(_) => Err(format!("\"{key}\" must be a number")),
    }
}

fn clean_ref(text: &str) -> Result<String, String> {
    if text.is_empty()
        || text.len() > MAX_ID_LEN
        || !text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("invalid identifier".into());
    }
    Ok(text.to_owned())
}

fn parse_auth(text: &str) -> Option<AuthMethod> {
    Some(match text {
        "password" => AuthMethod::Password,
        "publicKey" => AuthMethod::PublicKey,
        "keyboardInteractive" => AuthMethod::KeyboardInteractive,
        "agent" => AuthMethod::Agent,
        _ => return None,
    })
}

/// Shared field rules (the same limits `ConnectionStore::save_connection` applies).
pub struct Fields<'a> {
    pub name: &'a str,
    pub host: &'a str,
    pub port: i64,
    pub username: &'a str,
    pub timeout_secs: i64,
    pub key_path: Option<&'a str>,
    pub initial_directory: Option<&'a str>,
}

pub struct CleanFields {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub timeout_secs: u32,
    pub key_path: Option<String>,
    pub initial_directory: Option<String>,
}

pub fn clean_fields(f: Fields<'_>) -> Result<CleanFields, String> {
    let msg = |e: AppError| e.to_string();
    let name = required_text(f.name, MAX_NAME, "Name").map_err(msg)?;
    let host = validate_host(f.host).map_err(msg)?;
    if !(1..=65535).contains(&f.port) {
        return Err("Port must be between 1 and 65535".into());
    }
    let username = f.username.trim().to_owned();
    if username.chars().count() > MAX_USER || username.contains(['\0', '@', ' ']) {
        return Err("Username is invalid".into());
    }
    if !(1..=300).contains(&f.timeout_secs) {
        return Err("Timeout must be between 1 and 300 seconds".into());
    }
    let key_path =
        optional_text(f.key_path.map(str::to_owned), MAX_PATH, "Key path").map_err(msg)?;
    let initial_directory = optional_text(
        f.initial_directory.map(str::to_owned),
        MAX_PATH,
        "Directory",
    )
    .map_err(msg)?;
    Ok(CleanFields {
        name,
        host,
        port: f.port as u16,
        username,
        timeout_secs: f.timeout_secs as u32,
        key_path,
        initial_directory,
    })
}

/// Parse and validate a `peachterm-connections` document into the staging
/// model. Whole-document problems are errors; per-record problems become
/// [`InvalidEntry`] values and the rest of the file is still usable.
pub fn parse_document(bytes: &[u8]) -> AppResult<Parsed> {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| reject("This file is not valid JSON, so it was not imported."))?;
    let Value::Object(root) = value else {
        return Err(reject("This file is not a PeachTerm connections export."));
    };
    if root.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(reject(
            "This file is not a PeachTerm connections export. Only PeachTerm's own format can be imported.",
        ));
    }
    let version = match root.get("formatVersion") {
        Some(Value::Number(n)) => n.as_u64(),
        _ => None,
    }
    .ok_or_else(|| reject("The file has no valid format version."))?;
    if version == 0 {
        return Err(reject("The file has no valid format version."));
    }
    if version > FORMAT_VERSION {
        return Err(reject(
            "This file was exported by a newer version of PeachTerm. Update PeachTerm to import it.",
        ));
    }
    let mut parsed = Parsed {
        format_version: version,
        exported_at: root
            .get("exportedAt")
            .and_then(Value::as_str)
            .map(|s| s.chars().take(40).collect()),
        ..Parsed::default()
    };
    note_unknown(
        &root,
        &[
            "format",
            "formatVersion",
            "application",
            "exportedAt",
            "folders",
            "connections",
            "notes",
        ],
        "",
        &mut parsed.unsupported_fields,
    );
    let empty = Vec::new();
    let folders = match root.get("folders") {
        None | Some(Value::Null) => &empty,
        Some(Value::Array(a)) => a,
        Some(_) => return Err(reject("\"folders\" must be a list.")),
    };
    let connections = match root.get("connections") {
        None | Some(Value::Null) => &empty,
        Some(Value::Array(a)) => a,
        Some(_) => return Err(reject("\"connections\" must be a list.")),
    };
    if folders.len() > MAX_FOLDERS {
        return Err(reject("The file contains too many folders."));
    }
    if connections.len() > MAX_CONNECTIONS {
        return Err(reject("The file contains too many connections."));
    }

    parse_tree(folders, connections, false, &mut parsed);
    if let Some(Value::Array(list)) = root.get("notes") {
        parse_notes(list, &mut parsed);
    }
    Ok(parsed)
}

/// Validate the notes of a document: bad records are counted and dropped, the
/// rest is kept (duplicates by id keep the first).
pub fn parse_notes(list: &[Value], parsed: &mut Parsed) {
    let mut seen = HashSet::new();
    for (i, v) in list.iter().enumerate() {
        if i >= crate::notes::portable::MAX_INCOMING_NOTES {
            parsed.notes_invalid += list.len() - i;
            break;
        }
        match crate::notes::portable::parse_note(v) {
            Ok(n) if seen.insert(n.id) => parsed.notes.push(n),
            _ => parsed.notes_invalid += 1,
        }
    }
}

/// Validate folders and connections into `parsed.incoming`. With `backup`
/// set the entries come from a decrypted backup: ids are the real local ids
/// and creation/update times are kept.
pub fn parse_tree(folders: &[Value], connections: &[Value], backup: bool, parsed: &mut Parsed) {
    parse_folders(folders, parsed);
    parse_connections(connections, backup, parsed);
}

struct RawFolder {
    index: usize,
    key: String,
    parent: Option<String>,
    name: String,
    expanded: bool,
    order: i64,
}

fn parse_folders(list: &[Value], parsed: &mut Parsed) {
    let mut raw: Vec<RawFolder> = Vec::new();
    let mut seen = HashSet::new();
    for (index, entry) in list.iter().enumerate() {
        let bad = |reason: &str, parsed: &mut Parsed| {
            parsed.invalid.push(InvalidEntry {
                kind: "folder",
                index,
                reason: reason.to_owned(),
            })
        };
        let Value::Object(obj) = entry else {
            bad("not an object", parsed);
            continue;
        };
        note_unknown(
            obj,
            &["id", "name", "parent", "order", "expanded"],
            "folders.",
            &mut parsed.unsupported_fields,
        );
        let result = (|| -> Result<RawFolder, String> {
            let key = clean_ref(get_str(obj, "id")?.ok_or("missing id")?)?;
            let name = required_text(get_str(obj, "name")?.unwrap_or(""), MAX_NAME, "Folder name")
                .map_err(|e| e.to_string())?;
            let parent = get_str(obj, "parent")?.map(clean_ref).transpose()?;
            Ok(RawFolder {
                index,
                key,
                parent,
                name,
                expanded: get_bool(obj, "expanded", true)?,
                order: get_int(obj, "order")?.unwrap_or(index as i64),
            })
        })();
        match result {
            Ok(f) if !seen.insert(f.key.clone()) => bad("duplicate folder id", parsed),
            Ok(f) => raw.push(f),
            Err(reason) => bad(&reason, parsed),
        }
    }

    parsed.raw_parents = raw
        .iter()
        .map(|f| (f.key.clone(), f.parent.clone()))
        .collect();
    // Resolve references, cycles and the nesting limit.
    let verdict_and_valid = {
        let by_key: HashMap<&str, &RawFolder> = raw.iter().map(|f| (f.key.as_str(), f)).collect();
        let mut valid: HashSet<String> = HashSet::new();
        let mut verdict: Vec<(usize, &'static str)> = Vec::new();
        for f in &raw {
            let mut chain = vec![f.key.as_str()];
            let mut cursor = f.parent.as_deref();
            let mut problem = None;
            while let Some(parent) = cursor {
                if chain.contains(&parent) {
                    problem = Some("folder cycle");
                    break;
                }
                match by_key.get(parent) {
                    None => {
                        problem = Some("unknown parent folder");
                        break;
                    }
                    Some(p) => {
                        chain.push(parent);
                        cursor = p.parent.as_deref();
                    }
                }
            }
            if problem.is_none() && chain.len() > MAX_FOLDER_DEPTH {
                problem = Some("nested deeper than PeachTerm supports");
            }
            match problem {
                None => {
                    valid.insert(f.key.clone());
                }
                Some(reason) => verdict.push((f.index, reason)),
            }
        }
        // A folder inside a rejected folder is rejected as well (its chain was
        // already checked above for cycles/depth; here only dangling parents that
        // are themselves invalid remain).
        let mut changed = true;
        while changed {
            changed = false;
            for f in &raw {
                if valid.contains(&f.key) && f.parent.as_deref().is_some_and(|p| !valid.contains(p))
                {
                    valid.remove(&f.key);
                    verdict.push((f.index, "its parent folder is invalid"));
                    changed = true;
                }
            }
        }
        (verdict, valid)
    };
    let (mut verdict, valid) = verdict_and_valid;
    verdict.sort();
    for (index, reason) in verdict {
        parsed.invalid.push(InvalidEntry {
            kind: "folder",
            index,
            reason: reason.to_owned(),
        });
    }
    for f in raw {
        if valid.contains(&f.key) {
            parsed.incoming.folders.push(IncomingFolder {
                id_hint: Uuid::parse_str(&f.key).ok(),
                key: f.key,
                parent: f.parent,
                name: f.name,
                expanded: f.expanded,
                order: f.order,
            });
        }
    }
}

fn parse_connections(list: &[Value], backup: bool, parsed: &mut Parsed) {
    let valid_folders: HashSet<String> = parsed
        .incoming
        .folders
        .iter()
        .map(|f| f.key.clone())
        .collect();
    let mut seen_ids = HashSet::new();
    for (index, entry) in list.iter().enumerate() {
        let bad = |reason: &str, parsed: &mut Parsed| {
            parsed.invalid.push(InvalidEntry {
                kind: "connection",
                index,
                reason: reason.to_owned(),
            })
        };
        let Value::Object(obj) = entry else {
            bad("not an object", parsed);
            continue;
        };
        note_unknown(
            obj,
            &[
                "id",
                "name",
                "protocol",
                "host",
                "port",
                "username",
                "auth",
                "folder",
                "order",
                "savePassword",
                "timeoutSecs",
                "initialDirectory",
                "keyPath",
                "createdAt",
                "updatedAt",
            ],
            "connections.",
            &mut parsed.unsupported_fields,
        );
        let result = (|| -> Result<(IncomingConnection, bool), String> {
            if let Some(protocol) = get_str(obj, "protocol")?
                && protocol != "ssh"
            {
                return Err("unsupported protocol".into());
            }
            let auth = match get_str(obj, "auth")? {
                None => AuthMethod::Password,
                Some(text) => parse_auth(text).ok_or("unsupported authentication mode")?,
            };
            let source_id = get_str(obj, "id")?
                .map(|s| Uuid::parse_str(s).map_err(|_| "invalid id".to_owned()))
                .transpose()?;
            if backup && source_id.is_none() {
                return Err("missing id".into());
            }
            // Exports carry a one-way public id; backups carry the real one.
            let (id_hint, stable_hint) = match (backup, source_id) {
                (true, Some(id)) => (Some(id), Some(public_id(id))),
                (_, id) => (None, id),
            };
            let timestamp = |key: &str| -> Result<Option<u64>, String> {
                if !backup {
                    return Ok(None);
                }
                Ok(get_int(obj, key)?.and_then(|n| u64::try_from(n).ok()))
            };
            let port = get_int(obj, "port")?.unwrap_or(22);
            let timeout = get_int(obj, "timeoutSecs")?.unwrap_or(15);
            let clean = clean_fields(Fields {
                name: get_str(obj, "name")?.unwrap_or(""),
                host: get_str(obj, "host")?.unwrap_or(""),
                port,
                username: get_str(obj, "username")?.unwrap_or(""),
                timeout_secs: timeout,
                key_path: get_str(obj, "keyPath")?,
                initial_directory: get_str(obj, "initialDirectory")?,
            })?;
            let folder_ref = get_str(obj, "folder")?.map(clean_ref).transpose()?;
            let mut relocated = false;
            let folder = match folder_ref {
                None => None,
                Some(key) if valid_folders.contains(&key) => Some(key),
                Some(key) => {
                    // Unknown or unusable folder: keep the profile, move it to
                    // the nearest usable ancestor (or the top level) and say so.
                    relocated = true;
                    let mut cursor = parsed.raw_parents.get(&key).cloned().flatten();
                    let mut hops = 0;
                    let mut found = None;
                    while let Some(k) = cursor {
                        if valid_folders.contains(&k) {
                            found = Some(k);
                            break;
                        }
                        hops += 1;
                        if hops > 64 {
                            break;
                        }
                        cursor = parsed.raw_parents.get(&k).cloned().flatten();
                    }
                    found
                }
            };
            Ok((
                IncomingConnection {
                    id_hint,
                    stable_hint,
                    name: clean.name,
                    host: clean.host,
                    port: clean.port,
                    username: clean.username,
                    auth,
                    key_path: clean.key_path,
                    save_password: get_bool(obj, "savePassword", false)?,
                    timeout_secs: clean.timeout_secs,
                    initial_directory: clean.initial_directory,
                    folder,
                    order: get_int(obj, "order")?.unwrap_or(index as i64),
                    created_at: timestamp("createdAt")?,
                    updated_at: timestamp("updatedAt")?,
                },
                relocated,
            ))
        })();
        match result {
            Ok((c, _)) if c.stable_hint.is_some_and(|id| !seen_ids.insert(id)) => {
                bad("duplicate id", parsed)
            }
            Ok((c, relocated)) => {
                if relocated {
                    parsed.relocated += 1;
                }
                parsed.incoming.connections.push(c);
            }
            Err(reason) => bad(&reason, parsed),
        }
    }
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

fn bare_host(host: &str) -> String {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

pub fn same_endpoint(a: &Connection, b: &IncomingConnection) -> bool {
    a.port == b.port && a.username == b.username && bare_host(&a.host) == bare_host(&b.host)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Match {
    New,
    /// Same profile (by id or by protocol + host + port + user).
    Duplicate(Uuid),
    /// Recognised by id, but its host/port/user differ from the local profile.
    Changed(Uuid),
}

pub fn classify(base: &ConnectionTree, c: &IncomingConnection) -> Match {
    let by_id = base
        .connections
        .iter()
        .find(|e| c.id_hint == Some(e.id) || c.stable_hint.is_some_and(|s| public_id(e.id) == s));
    if let Some(existing) = by_id {
        return if same_endpoint(existing, c) {
            Match::Duplicate(existing.id)
        } else {
            Match::Changed(existing.id)
        };
    }
    match base.connections.iter().find(|e| same_endpoint(e, c)) {
        Some(existing) => Match::Duplicate(existing.id),
        None => Match::New,
    }
}

/// `"Folder / Sub"` for display.
pub fn folder_path(set: &IncomingSet, key: Option<&str>) -> String {
    let mut parts = Vec::new();
    let mut cursor = key;
    while let Some(k) = cursor {
        let Some(f) = set.folders.iter().find(|f| f.key == k) else {
            break;
        };
        parts.push(f.name.clone());
        cursor = f.parent.as_deref();
        if parts.len() > MAX_FOLDER_DEPTH + 2 {
            break;
        }
    }
    parts.reverse();
    parts.join(" / ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyPathState {
    None,
    Present,
    Missing,
    /// Not looked at (relative or network path): see [`key_path_state`].
    Unchecked,
}

/// Whether a key path from a file exists on this machine.
///
/// SECURITY: a path from an untrusted file is only `stat`ed when it is a
/// plain absolute local path. UNC (`\\host\share`) and `//host` paths would
/// make Windows contact a remote server (leaking credential hashes), so they
/// are never touched.
pub fn key_path_state(path: Option<&str>) -> KeyPathState {
    let Some(path) = path else {
        return KeyPathState::None;
    };
    let network = path.starts_with("\\\\") || path.starts_with("//");
    let p = Path::new(path);
    if network || path.contains('\0') || !p.is_absolute() {
        return KeyPathState::Unchecked;
    }
    if p.is_file() {
        KeyPathState::Present
    } else {
        KeyPathState::Missing
    }
}

// ---------------------------------------------------------------------------
// Merge engine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicatePolicy {
    Skip,
    Copy,
    Update,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Created(Uuid),
    Copied(Uuid),
    Updated(Uuid),
    SkippedDuplicate(Uuid),
    /// Recognised, but host/port/user differ: never updated in place.
    SkippedChanged(Uuid),
    NotSelected,
}

impl Outcome {
    /// The final local id when the profile exists afterwards.
    pub fn final_id(self) -> Option<Uuid> {
        match self {
            Outcome::Created(id) | Outcome::Copied(id) | Outcome::Updated(id) => Some(id),
            _ => None,
        }
    }
}

pub struct MergeRequest<'a> {
    pub incoming: &'a IncomingSet,
    /// Indices into `incoming.connections`; `None` = every connection.
    pub selected: Option<&'a HashSet<usize>>,
    pub policy: DuplicatePolicy,
    /// With [`DuplicatePolicy::Update`]: the duplicates the user chose to update.
    pub update: &'a HashSet<usize>,
    /// Keep ids from the source when still free (encrypted backups).
    pub preserve_ids: bool,
    pub now: u64,
}

#[derive(Debug)]
pub struct MergeResult {
    pub tree: ConnectionTree,
    pub outcomes: Vec<Outcome>,
    pub folders_created: usize,
}

fn copy_name(name: &str) -> String {
    const SUFFIX: &str = " (copy)";
    let keep = MAX_NAME - SUFFIX.chars().count();
    let mut out: String = name.chars().take(keep).collect();
    out.push_str(SUFFIX);
    out
}

/// Pure: returns a new tree, never mutates `base`.
pub fn merge(base: &ConnectionTree, req: &MergeRequest<'_>) -> AppResult<MergeResult> {
    let mut tree = base.clone();
    let set = req.incoming;
    let mut outcomes = vec![Outcome::NotSelected; set.connections.len()];
    let is_selected = |i: usize| req.selected.is_none_or(|s| s.contains(&i));

    // 1. Decide every connection against the *original* tree.
    #[derive(Clone, Copy)]
    enum Action {
        Create,
        Copy,
        Update(Uuid),
        None,
    }
    let mut actions = vec![Action::None; set.connections.len()];
    for (i, c) in set.connections.iter().enumerate() {
        if !is_selected(i) {
            continue;
        }
        let (action, outcome) = match classify(base, c) {
            Match::New => (Action::Create, None),
            Match::Duplicate(id) => match req.policy {
                DuplicatePolicy::Skip => (Action::None, Some(Outcome::SkippedDuplicate(id))),
                DuplicatePolicy::Copy => (Action::Copy, None),
                DuplicatePolicy::Update if req.update.contains(&i) => (Action::Update(id), None),
                DuplicatePolicy::Update => (Action::None, Some(Outcome::SkippedDuplicate(id))),
            },
            Match::Changed(id) => match req.policy {
                DuplicatePolicy::Copy => (Action::Copy, None),
                _ => (Action::None, Some(Outcome::SkippedChanged(id))),
            },
        };
        actions[i] = action;
        if let Some(o) = outcome {
            outcomes[i] = o;
        }
    }

    // 2. Which source folders are needed?
    let mut needed: HashSet<String> = HashSet::new();
    let by_key: HashMap<&str, &IncomingFolder> =
        set.folders.iter().map(|f| (f.key.as_str(), f)).collect();
    let mut need_chain = |key: &str| {
        let mut cursor = Some(key);
        while let Some(k) = cursor {
            if !needed.insert(k.to_owned()) {
                break;
            }
            cursor = by_key.get(k).and_then(|f| f.parent.as_deref());
        }
    };
    for (i, c) in set.connections.iter().enumerate() {
        if matches!(actions[i], Action::Create | Action::Copy)
            && let Some(key) = &c.folder
        {
            need_chain(key);
        }
    }
    if req.selected.is_none() {
        // Importing everything also brings folders that hold nothing at all.
        let used: HashSet<&str> = set
            .connections
            .iter()
            .filter_map(|c| c.folder.as_deref())
            .collect();
        let mut has_content: HashSet<&str> = HashSet::new();
        for key in used {
            let mut cursor = Some(key);
            while let Some(k) = cursor {
                if !has_content.insert(k) {
                    break;
                }
                cursor = by_key.get(k).and_then(|f| f.parent.as_deref());
            }
        }
        for f in &set.folders {
            if !has_content.contains(f.key.as_str()) {
                need_chain(&f.key);
            }
        }
    }

    // 3. Map folders (parents first): reuse same-named folders, else create.
    let mut used_ids: HashSet<Uuid> = tree
        .folders
        .iter()
        .map(|f| f.id)
        .chain(tree.connections.iter().map(|c| c.id))
        .collect();
    let mut fresh_id = |hint: Option<Uuid>, preserve: bool| -> Uuid {
        if preserve
            && let Some(id) = hint
            && !used_ids.contains(&id)
        {
            used_ids.insert(id);
            return id;
        }
        loop {
            let id = Uuid::new_v4();
            if used_ids.insert(id) {
                return id;
            }
        }
    };
    let mut mapped: HashMap<String, Uuid> = HashMap::new();
    let mut folders_created = 0usize;
    let mut ordered: Vec<&IncomingFolder> = set
        .folders
        .iter()
        .filter(|f| needed.contains(&f.key))
        .collect();
    ordered.sort_by_key(|f| (f.order, f.name.to_lowercase()));
    // Parents before children, whatever the document order.
    let mut pending = ordered;
    while !pending.is_empty() {
        let before = pending.len();
        let mut rest = Vec::new();
        for f in pending {
            let parent_id = match &f.parent {
                None => Some(None),
                Some(p) => mapped.get(p).map(|id| Some(*id)),
            };
            let Some(parent_id) = parent_id else {
                rest.push(f);
                continue;
            };
            let existing = tree
                .folders
                .iter()
                .find(|e| {
                    e.parent_id == parent_id && e.name.to_lowercase() == f.name.to_lowercase()
                })
                .map(|e| e.id);
            let id = match existing {
                Some(id) => id,
                None => {
                    let level = parent_id.map(|p| tree.folder_level(p)).unwrap_or(0);
                    if level + 1 > MAX_FOLDER_DEPTH {
                        // Cannot nest deeper: contents fall back to the parent.
                        if let Some(p) = parent_id {
                            mapped.insert(f.key.clone(), p);
                        }
                        continue;
                    }
                    let id = fresh_id(f.id_hint, req.preserve_ids);
                    let sort_order = tree.next_order(parent_id, true);
                    tree.folders.push(Folder {
                        id,
                        name: f.name.clone(),
                        parent_id,
                        expanded: f.expanded,
                        sort_order,
                    });
                    folders_created += 1;
                    id
                }
            };
            mapped.insert(f.key.clone(), id);
        }
        if rest.len() == before {
            break; // unreachable for validated input; never loop forever
        }
        pending = rest;
    }

    // 4. Apply connection actions in display order.
    let mut order: Vec<usize> = (0..set.connections.len()).collect();
    order.sort_by_key(|&i| {
        (
            set.connections[i].order,
            set.connections[i].name.to_lowercase(),
        )
    });
    for i in order {
        let c = &set.connections[i];
        match actions[i] {
            Action::None => {}
            Action::Create | Action::Copy => {
                let copy = matches!(actions[i], Action::Copy);
                let folder_id = c.folder.as_ref().and_then(|k| mapped.get(k)).copied();
                let id = fresh_id(c.id_hint, req.preserve_ids && !copy);
                let sort_order = tree.next_order(folder_id, false);
                tree.connections.push(Connection {
                    id,
                    name: if copy {
                        copy_name(&c.name)
                    } else {
                        c.name.clone()
                    },
                    host: c.host.clone(),
                    port: c.port,
                    username: c.username.clone(),
                    auth: c.auth,
                    key_path: c.key_path.clone(),
                    save_password: c.save_password,
                    has_stored_secret: false,
                    timeout_secs: c.timeout_secs,
                    initial_directory: c.initial_directory.clone(),
                    folder_id,
                    sort_order,
                    monitoring: Default::default(),
                    created_at: c.created_at.unwrap_or(req.now),
                    updated_at: c.updated_at.unwrap_or(req.now),
                });
                outcomes[i] = if copy {
                    Outcome::Copied(id)
                } else {
                    Outcome::Created(id)
                };
            }
            Action::Update(id) => {
                // SECURITY: host, port and user are the identity a stored
                // password belongs to; they are never changed here, and
                // neither is `save_password` or the stored-secret flag.
                if let Some(existing) = tree.connections.iter_mut().find(|e| e.id == id) {
                    existing.name = c.name.clone();
                    existing.auth = c.auth;
                    if c.key_path.is_some() {
                        existing.key_path = c.key_path.clone();
                    }
                    existing.timeout_secs = c.timeout_secs;
                    existing.initial_directory = c.initial_directory.clone();
                    existing.updated_at = req.now;
                    outcomes[i] = Outcome::Updated(id);
                }
            }
        }
    }
    if !tree
        .too_deep_folders()
        .iter()
        .all(|id| base.folders.iter().any(|f| f.id == *id))
    {
        return Err(AppError::Validation(
            "The folder structure would exceed the supported depth. Nothing was changed.".into(),
        ));
    }
    Ok(MergeResult {
        tree,
        outcomes,
        folders_created,
    })
}

#[cfg(test)]
mod tests;
