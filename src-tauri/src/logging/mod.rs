//! Structured, allowlisted diagnostic logging (see docs/logging.md).
//!
//! How to log from any module — same pattern in every phase:
//!
//! ```ignore
//! tracing::info!(event = "ssh.connected", session_id = %session_id, auth_kind = "password");
//! tracing::warn!(event = "sftp.unsupported", session_id = %session_id, reason = "subsystem_refused");
//! ```
//!
//! * Always pass an `event` name (`area.action`, lowercase).
//! * Only fields listed in `fields.rs` are recorded, and only when the value has
//!   the declared shape. Use ids, fixed tokens and numbers; never pass host
//!   names, user names, paths, error strings, terminal or file content — they
//!   are dropped by design, at every log level.
//! * The `message` argument is ignored. Third-party crates' log text is never
//!   recorded either (only their target and level at WARN/ERROR).

pub mod clock;
pub mod export;
pub mod fields;
pub mod layer;
pub mod writer;

use crate::storage::settings::{DiagnosticsSettings, LogLevel};
use layer::SafeLayer;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{Registry, reload};
use writer::{FileSink, WriterConfig, WriterStatus};

pub fn level_filter(level: LogLevel) -> LevelFilter {
    match level {
        LogLevel::Error => LevelFilter::ERROR,
        LogLevel::Warn => LevelFilter::WARN,
        LogLevel::Info => LevelFilter::INFO,
        LogLevel::Debug => LevelFilter::DEBUG,
        LogLevel::Trace => LevelFilter::TRACE,
    }
}

pub fn level_token(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Error => "error",
        LogLevel::Warn => "warn",
        LogLevel::Info => "info",
        LogLevel::Debug => "debug",
        LogLevel::Trace => "trace",
    }
}

/// What the effective configuration resolves to for the current settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub enabled: bool,
    pub level: LogLevel,
    pub dir: PathBuf,
    pub custom_dir: bool,
    pub retention_days: u32,
    pub max_total_bytes: u64,
}

/// Settings + platform default → effective configuration. A relative custom
/// directory is rejected later (it would depend on the working directory).
pub fn resolve(settings: &DiagnosticsSettings, default_dir: &Path) -> Resolved {
    let custom = settings.log_dir.as_deref().map(PathBuf::from);
    Resolved {
        enabled: settings.file_logging,
        level: settings.level,
        custom_dir: custom.is_some(),
        dir: custom.unwrap_or_else(|| default_dir.to_path_buf()),
        retention_days: settings.retention_days,
        max_total_bytes: settings.max_total_mb as u64 * 1024 * 1024,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoggingStatus {
    pub enabled: bool,
    pub level: LogLevel,
    pub effective_dir: String,
    pub custom_dir: bool,
    /// Lines are being written right now.
    pub active: bool,
    /// Fixed token explaining why logging is not active (never a path).
    pub error: Option<String>,
    pub dropped_lines: u64,
    pub file_count: usize,
    pub total_bytes: u64,
    pub retention_days: u32,
    pub max_total_mb: u32,
}

struct Applied {
    resolved: Resolved,
    status: WriterStatus,
}

pub struct LogController {
    sink: Arc<FileSink>,
    level: Option<reload::Handle<LevelFilter, Registry>>,
    default_dir: PathBuf,
    applied: Mutex<Applied>,
}

impl LogController {
    /// Install the process-wide subscriber and panic hook and start logging
    /// with `settings`. Never fails: if a subscriber already exists the
    /// controller still manages the file writer (level changes then have no
    /// effect), and a bad directory only produces a non-active status.
    pub fn init(default_dir: PathBuf, settings: &DiagnosticsSettings) -> Arc<Self> {
        let sink = FileSink::start(writer::system_clock());
        let (filter, handle) = reload::Layer::new(LevelFilter::OFF);
        let installed = Registry::default()
            .with(filter)
            .with(SafeLayer::new(sink.clone()))
            .try_init()
            .is_ok();
        let controller = Arc::new(Self {
            sink,
            level: installed.then_some(handle),
            default_dir,
            applied: Mutex::new(Applied {
                resolved: resolve(settings, Path::new("")),
                status: WriterStatus::default(),
            }),
        });
        if installed {
            install_panic_hook(controller.clone());
        }
        controller.apply(settings);
        controller
    }

    /// A controller that manages the file writer but installs no global
    /// subscriber or panic hook (unit tests, which may run many in one process).
    #[cfg(test)]
    pub fn detached(default_dir: PathBuf, settings: &DiagnosticsSettings) -> Arc<Self> {
        let controller = Arc::new(Self {
            sink: FileSink::start(writer::system_clock()),
            level: None,
            default_dir,
            applied: Mutex::new(Applied {
                resolved: resolve(settings, Path::new("")),
                status: WriterStatus::default(),
            }),
        });
        controller.apply(settings);
        controller
    }

    pub fn apply(&self, settings: &DiagnosticsSettings) -> WriterStatus {
        let resolved = resolve(settings, &self.default_dir);
        let was_enabled = self
            .applied
            .lock()
            .map(|a| a.resolved.enabled)
            .unwrap_or(false);

        if !resolved.enabled {
            if was_enabled {
                tracing::info!(event = "logging.disabled");
                self.flush();
            }
            self.set_level(LevelFilter::OFF);
        }

        let status = if !resolved.dir.is_absolute() {
            WriterStatus {
                active: false,
                error: Some("relative_path"),
            }
        } else {
            self.sink.configure(WriterConfig {
                enabled: resolved.enabled,
                dir: resolved.dir.clone(),
                retention_days: resolved.retention_days,
                max_total_bytes: resolved.max_total_bytes,
                max_file_bytes: writer::DEFAULT_MAX_FILE_BYTES,
            })
        };

        if resolved.enabled {
            self.set_level(level_filter(resolved.level));
            tracing::info!(
                event = "logging.configured",
                log_level = level_token(resolved.level),
                retention_days = resolved.retention_days as u64,
                max_total_mb = resolved.max_total_bytes / 1024 / 1024,
                custom_dir = resolved.custom_dir,
                active = status.active,
                reason = status.error.unwrap_or("none"),
            );
        }
        if let Ok(mut applied) = self.applied.lock() {
            *applied = Applied {
                resolved,
                status: status.clone(),
            };
        }
        status
    }

    fn set_level(&self, filter: LevelFilter) {
        if let Some(handle) = &self.level {
            let _ = handle.modify(|f| *f = filter);
        }
    }

    pub fn effective_dir(&self) -> PathBuf {
        self.applied
            .lock()
            .map(|a| a.resolved.dir.clone())
            .unwrap_or_else(|_| self.default_dir.clone())
    }

    pub fn resolved(&self) -> Option<Resolved> {
        self.applied.lock().ok().map(|a| a.resolved.clone())
    }

    /// Performs file-system reads; call from a blocking context.
    pub fn status(&self) -> LoggingStatus {
        let (resolved, status) = self
            .applied
            .lock()
            .map(|a| (a.resolved.clone(), a.status.clone()))
            .unwrap_or_else(|poisoned| {
                let a = poisoned.into_inner();
                (a.resolved.clone(), a.status.clone())
            });
        let files = writer::list_log_files(&resolved.dir);
        LoggingStatus {
            enabled: resolved.enabled,
            level: resolved.level,
            effective_dir: resolved.dir.to_string_lossy().into_owned(),
            custom_dir: resolved.custom_dir,
            active: resolved.enabled && status.active,
            error: if resolved.enabled {
                status.error.map(str::to_owned)
            } else {
                None
            },
            dropped_lines: self.sink.dropped(),
            file_count: files.len(),
            total_bytes: files.iter().map(|f| f.bytes).sum(),
            retention_days: resolved.retention_days,
            max_total_mb: (resolved.max_total_bytes / 1024 / 1024) as u32,
        }
    }

    pub fn flush(&self) {
        self.sink.flush(Duration::from_millis(500));
    }

    pub fn shutdown(&self) {
        tracing::info!(event = "app.shutdown");
        self.sink.shutdown();
    }
}

/// Log panics without their message (payloads may contain anything) and
/// without absolute paths, then defer to the previous hook.
fn install_panic_hook(controller: Arc<LogController>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let (file, line) = info
            .location()
            .map(|l| {
                let name = Path::new(l.file())
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                (name, l.line() as u64)
            })
            .unwrap_or_default();
        tracing::error!(event = "app.panic", source_file = %file, line = line);
        controller.sink.flush(Duration::from_millis(300));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_custom_directories_resolve() {
        let default = PathBuf::from("/default/logs");
        let mut settings = DiagnosticsSettings::default();
        let r = resolve(&settings, &default);
        assert_eq!((r.dir.clone(), r.custom_dir), (default.clone(), false));
        assert_eq!(r.max_total_bytes, 100 * 1024 * 1024);
        assert_eq!(r.retention_days, 14);
        assert_eq!(r.level, LogLevel::Info);

        settings.log_dir = Some("/custom".into());
        let r = resolve(&settings, &default);
        assert_eq!((r.dir, r.custom_dir), (PathBuf::from("/custom"), true));
    }

    #[test]
    fn level_mapping_is_exhaustive_and_ordered() {
        let levels = [
            LogLevel::Error,
            LogLevel::Warn,
            LogLevel::Info,
            LogLevel::Debug,
            LogLevel::Trace,
        ];
        let filters: Vec<_> = levels.iter().map(|l| level_filter(*l)).collect();
        // More verbose levels enable more: ERROR < WARN < INFO < DEBUG < TRACE.
        assert!(filters.windows(2).all(|w| w[0] < w[1]));
    }

    /// Real layer -> real file writer -> real files -> real export: none of
    /// the secrets below may survive at any level, in the logs or the archive.
    #[test]
    fn secrets_never_reach_log_files_or_exports_at_any_level() {
        use tracing_subscriber::layer::SubscriberExt;
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::start(writer::system_clock());
        let settings = DiagnosticsSettings::default();
        let controller_dir = dir.path().join("logs");
        assert!(
            sink.configure(WriterConfig {
                enabled: true,
                dir: controller_dir.clone(),
                retention_days: settings.retention_days,
                max_total_bytes: 1 << 30,
                max_file_bytes: writer::DEFAULT_MAX_FILE_BYTES,
            })
            .active
        );
        let (filter, _handle) = reload::Layer::new(LevelFilter::TRACE);
        let subscriber = Registry::default()
            .with(filter)
            .with(SafeLayer::new(sink.clone()));

        let secrets = [
            "hunter2-PASSWORD",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "passphrase-xyz",
            "ghp_tokenvalue123",
            "srv.internal.example.com",
            "alice@203.0.113.7",
            "/home/alice/.ssh/id_ed25519",
            "C:\\Users\\Alice\\secret.txt",
            "cat /etc/shadow",
            "clipboard-contents-42",
        ];
        tracing::subscriber::with_default(subscriber, || {
            for level_event in 0..5 {
                for secret in secrets {
                    match level_event {
                        0 => tracing::error!(
                            event = "test.leak",
                            password = secret,
                            host = secret,
                            message = secret,
                            reason = secret,
                            "{secret}"
                        ),
                        1 => tracing::warn!(
                            event = "test.leak",
                            token = secret,
                            path = secret,
                            error = secret,
                            error_kind = secret,
                            "{secret}"
                        ),
                        2 => tracing::info!(
                            event = "test.leak",
                            content = secret,
                            data = secret,
                            session_id = secret,
                            file = secret,
                            "{secret}"
                        ),
                        3 => {
                            tracing::debug!(event = "test.leak", clipboard = secret, key_path = secret, auth_kind = %secret, "{secret}")
                        }
                        _ => {
                            tracing::trace!(event = "test.leak", payload = secret, state = ?secret, field = secret, "{secret}")
                        }
                    }
                    tracing::error!(target: "russh::client", "{secret}");
                }
            }
            tracing::info!(event = "test.ok", count = 1u64);
        });
        sink.flush(Duration::from_secs(5));

        let mut all = String::new();
        for file in writer::list_log_files(&controller_dir) {
            all.push_str(&std::fs::read_to_string(&file.path).unwrap());
        }
        assert!(all.contains("\"event\":\"test.ok\""));
        for line in all.lines() {
            serde_json::from_str::<serde_json::Value>(line).expect("every line is valid JSON");
        }
        for secret in secrets {
            assert!(!all.contains(secret), "log leaked {secret:?}");
        }
        assert!(!all.contains("hunter2") && !all.contains("shadow") && !all.contains("Alice"));

        let archive = dir.path().join("export.zip");
        let meta = export::ExportMeta {
            version: "0.1.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            log_level: "trace".into(),
            retention_days: 14,
        };
        export::build_archive(
            &controller_dir,
            &archive,
            &meta,
            std::time::SystemTime::now(),
        )
        .unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        let mut exported = String::new();
        for i in 0..zip.len() {
            std::io::Read::read_to_string(&mut zip.by_index(i).unwrap(), &mut exported).unwrap();
        }
        for secret in secrets {
            assert!(!exported.contains(secret), "export leaked {secret:?}");
        }
        assert!(exported.contains("test.ok"));
        sink.shutdown();
    }

    #[test]
    fn controller_applies_directory_status_and_recovers() {
        // `init` installs a global subscriber, so build the controller by hand.
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::start(writer::system_clock());
        let controller = LogController {
            sink,
            level: None,
            default_dir: dir.path().join("default"),
            applied: Mutex::new(Applied {
                resolved: resolve(&DiagnosticsSettings::default(), dir.path()),
                status: WriterStatus::default(),
            }),
        };

        let mut settings = DiagnosticsSettings::default();
        assert!(controller.apply(&settings).active);
        assert!(dir.path().join("default").is_dir());
        assert_eq!(controller.effective_dir(), dir.path().join("default"));

        // Custom directory takes over.
        settings.log_dir = Some(dir.path().join("custom").to_string_lossy().into_owned());
        assert!(controller.apply(&settings).active);
        assert!(dir.path().join("custom").is_dir());
        let status = controller.status();
        assert!(status.custom_dir && status.active && status.error.is_none());

        // Relative paths are refused.
        settings.log_dir = Some("relative/logs".into());
        let status = controller.apply(&settings);
        assert_eq!(status.error, Some("relative_path"));
        assert!(!controller.status().active);

        // Unwritable directory: reported, nothing panics.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        settings.log_dir = Some(blocker.join("logs").to_string_lossy().into_owned());
        let status = controller.apply(&settings);
        assert!(!status.active && status.error.is_some());
        let shown = serde_json::to_string(&controller.status()).unwrap();
        assert!(shown.contains("effectiveDir"));

        // Disabling reports no error and no activity; re-enabling recovers.
        settings.log_dir = None;
        settings.file_logging = false;
        controller.apply(&settings);
        let status = controller.status();
        assert!(!status.enabled && !status.active && status.error.is_none());
        settings.file_logging = true;
        assert!(controller.apply(&settings).active);
        controller.sink.shutdown();
    }
}
