//! External-editor integration.
//!
//! Launch configuration, per-OS presets, the remote-write policy (`policy`),
//! managed temp files (`tempfiles`) and the edit → confirm → upload round trip
//! (`service`).

pub mod policy;
pub mod service;
pub mod tempfiles;

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
pub struct EditorCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
}

/// Substitute `{file}` in every argument; append the file if no argument
/// contains the placeholder.
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

/// The program and arguments to use: the configured editor, or the first
/// preset found on this machine.
pub fn resolve_editor(
    settings: &crate::storage::settings::EditorSettings,
) -> Option<(String, Vec<String>)> {
    if let Some(program) = settings
        .program
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let args = if settings.args.is_empty() {
            vec![FILE_PLACEHOLDER.to_owned()]
        } else {
            settings.args.clone()
        };
        return Some((program.to_owned(), args));
    }
    presets().into_iter().next().map(|p| (p.program, p.args))
}

/// Start the editor on `file` without waiting for it. Arguments are an argv
/// array (no shell); the editor is not tied to PeachTerm's lifetime.
pub fn launcher(settings: &crate::storage::settings::EditorSettings) -> service::Launcher {
    let resolved = resolve_editor(settings);
    std::sync::Arc::new(move |file: &Path| {
        let (program, args) = resolved.as_ref().ok_or(())?;
        let command = build_command(program, args, file);
        let mut process = std::process::Command::new(&command.program);
        process
            .args(&command.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            process.process_group(0);
        }
        let mut child = process.spawn().map_err(|_| ())?;
        // Reap the child (some editors exit at once after handing over to a
        // running instance) without blocking anything.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    })
}

/// Where managed edit copies live: the configured directory (when it is an
/// absolute path) or the per-user cache directory.
pub fn temp_root(settings: &crate::storage::settings::EditorSettings) -> std::path::PathBuf {
    if let Some(dir) = settings
        .temp_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        let path = std::path::PathBuf::from(dir);
        if path.is_absolute() {
            return path.join("PeachTerm-editing");
        }
    }
    if let Some(base) = std::env::var_os(crate::platform::AppPaths::PROFILE_ENV)
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        return base.join("cache").join("editing");
    }
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("PeachTerm")
        .join("editing")
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

#[cfg(test)]
mod integration_tests;
