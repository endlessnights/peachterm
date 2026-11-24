// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Notes inside connection exports and encrypted backups.
//!
//! * The default JSON export carries NO notes. With the explicit option it
//!   carries internal note contents, titles, relations, URLs and the *paths* of
//!   linked files (never the contents of linked files). Offline snapshots only
//!   with a second explicit option.
//! * Encrypted backups carry everything PeachTerm itself stores: internal notes,
//!   relations, URLs, linked-file paths and saved offline snapshots.
//! * Nothing is ever fetched while exporting, importing, backing up or restoring,
//!   and imported HTML is stored as text, never executed.
//! * Importing never overwrites an existing note: a note that already exists
//!   (same id) keeps its content and only gains attachments to the connections
//!   that were restored in this run.

use super::model::*;
use super::remote;
use super::store::NotesStore;
use crate::error::{AppError, AppResult};
use crate::portability::fsio;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub const MAX_INCOMING_NOTES: usize = MAX_NOTES_TOTAL;
const MAX_LINKS_PER_NOTE: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableNote {
    pub id: Uuid,
    pub title: String,
    pub kind: NoteKind,
    pub format: DocFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub zoom: u16,
    /// Connection ids in the id space of the document (public ids in a JSON
    /// export, local ids in a backup).
    pub connections: Vec<Uuid>,
    /// Internal notes only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// An explicitly saved offline snapshot of a web document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_saved_at: Option<u64>,
}

/// Validate one record of an imported document. Anything doubtful is refused.
pub fn parse_note(value: &Value) -> Result<PortableNote, String> {
    let mut n: PortableNote =
        serde_json::from_value(value.clone()).map_err(|_| "not a valid note".to_owned())?;
    n.title = clean_title(&n.title).map_err(|_| "invalid title".to_owned())?;
    n.zoom = clamp_zoom(u32::from(n.zoom));
    let mut seen = HashSet::new();
    n.connections.retain(|c| seen.insert(*c));
    if n.connections.len() > MAX_LINKS_PER_NOTE {
        return Err("too many attachments".into());
    }
    match n.kind {
        NoteKind::Internal => {
            n.source = None;
            n.snapshot = None;
            n.snapshot_saved_at = None;
            if n.format == DocFormat::Html {
                return Err("typed notes are Markdown or text".into());
            }
            let content = n.content.as_deref().unwrap_or("");
            check_note_content(content).map_err(|_| "note too large".to_owned())?;
            n.content = Some(content.to_owned());
        }
        NoteKind::LocalFile => {
            n.content = None;
            n.snapshot = None;
            n.snapshot_saved_at = None;
            let src = n.source.as_deref().ok_or("missing file path")?;
            if src.is_empty() || src.chars().count() > MAX_SOURCE_CHARS || src.contains('\0') {
                return Err("invalid file path".into());
            }
            let ext = std::path::Path::new(src)
                .extension()
                .and_then(|e| e.to_str())
                .and_then(DocFormat::from_extension);
            if ext != Some(n.format) {
                return Err("unsupported file type".into());
            }
        }
        NoteKind::RemoteUrl => {
            n.content = None;
            let src = n.source.as_deref().ok_or("missing address")?;
            let url = remote::normalize(src).map_err(|_| "unsafe or invalid address".to_owned())?;
            n.source = Some(url.to_string());
            if let Some(s) = &n.snapshot {
                if s.len() > MAX_DOC_BYTES || s.contains('\0') {
                    return Err("snapshot too large".into());
                }
            } else {
                n.snapshot_saved_at = None;
            }
        }
    }
    Ok(n)
}

/// What a restore or import would do with the notes (counts only, no content).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesPreview {
    pub notes: usize,
    pub internal: usize,
    pub linked_files: usize,
    pub web_documents: usize,
    pub snapshots: usize,
    pub shared: usize,
    /// Linked local files that do not exist on this computer.
    pub missing_files: usize,
    /// A note with the same id already exists here (it will be kept as it is).
    pub conflicts: usize,
    /// Notes whose connections are not part of this run (they would be left out).
    pub unattached: usize,
}

pub fn preview(
    store: &NotesStore,
    incoming: &[PortableNote],
    mapping: &HashMap<Uuid, Uuid>,
) -> AppResult<NotesPreview> {
    let existing: HashMap<Uuid, super::store::NoteSummary> =
        store.list_all()?.into_iter().map(|s| (s.id, s)).collect();
    let mut p = NotesPreview::default();
    for n in incoming {
        let attached = n.connections.iter().any(|c| mapping.contains_key(c));
        if !attached {
            p.unattached += 1;
            continue;
        }
        p.notes += 1;
        match n.kind {
            NoteKind::Internal => p.internal += 1,
            NoteKind::LocalFile => {
                p.linked_files += 1;
                if let Some(path) = &n.source
                    && !std::path::Path::new(path).is_file()
                {
                    p.missing_files += 1;
                }
            }
            NoteKind::RemoteUrl => p.web_documents += 1,
        }
        if n.snapshot.is_some() {
            p.snapshots += 1;
        }
        if n.connections
            .iter()
            .filter(|c| mapping.contains_key(c))
            .count()
            > 1
        {
            p.shared += 1;
        }
        if existing.contains_key(&n.id) {
            p.conflicts += 1;
        }
    }
    Ok(p)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesMergeResult {
    pub created: usize,
    /// Existing notes that only gained attachments (their content is untouched).
    pub attached_existing: usize,
    pub snapshots: usize,
    /// Left out: none of their connections took part, or a limit was reached.
    pub skipped: usize,
}

impl NotesStore {
    /// Notes for an export or backup. `map` turns a local connection id into the
    /// id used inside the document (and drops connections that are not exported);
    /// notes left without any exported connection are omitted.
    pub fn export_notes(
        &self,
        map: &dyn Fn(Uuid) -> Option<Uuid>,
        include_snapshots: bool,
    ) -> AppResult<Vec<PortableNote>> {
        let mut out = Vec::new();
        for n in self.snapshot_doc()? {
            let connections: Vec<Uuid> = n.connections.iter().filter_map(|c| map(*c)).collect();
            if connections.is_empty() {
                continue;
            }
            let content = if n.kind == NoteKind::Internal {
                Some(self.read_internal(n.id)?)
            } else {
                None
            };
            let (snapshot, snapshot_saved_at) = match (include_snapshots, n.offline) {
                (true, Some(meta)) => (self.read_offline(n.id)?, Some(meta.saved_at)),
                _ => (None, None),
            };
            out.push(PortableNote {
                id: n.id,
                title: n.title,
                kind: n.kind,
                format: n.format,
                source: n.source,
                created_at: n.created_at,
                updated_at: n.updated_at,
                zoom: n.zoom,
                connections,
                content,
                snapshot_saved_at: snapshot.as_ref().and(snapshot_saved_at),
                snapshot,
            });
        }
        Ok(out)
    }

    /// Merge validated incoming notes. `mapping` turns an incoming connection id
    /// into a local one; a note is only attached to connections that are in it.
    /// All new files are written first and the metadata last, so a failure
    /// leaves the previous notes exactly as they were.
    pub fn merge(
        &self,
        incoming: &[PortableNote],
        mapping: &HashMap<Uuid, Uuid>,
    ) -> AppResult<NotesMergeResult> {
        self.merge_inner(incoming, mapping)
    }
}

// The implementation needs the store's private state, so it lives next to it.
impl NotesStore {
    fn merge_inner(
        &self,
        incoming: &[PortableNote],
        mapping: &HashMap<Uuid, Uuid>,
    ) -> AppResult<NotesMergeResult> {
        let mut result = NotesMergeResult::default();
        let mut written: Vec<std::path::PathBuf> = Vec::new();
        let outcome = self.with_doc(|doc| {
            let mut notes = doc.notes.clone();
            let mut order = doc.order.clone();
            for n in incoming {
                let targets: Vec<Uuid> = {
                    let mut seen = HashSet::new();
                    n.connections
                        .iter()
                        .filter_map(|c| mapping.get(c).copied())
                        .filter(|c| seen.insert(*c))
                        .collect()
                };
                if targets.is_empty() {
                    result.skipped += 1;
                    continue;
                }
                let per_connection = |notes: &Vec<Note>, c: Uuid| {
                    notes.iter().filter(|x| x.connections.contains(&c)).count()
                };
                if let Some(existing) = notes.iter().position(|x| x.id == n.id) {
                    // keep what is here; only add attachments
                    let mut added = false;
                    for t in &targets {
                        if !notes[existing].connections.contains(t)
                            && per_connection(&notes, *t) < MAX_NOTES_PER_CONNECTION
                        {
                            notes[existing].connections.push(*t);
                            order.entry(*t).or_default().push(n.id);
                            added = true;
                        }
                    }
                    if added {
                        result.attached_existing += 1;
                    } else {
                        result.skipped += 1;
                    }
                    continue;
                }
                if notes.len() >= MAX_NOTES_TOTAL {
                    result.skipped += 1;
                    continue;
                }
                let usable: Vec<Uuid> = targets
                    .into_iter()
                    .filter(|t| per_connection(&notes, *t) < MAX_NOTES_PER_CONNECTION)
                    .collect();
                if usable.is_empty() {
                    result.skipped += 1;
                    continue;
                }
                if n.kind == NoteKind::Internal {
                    let path = self.content_file(n.id);
                    fsio::write_atomic(&path, n.content.as_deref().unwrap_or("").as_bytes(), true)?;
                    written.push(path);
                }
                let mut offline = None;
                if let (Some(text), NoteKind::RemoteUrl) = (&n.snapshot, n.kind) {
                    let path = self.offline_file(n.id);
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    fsio::write_atomic(&path, text.as_bytes(), true)?;
                    written.push(path);
                    offline = Some(OfflineMeta {
                        saved_at: n.snapshot_saved_at.unwrap_or(n.updated_at),
                        bytes: text.len() as u64,
                        format: n.format,
                    });
                    result.snapshots += 1;
                }
                for t in &usable {
                    order.entry(*t).or_default().push(n.id);
                }
                notes.push(Note {
                    id: n.id,
                    title: n.title.clone(),
                    kind: n.kind,
                    format: n.format,
                    source: n.source.clone(),
                    created_at: n.created_at,
                    updated_at: n.updated_at,
                    connections: usable,
                    zoom: n.zoom,
                    offline,
                });
                result.created += 1;
            }
            doc.notes = notes;
            doc.order = order;
            Ok(())
        });
        if let Err(e) = outcome {
            for path in written {
                let _ = std::fs::remove_file(path);
            }
            return Err(match e {
                AppError::Validation(_) => e,
                _ => AppError::Storage("The notes could not be saved.".into()),
            });
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(kind: &str, extra: Value) -> Value {
        let mut v = json!({
            "id": Uuid::new_v4(), "title": "T", "kind": kind, "format": "markdown",
            "createdAt": 1, "updatedAt": 2, "zoom": 100, "connections": [Uuid::new_v4()],
        });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    }

    #[test]
    fn valid_records_parse_and_hostile_ones_are_refused() {
        assert!(parse_note(&raw("internal", json!({"content": "# hi"}))).is_ok());
        assert!(parse_note(&raw("localFile", json!({"source": "C:\\docs\\a.md"}))).is_ok());
        assert!(
            parse_note(&raw(
                "remoteUrl",
                json!({"source": "https://example.com/a.md"})
            ))
            .is_ok()
        );
        let bad = [
            raw(
                "internal",
                json!({"content": "x".repeat(MAX_NOTE_BYTES + 1)}),
            ),
            raw("internal", json!({"title": "   ", "content": ""})),
            raw("internal", json!({"format": "html", "content": "<script>"})),
            raw("localFile", json!({"source": "C:\\tools\\evil.exe"})),
            raw(
                "localFile",
                json!({"source": "C:\\docs\\a.md", "format": "html"}),
            ),
            raw("localFile", json!({})),
            raw("remoteUrl", json!({"source": "http://example.com/a.md"})),
            raw("remoteUrl", json!({"source": "https://127.0.0.1/a.md"})),
            raw("remoteUrl", json!({"source": "file:///etc/passwd"})),
            raw(
                "remoteUrl",
                json!({"source": "https://example.com/a.md", "snapshot": "x".repeat(MAX_DOC_BYTES + 1)}),
            ),
            raw("script", json!({})),
            json!({"nonsense": true}),
        ];
        for (i, b) in bad.iter().enumerate() {
            assert!(parse_note(b).is_err(), "case {i}");
        }
    }

    #[test]
    fn imported_html_references_stay_references_and_snapshots_stay_text() {
        let n = parse_note(&raw(
            "remoteUrl",
            json!({"format": "html", "source": "https://example.com/g.html", "snapshot": "<script>alert(1)</script>"}),
        ))
        .unwrap();
        assert_eq!(n.snapshot.as_deref(), Some("<script>alert(1)</script>"));
        assert_eq!(n.content, None);
    }

    fn pn(id: Uuid, conns: &[Uuid], content: &str) -> PortableNote {
        PortableNote {
            id,
            title: "Shared guide".into(),
            kind: NoteKind::Internal,
            format: DocFormat::Markdown,
            source: None,
            created_at: 1,
            updated_at: 2,
            zoom: 120,
            connections: conns.to_vec(),
            content: Some(content.into()),
            snapshot: None,
            snapshot_saved_at: None,
        }
    }

    #[test]
    fn export_then_merge_into_a_fresh_store_keeps_content_and_shared_relations() {
        let src = tempfile::tempdir().unwrap();
        let a = NotesStore::open(src.path()).unwrap();
        let (c1, c2, c3) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let shared = a
            .create_internal(c1, "VPS commands", DocFormat::Markdown, "pvesh get /nodes")
            .unwrap();
        a.attach(shared.id, c2).unwrap();
        a.create_internal(c3, "Not exported", DocFormat::Text, "private")
            .unwrap();
        let web = a
            .create_link(
                c1,
                "README",
                NoteKind::RemoteUrl,
                DocFormat::Markdown,
                "https://example.com/README.md",
            )
            .unwrap();
        a.save_offline(web.id, "# offline copy", DocFormat::Markdown)
            .unwrap();

        // exporting only c1 and c2 (ids mapped to "public" ids)
        let (p1, p2) = (Uuid::new_v4(), Uuid::new_v4());
        let map = |c: Uuid| match c {
            x if x == c1 => Some(p1),
            x if x == c2 => Some(p2),
            _ => None,
        };
        let without = a.export_notes(&map, false).unwrap();
        assert_eq!(without.len(), 2, "the note of c3 is not exported");
        assert!(
            without.iter().all(|n| n.snapshot.is_none()),
            "snapshots are opt-in"
        );
        let with = a.export_notes(&map, true).unwrap();
        assert_eq!(with.iter().filter(|n| n.snapshot.is_some()).count(), 1);

        let dst = tempfile::tempdir().unwrap();
        let b = NotesStore::open(dst.path()).unwrap();
        let (l1, l2) = (Uuid::new_v4(), Uuid::new_v4());
        let mapping: HashMap<Uuid, Uuid> = [(p1, l1), (p2, l2)].into();
        let r = b.merge(&with, &mapping).unwrap();
        assert_eq!((r.created, r.snapshots), (2, 1));
        let on_l1 = b.list_for_connection(l1).unwrap();
        let on_l2 = b.list_for_connection(l2).unwrap();
        assert_eq!(on_l1.len(), 2);
        assert_eq!(on_l2.len(), 1);
        let shared_b = on_l2.iter().find(|n| n.title == "VPS commands").unwrap();
        assert!(shared_b.shared, "one note, two connections");
        assert_eq!(b.read_internal(shared_b.id).unwrap(), "pvesh get /nodes");
        assert_eq!(b.get(shared_b.id).unwrap().zoom, shared.zoom);
        assert_eq!(
            b.read_offline(web.id).unwrap().as_deref(),
            Some("# offline copy")
        );
    }

    #[test]
    fn importing_twice_never_duplicates_and_never_overwrites() {
        let dst = tempfile::tempdir().unwrap();
        let s = NotesStore::open(dst.path()).unwrap();
        let (src_c, local_c) = (Uuid::new_v4(), Uuid::new_v4());
        let id = Uuid::new_v4();
        let mapping: HashMap<Uuid, Uuid> = [(src_c, local_c)].into();
        let note = pn(id, &[src_c], "original");
        assert_eq!(
            s.merge(std::slice::from_ref(&note), &mapping)
                .unwrap()
                .created,
            1
        );
        // the user edits the note, then imports the same file again
        s.write_internal(id, "my newer edit").unwrap();
        let again = s.merge(&[pn(id, &[src_c], "original")], &mapping).unwrap();
        assert_eq!(again.created, 0);
        assert_eq!(s.list_all().unwrap().len(), 1);
        assert_eq!(
            s.read_internal(id).unwrap(),
            "my newer edit",
            "existing content wins"
        );
        let p = preview(&s, &[pn(id, &[src_c], "different")], &mapping).unwrap();
        assert_eq!(p.conflicts, 1);
    }

    #[test]
    fn an_existing_note_gains_only_the_attachments_of_restored_connections() {
        let dst = tempfile::tempdir().unwrap();
        let s = NotesStore::open(dst.path()).unwrap();
        let (c_old, c_new, c_other) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let n = s
            .create_internal(c_old, "Guide", DocFormat::Markdown, "keep")
            .unwrap();
        let (s_new, s_unrelated) = (Uuid::new_v4(), Uuid::new_v4());
        // the backup attaches the note to two source connections; only one is restored
        let mapping: HashMap<Uuid, Uuid> = [(s_new, c_new)].into();
        let r = s
            .merge(&[pn(n.id, &[s_new, s_unrelated], "other text")], &mapping)
            .unwrap();
        assert_eq!(r.attached_existing, 1);
        assert_eq!(s.list_for_connection(c_new).unwrap().len(), 1);
        assert!(
            s.list_for_connection(c_other).unwrap().is_empty(),
            "no unrelated connection is touched"
        );
        assert_eq!(s.read_internal(n.id).unwrap(), "keep");
    }

    #[test]
    fn notes_of_connections_that_are_not_restored_are_left_out() {
        let dst = tempfile::tempdir().unwrap();
        let s = NotesStore::open(dst.path()).unwrap();
        let (kept, left_out, local) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mapping: HashMap<Uuid, Uuid> = [(kept, local)].into();
        let r = s
            .merge(
                &[
                    pn(Uuid::new_v4(), &[kept], "a"),
                    pn(Uuid::new_v4(), &[left_out], "b"),
                ],
                &mapping,
            )
            .unwrap();
        assert_eq!((r.created, r.skipped), (1, 1));
        assert_eq!(s.list_all().unwrap().len(), 1);
        let p = preview(&s, &[pn(Uuid::new_v4(), &[left_out], "b")], &mapping).unwrap();
        assert_eq!(p.unattached, 1);
        assert_eq!(p.notes, 0);
    }

    #[test]
    fn a_failed_merge_changes_nothing_and_leaves_no_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let s = NotesStore::open(dir.path()).unwrap();
        let existing = s
            .create_internal(Uuid::new_v4(), "Mine", DocFormat::Text, "mine")
            .unwrap();
        std::fs::remove_file(dir.path().join("notes.json")).unwrap();
        std::fs::create_dir(dir.path().join("notes.json")).unwrap(); // saving must fail now
        let (src, local) = (Uuid::new_v4(), Uuid::new_v4());
        let mapping: HashMap<Uuid, Uuid> = [(src, local)].into();
        let new_id = Uuid::new_v4();
        assert!(s.merge(&[pn(new_id, &[src], "new")], &mapping).is_err());
        assert_eq!(s.list_all().unwrap().len(), 1, "memory state unchanged");
        assert_eq!(s.read_internal(existing.id).unwrap(), "mine");
        assert!(
            !dir.path()
                .join("notes")
                .join(format!("{new_id}.txt"))
                .exists()
        );
    }

    #[test]
    fn the_preview_reports_counts_missing_files_and_never_reads_them() {
        let dir = tempfile::tempdir().unwrap();
        let s = NotesStore::open(dir.path()).unwrap();
        let (src, local) = (Uuid::new_v4(), Uuid::new_v4());
        let mapping: HashMap<Uuid, Uuid> = [(src, local)].into();
        let present = dir.path().join("here.md");
        std::fs::write(&present, "x").unwrap();
        let mut file_ok = pn(Uuid::new_v4(), &[src], "");
        file_ok.kind = NoteKind::LocalFile;
        file_ok.content = None;
        file_ok.source = Some(present.to_string_lossy().into_owned());
        let mut file_gone = file_ok.clone();
        file_gone.id = Uuid::new_v4();
        file_gone.source = Some(dir.path().join("gone.md").to_string_lossy().into_owned());
        let mut web = pn(Uuid::new_v4(), &[src, Uuid::new_v4()], "");
        web.kind = NoteKind::RemoteUrl;
        web.content = None;
        web.source = Some("https://example.com/a.md".into());
        web.snapshot = Some("snap".into());
        let p = preview(
            &s,
            &[file_ok, file_gone, web, pn(Uuid::new_v4(), &[src], "t")],
            &mapping,
        )
        .unwrap();
        assert_eq!(
            (
                p.notes,
                p.internal,
                p.linked_files,
                p.web_documents,
                p.snapshots,
                p.missing_files
            ),
            (4, 1, 2, 1, 1, 1)
        );
        assert_eq!(p.shared, 0, "the second connection is not part of this run");
    }
}
