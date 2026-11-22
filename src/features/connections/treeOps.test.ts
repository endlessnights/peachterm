// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { Connection, ConnectionTree, Folder, ItemRef } from '../../shared/types';
import {
  MAX_FOLDER_DEPTH,
  connectionRef,
  deleteItems,
  folderLevel,
  folderRef,
  itemKey,
  moveItems,
  normalizeItems,
  parseKey,
  planDelete,
  sortedChildren,
  subtreeHeight,
  tooDeepFolders,
  validateMove,
} from './treeOps';

const fld = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
  expanded: true,
  sortOrder: 0,
});
const con = (id: string, name: string, folderId: string | null = null): Connection => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'root',
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

/** A > B > C (three levels), loose D and E, connections s1 (root), s2 (in C), s3 (in D). */
const sample = (): ConnectionTree => ({
  version: 2,
  folders: [fld('A', 'A'), fld('B', 'B', 'A'), fld('C', 'C', 'B'), fld('D', 'D'), fld('E', 'E')],
  connections: [con('s1', 's1'), con('s2', 's2', 'C'), con('s3', 's3', 'D')],
});

const ids = (items: ItemRef[]) => items.map((i) => i.id);

describe('keys and levels', () => {
  it('round-trips item keys', () => {
    expect(itemKey(folderRef('x'))).toBe('f:x');
    expect(itemKey(connectionRef('x'))).toBe('c:x');
    expect(parseKey('f:abc')).toEqual(folderRef('abc'));
    expect(parseKey('c:abc')).toEqual(connectionRef('abc'));
  });

  it('computes folder levels and subtree heights', () => {
    const t = sample();
    expect(folderLevel(t, 'A')).toBe(1);
    expect(folderLevel(t, 'C')).toBe(3);
    expect(subtreeHeight(t, 'A')).toBe(3);
    expect(subtreeHeight(t, 'C')).toBe(1);
    expect(tooDeepFolders(t)).toEqual([]);
    expect(MAX_FOLDER_DEPTH).toBe(3);
  });
});

describe('move validation', () => {
  it('allows connections anywhere, between folders, and back to the top', () => {
    const t = sample();
    expect(validateMove(t, [connectionRef('s1')], 'C')).toBeNull();
    expect(validateMove(t, [connectionRef('s2')], 'D')).toBeNull();
    expect(validateMove(t, [connectionRef('s3')], null)).toBeNull();
  });

  it('refuses a fourth folder level and explains why', () => {
    const t = sample();
    const reason = validateMove(t, [folderRef('D')], 'C');
    expect(reason).toMatch(/at most 3 levels/);
    expect(validateMove(t, [folderRef('D')], 'B')).toBeNull(); // level 3 is fine
  });

  it('checks the whole subtree being moved', () => {
    const t = sample();
    expect(validateMove(t, [folderRef('A')], 'E')).toMatch(/level 4/);
    expect(validateMove(t, [folderRef('B')], 'E')).toBeNull(); // B + C reach level 3
  });

  it('prevents cycles', () => {
    const t = sample();
    for (const target of ['A', 'B', 'C']) {
      expect(validateMove(t, [folderRef('A')], target)).toMatch(/cannot be moved into itself/);
    }
  });

  it('reports vanished items and destinations', () => {
    const t = sample();
    expect(validateMove(t, [connectionRef('s1')], 'ghost')).toMatch(/no longer exists/);
    expect(validateMove(t, [connectionRef('ghost')], null)).toMatch(/no longer exists/);
  });

  it('only drops items that already travel with a selected folder', () => {
    const t = sample();
    expect(normalizeItems(t, [folderRef('A'), connectionRef('s2'), folderRef('A')], true)).toEqual([
      folderRef('A'),
    ]);
    // for deletes explicit children stay in the list
    expect(normalizeItems(t, [folderRef('A'), connectionRef('s2')], false)).toHaveLength(2);
  });

  it('keeps legacy deeper-than-limit data and only allows making it shallower', () => {
    const t: ConnectionTree = {
      version: 2,
      folders: [
        fld('A', 'A'),
        fld('B', 'B', 'A'),
        fld('C', 'C', 'B'),
        fld('D', 'D', 'C'),
        fld('E', 'E', 'D'),
        fld('X', 'X'),
      ],
      connections: [],
    };
    expect(tooDeepFolders(t)).toEqual(['D', 'E']);
    expect(validateMove(t, [folderRef('D')], 'C')).toBeNull(); // not deeper than before
    expect(validateMove(t, [folderRef('A')], 'X')).toMatch(/level/); // would deepen A's chain
    const next = moveItems(t, [folderRef('B')], null, null); // flatten: allowed
    expect(folderLevel(next, 'B')).toBe(1);
    expect(next.folders).toHaveLength(6); // nothing deleted
  });
});

describe('moving and reordering', () => {
  it('changes only location fields', () => {
    const t = sample();
    const next = moveItems(t, [connectionRef('s1')], 'E', null);
    const before = t.connections.find((c) => c.id === 's1')!;
    const after = next.connections.find((c) => c.id === 's1')!;
    expect(after).toEqual({ ...before, folderId: 'E', sortOrder: after.sortOrder });
    expect(t.connections.find((c) => c.id === 's1')!.folderId).toBeNull(); // input untouched
  });

  it('throws the validation message and leaves the tree alone on an invalid move', () => {
    const t = sample();
    expect(() => moveItems(t, [folderRef('D')], 'C', null)).toThrowError(
      expect.objectContaining({ code: 'validation' }),
    );
  });

  it('reorders within a folder: before an anchor, to the end, several at once', () => {
    let t: ConnectionTree = {
      version: 2,
      folders: [fld('E', 'E')],
      connections: [con('n1', 'n1', 'E'), con('n2', 'n2', 'E'), con('n3', 'n3', 'E')],
    };
    const order = () => ids(sortedChildren(t, 'E', 'connection'));
    expect(order()).toEqual(['n1', 'n2', 'n3']); // name order until reordered
    t = moveItems(t, [connectionRef('n3')], 'E', connectionRef('n1'));
    expect(order()).toEqual(['n3', 'n1', 'n2']);
    t = moveItems(t, [connectionRef('n3')], 'E', null);
    expect(order()).toEqual(['n1', 'n2', 'n3']);
    t = moveItems(t, [connectionRef('n2'), connectionRef('n3')], 'E', connectionRef('n1'));
    expect(order()).toEqual(['n2', 'n3', 'n1']);
  });

  it('folders sort among folders, independent of connections', () => {
    let t = sample();
    t = moveItems(t, [folderRef('E')], null, folderRef('A'));
    expect(ids(sortedChildren(t, null, 'folder'))[0]).toBe('E');
    expect(ids(sortedChildren(t, null, 'connection'))).toEqual(['s1']);
  });
});

describe('bulk delete planning', () => {
  it('moveToParent keeps contents and reports exactly what is deleted', () => {
    const t = sample();
    const plan = planDelete(t, [folderRef('B')], 'moveToParent');
    expect(plan).toEqual({
      connectionIds: [],
      folderIds: ['B'],
      movedConnections: 0,
      movedFolders: 1,
    });
    const result = deleteItems(t, [folderRef('B')], 'moveToParent');
    expect(result.tree.folders.find((f) => f.id === 'C')!.parentId).toBe('A');
    expect(result.tree.connections).toHaveLength(3);
  });

  it('deleteContents removes the whole subtree and its connections only', () => {
    const t = sample();
    const result = deleteItems(t, [folderRef('A')], 'deleteContents');
    expect(result.plan.folderIds.sort()).toEqual(['A', 'B', 'C']);
    expect(result.plan.connectionIds).toEqual(['s2']);
    expect(result.tree.connections.map((c) => c.id).sort()).toEqual(['s1', 's3']);
    expect(result.tree.folders.map((f) => f.id).sort()).toEqual(['D', 'E']);
  });

  it('a mixed selection relocates survivors to the nearest surviving ancestor', () => {
    const t = sample();
    const result = deleteItems(
      t,
      [folderRef('A'), folderRef('B'), connectionRef('s1')],
      'moveToParent',
    );
    expect(result.tree.folders.find((f) => f.id === 'C')!.parentId).toBeNull();
    expect(result.tree.connections.map((c) => c.id)).not.toContain('s1');
    expect(result.tree.connections.find((c) => c.id === 's2')!.folderId).toBe('C');
  });

  it('never reports connections outside the selection', () => {
    const plan = planDelete(sample(), [connectionRef('s1')], 'deleteContents');
    expect(plan.connectionIds).toEqual(['s1']);
    expect(plan.folderIds).toEqual([]);
  });
});
