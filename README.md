# PeachTerm

A lightweight, cross-platform SSH client with an integrated SFTP browser and a
safe "edit remote file in my local editor" round trip. Built with Tauri 2,
React + TypeScript and Rust. No telemetry, no accounts, no session limits.

> **Status: Phase 1 (foundation).** The UI shell, saved connections, settings,
> credential storage and security primitives are in place. Interactive SSH
> terminals arrive in Phase 2 — see [docs/roadmap.md](docs/roadmap.md).

| Platform                           | Status                                              |
| ---------------------------------- | --------------------------------------------------- |
| Windows 10/11                      | Primary development platform                        |
| Linux (X11/Wayland, WebKitGTK 4.1) | First-class target                                  |
| macOS 11+ (Apple Silicon first)    | First-class target, release after native validation |

Actual verification status per platform: [docs/platform-support.md](docs/platform-support.md).

## Documentation

- [Architecture](docs/architecture.md) — modules, data flow, security boundaries
- [IPC contract](docs/ipc.md) — every Rust ⇄ React command
- [Roadmap, risks, acceptance criteria](docs/roadmap.md)
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
`.github/workflows/ci.yml`). macOS builds are unsigned for now.

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

## License

Apache-2.0. PeachTerm takes architectural inspiration from
[FTPeach](https://github.com/Smooveemaan/FTPeach) (Apache-2.0); no FTPeach
source code, artwork or trademarks are included.
