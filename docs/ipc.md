# Rust ⇄ React IPC contract

All commands are `#[tauri::command]` functions registered in `src-tauri/src/lib.rs`
and called through the typed client in `src/shared/ipc.ts`. Payloads use
`camelCase` JSON. Errors are always `AppError { code, message }` where `code` is
a stable machine string and `message` never contains secrets.

Status legend: ✅ implemented (Phase 1) · 🟡 contract fixed, implemented later.

## App

| Command    | Args | Returns                                                                         | Status |
| ---------- | ---- | ------------------------------------------------------------------------------- | ------ |
| `app_info` | –    | `{ name, version, os, arch, issues[] }` (`issues` = secret-free start-up notes) | ✅     |

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

### Tree operations (`storage::tree_ops`)

| Command               | Args                                                                    | Returns                                                                                    | Status |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| `connections_rename`  | `{ id, name }`                                                          | `Connection` — only the display name changes                                               | ✅     |
| `folders_rename`      | `{ id, name }`                                                          | `Folder`                                                                                   | ✅     |
| `tree_move`           | `{ items: ItemRef[], targetFolderId \| null, before: ItemRef \| null }` | `ConnectionTree` — validates cycles and the 3-level limit, atomic                          | ✅     |
| `tree_delete_preview` | `{ items, mode: "moveToParent" \| "deleteContents" }`                   | `{ connectionIds, folderIds, movedConnections, movedFolders }`                             | ✅     |
| `tree_delete`         | `{ items, mode }`                                                       | `{ plan, credentialFailures, tree }` — deletes only the credentials of deleted connections | ✅     |

`ItemRef` = `{ kind: "connection" \| "folder", id }`. See
[connection-tree.md](connection-tree.md).

## Settings (`storage::settings`)

| Command         | Args                     | Returns                         | Status |
| --------------- | ------------------------ | ------------------------------- | ------ |
| `settings_load` | –                        | `Settings`                      | ✅     |
| `settings_save` | `{ settings: Settings }` | `Settings` (normalised/clamped) | ✅     |

`Settings` sections: `general`, `appearance`, `ssh`, `sftp`, `editor`, `diagnostics`, `ui`.
A changed `diagnostics` section is applied to the running logger immediately.
There is intentionally **no** field that disables remote-upload confirmation;
unknown fields are ignored on load, so such a flag cannot be injected.

## Diagnostics (`logging`)

| Command                  | Args | Returns                                                                                                                      | Status |
| ------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| `logging_status`         | –    | `{ enabled, level, effectiveDir, customDir, active, error, droppedLines, fileCount, totalBytes, retentionDays, maxTotalMb }` | ✅     |
| `logging_open_dir`       | –    | `()` — opens the _effective_ log folder (path never supplied by UI)                                                          | ✅     |
| `logging_export_preview` | –    | `{ files[{name,bytes}], totalBytes }`                                                                                        | ✅     |
| `logging_export`         | –    | `{ savedTo \| null, entries[{name,linesKept,linesDropped}], archiveBytes }` — Rust opens the native save dialog              | ✅     |
| `logging_reveal_export`  | –    | `()` — shows the folder of the last archive written by this process                                                          | ✅     |

`error` is a fixed token (`permission_denied`, `relative_path`, …), never a path.

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
