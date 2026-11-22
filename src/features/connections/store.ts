// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import type {
  Connection,
  ConnectionInput,
  ConnectionTree,
  DeleteOutcome,
  Folder,
  FolderDeleteMode,
  FolderInput,
  ItemRef,
  Uuid,
} from '../../shared/types';
import { itemKey, parseKey } from './treeOps';

interface ConnectionsState {
  tree: ConnectionTree;
  loaded: boolean;
  query: string;
  /** The focused item (connection or folder id): target of F2, Enter, "New tab"… */
  selectedId: Uuid | null;
  /** Every selected row, as keys (`c:<id>` / `f:<id>`). Includes `selectedId`. */
  selection: string[];
  /** Start of a Shift-click range. */
  anchorKey: string | null;
  /** Id of the connection or folder being renamed inline (null = none). */
  renamingId: Uuid | null;
  load: () => Promise<void>;
  setQuery: (query: string) => void;
  /** Select exactly one item by id (kind is looked up). */
  select: (id: Uuid | null) => void;
  setSelection: (keys: string[], activeKey: string | null, anchorKey?: string | null) => void;
  startRename: (id: Uuid) => void;
  stopRename: () => void;
  renameItem: (item: ItemRef, name: string) => Promise<void>;
  moveItems: (items: ItemRef[], target: Uuid | null, before: ItemRef | null) => Promise<void>;
  deleteItems: (items: ItemRef[], mode: FolderDeleteMode) => Promise<DeleteOutcome>;
  saveConnection: (input: ConnectionInput) => Promise<Connection>;
  deleteConnection: (id: Uuid) => Promise<void>;
  duplicateConnection: (id: Uuid) => Promise<Connection>;
  moveConnection: (id: Uuid, folderId: Uuid | null) => Promise<void>;
  saveFolder: (input: FolderInput) => Promise<Folder>;
  toggleFolder: (id: Uuid) => Promise<void>;
  deleteFolder: (id: Uuid) => Promise<void>;
  /** Re-read after an operation that changes several records in Rust. */
  refresh: () => Promise<void>;
}

const upsert = <T extends { id: Uuid }>(list: T[], item: T): T[] => {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
};

/** Drop selected keys that no longer exist in `tree`. */
const prune = (tree: ConnectionTree, keys: string[]) =>
  keys.filter((key) => {
    const item = parseKey(key);
    return item.kind === 'folder'
      ? tree.folders.some((f) => f.id === item.id)
      : tree.connections.some((c) => c.id === item.id);
  });

const keyOfId = (tree: ConnectionTree, id: Uuid): string | null => {
  if (tree.connections.some((c) => c.id === id)) return itemKey({ kind: 'connection', id });
  if (tree.folders.some((f) => f.id === id)) return itemKey({ kind: 'folder', id });
  return null;
};

export const useConnections = create<ConnectionsState>((set, get) => ({
  tree: { version: 2, folders: [], connections: [] },
  loaded: false,
  query: '',
  selectedId: null,
  selection: [],
  anchorKey: null,
  renamingId: null,

  load: async () => {
    const tree = await ipc.connectionsLoad();
    set({ tree, loaded: true });
  },
  refresh: async () => {
    const tree = await ipc.connectionsLoad();
    set((s) => ({ tree, selection: prune(tree, s.selection) }));
  },
  setQuery: (query) => set({ query }),
  select: (id) => {
    const key = id ? keyOfId(get().tree, id) : null;
    set({ selectedId: key ? id : null, selection: key ? [key] : [], anchorKey: key });
  },
  setSelection: (keys, activeKey, anchorKey) =>
    set((s) => ({
      selection: keys,
      selectedId: activeKey ? parseKey(activeKey).id : null,
      anchorKey: anchorKey === undefined ? s.anchorKey : anchorKey,
    })),
  startRename: (id) => {
    const key = keyOfId(get().tree, id);
    set({ renamingId: id, selectedId: id, selection: key ? [key] : [], anchorKey: key });
  },
  stopRename: () => set({ renamingId: null }),

  renameItem: async (item, name) => {
    if (item.kind === 'connection') {
      const saved = await ipc.connectionsRename(item.id, name);
      set((s) => ({ tree: { ...s.tree, connections: upsert(s.tree.connections, saved) } }));
    } else {
      const saved = await ipc.foldersRename(item.id, name);
      set((s) => ({ tree: { ...s.tree, folders: upsert(s.tree.folders, saved) } }));
    }
  },
  moveItems: async (items, target, before) => {
    const tree = await ipc.treeMove(items, target, before);
    set((s) => ({ tree, selection: prune(tree, s.selection) }));
  },
  deleteItems: async (items, mode) => {
    const outcome = await ipc.treeDelete(items, mode);
    set((s) => {
      const selection = prune(outcome.tree, s.selection);
      return {
        tree: outcome.tree,
        selection,
        selectedId: selection.length ? s.selectedId : null,
        renamingId: null,
      };
    });
    return outcome;
  },

  saveConnection: async (input) => {
    const saved = await ipc.connectionsSave(input);
    set((s) => ({ tree: { ...s.tree, connections: upsert(s.tree.connections, saved) } }));
    return saved;
  },
  deleteConnection: async (id) => {
    await ipc.connectionsDelete(id);
    set((s) => ({
      tree: { ...s.tree, connections: s.tree.connections.filter((c) => c.id !== id) },
      selectedId: s.selectedId === id ? null : s.selectedId,
      selection: s.selection.filter((k) => parseKey(k).id !== id),
    }));
  },
  duplicateConnection: async (id) => {
    const copy = await ipc.connectionsDuplicate(id);
    const key = itemKey({ kind: 'connection', id: copy.id });
    set((s) => ({
      tree: { ...s.tree, connections: [...s.tree.connections, copy] },
      selectedId: copy.id,
      selection: [key],
      anchorKey: key,
    }));
    return copy;
  },
  moveConnection: async (id, folderId) => {
    await ipc.connectionsMove(id, folderId);
    set((s) => ({
      tree: {
        ...s.tree,
        connections: s.tree.connections.map((c) => (c.id === id ? { ...c, folderId } : c)),
      },
    }));
  },
  saveFolder: async (input) => {
    const saved = await ipc.foldersSave(input);
    set((s) => ({ tree: { ...s.tree, folders: upsert(s.tree.folders, saved) } }));
    return saved;
  },
  toggleFolder: async (id) => {
    const folder = get().tree.folders.find((f) => f.id === id);
    if (!folder) return;
    // Optimistic: collapsing must feel instant.
    const next = { ...folder, expanded: !folder.expanded };
    set((s) => ({ tree: { ...s.tree, folders: upsert(s.tree.folders, next) } }));
    try {
      await ipc.foldersSave(next);
    } catch (error) {
      set((s) => ({ tree: { ...s.tree, folders: upsert(s.tree.folders, folder) } }));
      throw error;
    }
  },
  deleteFolder: async (id) => {
    await ipc.foldersDelete(id);
    await get().refresh();
  },
}));
