// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The terminal area. Every tab keeps its own terminal mounted (hidden when it
// is not on screen), so scrollback and running programs survive tab switches,
// splitting, moving between panes and unsplitting without any re-connect.
//
// Layout: either one visible tab, or a split tree of up to six panes (side by
// side, stacked, or mixed). Panes are positioned absolutely from the layout, so
// changing the layout never remounts a terminal.

import { useDroppable } from '@dnd-kit/core';
import { useEffect, useRef, type CSSProperties } from 'react';
import { Logo, Icon } from '../../components/Icon';
import { openConnectionEditor } from '../../app/dialogs';
import { useShortcutLabel } from '../settings/shortcutState';
import { SftpDock } from '../sftp/SftpDock';
import { RecentSessions } from '../sessions/RecentSessions';
import { SINGLE_PANE, paneDropId, useDrag } from '../sessions/dragStore';
import {
  DIVIDER,
  leaves,
  place,
  previewRect,
  ratioLimits,
  type Branch,
  type Rect,
} from '../sessions/layout';
import { dropTab } from '../sessions/splitActions';
import { useTabs } from '../sessions/store';
import { PanePicker } from './PanePicker';
import { TerminalView } from './TerminalView';

const HALF = DIVIDER / 2;

/** CSS for a pane occupying `rect` (fractions of the workspace) with a gap at inner edges. */
export function paneStyle(rect: Rect): CSSProperties {
  const EPS = 1e-6;
  const left = rect.x > EPS ? HALF : 0;
  const top = rect.y > EPS ? HALF : 0;
  const right = rect.x + rect.w < 1 - EPS ? HALF : 0;
  const bottom = rect.y + rect.h < 1 - EPS ? HALF : 0;
  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
  return {
    left: `calc(${pct(rect.x)} + ${left}px)`,
    top: `calc(${pct(rect.y)} + ${top}px)`,
    width: `calc(${pct(rect.w)} - ${left + right}px)`,
    height: `calc(${pct(rect.h)} - ${top + bottom}px)`,
  };
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export function TerminalWorkspace() {
  const hasTabs = useTabs((s) => s.tabs.length > 0);
  if (!hasTabs) {
    return (
      <div className="terminal-area">
        <Welcome />
      </div>
    );
  }
  return (
    <SftpDock>
      <PaneArea />
    </SftpDock>
  );
}

function DropTarget({ id, rect }: { id: string; rect: Rect }) {
  const { setNodeRef } = useDroppable({ id: paneDropId(id) });
  return <div ref={setNodeRef} className="pane-drop-target" style={paneStyle(rect)} aria-hidden />;
}

function PaneArea() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const layout = useTabs((s) => s.layout);
  const focusLeaf = useTabs((s) => s.focusLeaf);
  const area = useRef<HTMLDivElement>(null);
  const dragging = useDrag((s) => s.tabId);
  const preview = useDrag((s) => s.preview);
  const chooser = useDrag((s) => s.chooser);

  // The store needs the size of the area to keep panes above their minimum size.
  useEffect(() => {
    const el = area.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // getBoundingClientRect is in zoomed CSS pixels already (WebView zoom)
      useTabs.getState().setArea(Math.round(r.width), Math.round(r.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const placed = layout ? place(layout) : null;

  const rectOfTab = (tabId: string): { rect: Rect; leafId: string } | null => {
    if (!layout || !placed) return tabId === activeId ? { rect: FULL, leafId: SINGLE_PANE } : null;
    for (const leaf of layout ? leaves(layout) : []) {
      if (leaf.tabId === tabId) return { rect: placed.leaves.get(leaf.id)!, leafId: leaf.id };
    }
    return null;
  };

  const moveDivider = (branch: Branch, rect: Rect, clientX: number, clientY: number) => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return;
    const ratio =
      branch.dir === 'row'
        ? (clientX - (box.left + rect.x * box.width)) / (rect.w * box.width)
        : (clientY - (box.top + rect.y * box.height)) / (rect.h * box.height);
    useTabs.getState().setBranchRatio(branch.id, ratio);
  };

  const showFocus = !!layout;
  const previewLeaf = preview?.leafId ?? null;
  const previewBase =
    previewLeaf === SINGLE_PANE ? FULL : previewLeaf ? placed?.leaves.get(previewLeaf) : undefined;

  return (
    <div className="terminal-area" ref={area} data-split={layout ? 'on' : undefined}>
      {tabs.map((tab) => {
        const where = rectOfTab(tab.id);
        return (
          <div
            key={tab.id}
            className="terminal-pane"
            hidden={!where}
            style={where ? paneStyle(where.rect) : undefined}
            role="tabpanel"
            aria-label={tab.title}
            data-focused={showFocus && where && where.leafId === focusLeaf ? true : undefined}
            // A click anywhere in a pane gives it the keyboard focus.
            onMouseDownCapture={() => where && layout && useTabs.getState().focusPane(where.leafId)}
          >
            {showFocus && (
              <div className="pane-title" data-status={tab.status}>
                <span className="status-dot" data-status={tab.status} />
                <span className="pane-title-text">{tab.title}</span>
                <span className="pane-title-sub">{tab.subtitle}</span>
              </div>
            )}
            <TerminalView tab={tab} active={tab.id === activeId} />
          </div>
        );
      })}

      {layout &&
        placed &&
        leaves(layout)
          .filter((leaf) => leaf.tabId === null)
          .map((leaf) => (
            <div
              key={leaf.id}
              className="terminal-pane"
              style={paneStyle(placed.leaves.get(leaf.id)!)}
              data-focused={leaf.id === focusLeaf ? true : undefined}
              onMouseDownCapture={() => useTabs.getState().focusPane(leaf.id)}
            >
              <PanePicker leafId={leaf.id} />
            </div>
          ))}

      {/* one droppable per pane (invisible; the preview below shows the result) */}
      {dragging &&
        (placed ? (
          [...placed.leaves.entries()].map(([id, rect]) => (
            <DropTarget key={id} id={id} rect={rect} />
          ))
        ) : (
          <DropTarget id={SINGLE_PANE} rect={FULL} />
        ))}

      {dragging && preview && previewBase && (
        <div
          className="drop-preview"
          data-zone={preview.zone}
          data-invalid={preview.valid ? undefined : true}
          style={paneStyle(previewRect(previewBase, preview.zone))}
          aria-hidden
        >
          <span>{preview.valid ? ZONE_LABEL[preview.zone] : `Cannot drop: ${preview.reason}`}</span>
        </div>
      )}

      {chooser && <DropChooser chooser={chooser} />}

      {placed &&
        placed.branches.map(({ branch, rect }) => (
          <Divider
            key={branch.id}
            branch={branch}
            rect={rect}
            onMove={(x, y) => moveDivider(branch, rect, x, y)}
          />
        ))}
    </div>
  );
}

const ZONE_LABEL = {
  left: 'Split left',
  right: 'Split right',
  top: 'Split above',
  bottom: 'Split below',
  center: 'Drop for options',
} as const;

/** The four split targets of a pane (plus "replace"), offered after a drop in its middle. */
function DropChooser({ chooser }: { chooser: { tabId: string; leafId: string } }) {
  const set = useDrag((s) => s.set);
  const close = () => set({ chooser: null });
  const go = (zone: 'left' | 'right' | 'top' | 'bottom') => {
    close();
    dropTab(chooser.tabId, chooser.leafId, zone);
  };
  return (
    <div className="drop-chooser" role="dialog" aria-label="Where should the tab go?">
      <div className="drop-chooser-title">Show this tab…</div>
      <button className="btn" onClick={() => go('left')} data-autofocus>
        Left of this pane
      </button>
      <button className="btn" onClick={() => go('right')}>
        Right of this pane
      </button>
      <button className="btn" onClick={() => go('top')}>
        Above this pane
      </button>
      <button className="btn" onClick={() => go('bottom')}>
        Below this pane
      </button>
      <button
        className="btn"
        onClick={() => {
          close();
          const s = useTabs.getState();
          if (s.layout && chooser.leafId !== SINGLE_PANE) s.fillLeaf(chooser.leafId, chooser.tabId);
          else s.activate(chooser.tabId);
        }}
      >
        Replace this pane
      </button>
      <button className="btn" onClick={close}>
        Cancel
      </button>
    </div>
  );
}

function Divider({
  branch,
  rect,
  onMove,
}: {
  branch: Branch;
  rect: Rect;
  onMove: (x: number, y: number) => void;
}) {
  const area = useTabs((s) => s.area);
  const row = branch.dir === 'row';
  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
  const style: CSSProperties = row
    ? {
        left: `calc(${pct(rect.x + rect.w * branch.ratio)} - ${HALF}px)`,
        top: pct(rect.y),
        height: pct(rect.h),
      }
    : {
        top: `calc(${pct(rect.y + rect.h * branch.ratio)} - ${HALF}px)`,
        left: pct(rect.x),
        width: pct(rect.w),
      };
  const { lo, hi } = ratioLimits(branch, rect, area);
  return (
    <div
      className="split-divider"
      data-orientation={row ? 'vertical' : 'horizontal'}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize split panes"
      aria-valuenow={Math.round(branch.ratio * 100)}
      aria-valuemin={Math.round(lo * 100)}
      aria-valuemax={Math.round(hi * 100)}
      tabIndex={0}
      style={style}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = 'true';
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.dataset.dragging) onMove(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        delete e.currentTarget.dataset.dragging;
      }}
      onDoubleClick={() => useTabs.getState().setBranchRatio(branch.id, 0.5)}
      onKeyDown={(e) => {
        const grow = row ? 'ArrowRight' : 'ArrowDown';
        const shrink = row ? 'ArrowLeft' : 'ArrowUp';
        if (e.key !== grow && e.key !== shrink) return;
        e.preventDefault();
        useTabs
          .getState()
          .setBranchRatio(branch.id, branch.ratio + (e.key === grow ? 0.02 : -0.02));
      }}
    />
  );
}

function Welcome() {
  const newConnection = useShortcutLabel('newConnection');
  const toggleSidebar = useShortcutLabel('toggleSidebar');
  const search = useShortcutLabel('searchConnections');
  const closeTab = useShortcutLabel('closeTab');
  const settingsKey = useShortcutLabel('openSettings');
  return (
    <div className="placeholder">
      <Logo className="logo" />
      <h2>PeachTerm</h2>
      <p>Double-click a saved connection to open it in a new tab.</p>
      <button
        className="btn btn-primary"
        style={{ marginTop: 14 }}
        onClick={() => openConnectionEditor(null)}
      >
        <Icon name="plus" /> New connection
      </button>
      <div className="shortcut-list">
        <span>New connection</span>
        <span className="kbd">{newConnection}</span>
        <span>Toggle sidebar</span>
        <span className="kbd">{toggleSidebar}</span>
        <span>Search connections</span>
        <span className="kbd">{search}</span>
        <span>Close tab</span>
        <span className="kbd">{closeTab}</span>
        <span>Settings</span>
        <span className="kbd">{settingsKey}</span>
      </div>
      <RecentSessions />
    </div>
  );
}
