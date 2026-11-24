// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Server notes, renderer side. Note CONTENT only exists here while it is shown
// (it is fetched through `note_read`, cleared when the application locks) and as
// unsaved drafts. Edits are autosaved a moment after typing stops; a failed save
// keeps the draft, says so, and offers a retry: nothing the user typed is
// discarded without their say.

import { create } from 'zustand';
import { reportError } from '../../components/Toasts';
import { ipc, toAppError } from '../../shared/ipc';
import type { DocFormat, NoteContent, NotesOverview, NoteSummary, Uuid } from '../../shared/types';
import { useActivity } from '../exit/activity';
import { useLock } from '../lock/store';

export const AUTOSAVE_MS = 800;

export interface Draft {
  text: string;
  state: 'unsaved' | 'saving' | 'failed';
  error: string | null;
}

export type ContentEntry =
  | { status: 'loading' }
  | { status: 'ready'; data: NoteContent }
  | { status: 'failed'; message: string };

interface NotesState {
  /** Notes per connection (numbers only; drives the small indicator). */
  counts: Record<Uuid, number>;
  overview: Record<Uuid, NotesOverview | undefined>;
  content: Record<Uuid, ContentEntry | undefined>;
  drafts: Record<Uuid, Draft | undefined>;
  /** What the auxiliary panel shows. */
  view: 'files' | 'notes';

  setView: (view: 'files' | 'notes') => void;
  refreshCounts: () => Promise<void>;
  load: (connectionId: Uuid) => Promise<NotesOverview | null>;
  loadContent: (noteId: Uuid, force?: boolean) => Promise<void>;
  select: (connectionId: Uuid, noteId: Uuid) => Promise<void>;
  createNote: (
    connectionId: Uuid,
    title: string,
    format: Exclude<DocFormat, 'html'>,
  ) => Promise<Uuid | null>;
  attachUrl: (connectionId: Uuid, url: string, title?: string) => Promise<Uuid | null>;
  attachFile: (connectionId: Uuid) => Promise<Uuid | null>;
  attachExisting: (connectionId: Uuid, noteId: Uuid) => Promise<void>;
  rename: (connectionId: Uuid, noteId: Uuid, title: string) => Promise<void>;
  detach: (connectionId: Uuid, noteId: Uuid) => Promise<void>;
  remove: (connectionId: Uuid, noteId: Uuid) => Promise<void>;
  move: (connectionId: Uuid, noteId: Uuid, delta: -1 | 1) => Promise<void>;
  setZoom: (connectionId: Uuid, noteId: Uuid, zoom: number) => Promise<void>;
  saveOffline: (connectionId: Uuid, noteId: Uuid) => Promise<void>;
  removeOffline: (connectionId: Uuid, noteId: Uuid) => Promise<void>;
  relocate: (connectionId: Uuid, noteId: Uuid) => Promise<void>;
  edit: (noteId: Uuid, text: string) => void;
  flush: (noteId: Uuid) => Promise<boolean>;
  flushAll: () => Promise<boolean>;
  /** Forget everything that was fetched (the application locked). */
  forgetContent: () => void;
}

const timers = new Map<Uuid, ReturnType<typeof setTimeout>>();

const message = (error: unknown) => toAppError(error).message;

export const useNotes = create<NotesState>((set, get) => {
  const syncUnsaved = () => {
    const any = Object.values(get().drafts).some(Boolean);
    useActivity.getState().setUnsaved('notes', any);
  };
  const setDraft = (noteId: Uuid, draft: Draft | undefined) => {
    set((s) => {
      const drafts = { ...s.drafts };
      if (draft) drafts[noteId] = draft;
      else delete drafts[noteId];
      return { drafts };
    });
    syncUnsaved();
  };
  const reload = async (connectionId: Uuid) => {
    await Promise.all([get().load(connectionId), get().refreshCounts()]);
  };
  const guarded = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  return {
    counts: {},
    overview: {},
    content: {},
    drafts: {},
    view: 'files',

    setView: (view) => set({ view }),

    refreshCounts: async () => {
      try {
        set({ counts: await ipc.notesCounts() });
      } catch {
        /* locked: the next refresh will do */
      }
    },

    load: async (connectionId) => {
      try {
        const overview = await ipc.notesList(connectionId);
        set((s) => ({ overview: { ...s.overview, [connectionId]: overview } }));
        return overview;
      } catch {
        return null;
      }
    },

    loadContent: async (noteId, force = false) => {
      const current = get().content[noteId];
      if (!force && current && current.status !== 'failed') return;
      set((s) => ({ content: { ...s.content, [noteId]: { status: 'loading' } } }));
      try {
        const data = await ipc.noteRead(noteId);
        set((s) => ({ content: { ...s.content, [noteId]: { status: 'ready', data } } }));
      } catch (error) {
        set((s) => ({
          content: { ...s.content, [noteId]: { status: 'failed', message: message(error) } },
        }));
      }
    },

    select: async (connectionId, noteId) => {
      await get().flushAll();
      set((s) => {
        const o = s.overview[connectionId];
        return o
          ? { overview: { ...s.overview, [connectionId]: { ...o, lastSelected: noteId } } }
          : s;
      });
      void get().loadContent(noteId);
      await guarded(() => ipc.noteSelect(connectionId, noteId));
    },

    createNote: async (connectionId, title, format) => {
      const id = await guarded(() => ipc.noteCreate(connectionId, title, format, ''));
      if (id) {
        await reload(connectionId);
        void get().loadContent(id, true);
      }
      return id;
    },

    attachUrl: async (connectionId, url, title) => {
      const id = await guarded(() => ipc.noteAttachUrl(connectionId, url, title));
      if (id) {
        await reload(connectionId);
        void get().loadContent(id, true);
      }
      return id;
    },

    attachFile: async (connectionId) => {
      const id = await guarded(() => ipc.noteAttachFile(connectionId));
      if (id) {
        await reload(connectionId);
        void get().loadContent(id, true);
      }
      return id;
    },

    attachExisting: async (connectionId, noteId) => {
      await guarded(() => ipc.noteAttach(noteId, connectionId));
      await reload(connectionId);
      await get().select(connectionId, noteId);
    },

    rename: async (connectionId, noteId, title) => {
      await guarded(() => ipc.noteRename(noteId, title));
      await reload(connectionId);
    },

    detach: async (connectionId, noteId) => {
      await get().flush(noteId);
      await guarded(() => ipc.noteDetach(noteId, connectionId));
      await reload(connectionId);
    },

    remove: async (connectionId, noteId) => {
      timers.delete(noteId);
      setDraft(noteId, undefined);
      await guarded(() => ipc.noteDelete(noteId));
      set((s) => {
        const content = { ...s.content };
        delete content[noteId];
        return { content };
      });
      await reload(connectionId);
    },

    move: async (connectionId, noteId, delta) => {
      const list = get().overview[connectionId]?.notes ?? [];
      const at = list.findIndex((n) => n.id === noteId);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= list.length) return;
      const ids = list.map((n) => n.id);
      [ids[at], ids[to]] = [ids[to]!, ids[at]!];
      await guarded(() => ipc.noteReorder(connectionId, ids));
      await get().load(connectionId);
    },

    setZoom: async (connectionId, noteId, zoom) => {
      // show it at once; the backend remembers it (and clamps it to 50-200)
      set((s) => {
        const o = s.overview[connectionId];
        if (!o) return s;
        const notes = o.notes.map((n) => (n.id === noteId ? { ...n, zoom } : n));
        return { overview: { ...s.overview, [connectionId]: { ...o, notes } } };
      });
      await guarded(() => ipc.noteSetZoom(noteId, zoom));
    },

    saveOffline: async (connectionId, noteId) => {
      await guarded(() => ipc.noteSaveOffline(noteId));
      await reload(connectionId);
      await get().loadContent(noteId, true);
    },

    removeOffline: async (connectionId, noteId) => {
      await guarded(() => ipc.noteRemoveOffline(noteId));
      await reload(connectionId);
      await get().loadContent(noteId, true);
    },

    relocate: async (connectionId, noteId) => {
      const changed = await guarded(() => ipc.noteRelocate(noteId));
      if (changed) {
        await reload(connectionId);
        await get().loadContent(noteId, true);
      }
    },

    edit: (noteId, text) => {
      setDraft(noteId, { text, state: 'unsaved', error: null });
      const old = timers.get(noteId);
      if (old) clearTimeout(old);
      timers.set(
        noteId,
        setTimeout(() => {
          timers.delete(noteId);
          void get().flush(noteId);
        }, AUTOSAVE_MS),
      );
    },

    flush: async (noteId) => {
      const timer = timers.get(noteId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(noteId);
      }
      const draft = get().drafts[noteId];
      if (!draft) return true;
      if (draft.state === 'saving') return false;
      const sent = draft.text;
      setDraft(noteId, { ...draft, state: 'saving', error: null });
      try {
        await ipc.noteWrite(noteId, sent);
      } catch (error) {
        const latest = get().drafts[noteId];
        setDraft(noteId, { text: latest?.text ?? sent, state: 'failed', error: message(error) });
        return false;
      }
      set((s) => {
        const entry = s.content[noteId];
        return entry?.status === 'ready'
          ? {
              content: {
                ...s.content,
                [noteId]: { status: 'ready', data: { ...entry.data, text: sent } },
              },
            }
          : s;
      });
      const latest = get().drafts[noteId];
      if (latest && latest.text !== sent) {
        // typing continued while saving: save the newer text too
        setDraft(noteId, { ...latest, state: 'unsaved' });
        return get().flush(noteId);
      }
      setDraft(noteId, undefined);
      return true;
    },

    flushAll: async () => {
      const ids = Object.keys(get().drafts);
      const results = await Promise.all(ids.map((id) => get().flush(id)));
      return results.every(Boolean);
    },

    forgetContent: () => {
      set({ content: {}, overview: {}, counts: {} });
    },
  };
});

// Locking forgets everything that was fetched. Unsaved drafts are kept (they are
// the user's own work and saving needs the unlocked application), but nothing is
// written while locked; the autosave simply fails and is retried.
useLock.subscribe((state, previous) => {
  if (state.view?.locked && !previous.view?.locked) useNotes.getState().forgetContent();
});

/** The summary of one note of a connection. */
export const noteOf = (
  overview: NotesOverview | undefined,
  noteId: Uuid | null | undefined,
): NoteSummary | undefined => overview?.notes.find((n) => n.id === noteId);
