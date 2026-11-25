// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { ipc, onFileDrag } from '../../shared/ipc';
import { useLock } from '../lock/store';
import { resolveDropTarget, toCssPoint, type DropTarget } from './dropTarget';

export interface DragSummary {
  files: number;
  dirs: number;
  other: number;
}

export interface DropState {
  summary: DragSummary;
  /** Where a release would upload to, or null (not over this panel's file list). */
  target: DropTarget | null;
}

export interface DroppedFiles extends DragSummary {
  pickId: string;
  target: DropTarget;
}

/** Picks that a panel took responsibility for (the rest are discarded). */
const claimed = new Set<string>();

/**
 * Follows native file drags over one SFTP browser. `enabled` is false when
 * there is no usable SFTP session: then no indicator is shown and a drop here is
 * not accepted. `onDrop` is called once per drop that landed on this panel's file list.
 */
export function useFileDrop(
  root: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (drop: DroppedFiles) => void,
): DropState | null {
  const [state, setState] = useState<DropState | null>(null);
  const summary = useRef<DragSummary | null>(null);
  const handler = useRef(onDrop);
  useEffect(() => {
    handler.current = onDrop;
  });

  useEffect(() => {
    const locate = (x: number, y: number): DropTarget | null => {
      if (!enabled) return null;
      const point = toCssPoint({ x, y }, window.devicePixelRatio, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      return resolveDropTarget(root.current, point);
    };
    const stop = onFileDrag((event) => {
      if (useLock.getState().view?.locked) {
        summary.current = null;
        setState(null);
        return;
      }
      switch (event.phase) {
        case 'enter':
          summary.current = { files: event.files, dirs: event.dirs, other: event.other };
          setState({ summary: summary.current, target: locate(event.x, event.y) });
          break;
        case 'over': {
          const known = summary.current;
          if (!known) break;
          const target = locate(event.x, event.y);
          setState((prev) =>
            prev && JSON.stringify(prev.target) === JSON.stringify(target)
              ? prev
              : { summary: known, target },
          );
          break;
        }
        case 'leave':
          summary.current = null;
          setState(null);
          break;
        case 'drop': {
          summary.current = null;
          setState(null);
          const target = locate(event.x, event.y);
          if (target && !claimed.has(event.pickId)) {
            claimed.add(event.pickId);
            handler.current({
              pickId: event.pickId,
              files: event.files,
              dirs: event.dirs,
              other: event.other,
              target,
            });
          }
          break;
        }
      }
    });
    return stop;
  }, [root, enabled]);

  return state;
}

/**
 * Application-level cleanup: a drop that no panel accepted (it landed on the
 * terminal, the tab bar, a dialog or outside every SFTP list) is forgotten at
 * once instead of waiting for the time-out.
 */
export function useDiscardUnclaimedDrops(): void {
  useEffect(
    () =>
      onFileDrag((event) => {
        if (event.phase !== 'drop') return;
        const id = event.pickId;
        window.setTimeout(() => {
          if (claimed.has(id)) claimed.delete(id);
          else void ipc.sftpDiscardPick(id).catch(() => undefined);
        }, 50);
      }),
    [],
  );
}
