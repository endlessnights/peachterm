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
    pub fn workspace_file(&self) -> PathBuf {
        self.config_dir.join("workspace.json")
    }
}

/// An sRGB colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// `#rrggbb` (exactly; no shorthand, no alpha).
    pub fn parse(text: &str) -> Option<Self> {
        let hex = text.strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
        Some(Self(byte(0)?, byte(2)?, byte(4)?))
    }

    /// Windows `COLORREF` layout: `0x00BBGGRR` (only the Windows leaf calls it).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn colorref(self) -> u32 {
        u32::from(self.0) | (u32::from(self.1) << 8) | (u32::from(self.2) << 16)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowTheme {
    Dark,
    Light,
}

/// Title bar colours matching the application theme (`src/styles/theme.css`:
/// `--surface-1`, `--text-1`, `--line`). A test keeps both in sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TitleBarColors {
    pub caption: Rgb,
    pub text: Rgb,
    pub border: Rgb,
}

impl WindowTheme {
    pub fn palette(self) -> TitleBarColors {
        match self {
            WindowTheme::Dark => TitleBarColors {
                caption: Rgb(0x18, 0x18, 0x17),
                text: Rgb(0xf1, 0xed, 0xe8),
                border: Rgb(0x2d, 0x2b, 0x28),
            },
            WindowTheme::Light => TitleBarColors {
                caption: Rgb(0xf3, 0xf1, 0xee),
                text: Rgb(0x23, 0x20, 0x1d),
                border: Rgb(0xe1, 0xdd, 0xd7),
            },
        }
    }
}

/// How far the native title bar could be matched to the theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TitleBarOutcome {
    /// Caption, text and border colours were set (Windows 11).
    Colored,
    /// Only the light/dark window theme was set (macOS, Linux, older Windows).
    ThemeOnly,
}

/// Apply the window theme and, where the OS allows it, the caption colours.
pub fn apply_window_theme(
    window: &tauri::WebviewWindow,
    theme: WindowTheme,
    colors: TitleBarColors,
) -> Result<TitleBarOutcome, String> {
    window
        .set_theme(Some(match theme {
            WindowTheme::Dark => tauri::Theme::Dark,
            WindowTheme::Light => tauri::Theme::Light,
        }))
        .map_err(|e| e.to_string())?;
    Ok(current::apply_title_bar(window, colors))
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
    fn hex_colours_parse_strictly() {
        assert_eq!(Rgb::parse("#181817"), Some(Rgb(0x18, 0x18, 0x17)));
        assert_eq!(Rgb::parse("#FFaa00"), Some(Rgb(255, 170, 0)));
        for bad in [
            "",
            "181817",
            "#18181",
            "#1818177",
            "#12345g",
            "#fff",
            " #181817",
            "#181817 ",
            "rgb(1,2,3)",
            "#+12345",
        ] {
            assert_eq!(Rgb::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn colorref_is_bgr_ordered() {
        assert_eq!(Rgb(0x11, 0x22, 0x33).colorref(), 0x0033_2211);
        assert_eq!(Rgb(0, 0, 0).colorref(), 0);
        assert_eq!(Rgb(255, 255, 255).colorref(), 0x00ff_ffff);
    }

    /// The Rust palette used at start-up must equal the CSS tokens the UI uses.
    #[test]
    fn title_bar_palette_matches_the_css_theme_tokens() {
        let css = include_str!("../../../src/styles/theme.css");
        let hex = |c: Rgb| format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2);
        // Dark tokens live in `:root`, light ones in `:root[data-theme='light']`.
        let split = css
            .find(":root[data-theme='light'] {")
            .expect("light theme block");
        let (dark_css, light_css) = css.split_at(split);
        for (theme, block) in [
            (WindowTheme::Dark, dark_css),
            (WindowTheme::Light, light_css),
        ] {
            let p = theme.palette();
            for (token, color) in [
                ("--surface-1", p.caption),
                ("--text-1", p.text),
                ("--line", p.border),
            ] {
                let want = format!("{token}: {}", hex(color));
                assert!(
                    block.contains(&want),
                    "{theme:?}: expected `{want}` in theme.css"
                );
            }
        }
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
