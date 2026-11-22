# Saved connections: folders, ordering and bulk operations

## Model

- Folders and connections have **stable UUIDs**; every operation (rename, move,
  reorder, delete) refers to them by id, never by name or array position.
- A folder's `parentId` / a connection's `folderId` is the only thing a move
  changes, plus `sortOrder` (manual position among siblings; equal values fall
  back to natural name order, so files written before ordering existed look
  exactly as before).
- Folders are listed before connections at every level; each group is ordered
  independently.
- A move never touches host, port, user, authentication, key path, timeout,
  initial directory or the saved-password flag (covered by tests).

## Folder depth

At most **three folder levels** (children of the root are level 1; the root is
not a level):

```text
Folder
└── Subfolder
    └── Subfolder
        ├── Server A
        └── Server B
```

- Connections may live in a folder at any level.
- The rule is enforced in Rust for creating folders, re-parenting and moving
  whole subtrees (`storage/tree_ops.rs`); the renderer mirrors it
  (`features/connections/treeOps.ts`) only to show drop feedback early.
- A cycle (a folder into itself or its own descendants) is refused.
- Refused moves explain why ("Folders can be nested at most 3 levels deep. Moving
  “X” here would put its contents at level 4.") in the drag status line / a
  notice, and change nothing.
- **Legacy data is never truncated, deleted or relocated.** If an old file
  contains deeper nesting, the sidebar shows a notice. A move is allowed as long as
  it does not make a folder _deeper than it already is_, so such a subtree can be
  flattened step by step (drag, or right-click → _Move to…_).
- Dangling parent references and cycles found in a file are repaired on load by
  moving the affected items to the top level (nothing is deleted; the original
  file is kept as `connections.json.corrupt-<time>`).

## Interaction

| Action               | How                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select               | Click; **Ctrl/Cmd+Click** toggles; **Shift+Click** selects a range; **Ctrl+A** selects the siblings in the focused folder/list (press again for everything); arrows / Home / End move, **Shift+arrows** extends                                                                 |
| Rename inline        | **F2** (configurable) or context menu → _Rename_. Enter confirms, Esc cancels, an invalid or empty name keeps the editor open and the stored name unchanged; leaving the field saves a valid change and otherwise discards it. Only the display name changes; saved immediately |
| Move                 | Drag selected rows onto a folder (into), between rows (reorder), or the empty area (top level). Hover a collapsed folder to open it. The list auto-scrolls while dragging                                                                                                       |
| Move without a mouse | Right-click → _Move to…_ (destination list; invalid destinations are disabled with the reason), **Alt+↑ / Alt+↓** reorder                                                                                                                                                       |
| Delete               | **Delete** key or context menu → _Delete…_                                                                                                                                                                                                                                      |

Drag-and-drop is disabled while a search filter is active (the order would be
ambiguous).

## Deleting

One consolidated confirmation, whatever the number of items:

- it states how many connections and folders are selected and what will be
  deleted, with counts computed by the backend (`tree_delete_preview`);
- for folders you choose between **keeping their contents** (moved to the
  nearest surviving parent — the default) and deleting everything inside;
- only the saved passwords of connections that are actually deleted are removed
  from the OS keychain, one account each; other credentials and files are never
  touched;
- open tabs are **not** closed: deleting a saved entry does not disconnect a
  running session (the dialog says so), and "Cancel" has initial focus;
- the whole change is applied atomically and persisted in one write.

## Persistence and migration

`connections.json` is version 2 (adds `sortOrder`). A version-1 file loads
unchanged; before it can be rewritten, a copy is kept as
`connections.json.pre-v1-<time>`. Writes are atomic (temp file + rename), and a
failed operation leaves both memory and file untouched.
