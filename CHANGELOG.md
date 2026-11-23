# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
