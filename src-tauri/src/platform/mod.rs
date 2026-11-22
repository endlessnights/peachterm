//! Platform integration points.
//!
//! Shared code receives plain `PathBuf`s from [`AppPaths`]; it never builds
//! OS-specific paths itself. The per-OS leaf modules are deliberately tiny and
//! only contain what genuinely differs between platforms.

use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as current;
#[cfg(target_os = "macos")]
use macos as current;
#[cfg(target_os = "windows")]
use windows as current;

/// Application directories resolved once at start-up (Tauri path resolver).
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// Persistent configuration: connections, settings, known hosts.
    pub config_dir: PathBuf,
    /// Disposable data: editor temp files (Phase 4).
    pub cache_dir: PathBuf,
}

impl AppPaths {
    pub fn connections_file(&self) -> PathBuf {
        self.config_dir.join("connections.json")
    }
    pub fn settings_file(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }
    pub fn known_hosts_file(&self) -> PathBuf {
        self.config_dir.join("known_hosts.json")
    }
}

/// Short OS identifier exposed to the renderer (for shortcut labels etc.).
pub fn os_name() -> &'static str {
    current::OS_NAME
}

/// Locate an executable by bare name on `PATH`, or validate an explicit path.
/// Returns `None` when nothing executable-looking is found.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Phase 4 validates the configured editor with it
pub fn find_executable(program: &str) -> Option<PathBuf> {
    let candidate = Path::new(program);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.exists().then(|| candidate.to_path_buf());
    }
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).find_map(|dir| {
        current::executable_names(program)
            .into_iter()
            .map(|name| dir.join(name))
            .find(|full| full.is_file())
    })
}

pub use current::editor_presets as platform_editor_presets;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_paths_join_inside_config_dir() {
        let base = std::env::temp_dir().join("peachterm-paths-test");
        let paths = AppPaths {
            config_dir: base.clone(),
            cache_dir: base.join("cache"),
        };
        assert!(paths.connections_file().starts_with(&base));
        assert!(paths.settings_file().starts_with(&base));
        assert!(paths.known_hosts_file().starts_with(&base));
    }

    #[test]
    fn missing_executable_is_none() {
        assert!(find_executable("peachterm-definitely-not-a-real-program").is_none());
    }

    #[test]
    fn os_name_is_known() {
        assert!(["windows", "linux", "macos"].contains(&os_name()));
    }
}
