// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { toAppError } from '../shared/ipc';
import type { AppError } from '../shared/types';
import { i18n, t } from './index';

// Backend errors reach the renderer as `{ code, message, key?, params?, token? }`.
// `key` / `token` are stable identifiers the interface translates; `message`
// stays English: it is the diagnostic text and the fallback for anything that
// has no translation yet. Nothing is matched against message text.

const has = (key: string) => i18n.exists(key);

// Keys built at run time cannot be checked against the typed resources.
const tr = t as unknown as (key: string, options?: Record<string, unknown>) => string;

const WHAT: Record<string, string> = {
  session: 'session',
  connection: 'connection',
  folder: 'folder',
  note: 'note',
  tunnel: 'tunnel',
  update: 'update',
  question: 'question',
  selection: 'selection',
  'shell profile': 'shellProfile',
  'exported archive': 'exportedArchive',
  'destination folder': 'destinationFolder',
};

/** "session was not found" -> "session" (the noun is a fixed identifier from Rust). */
function subject(message: string): string {
  const noun = message.replace(/ was not found$/, '');
  const key = WHAT[noun] ?? 'other';
  return tr(`errors.what.${key}`);
}

/** The text shown to the user for any error thrown by an IPC call. */
export function errorMessage(error: unknown): string {
  const err: AppError = toAppError(error);
  if (err.key && has(`errors.${err.key}`)) {
    return tr(`errors.${err.key}`, err.params ?? {});
  }
  if (err.token && has(`errors.remote.${err.token}`)) {
    return tr(`errors.remote.${err.token}`);
  }
  switch (err.code) {
    case 'locked':
      return t('errors.code.locked');
    case 'not_found':
      return t('errors.code.not_found', { what: subject(err.message) });
    case 'credentials_unavailable':
      // The operating system's own wording stays in the brackets, untranslated.
      return t('errors.code.credentials_unavailable', {
        detail: err.message.replace(/^[^:]*unavailable: /, ''),
      });
    default:
      return err.message;
  }
}
