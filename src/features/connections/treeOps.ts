// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Pure structural operations on the connection tree. The Rust backend is
// authoritative (and re-validates everything); this mirror gives instant drop
// feedback in the sidebar and powers the in-memory dev backend and tests.
//
// Folder depth: at most MAX_FOLDER_DEPTH levels (children of the root are
// level 1). Legacy data that is deeper is preserved, and a move is allowed as
// long as it does not make a folder deeper than it already is.

import type {
  Connection,
  ConnectionTree,
  DeletePlan,
  Folder,
  FolderDeleteMode,
  ItemRef,
  Uuid,
} from '../../shared/types';

export const MAX_FOLDER_DEPTH = 3;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const itemKey = (item: ItemRef): string =>
  `${item.kind === 'folder' ? 'f' : 'c'}:${item.id}`;

export function parseKey(key: string): ItemRef {
  const [prefix, ...rest] = key.split(':');
  return { kind: prefix === 'f' ? 'folder' : 'connection', id: rest.join(':') };
}

export const folderRef = (id: Uuid): ItemRef => ({ kind: 'folder', id });
export const connectionRef = (id: Uuid): ItemRef => ({ kind: 'connection', id });

export const compareSiblings = (
  a: { sortOrder: number; name: string },
  b: { sortOrder: number; name: string },
) => a.sortOrder - b.sortOrder || collator.compare(a.name, b.name);

const folderOf = (tree: ConnectionTree, id: Uuid) => tree.folders.find((f) => f.id === id);

export function folderLevel(tree: ConnectionTree, id: Uuid): number {
  let level = 0;
  const seen = new Set<Uuid>();
  let cursor: Uuid | null = id;
  while (cursor && !seen.has(cursor) && folderOf(tree, cursor)) {
    seen.add(cursor);
    level += 1;
    cursor = folderOf(tree, cursor)!.parentId;
  }
  return level;
}

export function subtreeHeight(tree: ConnectionTree, id: Uuid, seen = new Set<Uuid>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const children = tree.folders.filter((f) => f.parentId === id);
  return 1 + Math.max(0, ...children.map((f) => subtreeHeight(tree, f.id, seen)));
}

/** Is `node` equal to `root` or inside its subtree? */
export function inSubtree(tree: ConnectionTree, node: Uuid | null, root: Uuid): boolean {
  const seen = new Set<Uuid>();
  let cursor = node;
  while (cursor && !seen.has(cursor)) {
    if (cursor === root) return true;
    seen.add(cursor);
    cursor = folderOf(tree, cursor)?.parentId ?? null;
  }
  return false;
}

export function tooDeepFolders(tree: ConnectionTree): Uuid[] {
  return tree.folders.filter((f) => folderLevel(tree, f.id) > MAX_FOLDER_DEPTH).map((f) => f.id);
}

export function sortedChildren(
  tree: ConnectionTree,
  parent: Uuid | null,
  kind: ItemRef['kind'],
): ItemRef[] {
  if (kind === 'folder') {
    return tree.folders
      .filter((f) => f.parentId === parent)
      .sort(compareSiblings)
      .map((f) => folderRef(f.id));
  }
  return tree.connections
    .filter((c) => c.folderId === parent)
    .sort(compareSiblings)
    .map((c) => connectionRef(c.id));
}

const parentOf = (tree: ConnectionTree, item: ItemRef): Uuid | null =>
  item.kind === 'folder'
    ? (folderOf(tree, item.id)?.parentId ?? null)
    : (tree.connections.find((c) => c.id === item.id)?.folderId ?? null);

const exists = (tree: ConnectionTree, item: ItemRef) =>
  item.kind === 'folder'
    ? !!folderOf(tree, item.id)
    : tree.connections.some((c) => c.id === item.id);

/** De-duplicate and (for moves) drop items that travel with a selected ancestor. */
export function normalizeItems(
  tree: ConnectionTree,
  items: ItemRef[],
  pruneDescendants: boolean,
): ItemRef[] {
  const seen = new Set<string>();
  const unique = items.filter((i) => !seen.has(itemKey(i)) && seen.add(itemKey(i)));
  if (!pruneDescendants) return unique;
  const selectedFolders = new Set(unique.filter((i) => i.kind === 'folder').map((i) => i.id));
  return unique.filter((item) => {
    const guard = new Set<Uuid>();
    let cursor = parentOf(tree, item);
    while (cursor && !guard.has(cursor)) {
      if (selectedFolders.has(cursor)) return false;
      guard.add(cursor);
      cursor = folderOf(tree, cursor)?.parentId ?? null;
    }
    return true;
  });
}

/** `null` when the move is allowed, otherwise the explanation shown to the user. */
export function validateMove(
  tree: ConnectionTree,
  items: ItemRef[],
  target: Uuid | null,
): string | null {
  if (target && !folderOf(tree, target)) return 'The destination folder no longer exists.';
  const list = normalizeItems(tree, items, true);
  if (list.some((i) => !exists(tree, i))) return 'An item no longer exists.';
  const targetLevel = target ? folderLevel(tree, target) : 0;
  for (const item of list) {
    if (item.kind !== 'folder') continue;
    if (target && inSubtree(tree, target, item.id)) {
      return 'A folder cannot be moved into itself or one of its own sub-folders.';
    }
    const height = subtreeHeight(tree, item.id);
    const reaches = targetLevel + height;
    const currently = folderLevel(tree, item.id) + height - 1;
    if (reaches > MAX_FOLDER_DEPTH && reaches > currently) {
      const name = folderOf(tree, item.id)?.name ?? '';
      return `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep. Moving “${name}” here would put its contents at level ${reaches}.`;
    }
  }
  return null;
}

/** Pure move; throws the validation message. */
export function moveItems(
  tree: ConnectionTree,
  items: ItemRef[],
  target: Uuid | null,
  before: ItemRef | null,
): ConnectionTree {
  const problem = validateMove(tree, items, target);
  if (problem) throw { code: 'validation', message: problem };
  const list = normalizeItems(tree, items, true);
  const next: ConnectionTree = structuredClone(tree);
  const moved = new Set(list.map(itemKey));
  for (const item of list) {
    if (item.kind === 'connection') {
      next.connections.find((c) => c.id === item.id)!.folderId = target;
    } else {
      next.folders.find((f) => f.id === item.id)!.parentId = target;
    }
  }
  for (const kind of ['folder', 'connection'] as const) {
    const moving = list.filter((i) => i.kind === kind);
    if (moving.length === 0) continue;
    const order = sortedChildren(next, target, kind).filter((i) => !moved.has(itemKey(i)));
    const anchor =
      before && before.kind === kind && !moved.has(itemKey(before))
        ? order.findIndex((i) => itemKey(i) === itemKey(before))
        : -1;
    order.splice(anchor >= 0 ? anchor : order.length, 0, ...moving);
    renumber(next, order);
  }
  return next;
}

function renumber(tree: ConnectionTree, order: ItemRef[]) {
  order.forEach((item, index) => {
    if (item.kind === 'connection') {
      const c = tree.connections.find((x) => x.id === item.id);
      if (c) c.sortOrder = index;
    } else {
      const f = tree.folders.find((x) => x.id === item.id);
      if (f) f.sortOrder = index;
    }
  });
}

export function subtreeIds(tree: ConnectionTree, root: Uuid): Set<Uuid> {
  return new Set(tree.folders.filter((f) => inSubtree(tree, f.id, root)).map((f) => f.id));
}

export function planDelete(
  tree: ConnectionTree,
  items: ItemRef[],
  mode: FolderDeleteMode,
): DeletePlan {
  const list = normalizeItems(tree, items, false);
  const selectedFolders = list.filter((i) => i.kind === 'folder').map((i) => i.id);
  const doomedFolders = new Set<Uuid>();
  if (mode === 'deleteContents') {
    selectedFolders.forEach((id) => subtreeIds(tree, id).forEach((x) => doomedFolders.add(x)));
  } else {
    selectedFolders.forEach((id) => doomedFolders.add(id));
  }
  const doomedConnections = new Set(list.filter((i) => i.kind === 'connection').map((i) => i.id));
  if (mode === 'deleteContents') {
    tree.connections
      .filter((c) => c.folderId && doomedFolders.has(c.folderId))
      .forEach((c) => doomedConnections.add(c.id));
  }
  const movedConnections = tree.connections.filter(
    (c) => !doomedConnections.has(c.id) && c.folderId && doomedFolders.has(c.folderId),
  ).length;
  const movedFolders = tree.folders.filter(
    (f) => !doomedFolders.has(f.id) && f.parentId && doomedFolders.has(f.parentId),
  ).length;
  return {
    connectionIds: [...doomedConnections].sort(),
    folderIds: [...doomedFolders].sort(),
    movedConnections,
    movedFolders,
  };
}

export function deleteItems(
  tree: ConnectionTree,
  items: ItemRef[],
  mode: FolderDeleteMode,
): { tree: ConnectionTree; plan: DeletePlan } {
  const plan = planDelete(tree, items, mode);
  const doomedF = new Set(plan.folderIds);
  const doomedC = new Set(plan.connectionIds);
  const next: ConnectionTree = structuredClone(tree);
  const survivor = (parent: Uuid | null) => {
    const guard = new Set<Uuid>();
    let cursor = parent;
    while (cursor && doomedF.has(cursor) && !guard.has(cursor)) {
      guard.add(cursor);
      cursor = folderOf(tree, cursor)?.parentId ?? null;
    }
    return cursor;
  };
  const relocated: ItemRef[] = [];
  for (const c of next.connections) {
    if (!doomedC.has(c.id) && c.folderId && doomedF.has(c.folderId)) {
      c.folderId = survivor(c.folderId);
      relocated.push(connectionRef(c.id));
    }
  }
  for (const f of next.folders) {
    if (!doomedF.has(f.id) && f.parentId && doomedF.has(f.parentId)) {
      f.parentId = survivor(f.parentId);
      relocated.push(folderRef(f.id));
    }
  }
  next.connections = next.connections.filter((c) => !doomedC.has(c.id));
  next.folders = next.folders.filter((f) => !doomedF.has(f.id));
  const moved = new Set(relocated.map(itemKey));
  const groups = new Map<string, { parent: Uuid | null; kind: ItemRef['kind'] }>();
  for (const item of relocated) {
    const parent = parentOf(next, item);
    groups.set(`${parent}|${item.kind}`, { parent, kind: item.kind });
  }
  for (const { parent, kind } of groups.values()) {
    const all = sortedChildren(next, parent, kind);
    renumber(next, [
      ...all.filter((i) => !moved.has(itemKey(i))),
      ...all.filter((i) => moved.has(itemKey(i))),
    ]);
  }
  return { tree: next, plan };
}

/** Next position after the existing siblings. */
export function nextOrder(tree: ConnectionTree, parent: Uuid | null, folders: boolean): number {
  const orders = (folders ? tree.folders : tree.connections)
    .filter((x) => ('parentId' in x ? x.parentId : (x as Connection).folderId) === parent)
    .map((x) => (x as Folder | Connection).sortOrder);
  return orders.length ? Math.max(...orders) + 1 : 0;
}
