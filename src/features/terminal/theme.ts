// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// xterm colours: a palette (see palettes.ts) chosen from the settings, the
// application theme and an optional per-tab override. Only the base colours and
// the indexed ANSI palette are provided here; programs that print their own
// 256-colour or RGB sequences keep exactly those colours.

import type { ITheme } from '@xterm/xterm';
import type { Settings } from '../../shared/types';
import { useSettings } from '../settings/store';
import { buildTheme, effectivePreset } from './palettes';

const accentColor = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f6a07a';

/**
 * The theme for one terminal. `appearance` defaults to what is shown right now
 * (the Settings preview while it is open, else the saved settings);
 * `sessionPreset` is the tab's own palette, if it has one.
 */
export function terminalTheme(
  appearance?: Settings['appearance'],
  sessionPreset: string | null = null,
): ITheme {
  const state = useSettings.getState();
  const a = appearance ?? state.preview ?? state.settings.appearance;
  const id = effectivePreset(a, sessionPreset);
  // Custom colours belong to the global palette; a tab with its own preset ignores them.
  const custom = sessionPreset ? null : a.terminalColors.custom;
  return buildTheme(id, custom, accentColor());
}
