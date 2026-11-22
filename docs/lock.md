# Application lock

Optional (off by default). Settings → Security → Application lock, the lock button
in the sidebar footer (status bar when the sidebar is collapsed) and the
`Lock application` shortcut (default Ctrl+Shift+L / ⇧⌘L).

## What it is — and is not

An in-app lock for walking away from an unlocked desktop. It does **not** replace
locking the operating system and does **not** protect against a fully
compromised user session (malware running as you, someone who can read process
memory or edit PeachTerm's files). Say so to users; do not oversell it.

## Authentication

- Method: **lock password** (minimum 8 characters), stored only as an
  **Argon2id** hash (19 MiB, t=2, p=1, random salt, PHC string) in
  `lock.json` in the configuration directory. The password is never written
  anywhere, never logged, and held in zeroizing memory while in use.
- **Not implemented yet** (and not claimed anywhere in the UI): Windows Hello,
  macOS LocalAuthentication/Touch ID, Linux native authentication (polkit/PAM),
  and locking together with the OS session. The module is structured so another
  authenticator can be added next to the password one.
- No arithmetic questions or CAPTCHAs are used: those are not authentication.
- Changing or removing the password requires the current password. Removing it
  turns the lock off.

## Setup is guided

The lock can only be switched on while a password exists. Ticking "Enable
application lock" without one opens the _Set lock password_ dialog; the
`Lock application` shortcut without a configured lock opens Settings → Security
instead of "locking" with nothing behind it. The backend rejects a settings
save that enables the lock without a password, and ignores such a flag found in
a hand-edited file (start-up notice: "password file is missing, so the lock is
off").

## Enforcement is in Rust

- `lock::LockFlag` is the single source of truth. The renderer overlay is only
  a view of it.
- Every IPC command calls `state.lock.guard()` first, except a short, reviewed
  allowlist (`lock_status`, `lock_unlock`, `lock_now`, `lock_touch`, `app_info`
  — which withholds start-up notes while locked —, `window_apply_theme`,
  `editor_presets`). A unit test scans `src/commands/*.rs` and fails for any
  command that is missing the guard.
- While locked the backend refuses: reading/saving settings and connections,
  credentials (set/clear/status), known hosts, diagnostics and log export, and
  — via the shared flag in `SessionRegistry` — opening sessions, evaluating or
  answering remote-write prompts. Phases 2–4 must call `lock.guard()` in their
  commands (SSH write/resize/close from the UI, SFTP operations, editor
  uploads) and check `LockFlag` in the output pump.
- **Remote writes:** locking drops every in-memory "Yes to all" override, so a
  fresh confirmation is required after unlocking (and the policy was already
  per-session and never persisted).
- **Terminal output while locked (Phase 2 requirement):** existing SSH
  connections may stay open; the output pump must either buffer a bounded
  amount (drop-oldest) or discard, never forward to the renderer, and the UI
  accepts no input (`inert`). Nothing is exposed through previews: the locked
  window shows only the lock screen.

## Behaviour

- **Locking** (button, shortcut, inactivity) takes effect immediately in Rust
  and then emits `lock-state-changed`. All dialogs and toasts are closed, key
  recording is stopped, the workspace stays mounted but `inert`,
  `aria-hidden` and `visibility:hidden`, and the lock screen covers the window.
  Tabs and sessions are kept; after unlocking the same workspace is back.
- **Lock screen:** no close button, Esc does nothing, no connection data, one
  action: _Unlock PeachTerm_.
- **Restart:** with the lock enabled the process **always starts locked**. An
  unlocked state is never persisted (the lock file contains only the hash, the
  failed-attempt counter and the lock-out deadline), so a crash or "quit while
  unlocked" cannot leave the next launch open. While locked at start-up the
  renderer loads nothing; the backend would refuse anyway.
- **Inactivity:** 1, 5, 15, 30 minutes or never. The renderer sends throttled
  activity pings (`lock_touch`, ≤ 1 per 5 s) but the timer lives in Rust and
  sleeps until its deadline (no polling), so a stalled renderer cannot keep the
  app unlocked.
- **Rate limiting:** 3 free attempts, then 5 s, 10 s, 20 s … capped at 15 min.
  The counter and deadline are persisted, so restarting does not reset them.
  Verification runs off the async workers.
- The lock-state notification carries only a boolean; no OS notification is
  ever raised with connection names.

## Logging

Events `lock.locked`, `lock.unlocked`, `lock.unlock_failed` (attempt count),
`lock.password_set`, `lock.password_removed` — no password, no host names.

## Tests

Rust: hashing (no plaintext, random salt, Argon2id), lock/unlock, wrong
passwords, persisted rate limit across restarts, exponential schedule, locked
start after restart, password change/removal rules, inactivity timer + activity
deferral, damaged lock file, session registry blocking and policy reset,
command-guard source scan, AppState-level restart test. Frontend: guided setup,
button visibility, immediate lock, hidden/inert workspace, shortcuts inert,
dialogs closed on lock, Esc cannot dismiss, wrong/right password, lock-out
message, started-locked loads nothing, backend refusals.

## Platform work still to do

Windows Hello (`UserConsentVerifier`), macOS `LocalAuthentication`, Linux
polkit, OS-session-lock detection (`WTSRegisterSessionNotification`,
`NSWorkspaceSessionDidResignActive`, logind `Lock` signal).
