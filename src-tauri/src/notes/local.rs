// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Reading a linked local document.
//!
//! Only a file the user picked through the native file dialog is ever read, and
//! only as text, with a size limit. PeachTerm never scans directories, never
//! follows a path from an imported document without the user's approval, and
//! never writes to a linked file.

use super::model::{DocFormat, MAX_DOC_BYTES};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalProblem {
    /// The file is gone or moved.
    Missing,
    /// Not a file, or not readable.
    Unreadable,
    TooLarge,
    /// Not one of the supported document types.
    Unsupported,
}

#[derive(Debug)]
pub struct LocalDoc {
    pub format: DocFormat,
    pub text: String,
}

/// The document type of a path, judged by its extension only.
pub fn format_of(path: &Path) -> Option<DocFormat> {
    path.extension()
        .and_then(|e| e.to_str())
        .and_then(DocFormat::from_extension)
}

pub fn read(path: &Path) -> Result<LocalDoc, LocalProblem> {
    let format = format_of(path).ok_or(LocalProblem::Unsupported)?;
    if !path.is_absolute() {
        return Err(LocalProblem::Unreadable);
    }
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(LocalProblem::Missing),
        Err(_) => return Err(LocalProblem::Unreadable),
    };
    if !meta.is_file() {
        return Err(LocalProblem::Unreadable);
    }
    if meta.len() > MAX_DOC_BYTES as u64 {
        return Err(LocalProblem::TooLarge);
    }
    let bytes = std::fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            LocalProblem::Missing
        } else {
            LocalProblem::Unreadable
        }
    })?;
    if bytes.len() > MAX_DOC_BYTES {
        return Err(LocalProblem::TooLarge);
    }
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    Ok(LocalDoc {
        format,
        text: String::from_utf8_lossy(body).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_supported_documents_as_text() {
        let dir = tempfile::tempdir().unwrap();
        for (name, body, fmt) in [
            ("a.md", "# T", DocFormat::Markdown),
            ("a.markdown", "x", DocFormat::Markdown),
            ("a.txt", "plain", DocFormat::Text),
            ("a.html", "<p>x</p>", DocFormat::Html),
            ("a.HTM", "<p>x</p>", DocFormat::Html),
        ] {
            let p = dir.path().join(name);
            std::fs::write(&p, body).unwrap();
            let doc = read(&p).unwrap();
            assert_eq!(doc.format, fmt, "{name}");
            assert_eq!(doc.text, body);
        }
    }

    #[test]
    fn a_byte_order_mark_and_invalid_utf8_do_not_break_reading() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("b.txt");
        std::fs::write(&p, b"\xEF\xBB\xBFhello \xFF world").unwrap();
        let doc = read(&p).unwrap();
        assert!(doc.text.starts_with("hello "));
        assert!(doc.text.contains('\u{FFFD}'));
    }

    #[test]
    fn missing_oversized_unsupported_and_non_files_are_distinct_problems() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read(&dir.path().join("gone.md")).unwrap_err(),
            LocalProblem::Missing
        );
        let exe = dir.path().join("tool.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert_eq!(read(&exe).unwrap_err(), LocalProblem::Unsupported);
        let big = dir.path().join("big.txt");
        std::fs::write(&big, vec![b'a'; MAX_DOC_BYTES + 1]).unwrap();
        assert_eq!(read(&big).unwrap_err(), LocalProblem::TooLarge);
        let folder = dir.path().join("dir.md");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(read(&folder).unwrap_err(), LocalProblem::Unreadable);
        assert_eq!(
            read(Path::new("relative.md")).unwrap_err(),
            LocalProblem::Unreadable
        );
    }

    #[test]
    fn reading_never_changes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("keep.md");
        std::fs::write(&p, "original").unwrap();
        let before = std::fs::metadata(&p).unwrap().modified().unwrap();
        let _ = read(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "original");
        assert_eq!(std::fs::metadata(&p).unwrap().modified().unwrap(), before);
    }
}
