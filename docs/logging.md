# Diagnostic logging

PeachTerm writes local, structured, allowlisted logs. Nothing is uploaded and
there is no telemetry. Logs exist to debug problems on the user's own machine and
to be attached to a bug report **by the user, after reviewing them**.

Settings → Diagnostics controls everything described here; the same settings
persist in `settings.json` (section `diagnostics`) and apply immediately.

## Where things live

|                                                                  | Windows                           | Linux                                                                        | macOS                                      |
| ---------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| Config (`connections.json`, `settings.json`, `known_hosts.json`) | `%APPDATA%\PeachTerm\`            | `$XDG_CONFIG_HOME/peachterm/` (default `~/.config/peachterm/`)               | `~/Library/Application Support/PeachTerm/` |
| Logs (default)                                                   | `%LOCALAPPDATA%\PeachTerm\logs\`  | `$XDG_STATE_HOME/peachterm/logs/` (default `~/.local/state/peachterm/logs/`) | `~/Library/Logs/PeachTerm/`                |
| Cache (editor temp files, Phase 4)                               | `%LOCALAPPDATA%\PeachTerm\cache\` | `$XDG_CACHE_HOME/peachterm/`                                                 | `~/Library/Caches/PeachTerm/`              |

Paths are resolved by the OS conventions via the `dirs` crate in
`src-tauri/src/platform/{windows,linux,macos}.rs`; no user directory is hardcoded.
The log folder can be changed in Settings (absolute paths only).

_History:_ before this milestone the data lived in Tauri's identifier-based folder
(`…/dev.peachterm.app/`). No release was ever shipped with it and no user data
existed there, so it is not migrated.

## Settings

| Setting            | Values                          | Default |
| ------------------ | ------------------------------- | ------- |
| File logging       | on / off                        | **on**  |
| Level              | error, warn, info, debug, trace | info    |
| Log folder         | any absolute path, or default   | default |
| Retention          | 7, 14, 30 days                  | 14      |
| Maximum total size | 10–1000 MB                      | 100 MB  |

Level changes, the on/off switch and a new folder take effect without a restart
(`Apply logging settings`, or Save).

## Rotation and retention

- One file per UTC day: `peachterm-YYYY-MM-DD.log`; a file is closed at 5 MiB and
  the next gets a numeric suffix (`peachterm-YYYY-MM-DD.1.log`).
- On start-up, on every rotation and on every reconfiguration, files older than the
  retention window are removed, then the oldest files until the total fits the
  size cap. The file being written is never removed.
- **Only files matching that exact name pattern are ever deleted**, so pointing the
  log folder at `Documents` cannot delete anything else.
- Lines are written append-only and flushed whenever the writer is idle, so a crash
  can damage at most the last line; earlier logs are untouched.

## Resilience

- The writer is a background thread fed through a bounded queue (4096 lines).
  Producers never block; if the queue is full lines are dropped and counted, and a
  `logs.dropped` event records how many.
- A missing folder is created; an unwritable one (permissions, file in the way,
  disk full, relative path) puts logging in an _inactive_ state with a fixed error
  token. The app shows a non-blocking notice and keeps working. Writes are retried
  at most every 5 seconds.
- Failures of the logger itself never produce log events (no feedback loops) and
  never reach the UI thread.
- Logging initialisation cannot fail the application.

## What is logged — and what can never be logged

Logging uses `tracing`, but PeachTerm does **not** use a generic formatter. A
custom layer (`logging/layer.rs`) writes one JSON object per line and records
only what an explicit allowlist (`logging/fields.rs`) permits:

1. **Event names are a closed registry** (`EVENTS`), e.g. `app.start`,
   `ssh.auth_failed`, `editor.upload_declined`. Unknown names become `<invalid>`.
2. **Fields are a closed list.** Anything else is dropped at every level,
   including DEBUG and TRACE: `message`, `password`, `host`, `username`, `path`,
   `error` strings, `content`, `payload`, `token`, …
3. **Values are validated against closed sets**, not just a shape: tokens must be
   members of `IDENT_VOCABULARY` (`password`, `permission_denied`, …), config
   field names must exist in the real settings schema, data files must be one of
   our four file names, ids must be canonical UUIDs, numbers/booleans must be
   numbers/booleans. A password like `hunter2` is token-shaped, which is why shape
   checks alone are not used. Invalid values are replaced by `<invalid>`.
4. **Third-party crates** (tauri, wry, russh, anything using `log`) never have
   their text recorded. At WARN/ERROR only `ts`, `level`, `target` and
   `third_party:true` are written.
5. **Panics** are logged without payload or absolute path (source file name and
   line only).
6. Host names, user names and paths are **not logged at all**; a connection or
   session is referred to by its UUID.

Example lines:

```json
{"event":"app.start","version":"0.1.0","os":"windows","arch":"x86_64","level":"INFO","target":"peachterm_lib","ts":"2026-11-22T14:00:00.123456Z"}
{"event":"config.issue","file":"settings.json","kind":"invalid_value","field":"ssh.keepaliveSecs","backup":true,"level":"WARN","target":"peachterm_lib","ts":"…"}
{"event":"connection.created","connection_id":"4f3653b1-1f94-4a43-a430-3db9ca1877f9","level":"INFO","target":"peachterm_lib::commands::connections","ts":"…"}
```

### How to log from new code (Phases 2–4)

```rust
tracing::info!(event = "ssh.connected", session_id = %session_id, auth_kind = "password");
tracing::warn!(event = "sftp.unsupported", session_id = %session_id, reason = "subsystem_refused");
```

If a new event or token is needed, add it to `EVENTS` / `IDENT_VOCABULARY` in the
same change: that is the review point. Never add a field that can carry free text.

## Export

Settings → Diagnostics → _Export diagnostic logs…_

1. A review panel lists the files that will be included (sizes shown) and what is
   excluded (settings, connections, saved passwords, host keys).
2. The user confirms; a native _Save as_ dialog (opened by Rust, not by the UI)
   picks the destination.
3. Each log line is **rebuilt from scratch** through the same allowlist, then a
   second independent filter drops values that still look like a path, e-mail,
   host or IP. Non-JSON lines, oversized lines and unknown keys are discarded.
4. `diagnostics.json` records the app version, OS, architecture, log level,
   retention and per-file kept/dropped line counts.
5. The result view shows what was written and offers _Show in folder_, so the
   archive can be opened and inspected before it is shared.

Nothing is sent anywhere.

## Tests

`cargo test` covers: level filtering and runtime changes; allowlist and value
validation; third-party text exclusion; an end-to-end test that pushes ten
different secrets through every level into real files and a real export;
rotation by size and day; retention by age and size; deleting only our own files;
unwritable / relative / missing directories and recovery; queue overflow;
custom directory selection; persistence of logging settings across simulated
restarts; export sanitisation; corrupt-config handling. Frontend tests cover the
Diagnostics page, status warnings and the export review flow.
