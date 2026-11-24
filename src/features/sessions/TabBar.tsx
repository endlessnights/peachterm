// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import {
  closeAllTabsForHost,
  closeOtherTabs,
  closeOtherTabsForHost,
  closeTabsToTheRight,
  duplicateTab,
  renameTabDialog,
  tabColorsDialog,
  tunnelsDialog,
  requestCloseTab,
  tabsForSameConnection,
} from '../../app/actions';
import { notify } from '../../components/Toasts';
import { showNotesOfTab } from '../notes/open';
import { useShortcutLabel } from '../settings/shortcutState';
import { shownTabs } from './layout';
import { moveToNewPane, splitFocused } from './splitActions';
import { useSettings } from '../settings/store';
import { defaultProfile, useProfiles } from '../terminal/profilesStore';
import { openLocalShell } from '../../app/actions';
import { useTabs, type Tab } from './store';

/** Wheel over the tab strip scrolls it sideways (vertical wheel -> horizontal). */
export function wheelToScroll(el: HTMLElement, e: WheelEvent): boolean {
  if (el.scrollWidth <= el.clientWidth) return false;
  const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? el.clientWidth : 1;
  const raw = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (raw === 0) return false;
  el.scrollLeft += raw * unit;
  return true;
}

/** Scroll just enough to bring the tab fully into view. */
export function revealTab(strip: HTMLElement, tab: HTMLElement) {
  const left = tab.offsetLeft - strip.offsetLeft;
  const right = left + tab.offsetWidth;
  if (left < strip.scrollLeft) strip.scrollLeft = left;
  else if (right > strip.scrollLeft + strip.clientWidth)
    strip.scrollLeft = right - strip.clientWidth;
}

export function TabBar() {
  const stripRef = useRef<HTMLDivElement>(null);
  const revealed = useRef<string | null>(null);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const activate = useTabs((s) => s.activate);
  const layout = useTabs((s) => s.layout);
  const visible = new Set(shownTabs(layout));
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);

  const openMenu = (tab: Tab, x: number, y: number) => {
    const all = useTabs.getState().tabs;
    const index = all.findIndex((t) => t.id === tab.id);
    const sameHost = tabsForSameConnection(tab.id);
    const entries: MenuEntry[] = [
      { kind: 'item', label: 'Rename Tab…', icon: 'edit', onSelect: () => renameTabDialog(tab.id) },
      { kind: 'item', label: 'Duplicate Tab', icon: 'copy', onSelect: () => duplicateTab(tab.id) },
      {
        kind: 'item',
        label: 'Terminal Colors…',
        onSelect: () => tabColorsDialog(tab.id),
      },
      ...(tab.kind === 'ssh'
        ? ([
            {
              kind: 'item',
              label: 'Notes & Documentation',
              onSelect: () => showNotesOfTab(tab.id),
            },
            {
              kind: 'item',
              label: 'SSH Tunnels…',
              onSelect: () => tunnelsDialog(tab.id),
            },
          ] as MenuEntry[])
        : []),
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Split Horizontally',
        icon: 'splitHorizontal',
        onSelect: () => {
          useTabs.getState().activate(tab.id);
          splitFocused('horizontal');
        },
      },
      {
        kind: 'item',
        label: 'Split Vertically',
        icon: 'splitVertical',
        onSelect: () => {
          useTabs.getState().activate(tab.id);
          splitFocused('vertical');
        },
      },
      {
        kind: 'item',
        label: 'Show in New Pane: Left',
        onSelect: () => moveToNewPane(tab.id, 'left'),
      },
      {
        kind: 'item',
        label: 'Show in New Pane: Right',
        onSelect: () => moveToNewPane(tab.id, 'right'),
      },
      {
        kind: 'item',
        label: 'Show in New Pane: Above',
        onSelect: () => moveToNewPane(tab.id, 'top'),
      },
      {
        kind: 'item',
        label: 'Show in New Pane: Below',
        onSelect: () => moveToNewPane(tab.id, 'bottom'),
      },
      {
        kind: 'item',
        label: 'Remove from Split',
        disabled: !visible.has(tab.id) || !layout,
        onSelect: () => {
          const leaf =
            layout &&
            [
              ...(function* walk(
                n: typeof layout,
              ): Generator<{ id: string; tabId: string | null }> {
                if (n.kind === 'leaf') yield n;
                else {
                  yield* walk(n.a);
                  yield* walk(n.b);
                }
              })(layout),
            ].find((l) => l.tabId === tab.id);
          if (leaf) useTabs.getState().removePane(leaf.id);
          else notify('That tab is not shown in a split.');
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
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    // native listener: React's wheel handlers are passive and cannot preventDefault
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (wheelToScroll(el, e)) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // Reveal the active tab when it changes (new tab, shortcut, sidebar, restore);
  // a manual scroll afterwards is left alone.
  const tabCount = tabs.length;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeId || revealed.current === activeId) return;
    const el = Array.from(strip.children).find(
      (c) => (c as HTMLElement).dataset.tabId === activeId,
    ) as HTMLElement | undefined;
    if (!el) return;
    revealTab(strip, el);
    revealed.current = activeId;
  }, [activeId, tabCount]);

  const profilesLoaded = useProfiles((s) => s.loaded);
  const refreshProfiles = useProfiles((s) => s.refresh);
  useEffect(() => {
    if (!profilesLoaded) void refreshProfiles();
  }, [profilesLoaded, refreshProfiles]);

  const startDefault = async () => {
    if (!useProfiles.getState().loaded) await useProfiles.getState().refresh();
    const profile = defaultProfile();
    if (profile) openLocalShell(profile);
    else notify('No local shell was found on this computer.');
  };
  const profileMenu = (x: number, y: number) => {
    const { profiles, defaultId } = useProfiles.getState();
    const entries: MenuEntry[] = profiles.map((p) => ({
      kind: 'item' as const,
      label: p.id === defaultId ? `${p.name} (default)` : p.name,
      icon: 'terminal' as const,
      onSelect: () => openLocalShell(p),
    }));
    if (entries.length === 0) {
      entries.push({
        kind: 'item',
        label: 'No local shells found',
        disabled: true,
        onSelect: () => {},
      });
    }
    entries.push(
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Refresh Profiles',
        icon: 'refresh',
        onSelect: () => void refreshProfiles(),
      },
    );
    setMenu({ x, y, entries });
  };
  const sidebarLabel = useShortcutLabel('toggleSidebar');
  const sidebarVisible = useSettings((s) => s.settings.ui.sidebarVisible);
  const setUi = useSettings((s) => s.setUi);
  const persistUi = useSettings((s) => s.persistUi);

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
      <div className="tabs-wrap">
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div ref={stripRef} className="tabs" role="tablist" aria-label="Sessions">
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                shown={visible.has(tab.id)}
                onActivate={activate}
                onMenu={openMenu}
              />
            ))}
          </div>
        </SortableContext>
        <button
          className="icon-btn tabs-add"
          aria-label="New local terminal"
          title="New local terminal (right-click to choose a shell)"
          onClick={() => void startDefault()}
          onContextMenu={(e) => {
            e.preventDefault();
            profileMenu(e.clientX, e.clientY);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              profileMenu(r.left, r.bottom);
            }
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function SortableTab({
  tab,
  active,
  shown,
  onActivate,
  onMenu,
}: {
  tab: Tab;
  active: boolean;
  /** The tab is visible in a pane of a split. */
  shown: boolean;
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
      data-tab-id={tab.id}
      role="tab"
      aria-selected={active}
      data-dragging={isDragging || undefined}
      data-pane={shown ? '' : undefined}
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
