// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Pure selection helpers for the sidebar list (Ctrl/Shift click, Ctrl+A,
// arrow keys). Selections are lists of row keys (`c:<id>` / `f:<id>`).

import type { Row } from './tree';

export function rangeKeys(rows: Row[], from: string, to: string): string[] {
  const a = rows.findIndex((r) => r.key === from);
  const b = rows.findIndex((r) => r.key === to);
  if (a < 0 || b < 0) return b >= 0 ? [rows[b]!.key] : [];
  const [start, end] = a < b ? [a, b] : [b, a];
  return rows.slice(start, end + 1).map((r) => r.key);
}

/** Entries that share a parent with `key`: "the focused list or folder". */
export function siblingKeys(rows: Row[], key: string): string[] {
  const row = rows.find((r) => r.key === key);
  if (!row) return [];
  return rows.filter((r) => r.parentId === row.parentId).map((r) => r.key);
}

export function toggleKey(selection: string[], key: string): string[] {
  return selection.includes(key) ? selection.filter((k) => k !== key) : [...selection, key];
}

/** Row key `delta` steps from `key` (clamped), or the first/last row. */
export function stepKey(rows: Row[], key: string | null, delta: number): string | null {
  if (rows.length === 0) return null;
  const index = key ? rows.findIndex((r) => r.key === key) : -1;
  if (index < 0) return rows[delta >= 0 ? 0 : rows.length - 1]!.key;
  return rows[Math.max(0, Math.min(rows.length - 1, index + delta))]!.key;
}

/** Selection in display order, for stable move/delete operations. */
export function inDisplayOrder(rows: Row[], selection: string[]): Row[] {
  const wanted = new Set(selection);
  return rows.filter((r) => wanted.has(r.key));
}
