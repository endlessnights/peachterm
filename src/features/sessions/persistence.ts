// Saving and restoring the tab layout. Only metadata goes through here: which
// saved connection each tab belongs to, a custom title, the order and the split.
// Restored tabs are NOT connected (unless the user opted in to reconnecting):
// no process is resurrected and no command is replayed. Every new connection
// starts with the remote-write policy "always ask" in the backend.

import { reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import type { Connection, WorkspaceLayout } from '../../shared/types';
import { clampRatio, restoredTab, useTabs, type Split, type Tab } from './store';

export const toLayout = (
  tabs: Tab[],
  activeId: string | null,
  split: Split | null,
): WorkspaceLayout => {
  const index = (id: string | null) => tabs.findIndex((t) => t.id === id);
  const first = split ? index(split.panes[0]) : -1;
  const second = split ? index(split.panes[1]) : -1;
  return {
    tabs: tabs.map((t) => ({ connectionId: t.connectionId, title: t.customTitle })),
    active: index(activeId) >= 0 ? index(activeId) : null,
    // a split that is still waiting for its second pane is not a layout yet
    split:
      split && first >= 0 && second >= 0 && first !== second
        ? {
            orientation: split.orientation,
            ratio: split.ratio,
            panes: [first, second],
            focus: split.focus,
          }
        : null,
  };
};

export function fromLayout(
  layout: WorkspaceLayout,
  connections: Connection[],
  autoConnect: boolean,
): { tabs: Tab[]; activeId: string | null; split: Split | null } {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const map: (number | null)[] = [];
  const tabs: Tab[] = [];
  for (const saved of layout.tabs) {
    const connection = byId.get(saved.connectionId);
    map.push(connection ? tabs.length : null);
    if (connection) tabs.push(restoredTab(connection, saved.title, autoConnect));
  }
  const a = layout.split ? map[layout.split.panes[0]] : null;
  const b = layout.split ? map[layout.split.panes[1]] : null;
  const split: Split | null =
    layout.split && typeof a === 'number' && typeof b === 'number' && a !== b
      ? {
          orientation: layout.split.orientation,
          ratio: clampRatio(layout.split.ratio),
          panes: [tabs[a]!.id, tabs[b]!.id],
          focus: layout.split.focus === 1 ? 1 : 0,
        }
      : null;
  const activeIndex = layout.active === null ? null : (map[layout.active] ?? null);
  const activeId = split
    ? (split.panes[split.focus] ?? split.panes[0])
    : activeIndex !== null
      ? (tabs[activeIndex]?.id ?? null)
      : (tabs[0]?.id ?? null);
  return { tabs, activeId, split };
}

let enabled = false;

/** Load the saved layout into the (empty) workspace and start saving changes. */
export async function restoreWorkspace(
  connections: Connection[],
  autoConnect: boolean,
): Promise<void> {
  try {
    const layout = await ipc.workspaceLoad();
    if (layout.tabs.length > 0 && useTabs.getState().tabs.length === 0) {
      const restored = fromLayout(layout, connections, autoConnect);
      useTabs.getState().restore(restored.tabs, restored.activeId, restored.split);
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
  const unsubscribe = useTabs.subscribe((state, previous) => {
    if (
      state.tabs === previous.tabs &&
      state.activeId === previous.activeId &&
      state.split === previous.split
    ) {
      return;
    }
    // Status/session updates replace `tabs` too; only layout facts matter.
    const layout = (s: typeof state) => JSON.stringify(toLayout(s.tabs, s.activeId, s.split));
    if (layout(state) === layout(previous)) return;
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = useTabs.getState();
      ipc.workspaceSave(toLayout(s.tabs, s.activeId, s.split)).catch(() => undefined);
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
