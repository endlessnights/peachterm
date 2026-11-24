# Encrypted backups (`.peachbackup`)

Settings → **Data & Backup → Encrypted backups** creates a single
password-protected file that can be restored on **Windows, Linux and macOS**.
The format does not depend on DPAPI, the macOS Keychain or the Secret Service:
those are only the _source and destination of individual credentials_.

> **If you lose the backup passphrase, the backup cannot be recovered.**
> PeachTerm never stores it and there is no reset.

## Cryptography

| Purpose              | Choice                                          | Crate (maintained, RustCrypto) |
| -------------------- | ----------------------------------------------- | ------------------------------ |
| Key derivation       | Argon2id v1.3, 32-byte key                      | `argon2` 0.5                   |
| Authenticated cipher | XChaCha20-Poly1305 (192-bit nonce, 128-bit tag) | `chacha20poly1305` 0.10        |
| Randomness           | operating-system CSPRNG (`OsRng`)               | `rand_core` via `argon2`       |
| Passphrase handling  | UTF-8, **Unicode NFC**                          | `unicode-normalization`        |
| Secret hygiene       | `Zeroizing` buffers, redacted `Debug`           | `zeroize`                      |

No custom primitives; no ZIP, Base64, XOR, ECB or fixed keys.

### Argon2id parameters and why

Default: **64 MiB memory, 3 passes, 4 lanes** — RFC 9106 §4's "second
recommended option" for memory-constrained use. It costs a desktop about a
quarter of a second, and an attacker 64 MiB of memory _per guess_, which is the
property that matters for offline guessing. Accepted range when reading a file:
19 MiB–256 MiB, 2–10 passes, 1–16 lanes. **The range is checked on the
untrusted header before any key-derivation memory is allocated**, so a hostile
file cannot request gigabytes. Weaker-than-OWASP-minimum parameters are
refused (no downgrade).

NFC normalisation means a Cyrillic or accented passphrase typed on any
platform or keyboard layout derives the same key.

The application requires a **passphrase of at least 12 characters**
(enforced in Rust). The strength meter is only advice: a few unrelated words
make a good passphrase.

## File layout (format version 1)

All integers are big-endian.

```
offset size  field
     0    8  magic              "PEACHBAK"
     8    2  format version     1
    10    1  KDF id             1 = Argon2id (v1.3)
    11    1  AEAD id            1 = XChaCha20-Poly1305
    12    4  Argon2 memory      KiB
    16    4  Argon2 passes
    20    4  Argon2 lanes
    24   16  salt               random per backup
    40   24  nonce              random per backup
    64    8  ciphertext length  includes the 16-byte tag
    72    n  ciphertext ‖ tag
```

The 72-byte header is the AEAD **associated data**: changing the version,
algorithm ids, KDF parameters, salt, nonce or length makes authentication fail.
The ciphertext must extend exactly to the end of the file (truncation and
appended data are both detected). Unknown magic, versions and algorithm ids are
rejected. Maximum file size 32 MiB.

The header contains **no** host names, user names, profile names, counts or
credentials. (The ciphertext length reveals the approximate amount of data.)

Because the key and tag cover everything, "wrong passphrase" and "modified
file" are indistinguishable by design; the user sees one neutral message.

## Plaintext payload (inside the ciphertext)

UTF-8 JSON, never written to disk unencrypted:

```json
{
  "format": "peachterm-backup-payload",
  "payloadVersion": 1,
  "createdAt": "…",
  "appVersion": "0.1.0",
  "folders": [ … ],
  "connections": [ … ],
  "settings": { … } ,
  "credentialsRequested": true,
  "credentials": [ { "connectionId": "…", "secret": "…" } ]
}
```

Connections use the same field names as the
[connections export](import-export.md) but carry the real ids, timestamps and
key-file paths (the file is encrypted). Payload and document are validated by
the same code on restore.

### Server notes (payload version 2)

With "Include Server Notes" (offered only when notes exist, on by default then) the payload gains a `notes` list and
`payloadVersion` becomes **2**. A backup made without notes stays at version **1**, so older PeachTerm versions can
still restore it; a version-2 backup opened by an older PeachTerm is refused with the standard "newer version"
message instead of silently dropping the notes. A version-1 payload is never searched for notes, whatever it contains.

```json
"notes": [
  { "id": "…", "title": "Proxmox VPS Commands", "kind": "internal", "format": "markdown", "zoom": 100,
    "createdAt": 1, "updatedAt": 2, "connections": ["<local connection id>", "…"],
    "content": "…" },
  { "kind": "localFile", "source": "C:\\docs\\guide.html", "format": "html", "…": "…" },
  { "kind": "remoteUrl", "source": "https://…/README.md", "snapshot": "…", "snapshotSavedAt": 3, "…": "…" }
]
```

Included: typed notes with their text, titles and metadata, the one-to-many relations, web addresses, **saved offline
copies**, and the **paths** of linked local files. **Not** included: the contents of linked local files (they were never
copied into PeachTerm), anything fetched from the network (nothing is fetched while backing up). The result screen
reports the numbers (notes, offline copies, linked files as paths only).

Restore (opt-in checkbox, on by default when the backup has notes) **only adds**: a note whose id already exists keeps
its content and only gains attachments to the connections restored in this run; nothing is overwritten and the preview
counts such conflicts. A note is attached only to connections that took part (a "selected profiles" restore never
attaches a note to an unrelated connection; notes whose connections were all left out are skipped). A skipped duplicate
profile counts as taking part through the existing profile it matched. In Replace mode the notes of connections that
disappear stay as unattached notes. The restore preview shows counts only (notes, linked files, web documents, offline
copies, shared notes, linked files missing on this computer, conflicts), never titles or content.

Atomicity: notes are applied as the last step (after connections and settings). New content files are written first and
`notes.json` last in one atomic replace; if any of it fails, the new files are removed and settings, connections and
saved passwords are put back, so the result is the previous state. Existing notes are never modified by a restore, so a
failure cannot destroy them.

### Always included

Connections, folders, ordering, per-connection preferences, and — if ticked,
default on — portable application settings: general, appearance (themes,
accent, terminal font and palette), SSH and SFTP defaults, keyboard shortcuts,
logging level/retention, window layout.

### Optional (default **off**)

"Include saved passwords and SSH key passphrases". Values are read from the OS
credential store through the existing abstraction. Anything that cannot be read
(store unavailable, read error, flagged but missing) is **skipped and counted**;
the result screen says exactly how many were included and how many were not, and
never claims otherwise.

### Never included

SSH private keys and key files (only the _path_ is stored), Application Lock
data, session-only upload permissions, SSH sessions, scrollback, transfers,
editor temp copies, logs, host keys, OS credential-database blobs, and
**anything that could run code**: the external-editor program and arguments,
custom local shell profiles, WSL/start-directory settings and custom log
folders are deliberately **not** portable, so a backup can never plant an
executable.

## Creating a backup

1. Choose data; 2. enter the passphrase twice (show/hide, strength advice,
   loss warning); 3. choose a destination (native dialog, opened by Rust);
2. encrypt.

Everything cryptographic happens in Rust. The file is written to a hidden temp
file next to the destination (exclusive create, owner-only on Unix), **read
back and decrypted to prove it is valid**, and only then renamed to its final
name. A failure at any point removes the temp file; no plaintext is ever
written. The passphrase is wiped from the UI state as soon as it is sent.

## Restoring

1. Select the file — the structure and size are checked, nothing trusted yet.
2. Enter the passphrase — authentication and decryption happen in Rust. Wrong
   passphrase, corruption, truncation, tampering and unsupported versions each
   produce a short message without implementation details. After 10 wrong
   attempts the staged file is dropped.
3. **Redacted preview** — counts, profile names/hosts for choosing, conflicts,
   missing key files. **No credential value ever reaches the renderer.**
4. Choose the mode:
   - **Merge** (default): add to existing; duplicates follow skip / copy /
     update, exactly as in [JSON import](import-export.md).
   - **Restore selected profiles** only.
   - **Replace existing configuration**: explicit confirmation required. A
     copy of `connections.json` is kept (`connections.json.pre-restore-<time>`,
     newest three retained) and the saved passwords of connections that no
     longer exist are removed.
5. Settings: restore application settings (off by default in merge).
6. Credentials (only if the backup has them; default **off**): choose
   _Keep existing_ (default), _Replace_ (needs an extra confirmation) or _Skip_.
   New entries are created in **this** computer's credential store under
   handles derived from the final local ids; source-machine handles are never
   reused. If the credential store is unavailable the restore is refused
   before anything changes — there is **no plaintext fallback**.
7. Result: created, copied, updated, skipped and failed counts, credential
   counts, warnings. Nothing connects automatically.

Nothing is deleted or modified before the whole backup is decrypted, parsed and
validated, and the new state is computed in memory.

### Failure handling — what is and is not atomic

OS credential stores have no transactions and cannot be committed together with
JSON files, so PeachTerm does **not** claim cross-store atomicity. Instead:

1. Plan (pure, in memory). Errors here change nothing.
2. Write credentials one by one, remembering each previous value. A single
   credential that cannot be written is reported as _failed_ and does not abort
   the restore; its profile will simply ask for the password.
3. Replace `connections.json` in one atomic file write — only if it is still
   exactly what the plan was built from.
4. Replace `settings.json` in one atomic file write.

If step 3 or 4 fails, every credential written in step 2 is put back to its
previous value (or deleted if it did not exist) and, after step 4, the
connections are reverted too. If a _compensating_ action itself fails, the error
states how many entries could not be put back. Each file is always entirely old
or entirely new.

Security rule in Replace and Update: a stored password stays attached to a
profile only while host, port and user name are unchanged; otherwise it would
be sent to a different server.

## Cross-platform migration

A backup made on Windows restores on Linux or macOS and vice versa. Passwords
are re-created in the destination's own credential store (Credential Manager,
Keychain or Secret Service). **SSH key files are not in the backup**: copy the
key files yourself and re-select them; the restore preview lists key paths that
do not exist on the new computer. Paths are stored as written, so a Windows
path will not exist on Linux.

## Limits and honest caveats

- Security rests on the passphrase. Backups are offline-attackable; use a long
  random passphrase. There is no recovery path.
- A backup that includes passwords is as sensitive as the passwords. **Do not
  put credential-containing backups in public Git repositories**, public cloud
  folders or chat attachments.
- Zeroisation is best effort: Rust frees buffers it controls, but the
  allocator, JSON parsing and the OS can leave copies in memory or swap that
  PeachTerm cannot wipe.
- The ciphertext length leaks roughly how large the configuration is.
- Locking the application discards any staged (decrypted) restore; all
  commands refuse while locked.

## Versioning

`formatVersion` changes only for incompatible envelope changes; `payloadVersion`
for the inner document (1 = profiles, settings, credentials; 2 = additionally server notes). A file with a higher version is refused with an
upgrade message. Test fixtures for old versions live in
`src-tauri/tests/fixtures/` and must keep opening.
