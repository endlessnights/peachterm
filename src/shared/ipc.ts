// The only module allowed to call Tauri's `invoke` (enforced by ESLint).
// Every backend command is wrapped in a typed function here.

import { Channel, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AppError,
  AppInfo,
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
  LockView,
  UnlockOutcome,
  LoggingStatus,
  Settings,
  SshPrompt,
  TerminalEvent,
  Uuid,
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

  /** Colour the native title bar like the application theme. */
  windowApplyTheme: (
    theme: 'dark' | 'light',
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
  credentialsClearAll: () => call<{ cleared: number }>('credentials_clear_all'),

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
    const channel: { onmessage: ((event: TerminalEvent) => void) | null } = isTauri()
      ? new Channel<TerminalEvent>()
      : { onmessage: null };
    channel.onmessage = onEvent;
    return call<{ sessionId: Uuid }>('ssh_open', {
      connectionId,
      cols,
      rows,
      onEvent: channel,
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
  sshAnswerHostKey: (promptId: Uuid, decision: HostKeyDecision) =>
    call<void>('ssh_answer_host_key', { promptId, decision }),
  /** `answers: null` cancels. Answers go straight to Rust and are never stored. */
  sshAnswerAuth: (promptId: Uuid, answers: string[] | null) =>
    call<void>('ssh_answer_auth', { promptId, answers }),

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

/** Test/dev hook: deliver a prompt as the backend would. */
export function __emitSshPromptForTests(prompt: SshPrompt): void {
  testListeners.forEach((l) => l(prompt));
}

/** Test hook: replace the backend with a custom implementation. */
export function __setBackendForTests(impl: Invoke | null): void {
  backend = impl;
}
