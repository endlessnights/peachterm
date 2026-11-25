// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Entry points to the notes panel: the connection and tab context menus.

import { t } from '../../i18n';
import { promptText } from '../../app/dialogs';
import { notify, reportError } from '../../components/Toasts';
import type { Connection } from '../../shared/types';
import { useTabs } from '../sessions/store';
import { useSettings } from '../settings/store';
import { useNotes } from './store';

/** The auxiliary panel is shared with SFTP: make sure it is open. */
function ensurePanelVisible() {
  const settings = useSettings.getState().settings;
  if (!settings.sftp.defaultVisible) {
    void useSettings
      .getState()
      .save({ ...settings, sftp: { ...settings.sftp, defaultVisible: true } })
      .catch(reportError);
  }
}

/** Show the notes of the SSH tab `tabId` in the auxiliary panel. */
export function showNotesOfTab(tabId: string) {
  useTabs.getState().activate(tabId);
  useNotes.getState().setView('notes');
  ensurePanelVisible();
}

/** "Notes & Documentation" on a saved connection. Needs an open tab to show anything beside. */
export function showNotesOfConnection(connection: Connection) {
  const tab = useTabs
    .getState()
    .tabs.find((t) => t.kind === 'ssh' && t.connectionId === connection.id);
  if (!tab) {
    notify(t('notes.openFirst', { name: connection.name }));
    return;
  }
  showNotesOfTab(tab.id);
}

/** Add a Markdown note to a saved connection (no connection is needed). */
export function addNoteToConnection(connection: Connection) {
  promptText({
    title: t('notes.newNoteFor', { name: connection.name }),
    label: t('notes.titleLabel'),
    initial: '',
    confirmLabel: t('folder.create'),
    validate: (v) => (v.trim() ? null : t('notes.needTitle')),
    onSubmit: (title) => {
      void useNotes
        .getState()
        .createNote(connection.id, title, 'markdown')
        .then((id) => {
          if (id) notify(t('notes.added'));
        });
    },
  });
}
