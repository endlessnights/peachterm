// Phase 1 placeholder for the terminal area. Each tab keeps its own pane
// mounted (hidden when inactive) so that in Phase 2 every xterm instance and
// its scrollback survive tab switches without re-rendering.

import { Logo, Icon } from '../../components/Icon';
import { openConnectionEditor } from '../../app/dialogs';
import { shortcutLabel, SHORTCUTS } from '../../shared/platform';
import { useConnections } from '../connections/store';
import { useTabs, type Tab } from '../sessions/store';

export function TerminalWorkspace() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);

  return (
    <div className="terminal-area">
      {tabs.length === 0 && <Welcome />}
      {tabs.map((tab) => (
        <div key={tab.id} className="terminal-pane" hidden={tab.id !== activeId} role="tabpanel">
          <SessionPlaceholder tab={tab} />
        </div>
      ))}
    </div>
  );
}

function Welcome() {
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
        <span className="kbd">{shortcutLabel(SHORTCUTS.newConnection)}</span>
        <span>Toggle sidebar</span>
        <span className="kbd">{shortcutLabel(SHORTCUTS.toggleSidebar)}</span>
        <span>Search connections</span>
        <span className="kbd">{shortcutLabel(SHORTCUTS.search)}</span>
        <span>Close tab</span>
        <span className="kbd">{shortcutLabel(SHORTCUTS.closeTab)}</span>
        <span>Settings</span>
        <span className="kbd">{shortcutLabel(SHORTCUTS.settings)}</span>
      </div>
    </div>
  );
}

function SessionPlaceholder({ tab }: { tab: Tab }) {
  const connection = useConnections((s) =>
    s.tree.connections.find((c) => c.id === tab.connectionId),
  );
  return (
    <div className="session-card">
      <h2>{tab.title}</h2>
      <div className="hint">Interactive SSH terminals arrive in Phase 2.</div>
      {connection ? (
        <dl>
          <dt>Host</dt>
          <dd>
            {connection.host}:{connection.port}
          </dd>
          <dt>User</dt>
          <dd>{connection.username || '—'}</dd>
          <dt>Auth</dt>
          <dd>{connection.auth}</dd>
          {connection.keyPath && (
            <>
              <dt>Key</dt>
              <dd>{connection.keyPath}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="hint">This saved connection was deleted.</p>
      )}
      <button className="btn" disabled title="Available in Phase 2">
        <Icon name="terminal" /> Connect
      </button>
    </div>
  );
}
