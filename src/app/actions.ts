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
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const confirm = useSettings.getState().settings.general.confirmCloseActive;
  if (confirm && isActiveStatus(tab.status)) {
    confirmAction({
      title: 'Close active session?',
      message: `"${tab.title}" is still connected. Closing the tab ends the SSH session.`,
      confirmLabel: 'Close tab',
      danger: true,
      onConfirm: () => useTabs.getState().closeTab(tabId),
    });
  } else {
    useTabs.getState().closeTab(tabId);
  }
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
