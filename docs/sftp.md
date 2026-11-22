# Integrated SFTP

SFTP uses a **second channel on the already authenticated SSH transport** of the
tab (no extra login, no extra connection). It is started right after the shell
(`sftp::init`) and announced to the UI with the `sftp` terminal event
(`pending` → `ready` | `unavailable`). A server that refuses the subsystem, or a
failed SFTP handshake, only makes the panel say so: the terminal is never
disconnected by SFTP trouble.

No FTP, FTPS or WebDAV are implemented.

## Browsing and file operations (`src-tauri/src/sftp/ops.rs`)

- Listing returns name, canonical path, kind (file / directory / symlink /
  other, plus whether a symlink points to a directory), size, mtime and
  permission bits. Sorting and the hidden-file filter live in the UI
  (`features/sftp/model.ts`): directories first, natural order, by name / size /
  time. The "show hidden files" choice is saved in `settings.sftp.showHidden`.
- Create folder, rename (same directory only, never replaces an existing item),
  delete (files, symlinks — the link itself, never the target — and directory
  trees, bounded by depth and item count). Deleting `/`, empty or relative
  paths is refused. The UI always asks for confirmation unless the user turned
  `confirmDelete` off in the settings.
- Paths from the renderer are validated in Rust (length, no control
  characters); new names must be a single path component.

## Transfers (`transfer.rs`)

Local paths never come from the renderer. Rust opens the native save / open
dialog; for uploads the renderer only receives names and sizes plus a
single-use opaque id (`sftp_pick_upload` → `sftp_upload`). Progress, completion,
failure and cancellation stream over a `Channel`; the panel shows one row per
transfer with a cancel button.

- Downloads go to a `.part` file next to the destination and are renamed on
  success; failed or cancelled downloads leave nothing at the destination.
- Uploads never replace an existing file unless the user confirmed it.
- Every upload writes a temporary file in the same remote directory first
  (`put.rs`).

## Safe remote write (`put.rs`)

1. write `.<name>.peachterm-XXXXXXXX.part` next to the target (created private);
2. copy the target's permission bits onto it;
3. re-check the remote file (conflict detection, see the editor docs);
4. move it over the target:
   - `posix-rename@openssh.com` available → atomic replacement (`atomic: true`);
   - otherwise: old file renamed aside → new file renamed in → old file removed,
     restored if the second step fails (`atomic: false` — reported as such, never
     claimed to be atomic).

A failed or cancelled write removes the temporary file and leaves the target
untouched. Limits that are **not** claimed: owner/group of the file may change
when the server creates a new inode, hard links and ACLs are not preserved.
Symlinks are resolved first so the link is kept and its target replaced.

## New file, new folder, menus

Right-click on **empty space** in the listing for _New File…_, _New Folder…_ and
_Refresh_; right-click on an item for its own actions (open / open in editor,
download, rename, copy path, delete). The empty-area menu never acts on a
previously selected item (the selection is cleared). Without a mouse: the
**+** toolbar button opens the same New File / New Folder menu, and the
context-menu key or `Shift+F10` opens the menu for the selected item, or the
folder menu when nothing is selected.

The name dialog states where the item will be created (the directory shown when
the dialog opened) and refuses empty names, `.`, `..`, names containing `/`,
control characters, names over 255 bytes and names that already exist, before
anything is sent. Rust validates again. **New File** creates a zero-byte file with
an exclusive SFTP open (`sftp_create_file`); it can never replace an existing file,
directory or link, and Unicode names are sent unchanged. Server errors (permission
denied, a name taken in the meantime) are shown as they are. No shell command is
ever used. The new item is selected after the listing refreshes.

## Panel

One panel for the workspace, beside the terminals (it shows the focused session's files; see [workspace.md](workspace.md)). Dock left or right, drag the splitter (or use the
arrow keys on it) to resize, collapse to a thin button. Side and width are saved
in `settings.ui` and collapse state in `settings.sftp.defaultVisible`, so they
survive a restart. Context menu: open / open in editor, download, rename, copy
path, delete.

## Tests

`src-tauri/src/sftp/integration_tests.rs` runs the real client over a real SSH
transport against an in-process SFTP server (`ssh/testsftp.rs`) rooted in a
temporary directory: browsing, validation, mkdir/rename/delete, uploads
(create, replace, with and without posix-rename, permissions on Unix),
interrupted and cancelled writes, remote-change detection, downloads, batch
uploads, a server without SFTP, and operations after the session ended.
Frontend behaviour is covered by `features/sftp/*.test.ts(x)`.
