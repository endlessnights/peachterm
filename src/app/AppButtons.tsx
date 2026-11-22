// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Icon } from '../components/Icon';
import { useShortcutLabel } from '../features/settings/shortcutState';
import { useLock } from '../features/lock/store';
import { lockApplication } from './commands';
import { openSettings } from './dialogs';

/**
 * Always-available entry points: Settings (and, once configured, Lock). Shown in
 * the sidebar footer, and in the status bar while the sidebar is collapsed.
 */
export function AppButtons({ compact = false }: { compact?: boolean }) {
  const settingsKey = useShortcutLabel('openSettings');
  const lockKey = useShortcutLabel('lockApp');
  const lockReady = useLock((s) => s.view?.enabled === true && s.view.configured);
  return (
    <div className={compact ? 'app-buttons app-buttons-compact' : 'app-buttons'}>
      <button
        className="icon-btn"
        aria-label="Settings"
        title={settingsKey ? `Settings (${settingsKey})` : 'Settings'}
        onClick={() => openSettings()}
      >
        <Icon name="settings" size={compact ? 13 : 15} />
      </button>
      {lockReady && (
        <button
          className="icon-btn"
          aria-label="Lock PeachTerm"
          title={lockKey ? `Lock PeachTerm (${lockKey})` : 'Lock PeachTerm'}
          onClick={lockApplication}
        >
          <Icon name="lock" size={compact ? 13 : 15} />
        </button>
      )}
    </div>
  );
}
