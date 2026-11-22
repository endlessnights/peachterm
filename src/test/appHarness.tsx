import { render } from '@testing-library/react';
import { App } from '../app/App';
import { __resetTitleBarCache } from '../app/useTheme';
import { useDialogs } from '../app/dialogs';
import { useToasts } from '../components/Toasts';
import { useConnections } from '../features/connections/store';
import { useLock } from '../features/lock/store';
import { useTabs } from '../features/sessions/store';
import { useSettings } from '../features/settings/store';
import { __setBackendForTests } from '../shared/ipc';
import { createMockBackend, type MockOptions } from '../shared/mockBackend';
import type { Connection, ConnectionTree, Settings } from '../shared/types';

export const conn = (id: string, name: string, extra: Partial<Connection> = {}): Connection => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'root',
  auth: 'password',
  keyPath: null,
  savePassword: false,
  hasStoredSecret: false,
  timeoutSecs: 15,
  initialDirectory: null,
  folderId: null,
  createdAt: 0,
  sortOrder: 0,
  updatedAt: 0,
  ...extra,
});

/** Fresh stores + a fresh in-memory backend; returns the backend for inspection. */
export function mountApp(
  seed?: Partial<ConnectionTree>,
  options: MockOptions = {},
  /** Wrap the backend, e.g. to record calls. */
  wrap?: (backend: ReturnType<typeof createMockBackend>) => ReturnType<typeof createMockBackend>,
) {
  const backend = createMockBackend(seed, options);
  __setBackendForTests(wrap ? wrap(backend) : backend);
  __resetTitleBarCache();
  useTabs.setState({ tabs: [], activeId: null });
  useConnections.setState({
    tree: { version: 2, folders: [], connections: [] },
    query: '',
    loaded: false,
    selectedId: null,
    renamingId: null,
  });
  useSettings.setState({ loaded: false, startupSnapshot: null, preview: null });
  useDialogs.setState({ dialog: null });
  useLock.setState({ view: null });
  useToasts.setState({ toasts: [] });
  return { backend, ...render(<App />) };
}

export const lastSaved = (backend: { saves?: Settings[] }) => backend.saves?.at(-1);

export const press = (init: KeyboardEventInit, target: Element = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
