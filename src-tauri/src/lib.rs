//! PeachTerm backend.
//!
//! Rust owns SSH/SFTP, credentials, host keys, temp files, file watching,
//! editor launching and every remote write. See docs/architecture.md.

mod commands;
mod editor;
mod error;
mod logging;
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
use tauri::Manager;

/// Process-wide services, shared with commands via `State<Arc<AppState>>`.
pub struct AppState {
    #[allow(dead_code)] // cache_dir is used by the editor round trip (Phase 4)
    pub paths: AppPaths,
    pub connections: ConnectionStore,
    pub settings: SettingsStore,
    pub known_hosts: KnownHostsStore,
    pub credentials: Arc<dyn CredentialStore>,
    #[allow(dead_code)] // driven by the SSH service (Phase 2)
    pub sessions: SessionRegistry,
    pub logging: Arc<LogController>,
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
        let known_hosts = KnownHostsStore::open(paths.known_hosts_file())?;

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
            credentials,
            sessions: SessionRegistry::new(),
            logging,
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
            app.manage(Arc::new(state));
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
}
