// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

use crate::error::{AppError, AppResult};
use crate::platform::{self, Rgb, TitleBarColors, TitleBarOutcome, WindowTheme};

/// Zoom the whole interface (70-150 %, steps of 10). This is the WebView's own
/// zoom factor, so pointer coordinates, hit testing, menus and drag-and-drop
/// stay consistent, and the operating system's display scaling is untouched.
/// Purely cosmetic, so it stays available while the application is locked.
#[tauri::command]
pub async fn window_apply_scale(window: tauri::WebviewWindow, percent: u32) -> AppResult<u32> {
    let percent = crate::storage::settings::normalize_scale(percent);
    window
        .set_zoom(f64::from(percent) / 100.0)
        .map_err(|_| AppError::Storage("The interface scale could not be applied".into()))?;
    tracing::debug!(event = "window.scale_applied", count = u64::from(percent));
    Ok(percent)
}

/// Make the native title bar match the application theme. The renderer sends
/// the resolved theme and the colours of its own CSS tokens; nothing else about
/// the window can be changed through this command. Cosmetic, so it stays
/// available while the application is locked.
#[tauri::command]
pub async fn window_apply_theme(
    window: tauri::WebviewWindow,
    theme: String,
    caption: String,
    text: String,
    border: String,
) -> AppResult<TitleBarOutcome> {
    let theme = match theme.as_str() {
        "dark" => WindowTheme::Dark,
        "light" => WindowTheme::Light,
        "olive" => WindowTheme::Olive,
        "gray" => WindowTheme::Gray,
        _ => return Err(AppError::Validation("Unknown window theme".into())),
    };
    let color = |value: &str| {
        Rgb::parse(value).ok_or_else(|| AppError::Validation("Colour must be #rrggbb".into()))
    };
    let colors = TitleBarColors {
        caption: color(&caption)?,
        text: color(&text)?,
        border: color(&border)?,
    };
    let outcome = platform::apply_window_theme(&window, theme, colors)
        .map_err(|_| AppError::Storage("The window theme could not be applied".into()))?;
    tracing::debug!(
        event = "window.theme_applied",
        state = if theme == WindowTheme::Dark {
            "dark"
        } else {
            "light"
        },
        status = if outcome == TitleBarOutcome::Colored {
            "ok"
        } else {
            "unsupported"
        },
    );
    Ok(outcome)
}
