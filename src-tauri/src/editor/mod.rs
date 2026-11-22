//! External-editor integration.
//!
//! Phase 1: launch configuration, per-OS presets and the remote-write policy.
//! Phase 4: temp files, watcher, confirmation prompts, conflict checks, upload.

pub mod policy;

use serde::Serialize;
use std::ffi::OsString;
use std::path::Path;

pub const FILE_PLACEHOLDER: &str = "{file}";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreset {
    pub id: String,
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
}

impl EditorPreset {
    pub fn new(id: &str, label: &str, program: impl Into<String>, args: &[&str]) -> EditorPreset {
        EditorPreset {
            id: id.to_owned(),
            label: label.to_owned(),
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
        }
    }
}

/// A fully resolved command line. Arguments are passed as an argv array
/// (never through a shell), so file names cannot inject commands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // used by the launcher in Phase 4
pub struct EditorCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
}

/// Substitute `{file}` in every argument; append the file if no argument
/// contains the placeholder.
#[allow(dead_code)] // used by the launcher in Phase 4
pub fn build_command(program: &str, args: &[String], file: &Path) -> EditorCommand {
    let mut substituted = false;
    let mut out = Vec::with_capacity(args.len() + 1);
    for arg in args {
        if arg == FILE_PLACEHOLDER {
            out.push(file.as_os_str().to_owned());
            substituted = true;
        } else if arg.contains(FILE_PLACEHOLDER) {
            let replaced = arg.replace(FILE_PLACEHOLDER, &file.to_string_lossy());
            out.push(OsString::from(replaced));
            substituted = true;
        } else {
            out.push(OsString::from(arg));
        }
    }
    if !substituted {
        out.push(file.as_os_str().to_owned());
    }
    EditorCommand {
        program: OsString::from(program),
        args: out,
    }
}

pub fn presets() -> Vec<EditorPreset> {
    crate::platform::platform_editor_presets()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn placeholder_is_replaced_as_single_argument() {
        let file = PathBuf::from("dir with space").join("sshd_config; rm -rf");
        let cmd = build_command("editor", &["-n".into(), "{file}".into()], &file);
        assert_eq!(cmd.args.len(), 2);
        assert_eq!(cmd.args[1], file.as_os_str());
    }

    #[test]
    fn file_is_appended_when_no_placeholder() {
        let file = PathBuf::from("a.txt");
        let cmd = build_command("editor", &["--wait".into()], &file);
        assert_eq!(
            cmd.args,
            vec![OsString::from("--wait"), OsString::from("a.txt")]
        );
    }

    #[test]
    fn embedded_placeholder_is_substituted() {
        let file = PathBuf::from("b.txt");
        let cmd = build_command("editor", &["--file={file}".into()], &file);
        assert_eq!(cmd.args, vec![OsString::from("--file=b.txt")]);
    }

    #[test]
    fn presets_use_placeholder() {
        for preset in presets() {
            assert!(
                preset.args.iter().any(|a| a.contains(FILE_PLACEHOLDER)),
                "{preset:?}"
            );
        }
    }
}
