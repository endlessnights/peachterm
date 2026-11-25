// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Persistence of server notes.
//!
//! Layout (inside the configuration folder):
//!
//! ```text
//! notes.json                 metadata + connection<->note relations (small, rewritten atomically)
//! notes/<id>.txt             content of an internal note (Markdown or text)
//! notes/offline/<id>.txt     an explicitly saved offline snapshot of a remote document
//! ```
//!
//! Contents are kept out of `connections.json` and `notes.json` so that editing
//! a note never rewrites the connection list and a large document never slows
//! the metadata down. Every file is written atomically (temp file, flush,
//! rename). Content is written before the metadata that refers to it, so a crash
//! leaves either the old state or the new one, plus at worst an unreferenced
//! content file, which is cleaned up at the next start (only when the metadata
//! loaded without problems, so damaged metadata never causes content to be
//! deleted).

use super::model::*;
use crate::error::{AppError, AppResult};
use crate::portability::fsio;
use crate::storage::atomic::{ConfigIssue, file_label, load_json_value, save_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

/// Attachments of one note (keeps a hand-edited file within reason).
const MAX_ATTACHMENTS_PER_NOTE: usize = 500;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Doc {
    version: u32,
    pub(super) notes: Vec<Note>,
    /// Display order of the notes of each connection.
    pub(super) order: BTreeMap<Uuid, Vec<Uuid>>,
    /// The note that was open last, per connection.
    pub(super) last_selected: BTreeMap<Uuid, Uuid>,
}

/// What the renderer gets to see of a note (never its content).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: Uuid,
    pub title: String,
    pub kind: NoteKind,
    pub format: DocFormat,
    pub source: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub zoom: u16,
    pub offline: Option<OfflineMeta>,
    /// Attached to more than one connection.
    pub shared: bool,
    /// The other connections it is attached to.
    pub shared_with: Vec<Uuid>,
    /// Attached to no connection at all (kept, never silently deleted).
    pub orphan: bool,
}

pub struct NotesStore {
    dir: PathBuf,
    meta: PathBuf,
    doc: Mutex<Doc>,
    issues: Vec<ConfigIssue>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn lenient(entry: &Value) -> Option<Note> {
    let mut n: Note = serde_json::from_value(entry.clone()).ok()?;
    n.title = clean_title(&n.title).ok()?;
    n.zoom = clamp_zoom(u32::from(n.zoom));
    match n.kind {
        NoteKind::Internal => n.source = None,
        NoteKind::LocalFile | NoteKind::RemoteUrl => {
            let s = n.source.as_deref()?;
            if s.is_empty() || s.chars().count() > MAX_SOURCE_CHARS || s.contains('\0') {
                return None;
            }
        }
    }
    let mut seen = HashSet::new();
    n.connections.retain(|c| seen.insert(*c));
    n.connections.truncate(MAX_ATTACHMENTS_PER_NOTE);
    if n.kind != NoteKind::RemoteUrl {
        n.offline = None;
    }
    Some(n)
}

impl NotesStore {
    /// `config_dir` is the application's configuration folder.
    pub fn open(config_dir: &Path) -> AppResult<Self> {
        let meta = config_dir.join("notes.json");
        let dir = config_dir.join("notes");
        let mut issues = Vec::new();
        let mut doc = Doc {
            version: 1,
            ..Doc::default()
        };
        let mut clean_load = true;
        match load_json_value(&meta, &mut issues) {
            Some(Value::Object(map)) => {
                let mut seen = HashSet::new();
                if let Some(Value::Array(entries)) = map.get("notes") {
                    for entry in entries {
                        match lenient(entry) {
                            Some(n) if seen.insert(n.id) && doc.notes.len() < MAX_NOTES_TOTAL => {
                                doc.notes.push(n);
                            }
                            _ => clean_load = false,
                        }
                    }
                }
                let ids: HashSet<Uuid> = doc.notes.iter().map(|n| n.id).collect();
                if let Some(v) = map.get("order")
                    && let Ok(order) =
                        serde_json::from_value::<BTreeMap<Uuid, Vec<Uuid>>>(v.clone())
                {
                    doc.order = order
                        .into_iter()
                        .map(|(c, list)| {
                            (c, list.into_iter().filter(|i| ids.contains(i)).collect())
                        })
                        .collect();
                }
                if let Some(v) = map.get("lastSelected")
                    && let Ok(last) = serde_json::from_value::<BTreeMap<Uuid, Uuid>>(v.clone())
                {
                    doc.last_selected = last.into_iter().filter(|(_, n)| ids.contains(n)).collect();
                }
                if !clean_load {
                    issues.push(ConfigIssue {
                        file: file_label(&meta),
                        kind: "invalid_entries",
                        field: None,
                        backed_up: false,
                    });
                }
            }
            Some(_) => {
                clean_load = false;
                issues.push(ConfigIssue {
                    file: file_label(&meta),
                    kind: "not_an_object",
                    field: None,
                    backed_up: false,
                });
            }
            None => {
                // no file yet, or unreadable/corrupt (the loader kept a backup and reported it)
                clean_load = !meta.exists();
            }
        }
        let store = Self {
            dir,
            meta,
            doc: Mutex::new(doc),
            issues,
        };
        if clean_load {
            store.collect_garbage();
        }
        Ok(store)
    }

    pub fn issues(&self) -> &[ConfigIssue] {
        &self.issues
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Doc>> {
        self.doc
            .lock()
            .map_err(|_| AppError::Storage("notes lock poisoned".into()))
    }

    pub(super) fn with_doc(&self, f: impl FnOnce(&mut Doc) -> AppResult<()>) -> AppResult<()> {
        self.update(f)
    }

    pub(super) fn content_file(&self, id: Uuid) -> PathBuf {
        self.content_path(id)
    }

    pub(super) fn offline_file(&self, id: Uuid) -> PathBuf {
        self.offline_path(id)
    }

    /// Where an internal note's text lives (the folder is created on demand).
    fn content_path(&self, id: Uuid) -> PathBuf {
        let _ = std::fs::create_dir_all(&self.dir);
        self.dir.join(format!("{id}.txt"))
    }

    fn offline_path(&self, id: Uuid) -> PathBuf {
        let folder = self.dir.join("offline");
        let _ = std::fs::create_dir_all(&folder);
        folder.join(format!("{id}.txt"))
    }

    fn persist(&self, doc: &Doc) -> AppResult<()> {
        save_json(&self.meta, doc)
    }

    /// Remove content files that no note refers to (left by an interrupted write).
    fn collect_garbage(&self) {
        let Ok(doc) = self.lock() else { return };
        let internal: HashSet<String> = doc
            .notes
            .iter()
            .filter(|n| n.kind == NoteKind::Internal)
            .map(|n| format!("{}.txt", n.id))
            .collect();
        let offline: HashSet<String> = doc
            .notes
            .iter()
            .filter(|n| n.offline.is_some())
            .map(|n| format!("{}.txt", n.id))
            .collect();
        for (folder, keep) in [
            (self.dir.clone(), internal),
            (self.dir.join("offline"), offline),
        ] {
            let Ok(entries) = std::fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let ours = name.ends_with(".txt") || name.contains(".tmp");
                if entry.path().is_file() && ours && !keep.contains(&name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    fn summary(n: &Note, viewing: Option<Uuid>) -> NoteSummary {
        NoteSummary {
            id: n.id,
            title: n.title.clone(),
            kind: n.kind,
            format: n.format,
            source: n.source.clone(),
            created_at: n.created_at,
            updated_at: n.updated_at,
            zoom: n.zoom,
            offline: n.offline,
            shared: n.connections.len() > 1,
            shared_with: n
                .connections
                .iter()
                .copied()
                .filter(|c| Some(*c) != viewing)
                .collect(),
            orphan: n.connections.is_empty(),
        }
    }

    // ---- reading ------------------------------------------------------------

    /// The notes of a connection in display order.
    pub fn list_for_connection(&self, connection: Uuid) -> AppResult<Vec<NoteSummary>> {
        let doc = self.lock()?;
        let mut mine: Vec<&Note> = doc
            .notes
            .iter()
            .filter(|n| n.connections.contains(&connection))
            .collect();
        let order = doc.order.get(&connection);
        mine.sort_by_key(|n| {
            (
                order
                    .and_then(|o| o.iter().position(|i| *i == n.id))
                    .unwrap_or(usize::MAX),
                n.created_at,
            )
        });
        Ok(mine
            .into_iter()
            .map(|n| Self::summary(n, Some(connection)))
            .collect())
    }

    /// Every note, for "attach an existing note" (includes orphans).
    pub fn list_all(&self) -> AppResult<Vec<NoteSummary>> {
        let doc = self.lock()?;
        Ok(doc.notes.iter().map(|n| Self::summary(n, None)).collect())
    }

    /// How many notes each connection has (no titles, no content).
    pub fn counts(&self) -> AppResult<HashMap<Uuid, usize>> {
        let doc = self.lock()?;
        let mut out: HashMap<Uuid, usize> = HashMap::new();
        for n in &doc.notes {
            for c in &n.connections {
                *out.entry(*c).or_default() += 1;
            }
        }
        Ok(out)
    }

    pub fn get(&self, id: Uuid) -> AppResult<Note> {
        self.lock()?
            .notes
            .iter()
            .find(|n| n.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("note".into()))
    }

    pub fn last_selected(&self, connection: Uuid) -> AppResult<Option<Uuid>> {
        Ok(self.lock()?.last_selected.get(&connection).copied())
    }

    /// Content of an internal note.
    pub fn read_internal(&self, id: Uuid) -> AppResult<String> {
        let note = self.get(id)?;
        if note.kind != NoteKind::Internal {
            return Err(AppError::Validation("This note has no stored text.".into()));
        }
        match std::fs::read(self.content_path(id)) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(_) => Err(AppError::storage_key(
                "notes.readFailed",
                "The note could not be read.",
            )),
        }
    }

    pub fn read_offline(&self, id: Uuid) -> AppResult<Option<String>> {
        let note = self.get(id)?;
        if note.offline.is_none() {
            return Ok(None);
        }
        match std::fs::read(self.offline_path(id)) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(_) => Ok(None),
        }
    }

    // ---- creating -----------------------------------------------------------

    fn check_room(doc: &Doc, connection: Uuid) -> AppResult<()> {
        if doc.notes.len() >= MAX_NOTES_TOTAL {
            return Err(AppError::Validation(format!(
                "PeachTerm keeps at most {MAX_NOTES_TOTAL} notes."
            )));
        }
        Self::check_connection_room(doc, connection)
    }

    fn check_connection_room(doc: &Doc, connection: Uuid) -> AppResult<()> {
        let n = doc
            .notes
            .iter()
            .filter(|n| n.connections.contains(&connection))
            .count();
        if n >= MAX_NOTES_PER_CONNECTION {
            return Err(AppError::Validation(format!(
                "A connection can have at most {MAX_NOTES_PER_CONNECTION} notes."
            )));
        }
        Ok(())
    }

    fn insert(&self, doc: &mut Doc, note: Note, connection: Uuid) {
        doc.order.entry(connection).or_default().push(note.id);
        doc.last_selected.insert(connection, note.id);
        doc.notes.push(note);
    }

    pub fn create_internal(
        &self,
        connection: Uuid,
        title: &str,
        format: DocFormat,
        content: &str,
    ) -> AppResult<Note> {
        if format == DocFormat::Html {
            return Err(AppError::Validation(
                "Typed notes are Markdown or plain text.".into(),
            ));
        }
        let title = clean_title(title)?;
        check_note_content(content)?;
        let mut doc = self.lock()?;
        Self::check_room(&doc, connection)?;
        let now = now_secs();
        let note = Note {
            id: Uuid::new_v4(),
            title,
            kind: NoteKind::Internal,
            format,
            source: None,
            created_at: now,
            updated_at: now,
            connections: vec![connection],
            zoom: ZOOM_DEFAULT,
            offline: None,
        };
        fsio::write_atomic(&self.content_path(note.id), content.as_bytes(), true)?;
        let mut next = doc.clone();
        self.insert(&mut next, note.clone(), connection);
        if let Err(e) = self.persist(&next) {
            let _ = std::fs::remove_file(self.content_path(note.id));
            return Err(e);
        }
        *doc = next;
        Ok(note)
    }

    /// A reference to a local file or a URL. Only the reference is stored.
    pub fn create_link(
        &self,
        connection: Uuid,
        title: &str,
        kind: NoteKind,
        format: DocFormat,
        source: &str,
    ) -> AppResult<Note> {
        if kind == NoteKind::Internal {
            return Err(AppError::Validation("Not a linked document.".into()));
        }
        let title = clean_title(title)?;
        if source.is_empty() || source.chars().count() > MAX_SOURCE_CHARS || source.contains('\0') {
            return Err(AppError::Validation(
                "The document reference is not valid.".into(),
            ));
        }
        let mut doc = self.lock()?;
        Self::check_room(&doc, connection)?;
        let now = now_secs();
        let note = Note {
            id: Uuid::new_v4(),
            title,
            kind,
            format,
            source: Some(source.to_owned()),
            created_at: now,
            updated_at: now,
            connections: vec![connection],
            zoom: ZOOM_DEFAULT,
            offline: None,
        };
        let mut next = doc.clone();
        self.insert(&mut next, note.clone(), connection);
        self.persist(&next)?;
        *doc = next;
        Ok(note)
    }

    // ---- changing -----------------------------------------------------------

    /// Replace the text of an internal note (autosave calls this).
    pub fn write_internal(&self, id: Uuid, content: &str) -> AppResult<()> {
        check_note_content(content)?;
        let mut doc = self.lock()?;
        let i = doc
            .notes
            .iter()
            .position(|n| n.id == id)
            .ok_or_else(|| AppError::NotFound("note".into()))?;
        if doc.notes[i].kind != NoteKind::Internal {
            return Err(AppError::Validation(
                "Only notes written in PeachTerm can be edited here.".into(),
            ));
        }
        fsio::write_atomic(&self.content_path(id), content.as_bytes(), true)?;
        let mut next = doc.clone();
        next.notes[i].updated_at = now_secs();
        self.persist(&next)?;
        *doc = next;
        Ok(())
    }

    fn update<T>(&self, f: impl FnOnce(&mut Doc) -> AppResult<T>) -> AppResult<T> {
        let mut doc = self.lock()?;
        let mut next = doc.clone();
        let out = f(&mut next)?;
        self.persist(&next)?;
        *doc = next;
        Ok(out)
    }

    fn note_mut(doc: &mut Doc, id: Uuid) -> AppResult<&mut Note> {
        doc.notes
            .iter_mut()
            .find(|n| n.id == id)
            .ok_or_else(|| AppError::NotFound("note".into()))
    }

    pub fn rename(&self, id: Uuid, title: &str) -> AppResult<()> {
        let title = clean_title(title)?;
        self.update(|d| {
            let n = Self::note_mut(d, id)?;
            n.title = title;
            n.updated_at = now_secs();
            Ok(())
        })
    }

    pub fn set_zoom(&self, id: Uuid, zoom: u32) -> AppResult<u16> {
        let z = clamp_zoom(zoom);
        self.update(|d| {
            Self::note_mut(d, id)?.zoom = z;
            Ok(z)
        })
    }

    pub fn set_source(&self, id: Uuid, source: &str, format: DocFormat) -> AppResult<()> {
        if source.is_empty() || source.chars().count() > MAX_SOURCE_CHARS || source.contains('\0') {
            return Err(AppError::Validation(
                "The document reference is not valid.".into(),
            ));
        }
        self.update(|d| {
            let n = Self::note_mut(d, id)?;
            if n.kind != NoteKind::LocalFile {
                return Err(AppError::Validation(
                    "Only linked files can be relocated.".into(),
                ));
            }
            n.source = Some(source.to_owned());
            n.format = format;
            Ok(())
        })
    }

    /// Remember the format a remote document turned out to have.
    pub fn set_format(&self, id: Uuid, format: DocFormat) -> AppResult<()> {
        let current = self.get(id)?;
        if current.format == format {
            return Ok(());
        }
        self.update(|d| {
            Self::note_mut(d, id)?.format = format;
            Ok(())
        })
    }

    pub fn select(&self, connection: Uuid, id: Uuid) -> AppResult<()> {
        self.update(|d| {
            if !Self::note_mut(d, id)?.connections.contains(&connection) {
                return Err(AppError::NotFound("note".into()));
            }
            d.last_selected.insert(connection, id);
            Ok(())
        })
    }

    pub fn reorder(&self, connection: Uuid, ids: &[Uuid]) -> AppResult<()> {
        self.update(|d| {
            let mine: HashSet<Uuid> = d
                .notes
                .iter()
                .filter(|n| n.connections.contains(&connection))
                .map(|n| n.id)
                .collect();
            let mut seen = HashSet::new();
            let mut order: Vec<Uuid> = ids
                .iter()
                .copied()
                .filter(|i| mine.contains(i) && seen.insert(*i))
                .collect();
            for n in d.notes.iter().filter(|n| mine.contains(&n.id)) {
                if seen.insert(n.id) {
                    order.push(n.id);
                }
            }
            d.order.insert(connection, order);
            Ok(())
        })
    }

    // ---- sharing ------------------------------------------------------------

    pub fn attach(&self, id: Uuid, connection: Uuid) -> AppResult<()> {
        self.update(|d| {
            if d.notes
                .iter()
                .find(|n| n.id == id)
                .ok_or_else(|| AppError::NotFound("note".into()))?
                .connections
                .contains(&connection)
            {
                return Ok(());
            }
            Self::check_connection_room(d, connection)?;
            let n = Self::note_mut(d, id)?;
            if n.connections.len() >= MAX_ATTACHMENTS_PER_NOTE {
                return Err(AppError::Validation(
                    "This note is attached to too many connections.".into(),
                ));
            }
            n.connections.push(connection);
            d.order.entry(connection).or_default().push(id);
            Ok(())
        })
    }

    /// Detach from ONE connection. The note itself (and its other attachments) stay.
    pub fn detach(&self, id: Uuid, connection: Uuid) -> AppResult<()> {
        self.update(|d| {
            let n = Self::note_mut(d, id)?;
            n.connections.retain(|c| *c != connection);
            if let Some(o) = d.order.get_mut(&connection) {
                o.retain(|i| *i != id);
            }
            if d.last_selected.get(&connection) == Some(&id) {
                d.last_selected.remove(&connection);
            }
            Ok(())
        })
    }

    /// A deleted connection loses its attachments; documents still used by other
    /// connections are untouched and documents used by no one are KEPT (orphans).
    pub fn detach_connection(&self, connection: Uuid) -> AppResult<()> {
        let touched = self
            .lock()?
            .notes
            .iter()
            .any(|n| n.connections.contains(&connection));
        if !touched {
            return Ok(());
        }
        self.update(|d| {
            for n in &mut d.notes {
                n.connections.retain(|c| *c != connection);
            }
            d.order.remove(&connection);
            d.last_selected.remove(&connection);
            Ok(())
        })
    }

    /// Delete the document everywhere (the caller asked for it explicitly).
    pub fn delete(&self, id: Uuid) -> AppResult<()> {
        let note = self.get(id)?;
        self.update(|d| {
            d.notes.retain(|n| n.id != id);
            for o in d.order.values_mut() {
                o.retain(|i| *i != id);
            }
            d.last_selected.retain(|_, n| *n != id);
            Ok(())
        })?;
        // The metadata no longer refers to the files; removing them is best effort
        // (anything left behind is collected at the next start).
        if note.kind == NoteKind::Internal {
            let _ = std::fs::remove_file(self.content_path(id));
        }
        let _ = std::fs::remove_file(self.offline_path(id));
        Ok(())
    }

    // ---- offline snapshots --------------------------------------------------

    pub fn save_offline(&self, id: Uuid, text: &str, format: DocFormat) -> AppResult<OfflineMeta> {
        if text.len() > MAX_DOC_BYTES {
            return Err(AppError::Validation(
                "This document is too large to save offline.".into(),
            ));
        }
        let note = self.get(id)?;
        if note.kind != NoteKind::RemoteUrl {
            return Err(AppError::Validation(
                "Only web documents can be saved offline.".into(),
            ));
        }
        let path = self.offline_path(id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        fsio::write_atomic(&path, text.as_bytes(), true)?;
        let meta = OfflineMeta {
            saved_at: now_secs(),
            bytes: text.len() as u64,
            format,
        };
        let result = self.update(|d| {
            Self::note_mut(d, id)?.offline = Some(meta);
            Ok(())
        });
        if result.is_err() && note.offline.is_none() {
            let _ = std::fs::remove_file(&path);
        }
        result.map(|()| meta)
    }

    pub fn remove_offline(&self, id: Uuid) -> AppResult<()> {
        self.update(|d| {
            Self::note_mut(d, id)?.offline = None;
            Ok(())
        })?;
        let _ = std::fs::remove_file(self.offline_path(id));
        Ok(())
    }

    // ---- used by portability ------------------------------------------------

    pub(crate) fn snapshot_doc(&self) -> AppResult<Vec<Note>> {
        Ok(self.lock()?.notes.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, NotesStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = NotesStore::open(dir.path()).unwrap();
        (dir, s)
    }

    fn ids() -> (Uuid, Uuid) {
        (Uuid::new_v4(), Uuid::new_v4())
    }

    #[test]
    fn create_edit_read_markdown_and_text_notes() {
        let (_d, s) = store();
        let (a, _) = ids();
        let md = s
            .create_internal(a, "  Commands ", DocFormat::Markdown, "# Hi\n")
            .unwrap();
        let tx = s
            .create_internal(a, "Plain", DocFormat::Text, "ls -la")
            .unwrap();
        assert_eq!(md.title, "Commands");
        assert_eq!(s.read_internal(md.id).unwrap(), "# Hi\n");
        s.write_internal(md.id, "# Changed\n`x`").unwrap();
        assert_eq!(s.read_internal(md.id).unwrap(), "# Changed\n`x`");
        assert_eq!(s.read_internal(tx.id).unwrap(), "ls -la");
        let list = s.list_for_connection(a).unwrap();
        assert_eq!(
            list.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(),
            ["Commands", "Plain"]
        );
        assert!(s.create_internal(a, "x", DocFormat::Html, "").is_err());
    }

    #[test]
    fn a_shared_note_is_stored_once_and_edits_reach_every_connection() {
        let (_d, s) = store();
        let (a, b) = ids();
        let n = s
            .create_internal(a, "VPS commands", DocFormat::Markdown, "v1")
            .unwrap();
        s.attach(n.id, b).unwrap();
        s.attach(n.id, b).unwrap(); // idempotent
        assert_eq!(s.snapshot_doc().unwrap().len(), 1);
        let la = s.list_for_connection(a).unwrap();
        let lb = s.list_for_connection(b).unwrap();
        assert!(la[0].shared && lb[0].shared);
        assert_eq!(la[0].shared_with, vec![b]);
        assert_eq!(lb[0].shared_with, vec![a]);
        s.write_internal(n.id, "v2").unwrap();
        assert_eq!(s.read_internal(lb[0].id).unwrap(), "v2");
        assert_eq!(s.counts().unwrap()[&a], 1);
        assert_eq!(s.counts().unwrap()[&b], 1);
    }

    #[test]
    fn detaching_removes_it_from_one_connection_only_and_deleting_is_global() {
        let (d, s) = store();
        let (a, b) = ids();
        let n = s
            .create_internal(a, "Shared", DocFormat::Markdown, "keep me")
            .unwrap();
        s.attach(n.id, b).unwrap();
        s.detach(n.id, a).unwrap();
        assert!(s.list_for_connection(a).unwrap().is_empty());
        assert_eq!(s.list_for_connection(b).unwrap().len(), 1);
        assert_eq!(s.read_internal(n.id).unwrap(), "keep me");
        // detaching the last one leaves an orphan, never a silent deletion
        s.detach(n.id, b).unwrap();
        let all = s.list_all().unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].orphan);
        assert_eq!(s.read_internal(n.id).unwrap(), "keep me");
        s.delete(n.id).unwrap();
        assert!(s.list_all().unwrap().is_empty());
        assert!(
            !d.path()
                .join("notes")
                .join(format!("{}.txt", n.id))
                .exists()
        );
    }

    #[test]
    fn deleting_a_connection_keeps_documents_other_connections_use() {
        let (_d, s) = store();
        let (a, b) = ids();
        let shared = s
            .create_internal(a, "Shared", DocFormat::Markdown, "s")
            .unwrap();
        s.attach(shared.id, b).unwrap();
        let only_a = s
            .create_internal(a, "Only A", DocFormat::Text, "a")
            .unwrap();
        s.detach_connection(a).unwrap();
        assert_eq!(s.list_for_connection(b).unwrap().len(), 1);
        assert_eq!(s.read_internal(shared.id).unwrap(), "s");
        // the note only A used survives as an orphan with its content
        let orphan = s
            .list_all()
            .unwrap()
            .into_iter()
            .find(|n| n.id == only_a.id)
            .unwrap();
        assert!(orphan.orphan);
        assert_eq!(s.read_internal(only_a.id).unwrap(), "a");
        // and can be attached again
        s.attach(only_a.id, b).unwrap();
        assert_eq!(s.list_for_connection(b).unwrap().len(), 2);
    }

    #[test]
    fn order_selection_and_rename_persist() {
        let dir = tempfile::tempdir().unwrap();
        let (a, _) = ids();
        let (n1, n2, n3);
        {
            let s = NotesStore::open(dir.path()).unwrap();
            n1 = s
                .create_internal(a, "One", DocFormat::Text, "1")
                .unwrap()
                .id;
            n2 = s
                .create_internal(a, "Two", DocFormat::Text, "2")
                .unwrap()
                .id;
            n3 = s
                .create_internal(a, "Three", DocFormat::Text, "3")
                .unwrap()
                .id;
            s.reorder(a, &[n3, n1]).unwrap();
            s.rename(n2, "Second").unwrap();
            s.select(a, n2).unwrap();
            assert_eq!(s.set_zoom(n1, 400).unwrap(), 200);
            assert_eq!(s.set_zoom(n1, 10).unwrap(), 50);
            s.set_zoom(n1, 130).unwrap();
        }
        let s = NotesStore::open(dir.path()).unwrap();
        let titles: Vec<_> = s
            .list_for_connection(a)
            .unwrap()
            .into_iter()
            .map(|n| n.title)
            .collect();
        assert_eq!(titles, ["Three", "One", "Second"]);
        assert_eq!(s.last_selected(a).unwrap(), Some(n2));
        assert_eq!(s.get(n1).unwrap().zoom, 130);
    }

    #[test]
    fn sizes_and_counts_are_limited() {
        let (_d, s) = store();
        let (a, _) = ids();
        let big = "x".repeat(MAX_NOTE_BYTES + 1);
        assert!(s.create_internal(a, "Big", DocFormat::Text, &big).is_err());
        let n = s.create_internal(a, "ok", DocFormat::Text, "").unwrap();
        assert!(s.write_internal(n.id, &big).is_err());
        assert_eq!(
            s.read_internal(n.id).unwrap(),
            "",
            "a refused write changes nothing"
        );
        for i in 1..MAX_NOTES_PER_CONNECTION {
            s.create_link(
                a,
                &format!("L{i}"),
                NoteKind::RemoteUrl,
                DocFormat::Markdown,
                "https://example.com/a.md",
            )
            .unwrap();
        }
        let err = s
            .create_internal(a, "one too many", DocFormat::Text, "")
            .unwrap_err();
        assert!(err.to_string().contains("at most"), "{err}");
        assert!(
            s.create_link(a, "", NoteKind::LocalFile, DocFormat::Text, "C:\\x.txt")
                .is_err()
        );
        assert!(
            s.create_link(a, "t", NoteKind::LocalFile, DocFormat::Text, "")
                .is_err()
        );
    }

    #[test]
    fn corrupt_or_hand_edited_metadata_never_loses_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let a = Uuid::new_v4();
        let keep;
        {
            let s = NotesStore::open(dir.path()).unwrap();
            keep = s
                .create_internal(a, "Keep", DocFormat::Text, "content")
                .unwrap()
                .id;
        }
        // one good entry, one with an invalid kind, one without a title
        let text = std::fs::read_to_string(dir.path().join("notes.json")).unwrap();
        let mut v: Value = serde_json::from_str(&text).unwrap();
        let arr = v["notes"].as_array_mut().unwrap();
        arr.push(serde_json::json!({"id": Uuid::new_v4(), "title":"x","kind":"evil","format":"text","createdAt":1,"updatedAt":1}));
        arr.push(serde_json::json!({"id": Uuid::new_v4(), "title":"  ","kind":"internal","format":"text","createdAt":1,"updatedAt":1}));
        std::fs::write(
            dir.path().join("notes.json"),
            serde_json::to_vec(&v).unwrap(),
        )
        .unwrap();
        let s = NotesStore::open(dir.path()).unwrap();
        assert_eq!(s.list_all().unwrap().len(), 1);
        assert_eq!(s.read_internal(keep).unwrap(), "content");
        assert_eq!(s.issues().len(), 1);
        // a file that is not JSON at all: nothing is deleted, the original is kept aside
        std::fs::write(dir.path().join("notes.json"), b"\x00 not json").unwrap();
        let s = NotesStore::open(dir.path()).unwrap();
        assert!(s.list_all().unwrap().is_empty());
        assert!(
            dir.path()
                .join("notes")
                .join(format!("{keep}.txt"))
                .exists(),
            "content must survive damaged metadata"
        );
        assert!(!s.issues().is_empty());
    }

    #[test]
    fn leftovers_of_an_interrupted_write_are_collected_only_after_a_clean_load() {
        let dir = tempfile::tempdir().unwrap();
        let a = Uuid::new_v4();
        let s = NotesStore::open(dir.path()).unwrap();
        let n = s.create_internal(a, "n", DocFormat::Text, "x").unwrap();
        drop(s);
        let stray = dir
            .path()
            .join("notes")
            .join(format!("{}.txt", Uuid::new_v4()));
        std::fs::write(&stray, b"left over").unwrap();
        let _ = NotesStore::open(dir.path()).unwrap();
        assert!(!stray.exists());
        assert!(
            dir.path()
                .join("notes")
                .join(format!("{}.txt", n.id))
                .exists()
        );
    }

    #[test]
    fn offline_snapshots_are_explicit_removable_and_only_for_web_documents() {
        let (d, s) = store();
        let a = Uuid::new_v4();
        let web = s
            .create_link(
                a,
                "README",
                NoteKind::RemoteUrl,
                DocFormat::Markdown,
                "https://example.com/README.md",
            )
            .unwrap();
        assert!(
            s.read_offline(web.id).unwrap().is_none(),
            "nothing is stored by default"
        );
        let meta = s
            .save_offline(web.id, "# Saved", DocFormat::Markdown)
            .unwrap();
        assert_eq!(meta.bytes, 7);
        assert_eq!(s.read_offline(web.id).unwrap().as_deref(), Some("# Saved"));
        assert!(s.list_for_connection(a).unwrap()[0].offline.is_some());
        s.remove_offline(web.id).unwrap();
        assert!(s.read_offline(web.id).unwrap().is_none());
        assert!(
            !d.path()
                .join("notes/offline")
                .join(format!("{}.txt", web.id))
                .exists()
        );
        let local = s
            .create_link(a, "File", NoteKind::LocalFile, DocFormat::Text, "C:\\a.txt")
            .unwrap();
        assert!(s.save_offline(local.id, "x", DocFormat::Text).is_err());
        let internal = s.create_internal(a, "I", DocFormat::Text, "").unwrap();
        assert!(s.save_offline(internal.id, "x", DocFormat::Text).is_err());
        assert!(
            s.save_offline(web.id, &"x".repeat(MAX_DOC_BYTES + 1), DocFormat::Text)
                .is_err()
        );
    }

    #[test]
    fn linked_documents_store_only_the_reference() {
        let (d, s) = store();
        let a = Uuid::new_v4();
        let n = s
            .create_link(
                a,
                "Guide",
                NoteKind::LocalFile,
                DocFormat::Html,
                "C:\\docs\\guide.html",
            )
            .unwrap();
        assert!(
            s.read_internal(n.id).is_err(),
            "no copy of the file is kept"
        );
        let any_content = std::fs::read_dir(d.path().join("notes"))
            .map(|r| r.count())
            .unwrap_or(0);
        assert_eq!(any_content, 0);
        s.set_source(n.id, "D:\\moved\\guide.html", DocFormat::Html)
            .unwrap();
        assert_eq!(
            s.get(n.id).unwrap().source.as_deref(),
            Some("D:\\moved\\guide.html")
        );
    }

    #[test]
    fn a_failed_metadata_write_leaves_no_half_created_note() {
        let dir = tempfile::tempdir().unwrap();
        let s = NotesStore::open(dir.path()).unwrap();
        let a = Uuid::new_v4();
        // make the metadata path a directory so that saving it must fail
        std::fs::create_dir(dir.path().join("notes.json")).unwrap();
        let err = s.create_internal(a, "n", DocFormat::Text, "x");
        assert!(err.is_err());
        assert!(s.list_all().unwrap().is_empty(), "memory state unchanged");
        let leftovers = std::fs::read_dir(dir.path().join("notes"))
            .map(|r| r.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "the content file was removed again");
    }
}
