//! Linux-only leaf: executable name resolution and editor presets.

use crate::editor::EditorPreset;

pub const OS_NAME: &str = "linux";

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
