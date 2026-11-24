// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// What would be lost if the application closed right now. Only counts: no
// names, hosts or paths are kept here.

import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import { useEditor } from '../editor/store';
import { useTabs } from '../sessions/store';

interface ActivityState {
  /** Running transfers per SFTP panel (keyed by tab id). */
  transfers: Record<string, number>;
  /** Dialogs holding edits that were not saved, by name ("settings", "connection"). */
  unsaved: Record<string, boolean>;
  setTransfers: (key: string, running: number) => void;
  setUnsaved: (key: string, unsaved: boolean) => void;
}

export const useActivity = create<ActivityState>((set) => ({
  transfers: {},
  unsaved: {},
  setTransfers: (key, running) =>
    set((s) => {
      if ((s.transfers[key] ?? 0) === running) return s;
      const transfers = { ...s.transfers };
      if (running === 0) delete transfers[key];
      else transfers[key] = running;
      return { transfers };
    }),
  setUnsaved: (key, unsaved) =>
    set((s) => {
      if (!!s.unsaved[key] === unsaved) return s;
      const next = { ...s.unsaved };
      if (unsaved) next[key] = true;
      else delete next[key];
      return { unsaved: next };
    }),
}));

export interface ExitSummary {
  sshActive: number;
  localActive: number;
  connecting: number;
  transfers: number;
  pendingUploads: number;
  /** Running SSH tunnels (they end with the application). */
  tunnels: number;
  unsavedConnection: boolean;
  unsavedSettings: boolean;
  /** Typed in a note and not saved yet. */
  unsavedNotes: boolean;
}

export const hasActivity = (s: ExitSummary) =>
  s.sshActive + s.localActive + s.connecting + s.transfers + s.pendingUploads + s.tunnels > 0 ||
  s.unsavedConnection ||
  s.unsavedSettings ||
  s.unsavedNotes;

export function summarize(): ExitSummary {
  const { tabs } = useTabs.getState();
  const { transfers, unsaved } = useActivity.getState();
  const editor = useEditor.getState();
  const pending = new Set<string>(editor.questions.map((q) => q.editId));
  for (const edit of Object.values(editor.edits)) {
    if (edit.state === 'uploading' || edit.state === 'conflict') pending.add(edit.editId);
  }
  return {
    sshActive: tabs.filter((t) => t.kind === 'ssh' && t.status === 'connected').length,
    localActive: tabs.filter((t) => t.kind !== 'ssh' && t.status === 'connected').length,
    connecting: tabs.filter((t) => t.status === 'connecting').length,
    transfers: Object.values(transfers).reduce((a, b) => a + b, 0),
    pendingUploads: pending.size,
    tunnels: 0,
    unsavedConnection: !!unsaved.connection,
    unsavedSettings: !!unsaved.settings,
    unsavedNotes: !!unsaved.notes,
  };
}

/** Like [`summarize`], with the running tunnels counted by the backend. */
export async function summarizeAll(): Promise<ExitSummary> {
  const summary = summarize();
  try {
    summary.tunnels = (await ipc.tunnelCounts()).running;
  } catch {
    /* unknown: the warning simply leaves tunnels out */
  }
  return summary;
}
