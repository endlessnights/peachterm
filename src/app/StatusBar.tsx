// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useCredentialStatus } from '../features/connections/useCredentialStatus';
import { useConnections } from '../features/connections/store';
import { useTabs } from '../features/sessions/store';
import { Icon } from '../components/Icon';
import { AppButtons } from './AppButtons';
import { useSettings } from '../features/settings/store';

export function StatusBar({ version }: { version: string }) {
  const count = useConnections((s) => s.tree.connections.length);
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const credentials = useCredentialStatus();
  const sidebarVisible = useSettings((s) => s.settings.ui.sidebarVisible);
  const connected = tabs.filter((t) => t.status === 'connected').length;

  return (
    <footer className="statusbar">
      {!sidebarVisible && <AppButtons compact />}
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
      <span
        className="statusbar-item"
        title={
          credentials?.available
            ? `Saved passwords are stored in ${credentials.backend}`
            : 'Secure credential storage is unavailable; passwords are not saved'
        }
      >
        <Icon name="lock" size={12} />
        {credentials ? (credentials.available ? credentials.backend : 'No keychain') : '…'}
      </span>
      {version && <span className="statusbar-item">v{version}</span>}
    </footer>
  );
}
