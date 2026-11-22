// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The shells this machine can start (from Rust: detected, never typed in).
import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import type { LocalProfile } from '../../shared/types';

interface ProfilesState {
  profiles: LocalProfile[];
  /** The profile a plain click on "+" starts. */
  defaultId: string | null;
  loaded: boolean;
  loading: boolean;
  /** Detect again (also what "Refresh profiles" in Settings uses). */
  refresh: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useProfiles = create<ProfilesState>((set) => ({
  profiles: [],
  defaultId: null,
  loaded: false,
  loading: false,
  refresh: () => {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = ipc
      .localProfiles()
      .then((list) => set({ profiles: list.profiles, defaultId: list.default, loaded: true }))
      .catch(() => set({ loaded: true }))
      .finally(() => {
        inflight = null;
        set({ loading: false });
      });
    return inflight;
  },
}));

/** The profile "+" starts: the configured default, else the first one found. */
export function defaultProfile(): LocalProfile | null {
  const { profiles, defaultId } = useProfiles.getState();
  return profiles.find((p) => p.id === defaultId) ?? profiles[0] ?? null;
}
