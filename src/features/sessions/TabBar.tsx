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
import { Icon } from '../../components/Icon';
import { requestCloseTab } from '../../app/actions';
import { shortcutLabel, SHORTCUTS } from '../../shared/platform';
import { useSettings } from '../settings/store';
import { useTabs, type Tab } from './store';

export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const activate = useTabs((s) => s.activate);
  const moveTab = useTabs((s) => s.moveTab);
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
          title={`Toggle sidebar (${shortcutLabel(SHORTCUTS.toggleSidebar)})`}
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
                onActivate={activate}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableTab({
  tab,
  active,
  onActivate,
}: {
  tab: Tab;
  active: boolean;
  onActivate: (id: string) => void;
}) {
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
      title={tab.subtitle}
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
        title={`Close (${shortcutLabel(SHORTCUTS.closeTab)})`}
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
