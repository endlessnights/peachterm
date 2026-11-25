// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Types mirrored from the Rust backend (src-tauri/src). Keep in sync with docs/ipc.md.

export type Uuid = string;

export type AuthMethod = 'password' | 'publicKey' | 'keyboardInteractive' | 'agent';

export type MonitorMode = 'inherit' | 'enabled' | 'disabled';

/** Sanitized readings from the live resource monitor (memory only, never saved). */
export interface MonitorMetrics {
  cpuPercent: number | null;
  load: [number, number, number] | null;
  memory: { usedKib: number; totalKib: number; availableKib: number } | null;
  disk: { usedKib: number; totalKib: number; availableKib: number; percent: number } | null;
  uptimeSecs: number | null;
}

export type MonitorEvent =
  | { kind: 'sample'; metrics: MonitorMetrics }
  | { kind: 'unavailable'; reason: string; permanent: boolean };

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
  /** Live resource monitor preference of this connection. */
  monitoring?: MonitorMode;
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
  monitoring?: MonitorMode;
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

export type ThemeMode = 'dark' | 'light' | 'olive' | 'gray' | 'system';
export type Accent = 'peach' | 'teal' | 'violet' | 'blue';
export type PanelSide = 'left' | 'right';
export type SplitOrientation = 'vertical' | 'horizontal';
export type StartupBehavior = 'empty' | 'restoreTabs';

/** Manual colour overrides (validated `#rrggbb` values only). */
export interface CustomTerminalColors {
  background: string | null;
  foreground: string | null;
  cursor: string | null;
  selectionBackground: string | null;
  /** Exactly 16 colours (normal 0-7, bright 8-15) or null. */
  ansi: string[] | null;
}

export interface TerminalColors {
  /** Follow the application theme (the default). */
  linked: boolean;
  /** The palette used while not linked. */
  preset: string;
  /** Custom colours imply independent mode. */
  custom: CustomTerminalColors | null;
}

/** A user-defined local shell: an absolute executable and fixed arguments. */
export interface CustomShell {
  id: string;
  name: string;
  program: string;
  args: string[];
}

export interface TerminalSettings {
  /** Profile id a plain click on "+" starts; null = the platform default. */
  defaultProfile: string | null;
  /** Preferred WSL distribution. */
  wslDistro: string | null;
  /** Directory new local shells start in; null = the home directory. */
  startDir: string | null;
  customProfiles: CustomShell[];
}

export interface Settings {
  general: {
    startup: StartupBehavior;
    confirmCloseActive: boolean;
    autoReconnectRestored: boolean;
    language: string;
    /** How many recent saved connections the home screen lists (3-20). */
    recentSessionsLimit: number;
    /** The bottom status bar (connection tracking and logging do not depend on it). */
    showStatusBar: boolean;
    /** Look for new versions now and then (never installs by itself). */
    checkUpdates: boolean;
  };
  appearance: {
    theme: ThemeMode;
    accent: Accent;
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalLineHeight: number;
    scrollback: number;
    /** Whole-interface zoom in percent: 70-150, steps of 10. */
    interfaceScale: number;
    /** Terminal palette and how it follows the application theme. */
    terminalColors: TerminalColors;
  };
  ssh: {
    connectTimeoutSecs: number;
    keepaliveSecs: number;
    defaultUsername: string;
    preferredAuth: AuthMethod;
  };
  monitoring: {
    enabled: boolean;
    /** 5, 10 or 30. */
    intervalSecs: number;
    cpu: boolean;
    ram: boolean;
    disk: boolean;
    uptime: boolean;
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
  terminal: TerminalSettings;
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

// ---- in-app updates -------------------------------------------------------

export type UpdatePlatform = 'windows' | 'macos' | 'linuxAppimage' | 'linuxPackage';

export interface UpdateInfo {
  version: string;
  /** Release notes as published (plain text). */
  notes: string | null;
  date: string | null;
}

export interface UpdateStatusDto {
  currentVersion: string;
  /** An update key is built in (official builds); otherwise checks are unavailable. */
  configured: boolean;
  platform: UpdatePlatform;
  /** This installation can be updated in place (not a .deb). */
  canInstall: boolean;
  lastCheckAt: number | null;
  pending: UpdateInfo | null;
  downloaded: boolean;
}

export type UpdateCheckOutcome =
  | { state: 'upToDate' }
  | { state: 'available'; info: UpdateInfo }
  | { state: 'busy' }
  | { state: 'unavailable'; reason: string };

export type UpdateDownloadEvent =
  | { kind: 'started'; total: number | null }
  | { kind: 'progress'; downloaded: number }
  | { kind: 'finished' };

// ---- SSH tunnels (local port forwarding) -------------------------------------

export type TunnelState = 'stopped' | 'starting' | 'listening' | 'connectionUnavailable' | 'error';

export interface TunnelDef {
  id: Uuid;
  connectionId: Uuid;
  kind: 'local';
  name: string;
  /** Always a loopback address. */
  bindAddress: string;
  localPort: number;
  /** Reached from the SSH server's point of view. */
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface TunnelStatus {
  state: TunnelState;
  /** The SSH session (tab) that owns the running listener. */
  ownerSession: Uuid | null;
  activeConnections: number;
  /** Why the latest forwarded connection failed, in one sentence. */
  lastError: string | null;
}

export type TunnelView = TunnelDef & { status: TunnelStatus };

export interface TunnelInput {
  id?: Uuid | null;
  name: string;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
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
  /** English diagnostic text; the interface prefers `key` / `token` when it knows them. */
  message: string;
  /** Stable identifier of a user-facing error, translated by the interface. */
  key?: string;
  params?: Record<string, string>;
  /** Failure token of a remote / transfer / update error. */
  token?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    startup: 'empty',
    confirmCloseActive: true,
    autoReconnectRestored: false,
    language: 'system',
    recentSessionsLimit: 3,
    showStatusBar: true,
    checkUpdates: true,
  },
  appearance: {
    theme: 'dark',
    accent: 'peach',
    terminalFontFamily:
      '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace',
    terminalFontSize: 14,
    terminalLineHeight: 1.2,
    scrollback: 10000,
    interfaceScale: 100,
    terminalColors: { linked: true, preset: 'peachDark', custom: null },
  },
  ssh: {
    connectTimeoutSecs: 15,
    keepaliveSecs: 30,
    defaultUsername: '',
    preferredAuth: 'password',
  },
  monitoring: { enabled: false, intervalSecs: 10, cpu: true, ram: true, disk: true, uptime: true },
  sftp: { defaultPosition: 'right', defaultVisible: true, confirmDelete: true, showHidden: false },
  editor: { program: null, args: ['{file}'], tempDir: null },
  terminal: { defaultProfile: null, wslDistro: null, startDir: null, customProfiles: [] },
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

// ---- Workspace layout and recent sessions ---------------------------------------

/** A shell that can be started locally (never a command line, only an id). */
export interface LocalProfile {
  id: string;
  name: string;
  kind: 'local' | 'wsl';
  /** Where it comes from, e.g. the executable or the WSL distribution. */
  detail: string;
}

/** What `local_profiles` returns. */
export interface LocalProfileList {
  profiles: LocalProfile[];
  /** The profile a plain click on "+" starts. */
  default: string | null;
}

export type SavedNode =
  | { kind: 'leaf'; tab: number }
  | { kind: 'branch'; dir: 'row' | 'column'; ratio: number; a: SavedNode; b: SavedNode };

/** What is remembered about open tabs: metadata only, never a session or a secret. */
export interface WorkspaceLayout {
  tabs: {
    kind: 'ssh' | 'local' | 'wsl';
    connectionId: Uuid | null;
    profileId: string | null;
    /** custom title only */
    title: string | null;
    /** Terminal palette chosen for this tab only (a built-in preset id). */
    colors: string | null;
  }[];
  active: number | null;
  /** The split tree (2 to 6 panes), `null` when there is no split. */
  tree: SavedNode | null;
  /** Index of the tab shown in the focused pane. */
  focus: number | null;
}

export const INTERFACE_SCALES = [70, 80, 90, 100, 110, 120, 130, 140, 150] as const;
export const RECENT_LIMITS = [3, 5, 10, 15, 20] as const;

// ---------------------------------------------------------------------------
// Data portability (connection JSON, encrypted backups)
//
// Everything here is redacted by construction: Rust never sends a password,
// a passphrase or decrypted backup content, only counts and profile summaries.
// ---------------------------------------------------------------------------

export type DuplicateChoice = 'skip' | 'copy' | 'update';
export type KeyPathState = 'none' | 'present' | 'missing' | 'unchecked';
export type ItemStatus = 'new' | 'duplicate' | 'changed';

export interface ConnectionsExportOutcome {
  /** null when the user cancelled the save dialog. */
  savedTo: string | null;
  connections: number;
  folders: number;
  keyPaths: number;
  /** Server notes written into the file (0 unless the user opted in). */
  notes?: number;
}

// ---- server notes & documentation ---------------------------------------------

export type NoteKind = 'internal' | 'localFile' | 'remoteUrl';
export type DocFormat = 'markdown' | 'text' | 'html';

export interface OfflineMeta {
  savedAt: number;
  bytes: number;
  format: DocFormat;
}

/** What the renderer sees of a note: never its content. */
export interface NoteSummary {
  id: Uuid;
  title: string;
  kind: NoteKind;
  format: DocFormat;
  source: string | null;
  createdAt: number;
  updatedAt: number;
  zoom: number;
  offline: OfflineMeta | null;
  /** Attached to more than one connection. */
  shared: boolean;
  /** The other connections it is attached to. */
  sharedWith: Uuid[];
  /** Attached to no connection (kept, never silently deleted). */
  orphan: boolean;
}

export interface NotesOverview {
  notes: NoteSummary[];
  lastSelected: Uuid | null;
}

export type NoteStatus =
  'ok' | 'missing' | 'unreadable' | 'tooLarge' | 'unsupported' | 'offline' | 'error';

export interface NoteContent {
  id: Uuid;
  kind: NoteKind;
  format: DocFormat;
  status: NoteStatus;
  text: string | null;
  /** A sentence about a problem, or about why an offline copy is shown. */
  problem: string | null;
  fromOffline: boolean;
  offline: OfflineMeta | null;
  source: string | null;
}

export interface NotesPreview {
  notes: number;
  internal: number;
  linkedFiles: number;
  webDocuments: number;
  snapshots: number;
  shared: number;
  missingFiles: number;
  conflicts: number;
  unattached: number;
}

export interface NotesMergeResult {
  created: number;
  attachedExisting: number;
  snapshots: number;
  skipped: number;
}

export interface PreviewItem {
  /** Position in the staged file; used to name profiles in the apply call. */
  index: number;
  name: string;
  host: string;
  port: number;
  username: string;
  folderPath: string;
  status: ItemStatus;
  existingName: string | null;
  keyPath: KeyPathState;
  hasCredential: boolean;
}

export interface ImportPreview {
  token: string;
  fileName: string;
  formatVersion: number;
  exportedAt: string | null;
  folderCount: number;
  connectionCount: number;
  newCount: number;
  duplicateCount: number;
  changedCount: number;
  invalidCount: number;
  relocatedCount: number;
  unsupportedFields: string[];
  keyPathsPresent: number;
  keyPathsMissing: number;
  needsKey: number;
  invalid: { kind: 'connection' | 'folder'; index: number; reason: string }[];
  items: PreviewItem[];
  itemsTruncated: boolean;
  /** Present when the file carries server notes (counts only). */
  notes?: NotesPreview | null;
  notesInvalid?: number;
}

export interface BackupDestination {
  token: string;
  path: string;
}

export interface BackupSummary {
  savedTo: string;
  connections: number;
  folders: number;
  settingsIncluded: boolean;
  credentialsRequested: boolean;
  credentialsIncluded: number;
  credentialsSkipped: number;
  credentialsUnreadable: number;
  notesRequested?: boolean;
  notesIncluded?: number;
  /** Offline copies of web documents that went into the backup. */
  snapshotsIncluded?: number;
  /** Linked local files: only their PATHS are in the backup. */
  linkedFiles?: number;
  formatVersion: number;
  sizeBytes: number;
  verified: boolean;
}

export interface BackupFileInfo {
  token: string;
  fileName: string;
  sizeBytes: number;
  formatVersion: number;
}

export interface RestorePreview {
  token: string;
  createdAt: string;
  appVersion: string;
  connectionCount: number;
  folderCount: number;
  invalidCount: number;
  newCount: number;
  duplicateCount: number;
  changedCount: number;
  settingsIncluded: boolean;
  credentialsRequested: boolean;
  credentialCount: number;
  credentialStoreAvailable: boolean;
  keyPathsPresent: number;
  keyPathsMissing: number;
  needsKey: number;
  unsupportedFields: string[];
  items: PreviewItem[];
  itemsTruncated: boolean;
  notes?: NotesPreview | null;
  notesInvalid?: number;
}

export type RestoreMode = 'merge' | 'selected' | 'replace';
export type CredentialConflict = 'keep' | 'replace' | 'skip';

export interface RestoreOptions {
  mode: RestoreMode;
  selected: number[];
  duplicates: DuplicateChoice;
  update: number[];
  restoreSettings: boolean;
  restoreCredentials: boolean;
  /** Add the server notes of the backup (existing notes are never overwritten). */
  restoreNotes?: boolean;
  credentialConflict: CredentialConflict;
  confirmReplaceCredentials: boolean;
  confirmReplaceAll: boolean;
}

export interface RestoreResult {
  created: number;
  copied: number;
  updated: number;
  skipped: number;
  failed: number;
  foldersCreated: number;
  settingsRestored: boolean;
  credentials: {
    restored: number;
    replaced: number;
    keptExisting: number;
    skipped: number;
    failed: number;
  };
  safetyCopy: boolean;
  warnings: string[];
  notes?: NotesMergeResult | null;
}
