// In-memory stand-in for the Rust backend, used ONLY for browser-based UI
// development (`npm run dev` outside Tauri) and tests. It is loaded through a
// dynamic import guarded by `import.meta.env.DEV`, so it never ships.
// It mirrors validation loosely; the Rust implementation is authoritative.

import {
  MAX_FOLDER_DEPTH,
  deleteItems,
  folderLevel,
  moveItems,
  nextOrder,
  planDelete,
} from '../features/connections/treeOps';
import type {
  Connection,
  ConnectionInput,
  ConnectionTree,
  Folder,
  FolderDeleteMode,
  FolderInput,
  ItemRef,
  LoggingStatus,
  Settings,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { checkBindings } from './shortcuts';

type Invoke = (<T>(command: string, args?: Record<string, unknown>) => Promise<T>) & {
  saves?: Settings[];
};

const uuid = () => globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`;

export interface MockOptions {
  /** Pretend file logging cannot write, with this fixed error token. */
  loggingError?: string;
  /** Start-up notes returned by `app_info`. */
  issues?: string[];
  /** Pretend a lock password exists (the lock is off until settings enable it). */
  lockPassword?: string;
  /** Start with the lock enabled and engaged (as after a restart). */
  startLocked?: boolean;
  /** Start with the lock enabled but unlocked. */
  lockEnabled?: boolean;
}

export function createMockBackend(
  seed?: Partial<ConnectionTree>,
  options: MockOptions = {},
): Invoke {
  const tree: ConnectionTree = {
    version: 1,
    folders: seed?.folders ?? [],
    connections: seed?.connections ?? [],
  };
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const saves: Settings[] = [];
  let lockPassword: string | null = options.lockPassword ?? null;
  let locked = !!options.startLocked && lockPassword !== null;
  let failed = 0;
  if (options.startLocked || options.lockEnabled) settings.security.appLock.enabled = true;
  const lockOpen = new Set([
    'lock_status',
    'lock_unlock',
    'lock_now',
    'lock_touch',
    'app_info',
    'window_apply_theme',
    'editor_presets',
  ]);

  const findConnection = (id: unknown) => {
    const c = tree.connections.find((x) => x.id === id);
    if (!c) throw { code: 'not_found', message: 'connection was not found' };
    return c;
  };

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    lock_status: () => ({
      enabled: settings.security.appLock.enabled && lockPassword !== null,
      configured: lockPassword !== null,
      locked,
      lockoutSeconds: failed >= 3 ? 5 : 0,
      inactivityMinutes: settings.security.appLock.inactivityMinutes,
      theme: settings.appearance.theme,
      accent: settings.appearance.accent,
    }),
    lock_unlock: ({ password }) => {
      if (failed >= 3) return { result: 'lockedOut', lockoutSeconds: 5 };
      if (password === lockPassword) {
        locked = false;
        failed = 0;
        return { result: 'unlocked' };
      }
      failed += 1;
      return {
        result: 'wrong',
        attemptsLeftBeforeDelay: Math.max(0, 3 - failed),
        lockoutSeconds: failed >= 3 ? 5 : 0,
      };
    },
    lock_now: () => {
      if (!(settings.security.appLock.enabled && lockPassword !== null)) {
        throw {
          code: 'validation',
          message: 'Application lock is not set up. Set a lock password first.',
        };
      }
      locked = true;
    },
    lock_touch: () => undefined,
    lock_set_password: ({ newPassword, currentPassword }) => {
      if (String(newPassword).length < 8) {
        throw { code: 'validation', message: 'The lock password must have at least 8 characters.' };
      }
      if (lockPassword !== null && currentPassword !== lockPassword) {
        throw { code: 'validation', message: 'The current lock password is wrong.' };
      }
      lockPassword = String(newPassword);
    },
    lock_remove_password: ({ currentPassword }) => {
      if (currentPassword !== lockPassword) {
        throw { code: 'validation', message: 'The lock password is wrong.' };
      }
      lockPassword = null;
      settings.security.appLock.enabled = false;
    },
    app_info: () => ({
      name: 'PeachTerm',
      version: '0.0.0-dev',
      os: 'windows',
      arch: 'x86_64',
      issues: options.issues ?? [],
    }),
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
        sortOrder: nextOrder(tree, input.folderId, false),
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
        sortOrder: source.sortOrder + 1,
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
      const level = input.parentId ? folderLevel(tree, input.parentId) : 0;
      if (level + 1 > MAX_FOLDER_DEPTH) {
        throw {
          code: 'validation',
          message: `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
        };
      }
      const created: Folder = {
        ...input,
        id: uuid(),
        sortOrder: nextOrder(tree, input.parentId, true),
      };
      tree.folders.push(created);
      return structuredClone(created);
    },
    connections_rename: ({ id, name }) => {
      const trimmed = String(name).trim();
      if (!trimmed || trimmed.length > 128) {
        throw { code: 'validation', message: 'Name is invalid' };
      }
      const c = findConnection(id);
      c.name = trimmed;
      return structuredClone(c);
    },
    folders_rename: ({ id, name }) => {
      const trimmed = String(name).trim();
      if (!trimmed || trimmed.length > 128) {
        throw { code: 'validation', message: 'Folder name is invalid' };
      }
      const f = tree.folders.find((x) => x.id === id);
      if (!f) throw { code: 'not_found', message: 'folder was not found' };
      f.name = trimmed;
      return structuredClone(f);
    },
    tree_move: ({ items, targetFolderId, before }) => {
      const next = moveItems(
        tree,
        items as ItemRef[],
        (targetFolderId as string | null) ?? null,
        (before as ItemRef | null) ?? null,
      );
      tree.folders = next.folders;
      tree.connections = next.connections;
      return structuredClone(tree);
    },
    tree_delete_preview: ({ items, mode }) =>
      planDelete(tree, items as ItemRef[], mode as FolderDeleteMode),
    tree_delete: ({ items, mode }) => {
      const result = deleteItems(tree, items as ItemRef[], mode as FolderDeleteMode);
      tree.folders = result.tree.folders;
      tree.connections = result.tree.connections;
      return { plan: result.plan, credentialFailures: 0, tree: structuredClone(tree) };
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
      const incoming = next as Settings;
      if (incoming.security.appLock.enabled && lockPassword === null) {
        throw {
          code: 'validation',
          message: 'Set a lock password before enabling the application lock.',
        };
      }
      // Mirrors the Rust validation: conflicting/reserved shortcuts are refused.
      const problem = checkBindings(incoming.shortcuts ?? {})[0];
      if (problem)
        throw { code: 'validation', message: `Shortcut "${problem.action}" ${problem.message}` };
      settings = structuredClone(incoming);
      saves.push(structuredClone(incoming));
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
    window_apply_theme: () => 'themeOnly',
    logging_status: (): LoggingStatus => {
      const d = settings.diagnostics;
      return {
        enabled: d.fileLogging,
        level: d.level,
        effectiveDir: d.logDir ?? '(browser dev mock)',
        customDir: d.logDir !== null,
        active: d.fileLogging && !options.loggingError,
        error: d.fileLogging ? (options.loggingError ?? null) : null,
        droppedLines: 0,
        fileCount: 1,
        totalBytes: 2048,
        retentionDays: d.retentionDays,
        maxTotalMb: d.maxTotalMb,
      };
    },
    logging_open_dir: () => undefined,
    logging_export_preview: () => ({
      files: [
        { name: 'peachterm-2026-11-22.log', bytes: 2048 },
        { name: 'diagnostics.json', bytes: 0 },
      ],
      totalBytes: 2048,
    }),
    logging_export: () => ({
      savedTo: '(browser dev mock)/peachterm-diagnostics.zip',
      entries: [{ name: 'peachterm-2026-11-22.log', linesKept: 12, linesDropped: 0 }],
      archiveBytes: 1024,
    }),
    logging_reveal_export: () => undefined,
    known_hosts_list: () => [],
    known_hosts_remove: () => undefined,
  };

  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (locked && !lockOpen.has(command)) throw { code: 'locked', message: 'PeachTerm is locked' };
    const handler = handlers[command];
    if (!handler) throw { code: 'not_implemented', message: `${command} is not implemented` };
    return handler(args) as T;
  };
  // Test hook: every settings object that was persisted, in order.
  return Object.assign(invoke, { saves }) as Invoke & { saves: Settings[] };
}
