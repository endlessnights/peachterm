// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// One SFTP panel for the whole workspace, placed beside the terminals (left or
// right), resizable and collapsible. Side, width and visibility are remembered
// in the settings.
//
// Every tab owns its own SftpPanel instance (kept mounted, shown only for the
// FOCUSED terminal), so each SSH session keeps its own directory, listing and
// transfers, and a listing can never be shown under another server's name.

import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { ResizeHandle } from '../../components/ResizeHandle';
import { reportError } from '../../components/Toasts';
import { useTabs } from '../sessions/store';
import { useSettings } from '../settings/store';
import { NotesPanel } from '../notes/NotesPanel';
import { useNotes } from '../notes/store';
import { SftpPanel } from './SftpPanel';

export function SftpDock({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const side = useSettings((s) => s.settings.ui.sftpSide);
  const width = useSettings((s) => s.settings.ui.sftpWidth);
  const visible = useSettings((s) => s.settings.sftp.defaultVisible);
  const setUi = useSettings((s) => s.setUi);
  const persistUi = useSettings((s) => s.persistUi);
  const active = tabs.find((t) => t.id === activeId);
  // Notes share this panel. The Files | Notes switch only exists when the connection
  // has notes (or Notes was opened on purpose); otherwise the panel is just SFTP.
  const notesCount = useNotes((s) =>
    active?.kind === 'ssh' ? (s.counts[active.connectionId] ?? 0) : 0,
  );
  const notesView = useNotes((s) => s.view);
  const setNotesView = useNotes((s) => s.setView);
  const showNotes = active?.kind === 'ssh' && notesView === 'notes';
  const hasSwitch = showNotes || notesCount > 0;

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

  // SFTP belongs to SSH sessions only: a local shell has no panel and no toggle.
  const sftpAvailable = !active || active.kind === 'ssh';

  const panel = !sftpAvailable ? null : visible ? (
    <>
      {side === 'right' && (
        <ResizeHandle
          label={t('sftp.dock.resize')}
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
          {hasSwitch ? (
            <div className="segmented sftp-switch" role="group" aria-label={t('sftp.dock.panel')}>
              <button type="button" aria-pressed={!showNotes} onClick={() => setNotesView('files')}>
                {t('sftp.dock.files')}
              </button>
              <button type="button" aria-pressed={showNotes} onClick={() => setNotesView('notes')}>
                {t('sftp.dock.notes')}
              </button>
            </div>
          ) : (
            <span className="sftp-title">SFTP</span>
          )}
          <button
            className="icon-btn"
            aria-label={t('sftp.dock.leftAria')}
            title={t('sftp.dock.left')}
            aria-pressed={side === 'left'}
            data-active={side === 'left' || undefined}
            onClick={() => dockTo('left')}
          >
            <Icon name="panelLeft" />
          </button>
          <button
            className="icon-btn"
            aria-label={t('sftp.dock.rightAria')}
            title={t('sftp.dock.right')}
            aria-pressed={side === 'right'}
            data-active={side === 'right' || undefined}
            onClick={() => dockTo('right')}
          >
            <Icon name="panelRight" />
          </button>
          <button
            className="icon-btn"
            aria-label={t('sftp.dock.collapseAria')}
            title={t('sftp.dock.collapse')}
            onClick={() => setVisible(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        {active && !showNotes && (
          <div className="sftp-identity" aria-live="polite" data-testid="sftp-identity">
            <span className="status-dot" data-status={active.status} />
            <span className="sftp-identity-name">{active.title}</span>
            <span className="sftp-identity-host">{active.subtitle}</span>
          </div>
        )}
        {showNotes && active && (
          <div className="sftp-slot notes-slot">
            <NotesPanel
              key={active.connectionId}
              connectionId={active.connectionId}
              connectionName={active.title}
            />
          </div>
        )}
        <div className="sftp-slots" style={showNotes ? { display: 'none' } : undefined}>
          {tabs
            .filter((tab) => tab.kind === 'ssh')
            .map((tab) => (
              <div
                key={tab.id}
                className="sftp-slot"
                hidden={tab.id !== activeId}
                aria-label={t('sftp.dock.filesOf', { title: tab.title })}
              >
                <SftpPanel tab={tab} />
              </div>
            ))}
        </div>
      </aside>
      {side === 'left' && (
        <ResizeHandle
          label={t('sftp.dock.resize')}
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
      aria-label={t('sftp.dock.show')}
      title={t('sftp.dock.show')}
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
