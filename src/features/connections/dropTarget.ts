// Where a drag ends up, derived from the pointer position over a row.
// Pure so the rules are testable without a DOM or a drag library.

import type { ConnectionTree, ItemRef, Uuid } from '../../shared/types';
import type { Row } from './tree';
import { itemKey, sortedChildren } from './treeOps';

export type Zone = 'before' | 'after' | 'into';

export interface DropPlan {
  /** Destination folder (null = top level). */
  target: Uuid | null;
  /** Insert before this sibling (null = at the end). */
  before: ItemRef | null;
  zone: Zone;
  /** Row that gets the visual indicator (null = the top-level area). */
  rowKey: string | null;
}

/**
 * Folder rows: top quarter = before, bottom quarter = after, middle = into.
 * Connection rows: upper half = before, lower half = after.
 */
export function zoneFor(pointerY: number, rect: { top: number; height: number }, row: Row): Zone {
  const ratio = rect.height > 0 ? (pointerY - rect.top) / rect.height : 0.5;
  if (row.ref.kind === 'folder') {
    if (ratio < 0.25) return 'before';
    // An expanded folder's lower edge is where its children begin: treat as "into".
    if (ratio > 0.75 && !row.expanded) return 'after';
    return 'into';
  }
  return ratio < 0.5 ? 'before' : 'after';
}

export function planDrop(
  tree: ConnectionTree,
  row: Row | null,
  zone: Zone,
  moving: ItemRef[],
): DropPlan {
  if (!row) return { target: null, before: null, zone: 'into', rowKey: null };
  if (zone === 'into' && row.ref.kind === 'folder') {
    return { target: row.ref.id, before: null, zone, rowKey: row.key };
  }
  const parent = row.parentId;
  const kinds = new Set(moving.map((m) => m.kind));
  let before: ItemRef | null = null;
  if (kinds.has(row.ref.kind)) {
    if (zone === 'before') {
      before = row.ref;
    } else {
      const siblings = sortedChildren(tree, parent, row.ref.kind);
      const index = siblings.findIndex((s) => itemKey(s) === row.key);
      before = siblings[index + 1] ?? null;
    }
  } else if (row.ref.kind === 'folder') {
    // Connections hovering a folder's edge join the start of that level's connections.
    before = sortedChildren(tree, parent, 'connection')[0] ?? null;
  }
  return { target: parent, before, zone, rowKey: row.key };
}
