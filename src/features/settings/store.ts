import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /** Persist a full settings object (Rust normalises and returns it). */
  save: (next: Settings) => Promise<Settings>;
  /** Update UI layout state locally; call `persistUi` when an interaction ends. */
  setUi: (patch: Partial<Settings['ui']>) => void;
  persistUi: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    set({ settings: await ipc.settingsLoad(), loaded: true });
  },
  save: async (next) => {
    const saved = await ipc.settingsSave(next);
    set({ settings: saved });
    return saved;
  },
  setUi: (patch) =>
    set((s) => ({ settings: { ...s.settings, ui: { ...s.settings.ui, ...patch } } })),
  persistUi: async () => {
    const saved = await ipc.settingsSave(get().settings);
    set({ settings: saved });
  },
}));
