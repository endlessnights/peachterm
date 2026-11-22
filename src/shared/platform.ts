// Platform-aware keyboard shortcuts.
//
// Terminal programs (bash, vim, tmux, nano, mc…) depend on plain Ctrl+<key>
// combinations, so on Windows/Linux application shortcuts use Ctrl+Shift+<key>
// and never steal a bare Ctrl chord. On macOS the Cmd key is free for the app.

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface Shortcut {
  /** `KeyboardEvent.key`, case-insensitive (e.g. "b", ",", "Tab"). */
  key: string;
  /** Allow the bare primary modifier on Windows/Linux (only for keys terminals never use). */
  allowBareCtrl?: boolean;
}

export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut, mac = isMac()): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  if (event.altKey) return false;
  if (mac) return event.metaKey && !event.ctrlKey;
  if (!event.ctrlKey || event.metaKey) return false;
  return shortcut.allowBareCtrl ? true : event.shiftKey;
}

export function shortcutLabel(shortcut: Shortcut, mac = isMac()): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  if (mac) return `⌘${key}`;
  return shortcut.allowBareCtrl ? `Ctrl+${key}` : `Ctrl+Shift+${key}`;
}

export const SHORTCUTS = {
  toggleSidebar: { key: 'b' },
  newConnection: { key: 'n' },
  closeTab: { key: 'w' },
  nextTab: { key: 'Tab', allowBareCtrl: true },
  search: { key: 'f' },
  // Ctrl+, is not a terminal control sequence, so the bare chord is safe.
  settings: { key: ',', allowBareCtrl: true },
} satisfies Record<string, Shortcut>;
