# In-app updates

PeachTerm checks GitHub Releases for new versions and can download and install them from Settings → About
or from a small notice. It uses the official [Tauri updater plugin](https://v2.tauri.app/plugin/updater/); there
is no custom downloader, no update server, no account and no telemetry.

## What the user sees

- **Settings → General → Automatically check for updates** (on by default). It controls only version _checks_.
  Nothing is ever downloaded or installed without a click.
- **Settings → About** shows the installed version, the status (_Up to date_, _Checking…_, _Update available_,
  _Downloading…_, _Ready to install_, _Update failed_, _Update check unavailable_), the time of the last successful
  check, a **Check for Updates** button and a **Release Notes** link.
- When a newer version exists, a small dot appears next to the Settings button and a compact notice opens **once
  per version** (non-modal, no banner): _Release Notes / Later / Download Update_, then _Install & Restart / Later_.
  "Later" leaves only the dot.
- Download progress is shown only when the server announces the size; otherwise it just says "Downloading…".
- Before installing, PeachTerm checks the same things as the exit confirmation (active SSH sessions, local
  terminals, **SSH tunnels**, file transfers, edited files not yet uploaded, unsaved connection/settings). If any
  exist, a warning lists them and **Install Later** is the default button. Live connections are not restored after
  the restart.

## How checking works

- One check shortly (about 30 s) after start, then about every 24 hours while PeachTerm runs, plus the manual
  button. No overlapping checks, no retry loop (a failed automatic check waits for the next one and stays quiet; a
  manual check explains the problem), 20 s timeout. Offline simply means "could not reach GitHub".
- The only request is a `GET` of
  `https://github.com/endlessnights/peachterm/releases/latest/download/latest.json`. No identifier, no installation
  id and nothing about the machine is sent (the updater's default `User-Agent` and the platform name in the URL
  path are all a server can see; that is inherent to any HTTPS request).
- PeachTerm stores one number for updates: the time of the last successful check (`updates.json`).

## Versions and channels

- Only a strictly **newer** version is offered. Equal or older versions (downgrades) are ignored; versions are
  compared as semantic versions (`0.10.0` > `0.9.0`).
- Pre-releases (`-alpha`, `-beta`, `-rc`) are never offered. **Limitation:** GitHub's `releases/latest/download`
  link points at the newest _non-pre-release_ release, so a "include pre-releases" option cannot be implemented
  reliably with static metadata and a dedicated update server is out of scope. There is therefore no such setting
  in v0.3.0; pre-release testers install manually. The policy function `update::judge` already supports a
  pre-release channel for a future, properly designed feed.

## Signing (security-critical)

Updates are verified with the updater's **minisign** signature against the public key built into the app.
Verification cannot be disabled, unsigned packages are rejected, and `http://` endpoints are not accepted (the
endpoint is fixed to HTTPS). This is **not** Windows Authenticode code signing and **not** Apple notarization:
installers are still unsigned in that sense (see [signing.md](signing.md)); the updater signature only proves that
an update was produced by the holder of the update private key.

A normal source build contains no update key, so it has no update source: **Check for Updates** says the check is
unavailable. Only official release builds (built by the release workflow with the key configured) can update.

### One-time maintainer setup (nothing here has been done for you)

1. Generate the key pair on a trusted machine, with a passphrase. **Never commit it.**

   ```powershell
   npx tauri signer generate -w "$HOME\.tauri\peachterm.key"
   ```

   This writes the private key `peachterm.key` and the public key `peachterm.key.pub`.

2. In the GitHub repository: **Settings → Secrets and variables → Actions**
   - Secret `TAURI_SIGNING_PRIVATE_KEY` = the full contents of `peachterm.key`
   - Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the passphrase
   - Variable (not secret) `TAURI_UPDATER_PUBKEY` = the contents of `peachterm.key.pub`

3. Keep an offline backup of the private key and passphrase. **If the key is lost or replaced, installed copies
   can no longer verify updates** and users must reinstall manually; do not rotate the key without a migration plan
   (ship one release signed with the old key that embeds the new public key first).

The release workflow (`.github/workflows/release.yml`) turns signed updates on only when **both** the secret and
the variable exist: it merges the output of `scripts/updater-config.mjs` (public key, fixed HTTPS endpoint,
`createUpdaterArtifacts`) over `tauri.conf.json`, passes the private key to `tauri-action` as an environment
variable (never written to disk or logs), and `tauri-action` uploads the signed packages, their `.sig` files and
`latest.json` to the draft release (this follows the documented behaviour of `tauri-action` and has **not** been exercised yet: check the first signed release's assets, i.e. per platform a package with its `.sig`, and `latest.json` with `windows-x86_64`, `linux-x86_64` (AppImage), `darwin-aarch64` and `darwin-x86_64`). Without the secrets the release is still built but has **no update metadata**,
and the workflow prints a warning. Always check that `latest.json` is among the release assets before publishing.

## Supported platforms and package formats

| Platform / format        | In-app update | Notes                                                                       |
| ------------------------ | ------------- | --------------------------------------------------------------------------- |
| Windows x64 (NSIS setup) | yes           | the updater runs the signed installer (passive mode) and PeachTerm restarts |
| macOS ARM64 / x64        | yes           | replaces the `.app` from the signed `.app.tar.gz`                           |
| Linux **AppImage**       | yes           | the AppImage file is replaced in place                                      |
| Linux **.deb**           | **no**        | see below                                                                   |

A `.deb` installation cannot update itself: replacing a system package needs administrator rights, which
PeachTerm does not request. When a newer version exists, PeachTerm tells the user so and offers the **release
page** (download the new `.deb`). The `latest.json` entry for Linux points at the AppImage, and PeachTerm refuses
to download or install it into a non-AppImage Linux installation.

## Upgrading from v0.2.1 (one time, manual)

v0.2.1 has no updater, so it cannot find v0.3.0. Download the v0.3.0 installer from the release page and run it
over the old version. Settings, connections, folders, keyring credentials, themes, shortcuts, terminal
preferences and encrypted-backup compatibility are untouched (the installer replaces program files only; user
data lives in the per-user configuration folder and the OS keyring). From v0.3.0 on, signed releases can be
installed from inside the app.

## What has and has not been tested

Automated: version policy (newer / equal / older / pre-release / invalid), failure classification, the single
non-overlapping check, the 24-hour schedule, every UI state (up to date, available, downloading with and without a
known size, ready, postponed, failed download, bad signature reported, failed install, `.deb` fallback), the
install warning (sessions, tunnels, transfers, unsaved settings; _Install Later_ default), the configuration
generator, and the guarantee that no private key or insecure endpoint is committed.

**Not tested end-to-end:** a real download and install of a real signed release. That needs the maintainer's
signing key and a published release newer than the installed one; the first real test is installing v0.3.0 and
then a later signed release (or a disposable signed test release on a throw-away fork).

## Current setup status

The update key pair was generated on the maintainer's machine on 2026-11-24 (outside the repository, in
`%USERPROFILE%\.tauri\`: `peachterm.key`, its passphrase file and `peachterm.key.pub`, readable only by that
user). The GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and the
variable `TAURI_UPDATER_PUBKEY` are set. **Back the private key and its passphrase up now** (for example in a password
manager, as two separate entries, plus an offline copy): there is no other copy, and losing them means installed
copies can never verify another update.
