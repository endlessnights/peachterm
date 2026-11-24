// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use crate::AppState;
use crate::editor::{self, EditorPreset};
use crate::error::AppResult;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    /// Recoverable start-up problems (secret-free, no paths).
    issues: Vec<String>,
}

#[tauri::command]
pub async fn app_info(state: State<'_, Arc<AppState>>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: "PeachTerm",
        version: env!("CARGO_PKG_VERSION"),
        os: crate::platform::os_name(),
        arch: std::env::consts::ARCH,
        // Notes can name data files, so they are withheld while locked.
        issues: if state.lock.is_locked() {
            Vec::new()
        } else {
            state.startup_issues.clone()
        },
    })
}

#[tauri::command]
pub async fn editor_presets() -> AppResult<Vec<EditorPreset>> {
    super::blocking(|| Ok(editor::presets())).await
}

/// Close the application. Every session is ended through its normal teardown
/// (nothing is typed into any shell), local shells are killed, then the process
/// exits. Allowed while locked: quitting exposes nothing.
#[tauri::command]
pub async fn app_quit(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> AppResult<()> {
    let shared = Arc::clone(&state);
    super::blocking(move || {
        shared.local.close_all();
        Ok(())
    })
    .await?;
    state.tunnel_engine.stop_all().await;
    for session in state.ssh.all() {
        session.close().await;
    }
    app.exit(0);
    Ok(())
}

/// Project links the About page may open. The renderer names one by key; the
/// addresses are fixed here, so no other URL can be opened through this command.
pub const LINKS: &[(&str, &str)] = &[
    ("github", "https://github.com/endlessnights"),
    ("telegram", "https://t.me/pycarrot2"),
    ("repository", "https://github.com/endlessnights/peachterm"),
    (
        "notices",
        "https://github.com/endlessnights/peachterm/blob/main/THIRD_PARTY_NOTICES.md",
    ),
    (
        "license",
        "https://github.com/endlessnights/peachterm/blob/main/LICENSE",
    ),
];

#[tauri::command]
pub async fn app_open_link(state: State<'_, Arc<AppState>>, link: String) -> AppResult<()> {
    state.lock.guard()?;
    let (_, url) = LINKS
        .iter()
        .find(|(key, _)| *key == link)
        .ok_or_else(|| crate::error::AppError::Validation("Unknown link".into()))?;
    super::blocking(move || {
        crate::platform::open_url(url)?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::LINKS;

    #[test]
    fn only_the_official_project_links_can_be_opened() {
        for (key, url) in LINKS {
            assert!(url.starts_with("https://"), "{key}");
            assert!(
                url.starts_with("https://github.com/endlessnights")
                    || *url == "https://t.me/pycarrot2",
                "{key}: {url}"
            );
        }
        let keys: Vec<_> = LINKS.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            keys,
            ["github", "telegram", "repository", "notices", "license"]
        );
    }
}
