# Linux Command Help and permission diagnostics

Optional, **off by default** (Settings → Terminal → Linux Command Help). Sub-options: command explanations and
permission error assistance.

## Command explanations

- Offline and deterministic: a curated table in `src/features/help/reference.ts` (read-only commands such as `ls`,
  `df`, `ps`, `ss`, `systemctl status`, `journalctl`, `docker ps`). No model, no network, no telemetry.
- Only text the user explicitly selects is explained (Shift + right-click → _Explain Command_, or the
  `explainSelection` shortcut, default `Mod+Shift+H`). The terminal output is never parsed continuously.
- Pipes, redirects, substitutions, `sudo`, actions such as `find -exec/-delete`, unknown commands and over-long
  text are refused with a neutral message. Options not in the reference are listed as unexplained.
- Examples are reviewed and read-only. **Copy** only puts text on the clipboard; it is never pasted or executed.

## Permission assistance

After an SFTP create / rename / delete / upload fails with "permission denied", a notice offers _Why did this
happen?_. The dialog explains the usual causes cautiously. **Diagnose Permissions** is a separate, explicit click:

- one exec channel on the existing SSH connection (never the terminal), fixed read-only script (`id`, `ls -ld`,
  `namei -l`, `test -w/-x`), no `sudo`, 8 s timeout, 16 KiB output cap;
- the path is passed as a positional argument (`sh -c '<fixed script>' sh '<path>'`) and refused when it holds
  quotes, `!` or control characters;
- the raw output is parsed into bounded fields and discarded; nothing is stored or logged;
- servers that refuse exec channels get a plain explanation; the Application Lock blocks the command.

PeachTerm never changes permissions (`chmod`, `chown`, `sudo`) automatically. Suggested commands are copy-only.

## Limitations

The help setting is global (no per-connection override yet). Mode bits are not the whole story (ACLs, mounts,
SELinux, SFTP chroot), so conclusions are worded as likely, not certain.
