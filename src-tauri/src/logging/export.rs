// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Diagnostic export: a zip with sanitised copies of the log files.
//!
//! Nothing is uploaded; the user picks where the archive is saved, can inspect
//! the file list first and can open the archive before sharing it.
//!
//! The logs are allowlisted when written, but an exported file could have been
//! edited, produced by another version, or written into a shared directory, so
//! every line is rebuilt from scratch here: only known keys with correctly
//! shaped values survive, then a second filter drops anything that still looks
//! like a path, e-mail address, host or IP. Lines that are not valid JSON
//! objects are discarded, never passed through.

use super::fields::{self, FieldKind};
use super::layer::is_first_party;
use super::writer::{self, LogFile};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::SystemTime;
use zip::write::SimpleFileOptions;

const MAX_LINE: u64 = 16 * 1024;
pub const METADATA_NAME: &str = "diagnostics.json";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub files: Vec<ExportFile>,
    pub total_bytes: u64,
}

/// What would be exported (names and sizes of the *source* files).
pub fn preview(dir: &Path) -> ExportPreview {
    let mut files: Vec<ExportFile> = writer::list_log_files(dir)
        .into_iter()
        .map(|f: LogFile| ExportFile {
            name: f.name,
            bytes: f.bytes,
        })
        .collect();
    files.push(ExportFile {
        name: METADATA_NAME.into(),
        bytes: 0,
    });
    let total_bytes = files.iter().map(|f| f.bytes).sum();
    ExportPreview { files, total_bytes }
}

fn looks_like_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Second, independent filter on string values.
fn looks_sensitive(kind: FieldKind, s: &str) -> bool {
    s.contains(['@', '\\', '/', ' ', ':']) && !matches!(kind, FieldKind::Version)
        || (kind != FieldKind::Version && looks_like_ipv4(s))
}

fn plausible_timestamp(ts: &str) -> bool {
    ts.len() == 27
        && ts.ends_with('Z')
        && ts
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b'T' | b'.' | b'Z'))
}

/// Rebuild one log line from allowlisted parts. `None` = drop the line.
pub fn sanitize_line(line: &str) -> Option<String> {
    let Value::Object(input) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let mut out = Map::new();

    let ts = input.get("ts")?.as_str()?;
    if !plausible_timestamp(ts) {
        return None;
    }
    out.insert("ts".into(), Value::from(ts));

    let level = input.get("level")?.as_str()?;
    if !matches!(level, "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE") {
        return None;
    }
    out.insert("level".into(), Value::from(level));

    let target = input.get("target")?.as_str()?;
    let target_ok = !target.is_empty()
        && target.len() <= 64
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':');
    out.insert(
        "target".into(),
        Value::from(if target_ok { target } else { "other" }),
    );

    for (key, value) in &input {
        let Some(kind) = fields::kind_of(key) else {
            continue; // includes ts/level/target (handled above) and everything unknown
        };
        let cleaned = match (kind, value) {
            (FieldKind::Count, Value::Number(n)) => n.as_u64().map(Value::from),
            (FieldKind::Flag, Value::Bool(b)) => Some(Value::from(*b)),
            (FieldKind::Count | FieldKind::Flag, _) => None,
            (k, Value::String(s)) => {
                if s == "<invalid>" {
                    Some(Value::from("<invalid>"))
                } else {
                    fields::clean_str(k, s)
                        .filter(|clean| !looks_sensitive(k, clean))
                        .map(Value::from)
                }
            }
            _ => None,
        };
        if let Some(v) = cleaned {
            out.insert(key.clone(), v);
        }
    }
    // First-party lines must name their event; the marker keeps them visible.
    if is_first_party(target) {
        out.entry("event").or_insert_with(|| Value::from("unnamed"));
    }
    Some(Value::Object(out).to_string())
}

#[derive(Debug, Clone)]
pub struct ExportMeta {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub log_level: String,
    pub retention_days: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntry {
    pub name: String,
    pub lines_kept: u64,
    pub lines_dropped: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub entries: Vec<ExportEntry>,
    pub archive_bytes: u64,
}

fn sanitize_file(source: &Path, out: &mut impl Write) -> std::io::Result<(u64, u64)> {
    let mut reader = BufReader::new(File::open(source)?);
    let (mut kept, mut dropped) = (0, 0);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        if n as u64 > MAX_LINE && buf.last() != Some(&b'\n') {
            // Oversized line: discard the rest of it without buffering it all.
            dropped += 1;
            let mut sink = Vec::new();
            loop {
                sink.clear();
                let k = reader
                    .by_ref()
                    .take(MAX_LINE)
                    .read_until(b'\n', &mut sink)?;
                if k == 0 || sink.last() == Some(&b'\n') {
                    break;
                }
            }
            continue;
        }
        let text = String::from_utf8_lossy(&buf);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        match sanitize_line(text) {
            Some(clean) => {
                out.write_all(clean.as_bytes())?;
                out.write_all(b"\n")?;
                kept += 1;
            }
            None => dropped += 1,
        }
    }
    Ok((kept, dropped))
}

/// Write the archive to `dest` (via a temp file, so a failure leaves nothing
/// half-written).
pub fn build_archive(
    dir: &Path,
    dest: &Path,
    meta: &ExportMeta,
    now: SystemTime,
) -> std::io::Result<ExportResult> {
    let temp = dest.with_extension("zip.part");
    let result = (|| {
        let file = File::create(&temp)?;
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut entries = Vec::new();
        for log in writer::list_log_files(dir) {
            zip.start_file(format!("logs/{}", log.name), options)
                .map_err(std::io::Error::other)?;
            let (lines_kept, lines_dropped) = sanitize_file(&log.path, &mut zip)?;
            entries.push(ExportEntry {
                name: log.name,
                lines_kept,
                lines_dropped,
            });
        }
        let info = serde_json::json!({
            "app": "PeachTerm",
            "version": meta.version,
            "os": meta.os,
            "arch": meta.arch,
            "exportedAt": super::clock::format_timestamp(now),
            "logLevel": meta.log_level,
            "retentionDays": meta.retention_days,
            "files": entries,
            "note": "Sanitised, allowlisted log fields only. No configuration files, credentials, host names, user names, file paths or terminal content are included.",
        });
        zip.start_file(METADATA_NAME, options)
            .map_err(std::io::Error::other)?;
        zip.write_all(serde_json::to_string_pretty(&info)?.as_bytes())?;
        zip.finish().map_err(std::io::Error::other)?;
        let archive_bytes = fs::metadata(&temp)?.len();
        fs::rename(&temp, dest)?;
        Ok(ExportResult {
            entries,
            archive_bytes,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"ts":"2026-11-22T13:41:58.000123Z","level":"INFO","target":"peachterm_lib::app","event":"app.start","version":"0.1.0","os":"windows","count":3,"enabled":true}"#;

    #[test]
    fn good_lines_survive_unchanged_in_content() {
        let clean = sanitize_line(GOOD).unwrap();
        let a: Value = serde_json::from_str(GOOD).unwrap();
        let b: Value = serde_json::from_str(&clean).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn unknown_keys_and_hostile_values_are_removed() {
        let hostile = r#"{"ts":"2026-11-22T13:41:58.000123Z","level":"INFO","target":"peachterm_lib::x","event":"app.start","password":"hunter2","host":"srv.example.com","username":"root","message":"login as root@10.0.0.1","error_kind":"root@10.0.0.1","reason":"C:\\Users\\me\\x","state":"/etc/shadow","auth_kind":"10.1.2.3","status":"two words","file":"id_ed25519","session_id":"web-01","count":"7","enabled":"yes"}"#;
        let clean = sanitize_line(hostile).unwrap();
        for leaked in [
            "hunter2",
            "example.com",
            "root",
            "10.0.0.1",
            "C:",
            "shadow",
            "10.1.2.3",
            "two words",
            "id_ed25519",
            "web-01",
            "login",
        ] {
            assert!(!clean.contains(leaked), "leaked {leaked}: {clean}");
        }
        let v: Value = serde_json::from_str(&clean).unwrap();
        assert_eq!(v["event"], "app.start");
        assert!(v.get("count").is_none() && v.get("enabled").is_none());
    }

    #[test]
    fn non_json_and_malformed_lines_are_dropped() {
        for bad in [
            "password=hunter2",
            "[1,2]",
            "{\"ts\":\"x\",\"level\":\"INFO\",\"target\":\"a\"}",
            "{\"ts\":\"2026-11-22T13:41:58.000123Z\",\"level\":\"SECRET\",\"target\":\"a\"}",
            "",
        ] {
            assert!(sanitize_line(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn bad_target_is_replaced() {
        let line = r#"{"ts":"2026-11-22T13:41:58.000123Z","level":"WARN","target":"C:\\secret path","third_party":true}"#;
        let v: Value = serde_json::from_str(&sanitize_line(line).unwrap()).unwrap();
        assert_eq!(v["target"], "other");
        assert!(!v.to_string().contains("secret"));
    }

    #[test]
    fn archive_contains_only_sanitised_logs_and_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        let huge = format!("{{\"ts\":\"{}\"}}", "A".repeat(100_000));
        fs::write(
            logs.join("peachterm-2026-11-22.log"),
            format!(
                "{GOOD}\npassword=hunter2\n{huge}\n{{\"ts\":\"2026-11-22T13:41:58.000123Z\",\"level\":\"INFO\",\"target\":\"peachterm_lib\",\"event\":\"a.b\",\"host\":\"leak.example.com\"}}\n"
            ),
        )
        .unwrap();
        // Unrelated files in the same directory must never be exported.
        fs::write(logs.join("settings.json"), "{\"token\":\"hunter2\"}").unwrap();
        fs::write(logs.join("notes.txt"), "private").unwrap();

        let pre = preview(&logs);
        assert_eq!(
            pre.files
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            vec!["peachterm-2026-11-22.log", METADATA_NAME]
        );

        let dest = dir.path().join("out.zip");
        let meta = ExportMeta {
            version: "0.1.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            log_level: "info".into(),
            retention_days: 14,
        };
        let result = build_archive(&logs, &dest, &meta, SystemTime::now()).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].lines_kept, 2);
        assert_eq!(result.entries[0].lines_dropped, 2);
        assert!(!dest.with_extension("zip.part").exists());

        let mut archive = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let mut names: Vec<String> = archive
            .file_names()
            .map(|n| n.unwrap().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec![METADATA_NAME, "logs/peachterm-2026-11-22.log"]);
        let mut all = String::new();
        for i in 0..archive.len() {
            archive
                .by_index(i)
                .unwrap()
                .read_to_string(&mut all)
                .unwrap();
        }
        for leaked in ["hunter2", "leak.example", "private", "token"] {
            assert!(!all.contains(leaked), "leaked {leaked}");
        }
        assert!(all.contains("app.start") && all.contains("\"version\": \"0.1.0\""));
    }

    #[test]
    fn failed_export_leaves_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        let dest = dir.path().join("missing-dir").join("out.zip");
        let meta = ExportMeta {
            version: "0.1.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            log_level: "info".into(),
            retention_days: 14,
        };
        assert!(build_archive(&logs, &dest, &meta, SystemTime::now()).is_err());
        assert!(!dir.path().join("missing-dir").exists());
    }
}
