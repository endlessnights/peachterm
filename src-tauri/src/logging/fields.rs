//! The allowlist of fields that may ever appear in a log line.
//!
//! This is the primary protection against leaking secrets: a field that is not
//! listed here is dropped, whatever its value and whatever the log level.
//! A listed field is only emitted when its *value* belongs to a closed set
//! (event names, tokens, config field names, data file names) or is a number,
//! a boolean or a canonical UUID. Shape checks alone are not enough: a
//! password such as `hunter2-X` looks exactly like a harmless token, so text
//! values must be members of a reviewed list, otherwise they become `<invalid>`.
//! Free-form text (`message`, error chains, panic payloads, file paths, host
//! names, user names) has no field and therefore cannot be logged.
//! Regex redaction is only used as a second, independent layer on export.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    /// A registered event name (see [`EVENTS`]).
    Event,
    /// Lowercase token such as `password` (auth kind) or `permission_denied`.
    Ident,
    /// `MAJOR.MINOR.PATCH` with an optional short pre-release suffix.
    Version,
    /// Canonical UUID (session and connection ids).
    Uuid,
    /// One of our own data file names.
    DataFile,
    /// A configuration field of ours, e.g. `ssh.keepaliveSecs`.
    ConfigField,
    /// A Rust source file name, e.g. `lib.rs`.
    SourceFile,
    /// Unsigned integer.
    Count,
    /// Boolean.
    Flag,
}

/// Field name → value shape. Adding a field here is a security decision:
/// its values must never carry user-controlled text.
pub fn kind_of(name: &str) -> Option<FieldKind> {
    use FieldKind::*;
    Some(match name {
        "event" => Event,
        "version" => Version,
        "os" | "arch" | "kind" | "issue" | "reason" | "error_kind" | "auth_kind"
        | "host_key_status" | "state" | "status" | "backend" | "log_level" | "phase" => Ident,
        "session_id" | "connection_id" | "transfer_id" => Uuid,
        "file" => DataFile,
        "field" => ConfigField,
        "source_file" => SourceFile,
        "count" | "bytes" | "duration_ms" | "attempt" | "code" | "retention_days" | "line"
        | "max_total_mb" | "files" => Count,
        "enabled" | "backup" | "active" | "custom_dir" | "third_party" => Flag,
        _ => return None,
    })
}

/// Every token an `Ident` field may carry. Shape checks alone cannot tell
/// `permission_denied` from a password such as `hunter2`, so the values are a
/// closed set: adding a token is a deliberate, reviewable change. Anything else
/// is replaced by `<invalid>`.
pub const IDENT_VOCABULARY: &[&str] = &[
    // os / arch
    "windows",
    "linux",
    "macos",
    "x86_64",
    "aarch64",
    "x86",
    "arm",
    "riscv64",
    "unknown",
    // generic
    "none",
    "ok",
    "failed",
    "started",
    "completed",
    "cancelled",
    "skipped",
    "timeout",
    // io / storage failures
    "permission_denied",
    "not_found",
    "already_exists",
    "not_a_directory",
    "is_a_directory",
    "disk_full",
    "read_only",
    "invalid_path",
    "io_error",
    "relative_path",
    "writer_stopped",
    // config issues
    "invalid_json",
    "not_an_object",
    "unreadable",
    "invalid_value",
    "invalid_entries",
    "dark",
    "light",
    "repaired_references",
    // credential store
    "keychain",
    "platform_failure",
    "no_storage_access",
    "no_entry",
    "bad_encoding",
    "too_long",
    "invalid",
    "ambiguous",
    "other",
    // log levels
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    // authentication (Phase 2)
    "password",
    "public_key",
    "keyboard_interactive",
    "agent",
    // host keys (Phase 2)
    "matched",
    "changed",
    "trusted",
    "rejected",
    // session / sftp / editor lifecycle (Phases 2-4)
    "connecting",
    "awaiting_host_key",
    "authenticating",
    "connected",
    "disconnected",
    "ready",
    "initializing",
    "unsupported",
    "subsystem_refused",
    "connect",
    "handshake",
    "auth",
    "channel",
    "sftp",
    "upload",
    "download",
    "cleanup",
    "approved",
    "declined",
    "conflict",
    "policy_reset",
    // SSH / SFTP / editor failure reasons and operations
    "connect_failed",
    "host_key_rejected",
    "auth_failed",
    "key_unreadable",
    "agent_unavailable",
    "protocol_error",
    "unavailable",
    "not_empty",
    "remote_changed",
    "local_io",
    "pending",
    "yes_to_all",
    "too_large",
    "launch_failed",
    "list",
    "mkdir",
    "rename",
    "delete",
    "always_ask",
];

/// Every event name that may be logged: the documented log schema. A new event
/// must be added here, which keeps names static and reviewable.
pub const EVENTS: &[&str] = &[
    // application
    "app.start",
    "lock.locked",
    "lock.unlocked",
    "lock.unlock_failed",
    "lock.password_set",
    "lock.password_removed",
    "window.theme_applied",
    "app.shutdown",
    "app.panic",
    "app.init_failed",
    // configuration
    "config.loaded",
    "config.saved",
    "config.issue",
    // logging itself
    "logging.configured",
    "logging.disabled",
    "logging.exported",
    "logging.export_failed",
    "logs.dropped",
    // saved connections and credentials
    "connection.created",
    "connection.updated",
    "connection.deleted",
    "connection.duplicated",
    "folder.saved",
    "folder.deleted",
    "credentials.saved",
    "credentials.cleared",
    "credentials.cleared_all",
    "credentials.unavailable",
    "known_hosts.removed",
    // SSH sessions (Phase 2)
    "ssh.connect_started",
    "ssh.connected",
    "ssh.connect_failed",
    "ssh.auth_succeeded",
    "ssh.auth_failed",
    "ssh.host_key_checked",
    "ssh.disconnected",
    "ssh.reconnect_attempt",
    "ssh.session_cleanup",
    // SFTP (Phase 3)
    "sftp.init_started",
    "sftp.ready",
    "sftp.unsupported",
    "sftp.list_failed",
    "sftp.transfer_started",
    "sftp.transfer_completed",
    "sftp.transfer_failed",
    "sftp.op_failed",
    // external editor round trip (Phase 4)
    "editor.launched",
    "editor.local_change_detected",
    "editor.write_confirmation_requested",
    "editor.upload_approved",
    "editor.upload_declined",
    "editor.upload_completed",
    "editor.upload_failed",
    "editor.conflict_detected",
    "editor.policy_reset",
];

fn event_registered(value: &str) -> bool {
    // Unit tests may use `test.*` names; production builds never accept them.
    EVENTS.contains(&value) || (cfg!(test) && value.starts_with("test."))
}

/// `section` and `section.field` names taken from the real settings schema, so
/// they cannot drift from the code and cannot be arbitrary text.
fn config_field_names() -> &'static std::collections::HashSet<String> {
    static NAMES: std::sync::OnceLock<std::collections::HashSet<String>> =
        std::sync::OnceLock::new();
    NAMES.get_or_init(|| {
        let mut names: std::collections::HashSet<String> =
            ["connections", "folders", "hosts"].map(String::from).into();
        if let Ok(Value::Object(top)) =
            serde_json::to_value(crate::storage::settings::Settings::default())
        {
            for (section, body) in top {
                if let Value::Object(fields) = body {
                    for field in fields.keys() {
                        names.insert(format!("{section}.{field}"));
                    }
                }
                names.insert(section);
            }
        }
        names
    })
}

fn version_shaped(value: &str) -> bool {
    let (core, suffix) = match value.split_once(['-', '+']) {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (value, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 4 && p.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|s| {
            all(s, 16, |c| c.is_ascii_alphanumeric() || c == '.')
                && s.starts_with(char::is_alphabetic)
        })
}

fn source_file_shaped(value: &str) -> bool {
    value.strip_suffix(".rs").is_some_and(|stem| {
        all(stem, 40, |c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
        })
    })
}

const DATA_FILES: [&str; 4] = [
    "connections.json",
    "settings.json",
    "known_hosts.json",
    "workspace.json",
];

fn all(s: &str, max: usize, ok: impl Fn(char) -> bool) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(ok)
}

/// Validate a string value for `kind`. `None` means "reject".
pub fn clean_str(kind: FieldKind, value: &str) -> Option<String> {
    let ok = match kind {
        FieldKind::Event => event_registered(value),
        FieldKind::Ident => IDENT_VOCABULARY.contains(&value),
        FieldKind::Version => version_shaped(value),
        FieldKind::Uuid => uuid::Uuid::parse_str(value).is_ok() && value.len() == 36,
        FieldKind::DataFile => DATA_FILES.contains(&value),
        FieldKind::ConfigField => config_field_names().contains(value),
        FieldKind::SourceFile => source_file_shaped(value),
        FieldKind::Count | FieldKind::Flag => false,
    };
    ok.then(|| value.to_owned())
}

/// Turn a raw recorded value into the JSON value to emit, or `None` to drop
/// the whole field. Invalid text values are replaced by a marker so that the
/// *presence* of a malformed field remains visible when debugging.
pub fn finish(kind: FieldKind, raw: Raw) -> Option<Value> {
    match (kind, raw) {
        (FieldKind::Count, Raw::U64(n)) => Some(Value::from(n)),
        (FieldKind::Count, Raw::I64(n)) if n >= 0 => Some(Value::from(n as u64)),
        (FieldKind::Flag, Raw::Bool(b)) => Some(Value::from(b)),
        (FieldKind::Count | FieldKind::Flag, _) => None,
        (k, Raw::Str(s)) => Some(Value::from(
            clean_str(k, &s).unwrap_or_else(|| "<invalid>".into()),
        )),
        (_, _) => None,
    }
}

#[derive(Debug, Clone)]
pub enum Raw {
    Str(String),
    U64(u64),
    I64(i64),
    Bool(bool),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlisted_fields_have_no_kind() {
        for name in [
            "message",
            "password",
            "passphrase",
            "host",
            "hostname",
            "user",
            "username",
            "path",
            "remote_path",
            "key_path",
            "token",
            "secret",
            "data",
            "payload",
            "clipboard",
            "content",
            "error",
            "err",
            "ip",
            "addr",
            "env",
        ] {
            assert!(kind_of(name).is_none(), "{name} must not be loggable");
        }
    }

    #[test]
    fn values_must_have_the_declared_shape() {
        assert!(clean_str(FieldKind::Event, "app.start").is_some());
        assert!(clean_str(FieldKind::Event, "App.Start").is_none());
        assert!(clean_str(FieldKind::Event, "app.hunter2").is_none());
        assert!(clean_str(FieldKind::Event, "hunter2-PASSWORD").is_none());
        assert!(clean_str(FieldKind::Ident, "permission_denied").is_some());
        for bad in [
            "a b",
            "root@example.com",
            "C:\\Users\\x",
            "/etc/passwd",
            "10.0.0.1",
            "ü",
            "",
        ] {
            assert!(clean_str(FieldKind::Ident, bad).is_none(), "{bad}");
        }
        assert!(clean_str(FieldKind::Uuid, "4f3653b1-1f94-4a43-a430-3db9ca1877f9").is_some());
        assert!(clean_str(FieldKind::Uuid, "web-01").is_none());
        assert!(clean_str(FieldKind::DataFile, "settings.json").is_some());
        assert!(clean_str(FieldKind::DataFile, "id_ed25519").is_none());
        assert!(clean_str(FieldKind::Ident, &"a".repeat(49)).is_none());
    }

    #[test]
    fn ident_values_come_from_a_closed_vocabulary() {
        // Token-shaped secrets must not pass just because they look harmless.
        for secret in ["hunter2", "letmein", "root", "admin", "web01", "p4ssw0rd"] {
            assert!(clean_str(FieldKind::Ident, secret).is_none(), "{secret}");
        }
        for token in ["password", "permission_denied", "windows", "none"] {
            assert!(clean_str(FieldKind::Ident, token).is_some(), "{token}");
        }
        // Vocabulary entries themselves must be plain lowercase tokens.
        for token in IDENT_VOCABULARY {
            assert!(
                token
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{token}"
            );
        }
    }

    #[test]
    fn version_config_field_and_source_file_values_are_closed_or_strict() {
        for good in ["0.1.0", "1.12.3-beta.1", "2.0.0+build5"] {
            assert!(clean_str(FieldKind::Version, good).is_some(), "{good}");
        }
        for bad in [
            "hunter2-PASSWORD",
            "1.2",
            "1.2.3.4",
            "v1.2.3",
            "1.2.3-",
            "1.2.3-p@ss",
        ] {
            assert!(clean_str(FieldKind::Version, bad).is_none(), "{bad}");
        }
        for good in [
            "ssh.keepaliveSecs",
            "diagnostics.logDir",
            "appearance",
            "connections",
        ] {
            assert!(clean_str(FieldKind::ConfigField, good).is_some(), "{good}");
        }
        for bad in [
            "hunter2-PASSWORD",
            "ssh.password",
            "diagnostics.secretKey",
            "",
        ] {
            assert!(clean_str(FieldKind::ConfigField, bad).is_none(), "{bad}");
        }
        assert!(clean_str(FieldKind::SourceFile, "known_hosts.rs").is_some());
        for bad in ["hunter2-PASSWORD", "x.txt", "A.rs", "a/b.rs", ".rs"] {
            assert!(clean_str(FieldKind::SourceFile, bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn event_registry_is_well_formed() {
        for name in EVENTS {
            assert!(
                name.split_once('.').is_some_and(|(area, action)| {
                    !area.is_empty()
                        && !action.is_empty()
                        && name.chars().all(|c| {
                            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.'
                        })
                }),
                "{name}"
            );
        }
        let unique: std::collections::HashSet<_> = EVENTS.iter().collect();
        assert_eq!(unique.len(), EVENTS.len(), "duplicate event name");
    }

    #[test]
    fn invalid_text_becomes_a_marker_and_wrong_types_are_dropped() {
        assert_eq!(
            finish(FieldKind::Ident, Raw::Str("hunter2 secret".into())),
            Some(Value::from("<invalid>"))
        );
        assert_eq!(finish(FieldKind::Count, Raw::Str("12".into())), None);
        assert_eq!(finish(FieldKind::Flag, Raw::U64(1)), None);
        assert_eq!(finish(FieldKind::Count, Raw::I64(-4)), None);
        assert_eq!(
            finish(FieldKind::Count, Raw::U64(4)),
            Some(Value::from(4u64))
        );
    }
}
