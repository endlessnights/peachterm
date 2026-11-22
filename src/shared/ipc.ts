// The only module allowed to call Tauri's `invoke` (enforced by ESLint).
// Every backend command is wrapped in a typed function here.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
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
  KnownHost,
  LockView,
  UnlockOutcome,
  LoggingStatus,
  Settings,
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

  loggingStatus: () => call<LoggingStatus>('logging_status'),
  /** Opens the effective log directory in the OS file manager. */
  loggingOpenDir: () => call<void>('logging_open_dir'),
  loggingExportPreview: () => call<ExportPreview>('logging_export_preview'),
  /** Rust opens the native "save as" dialog; the renderer never chooses the path. */
  loggingExport: () => call<ExportOutcome>('logging_export'),
  loggingRevealExport: () => call<void>('logging_reveal_export'),
};

/** Test hook: replace the backend with a custom implementation. */
export function __setBackendForTests(impl: Invoke | null): void {
  backend = impl;
}
