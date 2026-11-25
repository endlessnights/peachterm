// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __emitFileDragForTests } from '../../shared/ipc';
import type { MockSsh } from '../../shared/mockBackend';
import type { FileDragEvent, UploadPlan } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { useLock } from '../lock/store';
import { useSettings } from '../settings/store';
import { toCssPoint } from './dropTarget';

const seed = { connections: [conn('a', 'alpha')] };
const noConflicts: UploadPlan = {
  files: 1,
  dirs: 0,
  bytes: 10,
  skipped: 0,
  conflicts: { count: 0, samples: [] },
};

let hit: Element | null = null;
const DPR = { value: 1 };
beforeEach(() => {
  hit = null;
  DPR.value = 1;
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => hit),
  });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => DPR.value });
});
afterEach(() => vi.restoreAllMocks());

async function open() {
  const mounted = mountApp(seed);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  fireEvent.doubleClick(within(await screen.findByRole('tree')).getByText('alpha'));
  await waitFor(() => expect(ssh.opens).toHaveLength(1));
  const list = await screen.findByRole('listbox', { name: 'Remote files' });
  await within(list).findByText('home');
  return { ...mounted, ssh, list };
}

const send = (event: FileDragEvent) => act(() => __emitFileDragForTests(event));
const files = (n = 1, dirs = 0) => ({ files: n, dirs, other: 0 });
/** CSS point -> the physical point the backend would report. */
const at = (x: number, y: number) => ({ x: x * DPR.value, y: y * DPR.value });
const row = (name: RegExp) => screen.getByRole('option', { name });
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('dropping files from the operating system onto the SFTP list', () => {
  it('uploads a file into the current directory when dropped on empty space', async () => {
    const { ssh, list } = await open();
    hit = list;
    send({ phase: 'enter', ...at(50, 50), ...files() });
    expect(ssh.sftp.uploads).toEqual([]); // nothing starts before the release
    send({ phase: 'drop', ...at(50, 50), pickId: 'pick-A', ...files() });
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    expect(ssh.sftp.plans).toEqual([{ pickId: 'pick-A', remoteDir: '/' }]);
    expect(ssh.sftp.uploads[0]).toEqual({ pickId: 'pick-A', remoteDir: '/', overwrite: false });
  });

  it('a drop on a remote folder row targets that folder, not the current directory', async () => {
    const { ssh } = await open();
    hit = within(row(/home/)).getByText('home');
    send({ phase: 'enter', ...at(60, 60), ...files(2) });
    send({ phase: 'over', ...at(61, 60) });
    expect(row(/home/).hasAttribute('data-drop-target')).toBe(true);
    expect(row(/etc/).hasAttribute('data-drop-target')).toBe(false);
    send({ phase: 'drop', ...at(61, 60), pickId: 'pick-B', ...files(2) });
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    expect(ssh.sftp.uploads[0]!.remoteDir).toBe('/home');
    expect(row(/home/).hasAttribute('data-drop-target')).toBe(false); // cleared after the drop
  });

  it('a drop on a plain file row falls back to the current directory', async () => {
    const { ssh } = await open();
    hit = within(row(/readme/)).getByText('readme.txt');
    send({ phase: 'enter', ...at(10, 10), ...files() });
    send({ phase: 'drop', ...at(10, 10), pickId: 'pick-C', ...files() });
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    expect(ssh.sftp.uploads[0]!.remoteDir).toBe('/');
  });

  it('shows what will happen: destination and exact counts', async () => {
    const { list } = await open();
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files(3, 1) });
    expect(screen.getByText('Drop files to upload')).toBeTruthy();
    expect(document.querySelector('.sftp-drop-path')!.textContent).toBe('/');
    expect(screen.getByText('3 files · 1 directory')).toBeTruthy();
    hit = within(row(/home/)).getByText('home');
    send({ phase: 'over', ...at(5, 6) });
    expect(screen.getByText('/home')).toBeTruthy();
    expect(document.querySelector('.sftp-drop')!.getAttribute('role')).toBe('presentation');
  });

  it('cancelling the drag (leave / Escape) starts nothing and removes the preview', async () => {
    const { ssh, list } = await open();
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files() });
    expect(document.querySelector('.sftp-drop')).toBeTruthy();
    send({ phase: 'leave' });
    expect(document.querySelector('.sftp-drop')).toBeNull();
    await settle();
    expect(ssh.sftp.plans).toEqual([]);
    expect(ssh.sftp.uploads).toEqual([]);
  });

  it('drops that land elsewhere (terminal, tabs, sidebar, outside) upload nothing and are forgotten', async () => {
    const { ssh } = await open();
    const terminal = document.querySelector('.terminal-host')!;
    for (const [target, pick] of [
      [terminal, 'pick-term'],
      [document.querySelector('.tabbar'), 'pick-tabs'],
      [screen.getByRole('tree'), 'pick-tree'],
      [null, 'pick-nowhere'],
    ] as const) {
      hit = target;
      send({ phase: 'enter', ...at(5, 5), ...files() });
      expect(document.querySelector('.sftp-drop')).toBeNull(); // no indicator off the list
      send({ phase: 'drop', ...at(5, 5), pickId: pick, ...files() });
    }
    await settle();
    expect(ssh.sftp.plans).toEqual([]);
    expect(ssh.sftp.uploads).toEqual([]);
    expect(ssh.sftp.discards.sort()).toEqual(
      ['pick-nowhere', 'pick-term', 'pick-tabs', 'pick-tree'].sort(),
    );
  });

  it('a drop outside the window area is not accepted', async () => {
    const { ssh, list } = await open();
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files() });
    send({ phase: 'drop', x: -20, y: 30, pickId: 'pick-out', ...files() });
    send({ phase: 'drop', x: 99999, y: 30, pickId: 'pick-out2', ...files() });
    await settle();
    expect(ssh.sftp.uploads).toEqual([]);
    expect(ssh.sftp.discards).toEqual(expect.arrayContaining(['pick-out', 'pick-out2']));
  });

  it('asks before replacing existing files, and only then sends overwrite', async () => {
    const { ssh, list } = await open();
    ssh.sftp.nextPlan = {
      files: 2,
      dirs: 1,
      bytes: 5,
      skipped: 0,
      conflicts: { count: 1, samples: ['myservice/compose.yaml'] },
    };
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files(1, 1) });
    send({ phase: 'drop', ...at(5, 5), pickId: 'pick-D', ...files(1, 1) });
    const dialog = await screen.findByRole('dialog', { name: 'Replace existing files?' });
    expect(dialog.textContent).toContain('myservice/compose.yaml');
    expect(ssh.sftp.uploads).toEqual([]); // not started: the user has not answered
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(ssh.sftp.uploads).toEqual([{ pickId: 'pick-D', remoteDir: '/', overwrite: true }]),
    );
  });

  it('declining the replace question uploads nothing and forgets the selection', async () => {
    const { ssh, list } = await open();
    ssh.sftp.nextPlan = { ...noConflicts, conflicts: { count: 1, samples: ['a.txt'] } };
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files() });
    send({ phase: 'drop', ...at(5, 5), pickId: 'pick-E', ...files() });
    const dialog = await screen.findByRole('dialog', { name: 'Replace existing files?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.sftp.discards).toContain('pick-E'));
    expect(ssh.sftp.uploads).toEqual([]);
  });

  it.each([
    ['permission_denied', /Permission denied on the server/],
    ['local_io', /local file could not be read or written/],
    ['already_exists', /already exists/],
    ['limit_reached', /Too many items/],
  ])('a refused plan (%s) is reported and nothing is uploaded', async (token, message) => {
    const { ssh, list } = await open();
    ssh.sftp.nextPlan = new Error(token);
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files() });
    send({ phase: 'drop', ...at(5, 5), pickId: `pick-F-${token}`, ...files() });
    expect((await screen.findByText(message)).textContent).toMatch(message);
    expect(ssh.sftp.uploads).toEqual([]);
    expect(ssh.sftp.discards).toContain(`pick-F-${token}`);
  });

  it('a drop with nothing uploadable says so', async () => {
    const { ssh, list } = await open();
    ssh.sftp.nextPlan = { ...noConflicts, files: 0, dirs: 0, skipped: 2 };
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files() });
    send({ phase: 'drop', ...at(5, 5), pickId: 'pick-G', ...files() });
    expect(await screen.findByText(/nothing to upload/)).toBeTruthy();
    expect(ssh.sftp.uploads).toEqual([]);
  });

  it('never uploads the same drop twice', async () => {
    const { ssh, list } = await open();
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files() });
    send({ phase: 'drop', ...at(5, 5), pickId: 'pick-H', ...files() });
    send({ phase: 'drop', ...at(5, 5), pickId: 'pick-H', ...files() });
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    await settle();
    expect(ssh.sftp.plans).toHaveLength(1);
    expect(ssh.sftp.uploads).toHaveLength(1);
  });

  it('is ignored while the application is locked', async () => {
    const { ssh, list } = await open();
    hit = list;
    act(() => useLock.getState().setLocked(true));
    send({ phase: 'enter', ...at(5, 5), ...files() });
    expect(document.querySelector('.sftp-drop')).toBeNull();
    send({ phase: 'drop', ...at(5, 5), pickId: 'pick-L', ...files() });
    await settle();
    expect(ssh.sftp.plans).toEqual([]);
    expect(ssh.sftp.uploads).toEqual([]);
  });

  it.each(['left', 'right'] as const)(
    'works with the panel docked %s and after resizing it',
    async (side) => {
      const { ssh } = await open();
      const freshList = async () => {
        await settle(); // docking or resizing rebuilds the panel, which reloads its list
        const list = await screen.findByRole('listbox', { name: 'Remote files' });
        await within(list).findByText('home');
        return list;
      };
      act(() => useSettings.getState().setUi({ sftpSide: side, sftpWidth: 520 }));
      hit = await freshList();
      send({ phase: 'enter', ...at(5, 5), ...files() });
      expect(screen.getByText('Drop files to upload')).toBeTruthy();
      send({ phase: 'drop', ...at(5, 5), pickId: `pick-${side}`, ...files() });
      await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
      act(() => useSettings.getState().setUi({ sftpWidth: 240 }));
      hit = await freshList();
      send({ phase: 'enter', ...at(5, 5), ...files() });
      send({ phase: 'drop', ...at(5, 5), pickId: `pick-${side}-2`, ...files() });
      await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(2));
    },
  );

  it('a second terminal tab: only the visible panel reacts', async () => {
    const { ssh, list } = await open();
    hit = list;
    send({ phase: 'enter', ...at(5, 5), ...files() });
    send({ phase: 'drop', ...at(5, 5), pickId: 'pick-S', ...files() });
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    expect(document.querySelectorAll('.sftp-browser').length).toBe(1);
  });
});

describe('native coordinates', () => {
  const viewport = { width: 1000, height: 800 };
  it.each([
    [1, 100, 200, 100, 200],
    [1.25, 125, 250, 100, 200],
    [1.5, 150, 300, 100, 200],
    [2, 200, 400, 100, 200], // Windows 200 % scaling
    [2.5, 250, 500, 100, 200], // 200 % scaling plus a 125 % interface zoom
  ])('devicePixelRatio %s maps physical (%s,%s) to CSS (%s,%s)', (dpr, px, py, cx, cy) => {
    expect(toCssPoint({ x: px, y: py }, dpr, viewport)).toEqual({ x: cx, y: cy });
  });

  it('refuses implausible input instead of guessing', () => {
    expect(toCssPoint({ x: NaN, y: 1 }, 1, viewport)).toBeNull();
    expect(toCssPoint({ x: 1, y: 1 }, 0, viewport)).toBeNull();
    expect(toCssPoint({ x: 1, y: 1 }, Infinity, viewport)).toBeNull();
    expect(toCssPoint({ x: -1, y: 5 }, 1, viewport)).toBeNull();
    expect(toCssPoint({ x: 1001, y: 5 }, 1, viewport)).toBeNull();
    expect(toCssPoint({ x: 5, y: 801 }, 1, viewport)).toBeNull();
  });

  it('the whole flow works at high DPI: the same CSS point is hit whatever the scale', async () => {
    const { ssh, list } = await open();
    DPR.value = 2;
    hit = within(row(/home/)).getByText('home');
    send({ phase: 'enter', ...at(40, 40), ...files() });
    send({ phase: 'drop', ...at(40, 40), pickId: 'pick-HD', ...files() });
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    expect(ssh.sftp.uploads[0]!.remoteDir).toBe('/home');
    const elementFromPoint = document.elementFromPoint as ReturnType<typeof vi.fn>;
    const [x, y] = elementFromPoint.mock.calls.at(-1)!;
    expect([x, y]).toEqual([40, 40]);
    expect(list).toBeTruthy();
  });
});
