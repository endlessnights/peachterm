//! Windows-only leaf: executable name resolution and editor presets.

use crate::editor::EditorPreset;
use std::path::PathBuf;

pub const OS_NAME: &str = "windows";

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
