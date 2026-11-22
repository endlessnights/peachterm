# Local terminals

PeachTerm can run a shell on this computer next to its SSH sessions. A tab has an
explicit type: **SSH**, **Local PTY** or **WSL PTY**. SFTP exists only for SSH tabs.

## How it works

- `src-tauri/src/local/profiles.rs` finds the shells that exist and decides how each
  one is started (program + argument vector). The renderer only ever names a profile
  by **id**; it never sends a program or a command line.
- `src-tauri/src/local/session.rs` owns the pseudo-terminal (`portable-pty`: ConPTY on
  Windows, a POSIX PTY elsewhere). Output uses the same pump as SSH: batching,
  flow-control credits, and hold-while-locked. Input is written by a dedicated thread.
- Commands: `local_profiles`, `local_open`, `local_write`, `local_resize`, `local_ack`,
  `local_close`. Each one is refused while the application is locked.

## Profiles

| Platform      | Profiles                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Windows       | Windows PowerShell 5.1 (default fallback), PowerShell 7 (PATH, then Program Files, then WindowsApps), cmd, WSL |
| Linux / macOS | login shell (`$SHELL -l`), zsh, bash, fish (those that exist), `sh` as the last resort                         |
| Any           | custom shells from Settings → Terminal                                                                         |

PowerShell 7 is never assumed to be in one place. WSL distributions come from
`wsl.exe --list --quiet`; nothing is installed or started for detection beyond that.
Docker Desktop's internal distributions are hidden.

## Safety rules

- A WSL distribution is passed as its own argument (`wsl.exe -d <name>`), after the name
  is checked against a plain character set. A start directory is passed as `--cd <dir>`
  (one argument).
- A custom shell needs an **absolute path to an existing file**; its arguments are a fixed
  list. Nothing is run through another shell.
- Terminal input, output, environment and command lines are never logged. Only
  `local.started` / `local.ended` / `local.start_failed` with a session id and the type.
- A restored local tab never starts by itself (not even with "reconnect restored tabs").
- Closing a tab or the application kills the shell and, on Windows, its process tree.
  No `exit` is typed into the shell.

## Settings → Terminal → Local Shell

Default shell, preferred WSL distribution, start directory, a **Refresh profiles**
button and custom shells. All stored in `settings.json` under `terminal`.

## Exit confirmation

Closing the window (button, Alt+F4, taskbar) asks first when something would be lost:
active SSH sessions, local terminals, connections being established, running transfers,
edited files waiting for upload, and unsaved edits in the connection or settings dialog.
**Cancel** is the default. With nothing at stake the application simply closes.
