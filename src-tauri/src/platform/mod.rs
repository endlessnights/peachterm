//! Platform integration points.
//!
//! Shared code receives plain `PathBuf`s from [`AppPaths`]; it never builds
//! OS-specific paths itself. The per-OS leaf modules are deliberately tiny and
//! only contain what genuinely differs between platforms.

use crate::error::{AppError, AppResult};
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

/// Application directories, resolved once at start-up from the OS conventions
/// (`dirs` crate, which honours `XDG_*` on Linux and Known Folders on Windows).
///
/// | OS      | config                              | logs                                  |
/// |---------|-------------------------------------|---------------------------------------|
/// | Windows | `%APPDATA%\PeachTerm`               | `%LOCALAPPDATA%\PeachTerm\logs`      |
/// | Linux   | `$XDG_CONFIG_HOME/peachterm`        | `$XDG_STATE_HOME/peachterm/logs`      |
/// | macOS   | `~/Library/Application Support/PeachTerm` | `~/Library/Logs/PeachTerm`      |
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// Persistent configuration: connections, settings, known hosts.
    pub config_dir: PathBuf,
    /// Disposable data: editor temp files (Phase 4).
    pub cache_dir: PathBuf,
    /// Default location of diagnostic logs (user-overridable in settings).
    pub log_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> AppResult<Self> {
        let missing =
            || AppError::Storage("the operating system reports no user directories".into());
        Ok(Self {
            config_dir: current::config_dir().ok_or_else(missing)?,
            cache_dir: current::cache_dir().ok_or_else(missing)?,
            log_dir: current::log_dir().ok_or_else(missing)?,
        })
    }

    /// Everything below one base directory (tests and the degraded fallback).
    pub fn under(base: &Path) -> Self {
        Self {
            config_dir: base.join("config"),
            cache_dir: base.join("cache"),
            log_dir: base.join("logs"),
        }
    }

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

/// Open a directory in the OS file manager. The path must come from Rust-side
/// state (never straight from the renderer).
pub fn open_folder(path: &Path) -> std::io::Result<()> {
    current::open_folder(path)
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
        let paths = AppPaths::under(&base);
        let base = paths.config_dir.clone();
        assert!(paths.connections_file().starts_with(&base));
        assert!(paths.settings_file().starts_with(&base));
        assert!(paths.known_hosts_file().starts_with(&base));
    }

    #[test]
    fn resolved_paths_are_absolute_and_app_specific() {
        // Resolves from the real environment of whoever runs the tests, so only
        // the shape is asserted.
        let paths = AppPaths::resolve().unwrap();
        for dir in [&paths.config_dir, &paths.cache_dir, &paths.log_dir] {
            assert!(dir.is_absolute(), "{dir:?}");
            assert!(
                dir.to_string_lossy().to_lowercase().contains("peachterm"),
                "{dir:?}"
            );
        }
        assert_ne!(paths.config_dir, paths.log_dir);
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
