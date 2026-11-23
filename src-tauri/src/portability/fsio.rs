// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Safe file input/output for exports and backups.
//!
//! * Reads are size-capped *before and while* reading and only accept regular
//!   files (no devices, pipes or directories).
//! * Writes go to a hidden sibling temp file (`create_new`, owner-only on
//!   Unix), are flushed to disk and then renamed over the destination, so a
//!   half-written file never carries the final name. The temp file is removed
//!   on every failure path.

use crate::error::{AppError, AppResult};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Why a read or write was refused (fixed vocabulary, safe to show and log).
pub fn io_reason(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match error.kind() {
        NotFound => "the file was not found",
        PermissionDenied => "permission denied",
        AlreadyExists => "the file already exists",
        StorageFull => "the disk is full",
        ReadOnlyFilesystem => "the location is read-only",
        _ => "the file could not be accessed",
    }
}

/// Read a regular file of at most `max` bytes.
pub fn read_capped(path: &Path, max: u64) -> AppResult<Vec<u8>> {
    let meta = fs::metadata(path).map_err(|e| {
        AppError::Validation(format!("Could not open the file: {}.", io_reason(&e)))
    })?;
    if !meta.is_file() {
        return Err(AppError::Validation("That is not a regular file.".into()));
    }
    if meta.len() > max {
        return Err(AppError::Validation(format!(
            "The file is too large (limit {} MB).",
            max / (1024 * 1024)
        )));
    }
    let file = File::open(path).map_err(|e| {
        AppError::Validation(format!("Could not open the file: {}.", io_reason(&e)))
    })?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // One byte more than allowed: a file that grew since the check is caught.
    file.take(max + 1).read_to_end(&mut bytes).map_err(|e| {
        AppError::Validation(format!("Could not read the file: {}.", io_reason(&e)))
    })?;
    if bytes.len() as u64 > max {
        return Err(AppError::Validation("The file is too large.".into()));
    }
    Ok(bytes)
}

fn temp_sibling(dest: &Path) -> AppResult<PathBuf> {
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::Validation("The destination has no folder.".into()))?;
    let name = dest
        .file_name()
        .ok_or_else(|| AppError::Validation("The destination has no file name.".into()))?
        .to_string_lossy();
    Ok(parent.join(format!(".{name}.{}.part", uuid::Uuid::new_v4())))
}

/// Open the temp file for exclusive creation; private to the owner on Unix.
fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Stage `bytes` next to `dest` and flush them; returns the temp path. The
/// caller verifies it if it wants to, then calls [`publish`] or [`discard`].
pub fn stage(dest: &Path, bytes: &[u8]) -> AppResult<PathBuf> {
    let temp = temp_sibling(dest)?;
    let result = (|| -> std::io::Result<()> {
        let mut file = create_private(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    match result {
        Ok(()) => Ok(temp),
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(AppError::Storage(format!(
                "Could not write the file: {}.",
                io_reason(&e)
            )))
        }
    }
}

/// Move a staged file to its final name. With `overwrite == false` an existing
/// destination is an error (callers pass `true` only after the operating
/// system's save dialog has asked the user to confirm replacing it).
pub fn publish(temp: &Path, dest: &Path, overwrite: bool) -> AppResult<()> {
    if !overwrite && dest.exists() {
        discard(temp);
        return Err(AppError::Validation(
            "A file with that name already exists. Nothing was overwritten.".into(),
        ));
    }
    fs::rename(temp, dest).map_err(|e| {
        discard(temp);
        AppError::Storage(format!("Could not write the file: {}.", io_reason(&e)))
    })
}

pub fn discard(temp: &Path) {
    let _ = fs::remove_file(temp);
}

/// Stage and publish in one step.
pub fn write_atomic(dest: &Path, bytes: &[u8], overwrite: bool) -> AppResult<()> {
    let temp = stage(dest, bytes)?;
    publish(&temp, dest, overwrite)
}

/// Make sure the destination carries `ext` (without dot).
pub fn with_extension(mut dest: PathBuf, ext: &str) -> PathBuf {
    if dest
        .extension()
        .is_none_or(|e| !e.eq_ignore_ascii_case(ext))
    {
        let mut name = dest.file_name().unwrap_or_default().to_os_string();
        name.push(".");
        name.push(ext);
        dest.set_file_name(name);
    }
    dest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_is_atomic_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.json");
        write_atomic(&dest, b"one", false).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"one");
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn existing_destination_is_not_overwritten_without_permission() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.json");
        fs::write(&dest, b"old").unwrap();
        assert!(write_atomic(&dest, b"new", false).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"old");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "temp removed");
        write_atomic(&dest, b"new", true).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn failed_publish_cleans_up_and_keeps_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("target");
        fs::create_dir(&dest).unwrap(); // a directory cannot be replaced by a file
        assert!(write_atomic(&dest, b"x", true).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn missing_folder_is_reported_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("nope").join("a.json");
        assert!(write_atomic(&dest, b"x", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn files_are_private_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.json");
        write_atomic(&dest, b"x", true).unwrap();
        assert_eq!(fs::metadata(&dest).unwrap().permissions().mode() & 0o077, 0);
    }

    #[test]
    fn reads_are_capped_and_only_for_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big");
        fs::write(&file, vec![0u8; 100]).unwrap();
        assert_eq!(read_capped(&file, 100).unwrap().len(), 100);
        assert!(read_capped(&file, 99).is_err());
        assert!(read_capped(dir.path(), 100).is_err());
        assert!(read_capped(&dir.path().join("missing"), 100).is_err());
    }

    #[test]
    fn extension_is_appended_only_when_missing() {
        assert_eq!(
            with_extension(PathBuf::from("/x/a"), "json"),
            PathBuf::from("/x/a.json")
        );
        assert_eq!(
            with_extension(PathBuf::from("/x/a.JSON"), "json"),
            PathBuf::from("/x/a.JSON")
        );
        assert_eq!(
            with_extension(PathBuf::from("/x/a.b"), "json"),
            PathBuf::from("/x/a.b.json")
        );
    }
}
