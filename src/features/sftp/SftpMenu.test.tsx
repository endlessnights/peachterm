// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { validateRemoteName } from './model';

const seed = { connections: [conn('a', 'alpha')] };

async function openSession() {
  const mounted = mountApp(seed);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  fireEvent.doubleClick(within(await screen.findByRole('tree')).getByText('alpha'));
  await waitFor(() => expect(ssh.opens).toHaveLength(1));
  await screen.findByRole('listbox', { name: 'Remote files' });
  return { ...mounted, ssh };
}

const list = () => screen.getByRole('listbox', { name: 'Remote files' });
const names = () =>
  within(list())
    .queryAllByRole('option')
    .map((o) => o.querySelector('.sftp-name span:last-child')?.textContent);
const menuLabels = () => screen.getAllByRole('menuitem').map((m) => m.textContent);

async function createVia(kind: 'New File…' | 'New Folder…', name: string) {
  fireEvent.contextMenu(list());
  fireEvent.click(await screen.findByRole('menuitem', { name: kind }));
  const input = await screen.findByLabelText(kind === 'New File…' ? 'File name' : 'Folder name');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

describe('context menu on the empty area', () => {
  it('offers New File, New Folder and Refresh', async () => {
    await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    fireEvent.contextMenu(list());
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(menuLabels()).toEqual(['New File…', 'New Folder…', 'Refresh']);
  });

  it('never acts on a previously selected file', async () => {
    const { ssh } = await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('option', { name: /readme\.txt/ }));
    expect(screen.getByRole('option', { name: /readme\.txt/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.contextMenu(list());
    await screen.findByRole('menu');
    // nothing about the file is offered, and the selection is gone
    expect(menuLabels().join()).not.toMatch(/Rename|Delete|Download|Open/);
    expect(within(list()).queryAllByRole('option', { selected: true })).toEqual([]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.keyDown(list(), { key: 'Delete' }); // would delete the old selection
    expect(screen.queryByText('Delete file?')).toBeNull();
    expect(ssh.sftp.deletes).toEqual([]);
  });

  it('right-clicking an item still shows the item menu', async () => {
    await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    fireEvent.contextMenu(screen.getByRole('option', { name: /readme\.txt/ }));
    await screen.findByRole('menu');
    expect(menuLabels()).toEqual([
      'Open in editor',
      'Download…',
      'Rename…',
      'Copy path',
      'Delete…',
    ]);
    expect(screen.queryByRole('menuitem', { name: /New File/ })).toBeNull();
  });

  it('Refresh reloads the current folder', async () => {
    const { ssh } = await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    const before = ssh.sftp.lists.length;
    fireEvent.contextMenu(list());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Refresh' }));
    await waitFor(() => expect(ssh.sftp.lists.length).toBe(before + 1));
  });
});

describe('New File and New Folder', () => {
  it('creates an empty file in the folder that is shown, through SFTP', async () => {
    const { ssh } = await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    fireEvent.doubleClick(screen.getByRole('option', { name: /home/ }));
    await waitFor(() => expect(names()).toEqual(['notes.md']));
    fireEvent.contextMenu(list());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New File…' }));
    // the target directory is stated explicitly
    expect(await screen.findByText('Will be created in /home')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'todo.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(ssh.sftp.createdFiles).toEqual(['/home/todo.txt']));
    await waitFor(() => expect(names()).toContain('todo.txt'));
    expect(screen.getByRole('option', { name: /todo\.txt/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(ssh.sftp.mkdirs).toEqual([]);
  });

  it('creates a folder from the same menu and refreshes the listing', async () => {
    const { ssh } = await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    await createVia('New Folder…', 'logs');
    await waitFor(() => expect(ssh.sftp.mkdirs).toEqual(['/logs']));
    await waitFor(() => expect(names()).toContain('logs'));
  });

  it('keeps Unicode names intact', async () => {
    const { ssh } = await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    await createVia('New File…', 'отчёт 2024 ✓.txt');
    await waitFor(() => expect(ssh.sftp.createdFiles).toEqual(['/отчёт 2024 ✓.txt']));
    await waitFor(() => expect(names()).toContain('отчёт 2024 ✓.txt'));
  });

  it.each([
    ['', 'Enter a name'],
    ['.', 'not a valid name'],
    ['..', 'not a valid name'],
    ['a/b', 'cannot contain /'],
    ['readme.txt', 'already exists in this folder'],
  ])('refuses %j before anything is sent', async (name, message) => {
    const { ssh } = await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    await createVia('New File…', name);
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(ssh.sftp.createdFiles).toEqual([]);
    expect(screen.getByLabelText('File name')).toBeTruthy(); // the dialog stays open
  });

  it('shows the server error when it fails (for example permission denied)', async () => {
    const { ssh } = await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    ssh.sftp.failNext = 'Permission denied on the server';
    await createVia('New File…', 'blocked.txt');
    expect(await screen.findByText('Permission denied on the server')).toBeTruthy();
    expect(names()).not.toContain('blocked.txt');
    ssh.sftp.failNext = 'An item with that name already exists';
    await createVia('New Folder…', 'raced');
    expect(await screen.findByText('An item with that name already exists')).toBeTruthy();
  });

  it('is reachable without a right click: toolbar menu and the keyboard menu key', async () => {
    await openSession();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    // the old dedicated "New folder" toolbar button is gone; one "new" menu button remains
    const panel = within(screen.getByRole('complementary', { name: 'SFTP' }));
    expect(panel.queryByRole('button', { name: 'New folder' })).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'New file or folder' }));
    expect(menuLabels()).toEqual(['New File…', 'New Folder…']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    // keyboard: the context-menu key on the list opens the folder menu when nothing is selected
    fireEvent.keyDown(list(), { key: 'ContextMenu' });
    expect(await screen.findByRole('menuitem', { name: 'New Folder…' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // ...and the item menu when something is selected
    fireEvent.click(screen.getByRole('option', { name: /readme\.txt/ }));
    fireEvent.keyDown(list(), { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menuitem', { name: /Rename/ })).toBeTruthy();
  });
});

describe('name validation helper', () => {
  it('accepts ordinary and unusual-but-legal names', () => {
    for (const ok of [
      'a',
      '.hidden',
      'with space',
      'tab\tinside'.replace('\t', ' '),
      'a\\b',
      '日本語',
      'x'.repeat(255),
    ]) {
      expect(validateRemoteName(ok)).toBeNull();
    }
    expect(validateRemoteName('é'.repeat(130))).toMatch(/too long/);
    expect(validateRemoteName('line\nbreak')).toMatch(/control/);
  });
});
