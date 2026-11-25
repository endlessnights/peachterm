// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// State of the external-editor round trip. Content never passes through here:
// only names and the questions Rust asks ("upload this edit?", "the remote
// file changed"). Answers go to Rust, which alone decides what is uploaded.

import { t as tr } from '../../i18n';
import { describeFailure } from '../sftp/model';
import { create } from 'zustand';
import { ipc, onEditorEvent } from '../../shared/ipc';
import { notify, reportError } from '../../components/Toasts';
import type { ConflictChoice, EditorEvent, UserAnswer, Uuid } from '../../shared/types';

export type EditState = 'watching' | 'uploading' | 'uploaded' | 'failed' | 'declined' | 'conflict';

export interface EditInfo {
  editId: Uuid;
  sessionId: Uuid;
  name: string;
  remotePath: string;
  state: EditState;
  note?: string;
}

export type EditorQuestion =
  | {
      kind: 'confirm';
      editId: Uuid;
      sessionId: Uuid;
      name: string;
      remotePath: string;
      size: number;
    }
  | { kind: 'conflict'; editId: Uuid; sessionId: Uuid; name: string; remotePath: string };

interface EditorState {
  edits: Record<Uuid, EditInfo>;
  questions: EditorQuestion[];
  handle: (event: EditorEvent) => void;
  answer: (editId: Uuid, answer: UserAnswer) => Promise<void>;
  resolveConflict: (editId: Uuid, choice: ConflictChoice) => Promise<void>;
  retry: (editId: Uuid) => Promise<void>;
  /** A session ended: its questions and entries are void. */
  dropSession: (sessionId: Uuid) => void;
}

const withoutQuestion = (questions: EditorQuestion[], editId: Uuid) =>
  questions.filter((q) => q.editId !== editId);

export const useEditor = create<EditorState>((set) => {
  const patch = (editId: Uuid, change: Partial<EditInfo>) =>
    set((s) => {
      const current = s.edits[editId];
      return current ? { edits: { ...s.edits, [editId]: { ...current, ...change } } } : s;
    });
  return {
    edits: {},
    questions: [],
    handle: (event) => {
      switch (event.kind) {
        case 'opened':
          set((s) => ({
            edits: {
              ...s.edits,
              [event.editId]: {
                editId: event.editId,
                sessionId: event.sessionId,
                name: event.name,
                remotePath: event.remotePath,
                state: 'watching',
              },
            },
          }));
          break;
        case 'confirm':
          set((s) => ({
            // never two dialogs for one file
            questions: [...withoutQuestion(s.questions, event.editId), { ...event }],
          }));
          break;
        case 'uploading':
          patch(event.editId, { state: 'uploading', note: undefined });
          break;
        case 'uploaded':
          set((s) => ({ questions: withoutQuestion(s.questions, event.editId) }));
          patch(event.editId, {
            state: 'uploaded',
            note: event.atomic ? undefined : tr('editor.notAtomic'),
          });
          notify(tr('editor.uploaded', { name: event.name }));
          break;
        case 'uploadFailed':
          patch(event.editId, { state: 'failed', note: event.message });
          reportError({
            code: event.reason,
            message: tr('editor.uploadFailed', {
              name: event.name,
              reason: failureReason(event.reason, event.message),
            }),
          });
          break;
        case 'conflict':
          set((s) => ({
            questions: [
              ...withoutQuestion(s.questions, event.editId),
              {
                kind: 'conflict',
                editId: event.editId,
                sessionId: event.sessionId,
                name: event.name,
                remotePath: event.remotePath,
              },
            ],
          }));
          patch(event.editId, { state: 'conflict' });
          break;
        case 'declined':
          patch(event.editId, { state: 'declined' });
          break;
        case 'closed':
          set((s) => {
            const rest = { ...s.edits };
            delete rest[event.editId];
            return { edits: rest, questions: withoutQuestion(s.questions, event.editId) };
          });
          if (event.keptLocal) {
            notify(`${event.name} had changes that were not uploaded; the local copy was kept.`);
          }
          break;
      }
    },
    answer: async (editId, answer) => {
      set((s) => ({ questions: withoutQuestion(s.questions, editId) }));
      try {
        await ipc.editorAnswer(editId, answer);
      } catch (error) {
        reportError(error);
      }
    },
    resolveConflict: async (editId, choice) => {
      set((s) => ({ questions: withoutQuestion(s.questions, editId) }));
      try {
        await ipc.editorResolveConflict(editId, choice);
      } catch (error) {
        reportError(error);
      }
    },
    retry: async (editId) => {
      try {
        await ipc.editorRetry(editId);
      } catch (error) {
        reportError(error);
      }
    },
    dropSession: (sessionId) =>
      set((s) => ({
        questions: s.questions.filter((q) => q.sessionId !== sessionId),
        edits: Object.fromEntries(
          Object.entries(s.edits).filter(([, e]) => e.sessionId !== sessionId),
        ),
      })),
  };
});

export function listenForEditor(): () => void {
  return onEditorEvent((event) => useEditor.getState().handle(event));
}

/** A localized reason for known failure tokens; otherwise the backend's own short message. */
function failureReason(token: string, fallback: string): string {
  const known = describeFailure(token);
  return known === tr('sftp.failure.other') ? fallback : known;
}
