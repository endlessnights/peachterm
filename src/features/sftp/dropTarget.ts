// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Where on the screen did a native file drop land? The backend reports the
// cursor in physical pixels of the web view; the page lays out in CSS pixels.
// The WebView zoom that implements the interface scale is part of
// devicePixelRatio, so `physical / devicePixelRatio` is the point in the
// layout viewport at any display scaling, UI zoom and window size. Anything
// that does not resolve unambiguously to the SFTP panel is refused: a drop is
// never sent to a destination the user could not see.

export type DropTarget = { kind: 'row'; path: string; name: string } | { kind: 'directory' };

export interface Point {
  x: number;
  y: number;
}

/** Physical (device) pixels -> CSS pixels of the layout viewport; null when implausible. */
export function toCssPoint(
  physical: Point,
  devicePixelRatio: number,
  viewport: { width: number; height: number },
): Point | null {
  if (!Number.isFinite(physical.x) || !Number.isFinite(physical.y)) return null;
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return null;
  const x = physical.x / devicePixelRatio;
  const y = physical.y / devicePixelRatio;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return null;
  return { x, y };
}

/**
 * What is under `point` inside the SFTP browser `root`: a remote folder row, the
 * folder list itself (the current directory), or nothing (another part of the
 * application, a dialog above the panel, the empty area outside the list).
 */
export function resolveDropTarget(
  root: HTMLElement | null,
  point: Point | null,
  doc: Document = document,
): DropTarget | null {
  if (!root || !point) return null;
  const hit = doc.elementFromPoint(point.x, point.y);
  if (!hit || !root.contains(hit)) return null;
  // Only the file list accepts a drop (not the toolbar, the path bar or the transfer list).
  const list = hit.closest('[data-sftp-list]');
  if (!list || !root.contains(list)) return null;
  const row = hit.closest<HTMLElement>('[data-sftp-row]');
  if (row && list.contains(row) && row.dataset.sftpDir === 'true' && row.dataset.sftpPath) {
    return { kind: 'row', path: row.dataset.sftpPath, name: row.dataset.sftpName ?? '' };
  }
  return { kind: 'directory' };
}
