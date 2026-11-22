// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Questions the SSH layer asks while connecting (host keys, credentials).
// They arrive as backend events and are answered through IPC. Answers (which
// can be passwords) are passed straight to Rust and never stored here.

import { create } from 'zustand';
import { ipc, onSshPrompt } from '../../shared/ipc';
import { reportError } from '../../components/Toasts';
import type { HostKeyDecision, SshPrompt, Uuid } from '../../shared/types';

interface PromptState {
  queue: SshPrompt[];
  push: (prompt: SshPrompt) => void;
  /** The session ended: its questions are void (Rust cancels them too). */
  dropSession: (sessionId: Uuid) => void;
  answerHostKey: (promptId: Uuid, decision: HostKeyDecision) => Promise<void>;
  answerAuth: (promptId: Uuid, answers: string[] | null) => Promise<void>;
}

const without = (queue: SshPrompt[], promptId: Uuid) =>
  queue.filter((p) => p.promptId !== promptId);

export const usePrompts = create<PromptState>((set) => ({
  queue: [],
  push: (prompt) =>
    set((s) =>
      s.queue.some((p) => p.promptId === prompt.promptId) ? s : { queue: [...s.queue, prompt] },
    ),
  dropSession: (sessionId) =>
    set((s) => ({ queue: s.queue.filter((p) => p.sessionId !== sessionId) })),
  answerHostKey: async (promptId, decision) => {
    set((s) => ({ queue: without(s.queue, promptId) }));
    try {
      await ipc.sshAnswerHostKey(promptId, decision);
    } catch (error) {
      reportError(error);
    }
  },
  answerAuth: async (promptId, answers) => {
    set((s) => ({ queue: without(s.queue, promptId) }));
    try {
      await ipc.sshAnswerAuth(promptId, answers);
    } catch (error) {
      reportError(error);
    }
  },
}));

/** Subscribe once for the lifetime of the app window. */
export function listenForPrompts(): () => void {
  return onSshPrompt((prompt) => usePrompts.getState().push(prompt));
}
