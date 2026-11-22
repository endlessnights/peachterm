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
