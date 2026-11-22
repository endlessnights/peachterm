import { Icon } from '../components/Icon';
import { useShortcutLabel } from '../features/settings/shortcutState';
import { openSettings } from './dialogs';

/**
 * Always-available entry points: Settings (and, once configured, Lock). Shown in
 * the sidebar footer, and in the status bar while the sidebar is collapsed.
 */
export function AppButtons({ compact = false }: { compact?: boolean }) {
  const settingsKey = useShortcutLabel('openSettings');
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
    </div>
  );
}
