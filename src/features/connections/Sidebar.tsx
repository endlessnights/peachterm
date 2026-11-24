// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { reportError } from '../../components/Toasts';
import {
  connect,
  duplicateConnection,
  newFolder,
  requestDeleteItems,
  requestMoveItems,
} from '../../app/actions';
import { AppButtons } from '../../app/AppButtons';
import { openConnectionEditor, useDialogs } from '../../app/dialogs';
import { addNoteToConnection, showNotesOfConnection } from '../notes/open';
import type { ConnectionTree, ItemRef } from '../../shared/types';
import { useShortcutLabel } from '../settings/shortcutState';
import { useTabs, type TabStatus } from '../sessions/store';
import { planDrop, zoneFor, type DropPlan } from './dropTarget';
import { inDisplayOrder, rangeKeys, siblingKeys, stepKey, toggleKey } from './selection';
import { SidebarRow, type DropMark } from './SidebarRow';
import { useConnections } from './store';
import { buildTree, flattenRows, type Row } from './tree';
import {
  MAX_FOLDER_DEPTH,
  folderLevel,
  itemKey,
  sortedChildren,
  tooDeepFolders,
  validateMove,
} from './treeOps';

const STATUS_RANK: Record<TabStatus, number> = {
  connected: 4,
  connecting: 3,
  failed: 2,
  disconnected: 1,
  idle: 0,
};

/** Best status among all tabs of each connection (for the sidebar dot). */
function useConnectionStatuses(): Map<string, TabStatus> {
  const tabs = useTabs((s) => s.tabs);
  return useMemo(() => {
    const map = new Map<string, TabStatus>();
    for (const tab of tabs) {
      const current = map.get(tab.connectionId);
      if (!current || STATUS_RANK[tab.status] > STATUS_RANK[current]) {
        map.set(tab.connectionId, tab.status);
      }
    }
    return map;
  }, [tabs]);
}

interface DragState {
  items: ItemRef[];
  label: string;
  plan: DropPlan | null;
  problem: string | null;
}

function RootDropZone({ highlighted }: { highlighted: boolean }) {
  const { setNodeRef } = useDroppable({ id: 'root-zone' });
  return <div ref={setNodeRef} className="tree-root-drop" data-over={highlighted || undefined} />;
}

export function Sidebar({ width }: { width: number }) {
  const tree = useConnections((s) => s.tree);
  const query = useConnections((s) => s.query);
  const setQuery = useConnections((s) => s.setQuery);
  const selection = useConnections((s) => s.selection);
  const selectedId = useConnections((s) => s.selectedId);
  const anchorKey = useConnections((s) => s.anchorKey);
  const renamingId = useConnections((s) => s.renamingId);
  const setSelection = useConnections((s) => s.setSelection);
  const toggleFolder = useConnections((s) => s.toggleFolder);
  const renameItem = useConnections((s) => s.renameItem);
  const moveItems = useConnections((s) => s.moveItems);
  const statuses = useConnectionStatuses();
  const renameLabel = useShortcutLabel('rename');
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const expandTimer = useRef<{ key: string; id: number } | null>(null);

  const searching = query.trim().length > 0;
  const nodes = useMemo(() => buildTree(tree, query), [tree, query]);
  const rows = useMemo(() => flattenRows(nodes, searching), [nodes, searching]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const activeKey = useMemo(
    () => rows.find((r) => r.ref.id === selectedId)?.key ?? null,
    [rows, selectedId],
  );
  const deepCount = useMemo(() => tooDeepFolders(tree).length, [tree]);

  // ---- selection -----------------------------------------------------------

  /** The selected items in display order; a row outside the selection stands alone. */
  const itemsOfSelection = (fallback?: Row): ItemRef[] => {
    const picked = inDisplayOrder(rows, selection).map((r) => r.ref);
    if (picked.length > 0 && (!fallback || selected.has(fallback.key))) return picked;
    return fallback ? [fallback.ref] : picked;
  };

  const focusRow = (key: string) =>
    requestAnimationFrame(() => {
      // Never pull focus out of a dialog that opened in the meantime.
      if (useDialogs.getState().dialog) return;
      document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)?.focus();
    });

  const onClick = useCallback(
    (row: Row, e: React.MouseEvent) => {
      if (e.shiftKey && anchorKey) {
        setSelection(rangeKeys(rows, anchorKey, row.key), row.key);
      } else if (e.ctrlKey || e.metaKey) {
        const next = toggleKey(selection, row.key);
        setSelection(
          next,
          next.includes(row.key) ? row.key : (next[next.length - 1] ?? null),
          row.key,
        );
      } else {
        setSelection([row.key], row.key, row.key);
      }
    },
    [rows, selection, anchorKey, setSelection],
  );

  const onToggle = useCallback(
    (row: Row) => {
      if (searching) return;
      toggleFolder(row.ref.id).catch(reportError);
    },
    [toggleFolder, searching],
  );

  const onDoubleClick = useCallback(
    (row: Row) => {
      if (row.node.kind === 'connection') connect(row.node.connection);
      else onToggle(row);
    },
    [onToggle],
  );

  // ---- reordering via keyboard ---------------------------------------------

  const moveRelative = (direction: -1 | 1, only?: Row) => {
    const items = only ? [only.ref] : itemsOfSelection();
    if (items.length === 0) return;
    const first = rowByKey.get(itemKey(items[0]!));
    if (!first) return;
    const sameGroup = items.filter(
      (i) => i.kind === first.ref.kind && rowByKey.get(itemKey(i))?.parentId === first.parentId,
    );
    const siblings = sortedChildren(tree, first.parentId, first.ref.kind);
    const positions = sameGroup
      .map((i) => siblings.findIndex((s) => s.id === i.id))
      .sort((a, b) => a - b);
    const lo = positions[0]!;
    const hi = positions[positions.length - 1]!;
    let before: ItemRef | null;
    if (direction < 0) {
      if (lo <= 0) return;
      before = siblings[lo - 1]!;
    } else {
      if (hi >= siblings.length - 1) return;
      before = siblings[hi + 2] ?? null;
    }
    moveItems(sameGroup, first.parentId, before).catch(reportError);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input')) return;
    const active = activeKey ?? rows[0]?.key ?? null;
    const go = (key: string | null, extend: boolean) => {
      if (!key) return;
      e.preventDefault();
      if (extend && anchorKey) setSelection(rangeKeys(rows, anchorKey, key), key);
      else setSelection([key], key, key);
      focusRow(key);
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (e.altKey) {
          e.preventDefault();
          return moveRelative(e.key === 'ArrowUp' ? -1 : 1);
        }
        return go(stepKey(rows, active, e.key === 'ArrowDown' ? 1 : -1), e.shiftKey);
      }
      case 'Home':
        return go(rows[0]?.key ?? null, e.shiftKey);
      case 'End':
        return go(rows[rows.length - 1]?.key ?? null, e.shiftKey);
      case 'ArrowRight':
      case 'ArrowLeft': {
        const row = active ? rowByKey.get(active) : undefined;
        if (!row || row.node.kind !== 'folder') return;
        e.preventDefault();
        const open = row.expanded;
        if (e.key === 'ArrowRight' && !open) onToggle(row);
        else if (e.key === 'ArrowLeft' && open) onToggle(row);
        else if (e.key === 'ArrowLeft' && row.parentId) go(`f:${row.parentId}`, false);
        return;
      }
      case 'Enter': {
        const row = active ? rowByKey.get(active) : undefined;
        if (!row) return;
        e.preventDefault();
        return onDoubleClick(row);
      }
      case 'Delete': {
        e.preventDefault();
        return requestDeleteItems(itemsOfSelection());
      }
      case 'Escape':
        if (selection.length > 0) setSelection([], null, null);
        return;
      case 'a':
      case 'A': {
        if (!(e.ctrlKey || e.metaKey) || !active) return;
        e.preventDefault();
        // First press: everything in the focused list/folder; second press: everything.
        const siblings = siblingKeys(rows, active);
        const all = siblings.every((k) => selected.has(k)) ? rows.map((r) => r.key) : siblings;
        return setSelection(all, active, anchorKey ?? active);
      }
    }
  };

  // ---- context menu --------------------------------------------------------

  const openMenu = (e: React.MouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entries });
  };

  const rowMenu = (row: Row): MenuEntry[] => {
    const items = itemsOfSelection(row);
    if (items.length > 1) {
      return [
        {
          kind: 'item',
          label: `Move ${items.length} items to…`,
          icon: 'folder',
          onSelect: () => requestMoveItems(items),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: `Delete ${items.length} items…`,
          icon: 'trash',
          danger: true,
          onSelect: () => requestDeleteItems(items),
        },
      ];
    }
    const common: MenuEntry[] = [
      {
        kind: 'item',
        label: 'Rename',
        icon: 'edit',
        shortcut: renameLabel,
        onSelect: () => useConnections.getState().startRename(row.ref.id),
      },
    ];
    const order: MenuEntry[] = [
      {
        kind: 'item',
        label: 'Move to…',
        icon: 'folder',
        onSelect: () => requestMoveItems([row.ref]),
      },
      { kind: 'item', label: 'Move up', shortcut: 'Alt+↑', onSelect: () => moveRelative(-1, row) },
      { kind: 'item', label: 'Move down', shortcut: 'Alt+↓', onSelect: () => moveRelative(1, row) },
    ];
    const remove: MenuEntry = {
      kind: 'item',
      label: 'Delete…',
      icon: 'trash',
      danger: true,
      onSelect: () => requestDeleteItems([row.ref]),
    };
    if (row.node.kind === 'connection') {
      const c = row.node.connection;
      return [
        { kind: 'item', label: 'Connect', icon: 'plug', onSelect: () => connect(c) },
        { kind: 'separator' },
        ...common,
        { kind: 'item', label: 'Edit…', icon: 'edit', onSelect: () => openConnectionEditor(c) },
        {
          kind: 'item',
          label: 'Notes & Documentation',
          icon: 'file',
          onSelect: () => showNotesOfConnection(c),
        },
        { kind: 'item', label: 'Add note…', onSelect: () => addNoteToConnection(c) },
        {
          kind: 'item',
          label: 'Duplicate',
          icon: 'copy',
          onSelect: () => duplicateConnection(c),
        },
        { kind: 'separator' },
        ...order,
        { kind: 'separator' },
        remove,
      ];
    }
    const f = row.node.folder;
    const atLimit = folderLevel(tree, f.id) >= MAX_FOLDER_DEPTH;
    return [
      {
        kind: 'item',
        label: 'New connection here…',
        icon: 'plus',
        onSelect: () => openConnectionEditor(null, f.id),
      },
      // At the deepest allowed level the entry is simply absent (the backend still enforces the limit).
      ...(atLimit
        ? []
        : [
            {
              kind: 'item',
              label: 'New sub-folder…',
              icon: 'folderPlus',
              onSelect: () => newFolder(f.id),
            } as MenuEntry,
          ]),
      { kind: 'separator' },
      ...common,
      ...order,
      { kind: 'separator' },
      remove,
    ];
  };

  const emptyMenu: MenuEntry[] = [
    {
      kind: 'item',
      label: 'New connection…',
      icon: 'plus',
      onSelect: () => openConnectionEditor(null),
    },
    { kind: 'item', label: 'New folder…', icon: 'folderPlus', onSelect: () => newFolder(null) },
  ];

  // ---- rename --------------------------------------------------------------

  const commitRename = useCallback(
    async (row: Row, name: string) => {
      await renameItem(row.ref, name);
      useConnections.getState().stopRename();
      focusRow(row.key);
    },
    [renameItem],
  );
  const cancelRename = useCallback(() => useConnections.getState().stopRename(), []);

  // ---- drag and drop ------------------------------------------------------

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const describe = (items: ItemRef[], t: ConnectionTree): string => {
    if (items.length !== 1) return `${items.length} items`;
    const item = items[0]!;
    return (
      (item.kind === 'folder'
        ? t.folders.find((f) => f.id === item.id)?.name
        : t.connections.find((c) => c.id === item.id)?.name) ?? '1 item'
    );
  };

  const clearExpandTimer = () => {
    if (expandTimer.current) window.clearTimeout(expandTimer.current.id);
    expandTimer.current = null;
  };

  const onDragStart = (event: DragStartEvent) => {
    const key = String(event.active.id);
    const row = rowByKey.get(key);
    if (!row) return;
    const items = itemsOfSelection(row);
    if (!selected.has(key)) setSelection([key], key, key);
    setDrag({ items, label: describe(items, tree), plan: null, problem: null });
  };

  const onDragMove = (event: DragMoveEvent) => {
    setDrag((current) => {
      if (!current) return current;
      const over = event.over;
      let plan: DropPlan | null = null;
      if (over?.id === 'root-zone') {
        plan = planDrop(tree, null, 'into', current.items);
      } else if (over) {
        const row = rowByKey.get(String(over.id));
        const pointer = event.activatorEvent as PointerEvent;
        const y = pointer.clientY + event.delta.y;
        if (row && !current.items.some((i) => itemKey(i) === row.key)) {
          plan = planDrop(tree, row, zoneFor(y, over.rect, row), current.items);
        }
      }
      const problem = plan ? validateMove(tree, current.items, plan.target) : null;
      // Hovering a collapsed folder for a moment opens it.
      if (plan?.zone === 'into' && plan.rowKey && !problem) {
        const row = rowByKey.get(plan.rowKey);
        if (row && !row.expanded && expandTimer.current?.key !== plan.rowKey) {
          clearExpandTimer();
          expandTimer.current = {
            key: plan.rowKey,
            id: window.setTimeout(() => onToggle(row), 700),
          };
        }
      } else {
        clearExpandTimer();
      }
      if (
        current.plan?.rowKey === plan?.rowKey &&
        current.plan?.zone === plan?.zone &&
        current.problem === problem
      ) {
        return current;
      }
      return { ...current, plan, problem };
    });
  };

  const onDragEnd = (_event: DragEndEvent) => {
    clearExpandTimer();
    const current = drag;
    setDrag(null);
    if (!current?.plan) return;
    if (current.problem) {
      reportError({ code: 'validation', message: current.problem });
      return;
    }
    const target = current.plan.target;
    moveItems(current.items, target, current.plan.before)
      .then(() => {
        // Show where the items went.
        if (target && !tree.folders.find((f) => f.id === target)?.expanded) {
          return toggleFolder(target);
        }
      })
      .catch(reportError);
  };

  const dropMark = (key: string): DropMark | null =>
    drag?.plan?.rowKey === key ? { zone: drag.plan.zone, invalid: !!drag.problem } : null;

  const countOf = (row: Row) => (row.node.kind === 'folder' ? row.node.count : 0);

  return (
    <aside className="sidebar" style={{ width }} aria-label="Saved connections">
      <div className="sidebar-header">
        <span className="sidebar-title">Connections</span>
        <button
          className="icon-btn"
          title="New folder"
          aria-label="New folder"
          onClick={() => newFolder(null)}
        >
          <Icon name="folderPlus" />
        </button>
        <button
          className="icon-btn"
          title="New connection"
          aria-label="New connection"
          onClick={() => openConnectionEditor(null)}
        >
          <Icon name="plus" />
        </button>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={13} />
        <input
          id="sidebar-search"
          className="input"
          placeholder="Search name, host, user"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
          spellCheck={false}
          aria-label="Search connections"
        />
      </div>
      {deepCount > 0 && (
        <div className="notice notice-warn sidebar-banner" role="status">
          {deepCount === 1 ? 'One folder is' : `${deepCount} folders are`} nested deeper than{' '}
          {MAX_FOLDER_DEPTH} levels. Nothing was changed; move them up (drag, or right-click → Move
          to…) to reorganise.
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          clearExpandTimer();
          setDrag(null);
        }}
      >
        <div
          className="tree"
          role="tree"
          aria-multiselectable="true"
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('[data-row-key]')) return;
            openMenu(e, emptyMenu);
          }}
        >
          {rows.length === 0 ? (
            <div className="tree-empty">
              {searching ? (
                'No connections match your search.'
              ) : (
                <>
                  No saved connections yet.
                  <br />
                  <button className="btn btn-primary" onClick={() => openConnectionEditor(null)}>
                    <Icon name="plus" /> New connection
                  </button>
                </>
              )}
            </div>
          ) : (
            rows.map((row, index) => (
              <SidebarRow
                key={row.key}
                row={row}
                active={row.key === activeKey}
                selected={selected.has(row.key)}
                count={countOf(row)}
                status={row.node.kind === 'connection' ? statuses.get(row.ref.id) : undefined}
                renaming={renamingId === row.ref.id}
                dragDisabled={searching}
                drop={dropMark(row.key)}
                focusable={activeKey ? row.key === activeKey : index === 0}
                onClick={onClick}
                onDoubleClick={onDoubleClick}
                onToggle={onToggle}
                onContextMenu={(r, e) => {
                  if (!selected.has(r.key)) setSelection([r.key], r.key, r.key);
                  openMenu(e, rowMenu(r));
                }}
                onRename={commitRename}
                onCancelRename={cancelRename}
              />
            ))
          )}
          {!searching && <RootDropZone highlighted={!!drag?.plan && drag.plan.rowKey === null} />}
        </div>
        <DragOverlay dropAnimation={null}>
          {drag && (
            <div className="drag-chip" data-invalid={drag.problem ? 'true' : undefined}>
              <Icon name={drag.items[0]?.kind === 'folder' ? 'folder' : 'server'} />
              {drag.label}
            </div>
          )}
        </DragOverlay>
      </DndContext>
      {drag && (
        <div className="drag-status" role="status" data-invalid={drag.problem ? 'true' : undefined}>
          {drag.problem ?? (drag.plan ? 'Release to move here' : 'Drop on a folder to move')}
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
      <div className="sidebar-footer">
        <AppButtons />
      </div>
    </aside>
  );
}
