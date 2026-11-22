// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Saving and restoring the tab layout. Only metadata goes through here: which
// saved connection (or local shell profile) each tab belongs to, a custom title,
// the order and the split tree. Restored tabs are NOT connected (unless the
// user opted in to reconnecting SSH tabs): no process is resurrected and no
// command is replayed. Every new connection starts with the remote-write
// policy "always ask" in the backend.

import { reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import { isPresetId } from '../terminal/palettes';
import type { Connection, LocalProfile, SavedNode, WorkspaceLayout } from '../../shared/types';
import {
  MAX_LEAVES,
  clampRatio,
  countLeaves,
  depth,
  findLeaf,
  leaves,
  makeBranch,
  makeLeaf,
  type Node,
} from './layout';
import { restoredTab, useTabs, type Tab } from './store';

/** The persisted form of the live tree: pickers are dropped, a lone pane is no split. */
function saveNode(node: Node, indexOf: (tabId: string) => number): SavedNode | null {
  if (node.kind === 'leaf') {
    const i = node.tabId ? indexOf(node.tabId) : -1;
    return i >= 0 ? { kind: 'leaf', tab: i } : null;
  }
  const a = saveNode(node.a, indexOf);
  const b = saveNode(node.b, indexOf);
  if (a && b) return { kind: 'branch', dir: node.dir, ratio: node.ratio, a, b };
  return a ?? b;
}

const countSaved = (n: SavedNode): number =>
  n.kind === 'leaf' ? 1 : countSaved(n.a) + countSaved(n.b);

const safeColors = (id: string | null | undefined) => (isPresetId(id) ? id : null);

export const toLayout = (
  tabs: Tab[],
  activeId: string | null,
  layout: Node | null,
  focusLeaf: string | null,
): WorkspaceLayout => {
  const index = (id: string | null) => tabs.findIndex((t) => t.id === id);
  const tree = layout ? saveNode(layout, index) : null;
  const focusTab = layout && focusLeaf ? findLeaf(layout, focusLeaf)?.tabId : null;
  return {
    tabs: tabs.map((t) => ({
      kind: t.kind,
      connectionId: t.kind === 'ssh' ? t.connectionId : null,
      profileId: t.kind === 'ssh' ? null : t.profileId,
      title: t.customTitle,
      colors: t.colors,
    })),
    active: index(activeId) >= 0 ? index(activeId) : null,
    tree: tree && countSaved(tree) >= 2 ? tree : null,
    focus:
      tree && countSaved(tree) >= 2 && focusTab && index(focusTab) >= 0 ? index(focusTab) : null,
  };
};

function loadNode(node: SavedNode, tabIds: (number | null)[], used: Set<number>): Node | null {
  if (node.kind === 'leaf') {
    const id = tabIds[node.tab];
    if (typeof id !== 'number' || used.has(node.tab)) return null;
    used.add(node.tab);
    return makeLeaf(String(node.tab));
  }
  const a = loadNode(node.a, tabIds, used);
  const b = loadNode(node.b, tabIds, used);
  if (a && b) return makeBranch(node.dir, a, b, clampRatio(node.ratio));
  return a ?? b;
}

export function fromLayout(
  layout: WorkspaceLayout,
  connections: Connection[],
  autoConnect: boolean,
  profiles: LocalProfile[] = [],
): { tabs: Tab[]; activeId: string | null; layout: Node | null; focusLeaf: string | null } {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  const map: (number | null)[] = [];
  const tabs: Tab[] = [];
  for (const saved of layout.tabs) {
    let tab: Tab | null = null;
    if (saved.kind === 'ssh') {
      const c = saved.connectionId ? byId.get(saved.connectionId) : undefined;
      if (c) {
        tab = restoredTab(
          {
            kind: 'ssh',
            connectionId: c.id,
            profileId: null,
            defaultTitle: c.name,
            subtitle: `${c.username ? `${c.username}@` : ''}${c.host}${c.port === 22 ? '' : `:${c.port}`}`,
          },
          saved.title,
          autoConnect,
          safeColors(saved.colors),
        );
      }
    } else if (saved.profileId) {
      const p = byProfile.get(saved.profileId);
      tab = restoredTab(
        {
          kind: saved.kind,
          connectionId: '',
          profileId: saved.profileId,
          defaultTitle: p?.name ?? saved.profileId,
          subtitle: 'local shell',
        },
        saved.title,
        false, // a local shell is never started by restoring
        safeColors(saved.colors),
      );
    }
    map.push(tab ? tabs.length : null);
    if (tab) tabs.push(tab);
  }

  // The saved tree refers to saved tab positions; rebuild it with the new tab ids.
  let tree: Node | null = null;
  if (layout.tree) {
    const used = new Set<number>();
    const built = loadNode(layout.tree, map, used);
    const rewrite = (n: Node): Node =>
      n.kind === 'leaf'
        ? { ...n, tabId: tabs[map[Number(n.tabId)]!]!.id }
        : { ...n, a: rewrite(n.a), b: rewrite(n.b) };
    tree = built ? rewrite(built) : null;
    if (tree && (countLeaves(tree) < 2 || countLeaves(tree) > MAX_LEAVES || depth(tree) > 6)) {
      tree = null;
    }
  }
  const focusTab =
    layout.focus !== null && map[layout.focus] != null ? tabs[map[layout.focus]!]! : null;
  const focusLeaf =
    tree && focusTab ? (leaves(tree).find((l) => l.tabId === focusTab.id)?.id ?? null) : null;
  const activeIndex = layout.active === null ? null : (map[layout.active] ?? null);
  const activeId =
    focusTab && tree
      ? focusTab.id
      : activeIndex !== null
        ? (tabs[activeIndex]?.id ?? null)
        : (tabs[0]?.id ?? null);
  return { tabs, activeId, layout: tree, focusLeaf };
}

let enabled = false;

/** Load the saved layout into the (empty) workspace and start saving changes. */
export async function restoreWorkspace(
  connections: Connection[],
  autoConnect: boolean,
  profiles: LocalProfile[] = [],
): Promise<void> {
  try {
    const layout = await ipc.workspaceLoad();
    if (layout.tabs.length > 0 && useTabs.getState().tabs.length === 0) {
      const restored = fromLayout(layout, connections, autoConnect, profiles);
      useTabs
        .getState()
        .restore(restored.tabs, restored.activeId, restored.layout, restored.focusLeaf);
    }
  } catch (error) {
    reportError(error);
  } finally {
    enabled = true;
  }
}

/** Save the layout shortly after every change (debounced). */
export function startWorkspacePersistence(delayMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const snapshot = (s: ReturnType<typeof useTabs.getState>) =>
    toLayout(s.tabs, s.activeId, s.layout, s.focusLeaf);
  const unsubscribe = useTabs.subscribe((state, previous) => {
    if (
      state.tabs === previous.tabs &&
      state.activeId === previous.activeId &&
      state.layout === previous.layout &&
      state.focusLeaf === previous.focusLeaf
    ) {
      return;
    }
    // Status/session updates replace `tabs` too; only layout facts matter.
    if (JSON.stringify(snapshot(state)) === JSON.stringify(snapshot(previous))) return;
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      ipc.workspaceSave(snapshot(useTabs.getState())).catch(() => undefined);
    }, delayMs);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

/** Test hook. */
export const __setPersistenceEnabled = (value: boolean) => {
  enabled = value;
};
