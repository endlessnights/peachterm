import { create } from 'zustand';
import {
  ACTION_IDS,
  DEFAULT_BINDINGS,
  formatAccelerator,
  type ActionId,
} from '../../shared/shortcuts';
import { useSettings } from './store';

/** True while the Settings recorder is capturing a key press: global shortcuts pause. */
export const useRecording = create<{ recording: boolean; set: (v: boolean) => void }>((set) => ({
  recording: false,
  set: (recording) => set({ recording }),
}));

/** The currently effective, display-formatted shortcut of an action ("" when unassigned). */
export function useShortcutLabel(id: ActionId): string {
  const overrides = useSettings((s) => s.settings.shortcuts);
  const accel = overrides[id] ?? DEFAULT_BINDINGS[id];
  return accel ? formatAccelerator(accel) : '';
}

export const knownActions = ACTION_IDS;
