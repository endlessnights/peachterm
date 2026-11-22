// User-level actions shared by menus, shortcuts and double-clicks.

import { reportError } from '../components/Toasts';
import { useConnections } from '../features/connections/store';
import { isActiveStatus, useTabs } from '../features/sessions/store';
import { useSettings } from '../features/settings/store';
import type { Connection, Folder, Uuid } from '../shared/types';
import { confirmAction, promptText } from './dialogs';

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

export function requestDeleteConnection(connection: Connection) {
  confirmAction({
    title: 'Delete connection',
    message: `Delete "${connection.name}" (${connection.host})? Its saved password, if any, is removed from the system keychain.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => {
      useConnections.getState().deleteConnection(connection.id).catch(reportError);
    },
  });
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

export function renameFolder(folder: Folder) {
  promptText({
    title: 'Rename folder',
    label: 'Folder name',
    initial: folder.name,
    confirmLabel: 'Rename',
    onSubmit: (name) => {
      useConnections
        .getState()
        .saveFolder({ ...folder, name })
        .catch(reportError);
    },
  });
}

export function requestDeleteFolder(folder: Folder) {
  confirmAction({
    title: 'Delete folder',
    message: `Delete the folder "${folder.name}"? Its connections and sub-folders are kept and move up one level.`,
    confirmLabel: 'Delete folder',
    danger: true,
    onConfirm: () => {
      useConnections.getState().deleteFolder(folder.id).catch(reportError);
    },
  });
}
