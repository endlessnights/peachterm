// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Live readings of the server resource monitor. Memory only: nothing here is
// persisted, exported or logged, and everything is dropped when the session
// ends, a reconnect starts a new session, or the application locks.

import { create } from 'zustand';
import type { MonitorEvent, MonitorMetrics } from '../../shared/types';

export interface MonitorEntry {
  phase: 'waiting' | 'live' | 'unavailable';
  metrics: MonitorMetrics | null;
  /** When the last sample arrived (renderer clock). */
  at: number | null;
  reason?: string;
  permanent?: boolean;
}

interface MonitorState {
  /** Keyed by backend session id: readings never carry over to a new session. */
  entries: Record<string, MonitorEntry>;
  begin: (sessionId: string) => void;
  apply: (sessionId: string, event: MonitorEvent) => void;
  drop: (sessionId: string) => void;
  clear: () => void;
}

export const useMonitor = create<MonitorState>((set) => ({
  entries: {},
  begin: (sessionId) =>
    set((s) => ({
      entries: { ...s.entries, [sessionId]: { phase: 'waiting', metrics: null, at: null } },
    })),
  apply: (sessionId, event) =>
    set((s) => {
      const current = s.entries[sessionId];
      if (!current) return s; // stopped meanwhile: ignore late events
      if (event.kind === 'sample') {
        return {
          entries: {
            ...s.entries,
            [sessionId]: { phase: 'live', metrics: event.metrics, at: Date.now() },
          },
        };
      }
      // Unavailable: keep the last numbers out of sight; the bar shows no old data as current.
      return {
        entries: {
          ...s.entries,
          [sessionId]: {
            phase: 'unavailable',
            metrics: null,
            at: null,
            reason: event.reason,
            permanent: event.permanent,
          },
        },
      };
    }),
  drop: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.entries)) return s;
      const rest = { ...s.entries };
      delete rest[sessionId];
      return { entries: rest };
    }),
  clear: () => set({ entries: {} }),
}));
