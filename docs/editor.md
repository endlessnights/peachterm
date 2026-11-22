# External editor round trip

Open a remote file in your own editor (Notepad++, VS Code, Notepad, `xdg-open`
preset, …), save it there, and PeachTerm — **only after you confirm** — uploads
it back safely.

## Flow

1. **Open.** Double-click a file in the SFTP panel (or _Open in editor_ in its
   menu). Rust downloads it (size limit 64 MiB, refused for directories),
   records the remote size, mtime and SHA-256, stores a private copy and starts
   the configured editor. Opening the same remote file twice in one SSH session
   reuses the same copy and just starts the editor again.
2. **Watch.** Rust looks at the local copy every 300 ms. A change must stay
   unchanged for 700 ms (debounce: editors write in several steps) before it is
   read and hashed; saves that do not change the content, or revert to the last
   synchronised content, are ignored. Polling (rather than OS file events) is
   deliberate: it behaves identically on all platforms and notices editors that
   save by writing a temporary file and renaming it over the original.
3. **Ask.** A real change raises **"Remote file modified"** with
   _Yes / Yes to all / No / Cancel_. Only one question per file is ever open;
   changes made while it is open do not create a second dialog, and an answer
   only ever covers the exact content the question was raised for — if the file
   changed again meanwhile, the upload is not made and the new content is asked
   about. _No_ and _Cancel_ leave the server untouched and the same content is
   not asked again; saving different content asks again.
4. **Upload** (only after _Yes_, or while this SSH session's _Yes to all_ is
   active): a conflict check against the remote file (size, mtime and — up to
   64 MiB — a SHA-256 of what is there now versus what was downloaded), then the
   safe write described in [sftp.md](sftp.md) (temporary file next to the
   target, permission bits preserved, atomic `posix-rename` when the server has
   it, otherwise reported as _not atomic_). Uploads of one file are serialised
   (the watcher performs them itself, one at a time).
5. **Failure.** If anything fails the local copy is untouched and stays; the UI
   shows the reason and the edit can be retried. Local changes are never
   discarded: when the SSH session ends, a copy with unsent changes is kept.
6. **Conflict.** If the server's file changed after it was opened, nothing is
   sent. The dialog offers _Keep my local copy only_ (default) or _Overwrite
   remote file_ (an explicit authorisation for that one upload). Conflict
   detection also applies while _Yes to all_ is active.

## The confirmation policy (security-critical)

- Every SSH session starts with `RemoteWritePolicy::AlwaysAsk`. There is no way
  to start in another state and **no setting** that disables the question.
- _Yes to all_ is held in memory in the `SessionRegistry` entry of that one SSH
  session. It is not `Serialize`/`Deserialize` (compile-time asserted), so it can
  never be written to settings, session-restore data or IPC.
- It ends with the SSH session (disconnect, reconnect — which creates a **new**
  session id —, closing the tab, app restart) and also when the application is
  locked.
- An upload needs an `UploadAuthorization`, a value whose only constructors are
  in `editor::policy` and which `Edit::upload` takes by value and re-checks
  against the session, the remote path and the exact content hash. Answers sent
  from the UI are accepted only for a prompt Rust has open (single use), so the
  renderer cannot pre-authorise anything.
- A static test lists every module that writes remote files; adding one fails
  the build until it is reviewed against this policy.
- While the application is locked, nothing is asked or uploaded; after
  unlocking, pending changes are asked about again.

Covered by `src-tauri/src/editor/integration_tests.rs`, including the mandatory
scenario `yes_to_all_lives_and_dies_with_one_ssh_session`: connect → edit →
_Yes to all_ → more edits upload without a question → disconnect → reconnect →
a question is required → restart the application → a question is required.

## Local files

`<cache dir>/PeachTerm/editing/<edit id>/<name>` (or the configured temporary
directory + `PeachTerm-editing`). Directories are created private (0700 / 0600 on
Unix; on Windows inside the user profile), file names are sanitised (no
separators, `..`, reserved Windows names, control characters; extension kept),
files are created with `create_new` so an existing file or planted symlink is
never followed. Copies are removed when the edit ends unless they hold unsent
changes; at start-up copies older than seven days are purged.

## Editor configuration

_Settings → SFTP & editor_: program, arguments (`{file}` is replaced by the
local path; if absent the path is appended) and temporary directory. Without a
program the first preset found on the machine is used (Notepad++ → VS Code →
Notepad on Windows). The program is started with an argument vector, never
through a shell, and is not waited for.

## Logging

`editor.launched`, `editor.local_change_detected`,
`editor.write_confirmation_requested`, `editor.upload_approved|declined|
completed|failed`, `editor.conflict_detected`, `editor.policy_reset` — fixed
tokens and counts only; never file names, paths or content.
