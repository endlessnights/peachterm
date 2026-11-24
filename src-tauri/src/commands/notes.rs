// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Server notes & documentation. Every command refuses while the application is
//! locked (note contents, snapshots and remote fetches are all behind the lock).
//!
//! The renderer never supplies a file path or an unrestricted URL to read: local
//! files come from the native file dialog (chosen here, in Rust), web addresses are
//! validated and fetched here under the rules in `notes::remote`, and content is
//! returned as plain text to be rendered by the (script-free) viewer.

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::notes::local::{self, LocalProblem};
use crate::notes::model::{DocFormat, NoteKind, OfflineMeta};
use crate::notes::remote;
use crate::notes::store::NoteSummary;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

type AppStateRef<'a> = State<'a, Arc<AppState>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    id: Uuid,
    kind: NoteKind,
    format: DocFormat,
    /// `ok`, or why there is no text: `missing`, `unreadable`, `tooLarge`,
    /// `unsupported`, `offline`, `error`.
    status: &'static str,
    text: Option<String>,
    /// A sentence explaining a problem (or why an offline copy is shown).
    problem: Option<String>,
    /// The text comes from the saved offline copy, not from the source.
    from_offline: bool,
    offline: Option<OfflineMeta>,
    source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesOverview {
    notes: Vec<NoteSummary>,
    last_selected: Option<Uuid>,
}

fn dialog_path(path: Option<tauri_plugin_dialog::FilePath>) -> AppResult<Option<PathBuf>> {
    path.map(|p| {
        p.into_path()
            .map_err(|_| AppError::Validation("Unsupported file location".into()))
    })
    .transpose()
}

fn pick_document(app: &AppHandle, title: &str) -> AppResult<Option<PathBuf>> {
    dialog_path(
        app.dialog()
            .file()
            .set_title(title)
            .add_filter("Documents", &["md", "markdown", "txt", "html", "htm"])
            .blocking_pick_file(),
    )
}

fn local_sentence(problem: LocalProblem) -> &'static str {
    match problem {
        LocalProblem::Missing => "The file was not found. It may have been moved or deleted.",
        LocalProblem::Unreadable => "The file could not be read.",
        LocalProblem::TooLarge => "The file is too large to show here (limit 2 MB).",
        LocalProblem::Unsupported => "This file type is not supported.",
    }
}

fn local_status(problem: LocalProblem) -> &'static str {
    match problem {
        LocalProblem::Missing => "missing",
        LocalProblem::Unreadable => "unreadable",
        LocalProblem::TooLarge => "tooLarge",
        LocalProblem::Unsupported => "unsupported",
    }
}

fn file_title(path: &std::path::Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Document".into())
}

#[tauri::command]
pub async fn notes_counts(state: AppStateRef<'_>) -> AppResult<HashMap<Uuid, usize>> {
    state.lock.guard()?;
    state.notes.counts()
}

#[tauri::command]
pub async fn notes_list(state: AppStateRef<'_>, connection_id: Uuid) -> AppResult<NotesOverview> {
    state.lock.guard()?;
    Ok(NotesOverview {
        notes: state.notes.list_for_connection(connection_id)?,
        last_selected: state.notes.last_selected(connection_id)?,
    })
}

/// Every note (also those attached to nothing), to attach an existing one.
#[tauri::command]
pub async fn notes_all(state: AppStateRef<'_>) -> AppResult<Vec<NoteSummary>> {
    state.lock.guard()?;
    state.notes.list_all()
}

#[tauri::command]
pub async fn note_create(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    title: String,
    format: DocFormat,
    content: Option<String>,
) -> AppResult<Uuid> {
    state.lock.guard()?;
    state.connections.get(connection_id)?;
    let note = state.notes.create_internal(
        connection_id,
        &title,
        format,
        content.as_deref().unwrap_or(""),
    )?;
    tracing::info!(event = "notes.created");
    Ok(note.id)
}

/// Attach a web document. Nothing is fetched here.
#[tauri::command]
pub async fn note_attach_url(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    url: String,
    title: Option<String>,
) -> AppResult<Uuid> {
    state.lock.guard()?;
    state.connections.get(connection_id)?;
    let parsed = remote::normalize(&url).map_err(|e| AppError::Validation(e.sentence()))?;
    let title = title
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            parsed
                .path_segments()
                .and_then(|mut s| s.next_back().map(str::to_owned))
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| parsed.host_str().unwrap_or("Document").to_owned());
    let format = remote::format_from_path(&parsed).unwrap_or(DocFormat::Markdown);
    let note = state.notes.create_link(
        connection_id,
        &title,
        NoteKind::RemoteUrl,
        format,
        parsed.as_str(),
    )?;
    tracing::info!(event = "notes.linked", kind = "url");
    Ok(note.id)
}

/// Pick a local document with the native dialog and attach it by reference.
/// `None` = the user cancelled.
#[tauri::command]
pub async fn note_attach_file(
    app: AppHandle,
    state: AppStateRef<'_>,
    connection_id: Uuid,
) -> AppResult<Option<Uuid>> {
    state.lock.guard()?;
    state.connections.get(connection_id)?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        let Some(path) = pick_document(&app, "Attach a document")? else {
            return Ok(None);
        };
        shared.lock.guard()?;
        match local::read(&path) {
            Ok(_) => {}
            Err(
                p @ (LocalProblem::TooLarge | LocalProblem::Unsupported | LocalProblem::Unreadable),
            ) => {
                return Err(AppError::Validation(local_sentence(p).into()));
            }
            Err(LocalProblem::Missing) => {}
        }
        let format = local::format_of(&path)
            .ok_or_else(|| AppError::Validation("This file type is not supported.".into()))?;
        let note = shared.notes.create_link(
            connection_id,
            &file_title(&path),
            NoteKind::LocalFile,
            format,
            &path.to_string_lossy(),
        )?;
        tracing::info!(event = "notes.linked", kind = "file");
        Ok(Some(note.id))
    })
    .await
}

/// Choose a new location for a linked file that was moved.
#[tauri::command]
pub async fn note_relocate(
    app: AppHandle,
    state: AppStateRef<'_>,
    note_id: Uuid,
) -> AppResult<bool> {
    state.lock.guard()?;
    state.notes.get(note_id)?;
    let shared = Arc::clone(&state);
    super::blocking(move || {
        let Some(path) = pick_document(&app, "Locate the document")? else {
            return Ok(false);
        };
        shared.lock.guard()?;
        let format = local::format_of(&path)
            .ok_or_else(|| AppError::Validation("This file type is not supported.".into()))?;
        shared
            .notes
            .set_source(note_id, &path.to_string_lossy(), format)?;
        Ok(true)
    })
    .await
}

/// Read a note for display. Web documents are fetched now (never stored unless
/// the user saved an offline copy); linked files are read from disk.
#[tauri::command]
pub async fn note_read(state: AppStateRef<'_>, note_id: Uuid) -> AppResult<NoteContent> {
    state.lock.guard()?;
    let note = state.notes.get(note_id)?;
    let mut out = NoteContent {
        id: note.id,
        kind: note.kind,
        format: note.format,
        status: "ok",
        text: None,
        problem: None,
        from_offline: false,
        offline: note.offline,
        source: note.source.clone(),
    };
    match note.kind {
        NoteKind::Internal => out.text = Some(state.notes.read_internal(note_id)?),
        NoteKind::LocalFile => {
            let path = PathBuf::from(note.source.clone().unwrap_or_default());
            match local::read(&path) {
                Ok(doc) => {
                    out.format = doc.format;
                    out.text = Some(doc.text);
                }
                Err(p) => {
                    out.status = local_status(p);
                    out.problem = Some(local_sentence(p).into());
                }
            }
        }
        NoteKind::RemoteUrl => {
            let url = remote::normalize(note.source.as_deref().unwrap_or(""))
                .map_err(|e| AppError::Validation(e.sentence()))?;
            match remote::fetch_system(&url).await {
                Ok(doc) => {
                    out.format = doc.format;
                    out.text = Some(doc.text);
                    let _ = state.notes.set_format(note_id, doc.format);
                }
                Err(e) => {
                    tracing::info!(event = "notes.fetch_failed", reason = e.token());
                    match state.notes.read_offline(note_id)? {
                        Some(text) => {
                            out.text = Some(text);
                            out.from_offline = true;
                            out.problem =
                                Some(format!("Showing the saved offline copy. {}", e.sentence()));
                            if let Some(meta) = note.offline {
                                out.format = meta.format;
                            }
                        }
                        None => {
                            out.status = if matches!(
                                e,
                                remote::FetchError::Network
                                    | remote::FetchError::Dns
                                    | remote::FetchError::Timeout
                            ) {
                                "offline"
                            } else {
                                "error"
                            };
                            out.problem = Some(e.sentence());
                        }
                    }
                }
            }
        }
    }
    // The user may have locked the application while we were waiting.
    state.lock.guard()?;
    Ok(out)
}

#[tauri::command]
pub async fn note_write(state: AppStateRef<'_>, note_id: Uuid, content: String) -> AppResult<()> {
    state.lock.guard()?;
    state.notes.write_internal(note_id, &content)
}

#[tauri::command]
pub async fn note_rename(state: AppStateRef<'_>, note_id: Uuid, title: String) -> AppResult<()> {
    state.lock.guard()?;
    state.notes.rename(note_id, &title)
}

#[tauri::command]
pub async fn note_set_zoom(state: AppStateRef<'_>, note_id: Uuid, zoom: u32) -> AppResult<u16> {
    state.lock.guard()?;
    state.notes.set_zoom(note_id, zoom)
}

#[tauri::command]
pub async fn note_select(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    note_id: Uuid,
) -> AppResult<()> {
    state.lock.guard()?;
    state.notes.select(connection_id, note_id)
}

#[tauri::command]
pub async fn note_reorder(
    state: AppStateRef<'_>,
    connection_id: Uuid,
    note_ids: Vec<Uuid>,
) -> AppResult<()> {
    state.lock.guard()?;
    state.notes.reorder(connection_id, &note_ids)
}

#[tauri::command]
pub async fn note_attach(
    state: AppStateRef<'_>,
    note_id: Uuid,
    connection_id: Uuid,
) -> AppResult<()> {
    state.lock.guard()?;
    state.connections.get(connection_id)?;
    state.notes.attach(note_id, connection_id)
}

/// "Detach from this connection": the document stays for everyone else.
#[tauri::command]
pub async fn note_detach(
    state: AppStateRef<'_>,
    note_id: Uuid,
    connection_id: Uuid,
) -> AppResult<()> {
    state.lock.guard()?;
    state.notes.detach(note_id, connection_id)
}

/// "Delete the document everywhere": the renderer asks for explicit confirmation first.
#[tauri::command]
pub async fn note_delete(state: AppStateRef<'_>, note_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    state.notes.delete(note_id)?;
    tracing::info!(event = "notes.deleted");
    Ok(())
}

/// Download the web document now and keep a snapshot in PeachTerm's data folder.
#[tauri::command]
pub async fn note_save_offline(state: AppStateRef<'_>, note_id: Uuid) -> AppResult<OfflineMeta> {
    state.lock.guard()?;
    let note = state.notes.get(note_id)?;
    if note.kind != NoteKind::RemoteUrl {
        return Err(AppError::Validation(
            "Only web documents can be saved offline.".into(),
        ));
    }
    let url = remote::normalize(note.source.as_deref().unwrap_or(""))
        .map_err(|e| AppError::Validation(e.sentence()))?;
    let doc = remote::fetch_system(&url)
        .await
        .map_err(|e| AppError::Validation(e.sentence()))?;
    state.lock.guard()?;
    let meta = state.notes.save_offline(note_id, &doc.text, doc.format)?;
    let _ = state.notes.set_format(note_id, doc.format);
    tracing::info!(event = "notes.offline_saved");
    Ok(meta)
}

#[tauri::command]
pub async fn note_remove_offline(state: AppStateRef<'_>, note_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    state.notes.remove_offline(note_id)
}

/// Open the document itself in the system's default application / browser.
#[tauri::command]
pub async fn note_open_external(state: AppStateRef<'_>, note_id: Uuid) -> AppResult<()> {
    state.lock.guard()?;
    let note = state.notes.get(note_id)?;
    let source = note
        .source
        .ok_or_else(|| AppError::Validation("This note has no external document.".into()))?;
    match note.kind {
        NoteKind::LocalFile => {
            let path = PathBuf::from(source);
            if local::format_of(&path).is_none() || !path.is_file() {
                return Err(AppError::Validation(
                    "The file was not found. It may have been moved or deleted.".into(),
                ));
            }
            super::blocking(move || {
                crate::platform::open_folder(&path)?;
                Ok(())
            })
            .await
        }
        NoteKind::RemoteUrl => {
            let url = remote::normalize(&source).map_err(|e| AppError::Validation(e.sentence()))?;
            super::blocking(move || {
                crate::platform::open_url(url.as_str())?;
                Ok(())
            })
            .await
        }
        NoteKind::Internal => Err(AppError::Validation(
            "This note has no external document.".into(),
        )),
    }
}

/// A link inside a document, clicked by the user: only plain web addresses are
/// opened, in the system browser. Never another scheme, never a command.
#[tauri::command]
pub async fn note_open_link(state: AppStateRef<'_>, url: String) -> AppResult<()> {
    state.lock.guard()?;
    let parsed = url::Url::parse(url.trim())
        .map_err(|_| AppError::Validation("That is not a valid web address.".into()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host().is_none()
        || url.chars().count() > 2048
    {
        return Err(AppError::Validation(
            "Only web addresses (http or https) can be opened.".into(),
        ));
    }
    super::blocking(move || {
        crate::platform::open_url(parsed.as_str())?;
        Ok(())
    })
    .await
}
