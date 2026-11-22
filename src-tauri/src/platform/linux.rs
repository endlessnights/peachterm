//! Linux-only leaf: executable name resolution and editor presets.

use crate::editor::EditorPreset;

use std::path::{Path, PathBuf};

pub const OS_NAME: &str = "linux";

const APP_DIR: &str = "peachterm";

/// `$XDG_CONFIG_HOME/peachterm` (default `~/.config/peachterm`).
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(APP_DIR))
}

/// `$XDG_CACHE_HOME/peachterm` (default `~/.cache/peachterm`).
pub fn cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join(APP_DIR))
}

/// `$XDG_STATE_HOME/peachterm/logs` (default `~/.local/state/peachterm/logs`).
pub fn log_dir() -> Option<PathBuf> {
    dirs::state_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .map(|d| d.join(APP_DIR).join("logs"))
}

pub fn open_folder(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
}

pub fn executable_names(program: &str) -> Vec<String> {
    vec![program.to_owned()]
}

pub fn editor_presets() -> Vec<EditorPreset> {
    [
        ("kate", "Kate", "kate"),
        (
            "gnome-text-editor",
            "GNOME Text Editor",
            "gnome-text-editor",
        ),
        ("gedit", "gedit", "gedit"),
        ("vscode", "Visual Studio Code", "code"),
    ]
    .into_iter()
    .filter(|(_, _, program)| super::find_executable(program).is_some())
    .map(|(id, label, program)| EditorPreset::new(id, label, program, &["{file}"]))
    .collect()
}
