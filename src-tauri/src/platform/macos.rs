// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! macOS-only leaf: executable name resolution and editor presets.
//!
//! macOS GUI editors are launched through `open -a <App>`, which hands the file
//! to the application bundle. PeachTerm watches the file itself, so it does not
//! need the editor process to stay attached.

use crate::editor::EditorPreset;

use std::path::{Path, PathBuf};

pub const OS_NAME: &str = "macos";

const APP_DIR: &str = "PeachTerm";

/// `~/Library/Application Support/PeachTerm`.
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(APP_DIR))
}

/// `~/Library/Caches/PeachTerm`.
pub fn cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join(APP_DIR))
}

/// `~/Library/Logs/PeachTerm` (the macOS convention; Console.app reads it).
pub fn log_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Library").join("Logs").join(APP_DIR))
}

/// GTK and AppKit draw the title bar from the window theme set by Tauri
/// (`set_theme`), which is already dark/light aware; nothing else to do.
pub fn apply_title_bar(
    _window: &tauri::WebviewWindow,
    _colors: super::TitleBarColors,
) -> super::TitleBarOutcome {
    super::TitleBarOutcome::ThemeOnly
}

pub fn open_folder(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[allow(dead_code)]
pub fn executable_names(program: &str) -> Vec<String> {
    vec![program.to_owned()]
}

pub fn editor_presets() -> Vec<EditorPreset> {
    let mut presets = vec![EditorPreset::new(
        "textedit",
        "TextEdit",
        "open",
        &["-a", "TextEdit", "{file}"],
    )];
    presets.push(EditorPreset::new(
        "vscode",
        "Visual Studio Code",
        "open",
        &["-a", "Visual Studio Code", "{file}"],
    ));
    presets
}
