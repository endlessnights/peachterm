# Live Server Resource Monitor

A small, optional, agentless readout of CPU, RAM, disk and uptime of the Linux server behind the active SSH tab.
**Live display only**: nothing is stored, logged, exported or sent anywhere. No agent is installed on the server, and
there is no history, alerting or dashboard.

## Using it

- **Settings → SSH → Server Monitoring**: _Show server resource usage_ (off by default), refresh every 5 / 10 / 30
  seconds (default 10), and which metrics to show (CPU, RAM, Disk /, Uptime).
- **Per connection**: in the connection editor, _Server monitoring_ = use the global setting / enabled / disabled.
  This lets you watch a Proxmox host without enabling it for every connection.
- The readout sits in the status bar (turn the status bar off in Settings and monitoring stops with it):
  `CPU 18%  RAM 39.2 / 62.7 GiB  Disk / 72%  Up 12d 8h`. Click it for details (load average, available memory,
  root filesystem usage, long uptime, "last updated").
- In Split View the readout follows the focused pane / active tab; every tab has its own SSH transport and its own
  readings, so servers are never mixed up.

## How it works

Each connected SSH session gets at most one poller in Rust (`monitor`). A poll opens a short-lived **exec channel** on
the session's already authenticated transport and runs one fixed, read-only command:

```
sh -c 'LC_ALL=C; export LC_ALL; echo @@stat; head -n 1 /proc/stat; echo @@load; head -n 1 /proc/loadavg;
       echo @@mem; grep -e MemTotal: -e MemAvailable: /proc/meminfo; echo @@up; head -n 1 /proc/uptime;
       echo @@df; df -P -k /'
```

Only the sections of enabled metrics are requested. Nothing is typed into your interactive shell, no PTY is used, no
extra login or credentials are involved, host-key verification is unchanged, no `sudo`, nothing is written on the
server. It needs only the standard Linux `/proc` files, `head`, `grep`, `df` and a POSIX `sh`: an ordinary account is
enough; Debian, Ubuntu, other modern Linux distributions, Proxmox VE hosts, VMs and containers with SSH work.
Windows, BSD, macOS and network appliances are out of scope and show "Monitoring unavailable".

Safety: polls never overlap, have an 8 s timeout and a 16 KiB output limit, the channel is always closed (also after a
timeout), failures back off exponentially (up to 2 minutes) and are reported once rather than repeatedly. A server
without usable `/proc` data is reported as unsupported after two empty runs and polling stops. Output is untrusted:
it is parsed in Rust and only validated numbers reach the UI (remote text is never shown).

## What the numbers mean

- **CPU** — total utilisation across all cores between two successive samples of the aggregate `cpu` line of
  `/proc/stat`: `busy = user + nice + system + irq + softirq + steal`, `idle = idle + iowait`,
  `usage = Δbusy / (Δbusy + Δidle)`. `guest` and `guest_nice` are not added again (the kernel already counts them in
  `user`/`nice`). The first reading shows `—` because there is no baseline; a counter reset or hotplug, or a zero
  time delta, also shows `—` and starts a new baseline. It is **not** the load average; load (1/5/15 min) is shown
  separately in the details and is never presented as a percentage.
- **RAM** — `used = MemTotal − MemAvailable`, so reclaimable page cache is not counted as used. Binary units (KiB,
  MiB, GiB, TiB) throughout. Missing or invalid values show `N/A`.
- **Disk /** — the **root filesystem only** (`df -P -k /`), with the percentage `used / (used + available)` as `df`
  computes it. It is not total physical disk usage, and on Proxmox hosts it does not represent VM storage, LVM-thin
  or ZFS pools. Multiple mount points and storage backends are future work.
- **Uptime** — of the server (`/proc/uptime`), not of the SSH session.

## Locking, sessions and other features

- **Application Lock**: `monitor_start` is lock-guarded; while locked the poller sends no command, delivers nothing and
  drops its CPU baseline; a poll finishing during the lock is discarded. The renderer clears all readings as soon as
  the lock engages. After unlocking monitoring restarts with a fresh baseline (no stale values shown as current).
- **Reconnect / disconnect**: readings are keyed by backend session id; ending the session ends its poller, and a
  reconnect (new session) starts empty.
- **SFTP, tunnels, shell**: monitoring uses its own exec channel; it does not touch the shell, the SFTP subsystem or
  forwarded connections, and a hanging poll cannot block the terminal.
- Moving a tab between Split View panes does not restart anything (the poller belongs to the session).

## Privacy

Readings exist only in memory (Rust) and in the renderer state. They are not part of settings, `connections.json`,
JSON export, `.peachbackup` backups, diagnostic bundles or logs, and no log line contains them (a unit test checks that
the module has no file or logging calls). Only the preferences (enabled, interval, visible metrics, per-connection
choice) are saved; the per-connection choice is a local preference and is not part of connection export/import.
