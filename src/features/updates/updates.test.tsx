// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import type { UpdateInfo } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { useEditor } from '../editor/store';
import { useActivity } from '../exit/activity';
import { useTabs } from '../sessions/store';
import { useProfiles } from '../terminal/profilesStore';
import { startUpdateChecks, useUpdates } from './store';

const INFO: UpdateInfo = {
  version: '0.3.1',
  notes: '## 0.3.1\n\nBug fixes and improvements.',
  date: null,
};

async function mount(setup?: (ssh: MockSsh) => void) {
  useProfiles.setState({ profiles: [], defaultId: null, loaded: false, loading: false });
  useActivity.setState({ transfers: {}, unsaved: {} });
  useEditor.setState({ edits: {}, questions: [] });
  useUpdates.setState({
    phase: 'idle',
    checking: false,
    status: null,
    info: null,
    progress: null,
    problem: null,
    noticeOpen: false,
    notified: null,
    confirm: null,
  });
  const mounted = mountApp({ connections: [conn('a', 'alpha')] });
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  setup?.(ssh);
  await screen.findByRole('tree');
  return { ...mounted, ssh };
}

const check = (manual = true) => act(async () => useUpdates.getState().check(manual));
const notice = () => screen.queryByRole('region', { name: 'Software update' });
const indicator = () => screen.queryByRole('button', { name: /^Update available/ });

async function openAbout() {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'About' }));
  return dialog;
}

describe('update preference', () => {
  it('checking is on by default, says it never installs by itself, and can be turned off', async () => {
    const { backend } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const box = within(dialog).getByRole('checkbox', {
      name: 'Automatically check for updates',
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(dialog.textContent).toContain(
      'Check for new PeachTerm versions periodically. Updates are never installed automatically.',
    );
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => {
      const saved = (backend as unknown as { saves: { general: { checkUpdates: boolean } }[] })
        .saves;
      expect(saved.at(-1)?.general.checkUpdates).toBe(false);
    });
  });
});

describe('Settings → About: checking for updates', () => {
  it('shows the version, the status and the time of the last successful check', async () => {
    const { ssh } = await mount();
    const dialog = await openAbout();
    await waitFor(() =>
      expect(within(dialog).getByTestId('about-version').textContent).toBe('0.0.0-dev'),
    );
    expect(within(dialog).getByTestId('update-status').textContent).toBe('Not checked yet');
    expect(within(dialog).getByTestId('update-last-check').textContent).toBe('Never');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check for Updates' }));
    await waitFor(() =>
      expect(within(dialog).getByTestId('update-status').textContent).toBe('Up to date'),
    );
    expect(ssh.updates.checks).toBe(1);
    await waitFor(() =>
      expect(within(dialog).getByTestId('update-last-check').textContent).not.toBe('Never'),
    );
    expect(indicator()).toBeNull();
    expect(notice()).toBeNull();
  });

  it('reports a network problem calmly and never shows raw technical text', async () => {
    const { ssh } = await mount((s) => {
      s.updates.next = { state: 'unavailable', reason: 'network' };
    });
    const dialog = await openAbout();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check for Updates' }));
    await waitFor(() =>
      expect(within(dialog).getByTestId('update-status').textContent).toBe('Update failed'),
    );
    expect(dialog.textContent).toContain('Could not reach GitHub');
    expect(dialog.textContent).not.toMatch(/reqwest|error sending request|dns/i);
    expect(ssh.updates.installs).toBe(0);
  });

  it('a build without an update key says the check is unavailable', async () => {
    await mount((s) => {
      s.updates.configured = false;
    });
    const dialog = await openAbout();
    await waitFor(() =>
      expect(within(dialog).getByTestId('update-status').textContent).toBe(
        'Update check unavailable',
      ),
    );
    expect(dialog.textContent).toContain('not an official release build');
  });
});

describe('an available update', () => {
  const available = (s: MockSsh) => {
    s.updates.next = { state: 'available', info: INFO };
  };

  it('shows a compact notice once and a quiet indicator; "Later" keeps only the indicator', async () => {
    const { ssh } = await mount(available);
    await check(false); // an automatic check
    const card = await screen.findByRole('region', { name: 'Software update' });
    expect(within(card).getByText('PeachTerm 0.3.1 is available')).toBeTruthy();
    expect(card.textContent).toContain('Your version: 0.0.0-dev');
    expect(card.textContent).toContain('Bug fixes and improvements.');
    for (const name of ['Release Notes', 'Later', 'Download Update']) {
      expect(within(card).getByRole('button', { name })).toBeTruthy();
    }
    expect(indicator()).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Release Notes' }));
    await waitFor(() => expect(ssh.updates.notes).toBe(1));
    fireEvent.click(within(card).getByRole('button', { name: 'Later' }));
    expect(notice()).toBeNull();
    expect(indicator()).toBeTruthy(); // still there, not intrusive
    // the same version does not pop up again on the next automatic check
    await check(false);
    expect(notice()).toBeNull();
    // the indicator reopens it on request
    fireEvent.click(indicator()!);
    expect(notice()).toBeTruthy();
    expect(ssh.updates.downloads).toBe(0);
    expect(ssh.updates.installs).toBe(0);
  });

  it('downloading shows real progress only, then offers Install & Restart; nothing installs by itself', async () => {
    const { ssh } = await mount((s) => {
      available(s);
      s.updates.hold = true;
    });
    await check(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().phase).toBe('downloading'));
    // no length announced yet: no invented percentage
    const live = () => screen.getByRole('region', { name: 'Software update' });
    expect(within(live()).getByRole('status').textContent).toBe('Downloading…');
    act(() => useUpdates.setState({ progress: { downloaded: 250, total: 1000 } }));
    expect(within(live()).getByRole('status').textContent).toBe('Downloading… 25%');
    await act(async () => ssh.updates.release());
    await waitFor(() => expect(useUpdates.getState().phase).toBe('ready'));
    const card = await screen.findByRole('region', { name: 'Software update' });
    expect(within(card).getByText('PeachTerm 0.3.1 is ready')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Install & Restart' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Later' })).toBeTruthy();
    expect(ssh.updates.downloads).toBe(1);
    expect(ssh.updates.installs).toBe(0);
    // postponing keeps the downloaded update and the indicator
    fireEvent.click(within(card).getByRole('button', { name: 'Later' }));
    expect(useUpdates.getState().phase).toBe('ready');
    expect(indicator()).toBeTruthy();
    // an automatic check never discards a downloaded update
    await check(false);
    expect(useUpdates.getState().phase).toBe('ready');
    expect(ssh.updates.checks).toBe(1);
  });

  it('installs without a warning when nothing would be lost', async () => {
    const { ssh } = await mount(available);
    await check(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().phase).toBe('ready'));
    fireEvent.click(await screen.findByRole('button', { name: 'Install & Restart' }));
    await waitFor(() => expect(ssh.updates.installs).toBe(1));
    expect(screen.queryByRole('dialog', { name: 'Install the update?' })).toBeNull();
  });

  async function readyWithSessions(extra?: (ssh: MockSsh) => void) {
    const m = await mount(available);
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() =>
      expect(useTabs.getState().tabs.filter((t) => t.status === 'connected')).toHaveLength(2),
    );
    extra?.(m.ssh);
    await check(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().phase).toBe('ready'));
    fireEvent.click(await screen.findByRole('button', { name: 'Install & Restart' }));
    return m;
  }

  it('warns about sessions and tunnels first; "Install Later" is the default and installs nothing', async () => {
    const { ssh } = await readyWithSessions((s) => {
      s.tunnels.running = { t1: 'x', t2: 'y' };
    });
    const dialog = await screen.findByRole('dialog', { name: 'Install the update?' });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['2 active SSH sessions', '2 active SSH tunnels']);
    expect(dialog.textContent).toContain('closes these sessions');
    const later = within(dialog).getByRole('button', { name: 'Install Later' });
    expect(document.activeElement).toBe(later);
    fireEvent.click(later);
    expect(screen.queryByRole('dialog', { name: 'Install the update?' })).toBeNull();
    expect(ssh.updates.installs).toBe(0);
    expect(ssh.closes).toEqual([]); // no session was touched
    expect(useUpdates.getState().phase).toBe('ready');
    // Escape also keeps everything
    fireEvent.click(await screen.findByRole('button', { name: 'Install & Restart' }));
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Install the update?' }), {
      key: 'Escape',
    });
    expect(ssh.updates.installs).toBe(0);
  });

  it('installs only after the explicit confirmation', async () => {
    const { ssh } = await readyWithSessions();
    const dialog = await screen.findByRole('dialog', { name: 'Install the update?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install & Restart' }));
    await waitFor(() => expect(ssh.updates.installs).toBe(1));
  });

  it('counts pending editor uploads, transfers and unsaved settings in the warning', async () => {
    await mount(available);
    act(() => useActivity.getState().setTransfers('tab', 2));
    act(() => useActivity.getState().setUnsaved('settings', true));
    await check(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().phase).toBe('ready'));
    fireEvent.click(await screen.findByRole('button', { name: 'Install & Restart' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install the update?' });
    expect(dialog.textContent).toContain('2 file transfers in progress');
    expect(dialog.textContent).toContain('unsaved changes in the settings dialog');
  });

  it('a failed install leaves the application as it was and says so', async () => {
    const { ssh } = await mount((s) => {
      available(s);
      s.updates.failInstall = true;
    });
    await check(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().phase).toBe('ready'));
    fireEvent.click(await screen.findByRole('button', { name: 'Install & Restart' }));
    await waitFor(() => expect(useUpdates.getState().phase).toBe('failed'));
    expect(ssh.updates.installs).toBe(1);
    expect(useUpdates.getState().problem).toBe('install_failed');
  });

  it('a package that fails the signature check is reported and never installed', async () => {
    const { ssh } = await mount((s) => {
      available(s);
      s.updates.failDownload = 'signature';
    });
    await check(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().problem).toBe('signature'));
    const card = screen.getByRole('region', { name: 'Software update' });
    expect(card.textContent).toContain('did not pass the signature check');
    expect(useUpdates.getState().phase).toBe('available'); // can be retried, nothing was installed
    expect(ssh.updates.installs).toBe(0);
  });

  it('a download that is interrupted can be started again', async () => {
    const { ssh } = await mount((s) => {
      available(s);
      s.updates.failDownload = 'network';
    });
    await check(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().problem).toBe('network'));
    expect(screen.getByRole('region').textContent).toContain('Could not reach GitHub');
    fireEvent.click(screen.getByRole('button', { name: 'Download Update' }));
    await waitFor(() => expect(useUpdates.getState().phase).toBe('ready'));
    expect(ssh.updates.downloads).toBe(2);
  });

  it('a .deb installation is pointed to the release page instead of offering an in-place update', async () => {
    const { ssh } = await mount((s) => {
      available(s);
      s.updates.platform = 'linuxPackage';
    });
    await check(false);
    const card = await screen.findByRole('region', { name: 'Software update' });
    await waitFor(() => expect(card.textContent).toContain('cannot update itself'));
    expect(within(card).queryByRole('button', { name: 'Download Update' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Release Page' }));
    await waitFor(() => expect(ssh.updates.notes).toBe(1));
    expect(ssh.updates.downloads).toBe(0);
  });
});

describe('checking behaviour', () => {
  it('an automatic check that fails stays quiet; a manual one explains', async () => {
    await mount((s) => {
      s.updates.next = { state: 'unavailable', reason: 'timeout' };
    });
    await check(false);
    expect(useUpdates.getState().phase).toBe('idle');
    expect(useUpdates.getState().problem).toBeNull();
    expect(notice()).toBeNull();
    await check(true);
    expect(useUpdates.getState().phase).toBe('failed');
    expect(useUpdates.getState().problem).toBe('timeout');
  });

  it('two checks never overlap', async () => {
    const { ssh } = await mount();
    await act(async () => {
      await Promise.all([useUpdates.getState().check(true), useUpdates.getState().check(true)]);
    });
    expect(ssh.updates.checks).toBe(1);
  });

  it('an older or equal offer is never shown (the backend filters; the UI trusts only "available")', async () => {
    await mount((s) => {
      s.updates.next = { state: 'upToDate' };
    });
    await check(false);
    expect(useUpdates.getState().phase).toBe('upToDate');
    expect(indicator()).toBeNull();
  });

  describe('schedule', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('checks once shortly after start, then about every 24 hours, only while enabled', async () => {
      const ran = vi.spyOn(useUpdates.getState(), 'check').mockResolvedValue();
      let enabled = true;
      const stop = startUpdateChecks(() => enabled);
      expect(ran).not.toHaveBeenCalled(); // not at startup itself
      vi.advanceTimersByTime(31_000);
      expect(ran).toHaveBeenCalledTimes(1);
      expect(ran).toHaveBeenLastCalledWith(false);
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      expect(ran).toHaveBeenCalledTimes(1); // no retry loop in between
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(ran).toHaveBeenCalledTimes(2);
      enabled = false;
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(ran).toHaveBeenCalledTimes(2); // switched off
      stop();
      vi.advanceTimersByTime(48 * 60 * 60 * 1000);
      expect(ran).toHaveBeenCalledTimes(2);
      ran.mockRestore();
    });
  });
});
