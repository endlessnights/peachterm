# Platform support matrix

Compilation success does **not** prove runtime compatibility. This file tracks
what has actually been verified, by whom, and how.

| Check                                                         | Windows 11 / windows-2025                                              | Linux (ubuntu-24.04)        | macOS (macos-15)                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------- | --------------------------------- |
| `cargo clippy -D warnings`                                    | ✅ local + CI                                                          | ✅ CI                       | ✅ CI (arm64)                     |
| `cargo test`                                                  | ✅ local + CI                                                          | ✅ CI                       | ✅ CI (arm64)                     |
| Frontend format/lint/typecheck/tests                          | ✅ local + CI                                                          | ✅ CI                       | – (platform-neutral)              |
| Release build + installers                                    | ✅ local + CI (NSIS; MSI in CI)                                        | ✅ CI (deb, AppImage)       | ✅ CI (dmg arm64 + x64, unsigned) |
| Packaged app launched and exercised (real WebView2, real IPC) | ✅ local: portable exe and NSIS-installed exe, 31 scripted checks each | ❌ not yet                  | ❌ not yet                        |
| Install / uninstall (NSIS, per-user, silent)                  | ✅ local: clean uninstall, no registry or file leftovers               | n/a                         | n/a                               |
| Credential store against real OS keychain                     | ✅ Credential Manager: set/clear exercised via the packaged app        | ❌ not yet (Secret Service) | ❌ not yet (Keychain)             |
| Native "Save as" dialog + diagnostic export                   | ✅ local (archive written and inspected)                               | ❌ not yet                  | ❌ not yet                        |
| Log directory resolution (`dirs`)                             | ✅ `%LOCALAPPDATA%\PeachTerm\logs`, `%APPDATA%\PeachTerm`              | 🟡 unit-tested shape only   | 🟡 unit-tested shape only         |
| SSH/SFTP runtime tests                                        | n/a (Phase 2)                                                          | n/a                         | n/a                               |
| X11 / Wayland                                                 | –                                                                      | ❌ not yet                  | –                                 |

CI history (all jobs: frontend, Rust ×3 OS, app build ×4 targets):

| Run                                                                                | Commit    | Result                                                                                                               |
| ---------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| [45026854567](https://github.com/endlessnights/peachterm/actions/runs/45026854567) | `016032e` | ✅ 8/8 jobs; Node 20 deprecation warnings on three actions                                                           |
| [45028846755](https://github.com/endlessnights/peachterm/actions/runs/45028846755) | `bc779d9` | ✅ 8/8 jobs after bumping actions to v7 (Node 24); only a GitHub notice about macOS arm64 runner queue times remains |

CI success proves compilation, unit tests and packaging only, not runtime behaviour.
Only the Windows column has had the application actually run.

## Linux build dependencies (Debian/Ubuntu)

From the official Tauri 2 prerequisites plus `libdbus-1-dev` for Secret Service:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config
```

Fedora: `webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel dbus-devel` + `@development-tools`.

Runtime: a Secret Service provider (GNOME Keyring or KWallet ≥ 5.97) is needed
to save passwords. Without it PeachTerm still works and prompts every time.

## macOS

- Xcode Command Line Tools (`xcode-select --install`).
- Apple Silicon (`aarch64-apple-darwin`) is the primary target; Intel via
  `x86_64-apple-darwin` cross-target on the same runner.
- Unsigned builds: right-click → Open on first launch. Signing/notarisation
  hooks are prepared in `tauri.conf.json` (`bundle.macOS`) but need an Apple
  Developer ID and are not required during development.

### Manual macOS test checklist

1. `npm ci && npm run tauri dev` – window opens, dark theme, no console errors.
2. Create folder + connection, restart app – data persisted under
   `~/Library/Application Support/dev.peachterm.app/`.
3. Settings → Security shows "Keychain" backend as available.
4. Cmd-based shortcuts (Cmd+, settings, Cmd+B sidebar, Cmd+W close tab).
