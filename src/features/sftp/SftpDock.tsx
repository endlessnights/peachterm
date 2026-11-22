// One SFTP panel for the whole workspace, placed beside the terminals (left or
// right), resizable and collapsible. Side, width and visibility are remembered
// in the settings.
//
// Every tab owns its own SftpPanel instance (kept mounted, shown only for the
// FOCUSED terminal), so each SSH session keeps its own directory, listing and
// transfers, and a listing can never be shown under another server's name.

import { Icon } from '../../components/Icon';
import { ResizeHandle } from '../../components/ResizeHandle';
import { reportError } from '../../components/Toasts';
import { useTabs } from '../sessions/store';
import { useSettings } from '../settings/store';
import { SftpPanel } from './SftpPanel';

export function SftpDock({ children }: { children: React.ReactNode }) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const side = useSettings((s) => s.settings.ui.sftpSide);
  const width = useSettings((s) => s.settings.ui.sftpWidth);
  const visible = useSettings((s) => s.settings.sftp.defaultVisible);
  const setUi = useSettings((s) => s.setUi);
  const persistUi = useSettings((s) => s.persistUi);
  const active = tabs.find((t) => t.id === activeId);

  const setVisible = (defaultVisible: boolean) => {
    const settings = useSettings.getState().settings;
    void useSettings
      .getState()
      .save({ ...settings, sftp: { ...settings.sftp, defaultVisible } })
      .catch(reportError);
  };
  const dockTo = (next: 'left' | 'right') => {
    setUi({ sftpSide: next });
    void persistUi().catch(reportError);
  };

  const panel = visible ? (
    <>
      {side === 'right' && (
        <ResizeHandle
          label="Resize SFTP panel"
          value={width}
          min={220}
          max={720}
          direction={-1}
          onChange={(sftpWidth) => setUi({ sftpWidth })}
          onCommit={() => void persistUi().catch(reportError)}
        />
      )}
      <aside className="sftp-panel" style={{ width }} aria-label="SFTP">
        <div className="sftp-header">
          <span className="sftp-title">SFTP</span>
          <button
            className="icon-btn"
            aria-label="Dock panel left"
            title="Dock left"
            aria-pressed={side === 'left'}
            data-active={side === 'left' || undefined}
            onClick={() => dockTo('left')}
          >
            <Icon name="panelLeft" />
          </button>
          <button
            className="icon-btn"
            aria-label="Dock panel right"
            title="Dock right"
            aria-pressed={side === 'right'}
            data-active={side === 'right' || undefined}
            onClick={() => dockTo('right')}
          >
            <Icon name="panelRight" />
          </button>
          <button
            className="icon-btn"
            aria-label="Collapse SFTP panel"
            title="Collapse"
            onClick={() => setVisible(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        {active && (
          <div className="sftp-identity" aria-live="polite" data-testid="sftp-identity">
            <span className="status-dot" data-status={active.status} />
            <span className="sftp-identity-name">{active.title}</span>
            <span className="sftp-identity-host">{active.subtitle}</span>
          </div>
        )}
        <div className="sftp-slots">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="sftp-slot"
              hidden={tab.id !== activeId}
              aria-label={`Files of ${tab.title}`}
            >
              <SftpPanel tab={tab} />
            </div>
          ))}
        </div>
      </aside>
      {side === 'left' && (
        <ResizeHandle
          label="Resize SFTP panel"
          value={width}
          min={220}
          max={720}
          direction={1}
          onChange={(sftpWidth) => setUi({ sftpWidth })}
          onCommit={() => void persistUi().catch(reportError)}
        />
      )}
    </>
  ) : (
    <button
      className="sftp-tab"
      aria-label="Show SFTP panel"
      title="Show SFTP panel"
      onClick={() => setVisible(true)}
    >
      <Icon name="folder" />
    </button>
  );

  return (
    <div className="session-body" data-side={side}>
      {side === 'left' && panel}
      <div className="session-terminal">{children}</div>
      {side === 'right' && panel}
    </div>
  );
}
