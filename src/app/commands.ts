// What each keyboard-shortcut action does. Shortcuts, menus and buttons all go
// through `runAction`, so a binding can be changed without touching the UI.

import { notify } from '../components/Toasts';
import { useConnections } from '../features/connections/store';
import { useTabs } from '../features/sessions/store';
import { requestTerminalSearch } from '../features/terminal/events';
import { useSettings } from '../features/settings/store';
import type { ActionId } from '../shared/shortcuts';
import { useLock } from '../features/lock/store';
import { connect, duplicateTab, newFolder, requestCloseTab } from './actions';
import { openConnectionEditor, openSettings } from './dialogs';

const selectedItem = () => {
  const { tree, selectedId } = useConnections.getState();
  if (!selectedId) return null;
  const connection = tree.connections.find((c) => c.id === selectedId);
  if (connection) return { kind: 'connection' as const, connection };
  const folder = tree.folders.find((f) => f.id === selectedId);
  return folder ? { kind: 'folder' as const, folder } : null;
};

function newTab() {
  const item = selectedItem();
  if (item?.kind === 'connection') return connect(item.connection);
  // No selection: open another session to the same server as the active tab.
  const { tabs, activeId } = useTabs.getState();
  const active = tabs.find((t) => t.id === activeId);
  const connection = active
    ? useConnections.getState().tree.connections.find((c) => c.id === active.connectionId)
    : undefined;
  if (connection) return connect(connection);
  notify('Select a saved connection first (or create one).');
}

function rename() {
  const item = selectedItem();
  if (!item) return notify('Select a connection or folder to rename.');
  useConnections
    .getState()
    .startRename(item.kind === 'folder' ? item.folder.id : item.connection.id);
}

/**
 * Lock now if the lock is set up; otherwise guide the user to set a password
 * instead of "locking" with nothing behind it.
 */
export function lockApplication() {
  const view = useLock.getState().view;
  if (view?.enabled && view.configured) {
    useLock
      .getState()
      .lockNow()
      .catch((e) => notify(e?.message ?? 'Could not lock PeachTerm.'));
    return;
  }
  notify('Set up the application lock first: choose a password in Settings → Security.');
  openSettings('security');
}

export function toggleSidebar() {
  const { settings, setUi, persistUi } = useSettings.getState();
  setUi({ sidebarVisible: !settings.ui.sidebarVisible });
  void persistUi();
}

export function focusSearch() {
  const { settings, setUi } = useSettings.getState();
  if (!settings.ui.sidebarVisible) setUi({ sidebarVisible: true });
  requestAnimationFrame(() => document.getElementById('sidebar-search')?.focus());
}

export function runAction(id: ActionId) {
  switch (id) {
    case 'newTab':
      return newTab();
    case 'newConnection': {
      const item = selectedItem();
      return openConnectionEditor(null, item?.kind === 'folder' ? item.folder.id : null);
    }
    case 'closeTab': {
      const active = useTabs.getState().activeId;
      return active ? requestCloseTab(active) : undefined;
    }
    case 'openSettings':
      return openSettings();
    case 'toggleSidebar':
      return toggleSidebar();
    case 'searchConnections':
      return focusSearch();
    case 'terminalSearch':
      return requestTerminalSearch();
    case 'duplicateTab': {
      const active = useTabs.getState().activeId;
      return active ? duplicateTab(active) : undefined;
    }
    case 'splitVertical':
      return useTabs.getState().startSplit('vertical');
    case 'splitHorizontal':
      return useTabs.getState().startSplit('horizontal');
    case 'toggleSplitOrientation':
      return useTabs.getState().toggleOrientation();
    case 'focusNextPane':
      return useTabs.getState().focusNextPane();
    case 'unsplit':
      return useTabs.getState().unsplit();
    case 'rename':
      return rename();
    case 'lockApp':
      return lockApplication();
    case 'nextTab':
      return useTabs.getState().activateNext(1);
    case 'prevTab':
      return useTabs.getState().activateNext(-1);
  }
}

export { newFolder };
