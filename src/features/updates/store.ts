// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// In-app updates, renderer side. The backend (official Tauri updater) does the
// network work and the signature check; this store only drives the steps and
// keeps the user in control: nothing downloads or installs without a click, and
// installing asks first when sessions, tunnels, transfers or edits would be lost.

import { t as tr } from '../../i18n';
import { create } from 'zustand';
import { ipc, toAppError } from '../../shared/ipc';
import type { UpdateInfo, UpdateStatusDto } from '../../shared/types';
import { hasActivity, summarizeAll, type ExitSummary } from '../exit/activity';
import { isLocked } from '../lock/store';

export type UpdatePhase =
  | 'idle'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'failed'
  | 'unavailable';

/** Fixed failure tokens from the backend, as one calm sentence each. */
const PROBLEM_TOKENS = [
  'not_configured',
  'network',
  'no_package',
  'signature',
  'bad_metadata',
  'install_failed',
] as const;

/** A fixed, localized sentence for a failure token (never the raw error). */
export function updateProblem(token: string | null): string {
  if (token === 'timeout') return tr('update.problem.network');
  return (PROBLEM_TOKENS as readonly string[]).includes(token ?? '')
    ? tr(`update.problem.${token as (typeof PROBLEM_TOKENS)[number]}`)
    : tr('update.problem.default');
}

interface Progress {
  downloaded: number;
  /** Unknown when the server does not announce a length: then no percentage is shown. */
  total: number | null;
}

interface UpdatesState {
  phase: UpdatePhase;
  checking: boolean;
  status: UpdateStatusDto | null;
  info: UpdateInfo | null;
  progress: Progress | null;
  /** Fixed token of the last failure (turned into a sentence only when shown). */
  problem: string | null;
  /** The compact notification is open. */
  noticeOpen: boolean;
  /** The version the notification was already shown for (once per version per run). */
  notified: string | null;
  /** The pre-install warning (what would be lost), while it is shown. */
  confirm: ExitSummary | null;

  refresh: () => Promise<void>;
  check: (manual: boolean) => Promise<void>;
  download: () => Promise<void>;
  requestInstall: () => Promise<void>;
  cancelInstall: () => void;
  install: () => Promise<void>;
  openNotes: () => void;
  openNotice: () => void;
  closeNotice: () => void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  phase: 'idle',
  checking: false,
  status: null,
  info: null,
  progress: null,
  problem: null,
  noticeOpen: false,
  notified: null,
  confirm: null,

  refresh: async () => {
    try {
      const status = await ipc.updateStatus();
      set((s) => ({
        status,
        info: status.pending ?? s.info,
        phase:
          s.phase === 'idle' || s.phase === 'unavailable'
            ? status.downloaded
              ? 'ready'
              : status.pending
                ? 'available'
                : status.configured
                  ? 'idle'
                  : 'unavailable'
            : s.phase,
        problem: !status.configured && s.phase === 'idle' ? 'not_configured' : s.problem,
      }));
    } catch {
      /* locked or backend not ready: the next refresh will do */
    }
  },

  check: async (manual) => {
    const s = get();
    // never overlap a check, a download or an install; automatic checks also
    // leave a downloaded update alone
    if (s.checking || s.phase === 'downloading' || s.phase === 'installing') return;
    if (!manual && s.phase === 'ready') return;
    if (isLocked()) return;
    set({ checking: true, ...(manual ? { problem: null } : {}) });
    try {
      const outcome = await ipc.updateCheck();
      switch (outcome.state) {
        case 'upToDate':
          set({ phase: 'upToDate', info: null, problem: null });
          break;
        case 'available': {
          const first = get().notified !== outcome.info.version;
          set({
            phase: get().phase === 'ready' ? 'ready' : 'available',
            info: outcome.info,
            problem: null,
            notified: outcome.info.version,
            // shown once per version and run; "Later" leaves only the small indicator
            noticeOpen: first ? true : get().noticeOpen,
          });
          break;
        }
        case 'busy':
          break;
        case 'unavailable':
          // an automatic check fails quietly; a manual one says why
          if (manual || outcome.reason === 'not_configured') {
            set({
              phase: outcome.reason === 'not_configured' ? 'unavailable' : 'failed',
              problem: outcome.reason,
            });
          }
          break;
      }
    } catch (error) {
      if (manual) set({ phase: 'failed', problem: toAppError(error).code });
    } finally {
      set({ checking: false });
    }
    void get().refresh();
  },

  download: async () => {
    const s = get();
    if (s.phase !== 'available') return;
    set({ phase: 'downloading', progress: { downloaded: 0, total: null }, problem: null });
    try {
      await ipc.updateDownload((event) => {
        if (event.kind === 'started') {
          set({ progress: { downloaded: 0, total: event.total } });
        } else if (event.kind === 'progress') {
          set((st) => ({
            progress: { downloaded: event.downloaded, total: st.progress?.total ?? null },
          }));
        }
      });
      set({ phase: 'ready', progress: null });
    } catch (error) {
      const e = toAppError(error) as { code: string; message: string; token?: string };
      set({ phase: 'available', progress: null, problem: e.token ?? 'failed' });
    }
  },

  requestInstall: async () => {
    if (get().phase !== 'ready') return;
    const summary = await summarizeAll();
    if (hasActivity(summary)) set({ confirm: summary });
    else await get().install();
  },

  cancelInstall: () => set({ confirm: null }),

  install: async () => {
    if (get().phase !== 'ready') return;
    set({ confirm: null, phase: 'installing', noticeOpen: false });
    try {
      await ipc.updateInstall();
      // The application restarts; if we are still running, the installer took over.
    } catch (error) {
      const e = toAppError(error) as { code: string; message: string };
      set({ phase: 'failed', problem: e.code === 'remote' ? 'install_failed' : 'failed' });
    }
  },

  openNotes: () => {
    void ipc.updateOpenNotes().catch(() => undefined);
  },
  openNotice: () => set({ noticeOpen: true }),
  closeNotice: () => set({ noticeOpen: false }),
}));

/** The small indicator near Settings: only while something is waiting for the user. */
export const hasPendingUpdate = (phase: UpdatePhase) =>
  phase === 'available' || phase === 'downloading' || phase === 'ready';

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Automatic checks: once shortly after start, then about every 24 hours while the
 * application runs. No retry loop: a failed automatic check simply waits for the
 * next one. Returns a function that stops the timers.
 */
export function startUpdateChecks(enabled: () => boolean): () => void {
  const run = () => {
    if (enabled()) void useUpdates.getState().check(false);
  };
  const first = setTimeout(run, FIRST_CHECK_MS);
  const every = setInterval(run, EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
