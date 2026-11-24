// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { useEditor } from '../editor/store';
import { useProfiles } from '../terminal/profilesStore';
import { useTabs } from '../sessions/store';
import { useActivity } from './activity';
import { requestExit, useExit } from './exit';

async function mount() {
  useProfiles.setState({ profiles: [], defaultId: null, loaded: false, loading: false });
  useActivity.setState({ transfers: {}, unsaved: {} });
  useEditor.setState({ edits: {}, questions: [] });
  useExit.setState({ summary: null });
  const mounted = mountApp({ connections: [conn('a', 'alpha'), conn('b', 'beta')] });
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  return { ...mounted, ssh };
}

const dialog = () => screen.findByRole('dialog', { name: 'Exit PeachTerm?' });
const items = (d: HTMLElement) =>
  within(d)
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('exiting the application', () => {
  it('closes at once when nothing would be lost', async () => {
    const { ssh } = await mount();
    await act(async () => requestExit());
    expect(screen.queryByRole('dialog', { name: 'Exit PeachTerm?' })).toBeNull();
    await waitFor(() => expect(ssh.quits).toBe(1));
  });

  it('asks once and says how many SSH sessions and local terminals are active', async () => {
    const { ssh } = await mount();
    const tree = within(screen.getByRole('tree'));
    fireEvent.doubleClick(tree.getByText('alpha'));
    fireEvent.doubleClick(tree.getByText('beta'));
    fireEvent.click(await screen.findByRole('button', { name: 'New local terminal' }));
    await waitFor(() => expect(ssh.local.opens).toHaveLength(1));
    await waitFor(() =>
      expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true),
    );
    await act(async () => requestExit());
    const d = await dialog();
    expect(items(d)).toEqual([
      '2 active SSH sessions will be disconnected.',
      '1 local terminal will be closed and the programs running in it stopped.',
    ]);
    expect(ssh.quits).toBe(0); // nothing happens until the user confirms
  });

  it('Cancel is the default: it has focus, Escape keeps the application open', async () => {
    const { ssh } = await mount();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
    await act(async () => requestExit());
    const d = await dialog();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(d).getByRole('button', { name: 'Cancel' })),
    );
    fireEvent.keyDown(d, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Exit PeachTerm?' })).toBeNull(),
    );
    expect(ssh.quits).toBe(0);
    expect(useTabs.getState().tabs).toHaveLength(1); // the session is untouched
  });

  it('Exit asks the backend to quit, and no exit command is typed into any shell', async () => {
    const { ssh } = await mount();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
    await act(async () => requestExit());
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Exit PeachTerm' }));
    await waitFor(() => expect(ssh.quits).toBe(1));
    expect(ssh.writes).toEqual([]);
    expect(ssh.local.writes).toEqual([]);
  });

  it('counts connections that are still being established', async () => {
    await mount();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    const id = useTabs.getState().tabs[0]!.id;
    act(() => useTabs.getState().setStatus(id, 'connecting'));
    await act(async () => requestExit());
    expect(items(await dialog())).toEqual([
      '1 connection still being established will be cancelled.',
    ]);
  });

  it('counts running transfers and files waiting to be uploaded', async () => {
    await mount();
    act(() => {
      useActivity.getState().setTransfers('t1', 2);
      useActivity.getState().setTransfers('t2', 1);
      useEditor.setState({
        edits: {},
        questions: [
          {
            kind: 'confirm',
            editId: 'e1',
            sessionId: 's1',
            name: 'a.txt',
            remotePath: '/a.txt',
            size: 3,
          },
        ],
      });
    });
    await act(async () => requestExit());
    expect(items(await dialog())).toEqual([
      '3 file transfers in progress will be interrupted.',
      '1 edited file not yet uploaded. The local copy is kept; the remote file is not changed.',
    ]);
  });

  it('warns about unsaved edits in the settings and connection dialogs', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    // untouched dialogs are not "unsaved"
    await act(async () => requestExit());
    expect(screen.queryByRole('dialog', { name: 'Exit PeachTerm?' })).toBeNull();
    useExit.setState({ summary: null });
    fireEvent.click(within(settings).getByRole('button', { name: 'SSH' }));
    fireEvent.change(within(settings).getByDisplayValue('15'), { target: { value: '20' } });
    await act(async () => requestExit());
    const d = await dialog();
    expect(items(d)).toEqual(['The settings dialog has unsaved changes.']);
    // the dialog with the unsaved edits is still open underneath
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('a connection form with typed text counts as unsaved', async () => {
    await mount();
    act(() => useActivity.getState().setUnsaved('connection', true));
    await act(async () => requestExit());
    expect(items(await dialog())).toEqual(['The connection dialog has unsaved changes.']);
  });
});
