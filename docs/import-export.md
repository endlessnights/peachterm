# Connection export and import

Settings → **Data & Backup → Connection profiles** moves saved connection
profiles between computers as a small JSON file. **The file never contains
passwords or any other secret.** To move saved passwords too, use an
[encrypted backup](backup-format.md).

## What the existing architecture looks like

Found while implementing this feature (nothing was assumed):

| Concern                   | Where it lives                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Connections and folders   | `connections.json` (`storage::connections`), versioned, written atomically (`storage::atomic`)                                     |
| Identifiers               | Random UUID per connection and folder. **The connection UUID is also the credential-store account**                                |
| Folder hierarchy          | `parentId`, at most 3 levels (`storage::tree_ops::MAX_FOLDER_DEPTH`), manual `sortOrder`                                           |
| Passwords and passphrases | OS credential store only (`security::credentials`, account `connection:<uuid>`); one secret per profile; **no plaintext fallback** |
| Whether a secret exists   | `hasStoredSecret` flag in `connections.json`                                                                                       |
| Settings                  | `settings.json` (`storage::settings`), normalised on load and save                                                                 |
| Application Lock          | `lock::LockFlag`; every IPC command starts with `lock.guard()` (a unit test enforces it)                                           |
| Protocol                  | SSH only. There is no per-connection appearance setting, so none is exported                                                       |
| Capabilities              | Commands are listed in `build.rs` and `permissions/app-commands.toml`                                                              |

Consequence: the real connection UUID is a credential-store handle, so it is
**never exported** (see "Identifiers" below).

## The `peachterm-connections` format (version 1)

```json
{
  "format": "peachterm-connections",
  "formatVersion": 1,
  "application": "PeachTerm",
  "exportedAt": "2026-11-23T12:00:00.000000Z",
  "folders": [{ "id": "…", "name": "Production", "parent": null, "order": 0, "expanded": true }],
  "connections": [
    {
      "id": "…",
      "name": "Web 1",
      "protocol": "ssh",
      "host": "2001:db8::1",
      "port": 2222,
      "username": "deploy",
      "auth": "publicKey",
      "folder": "…",
      "order": 0,
      "savePassword": true,
      "timeoutSecs": 15,
      "initialDirectory": "/srv/www",
      "keyPath": "/home/me/.ssh/id_ed25519"
    }
  ]
}
```

- This is an **explicit allowlist**. Export builds the document from dedicated
  structures; internal storage objects are never serialised directly.
- `auth` is one of `password`, `publicKey`, `keyboardInteractive`, `agent`.
- `keyPath` is present **only** if the user ticked "Include SSH key file paths";
  it is a path, never key material.
- Array order is display order; `order` is the position among siblings.
- Unicode (including Cyrillic), IPv6 addresses and custom ports are preserved.
- Selecting specific profiles exports them plus the folders that contain them.

### Server notes (optional, off by default)

The default export carries **no notes** (no key, no titles, no contents). With _Include server notes_ the document gets a
`notes` list (the format version stays 1; an older PeachTerm reports `notes` as an unsupported field and imports the
profiles). A separate _Also include saved offline copies_ choice adds those snapshots. The dialog warns that the file is
plain, unencrypted JSON. Exported: titles, internal note text, relations (by the **public** connection ids below), web
addresses, and the **paths** of linked files (never their contents). Never exported: credentials, keyring identifiers,
notes that belong to no exported connection.

Import: notes are validated record by record (title, size, kind, type, address policy: only public `https` addresses,
only supported file extensions); bad records are counted and dropped. The preview shows counts only; _Import the server
notes_ is a checkbox (on by default when the file has notes). A note whose id already exists is never overwritten (it
gains attachments only), so importing the same file twice creates nothing new. Notes attach to the imported **or
matched** profile (a skipped duplicate counts as its existing profile). Nothing is fetched during import and imported
HTML is stored as text and never executed.

### Identifiers

`id` values are **public ids**: `SHA-256("peachterm/export-id/v1" ‖ uuid)`
truncated to a UUID. They are one-way (they cannot be turned into the
credential-store account), stable (the same profile always exports with the same
id) and therefore usable for recognising a profile on the machine it came from.

### Never exported

Passwords, key passphrases, authentication tokens, private-key contents or
files, credential-store identifiers (including the real UUIDs), Application
Lock data, session state, scrollback, terminal input/output, temporary editor
files, logs, upload permissions, environment variables and
`hasStoredSecret`. Unit tests assert this on the serialised document.

## Import

Workflow: **choose file → validate → stage → preview → choose conflict
behaviour → confirm → apply → summary.** Choosing a file never changes data.

1. Rust opens the native file dialog (the renderer never passes a path) and
   reads the file with a 10 MiB cap; only regular files are accepted.
2. The document is validated and staged **in Rust memory** behind a single-use,
   expiring token. Cancelling (or closing the dialog, or locking the app)
   discards it.
3. The preview shows connection and folder counts, new profiles, possible
   duplicates, invalid entries (with reasons), unsupported fields (names only,
   never values), profiles moved out of an unusable folder, missing key files
   and profiles that need a key file chosen.

### Validation

Format name and version (a newer version is refused with an upgrade hint),
JSON structure and types, file size (10 MiB), up to 10 000 connections and
2 000 folders, string lengths and characters (same rules as the connection
editor), port 1–65535 as an integer, host names / IPv4 / IPv6, authentication
mode, protocol (`ssh` only), identifiers, folder references, folder cycles and
the 3-level nesting limit. A bad record is reported and skipped; the rest of
the file stays usable. A connection in an unusable folder moves to the nearest
usable ancestor (not flattened to the top unless there is none).

Nothing in an imported file is executed: no commands, no URLs opened, no SSH
sessions started, no host keys touched. Key paths from the file are only
`stat`ed when they are plain absolute local paths; `\\server\share` and
`//server/share` paths are never touched (that would make Windows contact a
remote host).

### Duplicate detection

A file entry is a **duplicate** when it matches an existing profile by its
(public) id, or by **protocol + host + port + username** (host compared
case-insensitively, IPv6 brackets ignored; user names are case-sensitive). Two
different users on one host are not duplicates. An entry recognised by id whose
host/port/user differ is **changed**.

| Choice                        | Result                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Skip duplicates** (default) | New profiles are added; duplicates are left exactly as they are                                                     |
| **Import as copies**          | Duplicates are added as new profiles named "… (copy)"                                                               |
| **Update selected**           | Only the ticked duplicates change: name, authentication, timeout, initial directory, key path (if the file has one) |

"Update" never changes host, port or user name, and never touches
`savePassword`, the stored-secret flag or the saved password. This is
deliberate: otherwise a file could redirect a saved password to a different
server. "Changed" entries can only be skipped or imported as copies.

Folders are reused when a folder with the same name exists under the same
parent, otherwise created. New items are placed after existing siblings in file
order.

### Persistence

The new tree is computed in memory and written in one atomic file replace
(`connections.json`: temp file, flush, rename). The write is refused if the
connections changed since the preview was built. If it fails, memory and disk
are unchanged and the staged import can be retried. A credentials-free import
does not read, write or delete any credential.

## Security properties

- All privileged work (dialogs, file I/O, validation, merging) is in Rust.
- Every command enforces the Application Lock first; staged data is wiped when
  the lock engages.
- File writes are atomic, create the temp file exclusively and owner-only on
  Unix, and remove it on every failure path.
- The native save dialog asks before replacing an existing file.
