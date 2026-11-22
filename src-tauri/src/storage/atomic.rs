//! Crash-safe JSON persistence: write to a sibling temp file, flush to disk,
//! then rename over the target. A reader therefore sees either the old or the
//! new document, never a truncated one.

use crate::error::{AppError, AppResult};
use serde::{Serialize, de::DeserializeOwned};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

/// Load `path`, returning `T::default()` when the file does not exist yet.
/// A corrupt file is reported as an error instead of being silently replaced.
pub fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> AppResult<T> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            AppError::Storage(format!(
                "{} is not valid ({error})",
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn save_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Storage("data file has no parent directory".into()))?;
    fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(value)?;

    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::Storage("data file has no name".into()))?
        .to_string_lossy();
    let temp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // `rename` replaces an existing target atomically on POSIX and uses
        // MoveFileExW(MOVEFILE_REPLACE_EXISTING) on Windows.
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Doc {
        value: u32,
        text: String,
    }

    #[test]
    fn missing_file_yields_default() {
        let dir = tempfile::tempdir().unwrap();
        let doc: Doc = load_json_or_default(&dir.path().join("none.json")).unwrap();
        assert_eq!(doc, Doc::default());
    }

    #[test]
    fn round_trip_and_overwrite_unicode_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Подкаталог 設定").join("doc.json");
        save_json(
            &path,
            &Doc {
                value: 1,
                text: "a".into(),
            },
        )
        .unwrap();
        save_json(
            &path,
            &Doc {
                value: 2,
                text: "ü".into(),
            },
        )
        .unwrap();
        let doc: Doc = load_json_or_default(&path).unwrap();
        assert_eq!(
            doc,
            Doc {
                value: 2,
                text: "ü".into()
            }
        );
        // No temp files left behind.
        let leftovers = fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_reset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        fs::write(&path, b"{ not json").unwrap();
        assert!(load_json_or_default::<Doc>(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{ not json");
    }
}
