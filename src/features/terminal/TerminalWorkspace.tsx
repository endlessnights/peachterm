// The terminal area. Each tab keeps its own pane mounted (hidden when
// inactive) so every xterm instance and its scrollback survive tab switches.

import { Logo, Icon } from '../../components/Icon';
import { openConnectionEditor } from '../../app/dialogs';
import { useShortcutLabel } from '../settings/shortcutState';
import { useTabs } from '../sessions/store';
import { SftpDock } from '../sftp/SftpDock';
import { TerminalView } from './TerminalView';

export function TerminalWorkspace() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);

  return (
    <div className="terminal-area">
      {tabs.length === 0 && <Welcome />}
      {tabs.map((tab) => (
        <div key={tab.id} className="terminal-pane" hidden={tab.id !== activeId} role="tabpanel">
          <SftpDock tab={tab}>
            <TerminalView tab={tab} active={tab.id === activeId} />
          </SftpDock>
        </div>
      ))}
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
    </div>
  );
}
