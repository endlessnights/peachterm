# Roadmap, risks and acceptance criteria

## Major technical and security risks

| #   | Risk                                                                                        | Mitigation                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Terminal latency/jank if output flows through React state                                   | Per-session `tauri::ipc::Channel`, coalesced byte batches, direct `term.write()`; benchmark with `cat` of a large file              |
| R2  | Unbounded memory when the renderer is slower than the server                                | Bounded mpsc between SSH reader and IPC pump; reader awaits capacity (natural TCP backpressure)                                     |
| R3  | MITM via silently accepted host keys                                                        | Handshake aborts on `Unknown`/`Changed` before auth; explicit user decision; no opt-out setting                                     |
| R4  | Remote files overwritten without consent                                                    | `RemoteWritePolicy` is in-memory, non-serialisable, reset per session; `UploadAuthorization` only mintable in Rust; regression test |
| R5  | Editor save storms / atomic replace (rename, delete+create)                                 | Watch parent directory, debounce (300 ms), compare SHA-256 to last seen hash, per-file upload mutex                                 |
| R6  | Remote changed under the user (conflict)                                                    | Store base hash at download; re-hash remote before upload; separate conflict dialog                                                 |
| R7  | Non-atomic SFTP rename semantics (Windows SFTP servers, `posix-rename@openssh.com` missing) | Temp file in same dir → `posix-rename` if advertised → fallback with explicit wording; never claim atomicity                        |
| R8  | Secret Service missing on headless/minimal Linux                                            | Detect at start-up, disable "save password", prompt every time; never plaintext                                                     |
| R9  | Secrets leaking into logs / IPC                                                             | `SecretString` w/o `Debug`; no `credentials_get` command; error messages from fixed strings                                         |
| R10 | Platform drift (Windows-only code in shared modules)                                        | CI builds on 3 native runners; `cfg` leaf modules only; path APIs only                                                              |
| R11 | xterm.js shortcut collisions (Ctrl+C/V in vim, tmux)                                        | Copy only when selection exists; Ctrl+Shift+C/V on Win/Linux, Cmd+C/V on macOS; never swallow other control keys                    |
| R12 | WebKitGTK quirks on Linux (rendering, IME, Wayland)                                         | Test on X11 + Wayland; xterm.js DOM/canvas renderer fallback                                                                        |
| R13 | russh API churn between minor versions                                                      | Pin exact minor; SSH behind `ssh::` service trait; containerised integration tests                                                  |
| R14 | Session restore re-running commands                                                         | Restore only tab metadata; reconnect opt-in; never replay input                                                                     |

## Phase 1 — Foundation (this milestone)

Deliverables and acceptance criteria:

| Item                 | Acceptance criterion                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository, tooling  | `npm run lint`, `npm run typecheck`, `npm test`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` all pass locally                             |
| Tauri/React/Rust app | `npm run tauri dev` opens the window on Windows; `cargo build` succeeds on Windows locally                                                                  |
| Dark UI shell        | Sidebar, tab bar, workspace, status bar, settings dialog; dark + light + accents via CSS variables                                                          |
| Sidebar              | Nested folders, search (name/host/user), collapse, context menu (edit/duplicate/delete), double-click opens tab, resizable, width/visibility persisted      |
| Tabs                 | Open/close, drag-reorder, status indicator placeholder, multiple tabs per server                                                                            |
| Settings             | All sections from the spec; persisted in Rust; no "disable upload confirmation" option                                                                      |
| Backend interfaces   | Connections store, settings store, credential store trait (+ keyring impl), known-hosts store, session registry, remote-write policy, editor presets per OS |
| Security invariants  | Unit tests: policy starts `AlwaysAsk`, reset on new session, non-serialisable; host-key check outcomes; no plaintext secret in stores                       |
| Cross-platform       | CI: Windows, Linux, macOS builds; no Windows-only APIs in shared modules                                                                                    |
| Docs                 | Architecture, IPC, roadmap, platform matrix, README build instructions                                                                                      |

## Phase 2 — SSH

russh client service, auth (password, key + passphrase, keyboard-interactive, agent),
host-key prompts, xterm.js + fit/search addons, Channel streaming, resize, multiple tabs,
disconnect/reconnect, cleanup; integration tests against a Docker `openssh-server`.

## Phase 3 — SFTP

Auto-init SFTP subsystem on the same transport; listing, sort, hidden files, mkdir,
rename, delete (confirm), upload/download, panel left/right/collapse/resize.

## Phase 4 — External editor

Temp file management, editor launch, `notify` watcher with debounce + hashing,
Rust-enforced confirmation flow, conflict detection, safe upload, mandatory
security regression test (connect → Yes to all → reconnect → must ask → restart → must ask).

## Phase 5 — Split view and polish

Two-pane split (H/V, ratio), move tabs into panes, shortcuts, session restore
(metadata only), performance measurement on release builds, installers
(NSIS/MSI, AppImage/DEB, DMG).
