import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToHorizontalAxisModifier } from './dndModifiers';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import {
  closeAllTabsForHost,
  closeOtherTabs,
  closeOtherTabsForHost,
  closeTabsToTheRight,
  duplicateTab,
  renameTabDialog,
  requestCloseTab,
  tabsForSameConnection,
} from '../../app/actions';
import { useShortcutLabel } from '../settings/shortcutState';
import { useSettings } from '../settings/store';
import { useTabs, type Tab } from './store';

export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const activate = useTabs((s) => s.activate);
  const moveTab = useTabs((s) => s.moveTab);
  const split = useTabs((s) => s.split);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);

  const openMenu = (tab: Tab, x: number, y: number) => {
    const all = useTabs.getState().tabs;
    const index = all.findIndex((t) => t.id === tab.id);
    const sameHost = tabsForSameConnection(tab.id);
    const entries: MenuEntry[] = [
      { kind: 'item', label: 'Rename Tab…', icon: 'edit', onSelect: () => renameTabDialog(tab.id) },
      { kind: 'item', label: 'Duplicate Tab', icon: 'copy', onSelect: () => duplicateTab(tab.id) },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Split Horizontally',
        icon: 'splitHorizontal',
        onSelect: () => {
          useTabs.getState().activate(tab.id);
          useTabs.getState().startSplit('horizontal');
        },
      },
      {
        kind: 'item',
        label: 'Split Vertically',
        icon: 'splitVertical',
        onSelect: () => {
          useTabs.getState().activate(tab.id);
          useTabs.getState().startSplit('vertical');
        },
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Close Tab', icon: 'close', onSelect: () => requestCloseTab(tab.id) },
      {
        kind: 'item',
        label: 'Close Other Tabs',
        disabled: all.length < 2,
        onSelect: () => closeOtherTabs(tab.id),
      },
      {
        kind: 'item',
        label: 'Close Tabs to the Right',
        disabled: index === all.length - 1,
        onSelect: () => closeTabsToTheRight(tab.id),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Close Other Tabs for This Host',
        disabled: sameHost.length < 2,
        onSelect: () => closeOtherTabsForHost(tab.id),
      },
      {
        kind: 'item',
        label: 'Close All Tabs for This Host',
        danger: true,
        onSelect: () => closeAllTabsForHost(tab.id),
      },
    ];
    setMenu({ x, y, entries });
  };
  const sidebarLabel = useShortcutLabel('toggleSidebar');
  const sidebarVisible = useSettings((s) => s.settings.ui.sidebarVisible);
  const setUi = useSettings((s) => s.setUi);
  const persistUi = useSettings((s) => s.persistUi);

  // A small activation distance keeps plain clicks from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = (event: DragEndEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      moveTab(String(event.active.id), String(event.over.id));
    }
  };

  return (
    <div className="tabbar">
      <div className="tabbar-toggle">
        <button
          className="icon-btn"
          aria-pressed={sidebarVisible}
          aria-label="Toggle sidebar"
          title={`Toggle sidebar (${sidebarLabel})`}
          onClick={() => {
            setUi({ sidebarVisible: !sidebarVisible });
            void persistUi();
          }}
        >
          <Icon name="sidebar" />
        </button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxisModifier]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div className="tabs" role="tablist" aria-label="Sessions">
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                pane={split ? split.panes.indexOf(tab.id) : -1}
                onActivate={activate}
                onMenu={openMenu}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function SortableTab({
  tab,
  active,
  pane,
  onActivate,
  onMenu,
}: {
  tab: Tab;
  active: boolean;
  /** 0 / 1 when the tab is shown in a split pane, -1 otherwise. */
  pane: number;
  onActivate: (id: string) => void;
  onMenu: (tab: Tab, x: number, y: number) => void;
}) {
  const closeLabel = useShortcutLabel('closeTab');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="tab"
      role="tab"
      aria-selected={active}
      data-dragging={isDragging || undefined}
      data-pane={pane >= 0 ? pane : undefined}
      title={`${tab.subtitle}${tab.customTitle ? ` (${tab.defaultTitle})` : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(tab, e.clientX, e.clientY);
      }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onMouseDown={(e) => {
        // Middle-click closes, like most tabbed apps.
        if (e.button === 1) {
          e.preventDefault();
          requestCloseTab(tab.id);
        }
      }}
      onClick={() => onActivate(tab.id)}
    >
      <span className="status-dot" data-status={tab.status} aria-label={tab.status} />
      <span className="tab-title">{tab.title}</span>
      <button
        className="icon-btn"
        aria-label={`Close ${tab.title}`}
        title={`Close (${closeLabel})`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          requestCloseTab(tab.id);
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
