// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// User-level split commands: they run the store action and explain a refusal
// (never silently, and never by closing anything).

import { notify } from '../../components/Toasts';
import { SPLIT_REFUSAL, useTabs, type SplitOrientation, type SplitResult } from './store';
import type { Zone } from './layout';

export function explain(result: SplitResult): SplitResult {
  if (result === 'limit' || result === 'space') notify(SPLIT_REFUSAL[result]);
  return result;
}

export const splitFocused = (orientation: SplitOrientation) =>
  explain(useTabs.getState().startSplit(orientation));

export const dropTab = (tabId: string, leafId: string, zone: Exclude<Zone, 'center'>) =>
  explain(useTabs.getState().dropTab(tabId, leafId, zone));

export const moveToNewPane = (tabId: string, side: Exclude<Zone, 'center'>) =>
  explain(useTabs.getState().moveTabToNewPane(tabId, side));
