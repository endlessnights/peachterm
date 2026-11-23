// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { create } from 'zustand';
import type { Zone } from './layout';

/**
 * What is being dragged and where it would land. The preview is shown while
 * the tab is still held, so the result is visible before the button is released.
 */
interface DragState {
  tabId: string | null;
  preview: { leafId: string; zone: Zone; valid: boolean; reason?: string } | null;
  /** After a drop on the middle of a pane: which split the user wants. */
  chooser: { tabId: string; leafId: string } | null;
  set: (patch: Partial<Pick<DragState, 'tabId' | 'preview' | 'chooser'>>) => void;
}

export const useDrag = create<DragState>((set) => ({
  tabId: null,
  preview: null,
  chooser: null,
  set: (patch) => set(patch),
}));

/** Pane ids used by the droppables; the single (unsplit) pane has a fixed id. */
export const SINGLE_PANE = 'single';
export const paneDropId = (leafId: string) => `pane:${leafId}`;
