// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setBackendForTests } from '../shared/ipc';
import { createMockBackend } from '../shared/mockBackend';
import type { Connection } from '../shared/types';
import { useConnections } from '../features/connections/store';
import { useTabs } from '../features/sessions/store';
import { useSettings } from '../features/settings/store';
import { useDialogs } from './dialogs';
import { App } from './App';

const connection = (id: string, name: string, host: string): Connection => ({
  id,
  name,
  host,
  port: 22,
  username: 'root',
  auth: 'password',
  keyPath: null,
  savePassword: false,
  hasStoredSecret: false,
  timeoutSecs: 15,
  initialDirectory: null,
  folderId: null,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  __setBackendForTests(
    createMockBackend({
      connections: [
        connection('a', 'alpha', 'alpha.example.com'),
        connection('b', 'beta', '10.1.1.1'),
      ],
    }),
  );
  useTabs.setState({ tabs: [], activeId: null });
  useConnections.setState({ query: '', loaded: false, selectedId: null });
  useSettings.setState({ loaded: false });
  useDialogs.setState({ dialog: null });
});

afterEach(() => __setBackendForTests(null));

describe('App shell', () => {
  it('lists saved connections and filters them by host', async () => {
    render(<App />);
    const tree = await screen.findByRole('tree');
    await waitFor(() => expect(within(tree).getByText('alpha')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: '10.1' } });
    expect(within(tree).queryByText('alpha')).toBeNull();
    expect(within(tree).getByText('beta')).toBeTruthy();
  });

  it('opens a tab on double-click, twice for two sessions', async () => {
    render(<App />);
    const row = await screen.findByText('alpha');
    fireEvent.doubleClick(row);
    fireEvent.doubleClick(row);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('toggles the sidebar and persists the choice', async () => {
    render(<App />);
    await screen.findByRole('tree');
    fireEvent.click(screen.getByLabelText('Toggle sidebar'));
    expect(screen.queryByRole('tree')).toBeNull();
    await waitFor(() => expect(useSettings.getState().settings.ui.sidebarVisible).toBe(false));
  });

  it('creates a connection through the editor dialog', async () => {
    render(<App />);
    await screen.findByRole('tree');
    fireEvent.click(screen.getByLabelText('New connection'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('server.example.com'), {
      target: { value: 'gamma.example.com' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByText('Create'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useConnections.getState().tree.connections.map((c) => c.name)).toContain(
      'gamma.example.com',
    );
  });
});
