// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Crash-safe JSON persistence and forgiving loading.
//!
//! Writes go to a sibling temp file, are flushed to disk, then renamed over
//! the target, so a reader sees the old or the new document, never a
//! truncated one. Loads never fail the application: a damaged file or field is
//! reported as a [`ConfigIssue`], a copy of the original is kept, and valid
//! data around the damage is preserved.

use crate::error::{AppError, AppResult};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

/// A recoverable problem found while loading a data file. Carries only names
/// from our own schema, never file contents, so it is safe to log and show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigIssue {
    /// File name only (no directory).
    pub file: String,
    /// Stable machine-readable kind, e.g. `invalid_json`, `invalid_value`.
    pub kind: &'static str,
    /// Schema field/section name when the problem is local to one field.
    pub field: Option<String>,
    /// A copy of the original file was kept next to it.
    pub backed_up: bool,
}

impl ConfigIssue {
    /// One-line, secret-free description for the UI.
    pub fn describe(&self) -> String {
        let what = match (self.kind, &self.field) {
            ("invalid_json", _) => "is not valid JSON; defaults were used".to_owned(),
            ("not_an_object", _) => "has an unexpected layout; defaults were used".to_owned(),
            ("unreadable", _) => "could not be read; defaults were used".to_owned(),
            ("repaired_references", _) => {
                "referenced folders that no longer exist; those items were moved to the top level"
                    .to_owned()
            }
            (_, Some(field)) => {
                format!("has an invalid value for \"{field}\"; its default was used")
            }
            (_, None) => "contained invalid entries that were skipped".to_owned(),
        };
        let kept = if self.backed_up {
            " The original was kept."
        } else {
            ""
        };
        format!("{} {what}.{kept}", self.file)
    }
}

pub fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

const MAX_BACKUPS: usize = 5;

/// Keep a copy of a file that failed to load cleanly, so the next save cannot
/// destroy the only copy of the user's data. Returns whether a copy exists.
fn backup_original(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let label = file_label(path);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let prefix = format!("{label}.corrupt-");
    if fs::copy(path, parent.join(format!("{prefix}{stamp}"))).is_err() {
        return false;
    }
    let mut backups: Vec<_> = fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| e.path())
        .collect();
    backups.sort();
    while backups.len() > MAX_BACKUPS {
        let _ = fs::remove_file(backups.remove(0));
    }
    true
}

/// Before an upgrade may rewrite a user data file, keep a copy of the version
/// that was on disk (`<file>.pre-v<N>-<time>`). Done once per file and version.
pub fn backup_before_migration(path: &Path, from_version: u32) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let label = file_label(path);
    let prefix = format!("{label}.pre-v{from_version}-");
    let exists = fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().starts_with(&prefix));
    if exists {
        return true;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    fs::copy(path, parent.join(format!("{prefix}{stamp}"))).is_ok()
}

/// Read a JSON document. A missing file is `None` without an issue; anything
/// else that goes wrong becomes an issue (and a backup) and also yields `None`.
pub fn load_json_value(path: &Path, issues: &mut Vec<ConfigIssue>) -> Option<Value> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            issues.push(ConfigIssue {
                file: file_label(path),
                kind: "unreadable",
                field: None,
                backed_up: false,
            });
            return None;
        }
    };
    // Tolerate a UTF-8 BOM written by some Windows editors.
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => Some(value),
        Err(_) => {
            issues.push(ConfigIssue {
                file: file_label(path),
                kind: "invalid_json",
                field: None,
                backed_up: backup_original(path),
            });
            None
        }
    }
}

/// If a load added issues (from index `from`) but no backup exists yet, make
/// one, so entries that were skipped can still be recovered by hand.
pub fn ensure_backup(path: &Path, issues: &mut [ConfigIssue], from: usize) {
    if issues.len() <= from || issues[from..].iter().any(|i| i.backed_up) {
        return;
    }
    let ok = backup_original(path);
    for issue in &mut issues[from..] {
        issue.backed_up = ok;
    }
}

/// Deserialize `file` into `T` field by field: a value that does not fit is
/// replaced by its default and reported, everything else is kept. Unknown keys
/// are ignored (so e.g. a hand-added upload-bypass flag can never take effect).
pub fn merge_lenient<T>(file: Value, path: &Path, issues: &mut Vec<ConfigIssue>) -> T
where
    T: Serialize + DeserializeOwned + Default,
{
    let name = file_label(path);
    let mut note = |kind: &'static str, field: Option<&str>| {
        issues.push(ConfigIssue {
            file: name.clone(),
            kind,
            field: field.map(str::to_owned),
            backed_up: false,
        });
    };
    let Ok(mut base) = serde_json::to_value(T::default()) else {
        return T::default();
    };
    let fits = |doc: &Value| serde_json::from_value::<T>(doc.clone()).is_ok();
    let Value::Object(file_obj) = file else {
        note("not_an_object", None);
        return T::default();
    };
    for (key, value) in file_obj {
        let Some(default_slot) = base.get(&key).cloned() else {
            continue; // unknown key
        };
        let mut candidate = base.clone();
        candidate[&key] = value.clone();
        if fits(&candidate) {
            base = candidate;
            continue;
        }
        // The section as a whole does not fit: salvage it field by field.
        if let (Value::Object(fields), Value::Object(_)) = (&value, &default_slot) {
            let mut section = default_slot;
            for (field, field_value) in fields {
                if section.get(field).is_none() {
                    continue;
                }
                let mut trial = section.clone();
                trial[field] = field_value.clone();
                let mut doc = base.clone();
                doc[&key] = trial.clone();
                if fits(&doc) {
                    section = trial;
                } else {
                    note("invalid_value", Some(&format!("{key}.{field}")));
                }
            }
            base[&key] = section;
        } else {
            note("invalid_value", Some(&key));
        }
    }
    serde_json::from_value(base).unwrap_or_default()
}

/// Parse an array entry by entry; entries that do not fit are skipped.
pub fn parse_entries<T: DeserializeOwned>(
    value: Option<&Value>,
    path: &Path,
    field: &str,
    issues: &mut Vec<ConfigIssue>,
) -> Vec<T> {
    let Some(Value::Array(items)) = value else {
        if value.is_some_and(|v| !v.is_null()) {
            issues.push(ConfigIssue {
                file: file_label(path),
                kind: "invalid_value",
                field: Some(field.to_owned()),
                backed_up: false,
            });
        }
        return Vec::new();
    };
    let mut skipped = false;
    let parsed = items
        .iter()
        .filter_map(|item| match serde_json::from_value::<T>(item.clone()) {
            Ok(entry) => Some(entry),
            Err(_) => {
                skipped = true;
                None
            }
        })
        .collect();
    if skipped {
        issues.push(ConfigIssue {
            file: file_label(path),
            kind: "invalid_entries",
            field: None,
            backed_up: false,
        });
    }
    parsed
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
    #[serde(default)]
    struct Inner {
        size: u32,
        name: String,
    }

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    #[serde(default)]
    struct Doc {
        value: u32,
        inner: Inner,
        flag: bool,
    }

    fn merge(json: &str) -> (Doc, Vec<ConfigIssue>) {
        let mut issues = Vec::new();
        let doc = merge_lenient(
            serde_json::from_str(json).unwrap(),
            Path::new("doc.json"),
            &mut issues,
        );
        (doc, issues)
    }

    #[test]
    fn round_trip_and_overwrite_unicode_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Подкаталог 設定").join("doc.json");
        let one = Doc {
            value: 1,
            ..Doc::default()
        };
        let two = Doc {
            value: 2,
            inner: Inner {
                size: 3,
                name: "ü".into(),
            },
            flag: true,
        };
        save_json(&path, &one).unwrap();
        save_json(&path, &two).unwrap();
        let mut issues = Vec::new();
        let value = load_json_value(&path, &mut issues).unwrap();
        assert!(issues.is_empty());
        assert_eq!(serde_json::from_value::<Doc>(value).unwrap(), two);
        // No temp files left behind.
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn missing_file_is_not_an_issue() {
        let dir = tempfile::tempdir().unwrap();
        let mut issues = Vec::new();
        assert!(load_json_value(&dir.path().join("none.json"), &mut issues).is_none());
        assert!(issues.is_empty());
    }

    #[test]
    fn corrupt_file_is_reported_and_backed_up_not_lost() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        fs::write(&path, b"{ not json").unwrap();
        let mut issues = Vec::new();
        assert!(load_json_value(&path, &mut issues).is_none());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, "invalid_json");
        assert!(issues[0].backed_up);
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].path()).unwrap(), b"{ not json");
    }

    #[test]
    fn utf8_bom_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        fs::write(&path, b"\xEF\xBB\xBF{\"value\": 4}").unwrap();
        let mut issues = Vec::new();
        assert!(load_json_value(&path, &mut issues).is_some());
        assert!(issues.is_empty());
    }

    #[test]
    fn one_bad_field_does_not_reset_the_rest() {
        let (doc, issues) =
            merge(r#"{"value": 7, "inner": {"size": "huge", "name": "keep"}, "flag": true}"#);
        assert_eq!(doc.value, 7);
        assert!(doc.flag);
        assert_eq!(
            doc.inner,
            Inner {
                size: 0,
                name: "keep".into()
            }
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].field.as_deref(), Some("inner.size"));
    }

    #[test]
    fn bad_top_level_scalar_is_defaulted_individually() {
        let (doc, issues) = merge(r#"{"value": "x", "flag": true}"#);
        assert_eq!(doc.value, 0);
        assert!(doc.flag);
        assert_eq!(issues[0].field.as_deref(), Some("value"));
    }

    #[test]
    fn unknown_keys_are_ignored_silently() {
        let (doc, issues) = merge(r#"{"value": 1, "futureKey": {"a": 1}}"#);
        assert_eq!(doc.value, 1);
        assert!(issues.is_empty());
    }

    #[test]
    fn non_object_document_yields_defaults() {
        let (doc, issues) = merge("[1,2,3]");
        assert_eq!(doc, Doc::default());
        assert_eq!(issues[0].kind, "not_an_object");
    }

    #[test]
    fn entries_are_parsed_one_by_one() {
        let value: Value = serde_json::from_str(r#"[{"size":1},{"size":"x"},{"size":3}]"#).unwrap();
        let mut issues = Vec::new();
        let parsed: Vec<Inner> =
            parse_entries(Some(&value), Path::new("doc.json"), "items", &mut issues);
        assert_eq!(
            parsed.iter().map(|i| i.size).collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert_eq!(issues[0].kind, "invalid_entries");
    }

    #[test]
    fn issue_descriptions_contain_no_paths() {
        let issue = ConfigIssue {
            file: "settings.json".into(),
            kind: "invalid_value",
            field: Some("ssh.keepaliveSecs".into()),
            backed_up: true,
        };
        let text = issue.describe();
        assert!(text.contains("settings.json") && text.contains("ssh.keepaliveSecs"));
        assert!(!text.contains('\\') && !text.contains('/'));
    }
}
