# PeachTerm

A lightweight, cross-platform SSH client with an integrated SFTP browser, local terminals and a safe
"edit remote file in my local editor" round trip. Built with Tauri 2, React + TypeScript and Rust.
No telemetry, no accounts, no session limits.

## Features

- **SSH terminals** (xterm.js) with host-key verification, password / key / keyboard-interactive / agent
  authentication, automatic flow control and independent sessions per tab.
- **SFTP browser** beside the terminal: browse, upload, download, rename, delete, drag and drop, context menus.
- **External editor round trip**: edit a remote file in your own editor; every upload is confirmed first.
- **Local terminals**: Windows PowerShell, PowerShell 7, cmd, WSL distributions, and bash/zsh/fish on Linux/macOS
  through a native pseudo-terminal, plus your own shell profiles.
- **Tabs and split view**: up to six panes, drag a tab onto a pane edge, resizable dividers, restore tabs on start.
- **Themes**: Dark, Light, System, Industrial Olive and Source Gray, each with a matching terminal palette;
  ten built-in terminal palettes, custom terminal colours and per-tab palettes.
- **Security**: credentials in the OS keychain, optional application lock, no secrets in logs or settings files.
- Saved connections in folders, search, recent sessions, interface scale, terminal font picker, customisable shortcuts.

## Status

PeachTerm is **early software** (version 0.x). It is developed and tested mainly on Windows; the Linux and macOS
builds compile and pass the unit and integration tests in CI but have had little hands-on testing
(see [docs/platform-support.md](docs/platform-support.md)). Expect rough edges and report them.

Known limitations:

- Releases are not code-signed or notarized yet ([docs/signing.md](docs/signing.md)); Windows SmartScreen and
  macOS Gatekeeper will warn.
- Saving passwords on Linux requires a Secret Service provider (GNOME Keyring or KWallet).
- No X11/Wayland-specific testing yet; no Windows-on-ARM or Linux-on-ARM builds.
- The interface is English only.

## Supported platforms

| Platform                        | Build                   | Status                                    |
| ------------------------------- | ----------------------- | ----------------------------------------- |
| Windows 10/11 x64               | NSIS installer (`.exe`) | Primary development platform              |
| Linux x64 (WebKitGTK 4.1)       | `.deb`, AppImage        | Builds and tests in CI, little manual use |
| macOS 11+ Apple Silicon (arm64) | `.dmg`                  | Builds and tests in CI, little manual use |
| macOS 11+ Intel (x64)           | `.dmg`                  | Builds in CI                              |

## Installation

Download the installer for your system from the
[Releases](https://github.com/endlessnights/peachterm/releases) page (once a release is published) and run it.
Because the installers are not signed yet, the operating system will show a warning the first time; see
[docs/signing.md](docs/signing.md). Or build it yourself (below).

## Screenshots

Screenshots will be added to this section with the first public release.

## Documentation

- [Architecture](docs/architecture.md) — modules, data flow, security boundaries
- [IPC contract](docs/ipc.md) — every Rust ⇄ React command
- [Roadmap, risks, acceptance criteria](docs/roadmap.md)
- [Keyboard shortcuts](docs/shortcuts.md) — customisable, terminal-safe
- [Connection tree](docs/connection-tree.md) — folders (3 levels), drag-and-drop, bulk operations
- [SSH terminal](docs/ssh.md), [SFTP](docs/sftp.md), [external editor](docs/editor.md)
- [Tabs, split view, workspace, recent sessions, interface scale](docs/workspace.md)
- [Application lock](docs/lock.md) — optional, enforced in the backend
- [Local terminals](docs/local-terminals.md) — shells, profiles, safety rules
- [Releasing](docs/releasing.md) and [code signing](docs/signing.md)
- [Native title bar](docs/title-bar.md) — themed on Windows 11, macOS and Linux
- [Diagnostic logging](docs/logging.md)
- [FTPeach review notes](docs/ftpeach-review.md)

## Prerequisites (all platforms)

- **Node.js ≥ 22.12** (CI uses Node 24)
- **Rust** via [rustup](https://rustup.rs). The exact toolchain (1.100.0) is
  pinned in `rust-toolchain.toml` and installed automatically on first build.

### Windows

- Microsoft C++ Build Tools ("Desktop development with C++")
- WebView2 runtime (preinstalled on Windows 10 21H2+ and Windows 11)

### Linux (Debian/Ubuntu)

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config
```

Other distributions: see [docs/platform-support.md](docs/platform-support.md).
A Secret Service provider (GNOME Keyring / KWallet) is needed to _save_
passwords; without one PeachTerm still works and asks each time.

### macOS

```bash
xcode-select --install
```

## Development

```bash
npm ci
npm run app:dev        # Tauri window with hot reload (Vite on :1420)
```

`npm run dev` alone serves the UI in a normal browser backed by an in-memory
mock of the Rust API. That is only for styling work; the mock is excluded from
production builds.

### Checks

```bash
npm run check          # everything below
npm run format:check
npm run lint
npm run typecheck
npm test               # Vitest (frontend)
npm run rust:fmt
npm run rust:clippy
npm run rust:test      # cargo test (backend)
```

## Building

```bash
npm run app:build                               # installers for the host OS
npx tauri build --debug --no-bundle             # quick debug binary
```

| Host        | Command                                                                                                     | Output                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Windows     | `npx tauri build --bundles nsis,msi`                                                                        | `src-tauri/target/release/bundle/{nsis,msi}`               |
| Linux       | `npx tauri build --bundles deb,appimage`                                                                    | `src-tauri/target/release/bundle/{deb,appimage}`           |
| macOS arm64 | `rustup target add aarch64-apple-darwin && npx tauri build --target aarch64-apple-darwin --bundles app,dmg` | `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg` |
| macOS Intel | same with `x86_64-apple-darwin`                                                                             | …                                                          |

Native installers must be built on their own OS (CI does this on native runners:
`.github/workflows/ci.yml`). Release builds: [docs/releasing.md](docs/releasing.md). Builds are unsigned for now.

## Where data lives

| OS      | Configuration                                 | Logs (default, changeable)                             |
| ------- | --------------------------------------------- | ------------------------------------------------------ |
| Windows | `%APPDATA%\PeachTerm\`                        | `%LOCALAPPDATA%\PeachTerm\logs\`                       |
| Linux   | `$XDG_CONFIG_HOME/peachterm/` (`~/.config/…`) | `$XDG_STATE_HOME/peachterm/logs/` (`~/.local/state/…`) |
| macOS   | `~/Library/Application Support/PeachTerm/`    | `~/Library/Logs/PeachTerm/`                            |

`connections.json`, `settings.json` and `known_hosts.json` contain no secrets.
Passwords go to the OS keychain only — never to disk in plain text. A damaged
file never resets the rest of your data: bad fields/entries fall back to defaults
and a copy of the original is kept as `<file>.corrupt-<timestamp>`.

## Diagnostic logs

Local, allowlisted, rotated logs (Settings → Diagnostics): no passwords, keys,
host names, user names, paths or terminal content at any level, and nothing is
ever uploaded. Details: [docs/logging.md](docs/logging.md).

## Security principles

- Host keys are always verified; unknown keys need approval, changed keys are blocked.
- Secrets stay in Rust; the renderer can write a password but never read one.
- Uploads of externally edited files always require confirmation. "Yes to all"
  lasts for one connection session and is never persisted.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Contributing

Bug reports and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Release process:
[docs/releasing.md](docs/releasing.md).

## Author

PeachTerm was created and is maintained by
**Bakhti Baymukhamedov**.

- GitHub: https://github.com/endlessnights
- Telegram: https://t.me/pycarrot2

## License

PeachTerm is licensed under the Apache License,
Version 2.0.

See [LICENSE](LICENSE) and [NOTICE](NOTICE)
for details.

You may use, modify and redistribute PeachTerm, including commercially, under the terms of that license.
When you redistribute it (modified or not), keep the license text, the copyright notices and the contents of
the `NOTICE` file as Apache-2.0 section 4 requires; modified files should say that they were changed. The
license does not require your own product to display the author's name in its user interface.

## Third-party acknowledgments

PeachTerm is built on open-source software, each with its own license: [Tauri](https://tauri.app),
[React](https://react.dev), [xterm.js](https://xtermjs.org), [russh](https://github.com/Eugeny/russh),
[portable-pty](https://github.com/wezterm/wezterm/tree/main/pty), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)
(SIL OFL 1.1) and many more. The full list with licenses is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). PeachTerm takes architectural inspiration from
[FTPeach](https://github.com/Smooveemaan/FTPeach) (Apache-2.0); no FTPeach source code, artwork or trademarks
are included. The Industrial Olive and Source Gray themes are original designs inspired by the look of early-2000s
game-engine interfaces; no third-party artwork or assets are used.

Parts of PeachTerm were developed with the help of an AI coding assistant (Anthropic's Claude) under the
author's direction and review. The project is independent and is not owned, endorsed or maintained by any AI provider.
