// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The split-tree model of the terminal workspace.
//
// A workspace shows up to MAX_LEAVES terminals ("panes"). The layout is a binary
// tree: a branch splits its rectangle into two children, either side by side
// (`row`) or stacked (`column`); a leaf shows one tab (or is a picker that is
// waiting for the user to choose). Nesting gives every mixed layout. Panes
// only REFERENCE tabs (and so sessions): rearranging the tree never creates,
// closes or reconnects a session.
//
// All functions are pure and return new trees.

export type Dir = 'row' | 'column';
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface Leaf {
  kind: 'leaf';
  id: string;
  /** The tab shown here; `null` = a picker waiting for a choice. */
  tabId: string | null;
  /** For a picker: the tab whose saved connection "new session" duplicates. */
  sourceTabId?: string;
}

export interface Branch {
  kind: 'branch';
  id: string;
  dir: Dir;
  /** Share of the space taken by `a` (MIN_RATIO … MAX_RATIO). */
  ratio: number;
  a: Node;
  b: Node;
}

export type Node = Leaf | Branch;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_LEAVES = 6;
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;
/** Smallest useful pane in CSS pixels (a pane is never made smaller by splitting). */
export const MIN_PANE_W = 240;
export const MIN_PANE_H = 110;
/** Thickness of a divider in CSS pixels. */
export const DIVIDER = 6;
const MAX_DEPTH = 6;

let counter = 0;
export const newNodeId = (prefix: string) => `${prefix}-${(counter++).toString(36)}`;

export const clampRatio = (r: number, lo = MIN_RATIO, hi = MAX_RATIO) =>
  Number.isFinite(r) ? Math.min(hi, Math.max(lo, r)) : 0.5;

export const makeLeaf = (tabId: string | null, sourceTabId?: string): Leaf => ({
  kind: 'leaf',
  id: newNodeId('pane'),
  tabId,
  ...(sourceTabId ? { sourceTabId } : {}),
});

export const makeBranch = (dir: Dir, a: Node, b: Node, ratio = 0.5): Branch => ({
  kind: 'branch',
  id: newNodeId('split'),
  dir,
  ratio,
  a,
  b,
});

export function leaves(node: Node): Leaf[] {
  return node.kind === 'leaf' ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

export const countLeaves = (node: Node) => leaves(node).length;

export const findLeaf = (node: Node, id: string): Leaf | null =>
  leaves(node).find((l) => l.id === id) ?? null;

export const findLeafByTab = (node: Node, tabId: string): Leaf | null =>
  leaves(node).find((l) => l.tabId === tabId) ?? null;

export const shownTabs = (node: Node | null): string[] =>
  node ? leaves(node).flatMap((l) => (l.tabId ? [l.tabId] : [])) : [];

function mapLeaf(node: Node, id: string, fn: (leaf: Leaf) => Node): Node {
  if (node.kind === 'leaf') return node.id === id ? fn(node) : node;
  return { ...node, a: mapLeaf(node.a, id, fn), b: mapLeaf(node.b, id, fn) };
}

export const depth = (node: Node): number =>
  node.kind === 'leaf' ? 1 : 1 + Math.max(depth(node.a), depth(node.b));

/**
 * Split `leafId`: the old leaf stays and `fresh` is added on `side`
 * (`before` = left/top, `after` = right/bottom).
 */
export function splitLeaf(
  node: Node,
  leafId: string,
  dir: Dir,
  fresh: Leaf,
  side: 'before' | 'after',
): Node {
  return mapLeaf(node, leafId, (old) =>
    side === 'before' ? makeBranch(dir, fresh, old) : makeBranch(dir, old, fresh),
  );
}

/**
 * Remove a leaf; its sibling takes the place of their parent (empty split
 * containers collapse). `null` when it was the only leaf.
 */
export function removeLeaf(node: Node, leafId: string): Node | null {
  if (node.kind === 'leaf') return node.id === leafId ? null : node;
  const a = removeLeaf(node.a, leafId);
  const b = removeLeaf(node.b, leafId);
  if (a === null) return b;
  if (b === null) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export const setLeafTab = (node: Node, leafId: string, tabId: string | null): Node =>
  mapLeaf(node, leafId, (leaf) => ({ kind: 'leaf', id: leaf.id, tabId }));

export function setRatio(node: Node, branchId: string, ratio: number): Node {
  if (node.kind === 'leaf') return node;
  if (node.id === branchId) return { ...node, ratio: clampRatio(ratio) };
  return { ...node, a: setRatio(node.a, branchId, ratio), b: setRatio(node.b, branchId, ratio) };
}

export function parentOf(node: Node, id: string): Branch | null {
  if (node.kind === 'leaf') return null;
  if (node.a.id === id || node.b.id === id) return node;
  return parentOf(node.a, id) ?? parentOf(node.b, id);
}

/** Flip the orientation of one split (row ↔ column). */
export function flip(node: Node, branchId: string): Node {
  if (node.kind === 'leaf') return node;
  const dir: Dir = node.dir === 'row' ? 'column' : 'row';
  const self = node.id === branchId ? { ...node, dir } : node;
  return { ...self, a: flip(node.a, branchId), b: flip(node.b, branchId) };
}

export interface Placed {
  leaves: Map<string, Rect>;
  branches: { branch: Branch; rect: Rect }[];
}

/** Fractional rectangles (0…1 of the workspace) of every leaf and split. */
export function place(node: Node, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): Placed {
  const out: Placed = { leaves: new Map(), branches: [] };
  const walk = (n: Node, r: Rect) => {
    if (n.kind === 'leaf') {
      out.leaves.set(n.id, r);
      return;
    }
    out.branches.push({ branch: n, rect: r });
    if (n.dir === 'row') {
      walk(n.a, { x: r.x, y: r.y, w: r.w * n.ratio, h: r.h });
      walk(n.b, { x: r.x + r.w * n.ratio, y: r.y, w: r.w * (1 - n.ratio), h: r.h });
    } else {
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: r.h * n.ratio });
      walk(n.b, { x: r.x, y: r.y + r.h * n.ratio, w: r.w, h: r.h * (1 - n.ratio) });
    }
  };
  walk(node, rect);
  return out;
}

/** Which part of a pane a point is over: near an edge, or the middle. */
export function zoneFor(rect: Rect, px: number, py: number, edge = 0.26): Zone {
  if (rect.w <= 0 || rect.h <= 0) return 'center';
  const fx = (px - rect.x) / rect.w;
  const fy = (py - rect.y) / rect.h;
  // the nearest edge wins when the point is within `edge` of it
  const distances: [Zone, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ];
  const [zone, d] = distances.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  return d <= edge ? zone : 'center';
}

/** The area the new pane would occupy if a tab were dropped in `zone`. */
export function previewRect(rect: Rect, zone: Zone): Rect {
  switch (zone) {
    case 'left':
      return { x: rect.x, y: rect.y, w: rect.w / 2, h: rect.h };
    case 'right':
      return { x: rect.x + rect.w / 2, y: rect.y, w: rect.w / 2, h: rect.h };
    case 'top':
      return { x: rect.x, y: rect.y, w: rect.w, h: rect.h / 2 };
    case 'bottom':
      return { x: rect.x, y: rect.y + rect.h / 2, w: rect.w, h: rect.h / 2 };
    default:
      return rect;
  }
}

export const zoneDir = (zone: Zone): Dir | null =>
  zone === 'left' || zone === 'right'
    ? 'row'
    : zone === 'top' || zone === 'bottom'
      ? 'column'
      : null;

/**
 * Can this leaf be split in `dir` without making a pane smaller than the
 * minimum? `area` is the workspace size in CSS pixels.
 */
export function roomToSplit(
  node: Node,
  leafId: string,
  dir: Dir,
  area: { w: number; h: number },
): boolean {
  const rect = place(node).leaves.get(leafId);
  if (!rect) return false;
  if (area.w <= 0 || area.h <= 0) return true; // not measured yet (tests, first frame)
  return dir === 'row'
    ? rect.w * area.w >= 2 * MIN_PANE_W + DIVIDER
    : rect.h * area.h >= 2 * MIN_PANE_H + DIVIDER;
}

/** Ratio limits for a split so that neither side drops below the minimum size. */
export function ratioLimits(branch: Branch, rect: Rect, area: { w: number; h: number }) {
  if (area.w <= 0 || area.h <= 0) return { lo: MIN_RATIO, hi: MAX_RATIO };
  const total = branch.dir === 'row' ? rect.w * area.w : rect.h * area.h;
  const min = branch.dir === 'row' ? MIN_PANE_W : MIN_PANE_H;
  const share = total > 0 ? (min + DIVIDER / 2) / total : 0.5;
  if (share >= 0.5) return { lo: MIN_RATIO, hi: MAX_RATIO };
  return { lo: Math.max(MIN_RATIO, share), hi: Math.min(MAX_RATIO, 1 - share) };
}

/** Structural invariants; returns the problems found (empty = a valid tree). */
export function validate(node: Node | null): string[] {
  if (!node) return [];
  const problems: string[] = [];
  const all = leaves(node);
  if (all.length > MAX_LEAVES) problems.push(`more than ${MAX_LEAVES} panes`);
  if (depth(node) > MAX_DEPTH) problems.push('too deeply nested');
  const ids = new Set<string>();
  const tabs = new Set<string>();
  const walk = (n: Node) => {
    if (ids.has(n.id)) problems.push(`duplicate id ${n.id}`);
    ids.add(n.id);
    if (n.kind === 'leaf') {
      if (n.tabId) {
        if (tabs.has(n.tabId)) problems.push(`tab ${n.tabId} is shown twice`);
        tabs.add(n.tabId);
      }
      return;
    }
    if (!(n.ratio >= MIN_RATIO && n.ratio <= MAX_RATIO)) problems.push(`bad ratio ${n.ratio}`);
    if (!n.a || !n.b) problems.push('split without two children');
    else {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(node);
  return problems;
}
