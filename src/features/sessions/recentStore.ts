// Recent successful connections, newest first. The list itself lives in Rust
// (it is recorded after a successful login); this store only mirrors it. Ids
// are saved-connection ids, so renames show up automatically and deleted
// connections disappear.

import { create } from 'zustand';
import { reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import type { Uuid } from '../../shared/types';

interface RecentState {
  ids: Uuid[];
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
}

export const useRecent = create<RecentState>((set) => ({
  ids: [],
  refresh: async () => {
    try {
      set({ ids: await ipc.recentList() });
    } catch {
      /* the list is a convenience; keep what is shown */
    }
  },
  clear: async () => {
    try {
      await ipc.recentClear();
      set({ ids: [] });
    } catch (error) {
      reportError(error);
    }
  },
}));
