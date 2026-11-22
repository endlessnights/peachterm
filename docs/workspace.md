# Tabs, split view and workspace

## Identity model

| Id             | What it is                                                                                                            | Lifetime                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `connectionId` | A **saved connection** (profile). Shared by every tab opened from it.                                                 | Until the profile is deleted            |
| tab `id`       | One terminal tab / slot in the workspace.                                                                             | Until the tab is closed                 |
| `sessionId`    | The backend SSH session of the current connection attempt (own channels, PTY, scrollback, SFTP state, upload policy). | One attempt; a reconnect gets a new one |

"Tabs of the same host" always means _same `connectionId`_. Host names, user
names and tab titles are never used as identifiers: two saved profiles pointing
at the same hostname stay separate, and a renamed tab still belongs to its profile.

## Independent sessions

Every double-click, "Connect", "Duplicate Tab" or recent-session click opens a
**new tab and a new SSH session**, also when the connection is already open.
There is no limit per host. Sessions share nothing: closing one tears down only
its own channels (normal SSH teardown; nothing such as `exit` is ever typed into a
shell) and leaves the others to the same host connected.

## Tab context menu

Rename Tab (only this tab; reset returns to the saved name), Duplicate Tab (a new
authenticated session — no channel, terminal content or secret is cloned),
Split Horizontally / Vertically, Close Tab, Close Other Tabs, Close Tabs to the
Right, Close Other Tabs for This Host, Close All Tabs for This Host.

Closing several tabs shows **one** confirmation that states how many sessions
will be disconnected. A single connected tab asks only if "confirm before
closing" is on; ended or idle tabs close without a question.

## Split view

At most two panes (no nesting). _Vertical_ = side by side, _horizontal_ =
stacked. Splitting the active tab opens the second pane as a picker: start a **new
session** of the same saved connection, or show an **existing tab**. The divider
can be dragged (double-click resets to 50 %) or moved with the arrow keys; the
ratio stays between 15 % and 85 %. Each pane has its own xterm, focus, scrolling
and PTY size: a divider move makes each terminal refit and report its own
rows × columns to its own session.

Changing orientation or closing the split only repositions panes: terminals are
never remounted and no session is disconnected. Closing the tab shown in a pane
ends the split; the other pane's tab stays open.

Shortcuts (all rebindable in Settings → Keyboard Shortcuts): duplicate tab
`Mod+Shift+D`, split side by side `Mod+Shift+E`, split stacked `Mod+Shift+O`,
toggle orientation `Mod+Shift+U`, focus next pane `Mod+Shift+P`, close split
`Mod+Shift+X`. A new action's default is **left unassigned** if it would clash
with a binding the user already has; existing bindings are never overridden.

## One SFTP panel, per-session state

There is one SFTP panel for the workspace, but every tab owns its own panel
instance (kept mounted, shown only for the **focused** terminal). So each
session keeps its directory, listing and running transfers, the panel header names
the focused server (`title`, `user@host`), a listing can never appear under
another server's name, and a session without SFTP shows that message only for
itself. The remote-write confirmation policy is per SSH session in Rust (see
[editor.md](editor.md)); "Yes to all" in one pane does not affect the other.

## Persistence (`workspace.json`)

Stored (only when _Settings → General → Restore previous tabs_ is on): per tab the
`connectionId` and a custom title, tab order, active tab, and the split
(orientation, ratio, the two tab positions, focused pane). Never stored:
passwords, keys, session ids, terminal content or commands, remote-write
permissions, SFTP paths. With restoration off nothing about open tabs is written
(an empty layout replaces the old one).

On start the tabs come back **disconnected**: each restored tab shows "Restored
tab — not connected yet" with a Connect button, unless the user enabled _Reconnect
restored tabs automatically_. Connecting always starts a brand new SSH session
with the remote-write policy at `AlwaysAsk`. Tabs of deleted saved connections are
skipped; a split that lost a pane is dropped. The layout is sanitised on load and
save (≤ 100 tabs, titles ≤ 128 characters without control characters, ratio
clamped, indexes validated).

## Recent sessions

`workspace.json` also holds the recent list: saved-connection ids with a time,
newest first, one entry per connection (profiles with the same hostname stay
separate), at most 20 kept. An entry is recorded **only after the server accepted
the login** (not when a tab opens, not on a failed attempt or rejected host key).
Deleted connections are removed when the list is read; renames show up
automatically because only ids are stored. _Settings → General_: **Recent sessions
limit** (3 / 5 / 10 / 15 / 20, default 3, applied with Apply/OK) and **Clear Recent
Sessions History**, which forgets the list only (saved connections, credentials and
open sessions are untouched). The home screen shows compact rows; clicking one
opens a new session in a new tab.

## Interface scale

_Settings → Appearance → Interface scale_: 70 % – 150 % in steps of 10 (default
100 %). It is the **WebView's own zoom factor** (`WebviewWindow::set_zoom`, set from
Rust and again at start-up before the first frame), not a CSS transform or `zoom`
rule: pointer coordinates, hit testing, context-menu placement, drag-and-drop and
the operating system's display scaling are unaffected. Settings previews the value
live; Apply saves and keeps the dialog open, OK saves and closes, Cancel restores the
previous scale; "Reset to 100%" is one click.

The terminal font is a separate setting and is **not** scaled again: xterm gets the
configured size divided by the zoom, so glyphs are exactly the configured size on
screen at every scale. Terminals refit when the viewport changes and report the new
rows × columns to their sessions.

## Trying the application without touching your profile

Set `PEACHTERM_PROFILE_DIR` to an absolute directory before starting PeachTerm:
settings, connections, history, logs and editor copies then live below it
(`config/`, `logs/`, `cache/`).
