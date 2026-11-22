# Native title bar and the theme

## Problem

On Windows the title bar of a normal window takes the user's **accent colour**
when "Show accent colour on title bars and window borders" is enabled, so a dark
PeachTerm gets, for example, a bright purple title bar.

## Investigation (Tauri 2.12 / tao 0.37)

| Option                                                                                                     | Result                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebviewWindow::set_theme(Dark/Light)`                                                                     | Supported on all desktop platforms. Switches the title bar between light and dark (DWM immersive dark mode on Windows, `NSAppearance` on macOS, GTK dark preference on Linux). **On Windows it does not override the accent colour.** |
| `set_title_bar_style` (Overlay/Transparent)                                                                | macOS only.                                                                                                                                                                                                                           |
| tao `WindowExtWindows`                                                                                     | No caption/border colour API (only icons, taskbar, shadow, RTL…).                                                                                                                                                                     |
| Windows 11 DWM attributes `DWMWA_CAPTION_COLOR` / `DWMWA_TEXT_COLOR` / `DWMWA_BORDER_COLOR` (build 22000+) | Native, supported by the OS, keeps all native behaviour (drag, snap, caption buttons, DPI, accessibility).                                                                                                                            |
| Custom HTML title bar (`decorations: false`)                                                               | Works everywhere but means re-implementing drag regions, snap layouts, maximise/restore, keyboard access and DPI behaviour. **Not needed**, so not done.                                                                              |

## Decision

Keep the native title bar and colour it:

- **All platforms** — the renderer resolves the effective theme (including
  "System") and calls `window_apply_theme`, which runs `set_theme`.
- **Windows 11** — the same command additionally sets caption, text and border
  colour through one `DwmSetWindowAttribute` call (`platform/windows.rs`,
  the only `unsafe` in the code base, with a SAFETY note). The colours are the
  application's own tokens (`--surface-1`, `--text-1`, `--line`), read from the
  computed CSS, so the title bar blends into the tab bar in dark and light
  themes. `unsafe_code` is `deny` crate-wide with that single `allow`.
- **Windows 10 / older Windows 11** — the OS rejects the attributes; the
  title bar gets the dark/light theme only and may still show the accent colour
  if the user enabled it. This is an OS limit; it is reported as
  `themeOnly` and logged (`window.theme_applied`, `status=unsupported`).
- **macOS / Linux** — native appearance from `set_theme`; no extra step.

## Behaviour

- Applied before the UI loads (Rust reads the saved theme in `setup`), so there
  is no accent-coloured flash at start-up; the Rust palette equals the CSS
  tokens (a unit test compares both with `theme.css`).
- Re-applied whenever the effective theme changes: Settings → Appearance
  (live preview, reverted by Cancel), Apply/OK, and OS theme changes while the
  theme is "System". Identical requests are not repeated.
- The command accepts only `dark`/`light` and `#rrggbb` colours and changes
  nothing else about the window. It is deliberately allowed while the
  application is locked (it is cosmetic and reveals nothing).
