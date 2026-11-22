// Types mirrored from the Rust backend (src-tauri/src). Keep in sync with docs/ipc.md.

export type Uuid = string;

export type AuthMethod = 'password' | 'publicKey' | 'keyboardInteractive' | 'agent';

export interface Connection {
  id: Uuid;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
  savePassword: boolean;
  /** Computed by Rust. The secret itself never reaches the renderer. */
  hasStoredSecret: boolean;
  timeoutSecs: number;
  initialDirectory: string | null;
  folderId: Uuid | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionInput {
  id: Uuid | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
  savePassword: boolean;
  timeoutSecs: number;
  initialDirectory: string | null;
  folderId: Uuid | null;
}

export interface Folder {
  id: Uuid;
  name: string;
  parentId: Uuid | null;
  expanded: boolean;
}

export interface FolderInput {
  id: Uuid | null;
  name: string;
  parentId: Uuid | null;
  expanded: boolean;
}

export interface ConnectionTree {
  version: number;
  folders: Folder[];
  connections: Connection[];
}

export type ThemeMode = 'dark' | 'light' | 'system';
export type Accent = 'peach' | 'teal' | 'violet' | 'blue';
export type PanelSide = 'left' | 'right';
export type SplitOrientation = 'vertical' | 'horizontal';
export type StartupBehavior = 'empty' | 'restoreTabs';

export interface Settings {
  general: {
    startup: StartupBehavior;
    confirmCloseActive: boolean;
    autoReconnectRestored: boolean;
    language: string;
  };
  appearance: {
    theme: ThemeMode;
    accent: Accent;
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalLineHeight: number;
    scrollback: number;
  };
  ssh: {
    connectTimeoutSecs: number;
    keepaliveSecs: number;
    defaultUsername: string;
    preferredAuth: AuthMethod;
  };
  sftp: {
    defaultPosition: PanelSide;
    defaultVisible: boolean;
    confirmDelete: boolean;
    showHidden: boolean;
  };
  editor: {
    program: string | null;
    args: string[];
    tempDir: string | null;
  };
  ui: {
    sidebarVisible: boolean;
    sidebarWidth: number;
    sftpWidth: number;
    sftpSide: PanelSide;
    splitOrientation: SplitOrientation;
  };
}

export interface CredentialStatus {
  available: boolean;
  backend: string;
  detail: string | null;
}

export interface KnownHost {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  addedAt: number;
}

export interface EditorPreset {
  id: string;
  label: string;
  program: string;
  args: string[];
}

export interface AppInfo {
  name: string;
  version: string;
  os: 'windows' | 'linux' | 'macos';
  arch: string;
}

/** Error shape returned by every command (`AppError` in Rust). */
export interface AppError {
  code: string;
  message: string;
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    startup: 'empty',
    confirmCloseActive: true,
    autoReconnectRestored: false,
    language: 'en',
  },
  appearance: {
    theme: 'dark',
    accent: 'peach',
    terminalFontFamily:
      '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace',
    terminalFontSize: 14,
    terminalLineHeight: 1.2,
    scrollback: 10000,
  },
  ssh: {
    connectTimeoutSecs: 15,
    keepaliveSecs: 30,
    defaultUsername: '',
    preferredAuth: 'password',
  },
  sftp: { defaultPosition: 'right', defaultVisible: true, confirmDelete: true, showHidden: false },
  editor: { program: null, args: ['{file}'], tempDir: null },
  ui: {
    sidebarVisible: true,
    sidebarWidth: 260,
    sftpWidth: 360,
    sftpSide: 'right',
    splitOrientation: 'vertical',
  },
};
