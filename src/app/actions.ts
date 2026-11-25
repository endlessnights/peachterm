// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// User-level actions shared by menus, shortcuts and double-clicks.

import { reportError } from '../components/Toasts';
import { useConnections } from '../features/connections/store';
import { isActiveStatus, useTabs } from '../features/sessions/store';
import { useSettings } from '../features/settings/store';
import type { Connection, ItemRef, Uuid } from '../shared/types';
import { confirmAction, promptText, useDialogs } from './dialogs';
import { t } from '../i18n';

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
    const total = tabs.length > active.length ? tabs.length : null;
    confirmAction({
      title: single ? t('closeTabs.titleSingle') : t('closeTabs.titleMany', { count: tabs.length }),
      message: single
        ? tabs[0]!.kind === 'ssh'
          ? t('closeTabs.sshOne', { title: tabs[0]!.title })
          : t('closeTabs.localOne', { title: tabs[0]!.title })
        : active.every((t) => t.kind === 'ssh')
          ? total
            ? t('closeTabs.sshTotal', { count: active.length, total })
            : t('closeTabs.ssh', { count: active.length })
          : total
            ? t('closeTabs.anyTotal', { count: active.length, total })
            : t('closeTabs.any', { count: active.length }),
      confirmLabel: single
        ? t('closeTabs.confirmSingle')
        : t('closeTabs.confirmMany', { count: tabs.length }),
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
  if (!tab) return [];
  // local shells belong to no saved connection: "the same host" is just themselves
  if (tab.kind !== 'ssh') return [tab];
  return tabs.filter((t) => t.kind === 'ssh' && t.connectionId === tab.connectionId);
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

/** Open a new local terminal (a shell by profile id; the backend decides how it starts). */
export function openLocalShell(profile: { id: string; name: string; kind: 'local' | 'wsl' }) {
  return useTabs.getState().openLocal(profile);
}

export function duplicateTab(tabId: string) {
  useTabs.getState().duplicateTab(tabId);
}

export function tabColorsDialog(tabId: string) {
  useDialogs.getState().open({ kind: 'tabColors', tabId });
}

export function tunnelsDialog(tabId: string) {
  useDialogs.getState().open({ kind: 'tunnels', tabId });
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
    title: t('folder.newTitle'),
    label: t('folder.name'),
    initial: '',
    confirmLabel: t('folder.create'),
    onSubmit: (name) => {
      useConnections
        .getState()
        .saveFolder({ id: null, name, parentId, expanded: true })
        .catch(reportError);
    },
  });
}
