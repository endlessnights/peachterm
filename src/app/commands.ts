// What each keyboard-shortcut action does. Shortcuts, menus and buttons all go
// through `runAction`, so a binding can be changed without touching the UI.

import { notify } from '../components/Toasts';
import { useConnections } from '../features/connections/store';
import { useTabs } from '../features/sessions/store';
import { useSettings } from '../features/settings/store';
import type { ActionId } from '../shared/shortcuts';
import { connect, newFolder, renameFolder, requestCloseTab } from './actions';
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
  if (item.kind === 'folder') return renameFolder(item.folder);
  useConnections.getState().startRename(item.connection.id);
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
    case 'rename':
      return rename();
    case 'lockApp':
      return openSettings('security');
    case 'nextTab':
      return useTabs.getState().activateNext(1);
    case 'prevTab':
      return useTabs.getState().activateNext(-1);
  }
}

export { newFolder };
