// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { Connection, ConnectionTree, Folder } from '../../shared/types';
import { planDrop, zoneFor } from './dropTarget';
import { inDisplayOrder, rangeKeys, siblingKeys, stepKey, toggleKey } from './selection';
import { buildTree, flattenRows, type Row } from './tree';
import { connectionRef, folderRef } from './treeOps';

const fld = (
  id: string,
  name: string,
  parentId: string | null = null,
  expanded = true,
): Folder => ({
  id,
  name,
  parentId,
  expanded,
  sortOrder: 0,
});
const con = (id: string, name: string, folderId: string | null = null): Connection => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: '',
  auth: 'password',
  keyPath: null,
  savePassword: false,
  hasStoredSecret: false,
  timeoutSecs: 15,
  initialDirectory: null,
  folderId,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
});

const tree: ConnectionTree = {
  version: 2,
  folders: [fld('F', 'F'), fld('G', 'G', 'F'), fld('H', 'H', null, false)],
  connections: [con('a', 'a'), con('b', 'b'), con('c', 'c', 'F'), con('d', 'd', 'F')],
};
const rows = flattenRows(buildTree(tree), false);
const row = (key: string): Row => rows.find((r) => r.key === key)!;
const rect = { top: 100, height: 20 };

describe('visible rows', () => {
  it('are in display order, folders first, collapsed folders hide children', () => {
    expect(rows.map((r) => r.key)).toEqual(['f:F', 'f:G', 'c:c', 'c:d', 'f:H', 'c:a', 'c:b']);
    expect(row('c:c').depth).toBe(1);
    expect(row('c:c').parentId).toBe('F');
  });
});

describe('zoneFor', () => {
  it('folder: top quarter before, bottom quarter after (collapsed), middle into', () => {
    const collapsed = row('f:H');
    expect(zoneFor(101, rect, collapsed)).toBe('before');
    expect(zoneFor(110, rect, collapsed)).toBe('into');
    expect(zoneFor(119, rect, collapsed)).toBe('after');
    // an expanded folder's lower edge belongs to its children
    expect(zoneFor(119, rect, row('f:F'))).toBe('into');
  });

  it('connection: upper half before, lower half after', () => {
    expect(zoneFor(105, rect, row('c:a'))).toBe('before');
    expect(zoneFor(115, rect, row('c:a'))).toBe('after');
  });
});

describe('planDrop', () => {
  it('into a folder appends to it', () => {
    expect(planDrop(tree, row('f:F'), 'into', [connectionRef('a')])).toEqual({
      target: 'F',
      before: null,
      zone: 'into',
      rowKey: 'f:F',
    });
  });

  it("before/after a connection targets that connection's folder with the right anchor", () => {
    const before = planDrop(tree, row('c:c'), 'before', [connectionRef('a')]);
    expect(before).toMatchObject({ target: 'F', before: connectionRef('c') });
    const after = planDrop(tree, row('c:c'), 'after', [connectionRef('a')]);
    expect(after).toMatchObject({ target: 'F', before: connectionRef('d') });
    const last = planDrop(tree, row('c:d'), 'after', [connectionRef('a')]);
    expect(last).toMatchObject({ target: 'F', before: null }); // end of the list
  });

  it('a connection dragged out of a folder lands at the top level', () => {
    const plan = planDrop(tree, row('c:a'), 'before', [connectionRef('c')]);
    expect(plan.target).toBeNull();
    expect(plan.before).toEqual(connectionRef('a'));
  });

  it('folders reorder among folders', () => {
    const plan = planDrop(tree, row('f:H'), 'before', [folderRef('F')]);
    expect(plan).toMatchObject({ target: null, before: folderRef('H') });
  });

  it('connections hovering a folder edge join the start of that level', () => {
    const plan = planDrop(tree, row('f:H'), 'before', [connectionRef('c')]);
    expect(plan).toMatchObject({ target: null, before: connectionRef('a') });
  });

  it('the empty area below the list means the top level', () => {
    expect(planDrop(tree, null, 'into', [connectionRef('c')])).toEqual({
      target: null,
      before: null,
      zone: 'into',
      rowKey: null,
    });
  });
});

describe('selection helpers', () => {
  it('range selection follows display order in either direction', () => {
    expect(rangeKeys(rows, 'c:c', 'c:a')).toEqual(['c:c', 'c:d', 'f:H', 'c:a']);
    expect(rangeKeys(rows, 'c:a', 'c:c')).toEqual(['c:c', 'c:d', 'f:H', 'c:a']);
    expect(rangeKeys(rows, 'nope', 'c:a')).toEqual(['c:a']);
  });

  it('"select all" targets the focused list or folder', () => {
    expect(siblingKeys(rows, 'c:c')).toEqual(['f:G', 'c:c', 'c:d']);
  });

  it('toggles, steps and orders', () => {
    expect(toggleKey(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b']);
    expect(stepKey(rows, 'c:a', 1)).toBe('c:b');
    expect(stepKey(rows, 'c:b', 1)).toBe('c:b'); // clamped
    expect(stepKey(rows, null, 1)).toBe('f:F');
    expect(inDisplayOrder(rows, ['c:b', 'f:F']).map((r) => r.key)).toEqual(['f:F', 'c:b']);
  });
});
