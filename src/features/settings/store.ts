// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** Settings as loaded at start-up: used to tell which changes need a restart. */
  startupSnapshot: Settings | null;
  /** Unsaved appearance being previewed by the Settings dialog (null = none). */
  preview: Settings['appearance'] | null;
  load: () => Promise<void>;
  /** Persist a full settings object (Rust validates, normalises and returns it). */
  save: (next: Settings) => Promise<Settings>;
  setPreview: (appearance: Settings['appearance'] | null) => void;
  /** Update UI layout state locally; call `persistUi` when an interaction ends. */
  setUi: (patch: Partial<Settings['ui']>) => void;
  persistUi: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  startupSnapshot: null,
  preview: null,
  load: async () => {
    const settings = await ipc.settingsLoad();
    set((s) => ({ settings, loaded: true, startupSnapshot: s.startupSnapshot ?? settings }));
  },
  save: async (next) => {
    const saved = await ipc.settingsSave(next);
    set({ settings: saved });
    return saved;
  },
  setPreview: (preview) => set({ preview }),
  setUi: (patch) =>
    set((s) => ({ settings: { ...s.settings, ui: { ...s.settings.ui, ...patch } } })),
  persistUi: async () => {
    const saved = await ipc.settingsSave(get().settings);
    set({ settings: saved });
  },
}));
