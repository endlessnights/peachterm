// User-level actions shared by menus, shortcuts and double-clicks.

import { reportError } from '../components/Toasts';
import { useConnections } from '../features/connections/store';
import { isActiveStatus, useTabs } from '../features/sessions/store';
import { useSettings } from '../features/settings/store';
import type { Connection, ItemRef, Uuid } from '../shared/types';
import { confirmAction, promptText, useDialogs } from './dialogs';

export function connect(connection: Connection) {
  // Phase 2 starts the SSH session here; Phase 1 opens the tab only.
  useTabs.getState().openTab(connection);
}

export function requestCloseTab(tabId: string) {
  requestCloseTabs([tabId]);
}

/**
 * Close one or more tabs. Closing only ends the SSH sessions through the normal
 * channel teardown (no `exit` is typed into any shell). ONE confirmation covers
 * the whole batch and says how many sessions are affected.
 */
export function requestCloseTabs(ids: string[]) {
  const tabs = useTabs.getState().tabs.filter((t) => ids.includes(t.id));
  if (tabs.length === 0) return;
  const active = tabs.filter((t) => isActiveStatus(t.status));
  const confirm = useSettings.getState().settings.general.confirmCloseActive;
  const close = () => useTabs.getState().closeTabs(tabs.map((t) => t.id));
  if (active.length >= 2 || (active.length === 1 && confirm)) {
    const single = tabs.length === 1;
    confirmAction({
      title: single ? 'Close active session?' : `Close ${tabs.length} tabs?`,
      message: single
        ? `"${tabs[0]!.title}" is still connected. Closing the tab ends the SSH session.`
        : `${active.length} active SSH session${active.length === 1 ? '' : 's'} will be disconnected` +
          (tabs.length > active.length ? ` (${tabs.length} tabs in total).` : '.'),
      confirmLabel: single ? 'Close tab' : `Close ${tabs.length} tabs`,
      danger: true,
      onConfirm: close,
    });
  } else {
    close();
  }
}

export function closeOtherTabs(tabId: string) {
  requestCloseTabs(
    useTabs
      .getState()
      .tabs.filter((t) => t.id !== tabId)
      .map((t) => t.id),
  );
}

export function closeTabsToTheRight(tabId: string) {
  const { tabs } = useTabs.getState();
  const index = tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return;
  requestCloseTabs(tabs.slice(index + 1).map((t) => t.id));
}

/** Tabs opened from the same SAVED connection (matched by its id, never by name or host). */
export const tabsForSameConnection = (tabId: string) => {
  const { tabs } = useTabs.getState();
  const tab = tabs.find((t) => t.id === tabId);
  return tab ? tabs.filter((t) => t.connectionId === tab.connectionId) : [];
};

export function closeOtherTabsForHost(tabId: string) {
  requestCloseTabs(
    tabsForSameConnection(tabId)
      .filter((t) => t.id !== tabId)
      .map((t) => t.id),
  );
}

export function closeAllTabsForHost(tabId: string) {
  requestCloseTabs(tabsForSameConnection(tabId).map((t) => t.id));
}

export function duplicateTab(tabId: string) {
  useTabs.getState().duplicateTab(tabId);
}

export function renameTabDialog(tabId: string) {
  useDialogs.getState().open({ kind: 'renameTab', tabId });
}

/** One consolidated confirmation for any number of connections and folders. */
export function requestDeleteItems(items: ItemRef[]) {
  if (items.length === 0) return;
  useDialogs.getState().open({ kind: 'deleteItems', items });
}

/** Keyboard-accessible alternative to dragging: pick a destination folder. */
export function requestMoveItems(items: ItemRef[]) {
  if (items.length === 0) return;
  useDialogs.getState().open({ kind: 'move', items });
}

export function duplicateConnection(connection: Connection) {
  useConnections.getState().duplicateConnection(connection.id).catch(reportError);
}

export function newFolder(parentId: Uuid | null) {
  promptText({
    title: 'New folder',
    label: 'Folder name',
    initial: '',
    confirmLabel: 'Create',
    onSubmit: (name) => {
      useConnections
        .getState()
        .saveFolder({ id: null, name, parentId, expanded: true })
        .catch(reportError);
    },
  });
}
