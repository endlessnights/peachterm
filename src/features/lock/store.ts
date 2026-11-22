// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import type { LockView, UnlockOutcome } from '../../shared/types';

interface LockState {
  /** null until the first status has been read. */
  view: LockView | null;
  refresh: () => Promise<LockView>;
  /** Backend event or local confirmation that the lock engaged/released. */
  setLocked: (locked: boolean) => void;
  /** Engage the lock. The backend decides; the overlay follows its answer. */
  lockNow: () => Promise<void>;
  unlock: (password: string) => Promise<UnlockOutcome>;
}

export const useLock = create<LockState>((set, get) => ({
  view: null,
  refresh: async () => {
    const view = await ipc.lockStatus();
    set({ view });
    return view;
  },
  setLocked: (locked) => set((s) => (s.view ? { view: { ...s.view, locked } } : s)),
  lockNow: async () => {
    await ipc.lockNow();
    await get().refresh();
  },
  unlock: async (password) => {
    const outcome = await ipc.lockUnlock(password);
    await get().refresh();
    return outcome;
  },
}));

export const isLocked = () => useLock.getState().view?.locked === true;
