# Server Notes & Documentation

Notes keep commands, procedures, READMEs and server-specific documentation beside the terminal of the
connection they belong to. PeachTerm stays terminal-first: the panel is the same auxiliary dock that holds the
SFTP browser (left or right, resizable, collapsible), and nothing is shown for a connection that has no notes.

This is **not** a general document editor, a browser or a knowledge base. There is no command execution from
notes, no sync and no cloud.

## Using it

- **Open**: right-click a saved connection → _Notes & Documentation_ (needs an open tab for that connection), or
  right-click an SSH tab → _Notes & Documentation_. The auxiliary panel gets a **Files | Notes** switch. The switch
  exists only when the connection has notes (or Notes was opened on purpose); otherwise the panel is plain SFTP.
- **Add**: _Add note…_ in the connection menu (works without connecting), or the **+** in the Notes view: new
  Markdown or text note, attach a local file, add a web address, attach an existing note.
- **Indicator**: a quiet document mark beside saved connections that have notes. Connections without notes show
  nothing.
- **List**: with one document it opens at once, with several there is a compact list (arrow keys move, the last
  document is remembered per connection). Documents can be renamed, reordered, attached, detached and deleted.
- **Switching SSH tabs** shows the notes of the selected tab's connection. Typed text is saved (or kept as a draft)
  first; nothing is discarded.

## Document types

| Type                                                | Stored by PeachTerm                        | Editable       | Notes                                                 |
| --------------------------------------------------- | ------------------------------------------ | -------------- | ----------------------------------------------------- |
| Markdown note (internal)                            | the text                                   | yes            | Preview / Edit, autosave                              |
| Text note (internal)                                | the text                                   | yes            | whitespace preserved, monospace                       |
| Linked file `.md` `.markdown` `.txt` `.html` `.htm` | only the path                              | no (read-only) | read from disk when opened; 2 MB limit; never written |
| Web document (HTTPS)                                | only the address (+ optional offline copy) | no             | fetched when opened; Markdown, text, HTML             |

Limits: 1 MB per typed note, 2 MB per linked/fetched/offline document, 100 notes per connection, 1000 in total.

A GitHub file page (`https://github.com/o/r/blob/main/README.md`) is resolved to its raw content address. Nothing else
about GitHub is understood (no repository scraping, no tokens).

## Rendering and the HTML security model

There is **no `innerHTML` anywhere** and no `iframe`/WebView for documents. Every document is turned into a small
closed tree (headings, paragraphs, lists, tables, code blocks, quotes, details, anchors) and rendered by React as ordinary
elements:

- **Markdown**: raw HTML in Markdown is shown as literal text. Images are never loaded (their alt text is shown).
- **HTML**: parsed with `DOMParser` (an inert document: scripts do not run, resources are not fetched), then converted
  with an allow-list. Scripts, styles, forms, inputs, buttons, frames, objects, `svg`, event handlers, inline styles and
  unknown tags are dropped. Original page styling is therefore **not** preserved; structure, tables, code blocks and
  in-page navigation are. Original copy buttons are replaced by PeachTerm's own.
- **Links**: only `http`, `https`, `mailto` and in-page `#anchors` are clickable. A web link opens the system browser
  through a fixed Rust command that validates the address; anything else (`javascript:`, `file:`, `data:`, relative
  paths…) is shown as text.
- **Documents that rely on JavaScript** show their static content only; use _Open in external application_ / _Open
  original in browser_ for the full page.
- Document content has no access to Tauri IPC, the file system, the credential store or the application.

## Copy, never execute

Code blocks have a **Copy** button. It only writes to the clipboard. There is no Execute/Run button and nothing in a
note can send input to a terminal. Be careful with destructive commands (removing VMs, changing routes, deleting
host-key records): you paste and run them yourself.

## Remote documents (Rust, `notes::remote`)

HTTPS only, port 443, no credentials in the address, TLS verification on, no cookies, no `Authorization`, no
environment proxy. Local, private and internal destinations are refused: `localhost`, single-label and `.local`
/`.internal`/… names, loopback, RFC 1918, link-local (including `169.254.169.254`), CGNAT, multicast, documentation,
benchmarking and reserved ranges, IPv4-mapped/6to4/NAT64 IPv6 forms, number-style IP spellings. The host is resolved
by PeachTerm, **every** answer must be public (one private answer refuses the name: that is what DNS rebinding looks
like) and the connection is pinned to exactly those addresses. At most 5 redirects, each one re-validated the same
way (including a redirect to `http:` or to a private host). 20 s total / 8 s connect timeout, 2 MB streaming limit,
only `text/markdown`, `text/plain`, `text/html` (and XHTML) are accepted. Web documents are read-only and are not
stored; there is no background polling.

## Offline copies

_Save offline copy_ downloads the document now and stores it in PeachTerm's data folder (`notes/offline/`). It is
the only way web content is ever stored. When the source cannot be reached, the saved copy is shown and labelled as
such; _Refresh from source_, _Remove offline copy_ and _Open original in browser_ are available. There is no
automatic sync and no expiry: the copy stays until you remove it (or delete the note).

## Sharing

A note attaches to any number of connections and is stored once; editing it changes it everywhere, and the list says
_shared with …_. **Detach from this connection** removes only that attachment. **Delete everywhere…** needs
confirmation. When a connection is deleted its attachments are removed; notes still used elsewhere are untouched and
notes used by nobody are **kept** as unattached notes (reachable through _Attach an existing note…_), never silently
destroyed.

## Zoom

Per document, 50 %–200 % in 10 % steps, with reset and _Fit to width_ (shrinks only when the widest code block or
table overflows). It changes the document only: not the terminal font, not the interface scale. Long commands are not
wrapped; code blocks and tables scroll on their own.

## Storage

```
notes.json              metadata and connection<->note relations (small, atomic)
notes/<id>.txt          text of an internal note
notes/offline/<id>.txt  an explicitly saved offline copy
```

Contents are kept out of `connections.json`. All writes are atomic; content is written before the metadata that
references it, so a crash leaves the old state or the new one (plus, at worst, an unreferenced file that is removed at
the next start, but only after a clean load of the metadata). Invalid or oversized entries in a hand-edited file are
skipped and reported; damaged metadata is kept aside and never causes content to be deleted. Note titles and contents
are never logged.

## Application Lock

Every note command is refused while locked (contents, remote fetches, offline copies, attach/detach, backups). Fetched
content is dropped from the renderer when the lock engages. Unsaved drafts are kept in memory and saved after
unlocking.

## Export, import and backups

See [import-export.md](import-export.md) and [backup-format.md](backup-format.md). In short: the default JSON export
carries no notes; _Include server notes_ is a separate opt-in (with a plain-text warning) and offline copies are a
second opt-in. Encrypted backups can include notes (offered only when notes exist; on by default then); linked files
are always paths only. Nothing is fetched, imported HTML is never executed, existing notes are never overwritten.

## Known limitations

- No full-fidelity HTML: styles, scripts and interactive widgets are not reproduced.
- No images in documents.
- Linked-file paths are machine-specific; restoring on another computer shows them as missing until located.
- Notes are not versioned: there is no history or undo beyond the editor's own.
- A web page that needs login, cookies or JavaScript to show its content cannot be shown.
- Proxy settings of the operating system are not used for fetching documents.
