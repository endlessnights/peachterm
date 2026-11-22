// Tab and workspace-layout metadata only. Terminal output never flows through
// this store; each tab's xterm instance receives bytes directly from a Tauri
// Channel.
//
// Identity model (kept strictly apart):
//   * `connectionId` — the SAVED connection (stable, shared by every tab opened
//     from it; this is what "tabs for this host" means).
//   * `id`          — this tab / terminal slot; unique, never reused.
//   * `sessionId`   — the backend SSH session of the current connection attempt;
//     a reconnect inside the same tab gets a new one.

import { create } from 'zustand';
import type { Connection, SftpState, Uuid } from '../../shared/types';

export type TabStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface Tab {
  id: string;
  connectionId: Uuid;
  /** What the tab shows: the user's own name, else the saved connection's name. */
  title: string;
  /** The saved connection's name (kept in sync when the connection is renamed). */
  defaultTitle: string;
  /** Set by the user ("Rename tab"); `null` = follow the saved connection. */
  customTitle: string | null;
  subtitle: string;
  status: TabStatus;
  /** Set by Rust when a connection attempt starts; new on every reconnect. */
  sessionId: string | null;
  /** SFTP availability of the current session (`idle` until one starts). */
  sftp: 'idle' | SftpState;
  /** Restored from a previous run: stays disconnected until the user connects. */
  restored: boolean;
}

export type SplitOrientation = 'vertical' | 'horizontal';

/**
 * Two terminal panes at most (no nesting). `panes[1] === null` means the second
 * pane is still waiting for the user to pick a tab or start a new session.
 */
export interface Split {
  orientation: SplitOrientation;
  /** Share of the space taken by the first pane (0.15 – 0.85). */
  ratio: number;
  panes: [string, string | null];
  /** Which pane has the focus. */
  focus: 0 | 1;
}

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
export const clampRatio = (r: number) =>
  Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5;

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  split: Split | null;
  openTab: (connection: Connection) => string;
  /** New independent session for the same saved connection, next to `id`. */
  duplicateTab: (id: string) => string | null;
  closeTab: (id: string) => void;
  /** Close several tabs at once (one state change). */
  closeTabs: (ids: string[]) => void;
  activate: (id: string) => void;
  activateNext: (direction: 1 | -1) => void;
  moveTab: (fromId: string, toId: string) => void;
  /** `null` or blank resets to the saved connection's name. */
  renameTab: (id: string, title: string | null) => void;
  setStatus: (id: string, status: TabStatus) => void;
  setSession: (id: string, sessionId: string | null) => void;
  setSftp: (id: string, sftp: Tab['sftp']) => void;
  /** A restored tab starts connecting now. */
  markStarted: (id: string) => void;
  /** Keep tab titles in sync when a saved connection is edited or removed. */
  syncConnections: (connections: Connection[]) => void;

  // ---- split view ------------------------------------------------------------
  /** Split the active tab; the second pane waits for a choice. */
  startSplit: (orientation: SplitOrientation) => void;
  /** Put an existing tab (not the first pane's) into the second pane. */
  setSecondPane: (tabId: string) => void;
  /** Open a new session of the first pane's saved connection in the second pane. */
  splitWithNewSession: () => string | null;
  unsplit: () => void;
  toggleOrientation: () => void;
  setRatio: (ratio: number) => void;
  focusPane: (index: 0 | 1) => void;
  focusNextPane: () => void;

  /** Replace the whole layout (restoring a saved workspace). */
  restore: (tabs: Tab[], activeId: string | null, split: Split | null) => void;
}

let counter = 0;
const newTabId = () => `tab-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const isActiveStatus = (status: TabStatus) =>
  status === 'connected' || status === 'connecting';

const describe = (c: Connection) =>
  `${c.username ? `${c.username}@` : ''}${c.host}${c.port === 22 ? '' : `:${c.port}`}`;

const MAX_TITLE = 128;
const cleanTitle = (title: string | null): string | null => {
  const t = [...(title ?? '')]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .trim();
  return t ? t.slice(0, MAX_TITLE) : null;
};

const newTab = (connectionId: Uuid, defaultTitle: string, subtitle: string): Tab => ({
  id: newTabId(),
  connectionId,
  title: defaultTitle,
  defaultTitle,
  customTitle: null,
  subtitle,
  status: 'idle',
  sessionId: null,
  sftp: 'idle',
  restored: false,
});

const insertAfter = (tabs: Tab[], afterId: string | null, tab: Tab): Tab[] => {
  const index = afterId ? tabs.findIndex((t) => t.id === afterId) : -1;
  if (index === -1) return [...tabs, tab];
  return [...tabs.slice(0, index + 1), tab, ...tabs.slice(index + 1)];
};

/** The tab that gets the focus when `removed` tabs disappear: the one that takes the old position. */
function neighbourAfterRemoval(tabs: Tab[], removed: Set<string>, oldIndex: number) {
  const remaining = tabs.filter((t) => !removed.has(t.id));
  if (remaining.length === 0) return null;
  const before = tabs.slice(0, Math.max(0, oldIndex)).filter((t) => !removed.has(t.id)).length;
  return remaining[Math.min(before, remaining.length - 1)]!.id;
}

const activeFromSplit = (split: Split): string => split.panes[split.focus] ?? split.panes[0];

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  split: null,

  openTab: (connection) => {
    // Always a NEW tab and session, also when the same saved connection is
    // already open: any number of independent sessions per saved connection.
    const tab = newTab(connection.id, connection.name, describe(connection));
    set((s) => {
      // A pending second pane (the "pick a tab" state) takes the new tab.
      return { tabs: [...s.tabs, tab], ...place(s, tab.id) };
    });
    return tab.id;
  },

  duplicateTab: (id) => {
    const source = get().tabs.find((t) => t.id === id);
    if (!source) return null;
    const copy: Tab = {
      ...newTab(source.connectionId, source.defaultTitle, source.subtitle),
      customTitle: source.customTitle,
      title: source.title,
    };
    set((s) => ({ tabs: insertAfter(s.tabs, id, copy), ...place(s, copy.id) }));
    return copy.id;
  },

  closeTab: (id) => get().closeTabs([id]),

  closeTabs: (ids) =>
    set((s) => {
      const removed = new Set(ids.filter((id) => s.tabs.some((t) => t.id === id)));
      if (removed.size === 0) return s;
      const tabs = s.tabs.filter((t) => !removed.has(t.id));
      let split = s.split;
      let activeId = s.activeId;
      if (split) {
        const [first, second] = split.panes;
        const firstGone = removed.has(first);
        const secondGone = second !== null && removed.has(second);
        if (firstGone || secondGone) {
          // The split ends; the surviving pane's tab stays open and active.
          const survivor = firstGone ? (second && !secondGone ? second : null) : first;
          split = null;
          if (survivor) activeId = survivor;
        } else {
          activeId = activeFromSplit(split);
        }
      }
      if (!activeId || removed.has(activeId) || !tabs.some((t) => t.id === activeId)) {
        const oldIndex = s.tabs.findIndex((t) => t.id === s.activeId);
        activeId = neighbourAfterRemoval(s.tabs, removed, oldIndex);
      }
      return { tabs, activeId, split };
    }),

  activate: (id) => {
    const s = get();
    if (!s.tabs.some((t) => t.id === id)) return;
    const split = s.split;
    if (!split) return set({ activeId: id });
    const index = split.panes.indexOf(id);
    if (index === 0 || index === 1) {
      return set({ split: { ...split, focus: index as 0 | 1 }, activeId: id });
    }
    // A tab that is not shown takes over the focused pane (sessions keep running).
    const panes: [string, string | null] = [...split.panes];
    panes[split.focus] = id;
    set({ split: { ...split, panes }, activeId: id });
  },

  activateNext: (direction) => {
    const { tabs, activeId } = get();
    if (tabs.length === 0) return;
    const index = tabs.findIndex((t) => t.id === activeId);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next) get().activate(next.id);
  },

  moveTab: (fromId, toId) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === fromId);
      const to = s.tabs.findIndex((t) => t.id === toId);
      if (from === -1 || to === -1 || from === to) return s;
      const tabs = s.tabs.slice();
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved!);
      return { tabs };
    }),

  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const customTitle = cleanTitle(title);
        return { ...t, customTitle, title: customTitle ?? t.defaultTitle };
      }),
    })),

  setStatus: (id, status) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)) })),

  setSession: (id, sessionId) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sessionId } : t)) })),

  setSftp: (id, sftp) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sftp } : t)) })),

  markStarted: (id) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, restored: false } : t)) })),

  syncConnections: (connections) =>
    set((s) => {
      const byId = new Map(connections.map((c) => [c.id, c]));
      let changed = false;
      const tabs = s.tabs.map((t) => {
        const c = byId.get(t.connectionId);
        if (!c) return t; // deleted connection: keep the tab, it still works until closed
        const subtitle = describe(c);
        const title = t.customTitle ?? c.name;
        if (c.name === t.defaultTitle && subtitle === t.subtitle && title === t.title) return t;
        changed = true;
        return { ...t, defaultTitle: c.name, title, subtitle };
      });
      return changed ? { tabs } : s;
    }),

  // ---- split view ------------------------------------------------------------

  startSplit: (orientation) =>
    set((s) => {
      if (!s.activeId) return s;
      if (s.split) return { split: { ...s.split, orientation } };
      return { split: { orientation, ratio: 0.5, panes: [s.activeId, null], focus: 0 } };
    }),

  setSecondPane: (tabId) =>
    set((s) => {
      const split = s.split;
      if (!split || !s.tabs.some((t) => t.id === tabId) || tabId === split.panes[0]) return s;
      return { split: { ...split, panes: [split.panes[0], tabId], focus: 1 }, activeId: tabId };
    }),

  splitWithNewSession: () => {
    const s = get();
    const first = s.split?.panes[0];
    const source = s.tabs.find((t) => t.id === first);
    if (!s.split || !source) return null;
    const copy: Tab = {
      ...newTab(source.connectionId, source.defaultTitle, source.subtitle),
      customTitle: source.customTitle,
      title: source.title,
    };
    set((st) => {
      const split = st.split;
      if (!split) return st;
      return {
        tabs: insertAfter(st.tabs, split.panes[0], copy),
        split: { ...split, panes: [split.panes[0], copy.id], focus: 1 },
        activeId: copy.id,
      };
    });
    return copy.id;
  },

  unsplit: () =>
    set((s) => {
      if (!s.split) return s;
      return { split: null, activeId: activeFromSplit(s.split) };
    }),

  toggleOrientation: () =>
    set((s) =>
      s.split
        ? {
            split: {
              ...s.split,
              orientation: s.split.orientation === 'vertical' ? 'horizontal' : 'vertical',
            },
          }
        : s,
    ),

  setRatio: (ratio) =>
    set((s) => (s.split ? { split: { ...s.split, ratio: clampRatio(ratio) } } : s)),

  focusPane: (index) =>
    set((s) => {
      const split = s.split;
      if (!split || split.focus === index || split.panes[index] === null) return s;
      return { split: { ...split, focus: index }, activeId: split.panes[index]! };
    }),

  focusNextPane: () => {
    const { split } = get();
    if (!split || split.panes[1] === null) return;
    get().focusPane(split.focus === 0 ? 1 : 0);
  },

  restore: (tabs, activeId, split) => set({ tabs, activeId, split }),
}));

/**
 * Where a newly created tab goes: into a waiting second pane if there is one,
 * otherwise it simply becomes the active tab (outside of split view) or takes
 * over the focused pane.
 */
function place(s: TabsState, tabId: string): Partial<TabsState> {
  const split = s.split;
  if (!split) return { activeId: tabId };
  if (split.panes[1] === null) {
    return { split: { ...split, panes: [split.panes[0], tabId], focus: 1 }, activeId: tabId };
  }
  const panes: [string, string | null] = [...split.panes];
  panes[split.focus] = tabId;
  return { split: { ...split, panes }, activeId: tabId };
}

/** Newly created tab objects for restoring a saved workspace. */
export function restoredTab(
  connection: Connection,
  customTitle: string | null,
  autoConnect: boolean,
): Tab {
  const tab = newTab(connection.id, connection.name, describe(connection));
  const custom = cleanTitle(customTitle);
  return {
    ...tab,
    customTitle: custom,
    title: custom ?? connection.name,
    restored: !autoConnect,
  };
}
