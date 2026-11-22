// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

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
  LocalProfile,
  LoggingStatus,
  SavedNode,
  Settings,
  TerminalEvent,
  TransferEvent,
  WorkspaceLayout,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { checkBindings } from './shortcuts';

type Invoke = (<T>(command: string, args?: Record<string, unknown>) => Promise<T>) & {
  saves?: Settings[];
  ssh?: MockSsh;
};

/** Recorded SSH traffic of the mock backend, plus a way to push events. */
export interface MockSsh {
  opens: { sessionId: string; connectionId: string; cols: number; rows: number; attempt: number }[];
  writes: { sessionId: string; text: string }[];
  resizes: { sessionId: string; cols: number; rows: number }[];
  acks: { sessionId: string; bytes: number }[];
  closes: string[];
  clears: {
    begins: number;
    cancels: number;
    deleted: number;
    attempts: { token: string; answer: number }[];
  };
  /** Interface scales that were applied, in order. */
  scales: number[];
  workspaceSaves: WorkspaceLayout[];
  /** Local terminal traffic (the shells themselves are not simulated). */
  local: {
    opens: { sessionId: string; profileId: string; cols: number; rows: number }[];
    writes: { sessionId: string; text: string }[];
    resizes: { sessionId: string; cols: number; rows: number }[];
    acks: { sessionId: string; bytes: number }[];
    closes: string[];
    profileLoads: number;
  };
  /** How many times the application was asked to quit. */
  quits: number;
  /** Project links opened from the About page. */
  links: string[];
  hostKeyAnswers: { promptId: string; decision: string }[];
  authAnswers: { promptId: string; answers: string[] | null }[];
  emit: (sessionId: string, event: TerminalEvent) => void;
  editor: {
    opens: { sessionId: string; remotePath: string }[];
    answers: { editId: string; answer: string }[];
    conflicts: { editId: string; choice: string }[];
    retries: string[];
    stops: string[];
  };
  sftp: {
    lists: (string | null)[];
    mkdirs: string[];
    createdFiles: string[];
    /** Make the next create/mkdir fail with this error message. */
    failNext: string | null;
    renames: { path: string; newName: string }[];
    deletes: string[];
    downloads: string[];
    uploads: { pickId: string; remoteDir: string; overwrite: boolean }[];
    cancels: string[];
    /** Deliver a transfer event to the most recent upload/download. */
    emitTransfer: (event: TransferEvent) => void;
    /** Files the next native file picker returns. */
    nextPick: { name: string; size: number }[] | null;
    /** Remote file system: directory path -> entries. */
    fs: Record<string, { name: string; dir: boolean; size: number }[]>;
    /** A different file system for one session (by session id). */
    perSession: Record<string, Record<string, { name: string; dir: boolean; size: number }[]>>;
  };
}

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
  /** Pretend the server has no SFTP subsystem. */
  noSftp?: boolean;
  /** How many saved passwords "fail to delete" in clear-all (partial failure). */
  clearFailures?: number;
  /** Saved connections whose SSH login fails (they never enter the recent list). */
  sshFails?: string[];
  /** A layout left by the previous run; also switches "restore tabs" on. */
  restoreLayout?: WorkspaceLayout;
  /** Recent connection ids from earlier runs (newest first). */
  recent?: string[];
  /** Shells `local_profiles` reports (default: Windows PowerShell and Command Prompt). */
  localProfiles?: LocalProfile[];
  /** Profile ids whose shell fails to start. */
  localFails?: string[];
  /** Change the stored settings before the app starts. */
  settings?: (s: Settings) => Settings;
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
  if (options.restoreLayout) settings.general.startup = 'restoreTabs';
  if (options.settings) settings = options.settings(settings);
  const saves: Settings[] = [];
  let lockPassword: string | null = options.lockPassword ?? null;
  let locked = !!options.startLocked && lockPassword !== null;
  let failed = 0;
  const channels = new Map<string, (event: TerminalEvent) => void>();
  const emptyLayout = (): WorkspaceLayout => ({ tabs: [], active: null, tree: null, focus: null });
  let layout: WorkspaceLayout = options.restoreLayout ?? emptyLayout();
  let recent: string[] = options.recent ?? [];
  let pendingClear: { token: string; wrong: number } | null = null;
  let clearCounter = 0;
  const ssh: MockSsh = {
    opens: [],
    writes: [],
    resizes: [],
    acks: [],
    closes: [],
    clears: { begins: 0, cancels: 0, deleted: 0, attempts: [] },
    scales: [],
    workspaceSaves: [],
    local: { opens: [], writes: [], resizes: [], acks: [], closes: [], profileLoads: 0 },
    quits: 0,
    links: [],
    hostKeyAnswers: [],
    authAnswers: [],
    emit: (sessionId, event) => channels.get(sessionId)?.(event),
    editor: { opens: [], answers: [], conflicts: [], retries: [], stops: [] },
    sftp: {
      lists: [],
      mkdirs: [],
      createdFiles: [],
      failNext: null,
      renames: [],
      deletes: [],
      downloads: [],
      uploads: [],
      cancels: [],
      emitTransfer: () => undefined,
      nextPick: null,
      perSession: {},
      fs: {
        '/': [
          { name: 'home', dir: true, size: 0 },
          { name: 'etc', dir: true, size: 0 },
          { name: 'readme.txt', dir: false, size: 120 },
          { name: '.profile', dir: false, size: 800 },
        ],
        '/home': [{ name: 'notes.md', dir: false, size: 2048 }],
        '/etc': [],
      },
    },
  };
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
    credentials_clear_begin: () => {
      pendingClear = { token: `clear-${++clearCounter}`, wrong: 0 };
      ssh.clears.begins += 1;
      return {
        token: pendingClear.token,
        question: '7 + 5',
        expiresInSecs: 60,
        count: tree.connections.filter((c) => c.hasStoredSecret).length,
      };
    },
    credentials_clear_cancel: () => {
      ssh.clears.cancels += 1;
      pendingClear = null;
    },
    // like Rust: refuses without the matching token and the right answer
    credentials_clear_all: (args) => {
      ssh.clears.attempts.push({ token: String(args.token), answer: Number(args.answer) });
      if (!pendingClear || pendingClear.token !== args.token) {
        throw {
          code: 'validation',
          message: 'There is no pending confirmation. Nothing was deleted.',
        };
      }
      if (Number(args.answer) !== 12) {
        pendingClear.wrong += 1;
        if (pendingClear.wrong >= 3) pendingClear = null;
        throw { code: 'validation', message: 'That is not the right answer. Nothing was deleted.' };
      }
      pendingClear = null;
      const flagged = tree.connections.filter((c) => c.hasStoredSecret);
      const failed = Math.min(options.clearFailures ?? 0, flagged.length);
      flagged.slice(failed).forEach((c) => (c.hasStoredSecret = false));
      ssh.clears.deleted += flagged.length - failed;
      return { deleted: flagged.length - failed, failed };
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
    ssh_open: (args) => {
      const sessionId = uuid();
      const channel = args.onEvent as { onmessage: ((event: TerminalEvent) => void) | null };
      ssh.opens.push({
        sessionId,
        connectionId: String(args.connectionId),
        cols: Number(args.cols),
        rows: Number(args.rows),
        attempt: Number(args.attempt ?? 0),
      });
      if (channel.onmessage) channels.set(sessionId, channel.onmessage);
      queueMicrotask(() => {
        if (options.sshFails?.includes(String(args.connectionId))) {
          ssh.emit(sessionId, { kind: 'status', state: 'failed' });
          ssh.emit(sessionId, { kind: 'closed', reason: 'auth_failed' });
          return;
        }
        // what Rust does after a successful login
        recent = [String(args.connectionId), ...recent.filter((id) => id !== args.connectionId)];
        ssh.emit(sessionId, { kind: 'status', state: 'connected' });
        ssh.emit(sessionId, { kind: 'sftp', state: options.noSftp ? 'unavailable' : 'ready' });
        ssh.emit(sessionId, {
          kind: 'data',
          data: btoa('mock shell ready' + String.fromCharCode(13, 10)),
        });
      });
      return { sessionId };
    },
    app_open_link: (args) => {
      ssh.links.push(String(args.link));
    },
    app_quit: () => {
      ssh.quits += 1;
    },
    local_profiles: () => {
      ssh.local.profileLoads += 1;
      const profiles = options.localProfiles ?? [
        { id: 'powershell', name: 'Windows PowerShell', kind: 'local', detail: 'powershell.exe' },
        { id: 'cmd', name: 'Command Prompt', kind: 'local', detail: 'cmd.exe' },
      ];
      const wanted = settings.terminal.defaultProfile;
      const fallback = profiles[0]?.id ?? null;
      return {
        profiles,
        default: profiles.some((p) => p.id === wanted) ? wanted : fallback,
      };
    },
    local_open: (args) => {
      const sessionId = uuid();
      const channel = args.onEvent as { onmessage: ((event: TerminalEvent) => void) | null };
      const profileId = String(args.profileId);
      if (options.localFails?.includes(profileId)) {
        throw { code: 'validation', message: 'The shell could not be started.' };
      }
      ssh.local.opens.push({
        sessionId,
        profileId,
        cols: Number(args.cols),
        rows: Number(args.rows),
      });
      if (channel.onmessage) channels.set(sessionId, channel.onmessage);
      queueMicrotask(() => {
        ssh.emit(sessionId, { kind: 'status', state: 'connected' });
        ssh.emit(sessionId, {
          kind: 'data',
          data: btoa('mock local shell ready' + String.fromCharCode(13, 10)),
        });
      });
      return { sessionId };
    },
    local_write: (args) => {
      ssh.local.writes.push({ sessionId: String(args.sessionId), text: atob(String(args.data)) });
    },
    local_resize: (args) => {
      ssh.local.resizes.push({
        sessionId: String(args.sessionId),
        cols: Number(args.cols),
        rows: Number(args.rows),
      });
    },
    local_ack: (args) => {
      ssh.local.acks.push({ sessionId: String(args.sessionId), bytes: Number(args.bytes) });
    },
    local_close: (args) => {
      ssh.local.closes.push(String(args.sessionId));
    },
    ssh_write: (args) => {
      ssh.writes.push({ sessionId: String(args.sessionId), text: atob(String(args.data)) });
    },
    ssh_resize: (args) => {
      ssh.resizes.push({
        sessionId: String(args.sessionId),
        cols: Number(args.cols),
        rows: Number(args.rows),
      });
    },
    ssh_ack: (args) => {
      ssh.acks.push({ sessionId: String(args.sessionId), bytes: Number(args.bytes) });
    },
    ssh_close: (args) => {
      ssh.closes.push(String(args.sessionId));
    },
    ssh_answer_host_key: (args) => {
      ssh.hostKeyAnswers.push({ promptId: String(args.promptId), decision: String(args.decision) });
    },
    ssh_answer_auth: (args) => {
      ssh.authAnswers.push({
        promptId: String(args.promptId),
        answers: (args.answers as string[] | null) ?? null,
      });
    },
    editor_open_remote: (args) => {
      ssh.editor.opens.push({
        sessionId: String(args.sessionId),
        remotePath: String(args.remotePath),
      });
      return {
        editId: '33333333-3333-4333-8333-333333333333',
        name: String(args.remotePath).split('/').pop(),
        alreadyOpen: false,
      };
    },
    editor_answer: (args) => {
      ssh.editor.answers.push({ editId: String(args.editId), answer: String(args.answer) });
      return true;
    },
    editor_resolve_conflict: (args) => {
      ssh.editor.conflicts.push({ editId: String(args.editId), choice: String(args.choice) });
      return true;
    },
    editor_retry: (args) => {
      ssh.editor.retries.push(String(args.editId));
      return true;
    },
    editor_stop: (args) => {
      ssh.editor.stops.push(String(args.editId));
    },
    workspace_load: () => {
      if (settings.general.startup !== 'restoreTabs') return emptyLayout();
      const exists = new Set(tree.connections.map((c) => c.id));
      const map: (number | null)[] = [];
      const tabs: WorkspaceLayout['tabs'] = [];
      layout.tabs.forEach((t) => {
        const keep =
          t.kind === 'ssh' ? !!t.connectionId && exists.has(t.connectionId) : !!t.profileId;
        map.push(keep ? tabs.length : null);
        if (keep) tabs.push(t);
      });
      const prune = (n: SavedNode): SavedNode | null => {
        if (n.kind === 'leaf')
          return map[n.tab] == null ? null : { kind: 'leaf', tab: map[n.tab]! };
        const a = prune(n.a);
        const b = prune(n.b);
        return a && b ? { ...n, a, b } : (a ?? b);
      };
      const count = (n: SavedNode): number => (n.kind === 'leaf' ? 1 : count(n.a) + count(n.b));
      let pruned = layout.tree ? prune(layout.tree) : null;
      if (pruned && count(pruned) < 2) pruned = null;
      return {
        tabs,
        active: layout.active === null ? null : (map[layout.active] ?? null),
        tree: pruned,
        focus: pruned && layout.focus !== null ? (map[layout.focus] ?? null) : null,
      } satisfies WorkspaceLayout;
    },
    workspace_save: (args) => {
      const next = args.layout as WorkspaceLayout;
      ssh.workspaceSaves.push(structuredClone(next));
      layout = settings.general.startup === 'restoreTabs' ? structuredClone(next) : emptyLayout();
    },
    recent_list: () => {
      const exists = new Set(tree.connections.map((c) => c.id));
      recent = recent.filter((id) => exists.has(id));
      return recent.slice(0, settings.general.recentSessionsLimit);
    },
    recent_clear: () => {
      recent = [];
    },
    window_apply_scale: (args) => {
      const percent = Number(args.percent);
      ssh.scales.push(percent);
      return percent;
    },
    sftp_status: () => (options.noSftp ? 'unavailable' : 'ready'),
    sftp_list: (args) => {
      const requested = args.path === null ? '/' : String(args.path);
      ssh.sftp.lists.push(args.path === null ? null : requested);
      const entries = (ssh.sftp.perSession[String(args.sessionId)] ?? ssh.sftp.fs)[requested];
      if (!entries) throw { code: 'remote', message: 'No such file or directory' };
      const parent =
        requested === '/' ? null : requested.slice(0, requested.lastIndexOf('/')) || '/';
      return {
        path: requested,
        parent,
        entries: entries.map((e) => ({
          name: e.name,
          path: requested === '/' ? `/${e.name}` : `${requested}/${e.name}`,
          kind: e.dir ? 'directory' : 'file',
          targetIsDir: false,
          size: e.size,
          modified: 1_700_000_000,
          mode: e.dir ? 0o755 : 0o644,
        })),
      };
    },
    sftp_create_file: (args) => {
      const parent = String(args.parent);
      const name = String(args.name);
      if (ssh.sftp.failNext) {
        const message = ssh.sftp.failNext;
        ssh.sftp.failNext = null;
        throw { code: 'remote', message };
      }
      const dir = ssh.sftp.fs[parent];
      if (dir?.some((e) => e.name === name)) {
        throw { code: 'remote', message: 'An item with that name already exists' };
      }
      ssh.sftp.createdFiles.push(parent === '/' ? `/${name}` : `${parent}/${name}`);
      dir?.push({ name, dir: false, size: 0 });
      return parent === '/' ? `/${name}` : `${parent}/${name}`;
    },
    sftp_mkdir: (args) => {
      const parent = String(args.parent);
      const name = String(args.name);
      if (ssh.sftp.failNext) {
        const message = ssh.sftp.failNext;
        ssh.sftp.failNext = null;
        throw { code: 'remote', message };
      }
      ssh.sftp.mkdirs.push(parent === '/' ? `/${name}` : `${parent}/${name}`);
      ssh.sftp.fs[parent]?.push({ name, dir: true, size: 0 });
      return parent === '/' ? `/${name}` : `${parent}/${name}`;
    },
    sftp_rename: (args) => {
      ssh.sftp.renames.push({ path: String(args.path), newName: String(args.newName) });
      return String(args.newName);
    },
    sftp_delete: (args) => {
      ssh.sftp.deletes.push(String(args.path));
      return { removed: 1 };
    },
    sftp_download: (args) => {
      ssh.sftp.downloads.push(String(args.remotePath));
      const channel = args.onEvent as { onmessage: ((e: TransferEvent) => void) | null };
      if (channel.onmessage) ssh.sftp.emitTransfer = channel.onmessage;
      return true;
    },
    sftp_pick_upload: () => {
      const files = ssh.sftp.nextPick;
      ssh.sftp.nextPick = null;
      return files ? { pickId: 'pick-1', files } : null;
    },
    sftp_upload: (args) => {
      const channel = args.onEvent as { onmessage: ((e: TransferEvent) => void) | null };
      if (channel.onmessage) ssh.sftp.emitTransfer = channel.onmessage;
      ssh.sftp.uploads.push({
        pickId: String(args.pickId),
        remoteDir: String(args.remoteDir),
        overwrite: Boolean(args.overwrite),
      });
    },
    sftp_cancel: (args) => {
      ssh.sftp.cancels.push(String(args.transferId));
    },
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
  return Object.assign(invoke, { saves, ssh }) as Invoke & { saves: Settings[]; ssh: MockSsh };
}
