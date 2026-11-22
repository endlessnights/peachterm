//! User preferences. Non-sensitive by construction.
//!
//! SECURITY: there is intentionally no field that disables the remote-write
//! confirmation for external-editor uploads. Unknown fields are dropped on
//! load, so such a flag cannot be smuggled in through the file or over IPC.
//! See `editor::policy`.

use super::atomic::{ConfigIssue, load_json_value, merge_lenient, save_json};
use crate::error::{AppError, AppResult};
use crate::storage::connections::AuthMethod;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThemeMode {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Accent {
    #[default]
    Peach,
    Teal,
    Violet,
    Blue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PanelSide {
    Left,
    #[default]
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SplitOrientation {
    #[default]
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum StartupBehavior {
    #[default]
    Empty,
    RestoreTabs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    pub startup: StartupBehavior,
    pub confirm_close_active: bool,
    /// Reconnect restored tabs automatically. Off by default (opt-in).
    pub auto_reconnect_restored: bool,
    pub language: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            startup: StartupBehavior::Empty,
            confirm_close_active: true,
            auto_reconnect_restored: false,
            language: "en".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    pub theme: ThemeMode,
    pub accent: Accent,
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    pub terminal_line_height: f32,
    pub scrollback: u32,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::Dark,
            accent: Accent::Peach,
            terminal_font_family:
                "\"Cascadia Mono\", \"JetBrains Mono\", \"DejaVu Sans Mono\", Menlo, Consolas, monospace"
                    .into(),
            terminal_font_size: 14,
            terminal_line_height: 1.2,
            scrollback: 10_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SshSettings {
    pub connect_timeout_secs: u32,
    /// 0 disables keepalive.
    pub keepalive_secs: u32,
    pub default_username: String,
    pub preferred_auth: AuthMethod,
}

impl Default for SshSettings {
    fn default() -> Self {
        Self {
            connect_timeout_secs: 15,
            keepalive_secs: 30,
            default_username: String::new(),
            preferred_auth: AuthMethod::Password,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SftpSettings {
    pub default_position: PanelSide,
    pub default_visible: bool,
    pub confirm_delete: bool,
    pub show_hidden: bool,
}

impl Default for SftpSettings {
    fn default() -> Self {
        Self {
            default_position: PanelSide::Right,
            default_visible: true,
            confirm_delete: true,
            show_hidden: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    /// Executable path or bare program name. `None` = not configured.
    pub program: Option<String>,
    /// Arguments; `{file}` is replaced by the local temp file path.
    pub args: Vec<String>,
    /// Override for the temp directory; `None` = app cache directory.
    pub temp_dir: Option<String>,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            program: None,
            args: vec!["{file}".into()],
            temp_dir: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Error,
    Warn,
    #[default]
    Info,
    Debug,
    Trace,
}

/// Diagnostic logging preferences. Contains no secrets; the log *content* is
/// restricted by an allowlist in `logging`, independent of these settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagnosticsSettings {
    pub file_logging: bool,
    pub level: LogLevel,
    /// Custom directory; `None` = the platform default.
    pub log_dir: Option<String>,
    /// 7, 14 or 30.
    pub retention_days: u32,
    /// Upper bound for all log files together.
    pub max_total_mb: u32,
}

impl Default for DiagnosticsSettings {
    fn default() -> Self {
        Self {
            file_logging: true,
            level: LogLevel::Info,
            log_dir: None,
            retention_days: 14,
            max_total_mb: 100,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiState {
    pub sidebar_visible: bool,
    pub sidebar_width: u32,
    pub sftp_width: u32,
    pub sftp_side: PanelSide,
    pub split_orientation: SplitOrientation,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            sidebar_visible: true,
            sidebar_width: 260,
            sftp_width: 360,
            sftp_side: PanelSide::Right,
            split_orientation: SplitOrientation::Vertical,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub ssh: SshSettings,
    pub sftp: SftpSettings,
    pub editor: EditorSettings,
    pub diagnostics: DiagnosticsSettings,
    pub ui: UiState,
}

impl Settings {
    /// Clamp numeric values into supported ranges and trim strings, so a
    /// hand-edited file or a buggy renderer cannot store nonsense.
    pub fn normalized(mut self) -> Self {
        let a = &mut self.appearance;
        a.terminal_font_size = a.terminal_font_size.clamp(8, 32);
        a.terminal_line_height = if a.terminal_line_height.is_finite() {
            a.terminal_line_height.clamp(1.0, 2.0)
        } else {
            1.2
        };
        a.scrollback = a.scrollback.clamp(500, 200_000);
        a.terminal_font_family = a.terminal_font_family.trim().chars().take(512).collect();
        if a.terminal_font_family.is_empty() {
            a.terminal_font_family = AppearanceSettings::default().terminal_font_family;
        }

        let s = &mut self.ssh;
        s.connect_timeout_secs = s.connect_timeout_secs.clamp(1, 300);
        s.keepalive_secs = s.keepalive_secs.min(3600);
        s.default_username = s.default_username.trim().chars().take(256).collect();

        let e = &mut self.editor;
        e.program = e
            .program
            .take()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());
        e.temp_dir = e
            .temp_dir
            .take()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());
        e.args.truncate(32);
        if e.args.is_empty() {
            e.args.push("{file}".into());
        }

        let d = &mut self.diagnostics;
        d.retention_days = match d.retention_days {
            0..=10 => 7,
            11..=21 => 14,
            _ => 30,
        };
        d.max_total_mb = d.max_total_mb.clamp(10, 1000);
        d.log_dir = d
            .log_dir
            .take()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty() && !p.contains(' '));

        let u = &mut self.ui;
        u.sidebar_width = u.sidebar_width.clamp(160, 640);
        u.sftp_width = u.sftp_width.clamp(220, 1200);

        if self.general.language.trim().is_empty() {
            self.general.language = "en".into();
        }
        self
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
    issues: Vec<ConfigIssue>,
}

impl SettingsStore {
    /// Never fails because of file contents: each invalid field falls back to
    /// its default while every valid field is kept (see `merge_lenient`).
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let mut issues = Vec::new();
        let settings = match load_json_value(&path, &mut issues) {
            Some(value) => {
                let before = issues.len();
                let settings: Settings = merge_lenient(value, &path, &mut issues);
                super::atomic::ensure_backup(&path, &mut issues, before);
                settings
            }
            None => Settings::default(),
        };
        Ok(Self {
            path,
            current: Mutex::new(settings.normalized()),
            issues,
        })
    }

    pub fn issues(&self) -> &[ConfigIssue] {
        &self.issues
    }

    pub fn get(&self) -> AppResult<Settings> {
        self.current
            .lock()
            .map(|s| s.clone())
            .map_err(|_| AppError::Storage("settings lock poisoned".into()))
    }

    pub fn save(&self, settings: Settings) -> AppResult<Settings> {
        let settings = settings.normalized();
        let mut guard = self
            .current
            .lock()
            .map_err(|_| AppError::Storage("settings lock poisoned".into()))?;
        save_json(&self.path, &settings)?;
        *guard = settings.clone();
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        assert_eq!(store.get().unwrap(), Settings::default().normalized());
        let mut s = store.get().unwrap();
        s.ui.sidebar_width = 333;
        s.appearance.theme = ThemeMode::Light;
        store.save(s.clone()).unwrap();
        let reopened = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        assert_eq!(reopened.get().unwrap(), s);
    }

    #[test]
    fn values_are_clamped() {
        let mut s = Settings::default();
        s.appearance.terminal_font_size = 200;
        s.appearance.terminal_line_height = f32::NAN;
        s.ui.sidebar_width = 5;
        s.editor.args.clear();
        let n = s.normalized();
        assert_eq!(n.appearance.terminal_font_size, 32);
        assert_eq!(n.appearance.terminal_line_height, 1.2);
        assert_eq!(n.ui.sidebar_width, 160);
        assert_eq!(n.editor.args, vec!["{file}".to_string()]);
    }

    #[test]
    fn unknown_fields_including_upload_bypass_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"editor":{"autoUpload":true,"skipConfirmation":true},"remoteWriteConfirmation":"never"}"#,
        )
        .unwrap();
        let store = SettingsStore::open(path.clone()).unwrap();
        store.save(store.get().unwrap()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("autoUpload"));
        assert!(!text.contains("skipConfirmation"));
        assert!(!text.contains("remoteWriteConfirmation"));
    }

    #[test]
    fn partial_file_keeps_defaults_for_missing_sections() {
        let s: Settings = serde_json::from_str(r#"{"ui":{"sidebarWidth":300}}"#).unwrap();
        assert_eq!(s.ui.sidebar_width, 300);
        assert!(s.ui.sidebar_visible);
        assert!(s.general.confirm_close_active);
        assert!(!s.general.auto_reconnect_restored);
    }
}
