import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockOptions, MockSsh } from '../../shared/mockBackend';
import { ipc } from '../../shared/ipc';
import { conn, mountApp } from '../../test/appHarness';
import { useConnections } from '../connections/store';
import { useTabs } from './store';

const names = ['pve1', 'pve2', 'pve3', 'pve4', 'pve5'];
const seed = {
  connections: [
    ...names.map((n, i) => conn(`id-${i + 1}`, n, { host: 'cluster.example.com' })),
    // another saved profile for the SAME hostname: a distinct entry
    conn('id-6', 'pve1-root', { host: 'cluster.example.com', username: 'root' }),
  ],
};

async function mount(options: MockOptions = {}) {
  // the mock edits the objects it is given: every test gets its own copies
  const mounted = mountApp(structuredClone(seed), options);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  const tree = () => within(screen.getByRole('tree'));
  const connectAndClose = async (name: string) => {
    const before = ssh.opens.length;
    fireEvent.doubleClick(tree().getByText(name));
    await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
    await waitFor(() => expect(useTabs.getState().tabs.at(-1)?.status).not.toBe('connecting'));
    act(() => useTabs.getState().closeTabs(useTabs.getState().tabs.map((t) => t.id)));
  };
  const rows = () =>
    screen
      .queryAllByRole('button')
      .filter((b) => b.classList.contains('recent-row'))
      .map((b) => b.querySelector('.recent-name')?.textContent);
  return { ...mounted, ssh, tree, connectAndClose, rows };
}

describe('Recent Sessions on the home screen', () => {
  it('is hidden while there is no history', async () => {
    await mount();
    expect(screen.queryByText('Recent Sessions')).toBeNull();
  });

  it('lists distinct saved connections, newest first, once each (pve1 pve2 pve1 pve1 pve3)', async () => {
    const { connectAndClose, rows } = await mount({
      settings: (s) => ({ ...s, general: { ...s.general, recentSessionsLimit: 10 } }),
    });
    for (const n of ['pve1', 'pve2', 'pve1', 'pve1', 'pve3']) await connectAndClose(n);
    await waitFor(() => expect(rows()).toEqual(['pve3', 'pve1', 'pve2']));
  });

  it('shows 3 entries by default', async () => {
    const { connectAndClose, rows } = await mount();
    for (const n of names) await connectAndClose(n);
    await waitFor(() => expect(rows()).toEqual(['pve5', 'pve4', 'pve3']));
  });

  it('does not merge different saved profiles that share a hostname', async () => {
    const { connectAndClose, rows } = await mount({
      settings: (s) => ({ ...s, general: { ...s.general, recentSessionsLimit: 10 } }),
    });
    await connectAndClose('pve1');
    await connectAndClose('pve1-root');
    await waitFor(() => expect(rows()).toEqual(['pve1-root', 'pve1']));
  });

  it('a failed login never enters the history', async () => {
    const { connectAndClose, rows, ssh } = await mount({ sshFails: ['id-2'] });
    await connectAndClose('pve1');
    await connectAndClose('pve2'); // auth fails
    expect(ssh.opens).toHaveLength(2);
    await waitFor(() => expect(rows()).toEqual(['pve1']));
  });

  it('merely opening a tab does not record anything until the login succeeded', async () => {
    const { ssh, tree } = await mount();
    fireEvent.doubleClick(tree().getByText('pve1'));
    await waitFor(() => expect(ssh.opens).toHaveLength(1));
    // the mock records on success only; before that the Rust-side list is empty
    expect(await ipc.recentList()).toEqual(
      useTabs.getState().tabs[0]!.status === 'connected' ? ['id-1'] : [],
    );
  });

  it('clicking an entry opens a NEW session in a NEW tab', async () => {
    const { connectAndClose, rows, ssh } = await mount();
    await connectAndClose('pve1');
    await waitFor(() => expect(rows()).toEqual(['pve1']));
    const firstSession = ssh.opens[0]!.sessionId;
    fireEvent.click(screen.getByRole('button', { name: /pve1/ }));
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
    expect(ssh.opens[1]!.sessionId).not.toBe(firstSession);
    expect(ssh.opens[1]!.connectionId).toBe('id-1');
    expect(useTabs.getState().tabs).toHaveLength(1);
    // another click while a tab is open (home screen is hidden then): use the sidebar entry
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('pve1'));
    await waitFor(() => expect(ssh.opens).toHaveLength(3));
    expect(useTabs.getState().tabs).toHaveLength(2);
  });

  it('follows renames and forgets deleted connections', async () => {
    const { connectAndClose, rows } = await mount({
      settings: (s) => ({ ...s, general: { ...s.general, recentSessionsLimit: 10 } }),
    });
    await connectAndClose('pve1');
    await connectAndClose('pve2');
    await waitFor(() => expect(rows()).toEqual(['pve2', 'pve1']));
    await act(async () => {
      await useConnections.getState().renameItem({ kind: 'connection', id: 'id-2' }, 'renamed');
    });
    await waitFor(() => expect(rows()).toEqual(['renamed', 'pve1']));
    await act(async () => {
      await useConnections.getState().deleteConnection('id-1');
      await (await import('./recentStore')).useRecent.getState().refresh();
    });
    await waitFor(() => expect(rows()).toEqual(['renamed']));
  });

  it.each([3, 5, 10, 15, 20])('respects a limit of %i', async (limit) => {
    const many = Array.from({ length: 22 }, (_, i) => conn(`m-${i}`, `host${i}`));
    const mounted = mountApp(
      { connections: many },
      { settings: (s) => ({ ...s, general: { ...s.general, recentSessionsLimit: limit } }) },
    );
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    for (let i = 0; i < 22; i += 1) {
      fireEvent.doubleClick(within(screen.getByRole('tree')).getByText(`host${i}`));
      await waitFor(() => expect(ssh.opens).toHaveLength(i + 1));
    }
    act(() => useTabs.getState().closeTabs(useTabs.getState().tabs.map((t) => t.id)));
    await waitFor(() => expect(document.querySelectorAll('.recent-row')).toHaveLength(limit));
    expect(document.querySelector('.recent-name')?.textContent).toBe('host21');
  });

  it('rows are real buttons with an accessible name and keyboard focus', async () => {
    const { connectAndClose } = await mount();
    await connectAndClose('pve1');
    const row = await screen.findByRole('button', { name: /pve1/ });
    row.focus();
    expect(document.activeElement).toBe(row);
    expect(row.title).toContain('cluster.example.com');
  });
});

describe('recent sessions settings', () => {
  const openGeneral = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    return screen.findByRole('dialog', { name: 'Settings' });
  };

  it('offers 3, 5, 10, 15 and 20 and applies a change immediately', async () => {
    const { connectAndClose, rows } = await mount();
    for (const n of names) await connectAndClose(n);
    await waitFor(() => expect(rows()).toHaveLength(3));
    const dialog = await openGeneral();
    const select = within(dialog).getByLabelText('Recent sessions limit') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['3', '5', '10', '15', '20']);
    expect(select.value).toBe('3');
    fireEvent.change(select, { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(rows()).toHaveLength(5));
  });

  it('clearing the history keeps saved connections and open sessions', async () => {
    const { connectAndClose, rows, ssh } = await mount();
    await connectAndClose('pve1');
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('pve2'));
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
    await waitFor(() => expect(useTabs.getState().tabs[0]!.status).toBe('connected'));
    const dialog = await openGeneral();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Recent Sessions History' }));
    // asks first
    expect(within(dialog).getByText('Forget the recent sessions list?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    expect(await ipc.recentList()).toEqual(['id-2', 'id-1']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Recent Sessions History' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear history' }));
    await waitFor(async () => expect(await ipc.recentList()).toEqual([]));
    // saved connections and the open session are untouched
    expect(useConnections.getState().tree.connections).toHaveLength(6);
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().tabs[0]!.status).toBe('connected');
    expect(ssh.closes).toEqual([ssh.opens[0]!.sessionId]); // only the tab closed earlier
    expect(rows()).toEqual([]);
  });
});
