// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import type { PermissionReport, Settings } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { useLock } from '../lock/store';
import { useTabs } from '../sessions/store';
import { requestExplainSelection } from '../terminal/events';

const clip: string[] = [];
beforeEach(() => {
  clip.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (t: string) => void clip.push(t)),
      readText: vi.fn(async () => ''),
    },
  });
});
afterEach(() => vi.restoreAllMocks());

async function open(help?: Partial<Settings['linuxHelp']>) {
  const mounted = mountApp(
    { connections: [conn('a', 'alpha')] },
    help
      ? {
          settings: (s: Settings) => ({
            ...s,
            linuxHelp: { ...s.linuxHelp, enabled: true, ...help },
          }),
        }
      : {},
  );
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  fireEvent.doubleClick(within(await screen.findByRole('tree')).getByText('alpha'));
  await waitFor(() => expect(ssh.opens).toHaveLength(1));
  await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
  await screen.findByRole('listbox', { name: 'Remote files' });
  return { ...mounted, ssh, host: document.querySelector('.terminal-host')! };
}

async function denyCreate(ssh: MockSsh) {
  ssh.sftp.failNext = 'permission_denied';
  fireEvent.contextMenu(screen.getByRole('listbox', { name: 'Remote files' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Folder…' }));
  fireEvent.change(await screen.findByLabelText(/Folder name or path/), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

describe('permission assistance', () => {
  it('is silent when Linux Command Help is off: the ordinary error only', async () => {
    const { ssh } = await open();
    await denyCreate(ssh);
    expect(screen.queryByRole('button', { name: 'Why did this happen?' })).toBeNull();
    expect(ssh.sftp.diagnosed).toEqual([]);
  });

  it('offers an explanation, and runs nothing until Diagnose is pressed', async () => {
    const { ssh } = await open({});
    await denyCreate(ssh);
    fireEvent.click(await screen.findByRole('button', { name: 'Why did this happen?' }));
    expect(await screen.findByText(/Connected as/)).toBeTruthy();
    expect(ssh.sftp.diagnosed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Show Details' }));
    expect(screen.getByTestId('perm-details')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose Permissions' }));
    await waitFor(() => expect(ssh.sftp.diagnosed).toEqual(['/']));
    expect((await screen.findAllByTestId('perm-verdict')).length).toBeGreaterThan(0);
    // suggestions are copy-only and never sent to the terminal
    fireEvent.click(await screen.findByRole('button', { name: /Copy.*id$/ }));
    await waitFor(() => expect(clip).toContain('id'));
    expect(ssh.writes).toEqual([]);
  });

  it('states plainly when the server refuses diagnostics', async () => {
    const { ssh } = await open({});
    const report: PermissionReport = {
      platform: 'unknown',
      exec: 'unavailable',
      user: null,
      path: '/',
      pathRefused: false,
      target: null,
      chain: [],
      access: null,
      unsupported: [],
    };
    ssh.sftp.report = report;
    await denyCreate(ssh);
    fireEvent.click(await screen.findByRole('button', { name: 'Why did this happen?' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Diagnose Permissions' }));
    expect(await screen.findByText(/does not allow PeachTerm to run diagnostics/)).toBeTruthy();
  });

  it('is off when only the permission option is disabled', async () => {
    const { ssh } = await open({ permissions: false });
    await denyCreate(ssh);
    expect(screen.queryByRole('button', { name: 'Why did this happen?' })).toBeNull();
  });
});

describe('explaining selected text', () => {
  const select = (text: string) => act(() => fakeTerminals[0]!.select(text));

  it('does nothing while the feature is off', async () => {
    await open();
    select('ls -la');
    act(() => requestExplainSelection());
    expect(screen.queryByTestId('help-selected')).toBeNull();
  });

  it('explains only the selection, from the shortcut event', async () => {
    const { ssh } = await open({});
    select('ls -la /var/log');
    act(() => requestExplainSelection());
    expect((await screen.findByTestId('help-selected')).textContent).toBe('ls -la /var/log');
    expect(screen.getAllByText(/ls/).length).toBeGreaterThan(0);
    expect(ssh.writes).toEqual([]); // nothing reached the terminal
  });

  it('answers neutrally for anything outside the reference', async () => {
    await open({});
    select('rm -rf /tmp/x | sh');
    act(() => requestExplainSelection());
    expect(
      await screen.findByText('No built-in explanation is available for this command.'),
    ).toBeTruthy();
  });

  it('copy buttons copy an example and never execute it', async () => {
    const { ssh } = await open({});
    select('df -h');
    act(() => requestExplainSelection());
    const buttons = await screen.findAllByRole('button', { name: /^Copy/ });
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(clip.length).toBe(1));
    expect(ssh.writes).toEqual([]);
  });

  it('opens from Shift + right click, which has Explain and Reference entries', async () => {
    const { host } = await open({});
    select('pwd');
    fireEvent.contextMenu(host, { shiftKey: true });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Explain Command' }));
    expect(await screen.findByTestId('help-selected')).toBeTruthy();
  });

  it('a plain right click keeps its normal meaning even when help is on', async () => {
    const { host } = await open({});
    fireEvent.contextMenu(host);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('is unreachable while the application is locked', async () => {
    await open({});
    select('pwd');
    act(() => useLock.setState({ view: { locked: true } } as never));
    act(() => requestExplainSelection());
    expect(screen.queryByTestId('help-selected')).toBeNull();
  });
});
