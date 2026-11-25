// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../i18n/errors';
import { useEffect, useState } from 'react';
import { ConfirmDialog, PromptDialog } from '../components/Dialog';
import { ResizeHandle } from '../components/ResizeHandle';
import { reportError, Toasts, useToasts } from '../components/Toasts';
import { ConnectionEditor } from '../features/connections/ConnectionEditor';
import { DeleteItemsDialog } from '../features/connections/DeleteItemsDialog';
import { MoveDialog } from '../features/connections/MoveDialog';
import { Sidebar } from '../features/connections/Sidebar';
import { useConnections } from '../features/connections/store';
import { TabBar } from '../features/sessions/TabBar';
import { WorkspaceDnd } from '../features/sessions/WorkspaceDnd';
import { useTabs } from '../features/sessions/store';
import { describeReason } from '../features/settings/DiagnosticsPage';
import { EditorPromptHost } from '../features/editor/EditorDialogs';
import { listenForEditor } from '../features/editor/store';
import { SshPromptHost } from '../features/ssh/PromptDialogs';
import { listenForPrompts } from '../features/ssh/promptStore';
import { TabColorsDialog } from '../features/sessions/TabColorsDialog';
import { RenameTabDialog } from '../features/sessions/RenameTabDialog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { useSettings } from '../features/settings/store';
import { TerminalWorkspace } from '../features/terminal/TerminalWorkspace';
import { LockScreen } from '../features/lock/LockScreen';
import { useLock } from '../features/lock/store';
import { useActivityTouch } from '../features/lock/useActivityTouch';
import { ipc, isTauri } from '../shared/ipc';
import { restoreWorkspace, startWorkspacePersistence } from '../features/sessions/persistence';
import { useRecent } from '../features/sessions/recentStore';
import { TunnelsDialog } from '../features/tunnels/TunnelsDialog';
import { ExitDialog } from '../features/exit/ExitDialog';
import { useNotes } from '../features/notes/store';
import { InstallConfirm, UpdateNotice } from '../features/updates/UpdateNotice';
import { startUpdateChecks, useUpdates } from '../features/updates/store';
import { installCloseHandler } from '../features/exit/exit';
import { useDialogs } from './dialogs';
import { useInterfaceScale } from './useInterfaceScale';
import { StatusBar } from './StatusBar';
import { MonitorController } from '../features/monitor/MonitorController';
import { useShortcuts } from './useShortcuts';
import { useTheme } from './useTheme';
import { useTranslation } from 'react-i18next';
import { applyLanguagePreference, t as tr } from '../i18n';

export function App() {
  const { t } = useTranslation();
  const settings = useSettings((s) => s.settings);
  const settingsLoaded = useSettings((s) => s.loaded);
  const setUi = useSettings((s) => s.setUi);
  const persistUi = useSettings((s) => s.persistUi);
  const connections = useConnections((s) => s.tree.connections);
  const lock = useLock((s) => s.view);
  const locked = lock?.locked === true;
  const [version, setVersion] = useState('');
  const [fatal, setFatal] = useState<string | null>(null);

  // While locked and nothing is loaded yet, the lock screen borrows the theme
  // from the lock status; otherwise the normal (possibly previewed) appearance.
  const preview = useSettings((s) => s.preview);
  useTheme(
    settingsLoaded
      ? (preview ?? settings.appearance)
      : { ...settings.appearance, theme: lock?.theme ?? 'dark', accent: lock?.accent ?? 'peach' },
  );
  useShortcuts();
  // The interface language follows the saved preference at once (no restart, no remount).
  useEffect(() => {
    applyLanguagePreference(settings.general.language);
  }, [settings.general.language]);
  useActivityTouch();
  useInterfaceScale(settingsLoaded ? (preview ?? settings.appearance).interfaceScale : undefined);
  useEffect(() => startWorkspacePersistence(), []);
  useEffect(() => installCloseHandler(), []);
  // Looking for updates: once shortly after start, then about daily, only while
  // the setting is on and the application is unlocked. Never installs anything.
  useEffect(() => {
    if (!settingsLoaded || locked) return undefined;
    void useUpdates.getState().refresh();
    void useNotes.getState().refreshCounts();
    return startUpdateChecks(() => useSettings.getState().settings.general.checkUpdates);
  }, [settingsLoaded, locked]);

  const bootstrap = async () => {
    try {
      await Promise.all([useSettings.getState().load(), useConnections.getState().load()]);
    } catch (e) {
      setFatal(errorMessage(e));
      return;
    }
    // Tabs of the previous run (metadata only; connecting is the user's choice).
    const loaded = useSettings.getState().settings.general;
    await restoreWorkspace(
      useConnections.getState().tree.connections,
      loaded.startup === 'restoreTabs' && loaded.autoReconnectRestored,
    );
    void useRecent.getState().refresh();
    ipc
      .appInfo()
      .then((info) => {
        setVersion(info.version);
        // Recoverable start-up problems (damaged config entries, fallback folder).
        info.issues.forEach((issue) => useToasts.getState().push('error', issue));
      })
      .catch(reportError);
    // Non-blocking notice if file logging cannot write; the app keeps working.
    ipc
      .loggingStatus()
      .then((status) => {
        if (status.enabled && !status.active) {
          useToasts
            .getState()
            .push('error', tr('app.loggingUnavailable', { reason: describeReason(status.error) }));
        }
      })
      .catch(() => undefined);
  };

  // Ask the backend first: a locked application loads nothing until unlocked
  // (the backend would refuse anyway).
  useEffect(() => {
    useLock
      .getState()
      .refresh()
      .then((view) => {
        if (!view.locked) void bootstrap();
      })
      .catch((e) => setFatal(errorMessage(e)));
    // The backend tells us when the timer or another window locks the app.
    let stop: (() => void) | undefined;
    if (isTauri()) {
      void import('@tauri-apps/api/event').then(({ listen }) =>
        listen<boolean>('lock-state-changed', (event) => {
          useLock.getState().setLocked(event.payload);
          void useLock.getState().refresh();
        }).then((un) => (stop = un)),
      );
    }
    return () => stop?.();
  }, []);

  // Locking clears everything transient: open dialogs (which may hold typed
  // secrets), toasts and key recording. Unlocking loads the data if it was not
  // loaded yet (application started locked).
  useEffect(() => {
    if (locked) {
      useDialogs.getState().close();
      useToasts.setState({ toasts: [] });
    } else if (useLock.getState().view && !useSettings.getState().loaded) {
      queueMicrotask(() => void bootstrap());
    }
  }, [locked]);

  // Host-key and credential questions from the SSH layer.
  useEffect(() => listenForPrompts(), []);
  // Progress and questions of the external-editor round trip.
  useEffect(() => listenForEditor(), []);

  // Tab titles follow edits of their saved connection.
  useEffect(() => {
    useTabs.getState().syncConnections(connections);
  }, [connections]);

  if (fatal) {
    return (
      <div className="placeholder" role="alert">
        <h2>{t('app.fatalTitle')}</h2>
        <p>{fatal}</p>
        <p className="hint">{t('app.fatalHint')}</p>
      </div>
    );
  }
  if (!lock) return null;
  if (!settingsLoaded && !locked) return null;

  const { ui } = settings;
  return (
    <>
      {/* While locked the workspace stays mounted (tabs and sessions are kept)
          but is inert and invisible: no input, no focus, nothing to read. */}
      <div
        className="app"
        data-statusbar={settings.general.showStatusBar ? 'on' : 'off'}
        data-locked={locked || undefined}
        inert={locked}
        aria-hidden={locked || undefined}
      >
        <div className="main">
          {ui.sidebarVisible && (
            <>
              <Sidebar width={ui.sidebarWidth} />
              <ResizeHandle
                label={t('app.resizeSidebar')}
                value={ui.sidebarWidth}
                min={160}
                max={640}
                direction={1}
                onChange={(sidebarWidth) => setUi({ sidebarWidth })}
                onCommit={() => void persistUi().catch(reportError)}
              />
            </>
          )}
          <main className="workspace">
            <WorkspaceDnd>
              <TabBar />
              <TerminalWorkspace />
            </WorkspaceDnd>
          </main>
        </div>
        {settings.general.showStatusBar && <StatusBar version={version} />}
        {settings.general.showStatusBar && <MonitorController />}
        {!locked && <DialogHost />}
        {!locked && <SshPromptHost />}
        {!locked && <EditorPromptHost />}
        {!locked && <UpdateNotice />}
        {!locked && <InstallConfirm />}
        {!locked && <Toasts />}
      </div>
      {locked && <LockScreen />}
      <ExitDialog />
    </>
  );
}

function DialogHost() {
  const dialog = useDialogs((s) => s.dialog);
  const close = useDialogs((s) => s.close);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'connection':
      return (
        <ConnectionEditor
          connection={dialog.connection}
          defaultFolderId={dialog.folderId}
          onClose={close}
        />
      );
    case 'move':
      return <MoveDialog items={dialog.items} onClose={close} />;
    case 'deleteItems':
      return <DeleteItemsDialog items={dialog.items} onClose={close} />;
    case 'renameTab':
      return <RenameTabDialog tabId={dialog.tabId} onClose={close} />;
    case 'tabColors':
      return <TabColorsDialog tabId={dialog.tabId} onClose={close} />;
    case 'tunnels':
      return <TunnelsDialog tabId={dialog.tabId} onClose={close} />;
    case 'settings':
      return <SettingsDialog onClose={close} initialPage={dialog.page} />;
    case 'confirm':
      return (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          onCancel={close}
          onConfirm={() => {
            close();
            dialog.onConfirm();
          }}
        />
      );
    case 'prompt':
      return (
        <PromptDialog
          title={dialog.title}
          label={dialog.label}
          initial={dialog.initial}
          confirmLabel={dialog.confirmLabel}
          hint={dialog.hint}
          validate={dialog.validate}
          onCancel={close}
          onSubmit={(value) => {
            close();
            dialog.onSubmit(value);
          }}
        />
      );
  }
}
