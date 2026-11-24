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

## Data portability (`portability`)

See [import-export.md](import-export.md) and [backup-format.md](backup-format.md).
No command takes a file path: Rust opens the native dialogs. Every command
enforces the Application Lock; staged state is wiped when the lock engages.
Secrets travel renderer → Rust only (the backup passphrase) and never back.

| Command                     | Args                                        | Returns                                                 | Status |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------- | ------ |
| `connections_export`        | `ids \| null`, `includeKeyPaths`            | `{ savedTo \| null, connections, folders, keyPaths }`   | ✅     |
| `connections_import_pick`   | –                                           | `ImportPreview \| null` (staged in Rust behind a token) | ✅     |
| `connections_import_apply`  | `token`, `{ duplicates, update[] }`         | `RestoreResult`                                         | ✅     |
| `backup_choose_destination` | –                                           | `{ token, path } \| null`                               | ✅     |
| `backup_create`             | `token`, `options`, `passphrase`, `confirm` | `BackupSummary` (counts, skipped credentials, verified) | ✅     |
| `restore_pick`              | –                                           | `{ token, fileName, sizeBytes, formatVersion } \| null` | ✅     |
| `restore_unlock`            | `token`, `passphrase`                       | `RestorePreview` — redacted, no credential values       | ✅     |
| `restore_apply`             | `token`, `RestoreOptions`                   | `RestoreResult` (counts only)                           | ✅     |
| `portability_cancel`        | `token`                                     | `()` — discards the staged operation                    | ✅     |

### Server notes in portability

`connections_export` takes an optional `notes { include, snapshots }`, `connections_import_apply` an `importNotes`
option, `backup_create` an `includeNotes` option and `restore_apply` a `restoreNotes` option. `ImportPreview` /
`RestorePreview` gain `notes?: NotesPreview` (counts: notes, internal, linkedFiles, webDocuments, snapshots, shared,
missingFiles, conflicts, unattached) and `notesInvalid`; `RestoreResult` gains `notes?` (created, attachedExisting,
snapshots, skipped); `BackupSummary` gains `notesRequested`, `notesIncluded`, `snapshotsIncluded`, `linkedFiles`.
Previews never contain titles or content.

## Server notes (`notes`)

See [notes.md](notes.md). Every command refuses while locked. The renderer never supplies a file path; local files come
from the native dialog opened in Rust, web addresses are validated and fetched in Rust. List commands return summaries
(no content); content only comes from `note_read`.

| Command                                                       | Args                                          | Returns                                                                        |
| ------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `notes_counts`                                                | –                                             | `{ connectionId: number }` (drives the tree indicator)                         |
| `notes_list`                                                  | `connectionId`                                | `{ notes: NoteSummary[], lastSelected }`                                       |
| `notes_all`                                                   | –                                             | every note (also unattached), to attach an existing one                        |
| `note_create`                                                 | `connectionId`, `title`, `format`, `content?` | note id (Markdown or text)                                                     |
| `note_attach_url`                                             | `connectionId`, `url`, `title?`               | note id; validated, GitHub file pages resolved, nothing fetched                |
| `note_attach_file` / `note_relocate`                          | `connectionId` / `noteId`                     | note id / bool; native file dialog in Rust (`null`/`false` = cancelled)        |
| `note_read`                                                   | `noteId`                                      | `NoteContent { status, text, problem, fromOffline, … }`; fetches web documents |
| `note_write`                                                  | `noteId`, `content`                           | `()`; internal notes only, atomic                                              |
| `note_rename`, `note_set_zoom`, `note_select`, `note_reorder` | …                                             | `()` / clamped zoom                                                            |
| `note_attach`, `note_detach`, `note_delete`                   | `noteId` (+ `connectionId`)                   | `()`; detach = this connection only, delete = everywhere                       |
| `note_save_offline`, `note_remove_offline`                    | `noteId`                                      | `OfflineMeta` / `()`                                                           |
| `note_open_external`                                          | `noteId`                                      | opens the linked file / original URL in the default application                |
| `note_open_link`                                              | `url`                                         | opens an `http(s)` link from a document in the system browser                  |

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

## SSH sessions

| Command / event       | Direction        | Shape                                                                                                                                                                                                  |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ssh_open`            | R→Rust           | `{ connectionId, cols, rows, onEvent: Channel<TerminalEvent>, attempt? }` → `{ sessionId }`                                                                                                            |
| `ssh_write`           | R→Rust           | `{ sessionId, data: base64 }` (keyboard input / paste)                                                                                                                                                 |
| `ssh_resize`          | R→Rust           | `{ sessionId, cols, rows }`                                                                                                                                                                            |
| `ssh_ack`             | R→Rust           | `{ sessionId, bytes }` flow control: output bytes the terminal has rendered                                                                                                                            |
| `ssh_close`           | R→Rust           | `{ sessionId }`                                                                                                                                                                                        |
| `TerminalEvent`       | Rust→R (Channel) | `{ kind:"data", data: base64 } \| { kind:"status", state } \| { kind:"closed", reason } \| { kind:"sftp", state }`                                                                                     |
| `ssh-prompt`          | Rust→R (event)   | `{ kind:"hostKey", promptId, sessionId, host, port, algorithm, fingerprint, previousFingerprint? }` or `{ kind:"auth", promptId, sessionId, method, name, instructions, prompts[{text,echo}], retry }` |
| `ssh_answer_host_key` | R→Rust           | `{ promptId, decision: "trustOnce" \| "trustAndSave" \| "replace" \| "reject" }`                                                                                                                       |
| `ssh_answer_auth`     | R→Rust           | `{ promptId, answers: string[] \| null }` (`null` = cancel)                                                                                                                                            |

`sessionId` is a fresh UUID **per connection attempt**: a reconnect yields a new
id and therefore a fresh `RemoteWritePolicy::AlwaysAsk`. Prompt ids are
single-use and expire after 180 s. See [ssh.md](ssh.md).

## SFTP and the editor round trip

| Command                        | Shape                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `sftp_status`                  | `{ sessionId }` → `"pending" \| "ready" \| "unavailable"` (also pushed as a terminal event)            |
| `sftp_list`                    | `{ sessionId, path \| null }` → `{ path, parent, entries[RemoteEntry] }`                               |
| `sftp_mkdir`                   | `{ sessionId, parent, name }` → new path                                                               |
| `sftp_rename`                  | `{ sessionId, path, newName }` (same directory, never replaces)                                        |
| `sftp_delete`                  | `{ sessionId, path }` → `{ removed }` (trees included; symlinks are removed, not followed)             |
| `sftp_download`                | `{ sessionId, remotePath, onEvent }` → `bool` (Rust opens the native "save as" dialog)                 |
| `sftp_pick_upload`             | `{ sessionId }` → `{ pickId, files[{name,size}] } \| null` (native picker; paths stay in Rust)         |
| `sftp_upload`                  | `{ sessionId, pickId, remoteDir, overwrite, onEvent }` (the pick id is single-use)                     |
| `sftp_cancel`                  | `{ transferId }`                                                                                       |
| `editor_open_remote`           | `{ sessionId, remotePath }` → `{ editId, name, alreadyOpen }`                                          |
| `editor_answer`                | `{ editId, answer: "yes" \| "yesToAll" \| "no" \| "cancel" }` → accepted only for an open prompt       |
| `editor_resolve_conflict`      | `{ editId, choice: "overwrite" \| "keepLocal" }`                                                       |
| `editor_retry` / `editor_stop` | `{ editId }`                                                                                           |
| `editor-event`                 | Rust→R: `opened`, `confirm`, `uploading`, `uploaded`, `uploadFailed`, `conflict`, `declined`, `closed` |

`TransferEvent` (Channel): `started`, `progress`, `completed`, `failed{reason,message}`,
`cancelled`, `finished`. Errors carry `code: "remote"` and a fixed sentence.

The renderer never passes a local path to any upload command; Rust owns the
mapping `editId → (session, private copy, remote path, base hashes)` and the
confirmation state. See [sftp.md](sftp.md) and [editor.md](editor.md).

## Workspace, recent sessions and window scale

| Command              | Shape                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_load`     | → `{ tabs[{connectionId, title\|null}], active, split{orientation, ratio, panes[i,j], focus}\|null }` (empty unless "restore tabs" is on; tabs of deleted connections left out) |
| `workspace_save`     | `{ layout }` — stores nothing when "restore tabs" is off                                                                                                                        |
| `recent_list`        | → saved-connection ids, newest first, at most `general.recentSessionsLimit`; deleted ones pruned                                                                                |
| `recent_clear`       | forgets the history only                                                                                                                                                        |
| `window_apply_scale` | `{ percent }` → applied percent (snapped to 70…150 step 10); the WebView zoom; allowed while locked                                                                             |

Settings gained `general.recentSessionsLimit` (3–20, default 3) and
`appearance.interfaceScale` (70–150 step 10, default 100); older files without them
load with the defaults. See [workspace.md](workspace.md).
