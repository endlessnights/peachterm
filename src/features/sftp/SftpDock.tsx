// Places the SFTP panel beside the terminal: left or right, resizable and
// collapsible. Side, width and visibility are remembered in the settings.

import { Icon } from '../../components/Icon';
import { ResizeHandle } from '../../components/ResizeHandle';
import { reportError } from '../../components/Toasts';
import type { Tab } from '../sessions/store';
import { useSettings } from '../settings/store';
import { SftpPanel } from './SftpPanel';

interface Props {
  tab: Tab;
  children: React.ReactNode;
  onOpenFile?: Parameters<typeof SftpPanel>[0]['onOpenFile'];
}

export function SftpDock({ tab, children, onOpenFile }: Props) {
  const side = useSettings((s) => s.settings.ui.sftpSide);
  const width = useSettings((s) => s.settings.ui.sftpWidth);
  const visible = useSettings((s) => s.settings.sftp.defaultVisible);
  const setUi = useSettings((s) => s.setUi);
  const persistUi = useSettings((s) => s.persistUi);

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
        <SftpPanel tab={tab} onOpenFile={onOpenFile} />
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
