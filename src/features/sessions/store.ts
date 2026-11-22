// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Tab and workspace-layout metadata only. Terminal output never flows through
// this store; each tab's terminal receives bytes directly from the backend.
//
// Identity model (kept strictly apart):
//   * `connectionId` — the SAVED connection (stable, shared by every tab opened
//     from it; this is what "tabs for this host" means).
//   * `id`          — this tab; unique, never reused.
//   * `sessionId`   — the backend session of the current attempt; a reconnect
//     inside the same tab gets a new one.
//   * `kind`        — what the session is (SSH, or a local / WSL shell).
//
// The workspace layout is a split tree (see layout.ts) whose leaves REFERENCE
// tabs. Changing the layout never touches a session.

import { create } from 'zustand';
import type { Connection, SftpState, Uuid } from '../../shared/types';
import {
  MAX_LEAVES,
  countLeaves,
  findLeaf,
  findLeafByTab,
  flip,
  leaves,
  makeBranch,
  makeLeaf,
  parentOf,
  place,
  removeLeaf,
  roomToSplit,
  setLeafTab,
  setRatio,
  shownTabs,
  splitLeaf,
  zoneDir,
  clampRatio,
  ratioLimits,
  type Dir,
  type Node,
  type Zone,
} from './layout';

export type TabStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';

/** What runs behind a tab. */
export type SessionKind = 'ssh' | 'local' | 'wsl';

export interface Tab {
  id: string;
  /** Explicit session type: SFTP exists only for `ssh`. */
  kind: SessionKind;
  /** The SAVED connection (SSH tabs); empty for local shells. */
  connectionId: Uuid;
  /** For local tabs: which shell profile to start (see the local-shell settings). */
  profileId: string | null;
  /** What the tab shows: the user's own name, else the default name. */
  title: string;
  /** The saved connection's name / the shell's name (kept in sync). */
  defaultTitle: string;
  /** Set by the user ("Rename tab"); `null` = follow the default. */
  customTitle: string | null;
  /** Terminal palette for this tab only (preset id); `null` = follow the global setting. */
  colors: string | null;
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

/** Why a layout change was refused (the UI explains it). */
export type SplitResult = 'ok' | 'limit' | 'space' | 'none';

export const SPLIT_REFUSAL: Record<Exclude<SplitResult, 'ok' | 'none'>, string> = {
  limit: `A workspace shows at most ${MAX_LEAVES} panes. Close or hide one first; no session is closed.`,
  space:
    'There is not enough room to split this pane: every pane needs a usable size. Enlarge the window or hide the sidebar. No session is affected.',
};

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  /** The split tree; `null` = a single terminal (the active tab). */
  layout: Node | null;
  /** The focused pane of the layout. */
  focusLeaf: string | null;
  /** Size of the terminal area in CSS pixels (for minimum pane sizes). */
  area: { w: number; h: number };

  openTab: (connection: Connection) => string;
  /** A new tab for a local or WSL shell profile. */
  openLocal: (profile: { id: string; name: string; kind: 'local' | 'wsl' }) => string;
  /** New independent session for the same saved connection / profile, next to `id`. */
  duplicateTab: (id: string) => string | null;
  closeTab: (id: string) => void;
  /** Close several tabs at once (one state change). */
  closeTabs: (ids: string[]) => void;
  activate: (id: string) => void;
  activateNext: (direction: 1 | -1) => void;
  moveTab: (fromId: string, toId: string) => void;
  /** `null` or blank resets to the default name. */
  renameTab: (id: string, title: string | null) => void;
  /** Per-tab terminal palette; `null` follows the global setting. Touches nothing else. */
  setTabColors: (id: string, colors: string | null) => void;
  setStatus: (id: string, status: TabStatus) => void;
  setSession: (id: string, sessionId: string | null) => void;
  setSftp: (id: string, sftp: Tab['sftp']) => void;
  /** A restored tab starts connecting now. */
  markStarted: (id: string) => void;
  /** Keep tab titles in sync when a saved connection is edited or removed. */
  syncConnections: (connections: Connection[]) => void;

  // ---- split view ------------------------------------------------------------
  /** Split the focused pane; the new pane waits for a choice (picker). */
  startSplit: (orientation: SplitOrientation) => SplitResult;
  /** Show an existing tab in a pane (moves it if it is shown elsewhere). */
  fillLeaf: (leafId: string, tabId: string) => void;
  /** Start a NEW session (like the picker's source) in a waiting pane. */
  fillLeafWithNewSession: (leafId: string) => string | null;
  /** Drop a tab on a pane: split towards `zone` (or offer targets for `center`). */
  dropTab: (tabId: string, leafId: string, zone: Exclude<Zone, 'center'>) => SplitResult;
  /** Menu command: show `tabId` in a new pane beside the focused pane. */
  moveTabToNewPane: (tabId: string, side: Exclude<Zone, 'center'>) => SplitResult;
  /** Remove a pane (its tab stays open); the neighbour takes its space. */
  removePane: (leafId: string) => void;
  /** Back to a single terminal. Sessions stay open. */
  unsplit: () => void;
  toggleOrientation: () => void;
  setBranchRatio: (branchId: string, ratio: number) => void;
  focusPane: (leafId: string) => void;
  focusNextPane: () => void;
  setArea: (w: number, h: number) => void;

  /** Replace the whole layout (restoring a saved workspace). */
  restore: (
    tabs: Tab[],
    activeId: string | null,
    layout: Node | null,
    focusLeaf: string | null,
  ) => void;
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

const newTab = (
  kind: SessionKind,
  connectionId: Uuid,
  defaultTitle: string,
  subtitle: string,
  profileId: string | null = null,
): Tab => ({
  id: newTabId(),
  kind,
  connectionId,
  profileId,
  title: defaultTitle,
  defaultTitle,
  customTitle: null,
  colors: null,
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

type Slice = Pick<TabsState, 'layout' | 'focusLeaf' | 'activeId'>;

/** A tree with one leaf is no split: the layout becomes `null`. */
function normalize(
  layout: Node | null,
  focusLeaf: string | null,
  fallbackActive: string | null,
): Slice {
  if (!layout) return { layout: null, focusLeaf: null, activeId: fallbackActive };
  if (layout.kind === 'leaf') {
    return { layout: null, focusLeaf: null, activeId: layout.tabId ?? fallbackActive };
  }
  const all = leaves(layout);
  const focus = all.find((l) => l.id === focusLeaf) ?? all.find((l) => l.tabId) ?? all[0] ?? null;
  return {
    layout,
    focusLeaf: focus?.id ?? null,
    activeId: focus?.tabId ?? fallbackActive,
  };
}

/** Put a freshly created tab where the user is looking. */
function placeNew(s: TabsState, tabId: string): Slice {
  const layout = s.layout;
  if (!layout) return { layout: null, focusLeaf: null, activeId: tabId };
  const all = leaves(layout);
  const waiting = all.find((l) => l.tabId === null);
  const target = waiting ?? all.find((l) => l.id === s.focusLeaf) ?? all[0]!;
  return normalize(setLeafTab(layout, target.id, tabId), target.id, tabId);
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  layout: null,
  focusLeaf: null,
  area: { w: 0, h: 0 },

  openTab: (connection) => {
    // Always a NEW tab and session, also when the same saved connection is
    // already open: any number of independent sessions per saved connection.
    const tab = newTab('ssh', connection.id, connection.name, describe(connection));
    set((s) => ({ tabs: [...s.tabs, tab], ...placeNew(s, tab.id) }));
    return tab.id;
  },

  openLocal: (profile) => {
    const tab = newTab(profile.kind, '', profile.name, 'local shell', profile.id);
    set((s) => ({ tabs: [...s.tabs, tab], ...placeNew(s, tab.id) }));
    return tab.id;
  },

  duplicateTab: (id) => {
    const source = get().tabs.find((t) => t.id === id);
    if (!source) return null;
    const copy: Tab = {
      ...newTab(
        source.kind,
        source.connectionId,
        source.defaultTitle,
        source.subtitle,
        source.profileId,
      ),
      customTitle: source.customTitle,
      colors: source.colors,
      title: source.title,
    };
    set((s) => ({ tabs: insertAfter(s.tabs, id, copy), ...placeNew(s, copy.id) }));
    return copy.id;
  },

  closeTab: (id) => get().closeTabs([id]),

  closeTabs: (ids) =>
    set((s) => {
      const removed = new Set(ids.filter((id) => s.tabs.some((t) => t.id === id)));
      if (removed.size === 0) return s;
      const tabs = s.tabs.filter((t) => !removed.has(t.id));
      let layout = s.layout;
      if (layout) {
        // A pane whose tab is closed disappears; its neighbour takes the space.
        for (const leaf of leaves(layout)) {
          if (leaf.tabId && removed.has(leaf.tabId)) layout = layout && removeLeaf(layout, leaf.id);
        }
      }
      let fallback = s.activeId;
      if (!fallback || removed.has(fallback)) {
        const oldIndex = s.tabs.findIndex((t) => t.id === s.activeId);
        fallback = neighbourAfterRemoval(s.tabs, removed, oldIndex);
      }
      const next = normalize(layout, s.focusLeaf, fallback);
      let activeId = next.activeId;
      if (!activeId || removed.has(activeId) || !tabs.some((t) => t.id === activeId)) {
        activeId =
          fallback && tabs.some((t) => t.id === fallback) ? fallback : (tabs[0]?.id ?? null);
      }
      return { tabs, ...next, activeId };
    }),

  activate: (id) => {
    const s = get();
    if (!s.tabs.some((t) => t.id === id)) return;
    const layout = s.layout;
    if (!layout) return set({ activeId: id });
    const shown = findLeafByTab(layout, id);
    if (shown) return set({ focusLeaf: shown.id, activeId: id });
    // A tab that is not shown takes over the focused pane (sessions keep running).
    const target = findLeaf(layout, s.focusLeaf ?? '') ?? leaves(layout)[0]!;
    set({ layout: setLeafTab(layout, target.id, id), focusLeaf: target.id, activeId: id });
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

  setTabColors: (id, colors) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, colors } : t)) })),

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
        if (t.kind !== 'ssh') return t;
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

  startSplit: (orientation) => {
    const s = get();
    if (!s.activeId) return 'none';
    const dir: Dir = orientation === 'vertical' ? 'row' : 'column';
    const layout = s.layout;
    if (!layout) {
      const first = makeLeaf(s.activeId);
      const picker = makeLeaf(null, s.activeId);
      set({
        layout: makeBranch(dir, first, picker),
        focusLeaf: first.id,
        activeId: s.activeId,
      });
      return 'ok';
    }
    if (countLeaves(layout) >= MAX_LEAVES) return 'limit';
    const target = findLeaf(layout, s.focusLeaf ?? '') ?? leaves(layout)[0]!;
    if (!roomToSplit(layout, target.id, dir, s.area)) return 'space';
    const picker = makeLeaf(null, target.tabId ?? s.activeId);
    set({ layout: splitLeaf(layout, target.id, dir, picker, 'after') });
    return 'ok';
  },

  fillLeaf: (leafId, tabId) =>
    set((s) => {
      const layout = s.layout;
      if (!layout || !s.tabs.some((t) => t.id === tabId) || !findLeaf(layout, leafId)) return s;
      // A session is shown in one place only: it moves, it is not shown twice.
      let next: Node | null = layout;
      const elsewhere = findLeafByTab(layout, tabId);
      if (elsewhere && elsewhere.id !== leafId) next = removeLeaf(layout, elsewhere.id);
      if (!next) return s;
      next = setLeafTab(next, leafId, tabId);
      return normalize(next, leafId, tabId);
    }),

  fillLeafWithNewSession: (leafId) => {
    const s = get();
    const layout = s.layout;
    const leaf = layout ? findLeaf(layout, leafId) : null;
    if (!layout || !leaf) return null;
    const source =
      s.tabs.find((t) => t.id === leaf.sourceTabId) ??
      s.tabs.find((t) => t.id === s.activeId) ??
      s.tabs[0];
    if (!source) return null;
    const copy: Tab = {
      ...newTab(
        source.kind,
        source.connectionId,
        source.defaultTitle,
        source.subtitle,
        source.profileId,
      ),
      customTitle: source.customTitle,
      title: source.title,
    };
    set((st) => {
      const current = st.layout;
      if (!current) return st;
      return {
        tabs: insertAfter(st.tabs, source.id, copy),
        ...normalize(setLeafTab(current, leafId, copy.id), leafId, copy.id),
      };
    });
    return copy.id;
  },

  dropTab: (tabId, leafId, zone) => {
    const s = get();
    if (!s.tabs.some((t) => t.id === tabId)) return 'none';
    const dir = zoneDir(zone)!;
    let layout: Node | null = s.layout;
    if (!layout) {
      // No split yet: the pane being dropped on is the active tab.
      if (!s.activeId || s.activeId === tabId) return 'none';
      const base = makeLeaf(s.activeId);
      layout = base;
      leafId = base.id;
    }
    const target = findLeaf(layout, leafId);
    if (!target) return 'none';
    if (target.tabId === tabId) return 'none'; // dropping a pane on itself
    // Moving a visible tab frees its old pane first.
    const old = findLeafByTab(layout, tabId);
    let working: Node | null = layout;
    if (old) working = removeLeaf(layout, old.id);
    if (!working) return 'none';
    const targetStillThere = findLeaf(working, target.id);
    if (!targetStillThere) return 'none';
    if (countLeaves(working) >= MAX_LEAVES) return 'limit';
    if (!roomToSplit(working, target.id, dir, s.area)) return 'space';
    const fresh = makeLeaf(tabId);
    const next = splitLeaf(
      working,
      target.id,
      dir,
      fresh,
      zone === 'left' || zone === 'top' ? 'before' : 'after',
    );
    set(normalize(next, fresh.id, tabId));
    return 'ok';
  },

  moveTabToNewPane: (tabId, side) => {
    const s = get();
    if (!s.tabs.some((t) => t.id === tabId)) return 'none';
    if (!s.layout) {
      // A single terminal becomes the first pane; the tab becomes the second.
      if (!s.activeId || s.activeId === tabId) return 'none';
      const first = makeLeaf(s.activeId);
      return get().dropTab(tabId, first.id, side);
    }
    const focus = findLeaf(s.layout, s.focusLeaf ?? '') ?? leaves(s.layout)[0]!;
    if (focus.tabId === tabId) {
      // the tab is already the focused pane: use another pane as the anchor
      const other = leaves(s.layout).find((l) => l.id !== focus.id);
      if (!other) return 'none';
      return get().dropTab(tabId, other.id, side);
    }
    return get().dropTab(tabId, focus.id, side);
  },

  removePane: (leafId) =>
    set((s) => {
      if (!s.layout) return s;
      const next = removeLeaf(s.layout, leafId);
      return normalize(next, s.focusLeaf === leafId ? null : s.focusLeaf, s.activeId);
    }),

  unsplit: () =>
    set((s) => {
      if (!s.layout) return s;
      const focus = findLeaf(s.layout, s.focusLeaf ?? '');
      return { layout: null, focusLeaf: null, activeId: focus?.tabId ?? s.activeId };
    }),

  toggleOrientation: () =>
    set((s) => {
      if (!s.layout) return s;
      const parent =
        parentOf(s.layout, s.focusLeaf ?? '') ?? (s.layout.kind === 'branch' ? s.layout : null);
      return parent ? { layout: flip(s.layout, parent.id) } : s;
    }),

  setBranchRatio: (branchId, ratio) =>
    set((s) => {
      if (!s.layout) return s;
      const placed = place(s.layout);
      const entry = placed.branches.find((b) => b.branch.id === branchId);
      if (!entry) return s;
      const { lo, hi } = ratioLimits(entry.branch, entry.rect, s.area);
      return { layout: setRatio(s.layout, branchId, clampRatio(ratio, lo, hi)) };
    }),

  focusPane: (leafId) =>
    set((s) => {
      const leaf = s.layout ? findLeaf(s.layout, leafId) : null;
      if (!leaf || s.focusLeaf === leafId) return s;
      return { focusLeaf: leafId, activeId: leaf.tabId ?? s.activeId };
    }),

  focusNextPane: () => {
    const { layout, focusLeaf } = get();
    if (!layout) return;
    const all = leaves(layout).filter((l) => l.tabId);
    if (all.length < 2) return;
    const index = all.findIndex((l) => l.id === focusLeaf);
    get().focusPane(all[(index + 1) % all.length]!.id);
  },

  setArea: (w, h) => set((s) => (s.area.w === w && s.area.h === h ? s : { area: { w, h } })),

  restore: (tabs, activeId, layout, focusLeaf) =>
    set({ tabs, ...normalize(layout, focusLeaf, activeId ?? tabs[0]?.id ?? null) }),
}));

export { MAX_LEAVES, shownTabs };

/** Newly created tab objects for restoring a saved workspace. */
export function restoredTab(
  saved: {
    kind: SessionKind;
    connectionId: Uuid;
    profileId: string | null;
    defaultTitle: string;
    subtitle: string;
  },
  customTitle: string | null,
  autoConnect: boolean,
  colors: string | null = null,
): Tab {
  const tab = newTab(
    saved.kind,
    saved.connectionId,
    saved.defaultTitle,
    saved.subtitle,
    saved.profileId,
  );
  const custom = cleanTitle(customTitle);
  return {
    ...tab,
    customTitle: custom,
    colors,
    title: custom ?? saved.defaultTitle,
    // Local shells are never started by restoring a workspace on their own.
    restored: !autoConnect || saved.kind !== 'ssh',
  };
}
