// In-memory stand-in for the Rust backend, used ONLY for browser-based UI
// development (`npm run dev` outside Tauri) and tests. It is loaded through a
// dynamic import guarded by `import.meta.env.DEV`, so it never ships.
// It mirrors validation loosely; the Rust implementation is authoritative.

import type {
  Connection,
  ConnectionInput,
  ConnectionTree,
  Folder,
  FolderInput,
  Settings,
} from './types';
import { DEFAULT_SETTINGS } from './types';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const uuid = () => globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`;

export function createMockBackend(seed?: Partial<ConnectionTree>): Invoke {
  const tree: ConnectionTree = {
    version: 1,
    folders: seed?.folders ?? [],
    connections: seed?.connections ?? [],
  };
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);

  const findConnection = (id: unknown) => {
    const c = tree.connections.find((x) => x.id === id);
    if (!c) throw { code: 'not_found', message: 'connection was not found' };
    return c;
  };

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    app_info: () => ({ name: 'PeachTerm', version: '0.0.0-dev', os: 'windows', arch: 'x86_64' }),
    editor_presets: () => [
      { id: 'mock', label: 'Mock editor', program: 'editor', args: ['{file}'] },
    ],
    connections_load: () => structuredClone(tree),
    connections_save: ({ connection }) => {
      const input = connection as ConnectionInput;
      if (!input.name.trim()) throw { code: 'validation', message: 'Name is required' };
      if (!input.host.trim()) throw { code: 'validation', message: 'Host is required' };
      const now = Date.now();
      if (input.id) {
        const existing = findConnection(input.id);
        Object.assign(existing, input, { updatedAt: now });
        return structuredClone(existing);
      }
      const created: Connection = {
        ...input,
        id: uuid(),
        hasStoredSecret: false,
        createdAt: now,
        updatedAt: now,
      };
      tree.connections.push(created);
      return structuredClone(created);
    },
    connections_delete: ({ id }) => {
      tree.connections = tree.connections.filter((c) => c.id !== id);
    },
    connections_duplicate: ({ id }) => {
      const source = findConnection(id);
      const copy = {
        ...source,
        id: uuid(),
        name: `${source.name} (copy)`,
        hasStoredSecret: false,
      };
      tree.connections.push(copy);
      return structuredClone(copy);
    },
    connections_move: ({ id, folderId }) => {
      findConnection(id).folderId = (folderId as string | null) ?? null;
    },
    folders_save: ({ folder }) => {
      const input = folder as FolderInput;
      if (input.id) {
        const existing = tree.folders.find((f) => f.id === input.id);
        if (!existing) throw { code: 'not_found', message: 'folder was not found' };
        Object.assign(existing, input);
        return structuredClone(existing);
      }
      const created: Folder = { ...input, id: uuid() };
      tree.folders.push(created);
      return structuredClone(created);
    },
    folders_delete: ({ id }) => {
      const removed = tree.folders.find((f) => f.id === id);
      if (!removed) return;
      tree.folders = tree.folders.filter((f) => f.id !== id);
      tree.folders.forEach((f) => {
        if (f.parentId === id) f.parentId = removed.parentId;
      });
      tree.connections.forEach((c) => {
        if (c.folderId === id) c.folderId = removed.parentId;
      });
    },
    settings_load: () => structuredClone(settings),
    settings_save: ({ settings: next }) => {
      settings = structuredClone(next as Settings);
      return structuredClone(settings);
    },
    credentials_status: () => ({ available: true, backend: 'memory (dev mock)', detail: null }),
    credentials_set_password: ({ connectionId }) => {
      findConnection(connectionId).hasStoredSecret = true;
    },
    credentials_clear: ({ connectionId }) => {
      findConnection(connectionId).hasStoredSecret = false;
    },
    credentials_clear_all: () => {
      const cleared = tree.connections.filter((c) => c.hasStoredSecret).length;
      tree.connections.forEach((c) => (c.hasStoredSecret = false));
      return { cleared };
    },
    known_hosts_list: () => [],
    known_hosts_remove: () => undefined,
  };

  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const handler = handlers[command];
    if (!handler) throw { code: 'not_implemented', message: `${command} is not implemented` };
    return handler(args) as T;
  };
}
