// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runAction } from '../../app/commands';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { useTabs } from './store';

const seed = {
  connections: [
    conn('a', 'alpha', { host: 'same.example.com' }),
    conn('b', 'beta', { host: 'other.example.com' }),
    // a different saved profile that points to the SAME hostname
    conn('c', 'gamma', { host: 'same.example.com', username: 'deploy' }),
  ],
};

async function mount() {
  const mounted = mountApp(seed);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  const tree = () => within(screen.getByRole('tree'));
  const open = async (name: string) => {
    const before = ssh.opens.length;
    fireEvent.doubleClick(tree().getByText(name));
    await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
  };
  return { ...mounted, ssh, tree, open };
}

const tabTitles = () =>
  screen.getAllByRole('tab').map((t) => t.querySelector('.tab-title')?.textContent);
const tabNamed = (n: number) => screen.getAllByRole('tab')[n]!;

describe('independent sessions to the same saved connection', () => {
  it('every double-click opens a new tab and a new backend session', async () => {
    const { ssh, open } = await mount();
    await open('alpha');
    await open('alpha');
    await open('alpha');
    expect(tabTitles()).toEqual(['alpha', 'alpha', 'alpha']);
    const tabs = useTabs.getState().tabs;
    expect(new Set(tabs.map((t) => t.id)).size).toBe(3);
    expect(new Set(ssh.opens.map((o) => o.sessionId)).size).toBe(3);
    // the saved connection id is shared; session ids are separate
    expect(new Set(ssh.opens.map((o) => o.connectionId))).toEqual(new Set(['a']));
    expect(tabs.every((t) => t.connectionId === 'a')).toBe(true);
    await waitFor(() => expect(tabs.length).toBe(3));
    await waitFor(() =>
      expect(useTabs.getState().tabs.map((t) => t.sessionId)).toEqual(
        ssh.opens.map((o) => o.sessionId),
      ),
    );
    // each has its own terminal instance
    expect(fakeTerminals).toHaveLength(3);
  });

  it('closing one session leaves the others to the same host connected', async () => {
    const { ssh, open } = await mount();
    await open('alpha');
    await open('alpha');
    await waitFor(() => expect(useTabs.getState().tabs[1]?.status).toBe('connected'));
    const [first, second] = ssh.opens;
    act(() => useTabs.getState().closeTab(useTabs.getState().tabs[0]!.id));
    await waitFor(() => expect(ssh.closes).toEqual([first!.sessionId]));
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().tabs[0]!.sessionId).toBe(second!.sessionId);
    expect(useTabs.getState().tabs[0]!.status).toBe('connected');
    expect(ssh.writes).toEqual([]); // nothing is typed into a shell to close it
  });

  it('a session ending on its own affects only its tab', async () => {
    const { ssh, open } = await mount();
    await open('alpha');
    await open('alpha');
    await waitFor(() => expect(useTabs.getState().tabs[1]?.status).toBe('connected'));
    act(() => ssh.emit(ssh.opens[0]!.sessionId, { kind: 'closed', reason: 'connect_failed' }));
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('failed'));
    expect(useTabs.getState().tabs[1]?.status).toBe('connected');
  });
});

describe('rename tab', () => {
  it('renames only that tab, can be reset, and never touches the saved connection', async () => {
    const { open, tree, ssh } = await mount();
    await open('alpha');
    await open('alpha');
    fireEvent.contextMenu(tabNamed(0));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename Tab/ }));
    const input = await screen.findByLabelText('Tab name');
    fireEvent.change(input, { target: { value: '  prod web  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(tabTitles()).toEqual(['prod web', 'alpha']));
    expect(tree().getByText('alpha')).toBeTruthy(); // saved connection unchanged
    expect(useTabs.getState().tabs[1]!.title).toBe('alpha');
    expect(ssh.opens).toHaveLength(2); // no reconnect

    // reset to the saved connection's name
    fireEvent.contextMenu(tabNamed(0));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename Tab/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Reset to/ }));
    await waitFor(() => expect(tabTitles()).toEqual(['alpha', 'alpha']));
    expect(useTabs.getState().tabs[0]!.customTitle).toBeNull();
  });

  it('a custom title survives a rename of the saved connection; the default follows it', async () => {
    const { open } = await mount();
    await open('alpha');
    await open('alpha');
    act(() => useTabs.getState().renameTab(useTabs.getState().tabs[0]!.id, 'mine'));
    act(() =>
      useTabs
        .getState()
        .syncConnections([conn('a', 'alpha-renamed', { host: 'same.example.com' })]),
    );
    expect(useTabs.getState().tabs.map((t) => t.title)).toEqual(['mine', 'alpha-renamed']);
  });

  it('blank, control characters and very long titles are normalised', () => {
    useTabs.setState({ tabs: [], activeId: null, layout: null, focusLeaf: null });
    const id = useTabs.getState().openTab(conn('a', 'alpha'));
    useTabs.getState().renameTab(id, '   ');
    expect(useTabs.getState().tabs[0]!.title).toBe('alpha');
    useTabs.getState().renameTab(id, 'a\u0007b\nc');
    expect(useTabs.getState().tabs[0]!.title).toBe('a b c');
    useTabs.getState().renameTab(id, 'x'.repeat(500));
    expect(useTabs.getState().tabs[0]!.title).toHaveLength(128);
  });
});

describe('duplicate tab', () => {
  it('starts a NEW session next to the tab, with the same saved connection', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('beta');
    act(() => useTabs.getState().renameTab(useTabs.getState().tabs[0]!.id, 'mine'));
    fireEvent.contextMenu(tabNamed(0));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate Tab' }));
    await waitFor(() => expect(ssh.opens).toHaveLength(3));
    expect(tabTitles()).toEqual(['mine', 'mine', 'beta']); // right after the source
    const opened = ssh.opens[2]!;
    expect(opened.connectionId).toBe('a');
    expect(new Set(ssh.opens.map((o) => o.sessionId)).size).toBe(3);
    // only ids go over IPC: no secret, no terminal contents
    expect(Object.keys(opened).sort()).toEqual([
      'attempt',
      'cols',
      'connectionId',
      'rows',
      'sessionId',
    ]);
    expect(fakeTerminals).toHaveLength(3);
  });

  it('is reachable from the keyboard shortcut action', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('duplicateTab'));
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
  });
});

describe('closing tabs', () => {
  async function fiveTabs() {
    const m = await mount();
    for (const name of ['alpha', 'beta', 'alpha', 'gamma', 'alpha']) await m.open(name);
    await waitFor(() =>
      expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true),
    );
    return m;
  }
  const closeVia = async (index: number, item: RegExp | string) => {
    fireEvent.contextMenu(tabNamed(index));
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  };

  it('Close Other Tabs asks once, with the number of sessions, then closes only the others', async () => {
    const { ssh } = await fiveTabs();
    await closeVia(1, 'Close Other Tabs');
    expect(await screen.findByText('Close 4 tabs?')).toBeTruthy();
    expect(screen.getByText(/4 active SSH sessions will be disconnected/)).toBeTruthy();
    expect(ssh.closes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close 4 tabs' }));
    await waitFor(() => expect(tabTitles()).toEqual(['beta']));
    await waitFor(() => expect(ssh.closes).toHaveLength(4));
    expect(ssh.writes).toEqual([]);
  });

  it('Close Tabs to the Right closes only what is to the right', async () => {
    const { ssh } = await fiveTabs();
    await closeVia(2, 'Close Tabs to the Right');
    fireEvent.click(await screen.findByRole('button', { name: 'Close 2 tabs' }));
    await waitFor(() => expect(tabTitles()).toEqual(['alpha', 'beta', 'alpha']));
    expect(ssh.closes).toHaveLength(2);
  });

  it('host scoped closing uses the saved connection id, not the host name or title', async () => {
    const { ssh } = await fiveTabs();
    // rename a tab of connection "a" to look like another host; ids decide
    act(() => useTabs.getState().renameTab(useTabs.getState().tabs[2]!.id, 'beta'));
    // gamma has the same hostname as alpha but is a different saved profile
    await closeVia(0, 'Close Other Tabs for This Host');
    expect(await screen.findByText('Close 2 tabs?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close 2 tabs' }));
    await waitFor(() => expect(tabTitles()).toEqual(['alpha', 'beta', 'gamma']));
    expect(useTabs.getState().tabs.map((t) => t.connectionId)).toEqual(['a', 'b', 'c']);
    expect(ssh.closes).toHaveLength(2);

    // all tabs of connection a, including the selected one; b and c are untouched
    await closeVia(0, 'Close All Tabs for This Host');
    fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(tabTitles()).toEqual(['beta', 'gamma']));
    expect(ssh.closes).toHaveLength(3);
    expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true);
  });

  it('host actions are disabled when there is nothing else for the host', async () => {
    const { open } = await mount();
    await open('alpha');
    await open('beta');
    fireEvent.contextMenu(tabNamed(0));
    const item = await screen.findByRole('menuitem', { name: 'Close Other Tabs for This Host' });
    expect(item).toHaveProperty('disabled', true);
    expect(screen.getByRole('menuitem', { name: 'Close Tabs to the Right' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('a lone idle or ended tab closes without any question', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => ssh.emit(ssh.opens[0]!.sessionId, { kind: 'closed', reason: null }));
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('disconnected'));
    await closeViaSingle();
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(0));
  });
});

async function closeViaSingle() {
  fireEvent.contextMenu(tabNamed(0));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Tab' }));
}
