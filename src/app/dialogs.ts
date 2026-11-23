// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// App-level dialog state, so shortcuts, menus and the sidebar can all open
// the same dialogs without prop drilling.

import { create } from 'zustand';
import type { Connection, ItemRef, Uuid } from '../shared/types';

export type SettingsPage =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'shortcuts'
  | 'ssh'
  | 'sftp'
  | 'security'
  | 'data'
  | 'diagnostics'
  | 'about';

export type DialogState =
  | { kind: 'connection'; connection: Connection | null; folderId: Uuid | null }
  | { kind: 'settings'; page?: SettingsPage }
  | { kind: 'move'; items: ItemRef[] }
  | { kind: 'deleteItems'; items: ItemRef[] }
  | { kind: 'renameTab'; tabId: string }
  | { kind: 'tabColors'; tabId: string }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
    }
  | {
      kind: 'prompt';
      title: string;
      label: string;
      initial: string;
      confirmLabel: string;
      /** Extra line under the field (e.g. where the item will be created). */
      hint?: string;
      /** Return a message to refuse the value; the dialog stays open and shows it. */
      validate?: (value: string) => string | null;
      onSubmit: (value: string) => void;
    };

interface DialogStore {
  dialog: DialogState | null;
  open: (dialog: DialogState) => void;
  close: () => void;
}

export const useDialogs = create<DialogStore>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

export const openConnectionEditor = (connection: Connection | null, folderId: Uuid | null = null) =>
  useDialogs.getState().open({ kind: 'connection', connection, folderId });

export const openSettings = (page?: SettingsPage) =>
  useDialogs.getState().open({ kind: 'settings', page });

export const confirmAction = (options: Omit<Extract<DialogState, { kind: 'confirm' }>, 'kind'>) =>
  useDialogs.getState().open({ kind: 'confirm', ...options });

export const promptText = (options: Omit<Extract<DialogState, { kind: 'prompt' }>, 'kind'>) =>
  useDialogs.getState().open({ kind: 'prompt', ...options });
