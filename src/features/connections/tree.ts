// Pure helpers that turn the flat folder/connection lists into a sorted tree
// and apply sidebar search. Kept free of React so they are cheap to test.

import type { Connection, ConnectionTree, Folder, Uuid } from '../../shared/types';

export interface FolderNode {
  kind: 'folder';
  folder: Folder;
  children: TreeNode[];
  /** Number of connections in this folder and all sub-folders. */
  count: number;
}

export interface ConnectionNode {
  kind: 'connection';
  connection: Connection;
}

export type TreeNode = FolderNode | ConnectionNode;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function connectionMatches(connection: Connection, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    connection.name,
    connection.host,
    connection.username,
    `${connection.username}@${connection.host}`,
  ].some((field) => field.toLowerCase().includes(q));
}

/**
 * Build the visible tree. Folders sort before connections, both by natural
 * name order. With a query, only matching connections and the folders that
 * lead to them are kept; folders whose *name* matches keep all children.
 */
export function buildTree(tree: ConnectionTree, query = ''): TreeNode[] {
  const q = query.trim().toLowerCase();
  const folderIds = new Set(tree.folders.map((f) => f.id));
  const childFolders = new Map<Uuid | null, Folder[]>();
  for (const folder of tree.folders) {
    // A dangling parent reference is shown at the root instead of vanishing.
    const parent = folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : null;
    const list = childFolders.get(parent) ?? [];
    list.push(folder);
    childFolders.set(parent, list);
  }
  const childConnections = new Map<Uuid | null, Connection[]>();
  for (const connection of tree.connections) {
    const parent =
      connection.folderId && folderIds.has(connection.folderId) ? connection.folderId : null;
    const list = childConnections.get(parent) ?? [];
    list.push(connection);
    childConnections.set(parent, list);
  }

  const visited = new Set<Uuid>();
  const build = (parent: Uuid | null, forceInclude: boolean): TreeNode[] => {
    const folders = [...(childFolders.get(parent) ?? [])].sort((a, b) =>
      collator.compare(a.name, b.name),
    );
    const connections = [...(childConnections.get(parent) ?? [])].sort((a, b) =>
      collator.compare(a.name, b.name),
    );
    const nodes: TreeNode[] = [];
    for (const folder of folders) {
      if (visited.has(folder.id)) continue; // defensive: cycles
      visited.add(folder.id);
      const nameMatches = !!q && folder.name.toLowerCase().includes(q);
      const children = build(folder.id, forceInclude || nameMatches);
      const count = children.reduce(
        (sum, child) => sum + (child.kind === 'folder' ? child.count : 1),
        0,
      );
      if (!q || forceInclude || nameMatches || children.length > 0) {
        nodes.push({ kind: 'folder', folder, children, count });
      }
    }
    for (const connection of connections) {
      if (!q || forceInclude || connectionMatches(connection, q)) {
        nodes.push({ kind: 'connection', connection });
      }
    }
    return nodes;
  };
  return build(null, false);
}

/** Ids of `folderId` and all of its descendants (for move-target validation). */
export function descendantFolderIds(folders: Folder[], folderId: Uuid): Set<Uuid> {
  const result = new Set<Uuid>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of folders) {
      if (f.parentId && result.has(f.parentId) && !result.has(f.id)) {
        result.add(f.id);
        changed = true;
      }
    }
  }
  return result;
}

/** "Prod / Web" style path for folder pickers. */
export function folderPath(folders: Folder[], folderId: Uuid | null): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  const seen = new Set<Uuid>();
  let cursor = folderId ? byId.get(folderId) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    parts.unshift(cursor.name);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return parts.join(' / ');
}
