import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import type {
  Connection,
  ConnectionInput,
  ConnectionTree,
  Folder,
  FolderInput,
  Uuid,
} from '../../shared/types';

interface ConnectionsState {
  tree: ConnectionTree;
  loaded: boolean;
  query: string;
  selectedId: Uuid | null;
  load: () => Promise<void>;
  setQuery: (query: string) => void;
  select: (id: Uuid | null) => void;
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

export const useConnections = create<ConnectionsState>((set, get) => ({
  tree: { version: 1, folders: [], connections: [] },
  loaded: false,
  query: '',
  selectedId: null,

  load: async () => {
    const tree = await ipc.connectionsLoad();
    set({ tree, loaded: true });
  },
  refresh: async () => {
    set({ tree: await ipc.connectionsLoad() });
  },
  setQuery: (query) => set({ query }),
  select: (selectedId) => set({ selectedId }),

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
    }));
  },
  duplicateConnection: async (id) => {
    const copy = await ipc.connectionsDuplicate(id);
    set((s) => ({
      tree: { ...s.tree, connections: [...s.tree.connections, copy] },
      selectedId: copy.id,
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
