# SSH terminal

Implemented in Rust (`russh`, `src-tauri/src/ssh/`) and rendered with xterm.js
(`src/features/terminal/`).

## Connecting

`ssh_open` creates a **new backend session** for a saved connection (every
reconnect is a new session with a new id). Steps, all inside Rust:

1. TCP connect (timeout from the connection), key exchange.
2. **Host key check before any credential is sent.** The key is compared with
   `known_hosts.json`:
   - known and equal: continue silently;
   - unknown: the UI asks _Trust and save_ / _Connect once_ / _Reject_;
   - **changed**: the UI shows both fingerprints; only the explicit
     _Replace saved key_ answer continues. A plain "trust" answer to a changed
     key is treated as rejection.
3. Authentication: saved password (OS credential store) first, then prompts;
   private keys (with passphrase prompt for encrypted keys), keyboard-
   interactive (server prompts are shown verbatim, masked unless the server
   allows echo), SSH agent (OpenSSH agent / Pageant on Windows, `SSH_AUTH_SOCK`
   elsewhere). Three tries per method, then `auth_failed`.
4. PTY (`xterm-256color`), shell, optional `cd -- '<initial directory>'`.

Questions to the user (`ssh-prompt` event, answered with `ssh_answer_*`) use
single-use unguessable ids, time out after 180 s and are cancelled when the
session ends. Passwords travel only inside the answer command and are wiped
from the dialog afterwards; they are never stored in a renderer store.

## Data path and back-pressure

russh channel → 8 ms / 64 KiB coalescing → Tauri `Channel` (base64) →
`xterm.write`. The write callback acknowledges bytes (`ssh_ack`, batched). Rust
stops reading the SSH channel while more than 512 KiB are unacknowledged, which
makes russh stop reading the socket, so a slow UI throttles the remote program
instead of growing memory. Input goes through a bounded queue and never blocks
the UI.

## Terminal UI

- Copy: `Ctrl+Shift+C` / `Ctrl+Insert` / right-click with a selection.
- Paste: `Ctrl+Shift+V` / `Shift+Insert` / right-click without a selection.
- Search: `Mod+Alt+F` (configurable action "Search in terminal").
- Mouse reporting, 256 colours, true colour, UTF-8 and alternate screen are
  handled by xterm.js (vim, nano, htop, mc and tmux work).
- Reconnect button appears when a session ends or fails; the failure reason is
  one of a fixed set of phrases, never raw server text.

## Tests

`src-tauri/src/ssh/integration.rs` runs the real client against an in-process
`russh` server (`testserver.rs`): password / key / encrypted key / keyboard-
interactive, rejected auth, host-key unknown/changed/rejected, shell I/O, PTY
resize, several sessions, flood back-pressure, cancellation and cleanup. No
network beyond `127.0.0.1` is used.
