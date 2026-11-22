//! macOS-only leaf: executable name resolution and editor presets.
//!
//! macOS GUI editors are launched through `open -a <App>`, which hands the file
//! to the application bundle. PeachTerm watches the file itself, so it does not
//! need the editor process to stay attached.

use crate::editor::EditorPreset;

pub const OS_NAME: &str = "macos";

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
