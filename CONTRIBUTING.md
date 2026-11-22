# Contributing to PeachTerm

Thank you for helping. PeachTerm is a small, security-minded desktop application;
careful, focused changes are the most useful ones.

## Reporting bugs

Open an issue at <https://github.com/endlessnights/peachterm/issues> with:

- PeachTerm version (Settings → About), operating system and version.
- What you did, what you expected, what happened.
- Relevant lines from the diagnostic log if you can share them (Settings → Diagnostics → Export).
  The export is designed not to contain passwords, keys, terminal content or file contents —
  still, read it before attaching it.

**Do not report security problems in public issues.** See [SECURITY.md](SECURITY.md).

## Pull requests

1. Open an issue first for anything larger than a small fix, so the direction can be agreed.
2. Fork, branch from `main`, keep the change focused (one topic per pull request).
3. Run the full check before pushing:

   ```bash
   npm ci
   npm run check
   ```

   It runs formatting, lint, TypeScript, the frontend tests, `cargo fmt`, `cargo clippy -D warnings`
   and the Rust tests. CI runs the same on Windows, Linux and macOS.

4. Add or update tests for behaviour you change. Do not disable or weaken existing tests.
5. Describe what changed and why; mention anything you could not test (for example a platform).

## Code style

- TypeScript: strict, formatted with Prettier, linted with ESLint (`npm run format`, `npm run lint`).
- Rust: `cargo fmt`, no `unsafe` (the crate denies it; the single Windows title-bar exception is documented),
  clippy clean.
- Keep the UI minimal and consistent with all themes (Dark, Light, Industrial Olive, Source Gray).
- Security-relevant rules are enforced by tests (for example every IPC command must check the application
  lock, and logging uses a closed vocabulary). Read [docs/architecture.md](docs/architecture.md) before
  changing those areas.
- Never log, persist or send passwords, key passphrases, terminal input/output or file contents.
- No telemetry and no network access other than what the user asks for (SSH/SFTP).

## Licensing of contributions

PeachTerm is licensed under the [Apache License 2.0](LICENSE). Unless you explicitly state otherwise,
any contribution you intentionally submit for inclusion in the project is submitted under the terms of
that license (Apache-2.0, section 5), without additional terms or conditions.

You keep the copyright in your contribution; there is no copyright assignment. Only submit code you wrote
or that you have the right to submit under Apache-2.0, and keep the copyright and license notices of any
third-party code you include.

New source files should start with:

```
Copyright 2026 Bakhti Baymukhamedov
SPDX-License-Identifier: Apache-2.0
```

(or your own copyright line, if you prefer; do not remove or replace existing notices).
