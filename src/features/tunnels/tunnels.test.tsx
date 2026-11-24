// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { useEditor } from '../editor/store';
import { useActivity } from '../exit/activity';
import { requestExit, useExit } from '../exit/exit';
import { useTabs } from '../sessions/store';
import { useProfiles } from '../terminal/profilesStore';

async function mount() {
  useProfiles.setState({ profiles: [], defaultId: null, loaded: false, loading: false });
  useActivity.setState({ transfers: {}, unsaved: {} });
  useEditor.setState({ edits: {}, questions: [] });
  useExit.setState({ summary: null });
  const mounted = mountApp({ connections: [conn('a', 'alpha'), conn('b', 'beta')] });
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  const open = async (name: string) => {
    const before = ssh.opens.length;
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText(name));
    await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
    await waitFor(() =>
      expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true),
    );
  };
  return { ...mounted, ssh, open };
}

const tabNamed = (n: number) => screen.getAllByRole('tab')[n]!;

async function openTunnels(index = 0) {
  fireEvent.contextMenu(tabNamed(index));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'SSH Tunnels…' }));
  return screen.findByRole('dialog', { name: /SSH Tunnels/ });
}

async function addTunnel(
  dialog: HTMLElement,
  v: { name: string; local: string; host?: string; remote: string; auto?: boolean },
) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add Tunnel' }));
  const form = await within(dialog).findByRole('form', { name: 'SSH Port Forwarding' });
  const f = within(form);
  fireEvent.change(f.getByLabelText('Name'), { target: { value: v.name } });
  fireEvent.change(f.getByLabelText('Local port'), { target: { value: v.local } });
  if (v.host)
    fireEvent.change(f.getByLabelText('Remote destination'), { target: { value: v.host } });
  fireEvent.change(f.getByLabelText('Remote port'), { target: { value: v.remote } });
  if (v.auto) fireEvent.click(f.getByRole('checkbox'));
  fireEvent.click(f.getByRole('button', { name: 'Save' }));
}

const rows = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('list', { name: 'Tunnels' })).queryAllByRole('listitem');

describe('SSH tunnels dialog', () => {
  it('is reached from the SSH tab menu and starts empty', async () => {
    const { open } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    expect(
      await within(dialog).findByText('No tunnels saved for this connection yet.'),
    ).toBeTruthy();
    expect(dialog.textContent).toContain('listen on this computer only');
  });

  it('the form defaults to loopback and no auto-start, and explains the remote address', async () => {
    const { open } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Tunnel' }));
    const form = await within(dialog).findByRole('form', { name: 'SSH Port Forwarding' });
    expect((within(form).getByLabelText('Local bind address') as HTMLSelectElement).value).toBe(
      '127.0.0.1',
    );
    expect((within(form).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((within(form).getByLabelText('Remote destination') as HTMLInputElement).value).toBe(
      '127.0.0.1',
    );
    // only loopback addresses can be chosen: nothing public, nothing on all interfaces
    const options = [
      ...(within(form).getByLabelText('Local bind address') as HTMLSelectElement).options,
    ];
    expect(options.map((o) => o.value)).toEqual(['127.0.0.1', '::1']);
    expect(form.textContent).toContain("127.0.0.1 means the server's own loopback interface");
  });

  it('saves a tunnel, shows route and state, and keeps nothing running by itself', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    const row = rows(dialog)[0]!;
    expect(row.textContent).toContain('Grafana');
    expect(row.textContent).toContain('127.0.0.1:8080 → 127.0.0.1:3000');
    expect(within(row).getByRole('status').textContent).toBe('Stopped');
    expect(ssh.tunnels.starts).toEqual([]);
    expect(ssh.tunnels.defs[0]!.autoStart).toBe(false);
  });

  it('validates ports before asking the backend and explains a port conflict', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Bad', local: '70000', remote: '3000' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'local port must be a number between 1 and 65535',
    );
    expect(ssh.tunnels.defs).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await addTunnel(dialog, { name: 'One', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    await addTunnel(dialog, { name: 'Two', local: '8080', remote: '4000' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'local port 8080 is already used by the tunnel "One"',
    );
    expect(ssh.tunnels.defs).toHaveLength(1);
  });

  it('starts on THIS tab, reports Listening (not "connected"), and stops again', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(within(rows(dialog)[0]!).getByRole('status').textContent).toBe('Listening'),
    );
    expect(dialog.textContent).not.toMatch(/\bConnected\b/);
    expect(ssh.tunnels.starts).toEqual([
      { sessionId: useTabs.getState().tabs[0]!.sessionId, tunnelId: ssh.tunnels.defs[0]!.id },
    ]);
    // a running tunnel cannot be edited
    expect(
      (within(dialog).getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(within(rows(dialog)[0]!).getByRole('status').textContent).toBe('Stopped'),
    );
    expect(ssh.tunnels.stops).toHaveLength(1);
  });

  it('a start that fails (for example a busy port) says why and the tunnel stays stopped', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    ssh.tunnels.failStart =
      'The local port 8080 is already in use by another program. Choose a different port.';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('already in use');
    expect(within(rows(dialog)[0]!).getByRole('status').textContent).toBe('Stopped');
    expect(Object.keys(ssh.tunnels.running)).toEqual([]);
  });

  it('shows the latest forwarding failure without calling the tunnel broken', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(Object.keys(ssh.tunnels.running)).toHaveLength(1));
    ssh.tunnels.lastError[ssh.tunnels.defs[0]!.id] =
      'The SSH server does not allow port forwarding (AllowTcpForwarding).';
    await waitFor(() => expect(rows(dialog)[0]!.textContent).toContain('AllowTcpForwarding'), {
      timeout: 4000,
    });
    expect(within(rows(dialog)[0]!).getByRole('status').textContent).toBe('Listening');
  });

  it('offers Open in Browser only for a running tunnel to a web-like port', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    await addTunnel(dialog, { name: 'Postgres', local: '15432', remote: '5432' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(2));
    expect(within(dialog).queryByRole('button', { name: 'Open in Browser' })).toBeNull();
    for (const start of within(dialog).getAllByRole('button', { name: 'Start' }))
      fireEvent.click(start);
    await waitFor(() => expect(Object.keys(ssh.tunnels.running)).toHaveLength(2));
    await waitFor(() =>
      expect(within(dialog).getAllByRole('button', { name: 'Open in Browser' })).toHaveLength(1),
    );
    expect(within(rows(dialog)[0]!).getByRole('button', { name: 'Open in Browser' })).toBeTruthy();
    expect(ssh.tunnels.browser).toEqual([]); // never opened by itself
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open in Browser' }));
    await waitFor(() => expect(ssh.tunnels.browser).toHaveLength(1));
  });

  it('Start is unavailable until the tab is connected', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    act(() => ssh.emit(ssh.opens[0]!.sessionId, { kind: 'closed', reason: 'connect_failed' }));
    await waitFor(() => expect(useTabs.getState().tabs[0]!.status).not.toBe('connected'));
    expect(
      (within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(dialog.textContent).toContain('Connect this tab to start a tunnel.');
  });

  it('deleting needs a second click, and edits keep the saved id', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const dialog = await openTunnels();
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    const id = ssh.tunnels.defs[0]!.id;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    const form = await within(dialog).findByRole('form', { name: 'SSH Port Forwarding' });
    fireEvent.change(within(form).getByLabelText('Remote port'), { target: { value: '3001' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rows(dialog)[0]!.textContent).toContain('3001'));
    expect(ssh.tunnels.defs.map((d) => d.id)).toEqual([id]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(ssh.tunnels.defs).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Delete' }));
    await waitFor(() => expect(ssh.tunnels.defs).toHaveLength(0));
  });

  it('tunnels belong to the saved connection: another connection does not see them', async () => {
    const { open } = await mount();
    await open('alpha');
    await open('beta');
    let dialog = await openTunnels(0);
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /SSH Tunnels/ })).toBeNull());
    dialog = await openTunnels(1);
    expect(await within(dialog).findByText(/No tunnels saved/)).toBeTruthy();
  });

  it('a tunnel running in another tab is labelled and cannot be started twice', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('alpha');
    const dialog = await openTunnels(0);
    await addTunnel(dialog, { name: 'Grafana', local: '8080', remote: '3000' });
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));
    ssh.tunnels.running[ssh.tunnels.defs[0]!.id] = useTabs.getState().tabs[1]!.sessionId!;
    await waitFor(() => expect(rows(dialog)[0]!.textContent).toContain('(in another tab)'), {
      timeout: 4000,
    });
    expect(within(dialog).queryByRole('button', { name: 'Open in Browser' })).toBeNull();
  });
});

describe('tunnels and the rest of the application', () => {
  it('moving tabs in Split View never stops or restarts a tunnel or reconnects SSH', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('beta');
    const [a, b] = useTabs.getState().tabs;
    ssh.tunnels.running = { t1: a!.sessionId! };
    const opens = ssh.opens.length;
    expect(useTabs.getState().dropTab(a!.id, 'single', 'right')).toBe('ok');
    useTabs.getState().activate(b!.id);
    useTabs.getState().activate(a!.id);
    expect(ssh.tunnels.stops).toEqual([]);
    expect(ssh.tunnels.starts).toEqual([]);
    expect(ssh.tunnels.running).toEqual({ t1: a!.sessionId });
    expect(ssh.opens).toHaveLength(opens);
    expect(ssh.closes).toEqual([]);
  });

  it('closing a tab closes only that SSH session (its tunnels end with it in the backend)', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('beta');
    const first = useTabs.getState().tabs[0]!;
    useTabs.getState().closeTab(first.id);
    await waitFor(() => expect(ssh.closes).toEqual([first.sessionId]));
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('the exit warning counts running tunnels', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    ssh.tunnels.running = { t1: 's1', t2: 's1' };
    await act(async () => requestExit());
    const dialog = await screen.findByRole('dialog', { name: 'Exit PeachTerm?' });
    expect(dialog.textContent).toContain('2 SSH tunnels will be stopped.');
    expect(ssh.quits).toBe(0);
  });

  it('tunnels alone are enough to warn before exiting', async () => {
    const { ssh } = await mount();
    ssh.tunnels.running = { t1: 's1' };
    await act(async () => requestExit());
    expect(await screen.findByRole('dialog', { name: 'Exit PeachTerm?' })).toBeTruthy();
  });
});

describe('Application Lock', () => {
  it('closes the tunnel dialog and refuses tunnel commands while locked', async () => {
    const mounted = mountApp(
      { connections: [conn('a', 'alpha')] },
      { lockPassword: 'correct horse', lockEnabled: true },
    );
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(ssh.opens).toHaveLength(1));
    await waitFor(() => expect(useTabs.getState().tabs[0]!.status).toBe('connected'));
    const dialog = await openTunnels();
    expect(dialog).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Lock PeachTerm' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /SSH Tunnels/ })).toBeNull());
    const { ipc } = await import('../../shared/ipc');
    await expect(ipc.tunnelList('a')).rejects.toMatchObject({ code: 'locked' });
    await expect(ipc.tunnelStart('s', 't')).rejects.toMatchObject({ code: 'locked' });
    await expect(
      ipc.tunnelSave('a', {
        name: 'x',
        bindAddress: '127.0.0.1',
        localPort: 1,
        remoteHost: 'h',
        remotePort: 2,
        autoStart: false,
      }),
    ).rejects.toMatchObject({ code: 'locked' });
    // only the bare count stays available (so quitting still warns)
    await expect(ipc.tunnelCounts()).resolves.toEqual({ running: 0 });
  });
});
