# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in public issues or discussions.

- Preferred: use GitHub's private vulnerability reporting for this repository
  (Security tab → "Report a vulnerability"), if it is enabled.
- Otherwise contact the maintainer, Bakhti Baymukhamedov, privately via Telegram: <https://t.me/pycarrot2>.
  Please send only a short message asking for a private channel first; share details there.

Include: affected version and platform, what an attacker could do, steps to reproduce, and any
proof of concept. Please do not include real credentials, hostnames or private data.

PeachTerm is maintained by one person in their spare time. No response time or fix schedule is
promised, and no formal security audit has been carried out. Reports are read and handled on a
best-effort basis, and reporters are credited if they wish.

## What is in scope

PeachTerm handles SSH credentials and remote files, so the following matter most:

- Leaking or persisting passwords, key passphrases, terminal content or file contents.
- Bypassing host-key verification, the application lock, or the confirmation required before
  uploading an edited remote file.
- Running commands or opening files the user did not ask for (including through local-shell profiles).
- Vulnerabilities in the IPC boundary between the interface and the Rust backend.

## Supported versions

Only the latest release receives fixes.

## Privacy notes

PeachTerm has no telemetry and no accounts. Credentials are stored in the operating system's keychain.
Logs never contain secrets or terminal content (see [docs/logging.md](docs/logging.md)).
