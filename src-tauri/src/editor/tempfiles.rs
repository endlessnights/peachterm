// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Managed local copies of remote files being edited.
//!
//! Layout: `<root>/<edit id>/<sanitised file name>`. The root and every edit
//! directory are created private (mode 0700 on Unix; on Windows they live in
//! the user's profile, whose ACL already restricts them to the user). File
//! names derived from remote paths can never contain a separator, a drive
//! prefix or `..`, and the file is created with `create_new`, so a planted
//! symlink or an existing file cannot be followed or overwritten.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const MAX_NAME_CHARS: usize = 120;
/// Leftovers of earlier runs older than this are deleted at start-up.
pub const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

/// A file name that is safe on every supported OS, keeping the extension
/// (editors pick syntax highlighting from it).
pub fn sanitize_file_name(remote_path: &str) -> String {
    let base = remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let mut name: String = cleaned.trim().trim_end_matches(['.', ' ']).to_owned();
    if name.chars().count() > MAX_NAME_CHARS {
        // keep the extension when shortening
        let (stem, ext) = match name.rfind('.') {
            Some(i) if name.len() - i <= 12 => (name[..i].to_owned(), name[i..].to_owned()),
            _ => (name.clone(), String::new()),
        };
        let keep = MAX_NAME_CHARS.saturating_sub(ext.chars().count());
        name = stem.chars().take(keep).collect::<String>() + &ext;
    }
    let stem_upper = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem_upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem_upper.len() == 4
            && (stem_upper.starts_with("COM") || stem_upper.starts_with("LPT"))
            && stem_upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    if name.is_empty() || name == "." || name == ".." {
        name = "file".to_owned();
    }
    name
}

#[cfg(unix)]
fn private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
fn private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// One edit's private directory and the file inside it.
#[derive(Debug, Clone)]
pub struct EditFiles {
    pub dir: PathBuf,
    pub file: PathBuf,
}

/// Create `<root>/<id>/<name>` and write `content` into it.
pub fn create(
    root: &Path,
    edit_id: &str,
    remote_path: &str,
    content: &[u8],
) -> std::io::Result<EditFiles> {
    private_dir(root)?;
    let dir = root.join(edit_id);
    // `create_dir` (not `create_dir_all`): the directory must be new.
    std::fs::create_dir(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let file = dir.join(sanitize_file_name(remote_path));
    debug_assert!(file.starts_with(root));
    let mut out = create_private_file(&file)?;
    out.write_all(content)?;
    out.sync_all()?;
    Ok(EditFiles { dir, file })
}

/// Remove one edit directory. Errors (for example the editor still holds the
/// file open on Windows) are returned so the caller can keep the files.
pub fn remove(files: &EditFiles) -> std::io::Result<()> {
    match std::fs::remove_dir_all(&files.dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Start-up housekeeping: drop edit directories left by earlier runs once
/// they are old enough that nobody is still working in them. Returns how many
/// were removed.
pub fn purge_stale(root: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .unwrap_or_default();
        if age >= STALE_AFTER && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_never_contain_separators_or_traversal() {
        assert_eq!(sanitize_file_name("/etc/ssh/sshd_config"), "sshd_config");
        assert_eq!(sanitize_file_name("/a/../../b.txt"), "b.txt");
        assert_eq!(sanitize_file_name("/a/.."), "file");
        assert_eq!(sanitize_file_name("/a/."), "file");
        assert_eq!(sanitize_file_name("/"), "file");
        assert_eq!(sanitize_file_name(""), "file");
        assert_eq!(sanitize_file_name("/x/a\\b:c*?.txt"), "a_b_c__.txt");
        assert_eq!(sanitize_file_name("/x/line\nbreak.cfg"), "line_break.cfg");
        assert_eq!(sanitize_file_name("/x/trailing. . "), "trailing");
        for name in ["/x/CON", "/x/nul.txt", "/x/COM1.log", "/x/lpt9"] {
            assert!(sanitize_file_name(name).starts_with('_'), "{name}");
        }
        assert_eq!(sanitize_file_name("/x/console.log"), "console.log");
    }

    #[test]
    fn long_names_keep_their_extension() {
        let long = format!("/x/{}.conf", "a".repeat(400));
        let name = sanitize_file_name(&long);
        assert!(name.chars().count() <= MAX_NAME_CHARS);
        assert!(name.ends_with(".conf"));
    }

    #[test]
    fn files_are_created_once_inside_a_private_directory() {
        let root = tempfile::tempdir().unwrap();
        let files = create(root.path(), "edit-1", "/etc/hosts", b"127.0.0.1 localhost").unwrap();
        assert_eq!(files.file, root.path().join("edit-1").join("hosts"));
        assert_eq!(std::fs::read(&files.file).unwrap(), b"127.0.0.1 localhost");
        // the same edit id cannot be reused (no overwrite, no following)
        assert!(create(root.path(), "edit-1", "/etc/hosts", b"x").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir_mode = std::fs::metadata(&files.dir).unwrap().permissions().mode() & 0o777;
            let file_mode = std::fs::metadata(&files.file).unwrap().permissions().mode() & 0o777;
            assert_eq!((dir_mode, file_mode), (0o700, 0o600));
        }
        remove(&files).unwrap();
        assert!(!files.dir.exists());
        remove(&files).unwrap(); // idempotent
    }

    #[test]
    fn stale_directories_are_purged_but_recent_ones_are_kept() {
        let root = tempfile::tempdir().unwrap();
        create(root.path(), "old", "/f", b"1").unwrap();
        create(root.path(), "new", "/f", b"2").unwrap();
        let future = SystemTime::now() + STALE_AFTER + Duration::from_secs(60);
        // pretend "now" is far in the future for the old one only: both are
        // equally old on disk, so purge with a near "now" first
        assert_eq!(purge_stale(root.path(), SystemTime::now()), 0);
        assert_eq!(purge_stale(root.path(), future), 2);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
