# SSH tunnels (local port forwarding)

PeachTerm can forward a local TCP port through an SSH connection, like `ssh -N -L 8080:127.0.0.1:3000 user@server`,
so private services on (or reachable from) the server can be used without publishing them. Scope for v0.3.0:
**local forwarding (`-L`) only**; remote (`-R`), dynamic SOCKS (`-D`) and jump hosts are not implemented (the saved
definition has a `kind` field so they can be added later without a format change).

## Using it

Right-click an SSH tab → **SSH Tunnels…**. The dialog lists the tunnels saved for that connection with their local
endpoint, remote destination and state, and offers Add, Start/Stop, Edit, Delete, Copy Local Address and (for a
running tunnel to a web-like port) Open in Browser — always an explicit click.

- **Local bind address**: `127.0.0.1` (default) or `::1`. Nothing else is accepted: not `0.0.0.0`, not `::`, not a
  LAN address. LAN/public exposure would need its own design and review.
- **Remote destination** is reached **from the SSH server**: `127.0.0.1` means the server's own loopback, not your
  computer. IPv4, IPv6 and host names are accepted; ports 1–65535. Docker container names are not resolved by PeachTerm
  (use `127.0.0.1:<published port>` or a bridge IP the server can reach).
- **Start automatically when SSH connects** is off by default. Running state is never saved.
- The requested local port is used exactly as typed. If it is taken, PeachTerm says so; it never picks another one.

Example (Grafana published only on the server's loopback, `ports: ["127.0.0.1:3000:3000"]`): local `127.0.0.1:8080`
→ remote `127.0.0.1:3000`, then open `http://127.0.0.1:8080`.

### States

| State                  | Meaning                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Stopped                | not running                                                                                                                     |
| Starting               | being set up                                                                                                                    |
| **Listening**          | the local socket is bound. It does **not** mean the remote service answers (see the message under the row for the last failure) |
| Connection unavailable | the SSH connection that carries it is gone or not ready                                                                         |
| Error                  | the listener itself failed                                                                                                      |

## Ownership and lifecycle

- A tunnel runs on **one SSH session (one tab's transport)**. Every accepted local connection opens its own
  `direct-tcpip` channel on that already-authenticated transport (`russh`), so there is no second login and the shell
  and SFTP channels are never touched. Opening, failing or closing a forward does not affect them.
- When that session ends — the tab is closed, the connection drops, the server disconnects, PeachTerm exits or an
  update is installed — **its tunnels are stopped and their ports released**. Nothing re-connects or re-authenticates
  behind the user's back; reconnecting a tab creates a new session and tunnels start again only if marked
  _start automatically_ (or by hand).
- Moving a tab into Split View, switching tabs, switching themes or minimising does not touch tunnels (they live in
  the backend session, not in the tab layout).
- One listener per local endpoint: starting the same tunnel twice, or two tunnels on the same endpoint, is refused with
  an explanation. If another tab of the same connection already runs it, the list shows "(in another tab)" and it
  must be stopped there first. Saved tunnels cannot share a local endpoint either.
- Deleting a saved connection deletes its tunnel definitions and stops its running tunnels.
- Up to 128 simultaneous forwarded connections per tunnel; further ones are refused.

## Application Lock policy

While PeachTerm is locked:

- tunnels cannot be created, edited, deleted or started (every tunnel command is refused; only a bare "how many are
  running" count stays available so quitting still warns);
- **no new forwarded connection is accepted** — the local socket is closed immediately and nothing is sent to the
  server;
- streams that were **already open keep running until they end by themselves** (they carry data between two programs
  and expose nothing of PeachTerm). Locking does not stop a running tunnel's listener; it simply refuses new
  connections, and new connections work again after unlocking. If you need a hard stop, stop the tunnel before locking.

## Data handling and security

- Saved definitions (`tunnels.json`) contain names, addresses and ports only: **no credentials**, no running state.
  Definitions read from disk are re-validated (a hand-edited non-loopback bind address is dropped).
- Forwarded payload bytes are never logged; logs carry fixed event names only.
- The SSH server must allow forwarding (`AllowTcpForwarding`). If it refuses, the row says so; PeachTerm does not try
  to bypass it. Host-key verification is unchanged.
- Tunnel definitions are **not** part of connection export/import or `.peachbackup` backups in v0.3.0.

## Implementation notes and limits

- Bounded memory: one 32 KiB buffer per direction per connection; a stalled peer applies backpressure.
- Half-close (`EOF`) is propagated in both directions; closing either side ends the forward.
- All tasks of a tunnel are owned by its accept loop and are cancelled when it stops (no leaked tasks or sockets).
- **Known limitation (russh):** the SSH library delivers all channels of one connection through a single loop and
  acknowledges data when it arrives. A local program that stops reading a forwarded connection for a long time can
  therefore make the other traffic of the same SSH connection (including the shell) wait until it reads again.
- The in-process tests use `russh` on both ends. Several concurrent full-duplex bulk streams can wedge such a pair
  (two russh loops writing at each other), so the test server advertises a small window (128 KiB), and the large
  transfers are checked one direction at a time with many clients, plus full duplex with one large stream and with
  many small ones (20 consecutive runs without a failure). This was not reproduced or tested against OpenSSH;
  verify heavy simultaneous two-way transfers against a real server.
