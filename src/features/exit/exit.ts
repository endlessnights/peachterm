// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Closing the application: one confirmation that says what will be ended.
// Nothing is typed into any shell (`exit` is never sent); sessions are closed
// through their normal teardown by the backend.

import { create } from 'zustand';
import { ipc, isTauri } from '../../shared/ipc';
import { hasActivity, summarizeAll, type ExitSummary } from './activity';

interface ExitState {
  summary: ExitSummary | null;
  cancel: () => void;
}

export const useExit = create<ExitState>((set) => ({
  summary: null,
  cancel: () => set({ summary: null }),
}));

/** Quit now: Rust ends every local shell and SSH session, then exits. */
export function quitNow(): void {
  useExit.setState({ summary: null });
  void ipc.appQuit().catch(() => undefined);
}

/**
 * The user (or the system: window close button, Alt+F4, taskbar) asks to close.
 * With nothing at stake the application just closes; otherwise ask once.
 */
export async function requestExit(): Promise<void> {
  const summary = await summarizeAll();
  if (!hasActivity(summary)) {
    quitNow();
    return;
  }
  useExit.setState({ summary });
}

/** Intercept the native close request. Returns an unsubscribe function. */
export function installCloseHandler(): () => void {
  if (!isTauri()) return () => undefined;
  let stop: (() => void) | undefined;
  let cancelled = false;
  void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
    const un = await getCurrentWindow().onCloseRequested((event) => {
      // never closed behind the user's back
      event.preventDefault();
      void requestExit();
    });
    if (cancelled) un();
    else stop = un;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}
