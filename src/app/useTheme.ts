// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import { ipc } from '../shared/ipc';
import { titleBarColors, type ResolvedTheme } from '../shared/titleBar';
import type { Settings } from '../shared/types';

let lastTitleBar = '';

/** Tell the backend to colour the native title bar like the current theme. */
function syncTitleBar(theme: ResolvedTheme) {
  const colors = titleBarColors(theme);
  const signature = `${theme}|${colors.caption}|${colors.text}|${colors.border}`;
  if (signature === lastTitleBar) return;
  lastTitleBar = signature;
  ipc.windowApplyTheme(theme, colors).catch(() => {
    lastTitleBar = ''; // retry on the next change
  });
}

/**
 * Apply theme + accent to <html>; "system" follows the OS preference live.
 * The native title bar is updated to match whenever the effective theme or
 * accent changes (including the Settings preview and its cancellation).
 */
export function useTheme(appearance: Settings['appearance']) {
  const { theme, accent } = appearance;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = accent;
    const set = (resolved: ResolvedTheme) => {
      root.dataset.theme = resolved;
      syncTitleBar(resolved);
    };
    if (theme !== 'system') {
      set(theme);
      return;
    }
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => set(query.matches ? 'light' : 'dark');
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme, accent]);
}

/** Test hook: forget what was last sent. */
export function __resetTitleBarCache() {
  lastTitleBar = '';
}
