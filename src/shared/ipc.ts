// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The only module allowed to call Tauri's `invoke` (enforced by ESLint).
// Every backend command is wrapped in a typed function here.

import { Channel, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  LocalProfileList,
  AppError,
  AppInfo,
  BackupDestination,
  BackupFileInfo,
  BackupSummary,
  ConnectionsExportOutcome,
  DuplicateChoice,
  ImportPreview,
  RestoreOptions,
  RestorePreview,
  RestoreResult,
  Connection,
  ConnectionInput,
  DeleteOutcome,
  DeletePlan,
  FolderDeleteMode,
  ItemRef,
  ConnectionTree,
  CredentialStatus,
  EditorPreset,
  ExportOutcome,
  ExportPreview,
  Folder,
  FolderInput,
  HostKeyDecision,
  KnownHost,
  ConflictChoice,
  EditorEvent,
  Listing,
  OpenedEdit,
  PickedUpload,
  SftpState,
  TransferEvent,
  LockView,
  UnlockOutcome,
  LoggingStatus,
  Settings,
  SshPrompt,
  TerminalEvent,
  TunnelDef,
  TunnelInput,
  TunnelView,
  UpdateCheckOutcome,
  UpdateDownloadEvent,
  UpdateStatusDto,
  DocFormat,
  NoteContent,
  NotesOverview,
  NoteSummary,
  OfflineMeta,
  UserAnswer,
  Uuid,
  WorkspaceLayout,
} from './types';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let backend: Invoke | null = null;

async function resolveBackend(): Promise<Invoke> {
  if (backend) return backend;
  if (isTauri()) {
    backend = tauriInvoke as Invoke;
  } else if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    // Browser-only UI development (`npm run dev` without Tauri) and tests.
    // Never part of a production bundle.
    const { createMockBackend } = await import('./mockBackend');
    backend = createMockBackend();
  } else {
    throw new Error('PeachTerm must run inside its desktop shell.');
  }
  return backend;
}

/** Normalises any thrown value into the backend's `AppError` shape. */
export function toAppError(error: unknown): AppError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    return error as AppError;
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = await resolveBackend();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toAppError(error);
  }
}

/** A Tauri `Channel` in the desktop shell, a plain object in tests/dev. */
function makeChannel<T>(onEvent: (event: T) => void): { onmessage: ((event: T) => void) | null } {
  const channel: { onmessage: ((event: T) => void) | null } = isTauri()
    ? new Channel<T>()
    : { onmessage: null };
  channel.onmessage = onEvent;
  return channel;
}

export const ipc = {
  appInfo: () => call<AppInfo>('app_info'),
  editorPresets: () => call<EditorPreset[]>('editor_presets'),

  connectionsLoad: () => call<ConnectionTree>('connections_load'),
  connectionsSave: (connection: ConnectionInput) =>
    call<Connection>('connections_save', { connection }),
  connectionsDelete: (id: Uuid) => call<void>('connections_delete', { id }),
  connectionsDuplicate: (id: Uuid) => call<Connection>('connections_duplicate', { id }),
  connectionsMove: (id: Uuid, folderId: Uuid | null) =>
    call<void>('connections_move', { id, folderId }),
  foldersSave: (folder: FolderInput) => call<Folder>('folders_save', { folder }),
  foldersDelete: (id: Uuid) => call<void>('folders_delete', { id }),
  connectionsRename: (id: Uuid, name: string) =>
    call<Connection>('connections_rename', { id, name }),
  foldersRename: (id: Uuid, name: string) => call<Folder>('folders_rename', { id, name }),
  /** Move and/or reorder items; Rust validates cycles and the folder depth limit. */
  treeMove: (items: ItemRef[], targetFolderId: Uuid | null, before: ItemRef | null) =>
    call<ConnectionTree>('tree_move', { items, targetFolderId, before }),
  treeDeletePreview: (items: ItemRef[], mode: FolderDeleteMode) =>
    call<DeletePlan>('tree_delete_preview', { items, mode }),
  treeDelete: (items: ItemRef[], mode: FolderDeleteMode) =>
    call<DeleteOutcome>('tree_delete', { items, mode }),

  // Data portability. Paths come from native dialogs opened by Rust; the renderer
  // never supplies one, and secrets only ever travel renderer -> Rust.
  connectionsExport: (
    ids: Uuid[] | null,
    includeKeyPaths: boolean,
    notes?: { include: boolean; snapshots: boolean },
  ) => call<ConnectionsExportOutcome>('connections_export', { ids, includeKeyPaths, notes }),
  connectionsImportPick: () => call<ImportPreview | null>('connections_import_pick'),
  connectionsImportApply: (
    token: string,
    duplicates: DuplicateChoice,
    update: number[],
    importNotes = false,
  ) =>
    call<RestoreResult>('connections_import_apply', {
      token,
      options: { duplicates, update, importNotes },
    }),
  backupChooseDestination: () => call<BackupDestination | null>('backup_choose_destination'),
  backupCreate: (
    token: string,
    options: { includeSettings: boolean; includeCredentials: boolean; includeNotes?: boolean },
    passphrase: string,
    confirm: string,
  ) => call<BackupSummary>('backup_create', { token, options, passphrase, confirm }),
  restorePick: () => call<BackupFileInfo | null>('restore_pick'),
  restoreUnlock: (token: string, passphrase: string) =>
    call<RestorePreview>('restore_unlock', { token, passphrase }),
  restoreApply: (token: string, options: RestoreOptions) =>
    call<RestoreResult>('restore_apply', { token, options }),
  portabilityCancel: (token: string) => call<void>('portability_cancel', { token }),

  // ---- server notes & documentation (contents only through note_read) ----
  notesCounts: () => call<Record<Uuid, number>>('notes_counts'),
  notesList: (connectionId: Uuid) => call<NotesOverview>('notes_list', { connectionId }),
  notesAll: () => call<NoteSummary[]>('notes_all'),
  noteCreate: (connectionId: Uuid, title: string, format: DocFormat, content?: string) =>
    call<Uuid>('note_create', { connectionId, title, format, content }),
  noteAttachUrl: (connectionId: Uuid, url: string, title?: string) =>
    call<Uuid>('note_attach_url', { connectionId, url, title }),
  /** Opens the native file dialog in Rust; null when the user cancels. */
  noteAttachFile: (connectionId: Uuid) => call<Uuid | null>('note_attach_file', { connectionId }),
  noteRelocate: (noteId: Uuid) => call<boolean>('note_relocate', { noteId }),
  noteRead: (noteId: Uuid) => call<NoteContent>('note_read', { noteId }),
  noteWrite: (noteId: Uuid, content: string) => call<void>('note_write', { noteId, content }),
  noteRename: (noteId: Uuid, title: string) => call<void>('note_rename', { noteId, title }),
  noteSetZoom: (noteId: Uuid, zoom: number) => call<number>('note_set_zoom', { noteId, zoom }),
  noteSelect: (connectionId: Uuid, noteId: Uuid) =>
    call<void>('note_select', { connectionId, noteId }),
  noteReorder: (connectionId: Uuid, noteIds: Uuid[]) =>
    call<void>('note_reorder', { connectionId, noteIds }),
  noteAttach: (noteId: Uuid, connectionId: Uuid) =>
    call<void>('note_attach', { noteId, connectionId }),
  /** Detach from ONE connection; the document stays for the others. */
  noteDetach: (noteId: Uuid, connectionId: Uuid) =>
    call<void>('note_detach', { noteId, connectionId }),
  /** Delete the document everywhere (the UI asks for confirmation first). */
  noteDelete: (noteId: Uuid) => call<void>('note_delete', { noteId }),
  noteSaveOffline: (noteId: Uuid) => call<OfflineMeta>('note_save_offline', { noteId }),
  noteRemoveOffline: (noteId: Uuid) => call<void>('note_remove_offline', { noteId }),
  noteOpenExternal: (noteId: Uuid) => call<void>('note_open_external', { noteId }),
  /** A link clicked inside a document: only http(s) addresses are opened. */
  noteOpenLink: (url: string) => call<void>('note_open_link', { url }),

  /** Colour the native title bar like the application theme. */
  windowApplyTheme: (
    theme: 'dark' | 'light' | 'olive' | 'gray',
    colors: { caption: string; text: string; border: string },
  ) => call<'colored' | 'themeOnly'>('window_apply_theme', { theme, ...colors }),

  lockStatus: () => call<LockView>('lock_status'),
  /** The password goes to Rust and is never stored or logged by the renderer. */
  lockUnlock: (password: string) => call<UnlockOutcome>('lock_unlock', { password }),
  lockNow: () => call<void>('lock_now'),
  lockSetPassword: (newPassword: string, currentPassword?: string) =>
    call<void>('lock_set_password', { newPassword, currentPassword: currentPassword ?? null }),
  lockRemovePassword: (currentPassword: string) =>
    call<void>('lock_remove_password', { currentPassword }),
  lockTouch: () => call<void>('lock_touch'),

  settingsLoad: () => call<Settings>('settings_load'),
  settingsSave: (settings: Settings) => call<Settings>('settings_save', { settings }),

  credentialsStatus: () => call<CredentialStatus>('credentials_status'),
  /** Write-only. There is intentionally no way to read a secret back. */
  credentialsSetPassword: (connectionId: Uuid, secret: string) =>
    call<void>('credentials_set_password', { connectionId, secret }),
  credentialsClear: (connectionId: Uuid) => call<void>('credentials_clear', { connectionId }),
  /** Stage 2: Rust creates a short-lived confirmation (token + small sum). Nothing is deleted. */
  credentialsClearBegin: () =>
    call<{ token: string; question: string; expiresInSecs: number; count: number }>(
      'credentials_clear_begin',
    ),
  credentialsClearCancel: () => call<void>('credentials_clear_cancel'),
  /** Deletes PeachTerm's saved secrets; Rust checks the token and the answer. */
  credentialsClearAll: (token: string, answer: number) =>
    call<{ deleted: number; failed: number }>('credentials_clear_all', { token, answer }),

  knownHostsList: () => call<KnownHost[]>('known_hosts_list'),
  knownHostsRemove: (host: string, port: number) =>
    call<void>('known_hosts_remove', { host, port }),

  /**
   * Start a new SSH session (always a new backend session, also on reconnect).
   * Terminal output arrives through `onEvent`; it never touches a store.
   */
  sshOpen: (
    connectionId: Uuid,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
    attempt = 0,
  ) => {
    return call<{ sessionId: Uuid }>('ssh_open', {
      connectionId,
      cols,
      rows,
      onEvent: makeChannel(onEvent),
      attempt,
    });
  },
  /** `data` is base64 of the bytes to send. */
  sshWrite: (sessionId: Uuid, data: string) => call<void>('ssh_write', { sessionId, data }),
  sshResize: (sessionId: Uuid, cols: number, rows: number) =>
    call<void>('ssh_resize', { sessionId, cols, rows }),
  /** Flow control: the terminal has rendered `bytes` of output. */
  sshAck: (sessionId: Uuid, bytes: number) => call<void>('ssh_ack', { sessionId, bytes }),
  sshClose: (sessionId: Uuid) => call<void>('ssh_close', { sessionId }),
  /** Open one of the fixed project links (by key) in the default browser. */
  openLink: (link: 'github' | 'telegram' | 'repository' | 'notices' | 'license') =>
    call<void>('app_open_link', { link }),
  /** Close the application (ends every session first). */
  appQuit: () => call<void>('app_quit'),

  // ---- in-app updates (official Tauri updater; nothing installs by itself) ----
  updateStatus: () => call<UpdateStatusDto>('update_status'),
  updateCheck: () => call<UpdateCheckOutcome>('update_check'),
  updateDownload: (onEvent: (event: UpdateDownloadEvent) => void) =>
    call<void>('update_download', { onEvent: makeChannel(onEvent) }),
  updateInstall: () => call<void>('update_install'),
  updateOpenNotes: () => call<void>('update_open_notes'),

  // ---- SSH tunnels (local port forwarding) ----
  tunnelList: (connectionId: Uuid) => call<TunnelView[]>('tunnel_list', { connectionId }),
  tunnelSave: (connectionId: Uuid, input: TunnelInput) =>
    call<TunnelDef>('tunnel_save', { connectionId, input }),
  tunnelDelete: (tunnelId: Uuid) => call<void>('tunnel_delete', { tunnelId }),
  tunnelStart: (sessionId: Uuid, tunnelId: Uuid) =>
    call<void>('tunnel_start', { sessionId, tunnelId }),
  tunnelStop: (tunnelId: Uuid) => call<void>('tunnel_stop', { tunnelId }),
  tunnelOpenBrowser: (tunnelId: Uuid) => call<void>('tunnel_open_browser', { tunnelId }),
  /** How many tunnels are running (also while locked: warnings must stay accurate). */
  tunnelCounts: () => call<{ running: number }>('tunnel_counts'),
  // ---- local terminals ----
  localProfiles: () => call<LocalProfileList>('local_profiles'),
  /** Start a local shell by profile id (never a command line). */
  localOpen: (
    profileId: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ) =>
    call<{ sessionId: Uuid }>('local_open', {
      profileId,
      cols,
      rows,
      onEvent: makeChannel(onEvent),
    }),
  localWrite: (sessionId: Uuid, data: string) => call<void>('local_write', { sessionId, data }),
  localResize: (sessionId: Uuid, cols: number, rows: number) =>
    call<void>('local_resize', { sessionId, cols, rows }),
  localAck: (sessionId: Uuid, bytes: number) => call<void>('local_ack', { sessionId, bytes }),
  localClose: (sessionId: Uuid) => call<void>('local_close', { sessionId }),
  sshAnswerHostKey: (promptId: Uuid, decision: HostKeyDecision) =>
    call<void>('ssh_answer_host_key', { promptId, decision }),
  /** `answers: null` cancels. Answers go straight to Rust and are never stored. */
  sshAnswerAuth: (promptId: Uuid, answers: string[] | null) =>
    call<void>('ssh_answer_auth', { promptId, answers }),

  sftpStatus: (sessionId: Uuid) => call<SftpState>('sftp_status', { sessionId }),
  /** `path: null` = the login directory. */
  sftpList: (sessionId: Uuid, path: string | null) =>
    call<Listing>('sftp_list', { sessionId, path }),
  sftpMkdir: (sessionId: Uuid, parent: string, name: string) =>
    call<string>('sftp_mkdir', { sessionId, parent, name }),
  sftpCreateFile: (sessionId: Uuid, parent: string, name: string) =>
    call<string>('sftp_create_file', { sessionId, parent, name }),
  sftpRename: (sessionId: Uuid, path: string, newName: string) =>
    call<string>('sftp_rename', { sessionId, path, newName }),
  sftpDelete: (sessionId: Uuid, path: string) =>
    call<{ removed: number }>('sftp_delete', { sessionId, path }),
  /** Rust asks where to save (native dialog); resolves false if cancelled. */
  sftpDownload: (sessionId: Uuid, remotePath: string, onEvent: (e: TransferEvent) => void) =>
    call<boolean>('sftp_download', { sessionId, remotePath, onEvent: makeChannel(onEvent) }),
  /** Rust shows the native file picker; local paths never reach the renderer. */
  sftpPickUpload: (sessionId: Uuid) => call<PickedUpload | null>('sftp_pick_upload', { sessionId }),
  sftpUpload: (
    sessionId: Uuid,
    pickId: Uuid,
    remoteDir: string,
    overwrite: boolean,
    onEvent: (e: TransferEvent) => void,
  ) =>
    call<void>('sftp_upload', {
      sessionId,
      pickId,
      remoteDir,
      overwrite,
      onEvent: makeChannel(onEvent),
    }),
  sftpCancel: (transferId: Uuid) => call<void>('sftp_cancel', { transferId }),

  /** Download to a private copy, start the external editor, watch for saves. */
  editorOpenRemote: (sessionId: Uuid, remotePath: string) =>
    call<OpenedEdit>('editor_open_remote', { sessionId, remotePath }),
  /** Answer a "Remote file modified" prompt. Rust ignores answers to prompts that are not open. */
  editorAnswer: (editId: Uuid, answer: UserAnswer) =>
    call<boolean>('editor_answer', { editId, answer }),
  editorResolveConflict: (editId: Uuid, choice: ConflictChoice) =>
    call<boolean>('editor_resolve_conflict', { editId, choice }),
  editorRetry: (editId: Uuid) => call<boolean>('editor_retry', { editId }),
  editorStop: (editId: Uuid) => call<void>('editor_stop', { editId }),

  /** The saved tab layout (empty unless "restore tabs" is on). */
  workspaceLoad: () => call<WorkspaceLayout>('workspace_load'),
  workspaceSave: (layout: WorkspaceLayout) => call<void>('workspace_save', { layout }),
  /** Recent saved connection ids, newest first (limited by the setting). */
  recentList: () => call<Uuid[]>('recent_list'),
  recentClear: () => call<void>('recent_clear'),
  /** WebView zoom for the whole interface; returns the percentage that was applied. */
  windowApplyScale: (percent: number) => call<number>('window_apply_scale', { percent }),

  loggingStatus: () => call<LoggingStatus>('logging_status'),
  /** Opens the effective log directory in the OS file manager. */
  loggingOpenDir: () => call<void>('logging_open_dir'),
  loggingExportPreview: () => call<ExportPreview>('logging_export_preview'),
  /** Rust opens the native "save as" dialog; the renderer never chooses the path. */
  loggingExport: () => call<ExportOutcome>('logging_export'),
  loggingRevealExport: () => call<void>('logging_reveal_export'),
};

type PromptListener = (prompt: SshPrompt) => void;
const testListeners = new Set<PromptListener>();

/** Questions from the SSH layer (host keys, credentials). Returns an unsubscribe. */
export function onSshPrompt(listener: PromptListener): () => void {
  if (!isTauri()) {
    testListeners.add(listener);
    return () => testListeners.delete(listener);
  }
  const pending = listen<SshPrompt>('ssh-prompt', (e) => listener(e.payload));
  return () => void pending.then((unlisten) => unlisten());
}

type EditorListener = (event: EditorEvent) => void;
const editorTestListeners = new Set<EditorListener>();

/** Progress of the external-editor round trip. Returns an unsubscribe. */
export function onEditorEvent(listener: EditorListener): () => void {
  if (!isTauri()) {
    editorTestListeners.add(listener);
    return () => editorTestListeners.delete(listener);
  }
  const pending = listen<EditorEvent>('editor-event', (e) => listener(e.payload));
  return () => void pending.then((unlisten) => unlisten());
}

/** Test/dev hook: deliver an editor event as the backend would. */
export function __emitEditorEventForTests(event: EditorEvent): void {
  editorTestListeners.forEach((l) => l(event));
}

/** Test/dev hook: deliver a prompt as the backend would. */
export function __emitSshPromptForTests(prompt: SshPrompt): void {
  testListeners.forEach((l) => l(prompt));
}

/** Test hook: replace the backend with a custom implementation. */
export function __setBackendForTests(impl: Invoke | null): void {
  backend = impl;
}
