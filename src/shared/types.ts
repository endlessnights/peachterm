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
  /** Manual position among siblings; equal values fall back to name order. */
  sortOrder: number;
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
  sortOrder: number;
}

export interface FolderInput {
  id: Uuid | null;
  name: string;
  parentId: Uuid | null;
  expanded: boolean;
}

/** A connection or folder, by stable id. */
export type ItemRef = { kind: 'connection'; id: Uuid } | { kind: 'folder'; id: Uuid };

/** What happens to the contents of deleted folders. */
export type FolderDeleteMode = 'moveToParent' | 'deleteContents';

export interface DeletePlan {
  connectionIds: Uuid[];
  folderIds: Uuid[];
  movedConnections: number;
  movedFolders: number;
}

export interface DeleteOutcome {
  plan: DeletePlan;
  credentialFailures: number;
  tree: ConnectionTree;
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
  diagnostics: {
    fileLogging: boolean;
    level: LogLevel;
    /** Custom log directory; null = platform default. */
    logDir: string | null;
    retentionDays: 7 | 14 | 30;
    maxTotalMb: number;
  };
  security: {
    appLock: {
      /** Takes effect only while a lock password is configured. */
      enabled: boolean;
      /** Minutes of inactivity before locking; 0 = never. */
      inactivityMinutes: 0 | 1 | 5 | 15 | 30;
    };
  };
  /** Shortcut overrides: action id -> accelerator ("" = unassigned). */
  shortcuts: Record<string, string>;
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
  /** Recoverable start-up problems (secret-free, no paths). */
  issues: string[];
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LoggingStatus {
  enabled: boolean;
  level: LogLevel;
  effectiveDir: string;
  customDir: boolean;
  /** Lines are being written to disk right now. */
  active: boolean;
  /** Fixed token explaining why logging is inactive (never a path). */
  error: string | null;
  droppedLines: number;
  fileCount: number;
  totalBytes: number;
  retentionDays: number;
  maxTotalMb: number;
}

export interface LockView {
  /** The lock is on (it can only be on while a password exists). */
  enabled: boolean;
  /** A lock password has been set. */
  configured: boolean;
  locked: boolean;
  lockoutSeconds: number;
  inactivityMinutes: number;
  /** For the lock screen only. */
  theme: ThemeMode;
  accent: Accent;
}

export type UnlockOutcome =
  | { result: 'unlocked' }
  | { result: 'wrong'; attemptsLeftBeforeDelay: number; lockoutSeconds: number }
  | { result: 'lockedOut'; lockoutSeconds: number };

export interface ExportPreview {
  files: { name: string; bytes: number }[];
  totalBytes: number;
}

export interface ExportOutcome {
  /** null when the user cancelled the save dialog. */
  savedTo: string | null;
  entries: { name: string; linesKept: number; linesDropped: number }[];
  archiveBytes: number;
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
  diagnostics: {
    fileLogging: true,
    level: 'info',
    logDir: null,
    retentionDays: 14,
    maxTotalMb: 100,
  },
  security: { appLock: { enabled: false, inactivityMinutes: 0 } },
  shortcuts: {},
  ui: {
    sidebarVisible: true,
    sidebarWidth: 260,
    sftpWidth: 360,
    sftpSide: 'right',
    splitOrientation: 'vertical',
  },
};

// ---- SSH sessions (Phase 2) ------------------------------------------------

export type SessionState =
  'connecting' | 'awaitingHostKey' | 'authenticating' | 'connected' | 'disconnected' | 'failed';

/** Streamed from Rust over a Tauri `Channel`. `data` is base64 of raw bytes. */
export type TerminalEvent =
  | { kind: 'data'; data: string }
  | { kind: 'status'; state: SessionState }
  | { kind: 'closed'; reason: string | null }
  | { kind: 'sftp'; state: SftpState };

export type HostKeyDecision = 'trustOnce' | 'trustAndSave' | 'replace' | 'reject';

export interface AuthPromptLine {
  text: string;
  echo: boolean;
}

/** A question from the SSH layer. Never contains a secret. */
export type SshPrompt =
  | {
      kind: 'hostKey';
      promptId: Uuid;
      sessionId: Uuid;
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
      /** Present when the host key CHANGED since it was trusted. */
      previousFingerprint: string | null;
    }
  | {
      kind: 'auth';
      promptId: Uuid;
      sessionId: Uuid;
      method: 'password' | 'passphrase' | 'keyboardInteractive';
      name: string;
      instructions: string;
      prompts: AuthPromptLine[];
      retry: boolean;
    };

// ---- SFTP (Phase 2) --------------------------------------------------------

export type SftpState = 'pending' | 'ready' | 'unavailable';

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface RemoteEntry {
  name: string;
  path: string;
  kind: EntryKind;
  /** For a symlink: does it point to a directory? */
  targetIsDir: boolean;
  size: number;
  /** Seconds since the Unix epoch. */
  modified: number | null;
  /** POSIX permission bits (no file type). */
  mode: number | null;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: RemoteEntry[];
}

export interface PickedFile {
  name: string;
  size: number;
}

export interface PickedUpload {
  pickId: Uuid;
  files: PickedFile[];
}

export type TransferDirection = 'upload' | 'download';

export type TransferEvent =
  | {
      kind: 'started';
      transferId: Uuid;
      name: string;
      direction: TransferDirection;
      total: number;
      index: number;
      count: number;
    }
  | { kind: 'progress'; transferId: Uuid; done: number; total: number }
  | { kind: 'completed'; transferId: Uuid; bytes: number }
  | { kind: 'failed'; transferId: Uuid; reason: string; message: string }
  | { kind: 'cancelled'; transferId: Uuid }
  | { kind: 'finished' };

// ---- External editor (Phase 2) -----------------------------------------------

export type UserAnswer = 'yes' | 'yesToAll' | 'no' | 'cancel';
export type ConflictChoice = 'overwrite' | 'keepLocal';

export interface OpenedEdit {
  editId: Uuid;
  name: string;
  /** The file was already open in this session; the editor was started again. */
  alreadyOpen: boolean;
}

/** Events of the edit → confirm → upload round trip (names only, no content). */
export type EditorEvent =
  | { kind: 'opened'; editId: Uuid; sessionId: Uuid; name: string; remotePath: string }
  | {
      kind: 'confirm';
      editId: Uuid;
      sessionId: Uuid;
      name: string;
      remotePath: string;
      size: number;
    }
  | { kind: 'uploading'; editId: Uuid; sessionId: Uuid; name: string }
  | { kind: 'uploaded'; editId: Uuid; sessionId: Uuid; name: string; atomic: boolean }
  | {
      kind: 'uploadFailed';
      editId: Uuid;
      sessionId: Uuid;
      name: string;
      reason: string;
      message: string;
    }
  | { kind: 'conflict'; editId: Uuid; sessionId: Uuid; name: string; remotePath: string }
  | { kind: 'declined'; editId: Uuid; sessionId: Uuid; name: string }
  | { kind: 'closed'; editId: Uuid; sessionId: Uuid; name: string; keptLocal: boolean };
