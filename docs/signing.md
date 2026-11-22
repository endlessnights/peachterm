# Code signing and notarization

**PeachTerm releases are currently not code-signed and not notarized.** Early releases are published unsigned and
say so in their release notes. Nothing in the project bypasses or disables an operating-system security feature.

## What users will see

### Windows (SmartScreen)

Unsigned installers trigger "Windows protected your PC" (Microsoft Defender SmartScreen). A user can choose
**More info → Run anyway** after checking where the file came from. Signing removes the "unknown publisher"
label; with a standard (OV) certificate SmartScreen reputation still builds up over time, an EV certificate
gets it immediately.

To sign later you need a code-signing certificate (OV or EV, or a cloud signing service such as Azure Trusted
Signing). Tauri signs the installer when `bundle.windows.certificateThumbprint` (or a `signCommand`) is set in
`src-tauri/tauri.conf.json`; in CI the certificate goes into encrypted repository secrets, never into the repo.

### macOS (Gatekeeper)

Unsigned and un-notarized apps are blocked by Gatekeeper ("cannot be opened because the developer cannot be
verified"). Users can open the app once via **System Settings → Privacy & Security → Open Anyway**.

To distribute without warnings you need:

1. An Apple Developer Program membership and a **Developer ID Application** certificate (code signing,
   hardened runtime).
2. **Notarization**: Apple scans the signed build; Tauri/`tauri-action` can do this when the signing identity,
   certificate and App Store Connect API key (or Apple ID app-specific password) are provided as secrets
   (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`,
   `APPLE_API_KEY`, `APPLE_API_KEY_PATH` …).
3. The ticket is stapled to the app/dmg so it also works offline.

### Linux

`.deb` and AppImage are not signed by the operating system. Integrity can be checked with the SHA-256 sums shown
on the release page (GitHub displays a digest for each asset).

## Preparing for signing later

The release workflow already uses `tauri-apps/tauri-action`, which reads the signing environment variables when
they are present, so signing can be switched on by adding repository secrets and the matching
`tauri.conf.json` settings — the workflow structure does not change. Secrets are only available to the tag-triggered
workflow, never to pull requests.
