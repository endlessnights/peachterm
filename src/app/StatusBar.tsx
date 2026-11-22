import { useCredentialStatus } from '../features/connections/useCredentialStatus';
import { useConnections } from '../features/connections/store';
import { useTabs } from '../features/sessions/store';
import { Icon } from '../components/Icon';
import { openSettings } from './dialogs';

export function StatusBar({ version }: { version: string }) {
  const count = useConnections((s) => s.tree.connections.length);
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const credentials = useCredentialStatus();
  const connected = tabs.filter((t) => t.status === 'connected').length;

  return (
    <footer className="statusbar">
      {active ? (
        <span className="statusbar-item">
          <span className="status-dot" data-status={active.status} />
          {active.subtitle} · {active.status}
        </span>
      ) : (
        <span className="statusbar-item">Ready</span>
      )}
      <span className="spacer" />
      <span className="statusbar-item">
        {connected}/{tabs.length} sessions
      </span>
      <span className="statusbar-item">{count} saved</span>
      <button
        className="statusbar-item icon-btn"
        style={{ width: 'auto', height: 20, padding: '0 6px', fontSize: 11.5 }}
        onClick={openSettings}
        title={
          credentials?.available
            ? `Passwords: ${credentials.backend}`
            : 'Secure storage unavailable'
        }
      >
        <Icon name="lock" size={12} />
        {credentials ? (credentials.available ? credentials.backend : 'No keychain') : '…'}
      </button>
      {version && <span className="statusbar-item">v{version}</span>}
    </footer>
  );
}
