// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for the SFTP panel: sorting, filtering and formatting.

import { t as tr } from '../../i18n';
import { formatDecimal, formatNumber } from '../../i18n/format';
import type { EntryKind, RemoteEntry } from '../../shared/types';

export type SortKey = 'name' | 'size' | 'modified';
export interface Sort {
  key: SortKey;
  ascending: boolean;
}

export const isDir = (e: Pick<RemoteEntry, 'kind' | 'targetIsDir'>) =>
  e.kind === 'directory' || (e.kind === 'symlink' && e.targetIsDir);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Directories first (always), then by the chosen key; names break ties. */
export function sortEntries(entries: RemoteEntry[], sort: Sort): RemoteEntry[] {
  const direction = sort.ascending ? 1 : -1;
  return entries.slice().sort((a, b) => {
    const folders = Number(isDir(b)) - Number(isDir(a));
    if (folders !== 0) return folders;
    let order = 0;
    if (sort.key === 'size') order = a.size - b.size;
    else if (sort.key === 'modified') order = (a.modified ?? 0) - (b.modified ?? 0);
    if (order === 0) order = collator.compare(a.name, b.name);
    return order * direction || collator.compare(a.name, b.name);
  });
}

export const isHidden = (e: Pick<RemoteEntry, 'name'>) => e.name.startsWith('.');

export function visibleEntries(entries: RemoteEntry[], showHidden: boolean): RemoteEntry[] {
  return showHidden ? entries : entries.filter((e) => !isHidden(e));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? formatNumber(Math.round(value)) : formatDecimal(value, 1)} ${units[unit]}`;
}

/** `drwxr-xr-x` style text for a mode and entry kind. */
export function formatMode(mode: number | null, kind: EntryKind): string {
  const type = kind === 'directory' ? 'd' : kind === 'symlink' ? 'l' : kind === 'other' ? '?' : '-';
  if (mode === null) return `${type}?????????`;
  const bit = (mask: number, ch: string) => (mode & mask ? ch : '-');
  return (
    type +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    bit(0o100, 'x') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    bit(0o010, 'x') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    bit(0o001, 'x')
  );
}

export function formatTime(seconds: number | null, now = Date.now()): string {
  if (seconds === null) return '';
  const date = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const recent = Math.abs(now - date.getTime()) < 180 * 24 * 3600 * 1000;
  return recent ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

/** `/a/b` → [{name:'/',path:'/'},{name:'a',path:'/a'},{name:'b',path:'/a/b'}] */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of path.split('/').filter(Boolean)) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

export const joinRemote = (dir: string, name: string) =>
  dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;

export const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

const FAILURE_TOKENS = [
  'already_exists',
  'permission_denied',
  'not_found',
  'local_io',
  'remote_changed',
  'timeout',
  'unavailable',
] as const;

/** A short localized reason for a transfer failure token (never the raw error). */
export function describeFailure(reason: string): string {
  return (FAILURE_TOKENS as readonly string[]).includes(reason)
    ? tr(`sftp.failure.${reason as (typeof FAILURE_TOKENS)[number]}`)
    : tr('sftp.failure.other');
}

export const MAX_REMOTE_FOLDER_DEPTH = 16;

/**
 * Why a new file PATH (`logs/app/1.txt`) cannot be used, or null. The folders in
 * front of the file name follow the folder-path rules; the last part is the file.
 */
export function validateRemoteFilePath(input: string, existing: string[] = []): string | null {
  const path = input.trim();
  if (!path.includes('/')) return validateRemoteName(path, existing);
  const parts = path.split('/');
  if (parts.length > MAX_REMOTE_FOLDER_DEPTH) {
    return tr('errors.folders.tooDeep', { max: MAX_REMOTE_FOLDER_DEPTH });
  }
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return tr('errors.folders.pathInvalid');
    const problem = validateRemoteName(part);
    if (problem) return problem;
  }
  return null;
}

/**
 * Why a new folder PATH (`ops/docker`) cannot be used, or null. Every part is a
 * plain name: no absolute paths, empty parts, `.` or `..`. A single name behaves
 * exactly like `validateRemoteName`.
 */
export function validateRemoteFolderPath(input: string, existing: string[] = []): string | null {
  const path = input.trim();
  if (!path.includes('/')) return validateRemoteName(path, existing);
  const parts = path.split('/');
  if (parts.length > MAX_REMOTE_FOLDER_DEPTH) {
    return tr('errors.folders.tooDeep', { max: MAX_REMOTE_FOLDER_DEPTH });
  }
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return tr('errors.folders.pathInvalid');
    const problem = validateRemoteName(part);
    if (problem) return problem;
  }
  return null;
}

/** The parts of a validated folder path. */
export const folderParts = (input: string): string[] => input.trim().split('/');

/**
 * Why a new file or folder name cannot be used, or `null` when it is fine. The
 * server and Rust check again; this gives the answer before anything is sent.
 */
export function validateRemoteName(name: string, existing: string[] = []): string | null {
  if (name.trim() === '') return tr('sftp.name.enter');
  if (name === '.' || name === '..') return tr('sftp.name.invalid', { name });
  if (name.includes('/')) return tr('sftp.name.slash');
  if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    return tr('sftp.name.control');
  }
  if (new TextEncoder().encode(name).length > 255) return tr('sftp.name.tooLong');
  if (existing.includes(name)) return tr('sftp.name.exists', { name });
  return null;
}
