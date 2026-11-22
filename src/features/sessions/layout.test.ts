// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  MAX_LEAVES,
  MIN_PANE_H,
  MIN_PANE_W,
  countLeaves,
  findLeafByTab,
  flip,
  leaves,
  makeBranch,
  makeLeaf,
  parentOf,
  place,
  previewRect,
  ratioLimits,
  removeLeaf,
  roomToSplit,
  setLeafTab,
  setRatio,
  splitLeaf,
  validate,
  zoneFor,
  type Node,
} from './layout';

const row = (a: Node, b: Node, ratio = 0.5) => makeBranch('row', a, b, ratio);
const col = (a: Node, b: Node, ratio = 0.5) => makeBranch('column', a, b, ratio);
const leaf = (tab: string) => makeLeaf(tab);

describe('split tree', () => {
  it('builds side-by-side, stacked and mixed layouts of 3 to 6 panes', () => {
    const three = row(leaf('a'), col(leaf('b'), leaf('c')));
    const four = col(row(leaf('a'), leaf('b')), row(leaf('c'), leaf('d')));
    const six = row(
      col(leaf('a'), col(leaf('b'), leaf('c'))),
      col(row(leaf('d'), leaf('e')), leaf('f')),
    );
    for (const [tree, n] of [
      [three, 3],
      [four, 4],
      [six, 6],
    ] as const) {
      expect(countLeaves(tree)).toBe(n);
      expect(validate(tree)).toEqual([]);
    }
    expect(leaves(six).map((l) => l.tabId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('refuses a seventh pane in validation', () => {
    let node: Node = leaf('t0');
    for (let i = 1; i < MAX_LEAVES + 1; i += 1) node = row(node, leaf(`t${i}`));
    expect(validate(node)).toContain(`more than ${MAX_LEAVES} panes`);
  });

  it('places every pane inside the workspace without overlap or gaps', () => {
    const tree = row(leaf('a'), col(leaf('b'), row(leaf('c'), leaf('d'), 0.25), 0.4), 0.3);
    const { leaves: rects } = place(tree);
    let area = 0;
    for (const r of rects.values()) {
      area += r.w * r.h;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(area).toBeCloseTo(1, 9);
    const list = [...rects.values()];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapW > 1e-9 && overlapH > 1e-9).toBe(false);
      }
    }
  });

  it('splitting puts the new pane on the requested side and keeps the old one', () => {
    const a = leaf('a');
    const fresh = leaf('b');
    const after = splitLeaf(a, a.id, 'row', fresh, 'after');
    expect(leaves(after).map((l) => l.tabId)).toEqual(['a', 'b']);
    const before = splitLeaf(a, a.id, 'column', fresh, 'before');
    expect(leaves(before).map((l) => l.tabId)).toEqual(['b', 'a']);
    expect(before.kind === 'branch' && before.dir).toBe('column');
  });

  it('removing a pane collapses empty containers and leaves the other panes alone', () => {
    const [a, b, c, d] = [leaf('a'), leaf('b'), leaf('c'), leaf('d')];
    const tree = row(a, col(b, row(c, d)));
    const withoutC = removeLeaf(tree, leaves(tree)[2]!.id)!;
    expect(leaves(withoutC).map((l) => l.tabId)).toEqual(['a', 'b', 'd']);
    expect(validate(withoutC)).toEqual([]);
    // removing b and c leaves a | d (no empty or single-child split remains)
    let t: Node | null = removeLeaf(withoutC, leaves(withoutC)[1]!.id);
    expect(t && leaves(t).map((l) => l.tabId)).toEqual(['a', 'd']);
    expect(t && t.kind === 'branch' && t.a.kind === 'leaf' && t.b.kind === 'leaf').toBe(true);
    t = removeLeaf(t!, leaves(t!)[0]!.id);
    expect(t && t.kind).toBe('leaf');
    expect(removeLeaf(t!, (t as { id: string }).id)).toBeNull();
  });

  it("keeps everything else untouched when swapping a pane's tab or moving a divider", () => {
    const tree = row(leaf('a'), col(leaf('b'), leaf('c')));
    const target = leaves(tree)[1]!;
    const swapped = setLeafTab(tree, target.id, 'z');
    expect(leaves(swapped).map((l) => l.tabId)).toEqual(['a', 'z', 'c']);
    expect(leaves(swapped).map((l) => l.id)).toEqual(leaves(tree).map((l) => l.id));
    const branch = parentOf(tree, target.id)!;
    const moved = setRatio(tree, branch.id, 0.8);
    expect(parentOf(moved, target.id)!.ratio).toBe(0.8);
    expect(setRatio(tree, branch.id, 5)).toBeTruthy();
    expect(parentOf(setRatio(tree, branch.id, 5), target.id)!.ratio).toBeLessThanOrEqual(0.9);
    // flipping one split leaves the other alone
    const flipped = flip(tree, branch.id);
    expect(parentOf(flipped, target.id)!.dir).toBe('row');
    expect(flipped.kind === 'branch' && flipped.dir).toBe('row');
  });

  it('finds the pane that shows a tab', () => {
    const tree = row(leaf('a'), leaf('b'));
    expect(findLeafByTab(tree, 'b')?.tabId).toBe('b');
    expect(findLeafByTab(tree, 'x')).toBeNull();
  });

  it('validation catches a tab shown twice and bad ratios', () => {
    expect(validate(row(leaf('a'), leaf('a')))).toEqual(['tab a is shown twice']);
    const bad = { ...row(leaf('a'), leaf('b')), ratio: 0.99 };
    expect(validate(bad).join()).toContain('bad ratio');
  });
});

describe('drop zones', () => {
  const rect = { x: 100, y: 50, w: 400, h: 200 };

  it('left / right / top / bottom edges and the middle', () => {
    expect(zoneFor(rect, 110, 150)).toBe('left');
    expect(zoneFor(rect, 490, 150)).toBe('right');
    expect(zoneFor(rect, 300, 55)).toBe('top');
    expect(zoneFor(rect, 300, 245)).toBe('bottom');
    expect(zoneFor(rect, 300, 150)).toBe('center');
  });

  it('the nearest edge wins in the corners', () => {
    expect(zoneFor(rect, 120, 52)).toBe('top'); // 5% from the left, 1% from the top
    expect(zoneFor(rect, 101, 140)).toBe('left');
  });

  it('previews exactly the half that the new pane would take', () => {
    const base = { x: 0, y: 0, w: 1, h: 1 };
    expect(previewRect(base, 'left')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(previewRect(base, 'right')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(previewRect(base, 'top')).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(previewRect(base, 'bottom')).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(previewRect(base, 'center')).toEqual(base);
  });
});

describe('minimum pane sizes', () => {
  it('refuses to split a pane that would become too small, in the matching direction', () => {
    const tree = row(leaf('a'), leaf('b'));
    const [a] = leaves(tree);
    // 600 x 400 area: each pane is 300 wide
    const area = { w: 600, h: 400 };
    expect(roomToSplit(tree, a!.id, 'row', area)).toBe(false); // 300 < 2 * 240 + 6
    expect(roomToSplit(tree, a!.id, 'column', area)).toBe(true); // 400 >= 2 * 110 + 6
    expect(roomToSplit(tree, a!.id, 'row', { w: 2 * (2 * MIN_PANE_W + 6), h: 400 })).toBe(true);
    expect(roomToSplit(tree, a!.id, 'column', { w: 600, h: 2 * MIN_PANE_H })).toBe(false);
    // not measured yet: do not block
    expect(roomToSplit(tree, a!.id, 'row', { w: 0, h: 0 })).toBe(true);
  });

  it('keeps a divider from squeezing a pane below the minimum', () => {
    const branch = row(leaf('a'), leaf('b'));
    if (branch.kind !== 'branch') throw new Error('branch');
    const { lo, hi } = ratioLimits(branch, { x: 0, y: 0, w: 1, h: 1 }, { w: 1000, h: 600 });
    expect(lo).toBeCloseTo((MIN_PANE_W + 3) / 1000, 5);
    expect(hi).toBeCloseTo(1 - (MIN_PANE_W + 3) / 1000, 5);
    // a workspace too small for two panes falls back to the generic limits
    const tiny = ratioLimits(branch, { x: 0, y: 0, w: 1, h: 1 }, { w: 300, h: 600 });
    expect(tiny.lo).toBeLessThan(tiny.hi);
  });
});
