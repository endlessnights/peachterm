# Rust ⇄ React IPC contract

All commands are `#[tauri::command]` functions registered in `src-tauri/src/lib.rs`
and called through the typed client in `src/shared/ipc.ts`. Payloads use
`camelCase` JSON. Errors are always `AppError { code, message }` where `code` is
a stable machine string and `message` never contains secrets.

Status legend: ✅ implemented (Phase 1) · 🟡 contract fixed, implemented later.

## App

| Command    | Args | Returns                       | Status |
| ---------- | ---- | ----------------------------- | ------ |
| `app_info` | –    | `{ name, version, os, arch }` | ✅     |

## Connections (`storage::connections`)

| Command                 | Args                              | Returns                                                           | Status |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------- | ------ |
| `connections_load`      | –                                 | `ConnectionTree { folders: Folder[], connections: Connection[] }` | ✅     |
| `connections_save`      | `{ connection: ConnectionInput }` | `Connection` (id assigned if new)                                 | ✅     |
| `connections_delete`    | `{ id }`                          | `()` – also deletes stored secret                                 | ✅     |
| `connections_duplicate` | `{ id }`                          | `Connection`                                                      | ✅     |
| `folders_save`          | `{ folder: FolderInput }`         | `Folder`                                                          | ✅     |
| `folders_delete`        | `{ id }`                          | `()` – children move to parent                                    | ✅     |
| `connections_move`      | `{ id, folderId \| null }`        | `()`                                                              | ✅     |

`Connection` = `{ id, name, host, port, username, auth: "password" | "publicKey" | "keyboardInteractive" | "agent", keyPath?, savePassword, hasStoredSecret, timeoutSecs, initialDirectory?, folderId?, createdAt, updatedAt }`.
`hasStoredSecret` is computed by Rust; the secret itself is never returned.

## Settings (`storage::settings`)

| Command         | Args                     | Returns                         | Status |
| --------------- | ------------------------ | ------------------------------- | ------ |
| `settings_load` | –                        | `Settings`                      | ✅     |
| `settings_save` | `{ settings: Settings }` | `Settings` (normalised/clamped) | ✅     |

`Settings` sections: `general`, `appearance`, `ssh`, `sftp`, `editor`, `ui`.
There is intentionally **no** field that disables remote-upload confirmation;
unknown fields are ignored on load, so such a flag cannot be injected.

## Credentials (`security::credentials`)

| Command                    | Args                       | Returns                           | Status |
| -------------------------- | -------------------------- | --------------------------------- | ------ |
| `credentials_status`       | –                          | `{ available, backend, detail? }` | ✅     |
| `credentials_set_password` | `{ connectionId, secret }` | `()`                              | ✅     |
| `credentials_clear`        | `{ connectionId }`         | `()`                              | ✅     |
| `credentials_clear_all`    | –                          | `{ cleared: number }`             | ✅     |

There is no `credentials_get`. Secrets are read only inside Rust by the SSH service.

## Known hosts (`security::known_hosts`)

| Command              | Args                                                                | Returns                                                       | Status     |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| `known_hosts_list`   | –                                                                   | `KnownHost[] { host, port, algorithm, fingerprint, addedAt }` | ✅         |
| `known_hosts_remove` | `{ host, port }`                                                    | `()`                                                          | ✅         |
| `known_hosts_decide` | `{ promptId, decision: "trustOnce" \| "trustAndSave" \| "reject" }` | `()`                                                          | 🟡 Phase 2 |

## Editor presets

| Command          | Args | Returns                                                | Status |
| ---------------- | ---- | ------------------------------------------------------ | ------ |
| `editor_presets` | –    | `EditorPreset[] { id, label, program, args }` (per OS) | ✅     |

## SSH sessions (Phase 2)

| Command / event   | Direction        | Shape                                                                             | Status |
| ----------------- | ---------------- | --------------------------------------------------------------------------------- | ------ |
| `ssh_open`        | R→Rust           | `{ connectionId, cols, rows, output: Channel<TerminalEvent> }` → `{ sessionId }`  | 🟡     |
| `ssh_write`       | R→Rust           | `{ sessionId, data: number[] }` (raw bytes)                                       | 🟡     |
| `ssh_resize`      | R→Rust           | `{ sessionId, cols, rows }`                                                       | 🟡     |
| `ssh_close`       | R→Rust           | `{ sessionId }`                                                                   | 🟡     |
| `TerminalEvent`   | Rust→R (Channel) | `{ kind:"data", bytes } \| { kind:"status", state } \| { kind:"closed", reason }` | 🟡     |
| `host-key-prompt` | Rust→R (event)   | `{ promptId, host, port, algorithm, fingerprint, previous? }`                     | 🟡     |
| `auth-prompt`     | Rust→R (event)   | keyboard-interactive / passphrase prompt `{ promptId, prompts[] }`                | 🟡     |
| `auth_respond`    | R→Rust           | `{ promptId, answers[] }`                                                         | 🟡     |

`sessionId` is a fresh UUID **per connection attempt**: a reconnect yields a new
id and therefore a fresh `RemoteWritePolicy::AlwaysAsk`.

## SFTP (Phase 3) and editor round trip (Phase 4)

| Command                        | Shape                                                                                | Status |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------ |
| `sftp_list`                    | `{ sessionId, path }` → `RemoteEntry[]`                                              | 🟡     |
| `sftp_mkdir / rename / delete` | `{ sessionId, path(s) }`                                                             | 🟡     |
| `sftp_download / upload`       | `{ sessionId, remotePath, localPath }` (local path chosen via native dialog in Rust) | 🟡     |
| `editor_open`                  | `{ sessionId, remotePath }` – Rust downloads, hashes, launches editor                | 🟡     |
| `remote-write-prompt`          | event `{ promptId, sessionId, remotePath, server }`                                  | 🟡     |
| `remote_write_answer`          | `{ promptId, answer: "yes" \| "yesToAll" \| "no" \| "cancel" }`                      | 🟡     |
| `remote-conflict-prompt`       | event; answer `"cancel" \| "downloadRemote" \| "overwrite"`                          | 🟡     |

The renderer never passes a local temp path to an upload command; Rust owns the
mapping `promptId → (session, temp file, remote path, base hash)`.
