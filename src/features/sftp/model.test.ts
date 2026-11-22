// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { RemoteEntry } from '../../shared/types';
import {
  baseName,
  breadcrumbs,
  formatMode,
  formatSize,
  formatTime,
  joinRemote,
  sortEntries,
  visibleEntries,
} from './model';

const entry = (name: string, extra: Partial<RemoteEntry> = {}): RemoteEntry => ({
  name,
  path: `/${name}`,
  kind: 'file',
  targetIsDir: false,
  size: 0,
  modified: null,
  mode: 0o644,
  ...extra,
});

describe('sorting', () => {
  const items = [
    entry('b.txt', { size: 5, modified: 30 }),
    entry('docs', { kind: 'directory' }),
    entry('A.txt', { size: 50, modified: 10 }),
    entry('a10', { kind: 'symlink', targetIsDir: true }),
    entry('a2.txt', { size: 1, modified: 20 }),
  ];
  it('puts directories (and links to directories) first whatever the key or direction', () => {
    for (const ascending of [true, false]) {
      for (const key of ['name', 'size', 'modified'] as const) {
        const names = sortEntries(items, { key, ascending }).map((e) => e.name);
        expect(names.slice(0, 2).sort()).toEqual(['a10', 'docs']);
      }
    }
  });
  it('sorts names naturally and case-insensitively', () => {
    const names = sortEntries(items, { key: 'name', ascending: true }).map((e) => e.name);
    expect(names).toEqual(['a10', 'docs', 'A.txt', 'a2.txt', 'b.txt']);
    const desc = sortEntries(items, { key: 'name', ascending: false }).map((e) => e.name);
    expect(desc.slice(2)).toEqual(['b.txt', 'a2.txt', 'A.txt']);
  });
  it('sorts by size and modification time, ties by name', () => {
    expect(
      sortEntries(items, { key: 'size', ascending: false })
        .filter((e) => e.kind === 'file')
        .map((e) => e.name),
    ).toEqual(['A.txt', 'b.txt', 'a2.txt']);
    expect(
      sortEntries(items, { key: 'modified', ascending: true })
        .filter((e) => e.kind === 'file')
        .map((e) => e.name),
    ).toEqual(['A.txt', 'a2.txt', 'b.txt']);
  });
  it('does not mutate its input', () => {
    const copy = items.map((e) => e.name);
    sortEntries(items, { key: 'size', ascending: true });
    expect(items.map((e) => e.name)).toEqual(copy);
  });
});

describe('hidden files', () => {
  it('are filtered unless requested', () => {
    const list = [entry('.bashrc'), entry('notes')];
    expect(visibleEntries(list, false).map((e) => e.name)).toEqual(['notes']);
    expect(visibleEntries(list, true)).toHaveLength(2);
  });
});

describe('formatting', () => {
  it('formats sizes', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(formatSize(10 * 1024 * 1024)).toBe('10 MiB');
    expect(formatSize(5 * 1024 ** 3)).toBe('5.0 GiB');
  });
  it('formats modes like ls', () => {
    expect(formatMode(0o755, 'directory')).toBe('drwxr-xr-x');
    expect(formatMode(0o640, 'file')).toBe('-rw-r-----');
    expect(formatMode(0o777, 'symlink')).toBe('lrwxrwxrwx');
    expect(formatMode(null, 'file')).toBe('-?????????');
  });
  it('formats times, with the clock only for recent files', () => {
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    expect(formatTime(null, now)).toBe('');
    const recent = formatTime(now / 1000 - 3600, now);
    expect(recent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatTime(now / 1000 - 400 * 24 * 3600, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('paths', () => {
  it('builds breadcrumbs', () => {
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }]);
    expect(breadcrumbs('/var/log')).toEqual([
      { name: '/', path: '/' },
      { name: 'var', path: '/var' },
      { name: 'log', path: '/var/log' },
    ]);
  });
  it('joins and splits POSIX paths', () => {
    expect(joinRemote('/', 'etc')).toBe('/etc');
    expect(joinRemote('/etc/', 'ssh')).toBe('/etc/ssh');
    expect(baseName('/etc/ssh/sshd_config')).toBe('sshd_config');
    expect(baseName('/etc/')).toBe('etc');
  });
});
