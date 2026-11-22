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
import { useTabs } from '../features/sessions/store';
import { describeReason } from '../features/settings/DiagnosticsPage';
import { EditorPromptHost } from '../features/editor/EditorDialogs';
import { listenForEditor } from '../features/editor/store';
import { SshPromptHost } from '../features/ssh/PromptDialogs';
import { listenForPrompts } from '../features/ssh/promptStore';
import { RenameTabDialog } from '../features/sessions/RenameTabDialog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { useSettings } from '../features/settings/store';
import { TerminalWorkspace } from '../features/terminal/TerminalWorkspace';
import { LockScreen } from '../features/lock/LockScreen';
import { useLock } from '../features/lock/store';
import { useActivityTouch } from '../features/lock/useActivityTouch';
import { ipc, isTauri, toAppError } from '../shared/ipc';
import { restoreWorkspace, startWorkspacePersistence } from '../features/sessions/persistence';
import { useRecent } from '../features/sessions/recentStore';
import { useDialogs } from './dialogs';
import { useInterfaceScale } from './useInterfaceScale';
import { StatusBar } from './StatusBar';
import { useShortcuts } from './useShortcuts';
import { useTheme } from './useTheme';

export function App() {
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
  useActivityTouch();
  useInterfaceScale(settingsLoaded ? (preview ?? settings.appearance).interfaceScale : undefined);
  useEffect(() => startWorkspacePersistence(), []);

  const bootstrap = async () => {
    try {
      await Promise.all([useSettings.getState().load(), useConnections.getState().load()]);
    } catch (e) {
      setFatal(toAppError(e).message);
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
            .push(
              'error',
              `File logging is unavailable (${describeReason(status.error)}). PeachTerm keeps working; check Settings → Diagnostics.`,
            );
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
      .catch((e) => setFatal(toAppError(e).message));
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
        <h2>PeachTerm could not load its data</h2>
        <p>{fatal}</p>
        <p className="hint">
          No file was modified. Fix or move the file mentioned above and restart.
        </p>
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
        data-locked={locked || undefined}
        inert={locked}
        aria-hidden={locked || undefined}
      >
        <div className="main">
          {ui.sidebarVisible && (
            <>
              <Sidebar width={ui.sidebarWidth} />
              <ResizeHandle
                label="Resize sidebar"
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
            <TabBar />
            <TerminalWorkspace />
          </main>
        </div>
        <StatusBar version={version} />
        {!locked && <DialogHost />}
        {!locked && <SshPromptHost />}
        {!locked && <EditorPromptHost />}
        {!locked && <Toasts />}
      </div>
      {locked && <LockScreen />}
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
