// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Drag-and-drop for the workspace: tabs can be re-ordered in the tab bar and
// dropped on a terminal pane to split it. One DndContext covers both areas.
// A dragged tab MOVES its existing session; nothing reconnects or duplicates.

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import type { ReactNode } from 'react';
import { useDrag } from './dragStore';
import { zoneFor, type Zone } from './layout';
import { dropTab } from './splitActions';
import { useTabs } from './store';

const PANE_PREFIX = 'pane:';

/** Inside the tab bar tabs sort; over the workspace panes are drop targets. */
const collision: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  const bar = document.querySelector('.tabbar')?.getBoundingClientRect();
  const inBar = !!pointer && !!bar && pointer.y >= bar.top && pointer.y <= bar.bottom;
  if (inBar) {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => !String(c.id).startsWith(PANE_PREFIX),
      ),
    });
  }
  return pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) =>
      String(c.id).startsWith(PANE_PREFIX),
    ),
  });
};

export function WorkspaceDnd({ children }: { children: ReactNode }) {
  // A small distance keeps plain clicks from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dragging = useDrag((s) => s.tabId);
  const draggedTab = useTabs((s) => s.tabs.find((t) => t.id === dragging));
  const set = useDrag((s) => s.set);

  const onDragMove = (event: DragMoveEvent) => {
    const over = event.over;
    const origin = event.activatorEvent as PointerEvent | MouseEvent;
    if (!over || !String(over.id).startsWith(PANE_PREFIX) || !('clientX' in origin)) {
      if (useDrag.getState().preview) set({ preview: null });
      return;
    }
    const x = origin.clientX + event.delta.x;
    const y = origin.clientY + event.delta.y;
    const r = over.rect;
    const zone = zoneFor({ x: r.left, y: r.top, w: r.width, h: r.height }, x, y);
    const leafId = String(over.id).slice(PANE_PREFIX.length);
    const current = useDrag.getState().preview;
    if (current?.leafId !== leafId || current.zone !== zone) set({ preview: { leafId, zone } });
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { preview } = useDrag.getState();
    const tabId = String(event.active.id);
    set({ tabId: null, preview: null });
    if (preview) {
      if (preview.zone === 'center') {
        // "Drop onto a pane": offer the valid targets for it
        set({ chooser: { tabId, leafId: preview.leafId } });
      } else {
        dropTab(tabId, preview.leafId, preview.zone as Exclude<Zone, 'center'>);
      }
      return;
    }
    const over = event.over;
    if (over && !String(over.id).startsWith(PANE_PREFIX) && over.id !== event.active.id) {
      useTabs.getState().moveTab(tabId, String(over.id));
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(e) => set({ tabId: String(e.active.id), preview: null, chooser: null })}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => set({ tabId: null, preview: null })}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {draggedTab ? (
          <div className="tab tab-ghost" role="presentation">
            <span className="status-dot" data-status={draggedTab.status} />
            <span className="tab-title">{draggedTab.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
