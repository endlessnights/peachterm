// The terminal area. Every tab keeps its own xterm instance mounted (hidden
// when it is not on screen), so scrollback and running programs survive tab
// switches, splitting and unsplitting without any re-connect.
//
// Layout: either one visible tab, or a split with two panes (side by side or
// stacked). Panes are positioned absolutely from the layout state, so changing
// the orientation or ratio never remounts a terminal.

import { useRef, type CSSProperties } from 'react';
import { Logo, Icon } from '../../components/Icon';
import { openConnectionEditor } from '../../app/dialogs';
import { useShortcutLabel } from '../settings/shortcutState';
import { SftpDock } from '../sftp/SftpDock';
import { RecentSessions } from '../sessions/RecentSessions';
import { clampRatio, useTabs, type Split } from '../sessions/store';
import { PanePicker } from './PanePicker';
import { TerminalView } from './TerminalView';

const GAP = 3; // half of the divider thickness in px

/** Where the pane at `index` goes (`undefined` = not shown). */
export function paneStyle(split: Split | null, index: number): CSSProperties | undefined {
  if (!split) return index === 0 ? { inset: 0 } : undefined;
  const r = `${(split.ratio * 100).toFixed(3)}%`;
  if (split.orientation === 'vertical') {
    return index === 0
      ? { top: 0, bottom: 0, left: 0, width: `calc(${r} - ${GAP}px)` }
      : { top: 0, bottom: 0, right: 0, left: `calc(${r} + ${GAP}px)` };
  }
  return index === 0
    ? { left: 0, right: 0, top: 0, height: `calc(${r} - ${GAP}px)` }
    : { left: 0, right: 0, bottom: 0, top: `calc(${r} + ${GAP}px)` };
}

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

function PaneArea() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const split = useTabs((s) => s.split);
  const focusPane = useTabs((s) => s.focusPane);
  const setRatio = useTabs((s) => s.setRatio);
  const area = useRef<HTMLDivElement>(null);

  const indexOf = (tabId: string): number =>
    split ? split.panes.indexOf(tabId) : tabId === activeId ? 0 : -1;

  const moveDivider = (clientX: number, clientY: number) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect || !split) return;
    setRatio(
      split.orientation === 'vertical'
        ? (clientX - rect.left) / rect.width
        : (clientY - rect.top) / rect.height,
    );
  };

  return (
    <div className="terminal-area" ref={area} data-split={split?.orientation}>
      {tabs.map((tab) => {
        const index = indexOf(tab.id);
        const style = index >= 0 ? paneStyle(split, index) : undefined;
        return (
          <div
            key={tab.id}
            className="terminal-pane"
            hidden={!style}
            style={style}
            role="tabpanel"
            aria-label={tab.title}
            data-focused={split ? (index === split.focus ? true : undefined) : undefined}
            // A click anywhere in a pane gives it the keyboard focus.
            onMouseDownCapture={() => split && index >= 0 && focusPane(index as 0 | 1)}
          >
            <TerminalView tab={tab} active={tab.id === activeId} />
          </div>
        );
      })}
      {split && split.panes[1] === null && (
        <div className="terminal-pane" style={paneStyle(split, 1)} data-focused={undefined}>
          <PanePicker />
        </div>
      )}
      {split && (
        <div
          className="split-divider"
          data-orientation={split.orientation}
          role="separator"
          aria-orientation={split.orientation === 'vertical' ? 'vertical' : 'horizontal'}
          aria-label="Resize split panes"
          aria-valuenow={Math.round(split.ratio * 100)}
          aria-valuemin={15}
          aria-valuemax={85}
          tabIndex={0}
          style={
            split.orientation === 'vertical'
              ? { left: `calc(${split.ratio * 100}% - ${GAP}px)` }
              : { top: `calc(${split.ratio * 100}% - ${GAP}px)` }
          }
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.dataset.dragging = 'true';
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.dataset.dragging) moveDivider(e.clientX, e.clientY);
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            delete e.currentTarget.dataset.dragging;
          }}
          onDoubleClick={() => setRatio(0.5)}
          onKeyDown={(e) => {
            const grow = split.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
            const shrink = split.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
            if (e.key !== grow && e.key !== shrink) return;
            e.preventDefault();
            setRatio(clampRatio(split.ratio + (e.key === grow ? 0.02 : -0.02)));
          }}
        />
      )}
    </div>
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
