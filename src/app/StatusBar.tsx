// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useCredentialStatus } from '../features/connections/useCredentialStatus';
import { useConnections } from '../features/connections/store';
import { useTabs } from '../features/sessions/store';
import { Icon } from '../components/Icon';
import { AppButtons } from './AppButtons';
import { useSettings } from '../features/settings/store';
import { MonitorBar } from '../features/monitor/MonitorBar';
import { useTranslation } from 'react-i18next';

export function StatusBar({ version }: { version: string }) {
  const { t } = useTranslation();
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
          {active.subtitle} · {t(`status.${active.status}`)}
        </span>
      ) : (
        <span className="statusbar-item">{t('status.ready')}</span>
      )}
      <MonitorBar />
      <span className="spacer" />
      <span className="statusbar-item">
        {t('status.sessions', { connected, total: tabs.length })}
      </span>
      <span className="statusbar-item">{t('status.saved', { count })}</span>
      <span
        className="statusbar-item"
        title={
          credentials?.available
            ? t('status.keychainStored', { backend: credentials.backend })
            : t('status.keychainUnavailable')
        }
      >
        <Icon name="lock" size={12} />
        {credentials ? (credentials.available ? credentials.backend : t('status.noKeychain')) : '…'}
      </span>
      {version && <span className="statusbar-item">v{version}</span>}
    </footer>
  );
}
