// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tabsForSameConnection } from '../../app/actions';
import type { MockSsh } from '../../shared/mockBackend';
import type { LocalProfile, Settings } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { useTabs } from '../sessions/store';
import { useProfiles } from './profilesStore';

const PS: LocalProfile = {
  id: 'powershell',
  name: 'Windows PowerShell',
  kind: 'local',
  detail: 'powershell.exe',
};
const PWSH: LocalProfile = { id: 'pwsh', name: 'PowerShell 7', kind: 'local', detail: 'pwsh.exe' };
const UBUNTU: LocalProfile = {
  id: 'wsl:Ubuntu',
  name: 'Ubuntu (WSL)',
  kind: 'wsl',
  detail: 'Ubuntu',
};

async function mount(profiles = [PS, PWSH, UBUNTU], options: Record<string, unknown> = {}) {
  useProfiles.setState({ profiles: [], defaultId: null, loaded: false, loading: false });
  const mounted = mountApp(
    { connections: [conn('a', 'alpha')] },
    { localProfiles: profiles, ...options },
  );
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  await waitFor(() => expect(useProfiles.getState().loaded).toBe(true));
  return { ...mounted, ssh };
}

const plus = () => screen.getByRole('button', { name: 'New local terminal' });

describe('the + button', () => {
  it('is visible with no tabs and starts the default shell on click', async () => {
    const { ssh } = await mount();
    expect(useTabs.getState().tabs).toHaveLength(0);
    fireEvent.click(plus());
    await waitFor(() => expect(ssh.local.opens).toHaveLength(1));
    expect(ssh.local.opens[0]!.profileId).toBe('powershell');
    const tab = useTabs.getState().tabs[0]!;
    expect(tab.kind).toBe('local');
    expect(tab.title).toBe('Windows PowerShell');
    expect(ssh.opens).toHaveLength(0); // no SSH involved
  });

  it('sits right after the last tab, inside the tab strip', async () => {
    await mount();
    fireEvent.click(plus());
    fireEvent.click(plus());
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));
    const list = screen.getByRole('tablist');
    expect(list.nextElementSibling).toBe(plus());
    expect(within(list).getAllByRole('tab')).toHaveLength(2);
  });

  it('right click lists the profiles; choosing one starts exactly that shell', async () => {
    const { ssh } = await mount();
    fireEvent.contextMenu(plus());
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Windows PowerShell (default)', 'PowerShell 7', 'Ubuntu (WSL)', 'Refresh Profiles']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Ubuntu (WSL)' }));
    await waitFor(() => expect(ssh.local.opens).toHaveLength(1));
    expect(ssh.local.opens[0]!.profileId).toBe('wsl:Ubuntu');
    expect(useTabs.getState().tabs[0]!.kind).toBe('wsl');
  });

  it('uses the configured default shell', async () => {
    const { ssh } = await mount([PS, PWSH], {
      settings: (s: Settings) => ({
        ...s,
        terminal: { ...s.terminal, defaultProfile: 'pwsh' },
      }),
    });
    fireEvent.click(plus());
    await waitFor(() => expect(ssh.local.opens).toHaveLength(1));
    expect(ssh.local.opens[0]!.profileId).toBe('pwsh');
  });

  it('says so when there is no shell at all instead of failing silently', async () => {
    const { ssh } = await mount([]);
    fireEvent.click(plus());
    expect(await screen.findByText(/No local shell was found/)).toBeTruthy();
    expect(ssh.local.opens).toHaveLength(0);
  });
});

describe('a local terminal tab', () => {
  async function openLocal() {
    const m = await mount();
    fireEvent.click(plus());
    await waitFor(() => expect(m.ssh.local.opens).toHaveLength(1));
    await waitFor(() => expect(useTabs.getState().tabs[0]!.sessionId).not.toBeNull());
    return m;
  }

  it('has no SFTP panel and no SFTP toggle, while SSH tabs keep theirs', async () => {
    const { ssh } = await openLocal();
    expect(screen.queryByLabelText('SFTP')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show SFTP panel' })).toBeNull();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(ssh.opens).toHaveLength(1));
    expect(await screen.findByLabelText('SFTP')).toBeTruthy();
    // back to the local tab: the panel goes away again
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    await waitFor(() => expect(screen.queryByLabelText('SFTP')).toBeNull());
  });

  it('input, resize and acknowledgements go to the local commands, never to SSH', async () => {
    const { ssh } = await openLocal();
    const id = useTabs.getState().tabs[0]!.sessionId!;
    const term = fakeTerminals.at(-1)!;
    act(() => term.type('dir\r'));
    await waitFor(() => expect(ssh.local.writes).toEqual([{ sessionId: id, text: 'dir\r' }]));
    act(() => term.resize(100, 30));
    await waitFor(() =>
      expect(ssh.local.resizes.at(-1)).toEqual({ sessionId: id, cols: 100, rows: 30 }),
    );
    expect(ssh.writes).toHaveLength(0);
    expect(ssh.resizes).toHaveLength(0);
    await waitFor(() => expect(ssh.local.acks.length).toBeGreaterThan(0));
    expect(ssh.acks).toHaveLength(0);
  });

  it('closing the tab closes the local session (and only that one)', async () => {
    const { ssh } = await openLocal();
    const id = useTabs.getState().tabs[0]!.sessionId!;
    fireEvent.click(screen.getByRole('button', { name: /^Close Windows PowerShell$/ }));
    // an active local shell asks first
    fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(ssh.local.closes).toEqual([id]));
    expect(ssh.closes).toHaveLength(0);
  });

  it('when the shell ends the tab offers a restart that starts a NEW process', async () => {
    const { ssh } = await openLocal();
    const first = useTabs.getState().tabs[0]!.sessionId!;
    act(() => ssh.emit(first, { kind: 'status', state: 'disconnected' }));
    act(() => ssh.emit(first, { kind: 'closed', reason: null }));
    fireEvent.click(await screen.findByRole('button', { name: /Restart shell/ }));
    await waitFor(() => expect(ssh.local.opens).toHaveLength(2));
    expect(ssh.local.opens[1]!.sessionId).not.toBe(first);
    expect(ssh.local.opens[1]!.profileId).toBe('powershell');
  });

  it('a shell that cannot start is reported on the tab, not as a crash', async () => {
    const m = await mount([PS], { localFails: ['powershell'] });
    fireEvent.click(plus());
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('failed'));
    expect((await screen.findAllByText(/could not be started/)).length).toBeGreaterThan(0);
    expect(m.ssh.local.opens).toHaveLength(0);
  });

  it('duplicating a local tab starts another shell of the same profile', async () => {
    const { ssh } = await openLocal();
    act(() => {
      useTabs.getState().duplicateTab(useTabs.getState().tabs[0]!.id);
    });
    await waitFor(() => expect(ssh.local.opens).toHaveLength(2));
    expect(ssh.local.opens.map((o) => o.profileId)).toEqual(['powershell', 'powershell']);
  });

  it('"for this host" actions on a local tab only ever touch that tab', async () => {
    const { ssh } = await mount();
    fireEvent.click(plus());
    fireEvent.click(plus());
    await waitFor(() => expect(ssh.local.opens).toHaveLength(2));
    expect(tabsForSameConnection(useTabs.getState().tabs[0]!.id)).toHaveLength(1);
  });
});

describe('restoring local tabs', () => {
  it('never starts a restored shell by itself; Start shell does', async () => {
    const m = await mount([PS], {
      restoreLayout: {
        tabs: [{ kind: 'local', connectionId: null, profileId: 'powershell', title: null }],
        active: 0,
        tree: null,
        focus: null,
      },
      settings: (s: Settings) => ({
        ...s,
        general: { ...s.general, autoReconnectRestored: true },
      }),
    });
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(await screen.findByText(/shell not started yet/)).toBeTruthy();
    expect(m.ssh.local.opens).toHaveLength(0); // even with auto-reconnect on
    fireEvent.click(screen.getByRole('button', { name: /Start shell/ }));
    await waitFor(() => expect(m.ssh.local.opens).toHaveLength(1));
  });
});

describe('Settings → Terminal → Local Shell', () => {
  async function openPage() {
    const m = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terminal' }));
    return { ...m, dialog };
  }

  it('lists the detected shells and saves the chosen default, WSL distribution and folder', async () => {
    const { dialog, backend } = await openPage();
    const list = await within(dialog).findByRole('list', { name: 'Detected shells' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.change(within(dialog).getByLabelText('Default shell'), { target: { value: 'pwsh' } });
    fireEvent.change(within(dialog).getByLabelText('Preferred WSL distribution'), {
      target: { value: 'Ubuntu' },
    });
    fireEvent.change(within(dialog).getByLabelText('Start directory'), {
      target: { value: 'C:/work' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect((backend as unknown as { saves: Settings[] }).saves.at(-1)?.terminal).toMatchObject({
        defaultProfile: 'pwsh',
        wslDistro: 'Ubuntu',
        startDir: 'C:/work',
      }),
    );
  });

  it('refreshing detects the shells again', async () => {
    const { dialog, ssh } = await openPage();
    await within(dialog).findByRole('list', { name: 'Detected shells' });
    const before = ssh.local.profileLoads;
    fireEvent.click(within(dialog).getByRole('button', { name: /Refresh profiles/ }));
    await waitFor(() => expect(ssh.local.profileLoads).toBeGreaterThan(before));
  });

  it('a custom shell needs a full path; relative names are flagged and arguments stay a list', async () => {
    const { dialog, backend } = await openPage();
    fireEvent.click(within(dialog).getByRole('button', { name: /Add custom shell/ }));
    const exe = within(dialog).getByLabelText('Custom shell executable');
    fireEvent.change(exe, { target: { value: 'nu.exe' } });
    expect(within(dialog).getByText(/Use a full path/)).toBeTruthy();
    expect(exe.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(exe, { target: { value: 'C:/Tools/nu.exe' } });
    expect(within(dialog).queryByText(/Use a full path/)).toBeNull();
    const args = within(dialog).getByLabelText('Custom shell arguments');
    fireEvent.change(args, { target: { value: '--login "a b" ; calc' } });
    fireEvent.blur(args);
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => {
      const custom = (backend as unknown as { saves: Settings[] }).saves.at(-1)?.terminal
        .customProfiles;
      expect(custom).toHaveLength(1);
      expect(custom![0]).toMatchObject({
        program: 'C:/Tools/nu.exe',
        args: ['--login', 'a b', ';', 'calc'], // separate arguments, never a command line
      });
    });
  });
});
