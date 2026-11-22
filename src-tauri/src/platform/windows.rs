// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Windows-only leaf: executable name resolution and editor presets.

use crate::editor::EditorPreset;
use std::path::{Path, PathBuf};

pub const OS_NAME: &str = "windows";

const APP_DIR: &str = "PeachTerm";

/// `%APPDATA%\PeachTerm` (roaming: settings follow the user profile).
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(APP_DIR))
}

/// `%LOCALAPPDATA%\PeachTerm\cache`.
pub fn cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join(APP_DIR).join("cache"))
}

/// `%LOCALAPPDATA%\PeachTerm\logs` (machine-local: logs must not roam).
pub fn log_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(APP_DIR).join("logs"))
}

/// Windows 11 (build 22000+) lets an application set the caption, text and
/// border colour of its native title bar through DWM. Without this the title
/// bar follows the user's accent colour ("Show accent colour on title bars"),
/// which clashes with a dark theme. Older Windows versions reject the
/// attributes; the dark/light theme set by Tauri is then all that applies.
pub fn apply_title_bar(
    window: &tauri::WebviewWindow,
    colors: super::TitleBarColors,
) -> super::TitleBarOutcome {
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;

    let Ok(hwnd) = window.hwnd() else {
        return super::TitleBarOutcome::ThemeOnly;
    };
    let set = |attribute: u32, color: super::Rgb| -> bool {
        let value: u32 = color.colorref();
        // SAFETY: `hwnd` is the live window handle owned by Tauri for the
        // duration of this call; `value` is a valid u32 that outlives the call
        // and its size is passed correctly. DwmSetWindowAttribute only reads it.
        #[allow(unsafe_code)]
        let result = unsafe {
            windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                hwnd.0,
                attribute,
                std::ptr::from_ref(&value).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        result >= 0
    };
    let all = set(DWMWA_CAPTION_COLOR, colors.caption)
        & set(DWMWA_TEXT_COLOR, colors.text)
        & set(DWMWA_BORDER_COLOR, colors.border);
    if all {
        super::TitleBarOutcome::Colored
    } else {
        super::TitleBarOutcome::ThemeOnly
    }
}

pub fn open_folder(path: &Path) -> std::io::Result<()> {
    // explorer.exe reports exit code 1 even on success, so do not wait for it.
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[allow(dead_code)]
pub fn executable_names(program: &str) -> Vec<String> {
    if program.to_ascii_lowercase().ends_with(".exe") {
        vec![program.to_owned()]
    } else {
        vec![format!("{program}.exe"), program.to_owned()]
    }
}

/// Known folder from an environment variable, resolved only here (Windows leaf).
fn known_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

pub fn editor_presets() -> Vec<EditorPreset> {
    let mut presets = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(dir) = known_dir(var) {
            let exe = dir.join("Notepad++").join("notepad++.exe");
            if exe.is_file() {
                presets.push(EditorPreset::new(
                    "notepad-plus-plus",
                    "Notepad++",
                    exe.to_string_lossy(),
                    &["-multiInst", "-nosession", "{file}"],
                ));
                break;
            }
        }
    }
    if let Some(local) = known_dir("LOCALAPPDATA") {
        let exe = local
            .join("Programs")
            .join("Microsoft VS Code")
            .join("Code.exe");
        if exe.is_file() {
            presets.push(EditorPreset::new(
                "vscode",
                "Visual Studio Code",
                exe.to_string_lossy(),
                &["{file}"],
            ));
        }
    }
    presets.push(EditorPreset::new(
        "notepad",
        "Notepad",
        "notepad.exe",
        &["{file}"],
    ));
    presets
}
