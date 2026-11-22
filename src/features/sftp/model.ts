// Pure helpers for the SFTP panel: sorting, filtering and formatting.

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
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
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

export function describeFailure(reason: string): string {
  switch (reason) {
    case 'already_exists':
      return 'already exists on the server';
    case 'permission_denied':
      return 'permission denied';
    case 'not_found':
      return 'not found';
    case 'local_io':
      return 'the local file could not be read or written';
    case 'remote_changed':
      return 'it changed on the server meanwhile';
    case 'timeout':
      return 'the server did not answer in time';
    case 'unavailable':
      return 'the connection was lost';
    default:
      return 'the server reported an error';
  }
}
