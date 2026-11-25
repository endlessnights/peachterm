// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Server notes & documentation: the data model and its validation.
//!
//! A *note* is one document. It can be written inside PeachTerm (Markdown or
//! plain text), or it can be a reference to a local file or a public HTTPS URL.
//! A note can be attached to any number of saved connections; the relationship
//! lives in `connections`, so a shared note is stored once.
//!
//! Note contents are potentially sensitive operational documentation: they are
//! never logged and never leave the backend while the application is locked.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_TITLE_CHARS: usize = 120;
/// An internal (typed) note.
pub const MAX_NOTE_BYTES: usize = 1024 * 1024;
/// A linked local file, a fetched remote document and an offline snapshot.
pub const MAX_DOC_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_NOTES_TOTAL: usize = 1000;
pub const MAX_NOTES_PER_CONNECTION: usize = 100;
pub const MAX_SOURCE_CHARS: usize = 2048;
pub const ZOOM_MIN: u16 = 50;
pub const ZOOM_MAX: u16 = 200;
pub const ZOOM_DEFAULT: u16 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteKind {
    /// Written in PeachTerm; the content is stored by PeachTerm.
    Internal,
    /// A reference to a file on this computer; only the path is stored.
    LocalFile,
    /// A reference to a public HTTPS document; only the URL is stored (and an
    /// offline snapshot, if the user explicitly saved one).
    RemoteUrl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocFormat {
    Markdown,
    Text,
    Html,
}

impl DocFormat {
    /// From a file extension (`md`, `markdown`, `txt`, `html`, `htm`).
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "md" | "markdown" => Some(Self::Markdown),
            "txt" => Some(Self::Text),
            "html" | "htm" => Some(Self::Html),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineMeta {
    pub saved_at: u64,
    pub bytes: u64,
    pub format: DocFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: Uuid,
    pub title: String,
    pub kind: NoteKind,
    pub format: DocFormat,
    /// Local path or URL, for linked documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// The saved connections this note is attached to.
    #[serde(default)]
    pub connections: Vec<Uuid>,
    /// Zoom of this document in percent (50-200).
    #[serde(default = "default_zoom")]
    pub zoom: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offline: Option<OfflineMeta>,
}

fn default_zoom() -> u16 {
    ZOOM_DEFAULT
}

pub fn clamp_zoom(zoom: u32) -> u16 {
    zoom.clamp(u32::from(ZOOM_MIN), u32::from(ZOOM_MAX)) as u16
}

pub fn clean_title(title: &str) -> AppResult<String> {
    let t: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let t = t.trim();
    if t.is_empty() {
        return Err(AppError::validation_key(
            "notes.needTitle",
            "Give the note a title.",
        ));
    }
    if t.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::Validation(format!(
            "A title can have at most {MAX_TITLE_CHARS} characters."
        )));
    }
    Ok(t.to_owned())
}

/// Internal notes must be valid text of a sane size (the editor sends UTF-8).
pub fn check_note_content(content: &str) -> AppResult<()> {
    if content.len() > MAX_NOTE_BYTES {
        return Err(AppError::Validation(format!(
            "This note is too large (the limit is {} KB).",
            MAX_NOTE_BYTES / 1024
        )));
    }
    if content.contains('\0') {
        return Err(AppError::Validation(
            "A note cannot contain NUL characters.".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_trimmed_cleaned_and_bounded() {
        assert_eq!(
            clean_title("  Proxmox\tcommands \n").unwrap(),
            "Proxmox commands"
        );
        assert!(clean_title("   ").is_err());
        assert!(clean_title(&"x".repeat(MAX_TITLE_CHARS + 1)).is_err());
        assert!(clean_title(&"x".repeat(MAX_TITLE_CHARS)).is_ok());
    }

    #[test]
    fn zoom_is_clamped_to_50_200() {
        assert_eq!(clamp_zoom(0), 50);
        assert_eq!(clamp_zoom(49), 50);
        assert_eq!(clamp_zoom(120), 120);
        assert_eq!(clamp_zoom(9999), 200);
    }

    #[test]
    fn only_the_supported_extensions_are_documents() {
        for (ext, f) in [
            ("md", DocFormat::Markdown),
            ("MARKDOWN", DocFormat::Markdown),
            ("txt", DocFormat::Text),
            ("html", DocFormat::Html),
            ("HTM", DocFormat::Html),
        ] {
            assert_eq!(DocFormat::from_extension(ext), Some(f));
        }
        for ext in ["exe", "js", "pdf", "svg", "", "md.exe"] {
            assert_eq!(DocFormat::from_extension(ext), None, "{ext}");
        }
    }

    #[test]
    fn note_content_limits() {
        assert!(check_note_content("# fine").is_ok());
        assert!(check_note_content(&"a".repeat(MAX_NOTE_BYTES)).is_ok());
        assert!(check_note_content(&"a".repeat(MAX_NOTE_BYTES + 1)).is_err());
        assert!(check_note_content("bad\0").is_err());
    }
}
