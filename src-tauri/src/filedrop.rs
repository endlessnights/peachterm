// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Files dragged from the operating system onto the window.
//!
//! With WebView2 (Windows), WKWebView and WebKitGTK an external file drop does
//! not reach the page as an ordinary DOM `drop` event: Tauri delivers it as a
//! native window event with the cursor position and the dropped paths. This
//! module turns those into one renderer event that never carries a path:
//!
//! * `enter` / `over` / `leave` only describe what is being dragged (counts)
//!   and where the cursor is, so the renderer can draw a preview and find the
//!   element under the cursor;
//! * `drop` stores the paths in the SFTP hub and hands the renderer an opaque,
//!   single-use, short-lived id. The renderer decides the destination and asks
//!   Rust to upload; it can never name a local path itself.
//!
//! While the application is locked nothing is stored and nothing is emitted.

use crate::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{DragDropEvent, Emitter, Manager};
use uuid::Uuid;

pub const EVENT: &str = "peachterm://file-drag";

/// Counting more than this many top-level items is pointless for a preview.
const COUNT_LIMIT: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DragPayload {
    Enter {
        x: f64,
        y: f64,
        files: usize,
        dirs: usize,
        other: usize,
    },
    Over {
        x: f64,
        y: f64,
    },
    Drop {
        x: f64,
        y: f64,
        pick_id: Uuid,
        files: usize,
        dirs: usize,
        other: usize,
    },
    Leave,
}

/// Top-level counts of what is being dragged (no recursion, no reading).
pub fn summarize(paths: &[PathBuf]) -> (usize, usize, usize) {
    let (mut files, mut dirs, mut other) = (0, 0, 0);
    for path in paths.iter().take(COUNT_LIMIT) {
        match std::fs::symlink_metadata(path) {
            Ok(m) if m.file_type().is_symlink() => other += 1,
            Ok(m) if m.is_dir() => dirs += 1,
            Ok(m) if m.is_file() => files += 1,
            _ => other += 1,
        }
    }
    (files, dirs, other)
}

/// Translate a native drag event for the renderer. `None` when the app is
/// locked (nothing leaves the backend and nothing is remembered).
pub fn translate(state: &AppState, event: &DragDropEvent) -> Option<DragPayload> {
    if state.lock.guard().is_err() {
        return None;
    }
    Some(match event {
        DragDropEvent::Enter { paths, position } => {
            let (files, dirs, other) = summarize(paths);
            DragPayload::Enter {
                x: position.x,
                y: position.y,
                files,
                dirs,
                other,
            }
        }
        DragDropEvent::Over { position } => DragPayload::Over {
            x: position.x,
            y: position.y,
        },
        DragDropEvent::Drop { paths, position } => {
            let (files, dirs, other) = summarize(paths);
            let pick_id = state.sftp.remember_drop(paths.clone());
            DragPayload::Drop {
                x: position.x,
                y: position.y,
                pick_id,
                files,
                dirs,
                other,
            }
        }
        DragDropEvent::Leave => DragPayload::Leave,
        _ => return None,
    })
}

/// Deliver a native drag event. Tauri reports the drag of the main window's
/// own web view as a *window* event (a separate web view would use a web view
/// event), so both entry points end here.
pub fn handle<R: tauri::Runtime, M: Manager<R> + Emitter<R>>(target: &M, event: &DragDropEvent) {
    let Some(state) = target.try_state::<Arc<AppState>>() else {
        return;
    };
    if let Some(payload) = translate(&state, event) {
        let _ = target.emit(EVENT, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_never_contain_a_path() {
        let id = Uuid::new_v4();
        let drop = DragPayload::Drop {
            x: 10.0,
            y: 20.0,
            pick_id: id,
            files: 2,
            dirs: 1,
            other: 0,
        };
        let json = serde_json::to_value(&drop).unwrap();
        assert_eq!(json["phase"], "drop");
        assert_eq!(json["pickId"], id.to_string());
        let text = json.to_string();
        assert!(!text.contains('\\') && !text.contains(":/"), "{text}");
        assert_eq!(
            serde_json::to_value(DragPayload::Leave).unwrap()["phase"],
            "leave"
        );
        let over = serde_json::to_value(DragPayload::Over { x: 1.5, y: 2.5 }).unwrap();
        assert_eq!(
            (over["x"].as_f64(), over["y"].as_f64()),
            (Some(1.5), Some(2.5))
        );
    }

    #[test]
    fn summaries_count_files_folders_and_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"1").unwrap();
        let d = dir.path().join("sub");
        std::fs::create_dir(&d).unwrap();
        std::fs::write(d.join("inner.txt"), b"2").unwrap();
        let gone = dir.path().join("gone");
        assert_eq!(summarize(&[f, d, gone]), (1, 1, 1));
        assert_eq!(summarize(&[]), (0, 0, 0));
    }
}
