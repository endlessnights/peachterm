import { useEffect, useState } from 'react';
import { ConfirmDialog, PromptDialog } from '../components/Dialog';
import { ResizeHandle } from '../components/ResizeHandle';
import { reportError, Toasts } from '../components/Toasts';
import { ConnectionEditor } from '../features/connections/ConnectionEditor';
import { Sidebar } from '../features/connections/Sidebar';
import { useConnections } from '../features/connections/store';
import { TabBar } from '../features/sessions/TabBar';
import { useTabs } from '../features/sessions/store';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { useSettings } from '../features/settings/store';
import { TerminalWorkspace } from '../features/terminal/TerminalWorkspace';
import { ipc, toAppError } from '../shared/ipc';
import { useDialogs } from './dialogs';
import { StatusBar } from './StatusBar';
import { useShortcuts } from './useShortcuts';
import { useTheme } from './useTheme';

export function App() {
  const settings = useSettings((s) => s.settings);
  const settingsLoaded = useSettings((s) => s.loaded);
  const setUi = useSettings((s) => s.setUi);
  const persistUi = useSettings((s) => s.persistUi);
  const connections = useConnections((s) => s.tree.connections);
  const [version, setVersion] = useState('');
  const [fatal, setFatal] = useState<string | null>(null);

  useTheme(settings.appearance);
  useShortcuts();

  useEffect(() => {
    Promise.all([useSettings.getState().load(), useConnections.getState().load()]).catch((e) =>
      setFatal(toAppError(e).message),
    );
    ipc
      .appInfo()
      .then((info) => setVersion(info.version))
      .catch(reportError);
  }, []);

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
  if (!settingsLoaded) return null;

  const { ui } = settings;
  return (
    <div className="app">
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
      <DialogHost />
      <Toasts />
    </div>
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
    case 'settings':
      return <SettingsDialog onClose={close} />;
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
          onCancel={close}
          onSubmit={(value) => {
            close();
            dialog.onSubmit(value);
          }}
        />
      );
  }
}
