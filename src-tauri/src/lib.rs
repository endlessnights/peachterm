//! PeachTerm backend.
//!
//! Rust owns SSH/SFTP, credentials, host keys, temp files, file watching,
//! editor launching and every remote write. See docs/architecture.md.

mod commands;
mod editor;
mod error;
mod platform;
mod security;
mod sessions;
mod sftp;
mod ssh;
mod storage;

use platform::AppPaths;
use security::credentials::{CredentialStore, KeyringCredentialStore};
use security::known_hosts::KnownHostsStore;
use sessions::SessionRegistry;
use std::sync::Arc;
use storage::connections::ConnectionStore;
use storage::settings::SettingsStore;
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
}

impl AppState {
    pub fn initialize(
        paths: AppPaths,
        credentials: Arc<dyn CredentialStore>,
    ) -> error::AppResult<Self> {
        std::fs::create_dir_all(&paths.config_dir)?;
        Ok(Self {
            connections: ConnectionStore::open(paths.connections_file())?,
            settings: SettingsStore::open(paths.settings_file())?,
            known_hosts: KnownHostsStore::open(paths.known_hosts_file())?,
            credentials,
            sessions: SessionRegistry::new(),
            paths,
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let resolver = app.path();
            let paths = AppPaths {
                config_dir: resolver.app_config_dir()?,
                cache_dir: resolver.app_cache_dir()?,
            };
            let state = AppState::initialize(paths, Arc::new(KeyringCredentialStore::new()))?;
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
            commands::settings::settings_load,
            commands::settings::settings_save,
            commands::security::credentials_status,
            commands::security::credentials_set_password,
            commands::security::credentials_clear,
            commands::security::credentials_clear_all,
            commands::security::known_hosts_list,
            commands::security::known_hosts_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PeachTerm");
}

#[cfg(test)]
mod tests {
    use super::*;
    use security::credentials::MemoryCredentialStore;

    #[test]
    fn initializes_in_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            config_dir: dir.path().join("config"),
            cache_dir: dir.path().join("cache"),
        };
        let state = AppState::initialize(paths, Arc::new(MemoryCredentialStore::new())).unwrap();
        assert!(state.connections.load().unwrap().connections.is_empty());
        assert_eq!(state.sessions.count(), 0);
    }
}
