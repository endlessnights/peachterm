// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../i18n/errors';
import { create } from 'zustand';

interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast['kind'], text: string) => void;
  dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text) => {
    const id = next++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const reportError = (error: unknown) =>
  useToasts.getState().push('error', errorMessage(error));
export const notify = (text: string) => useToasts.getState().push('info', text);

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
