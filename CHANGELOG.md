# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0] - 2026-11-25

### Added

- **Drag and drop from the file manager into the SFTP panel**: files and whole folders (recursively, relative paths
  preserved, symbolic links never followed). A drop on a remote folder row uploads into that folder, on empty space
  into the current directory; a subtle overlay shows the real destination and counts. Existing overwrite
  confirmation, progress, cancel and queue behaviour apply. See `docs/sftp.md`.
- **Nested connection folders**: _New Folder_ accepts a path such as `ops/docker`; missing levels are created
  atomically, existing ones reused. Invalid paths are rejected before anything is written.
  The SFTP panel's _New Folder_ accepts the same kind of path and creates the levels one by one.
- **Terminal → Copy Behavior**: _Copy on selection_ (default, also for existing installs) or _Copy on right-click_.
- **Linux Command Help** (optional, off by default, offline): explanations for selected common read-only commands
  and cautious, user-started read-only permission diagnostics after an SFTP "permission denied". Nothing is sent
  anywhere, nothing is run for you. See `docs/linux-help.md`.

### Changed

- Recent Sessions are laid out in two columns when there is room (one column when narrow).

## [0.6.0] - 2026-11-25

### Added

- **Complete interface localization** in six languages: English, Russian, German, French, Spanish and Serbian
  (Latin script). Choose **Settings → Appearance → Language** (System default or a fixed language); it applies at
  once with no restart and does not touch SSH sessions, transfers, tunnels, monitoring, notes or the terminal. The
  default follows the system language (`sr-Cyrl-*` systems get Serbian Latin; unsupported languages get English).
  Dialogs, menus, tooltips, accessible labels, warnings and errors are translated; user data, hosts, paths and
  commands never are. Dates, numbers, percentages, lists and plurals use the interface language (Russian and
  Serbian plural rules included).
- **Structured backend errors**: user-facing errors carry a stable `key` (with parameters) or failure `token` that
  the interface translates; the English text stays as diagnostics and fallback. Update failures now show the
  specific reason (signature, network, no package) instead of a generic one.
- `npm run i18n:check` (also in `npm run check` and CI) validates every translation file offline: key parity with
  English, empty values, placeholders and markup, plural completeness per language, unused keys. See
  `docs/localization.md`.

### Changed

- The language setting moved from the General page ("takes effect after restarting") to Appearance and now applies
  immediately. The stored value is now `system` by default (an older `en` stays English); unknown values fall back
  to `system`.
- Third-party notices list `i18next`, `react-i18next` and their small dependencies.

## [0.5.0] - 2026-11-26

### Added

- **Live Server Resource Monitor** (optional, off by default): CPU, RAM, root-filesystem disk usage and uptime of
  the Linux server behind the active SSH tab, in a compact status-bar readout with a details popover. Agentless: a
  fixed read-only command runs over a separate exec channel of the existing SSH connection (nothing is typed into the
  shell). Refresh every 5, 10 or 30 seconds, choose the visible metrics, and override per connection. Readings are
  live only: never saved, logged, exported or sent anywhere. See `docs/monitoring.md`.

## [0.4.0] - 2026-11-25

### Added

- **Server Notes & Documentation**: notes and documents attached to saved connections, shown in the existing
  auxiliary panel beside the terminal (Files | Notes; left or right, resizable, collapsible). Written Markdown and
  text notes with Preview/Edit and autosave, linked local `.md` `.markdown` `.txt` `.html` `.htm` files (path only),
  public HTTPS documents (GitHub README links resolved), search, copy buttons on code blocks (never executes
  anything), per-document zoom 50–200 % with Fit to width, notes shared between connections (detach vs. delete
  everywhere), offline copies on request, and a quiet mark in the connection tree. HTML is reduced to safe structure
  and never runs; web documents are fetched in Rust with strict network restrictions. See `docs/notes.md`.
- Notes in **JSON export/import** (separate opt-in, off by default, with a warning) and in **encrypted backups**
  (conditional "Include Server Notes", payload version 2 only when notes are included; version-1 backups keep
  restoring). Restoring only adds notes and never overwrites existing ones.
- **Tab bar**: the mouse wheel (and horizontal trackpad gestures) over the tab strip scrolls it sideways, and the
  active tab is scrolled into view when it changes (new tab, shortcut, sidebar, restored session).

### Fixed

- Tabs beyond the visible width (about 18 in a typical window) could not be reached because the strip overflowed with
  a hidden scrollbar. There never was a tab limit; the strip is now scrollable and the Add button stays visible.

## [0.3.0] - 2026-11-24

_Installers are not code-signed yet (Windows Authenticode / Apple notarisation). In-app updates are verified
with PeachTerm's own update signature; see `docs/updates.md`._

**Upgrading from 0.2.1:** v0.2.1 has no updater, so install v0.3.0 once by hand over the old version. Settings,
connections, folders, saved credentials, themes and shortcuts are kept. Later releases can be installed from inside
the app.

### Added

- In-app updates through GitHub Releases (official Tauri updater, minisign-verified): **Settings → General →
  Automatically check for updates** (on by default; never installs by itself), a check/status section and release
  notes link in **Settings → About**, a quiet indicator and a compact notice, download progress, and an install
  warning that lists active SSH sessions, tunnels, local terminals, transfers and unsaved work (default: _Install
  Later_). Stable releases only; a `.deb` install is pointed to the release page. See `docs/updates.md`.
- SSH local port forwarding (`ssh -L`): **SSH Tunnels…** in the SSH tab menu. Listens on loopback only, reuses the
  tab's authenticated connection (no second login), shows honest states (_Listening_ is not _Connected_), and stops
  with its SSH session. Definitions are saved per connection without credentials. See `docs/tunnels.md`.
- The exit confirmation counts running SSH tunnels.
- Release workflow: signed updater artifacts and `latest.json` when the signing secrets are configured.

### Changed

- The folder context menu no longer shows a disabled "New sub-folder… (limit: 3 levels)" entry: at the deepest
  allowed level the entry is simply absent, and elsewhere it reads "New sub-folder…". The limit is still enforced
  by the backend.
- Settings → About is more compact: the application, version and author, update status, links and licence now fit
  without scrolling at the standard Settings size.

### Known limitations

- Pre-releases are never offered by the updater (a GitHub "latest" link cannot point at them); there is no
  "include pre-releases" option yet.
- A `.deb` installation cannot update itself; PeachTerm links to the release page instead.
- Tunnel definitions are not included in connection export/import or `.peachbackup` backups.
- The SSH library (`russh`) carries all channels of a connection through one loop: a local program that stops
  reading a forwarded connection can make other traffic of the same SSH connection wait. See `docs/tunnels.md`.

## [0.2.1] - 2026-11-23

_Installers are not code-signed yet._

### Fixed

- Split view: dragging the active tab into a split zone now works like dragging an inactive one (it used to do
  nothing when no split existed yet). The dragged tab decides which session moves.
- When the active tab is dragged out, the original pane is taken over by the tab that takes its place in the
  tab bar.
- The drop preview no longer promises a split that cannot happen: an impossible drop (pane limit, not enough
  room, dropping a pane on itself) is shown as unavailable together with the reason.
- Moving a tab only rearranges panes: existing SSH sessions keep running without reconnecting and keep their
  scrollback.

## [0.2.0] - 2026-11-23

_Installers are not code-signed yet._

### Added

- Settings → Data & Backup: export/import of connection profiles as portable JSON (no passwords or secrets,
  preview and duplicate handling before anything changes) and password-protected `.peachbackup` backups
  (Argon2id + XChaCha20-Poly1305) that restore across Windows, Linux and macOS, with optional saved passwords
  and a guarded restore wizard. See `docs/import-export.md` and `docs/backup-format.md`.
- Split view with up to six panes (side-by-side, stacked, nested), resizable dividers, and drag-and-drop of
  tabs onto pane edges; moving a tab moves its running session.
- Local terminals (Windows PowerShell, PowerShell 7, cmd, WSL distributions, Linux/macOS shells) through a
  native pseudo-terminal, with custom shell profiles and Settings → Terminal.
- Themes: Industrial Olive and Source Gray, each with a matching terminal palette; ten built-in terminal
  palettes, custom terminal colours, optional linking of the terminal palette to the application theme, and
  per-tab terminal palettes.
- Two-step removal of all saved passwords and key passphrases.
- Terminal font picker, optional status bar, interface scale, recent sessions.
- Confirmation before exiting the application, listing what would be lost.
- Settings → About, with author, version and license information.
- Open-source project files: Apache-2.0 license, NOTICE, third-party notices, contribution and security guides,
  and an automated release workflow (draft releases from version tags).

### Changed

- The Known Host Keys list is no longer shown in Settings (host-key verification is unchanged).

## [0.1.0] — not yet released

First public version (to be tagged by the maintainer).
