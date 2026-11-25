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
  DocFormat,
  NoteKind,
  TunnelDef,
  TunnelInput,
  UpdateCheckOutcome,
  UpdateInfo,
  UpdateDownloadEvent,
  BackupFileInfo,
  Connection,
  ConnectionInput,
  ConnectionTree,
  Folder,
  FolderDeleteMode,
  FolderInput,
  ImportPreview,
  ItemRef,
  LocalProfile,
  LoggingStatus,
  MonitorEvent,
  RestorePreview,
  RestoreResult,
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
export interface MockNote {
  id: string;
  title: string;
  kind: NoteKind;
  format: DocFormat;
  source: string | null;
  zoom: number;
  connections: string[];
  text: string;
  offlineText: string | null;
  offlineAt: number | null;
}

export interface MockNotes {
  items: MockNote[];
  lastSelected: Record<string, string>;
  /** Text of web documents by URL; a string starting with "!" is a fetch error sentence. */
  web: Record<string, string>;
  /** Text of linked local files by path; missing key = the file is gone. */
  files: Record<string, string>;
  /** What the next native file dialog returns (null = cancelled). */
  nextFile: { path: string; format: DocFormat } | null;
  /** Make the next write fail with this message. */
  failWrite: string | null;
  writes: { id: string; text: string }[];
  opened: string[];
  links: string[];
  deleted: string[];
  detached: { id: string; connection: string }[];
  fetches: string[];
}

export interface MockUpdates {
  /** Pretend the build has an update key (official builds). */
  configured: boolean;
  platform: 'windows' | 'macos' | 'linuxAppimage' | 'linuxPackage';
  /** What the next check answers. */
  next: UpdateCheckOutcome;
  /** Make the next download fail with this fixed token. */
  failDownload: string | null;
  /** Make the next install fail. */
  failInstall: boolean;
  /** Events a download emits (a real percentage needs a `total`). */
  downloadEvents: UpdateDownloadEvent[];
  /** Keep a download open until `release()` (to test the in-flight state). */
  hold: boolean;
  release: () => void;
  checks: number;
  downloads: number;
  installs: number;
  notes: number;
  lastCheckAt: number | null;
}

export interface MockTunnels {
  defs: TunnelDef[];
  /** tunnel id -> owning session id */
  running: Record<string, string>;
  /** Fixed sentence to refuse the next start with (a port conflict, for example). */
  failStart: string | null;
  starts: { sessionId: string; tunnelId: string }[];
  stops: string[];
  browser: string[];
  /** Last failure sentence per tunnel (shown in the list). */
  lastError: Record<string, string>;
}

export interface MockMonitor {
  starts: string[];
  stops: string[];
  /** Deliver a monitor event to the session's channel. */
  emit: (sessionId: string, event: MonitorEvent) => void;
  channels: Record<string, (event: MonitorEvent) => void>;
}

export interface MockSsh {
  monitor: MockMonitor;
  notes: MockNotes;
  updates: MockUpdates;
  tunnels: MockTunnels;
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
  /** Data portability traffic (the dialogs and the crypto are not simulated). */
  portability: {
    exports: {
      ids: string[] | null;
      includeKeyPaths: boolean;
      notes?: { include: boolean; snapshots: boolean };
    }[];
    /** What the next "choose a file" dialog yields (null = the user cancels). */
    nextImport: ImportPreview | null;
    imports: { token: string; duplicates: string; update: number[]; importNotes?: boolean }[];
    nextDestination: string | null;
    backups: {
      token: string;
      includeSettings: boolean;
      includeCredentials: boolean;
      includeNotes?: boolean;
      passphrase: string;
      confirm: string;
    }[];
    nextRestoreFile: BackupFileInfo | null;
    /** The preview that a correct passphrase unlocks. */
    restorePreview: RestorePreview | null;
    unlocks: { token: string; passphrase: string }[];
    restores: { token: string; options: Record<string, unknown> }[];
    cancels: string[];
    restoreResult: RestoreResult | null;
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
    /** The plan returned for the next dropped selection (conflicts etc.). */
    nextPlan: import('./types').UploadPlan | Error | null;
    plans: { pickId: string; remoteDir: string }[];
    discards: string[];
    /** What the permission diagnostics return, and which directories were asked about. */
    report: import('./types').PermissionReport | Error | null;
    diagnosed: string[];
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
  const monitorChannels: Record<string, (event: MonitorEvent) => void> = {};
  const ssh: MockSsh = {
    monitor: {
      starts: [],
      stops: [],
      channels: monitorChannels,
      emit: (sessionId, event) => monitorChannels[sessionId]?.(event),
    },
    notes: {
      items: [],
      lastSelected: {},
      web: {},
      files: {},
      nextFile: null,
      failWrite: null,
      writes: [],
      opened: [],
      links: [],
      deleted: [],
      detached: [],
      fetches: [],
    },
    updates: {
      configured: true,
      platform: 'windows',
      next: { state: 'upToDate' },
      failDownload: null,
      failInstall: false,
      downloadEvents: [
        { kind: 'started', total: 1000 },
        { kind: 'progress', downloaded: 500 },
        { kind: 'progress', downloaded: 1000 },
        { kind: 'finished' },
      ],
      hold: false,
      release: () => undefined,
      checks: 0,
      downloads: 0,
      installs: 0,
      notes: 0,
      lastCheckAt: null,
    },
    tunnels: {
      defs: [],
      running: {},
      failStart: null,
      starts: [],
      stops: [],
      browser: [],
      lastError: {},
    },
    opens: [],
    writes: [],
    resizes: [],
    acks: [],
    closes: [],
    clears: { begins: 0, cancels: 0, deleted: 0, attempts: [] },
    scales: [],
    workspaceSaves: [],
    local: { opens: [], writes: [], resizes: [], acks: [], closes: [], profileLoads: 0 },
    portability: {
      exports: [],
      nextImport: null,
      imports: [],
      nextDestination: null,
      backups: [],
      nextRestoreFile: null,
      restorePreview: null,
      unlocks: [],
      restores: [],
      cancels: [],
      restoreResult: null,
    },
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
      nextPlan: null,
      plans: [],
      discards: [],
      report: null,
      diagnosed: [],
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
    'tunnel_counts',
    'monitor_stop',
    'window_apply_theme',
    'editor_presets',
  ]);

  const findConnection = (id: unknown) => {
    const c = tree.connections.find((x) => x.id === id);
    if (!c) throw { code: 'not_found', message: 'connection was not found' };
    return c;
  };

  const findNote = (id: unknown) => {
    const n = ssh.notes.items.find((x) => x.id === id);
    if (!n) throw { code: 'not_found', message: 'note was not found' };
    return n;
  };
  const noteSummary = (n: MockNote, viewing: string | null) => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    format: n.format,
    source: n.source,
    createdAt: 1,
    updatedAt: 1,
    zoom: n.zoom,
    offline: n.offlineAt
      ? { savedAt: n.offlineAt, bytes: (n.offlineText ?? '').length, format: n.format }
      : null,
    shared: n.connections.length > 1,
    sharedWith: n.connections.filter((c) => c !== viewing),
    orphan: n.connections.length === 0,
  });
  let pendingUpdate: UpdateInfo | null = null;
  let updateDownloaded = false;
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
        monitoring: input.monitoring ?? 'inherit',
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
    folders_create_path: ({ parentId, path }) => {
      const bad = (key: string, message: string, params?: Record<string, string>) => ({
        code: 'validation',
        message,
        key,
        params,
      });
      const text = String(path).trim();
      const names = text.split('/').map((n) => n.trim());
      if (!text || text.length > 392 || names.some((n) => !n || n === '.' || n === '..')) {
        throw bad('folders.pathInvalid', 'The folder path is invalid');
      }
      // eslint-disable-next-line no-control-regex
      if (names.some((n) => /[\u0000-\u001f\u007f]/.test(n) || [...n].length > 128)) {
        throw bad('folders.pathInvalid', 'The folder path is invalid');
      }
      const parent = (parentId as string | null) ?? null;
      if (parent && !tree.folders.some((f) => f.id === parent)) {
        throw { code: 'not_found', message: 'folder was not found' };
      }
      const base = parent ? folderLevel(tree, parent) : 0;
      if (base + names.length > MAX_FOLDER_DEPTH) {
        throw bad('folders.tooDeep', 'Folders can be nested at most 3 levels deep.', {
          max: String(MAX_FOLDER_DEPTH),
        });
      }
      const chain: Folder[] = [];
      let created = 0;
      let current = parent;
      for (const name of names) {
        let folder = tree.folders.find((f) => f.parentId === current && f.name === name);
        if (!folder) {
          folder = {
            id: uuid(),
            name,
            parentId: current,
            expanded: true,
            sortOrder: nextOrder(tree, current, true),
          };
          tree.folders.push(folder);
          created += 1;
        }
        folder.expanded = true;
        current = folder.id;
        chain.push(structuredClone(folder));
      }
      const top = tree.folders.find((f) => f.id === parent);
      if (top) top.expanded = true;
      return { folders: chain, created };
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
    notes_counts: () => {
      const out: Record<string, number> = {};
      for (const n of ssh.notes.items) for (const c of n.connections) out[c] = (out[c] ?? 0) + 1;
      return out;
    },
    notes_list: ({ connectionId }) => ({
      notes: ssh.notes.items
        .filter((n) => n.connections.includes(String(connectionId)))
        .map((n) => noteSummary(n, String(connectionId))),
      lastSelected: ssh.notes.lastSelected[String(connectionId)] ?? null,
    }),
    notes_all: () => ssh.notes.items.map((n) => noteSummary(n, null)),
    note_create: ({ connectionId, title, format, content }) => {
      const note: MockNote = {
        id: uuid(),
        title: String(title).trim(),
        kind: 'internal',
        format: format as DocFormat,
        source: null,
        zoom: 100,
        connections: [String(connectionId)],
        text: String(content ?? ''),
        offlineText: null,
        offlineAt: null,
      };
      if (!note.title) throw { code: 'validation', message: 'Give the note a title.' };
      ssh.notes.items.push(note);
      ssh.notes.lastSelected[String(connectionId)] = note.id;
      return note.id;
    },
    note_attach_url: ({ connectionId, url, title }) => {
      const u = String(url).trim();
      if (!u.startsWith('https://')) {
        throw { code: 'validation', message: 'Only https:// addresses can be used.' };
      }
      if (/^https:\/\/(localhost|127\.|10\.|192\.168\.)/.test(u)) {
        throw {
          code: 'validation',
          message: 'That address points to a local or private network and is not allowed.',
        };
      }
      const raw = u.replace(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/,
        'https://raw.githubusercontent.com/$1/$2/$3',
      );
      const name = raw.split('/').pop() ?? 'Document';
      const note: MockNote = {
        id: uuid(),
        title: String(title ?? '').trim() || name,
        kind: 'remoteUrl',
        format: /\.html?$/.test(raw) ? 'html' : /\.txt$/.test(raw) ? 'text' : 'markdown',
        source: raw,
        zoom: 100,
        connections: [String(connectionId)],
        text: '',
        offlineText: null,
        offlineAt: null,
      };
      ssh.notes.items.push(note);
      ssh.notes.lastSelected[String(connectionId)] = note.id;
      return note.id;
    },
    note_attach_file: ({ connectionId }) => {
      const pick = ssh.notes.nextFile;
      ssh.notes.nextFile = null;
      if (!pick) return null;
      const note: MockNote = {
        id: uuid(),
        title: (pick.path.split(/[\\/]/).pop() ?? 'Document').replace(/\.[^.]+$/, ''),
        kind: 'localFile',
        format: pick.format,
        source: pick.path,
        zoom: 100,
        connections: [String(connectionId)],
        text: '',
        offlineText: null,
        offlineAt: null,
      };
      ssh.notes.items.push(note);
      ssh.notes.lastSelected[String(connectionId)] = note.id;
      return note.id;
    },
    note_relocate: ({ noteId }) => {
      const pick = ssh.notes.nextFile;
      ssh.notes.nextFile = null;
      if (!pick) return false;
      const n = findNote(noteId);
      n.source = pick.path;
      n.format = pick.format;
      return true;
    },
    note_read: ({ noteId }) => {
      const n = findNote(noteId);
      const base = {
        id: n.id,
        kind: n.kind,
        format: n.format,
        problem: null as string | null,
        fromOffline: false,
        offline: n.offlineAt
          ? { savedAt: n.offlineAt, bytes: (n.offlineText ?? '').length, format: n.format }
          : null,
        source: n.source,
      };
      if (n.kind === 'internal') return { ...base, status: 'ok', text: n.text };
      if (n.kind === 'localFile') {
        const text = ssh.notes.files[n.source ?? ''];
        if (text === undefined) {
          return {
            ...base,
            status: 'missing',
            text: null,
            problem: 'The file was not found. It may have been moved or deleted.',
          };
        }
        return { ...base, status: 'ok', text };
      }
      ssh.notes.fetches.push(n.source ?? '');
      const web = ssh.notes.web[n.source ?? ''];
      if (web !== undefined && !web.startsWith('!')) return { ...base, status: 'ok', text: web };
      const sentence = web?.slice(1) ?? 'The document could not be downloaded (no connection?).';
      if (n.offlineText !== null) {
        return {
          ...base,
          status: 'ok',
          text: n.offlineText,
          fromOffline: true,
          problem: `Showing the saved offline copy. ${sentence}`,
        };
      }
      return { ...base, status: 'offline', text: null, problem: sentence };
    },
    note_write: ({ noteId, content }) => {
      if (ssh.notes.failWrite) {
        const message = ssh.notes.failWrite;
        ssh.notes.failWrite = null;
        throw { code: 'storage', message };
      }
      const n = findNote(noteId);
      n.text = String(content);
      ssh.notes.writes.push({ id: n.id, text: n.text });
    },
    note_rename: ({ noteId, title }) => {
      findNote(noteId).title = String(title).trim();
    },
    note_set_zoom: ({ noteId, zoom }) => {
      const z = Math.min(200, Math.max(50, Number(zoom)));
      findNote(noteId).zoom = z;
      return z;
    },
    note_select: ({ connectionId, noteId }) => {
      ssh.notes.lastSelected[String(connectionId)] = String(noteId);
    },
    note_reorder: ({ connectionId, noteIds }) => {
      const ids = noteIds as string[];
      const mine = ssh.notes.items.filter((n) => n.connections.includes(String(connectionId)));
      const rest = ssh.notes.items.filter((n) => !mine.includes(n));
      const ordered = [
        ...ids.map((i) => mine.find((n) => n.id === i)).filter((n): n is MockNote => !!n),
        ...mine.filter((n) => !ids.includes(n.id)),
      ];
      ssh.notes.items = [...rest, ...ordered];
    },
    note_attach: ({ noteId, connectionId }) => {
      const n = findNote(noteId);
      if (!n.connections.includes(String(connectionId))) n.connections.push(String(connectionId));
    },
    note_detach: ({ noteId, connectionId }) => {
      const n = findNote(noteId);
      n.connections = n.connections.filter((c) => c !== connectionId);
      ssh.notes.detached.push({ id: n.id, connection: String(connectionId) });
    },
    note_delete: ({ noteId }) => {
      ssh.notes.items = ssh.notes.items.filter((n) => n.id !== noteId);
      ssh.notes.deleted.push(String(noteId));
    },
    note_save_offline: ({ noteId }) => {
      const n = findNote(noteId);
      const web = ssh.notes.web[n.source ?? ''];
      if (web === undefined || web.startsWith('!')) {
        throw {
          code: 'validation',
          message: 'The document could not be downloaded (no connection?).',
        };
      }
      n.offlineText = web;
      n.offlineAt = Math.floor(Date.now() / 1000);
      return { savedAt: n.offlineAt, bytes: web.length, format: n.format };
    },
    note_remove_offline: ({ noteId }) => {
      const n = findNote(noteId);
      n.offlineText = null;
      n.offlineAt = null;
    },
    note_open_external: ({ noteId }) => {
      ssh.notes.opened.push(String(noteId));
    },
    note_open_link: ({ url }) => {
      ssh.notes.links.push(String(url));
    },
    update_status: () => ({
      currentVersion: '0.0.0-dev',
      configured: ssh.updates.configured,
      platform: ssh.updates.platform,
      canInstall: ssh.updates.platform !== 'linuxPackage',
      lastCheckAt: ssh.updates.lastCheckAt,
      pending: pendingUpdate,
      downloaded: updateDownloaded,
    }),
    update_check: () => {
      ssh.updates.checks += 1;
      if (!ssh.updates.configured) return { state: 'unavailable', reason: 'not_configured' };
      const outcome = ssh.updates.next;
      if (outcome.state === 'available') pendingUpdate = outcome.info;
      if (outcome.state !== 'unavailable' && outcome.state !== 'busy') {
        ssh.updates.lastCheckAt = Math.floor(Date.now() / 1000);
      }
      return outcome;
    },
    update_download: async (args) => {
      ssh.updates.downloads += 1;
      const send = args.onEvent as { onmessage: ((e: UpdateDownloadEvent) => void) | null };
      if (ssh.updates.hold) {
        await new Promise<void>((resolve) => {
          ssh.updates.release = resolve;
        });
      }
      if (ssh.updates.failDownload) {
        const token = ssh.updates.failDownload;
        ssh.updates.failDownload = null;
        throw { code: 'remote', message: 'The update could not be downloaded.', token };
      }
      for (const event of ssh.updates.downloadEvents) send.onmessage?.(event);
      updateDownloaded = true;
    },
    update_install: () => {
      ssh.updates.installs += 1;
      if (ssh.updates.failInstall) {
        throw { code: 'remote', message: 'The update could not be installed.' };
      }
    },
    update_open_notes: () => {
      ssh.updates.notes += 1;
    },
    monitor_start: (args) => {
      const sessionId = String(args.sessionId);
      const channel = args.onEvent as { onmessage: ((event: MonitorEvent) => void) | null };
      const opened = ssh.opens.find((o) => o.sessionId === sessionId);
      const mode = opened
        ? (findConnection(opened.connectionId).monitoring ?? 'inherit')
        : 'inherit';
      const on = mode === 'inherit' ? settings.monitoring.enabled : mode === 'enabled';
      if (!on) {
        ssh.monitor.stops.push(sessionId);
        return false;
      }
      ssh.monitor.starts.push(sessionId);
      if (channel.onmessage) monitorChannels[sessionId] = channel.onmessage;
      return true;
    },
    monitor_stop: ({ sessionId }) => {
      ssh.monitor.stops.push(String(sessionId));
      delete monitorChannels[String(sessionId)];
    },
    tunnel_counts: () => ({ running: Object.keys(ssh.tunnels.running).length }),
    tunnel_list: ({ connectionId }) =>
      ssh.tunnels.defs
        .filter((d) => d.connectionId === connectionId)
        .map((d) => {
          const owner = ssh.tunnels.running[d.id] ?? null;
          return {
            ...d,
            status: {
              state: owner ? 'listening' : 'stopped',
              ownerSession: owner,
              activeConnections: 0,
              lastError: ssh.tunnels.lastError[d.id] ?? null,
            },
          };
        }),
    tunnel_save: ({ connectionId, input }) => {
      const i = input as TunnelInput;
      const clash = ssh.tunnels.defs.find(
        (d) => d.id !== i.id && d.bindAddress === i.bindAddress && d.localPort === i.localPort,
      );
      if (clash) {
        throw {
          code: 'validation',
          message: `The local port ${i.localPort} is already used by the tunnel "${clash.name}".`,
        };
      }
      if (i.id && ssh.tunnels.running[i.id]) {
        throw { code: 'validation', message: 'Stop the tunnel before editing it.' };
      }
      const def: TunnelDef = {
        id: i.id ?? uuid(),
        connectionId: String(connectionId),
        kind: 'local',
        name: i.name.trim(),
        bindAddress: i.bindAddress,
        localPort: i.localPort,
        remoteHost: i.remoteHost.trim(),
        remotePort: i.remotePort,
        autoStart: i.autoStart,
      };
      const at = ssh.tunnels.defs.findIndex((d) => d.id === def.id);
      if (at >= 0) ssh.tunnels.defs[at] = def;
      else ssh.tunnels.defs.push(def);
      return def;
    },
    tunnel_delete: ({ tunnelId }) => {
      delete ssh.tunnels.running[String(tunnelId)];
      ssh.tunnels.defs = ssh.tunnels.defs.filter((d) => d.id !== tunnelId);
    },
    tunnel_start: ({ sessionId, tunnelId }) => {
      ssh.tunnels.starts.push({ sessionId: String(sessionId), tunnelId: String(tunnelId) });
      if (ssh.tunnels.failStart) {
        const message = ssh.tunnels.failStart;
        ssh.tunnels.failStart = null;
        throw { code: 'validation', message };
      }
      ssh.tunnels.running[String(tunnelId)] = String(sessionId);
    },
    tunnel_stop: ({ tunnelId }) => {
      ssh.tunnels.stops.push(String(tunnelId));
      delete ssh.tunnels.running[String(tunnelId)];
    },
    tunnel_open_browser: ({ tunnelId }) => {
      ssh.tunnels.browser.push(String(tunnelId));
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
        throw {
          code: 'remote',
          message,
          token: message === 'permission_denied' ? message : undefined,
        };
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
        throw {
          code: 'remote',
          message,
          token: message === 'permission_denied' ? message : undefined,
        };
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
    sftp_plan_upload: (args) => {
      ssh.sftp.plans.push({ pickId: String(args.pickId), remoteDir: String(args.remoteDir) });
      const plan = ssh.sftp.nextPlan;
      ssh.sftp.nextPlan = null;
      if (plan instanceof Error)
        throw { code: 'remote', message: plan.message, token: plan.message };
      return (
        plan ?? { files: 1, dirs: 0, bytes: 10, skipped: 0, conflicts: { count: 0, samples: [] } }
      );
    },
    sftp_diagnose_permissions: (args) => {
      ssh.sftp.diagnosed.push(String(args.path));
      const report = ssh.sftp.report;
      if (report instanceof Error) throw report;
      return (
        report ?? {
          platform: 'linux',
          exec: 'ok',
          user: { uid: 1000, gid: 1000, name: 'deploy', groups: [{ gid: 1000, name: 'deploy' }] },
          path: String(args.path),
          pathRefused: false,
          target: { mode: 'drwxr-xr-x', owner: 'root', group: 'root', name: String(args.path) },
          chain: [],
          access: { write: false, search: true },
          unsupported: [],
        }
      );
    },
    sftp_discard_pick: (args) => {
      ssh.sftp.discards.push(String(args.pickId));
    },
    sftp_cancel: (args) => {
      ssh.sftp.cancels.push(String(args.transferId));
    },
    connections_export: ({ ids, includeKeyPaths, notes }) => {
      const list = (ids as string[] | null) ?? tree.connections.map((c) => c.id);
      ssh.portability.exports.push({
        ids: ids as string[] | null,
        includeKeyPaths: Boolean(includeKeyPaths),
        notes: notes as { include: boolean; snapshots: boolean } | undefined,
      });
      return {
        savedTo: '(browser dev mock)/peachterm-connections.json',
        connections: list.length,
        folders: ids === null ? tree.folders.length : 0,
        keyPaths: includeKeyPaths ? list.length : 0,
        notes: (notes as { include?: boolean } | undefined)?.include ? ssh.notes.items.length : 0,
      };
    },
    connections_import_pick: () => {
      const next = ssh.portability.nextImport;
      ssh.portability.nextImport = null;
      return next;
    },
    connections_import_apply: ({ token, options }) => {
      const o = options as { duplicates: string; update: number[]; importNotes?: boolean };
      ssh.portability.imports.push({
        token: String(token),
        duplicates: o.duplicates,
        update: o.update,
        importNotes: o.importNotes,
      });
      return {
        created: 1,
        copied: 0,
        updated: o.update.length,
        skipped: 0,
        failed: 0,
        foldersCreated: 0,
        settingsRestored: false,
        credentials: { restored: 0, replaced: 0, keptExisting: 0, skipped: 0, failed: 0 },
        safetyCopy: false,
        warnings: [],
      } satisfies RestoreResult;
    },
    backup_choose_destination: () => {
      const path = ssh.portability.nextDestination;
      ssh.portability.nextDestination = null;
      return path ? { token: 'dest-1', path } : null;
    },
    backup_create: ({ token, options, passphrase, confirm }) => {
      const o = options as {
        includeSettings: boolean;
        includeCredentials: boolean;
        includeNotes?: boolean;
      };
      ssh.portability.backups.push({
        token: String(token),
        includeSettings: o.includeSettings,
        includeCredentials: o.includeCredentials,
        includeNotes: o.includeNotes,
        passphrase: String(passphrase),
        confirm: String(confirm),
      });
      if (String(passphrase) !== String(confirm)) {
        throw { code: 'validation', message: 'The passphrases do not match.' };
      }
      if (String(passphrase).length < 12) {
        throw {
          code: 'validation',
          message: 'The passphrase must be at least 12 characters long.',
        };
      }
      const withSecret = tree.connections.filter((c) => c.hasStoredSecret).length;
      return {
        savedTo: '(browser dev mock)/peachterm-backup.peachbackup',
        connections: tree.connections.length,
        folders: tree.folders.length,
        settingsIncluded: o.includeSettings,
        credentialsRequested: o.includeCredentials,
        credentialsIncluded: o.includeCredentials ? withSecret : 0,
        credentialsSkipped: 0,
        credentialsUnreadable: 0,
        notesRequested: Boolean(o.includeNotes),
        notesIncluded: o.includeNotes ? ssh.notes.items.length : 0,
        snapshotsIncluded: o.includeNotes
          ? ssh.notes.items.filter((n) => n.offlineText !== null).length
          : 0,
        linkedFiles: o.includeNotes
          ? ssh.notes.items.filter((n) => n.kind === 'localFile').length
          : 0,
        formatVersion: 1,
        sizeBytes: 4096,
        verified: true,
      };
    },
    restore_pick: () => {
      const next = ssh.portability.nextRestoreFile;
      ssh.portability.nextRestoreFile = null;
      return next;
    },
    restore_unlock: ({ token, passphrase }) => {
      ssh.portability.unlocks.push({ token: String(token), passphrase: String(passphrase) });
      if (String(passphrase) !== 'correct horse battery' || !ssh.portability.restorePreview) {
        throw {
          code: 'validation',
          message: 'The passphrase is wrong, or the backup file has been damaged or modified.',
        };
      }
      return ssh.portability.restorePreview;
    },
    restore_apply: ({ token, options }) => {
      ssh.portability.restores.push({
        token: String(token),
        options: options as Record<string, unknown>,
      });
      return (
        ssh.portability.restoreResult ?? {
          created: 1,
          copied: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          foldersCreated: 0,
          settingsRestored: false,
          credentials: { restored: 0, replaced: 0, keptExisting: 0, skipped: 0, failed: 0 },
          safetyCopy: false,
          warnings: [],
        }
      );
    },
    portability_cancel: ({ token }) => {
      ssh.portability.cancels.push(String(token));
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
