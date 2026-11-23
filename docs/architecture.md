# PeachTerm architecture

PeachTerm is a cross-platform (Windows, Linux, macOS) desktop SSH client with an
integrated SFTP browser and a safe external-editor round trip. One shared
codebase: Tauri 2 shell, React + TypeScript renderer, Rust + Tokio backend.

## 1. Guiding principles

1. **Rust owns everything security-sensitive.** SSH/SFTP transport, credentials,
   host keys, temporary files, file watching, editor launching and every remote
   write live in Rust. The renderer is treated as untrusted input.
2. **Renderer owns presentation.** Layout, tabs, sidebar, terminal rendering
   (xterm.js) and non-sensitive preferences.
3. **Platform code is isolated.** Shared modules never reference drive letters,
   path separators, `/home`, `/Users` or OS-specific environment variables.
   OS differences live behind small traits or `#[cfg(target_os)]` leaf modules.
4. **Secure defaults are enforced in Rust, not merely shown in React.**
   Host-key verification and the remote-write confirmation policy cannot be
   bypassed by any IPC call sequence.
5. **No hidden persistence of permissions.** Any "don't ask again" decision for
   remote writes exists only in memory, scoped to one connection session.

## 2. Process and module layout

```
peachterm/
├── src/                         React renderer
│   ├── app/                     App shell, layout composition, bootstrap
│   ├── components/              Reusable presentational components (Dialog, Menu…)
│   ├── features/
│   │   ├── connections/         Sidebar tree, search, connection editor
│   │   ├── sessions/            Tab model (store), tab bar
│   │   ├── terminal/            Terminal workspace (xterm.js in Phase 2)
│   │   ├── sftp/                SFTP panel (Phase 3)
│   │   ├── editor/              External-editor dialogs (Phase 4)
│   │   ├── split-view/          Split layout (Phase 5)
│   │   └── settings/            Settings dialog + store
│   ├── shared/                  IPC client, types mirrored from Rust, utils
│   └── styles/                  CSS variables (themes, accents) and base styles
├── src-tauri/src/
│   ├── lib.rs                   Builder, managed state, command registration
│   ├── error.rs                 `AppError` – serialisable, secret-free errors
│   ├── platform/                App directories + per-OS leaf modules
│   ├── storage/                 Atomic JSON persistence, connections, settings
│   ├── security/                Credential store abstraction, known hosts
│   ├── sessions/                Connection-session registry (in-memory only)
│   ├── editor/                  Remote-write policy, editor launch config
│   ├── ssh/                     SSH service interface (russh, Phase 2)
│   ├── sftp/                    SFTP service interface (russh-sftp, Phase 3)
│   └── commands/                Thin `#[tauri::command]` adapters
├── tests/                       Cross-cutting test assets (containerised SSH in Phase 2)
└── docs/
```

`commands/*` contain no business logic: they validate/deserialise input,
call a service and map errors. Services are plain Rust structs/traits and are
unit-tested without Tauri.

## 3. Persistence

| Data                       | Owner | Location                                     | Format          |
| -------------------------- | ----- | -------------------------------------------- | --------------- |
| Saved connections, folders | Rust  | `<app config dir>/connections.json`          | JSON, versioned |
| Settings (incl. UI prefs)  | Rust  | `<app config dir>/settings.json`             | JSON, versioned |
| Known host keys            | Rust  | `<app config dir>/known_hosts.json`          | JSON, versioned |
| Passwords / passphrases    | Rust  | OS keychain via `keyring`                    | opaque          |
| Workspace/tab metadata     | Rust  | `<app config dir>/workspace.json` (Phase 5)  | JSON            |
| Editor temp files          | Rust  | `<app cache dir>/edit/<session>/…` (Phase 4) | raw             |

_Why JSON and not SQLite:_ hundreds (even thousands) of connections are a few
hundred KB. A single JSON document written atomically (temp file + `fsync` +
rename) is simpler, diff-able, trivially portable and avoids a native SQLite
build on three platforms. The store sits behind `ConnectionStore`, so it can be
swapped for SQLite later without touching IPC.

App directories come from the OS conventions through the `dirs` crate, wrapped in
the per-OS leaf modules (`platform/{windows,linux,macos}.rs`): config in
`%APPDATA%\PeachTerm`, `$XDG_CONFIG_HOME/peachterm` or
`~/Library/Application Support/PeachTerm`; logs in `%LOCALAPPDATA%\PeachTerm\logs`,
`$XDG_STATE_HOME/peachterm/logs` or `~/Library/Logs/PeachTerm`. Shared code only
receives plain `PathBuf`s (`AppPaths`). See [logging.md](logging.md).

Loading is forgiving (`storage::atomic`): invalid JSON, wrong field types and
damaged list entries are reported as `ConfigIssue`s, replaced by defaults
field-by-field, and the original file is copied aside, so a bad value never
discards valid data and never prevents start-up.

Export, import and encrypted backups of this data live in `portability/` (see
[import-export.md](import-export.md) and [backup-format.md](backup-format.md)); they reuse the stores
above and add no persistence of their own.

Never persisted: plaintext passwords, private-key contents, remote-write
permission overrides, host-key decisions that were not explicitly confirmed.

## 4. Credential storage

`security::credentials::CredentialStore` (trait):

- `KeyringCredentialStore` – `keyring` 3.6 with `windows-native`
  (Credential Manager), `apple-native` (Keychain) and `sync-secret-service`
  (Secret Service over D-Bus, `crypto-rust`).
- `MemoryCredentialStore` – tests only.

At start-up Rust probes the keyring. If it is unavailable the status is
reported to the UI (`credentials_status`), the "save password" option is
disabled, and connections still work by prompting. **There is no plaintext
fallback.** Passwords travel renderer→Rust once (when typed) and are never
returned to the renderer. Private keys stay where the user keeps them; only the
path is stored.

## 5. SSH / terminal data path

```
xterm.js ──onData──► invoke("ssh_write", {sessionId, data})  ─► mpsc ─► russh channel
xterm.js ◄─write──── Channel<TerminalEvent> (tauri::ipc::Channel) ◄─ coalescing pump ◄─ russh channel
```

- Output is streamed through a per-session `tauri::ipc::Channel`, written
  straight into the xterm instance — **never through React state**.
- A Rust pump coalesces bytes (≤ 64 KiB or 8 ms) to cap IPC overhead. Flow
  control is credit based: the renderer acknowledges rendered bytes (`ssh_ack`)
  and the SSH read loop stops reading once 512 KiB are unacknowledged, so
  memory is bounded. While the application is locked output is held (≤ 256 KiB,
  newest wins) and not forwarded.
- Each tab owns an independent Tokio task; no global lock on the hot path.
- SFTP reuses the authenticated `russh` handle on a second channel
  (`request_subsystem("sftp")`); failure leaves the shell untouched.

## 6. Host-key verification

`known_hosts.json` maps `host:port` → algorithm + SHA-256 fingerprint.
`KnownHosts::check()` returns `Matched | Unknown | Changed{previous}`.
`Unknown` and `Changed` abort the handshake _before any credential is sent_;
the UI shows the fingerprint and the user must explicitly approve
(`known_hosts_trust`). A changed key shows a distinct red warning and needs a
separate, explicit "replace" action. There is no setting to disable this.

## 7. Remote-write confirmation policy (core invariant)

Implemented in `editor::policy` and `sessions`, enforced by `editor::service`
(see [editor.md](editor.md)).

- Every `ConnectionSession` is created with
  `RemoteWritePolicy::AlwaysAsk`. The type has **no** `Serialize`/`Deserialize`
  impl, so it cannot reach settings, workspace restore or IPC payloads.
- A reconnect creates a _new_ `ConnectionSession` (new `SessionId`), therefore a
  fresh `AlwaysAsk` – the override of the previous session is dropped with it.
- Uploads require an `UploadAuthorization` value that can only be minted by
  `PendingWrite::approve()` in Rust, which is reachable only from (a) an
  explicit user answer to a Rust-issued prompt id, or (b) the in-memory
  session override set by "Yes to all". Renderer-supplied paths cannot mint one.
- Prompt ids are single-use and bound to `(session_id, local_path, content_hash)`.

## 8. Platform abstraction

| Concern        | Shared interface                 | Per-OS leaf                                          |
| -------------- | -------------------------------- | ---------------------------------------------------- |
| App dirs       | `platform::AppPaths`             | Tauri path resolver                                  |
| Credentials    | `CredentialStore`                | `keyring` backend features per target                |
| Editor presets | `editor::presets()`              | `platform/{windows,linux,macos}.rs`                  |
| Editor launch  | `EditorCommand` (program + args) | macOS `open -a` handled in macOS leaf                |
| File watching  | polling (`editor::service`)      | identical on every OS; survives atomic-replace saves |
| Shortcuts      | `src/shared/platform.ts` (`Mod`) | Ctrl on Win/Linux, Cmd on macOS                      |
| File dialogs   | `tauri-plugin-dialog`            | native                                               |

## 9. Renderer state

Zustand stores, one per feature (`connections`, `sessions/tabs`, `settings`).
Stores hold _metadata only_. High-frequency data (terminal output, transfer
progress) bypasses stores and goes to imperative sinks.

## 10. Security boundaries summary

- Tauri capabilities grant the renderer only `core:default`-style event access
  plus the app's own commands and the dialog `open` command.
- CSP restricts scripts to `'self'`; no remote content is loaded.
- `AppError` messages are built from fixed strings + non-sensitive context;
  secrets are wrapped in `SecretString` (`zeroize`) and have no `Debug` output.
- No telemetry, no network access other than the SSH connections the user opens.

### `freezePrototype` is off on purpose

Tauri's `freezePrototype` freezes `Object.prototype` before any page script
runs. xterm.js assigns `toString` on its own namespace objects at import time,
which then throws and leaves an empty window (found in the first packaged
Phase 2 build; browsers and tests do not freeze, so they never saw it). The
setting stays `false`; the strict CSP (`script-src 'self'`, no remote content)
remains the main protection against injected script.
