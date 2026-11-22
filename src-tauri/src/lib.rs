//! PeachTerm backend.
//!
//! Rust owns SSH/SFTP, credentials, host keys, temp files, file watching,
//! editor launching and every remote write. See docs/architecture.md.

mod commands;
mod editor;
mod error;
mod lock;
mod logging;
#[cfg(test)]
mod openssh_ci;
mod platform;
mod security;
mod sessions;
mod sftp;
mod ssh;
mod storage;

use logging::LogController;
use platform::AppPaths;
use security::credentials::{CredentialStore, KeyringCredentialStore};
use security::known_hosts::KnownHostsStore;
use sessions::SessionRegistry;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use storage::atomic::ConfigIssue;
use storage::connections::ConnectionStore;
use storage::settings::{DiagnosticsSettings, SettingsStore};
use tauri::{Emitter, Manager};

/// Process-wide services, shared with commands via `State<Arc<AppState>>`.
pub type EditorEmitter =
    Arc<std::sync::OnceLock<Box<dyn Fn(editor::service::EditorEvent) + Send + Sync>>>;

pub type PromptEmitter =
    Arc<std::sync::OnceLock<Box<dyn Fn(ssh::prompt::PromptEvent) + Send + Sync>>>;

pub struct AppState {
    #[allow(dead_code)] // cache_dir is used by the editor round trip (Phase 4)
    pub paths: AppPaths,
    pub connections: ConnectionStore,
    pub settings: SettingsStore,
    pub known_hosts: Arc<KnownHostsStore>,
    pub workspace: Arc<storage::workspace::WorkspaceStore>,
    pub credentials: Arc<dyn CredentialStore>,
    #[allow(dead_code)] // driven by the SSH service (Phase 2)
    pub sessions: Arc<SessionRegistry>,
    pub editor: editor::service::EditorService,
    pub editor_emitter: EditorEmitter,
    pub logging: Arc<LogController>,
    pub lock: Arc<lock::LockService>,
    pub ssh: ssh::session::SshManager,
    pub prompts: ssh::prompt::Prompts,
    pub sftp: sftp::transfer::Hub,
    /// Set once the Tauri app exists; prompts are delivered through it. (A
    /// closure rather than an `AppHandle`, so unit tests do not link the
    /// whole webview runtime.)
    pub prompt_emitter: PromptEmitter,
    /// Human-readable, secret-free notes about recoverable start-up problems.
    pub startup_issues: Vec<String>,
    /// Last diagnostic archive written by this process (for "show in folder").
    pub last_export: Mutex<Option<PathBuf>>,
}

impl AppState {
    /// `start_logging` receives the default log directory and the loaded
    /// diagnostics settings, so logging honours the user's choices from the
    /// very first event. Tests pass a closure that avoids global state.
    pub fn initialize(
        paths: AppPaths,
        credentials: Arc<dyn CredentialStore>,
        mut startup_issues: Vec<String>,
        start_logging: impl FnOnce(PathBuf, &DiagnosticsSettings) -> Arc<LogController>,
    ) -> error::AppResult<Self> {
        std::fs::create_dir_all(&paths.config_dir)?;
        // Opening never fails on file *contents*; problems come back as issues.
        let connections = ConnectionStore::open(paths.connections_file())?;
        let settings = SettingsStore::open(paths.settings_file())?;
        let known_hosts = Arc::new(KnownHostsStore::open(paths.known_hosts_file())?);
        let workspace = Arc::new(storage::workspace::WorkspaceStore::open(
            paths.workspace_file(),
        )?);

        let prompt_emitter: PromptEmitter = Arc::default();
        let emit_handle = prompt_emitter.clone();
        let prompts = ssh::prompt::Prompts::new(Arc::new(move |event| {
            if let Some(emit) = emit_handle.get() {
                emit(event);
            }
        }));
        let lock = lock::LockService::open(paths.config_dir.join("lock.json"), lock::Kdf::STRONG);
        let sessions = Arc::new(SessionRegistry::with_lock(lock.flag()));
        let editor_emitter: EditorEmitter = Arc::default();
        let editor_emit_handle = editor_emitter.clone();
        let editor = editor::service::EditorService::new(
            sessions.clone(),
            lock.flag(),
            Arc::new(move |event| {
                if let Some(emit) = editor_emit_handle.get() {
                    emit(event);
                }
            }),
            editor::service::Timing::default(),
        );
        // Copies of files edited in earlier runs that nobody can still be
        // working in are removed.
        editor::tempfiles::purge_stale(
            &editor::temp_root(&settings.get()?.editor),
            std::time::SystemTime::now(),
        );
        let logging = start_logging(paths.log_dir.clone(), &settings.get()?.diagnostics);
        tracing::info!(
            event = "app.start",
            version = env!("CARGO_PKG_VERSION"),
            os = platform::os_name(),
            arch = std::env::consts::ARCH,
        );

        let issues: Vec<&ConfigIssue> = settings
            .issues()
            .iter()
            .chain(connections.issues())
            .chain(known_hosts.issues())
            .collect();
        for issue in &issues {
            match issue.field.as_deref() {
                Some(field) => tracing::warn!(
                    event = "config.issue",
                    file = issue.file.as_str(),
                    kind = issue.kind,
                    field = field,
                    backup = issue.backed_up,
                ),
                None => tracing::warn!(
                    event = "config.issue",
                    file = issue.file.as_str(),
                    kind = issue.kind,
                    backup = issue.backed_up,
                ),
            }
            startup_issues.push(issue.describe());
        }
        // The lock starts engaged whenever it is enabled; an unlocked state is
        // never restored from disk. Enabled without a password cannot lock
        // anything, so say so instead of pretending.
        let wanted = settings.get()?.security.app_lock;
        if !lock.configure(wanted.enabled, wanted.inactivity_minutes, true) && wanted.enabled {
            startup_issues.push(
                "Application lock is turned on but its password file is missing, so the lock is off. Set a password in Settings \u{2192} Security."
                    .to_owned(),
            );
        }
        lock.spawn_timer();
        tracing::info!(
            event = "config.loaded",
            file = "connections.json",
            count = connections.load()?.connections.len() as u64,
        );
        tracing::info!(event = "config.loaded", file = "settings.json");
        tracing::info!(
            event = "config.loaded",
            file = "known_hosts.json",
            count = known_hosts.list()?.len() as u64,
        );

        Ok(Self {
            connections,
            settings,
            known_hosts,
            workspace,
            credentials,
            sessions,
            editor,
            editor_emitter,
            logging,
            lock,
            ssh: ssh::session::SshManager::default(),
            sftp: sftp::transfer::Hub::default(),
            prompts,
            prompt_emitter,
            startup_issues,
            last_export: Mutex::new(None),
            paths,
        })
    }
}

/// Standard directories, or — if the OS offers none or they are unusable — a
/// temporary location so the application still starts (with a visible note).
fn prepare_paths() -> (AppPaths, Vec<String>) {
    match AppPaths::resolve() {
        Ok(paths) if std::fs::create_dir_all(&paths.config_dir).is_ok() => (paths, Vec::new()),
        _ => (
            AppPaths::under(&std::env::temp_dir().join("PeachTerm-fallback")),
            vec![
                "The standard settings folder could not be used. PeachTerm is using a temporary \
                 folder instead; check permissions of your user profile."
                    .to_owned(),
            ],
        ),
    }
}

/// Colour the native title bar before the UI has loaded, so a dark theme does
/// not flash the system accent colour. The renderer re-applies it on theme
/// changes (`window_apply_theme`).
/// The saved interface scale is in effect from the first frame.
fn apply_startup_scale(app: &tauri::App, state: &AppState) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(settings) = state.settings.get() {
        let _ = window.set_zoom(f64::from(settings.appearance.interface_scale) / 100.0);
    }
}

fn apply_startup_title_bar(app: &tauri::App, state: &AppState) {
    use platform::WindowTheme;
    use storage::settings::ThemeMode;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let theme = match state.settings.get().map(|s| s.appearance.theme) {
        Ok(ThemeMode::Light) => WindowTheme::Light,
        Ok(ThemeMode::System) => match window.theme() {
            Ok(tauri::Theme::Light) => WindowTheme::Light,
            _ => WindowTheme::Dark,
        },
        _ => WindowTheme::Dark,
    };
    let _ = platform::apply_window_theme(&window, theme, theme.palette());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (paths, notes) = prepare_paths();
            let state = AppState::initialize(
                paths,
                Arc::new(KeyringCredentialStore::new()),
                notes,
                LogController::init,
            )?;
            apply_startup_title_bar(app, &state);
            apply_startup_scale(app, &state);
            let state = Arc::new(state);
            let prompt_handle = app.handle().clone();
            let _ = state.prompt_emitter.set(Box::new(move |event| {
                let _ = prompt_handle.emit("ssh-prompt", event);
            }));
            let editor_handle = app.handle().clone();
            let _ = state.editor_emitter.set(Box::new(move |event| {
                let _ = editor_handle.emit("editor-event", event);
            }));
            // Whenever the lock engages (button, shortcut or inactivity timer):
            // forget in-memory upload permissions and tell the UI.
            let handle = app.handle().clone();
            let shared = Arc::clone(&state);
            state.lock.set_notifier(Box::new(move |locked| {
                if locked {
                    let _ = shared.sessions.reset_write_policies();
                    tracing::info!(event = "editor.policy_reset");
                }
                let _ = handle.emit("lock-state-changed", locked);
            }));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::app::editor_presets,
            commands::connections::connections_load,
            commands::connections::connections_save,
            commands::connections::connections_delete,
            commands::connections::connections_duplicate,
            commands::connections::connections_move,
            commands::connections::folders_save,
            commands::connections::folders_delete,
            commands::connections::connections_rename,
            commands::connections::folders_rename,
            commands::connections::tree_move,
            commands::connections::tree_delete_preview,
            commands::connections::tree_delete,
            commands::settings::settings_load,
            commands::settings::settings_save,
            commands::window::window_apply_theme,
            commands::ssh::ssh_open,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_ack,
            commands::ssh::ssh_close,
            commands::ssh::ssh_answer_host_key,
            commands::ssh::ssh_answer_auth,
            commands::sftp::sftp_status,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_create_file,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_download,
            commands::sftp::sftp_pick_upload,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_cancel,
            commands::editor::editor_open_remote,
            commands::editor::editor_answer,
            commands::editor::editor_resolve_conflict,
            commands::editor::editor_retry,
            commands::editor::editor_stop,
            commands::workspace::workspace_load,
            commands::workspace::workspace_save,
            commands::workspace::recent_list,
            commands::workspace::recent_clear,
            commands::window::window_apply_scale,
            commands::lock::lock_status,
            commands::lock::lock_unlock,
            commands::lock::lock_now,
            commands::lock::lock_set_password,
            commands::lock::lock_remove_password,
            commands::lock::lock_touch,
            commands::security::credentials_status,
            commands::security::credentials_set_password,
            commands::security::credentials_clear,
            commands::security::credentials_clear_all,
            commands::security::known_hosts_list,
            commands::security::known_hosts_remove,
            commands::logging::logging_status,
            commands::logging::logging_open_dir,
            commands::logging::logging_export_preview,
            commands::logging::logging_export,
            commands::logging::logging_reveal_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PeachTerm");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event
            && let Some(state) = handle.try_state::<Arc<AppState>>()
        {
            state.logging.shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use security::credentials::MemoryCredentialStore;
    use std::path::Path;

    fn start(dir: &Path) -> AppState {
        AppState::initialize(
            AppPaths::under(dir),
            Arc::new(MemoryCredentialStore::new()),
            Vec::new(),
            LogController::detached,
        )
        .unwrap()
    }

    #[test]
    fn initializes_in_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let state = start(dir.path());
        assert!(state.connections.load().unwrap().connections.is_empty());
        assert_eq!(state.sessions.count(), 0);
        assert!(state.startup_issues.is_empty());
    }

    /// Simulated application restarts: every preference and connection must
    /// come back from disk, and passwords must never be in those files.
    #[test]
    fn data_survives_restart_and_contains_no_secrets() {
        use storage::connections::{AuthMethod, ConnectionInput, FolderInput};
        use storage::settings::{Accent, LogLevel, PanelSide, StartupBehavior, ThemeMode};

        let dir = tempfile::tempdir().unwrap();
        let (folder_id, conn_id);
        {
            let state = start(dir.path());
            let parent = state
                .connections
                .save_folder(FolderInput {
                    id: None,
                    name: "Prod".into(),
                    parent_id: None,
                    expanded: true,
                })
                .unwrap();
            let child = state
                .connections
                .save_folder(FolderInput {
                    id: None,
                    name: "Web".into(),
                    parent_id: Some(parent.id),
                    expanded: false,
                })
                .unwrap();
            folder_id = child.id;
            let saved = state
                .connections
                .save_connection(ConnectionInput {
                    id: None,
                    name: "web-1".into(),
                    host: "example.com".into(),
                    port: 2222,
                    username: "deploy".into(),
                    auth: AuthMethod::PublicKey,
                    key_path: Some("/keys/id_ed25519".into()),
                    save_password: true,
                    timeout_secs: 30,
                    initial_directory: Some("/var/www".into()),
                    folder_id: Some(child.id),
                })
                .unwrap();
            conn_id = saved.id;
            state
                .credentials
                .set(
                    &security::credentials::connection_account(&conn_id),
                    &security::secret::SecretString::new("TopSecret-pw-123".into()),
                )
                .unwrap();
            state
                .connections
                .set_has_stored_secret(conn_id, true)
                .unwrap();

            let mut settings = state.settings.get().unwrap();
            settings.appearance.theme = ThemeMode::Light;
            settings.appearance.accent = Accent::Violet;
            settings.appearance.terminal_font_size = 17;
            settings.general.startup = StartupBehavior::RestoreTabs;
            settings.general.confirm_close_active = false;
            settings.ssh.keepalive_secs = 45;
            settings.ssh.default_username = "ops".into();
            settings.sftp.default_position = PanelSide::Left;
            settings.sftp.show_hidden = true;
            settings.editor.program = Some("/usr/bin/kate".into());
            settings.editor.args = vec!["--new".into(), "{file}".into()];
            settings.diagnostics.level = LogLevel::Debug;
            settings.diagnostics.retention_days = 30;
            settings.diagnostics.file_logging = false;
            settings.diagnostics.log_dir = Some("/custom/logs".into());
            settings.diagnostics.max_total_mb = 250;
            settings.ui.sidebar_visible = false;
            settings.ui.sidebar_width = 333;
            state.settings.save(settings).unwrap();
        }

        // "Restart": a brand-new AppState over the same directory.
        let state = start(dir.path());
        assert!(
            state.startup_issues.is_empty(),
            "{:?}",
            state.startup_issues
        );
        let tree = state.connections.load().unwrap();
        assert_eq!(tree.folders.len(), 2);
        let child = tree.folders.iter().find(|f| f.id == folder_id).unwrap();
        assert_eq!(child.name, "Web");
        assert!(!child.expanded);
        assert!(child.parent_id.is_some());
        let c = &tree.connections[0];
        assert_eq!(
            (c.name.as_str(), c.host.as_str(), c.port),
            ("web-1", "example.com", 2222)
        );
        assert_eq!(c.username, "deploy");
        assert_eq!(c.auth, AuthMethod::PublicKey);
        assert_eq!(c.key_path.as_deref(), Some("/keys/id_ed25519"));
        assert_eq!(c.initial_directory.as_deref(), Some("/var/www"));
        assert_eq!((c.timeout_secs, c.folder_id), (30, Some(folder_id)));
        assert!(c.has_stored_secret);

        let s = state.settings.get().unwrap();
        assert_eq!(s.appearance.theme, ThemeMode::Light);
        assert_eq!(s.appearance.accent, Accent::Violet);
        assert_eq!(s.appearance.terminal_font_size, 17);
        assert_eq!(s.general.startup, StartupBehavior::RestoreTabs);
        assert!(!s.general.confirm_close_active);
        assert!(!s.general.auto_reconnect_restored);
        assert_eq!(
            (s.ssh.keepalive_secs, s.ssh.default_username.as_str()),
            (45, "ops")
        );
        assert_eq!(s.sftp.default_position, PanelSide::Left);
        assert!(s.sftp.show_hidden);
        assert_eq!(s.editor.program.as_deref(), Some("/usr/bin/kate"));
        assert_eq!(
            s.editor.args,
            vec!["--new".to_string(), "{file}".to_string()]
        );
        assert_eq!(s.diagnostics.level, LogLevel::Debug);
        assert_eq!(s.diagnostics.retention_days, 30);
        assert!(!s.diagnostics.file_logging);
        assert_eq!(s.diagnostics.log_dir.as_deref(), Some("/custom/logs"));
        assert_eq!(s.diagnostics.max_total_mb, 250);
        assert!(!s.ui.sidebar_visible);
        assert_eq!(s.ui.sidebar_width, 333);

        // No JSON file under the config dir may contain the password or a
        // remote-write override.
        for entry in std::fs::read_dir(dir.path().join("config"))
            .unwrap()
            .flatten()
        {
            let text = std::fs::read_to_string(entry.path()).unwrap();
            assert!(!text.contains("TopSecret"), "{:?}", entry.path());
            let lower = text.to_lowercase();
            for forbidden in [
                "autoupload",
                "yestoall",
                "alwaysask",
                "writepolicy",
                "remotewrite",
            ] {
                assert!(
                    !lower.contains(forbidden),
                    "{forbidden} in {:?}",
                    entry.path()
                );
            }
        }
    }

    /// One damaged field/entry must not reset the user's other data, and
    /// startup must never fail because of file contents.
    #[test]
    fn corrupt_files_degrade_gracefully_and_keep_valid_data() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"appearance":{"theme":"light","terminalFontSize":"huge"},"ssh":{"keepaliveSecs":99},"diagnostics":{"level":"verbose","retentionDays":30}}"#,
        )
        .unwrap();
        std::fs::write(
            config.join("connections.json"),
            r#"{"folders":[{"id":"4f3653b1-1f94-4a43-a430-3db9ca1877f9","name":"Lab","parentId":null,"expanded":true},{"broken":true}],
               "connections":[{"nope":1}]}"#,
        )
        .unwrap();
        std::fs::write(config.join("known_hosts.json"), b"\x00\x01 not json").unwrap();

        let state = start(dir.path());
        let s = state.settings.get().unwrap();
        assert_eq!(s.appearance.theme, storage::settings::ThemeMode::Light);
        assert_eq!(s.appearance.terminal_font_size, 14, "bad field -> default");
        assert_eq!(s.ssh.keepalive_secs, 99);
        assert_eq!(s.diagnostics.retention_days, 30);
        assert_eq!(s.diagnostics.level, storage::settings::LogLevel::Info);
        let tree = state.connections.load().unwrap();
        assert_eq!(tree.folders.len(), 1);
        assert_eq!(tree.folders[0].name, "Lab");
        assert!(state.known_hosts.list().unwrap().is_empty());
        assert_eq!(state.startup_issues.len(), 5, "{:?}", state.startup_issues);
        for note in &state.startup_issues {
            assert!(!note.contains(dir.path().to_str().unwrap()), "{note}");
        }
        // Originals were kept as backups.
        let backups = std::fs::read_dir(&config)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(backups, 3);
    }

    /// Every IPC command must refuse while locked, except this short, reviewed
    /// list. A new command that forgets the guard fails this test.
    #[test]
    fn every_ipc_command_enforces_the_lock_except_the_allowlist() {
        const ALLOWED: &[&str] = &[
            "lock_status",        // the lock screen needs it
            "lock_unlock",        // how a locked app is opened
            "lock_now",           // idempotent; locking while locked is harmless
            "lock_touch",         // no-op while locked
            "app_info",           // withholds start-up notes while locked
            "window_apply_theme", // cosmetic, reveals nothing
            "window_apply_scale", // cosmetic zoom, reveals nothing
            "editor_presets",     // static list of editor names
        ];
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let text = std::fs::read_to_string(entry.path())
                .unwrap()
                .replace("\r\n", "\n");
            for part in text.split("#[tauri::command]").skip(1) {
                let name = part
                    .split("pub async fn ")
                    .nth(1)
                    .and_then(|r| r.split('(').next())
                    .unwrap()
                    .trim()
                    .to_owned();
                // The guard must come before any other work: within the first lines of the body.
                let body_start = part.find("{\n").unwrap();
                let head: String = part[body_start..]
                    .lines()
                    .take(6)
                    .collect::<Vec<_>>()
                    .join("\n");
                if !ALLOWED.contains(&name.as_str()) {
                    assert!(
                        head.contains("lock.guard()"),
                        "command `{name}` does not call lock.guard() first"
                    );
                }
                checked += 1;
            }
        }
        assert!(checked >= 25, "scan found only {checked} commands");
    }

    fn start_in(dir: &Path) -> AppState {
        AppState::initialize(
            AppPaths::under(dir),
            Arc::new(MemoryCredentialStore::new()),
            Vec::new(),
            LogController::detached,
        )
        .unwrap()
    }

    #[test]
    fn enabled_lock_starts_locked_after_every_restart_and_blocks_the_backend() {
        use security::secret::SecretString;
        let dir = tempfile::tempdir().unwrap();
        let password = SecretString::new("correct horse".into());
        {
            let state = start_in(dir.path());
            assert!(!state.lock.is_locked(), "disabled by default");
            state.lock.set_password(&password, None).unwrap();
            let mut s = state.settings.get().unwrap();
            s.security.app_lock.enabled = true;
            state.settings.save(s).unwrap();
            state.lock.configure(true, 0, false);
            assert!(!state.lock.is_locked(), "enabling does not lock by itself");
        }
        // Restart: locked again, regardless of how the previous run ended.
        let state = start_in(dir.path());
        assert!(state.lock.is_locked());
        assert_eq!(state.lock.guard().unwrap_err().code(), "locked");
        assert_eq!(
            state
                .sessions
                .open(uuid::Uuid::new_v4())
                .unwrap_err()
                .code(),
            "locked"
        );
        // The persisted files never record an unlocked state or the password.
        for entry in std::fs::read_dir(dir.path().join("config"))
            .unwrap()
            .flatten()
        {
            let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
            assert!(!text.contains("correct horse"));
            assert!(!text.to_lowercase().contains("unlocked"));
        }
        assert!(matches!(
            state
                .lock
                .unlock(&SecretString::new("wrong password".into()))
                .unwrap(),
            lock::UnlockOutcome::Wrong { .. }
        ));
        assert!(state.lock.is_locked());
        state.lock.unlock(&password).unwrap();
        assert!(state.lock.guard().is_ok());
        assert!(state.sessions.open(uuid::Uuid::new_v4()).is_ok());
    }

    #[test]
    fn enabled_without_a_password_file_is_reported_and_does_not_lock() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"security":{"appLock":{"enabled":true,"inactivityMinutes":5}}}"#,
        )
        .unwrap();
        let state = start_in(dir.path());
        assert!(!state.lock.is_locked());
        assert!(
            state
                .startup_issues
                .iter()
                .any(|n| n.contains("password file is missing"))
        );
    }
}
