// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { __setBackendForTests } from '../../shared/ipc';
import type { Folder } from '../../shared/types';
import { conn, mountApp, press } from '../../test/appHarness';
import { useTabs } from '../sessions/store';
import { useConnections } from './store';

afterEach(() => __setBackendForTests(null));

const fld = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
  expanded: true,
  sortOrder: 0,
});

const row = (name: string) =>
  screen.getByText(name, { selector: '.row-label' }).closest('[role=treeitem]') as HTMLElement;
const names = () =>
  [...document.querySelectorAll('.tree-row .row-label, .tree-row .rename-input')].map(
    (el) => (el as HTMLInputElement).value ?? el.textContent,
  );
const tree = () => useConnections.getState().tree;
const click = (el: HTMLElement, init: MouseEventInit = {}) => fireEvent.click(el, init);

describe('inline rename', () => {
  it('F2 renames the selected connection in place and persists immediately', async () => {
    mountApp({ connections: [conn('a', 'alpha', { port: 2222, username: 'ops' })] });
    await screen.findByText('alpha');
    click(row('alpha'));
    act(() => {
      press({ code: 'F2', key: 'F2' });
    });
    const input = (await screen.findByLabelText('Rename connection')) as HTMLInputElement;
    expect(input.value).toBe('alpha');
    expect(screen.queryByRole('dialog')).toBeNull(); // no settings dialog
    fireEvent.change(input, { target: { value: 'Alpha prod' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByLabelText('Rename connection')).toBeNull());
    const renamed = tree().connections[0]!;
    expect(renamed.name).toBe('Alpha prod');
    // nothing else about the connection changed
    expect(renamed).toMatchObject({
      host: 'a.example.com',
      port: 2222,
      username: 'ops',
      auth: 'password',
    });
  });

  it('Escape cancels and keeps the original name', async () => {
    mountApp({ connections: [conn('a', 'alpha')] });
    await screen.findByText('alpha');
    click(row('alpha'));
    act(() => {
      press({ code: 'F2', key: 'F2' });
    });
    const input = await screen.findByLabelText('Rename connection');
    fireEvent.change(input, { target: { value: 'changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Rename connection')).toBeNull());
    expect(tree().connections[0]!.name).toBe('alpha');
  });

  it('an invalid name keeps the editor open with the original stored', async () => {
    mountApp({ connections: [conn('a', 'alpha')] });
    await screen.findByText('alpha');
    click(row('alpha'));
    act(() => {
      press({ code: 'F2', key: 'F2' });
    });
    const input = await screen.findByLabelText('Rename connection');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be empty/);
    expect(screen.getByLabelText('Rename connection')).toBeTruthy();
    expect(tree().connections[0]!.name).toBe('alpha');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Rename connection')).toBeNull());
    expect(tree().connections[0]!.name).toBe('alpha');
  });

  it('leaving the field saves a valid change and discards an invalid one', async () => {
    mountApp({ connections: [conn('a', 'alpha'), conn('b', 'bravo')] });
    await screen.findByText('alpha');
    click(row('alpha'));
    act(() => {
      press({ code: 'F2', key: 'F2' });
    });
    let input = await screen.findByLabelText('Rename connection');
    fireEvent.change(input, { target: { value: 'alpha-2' } });
    fireEvent.blur(input);
    await waitFor(() => expect(tree().connections.find((c) => c.id === 'a')!.name).toBe('alpha-2'));

    click(row('bravo'));
    act(() => {
      press({ code: 'F2', key: 'F2' });
    });
    input = await screen.findByLabelText('Rename connection');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByLabelText('Rename connection')).toBeNull());
    expect(tree().connections.find((c) => c.id === 'b')!.name).toBe('bravo');
  });

  it('works for folders and from the context menu', async () => {
    mountApp({ folders: [fld('f', 'Prod')], connections: [conn('a', 'alpha', { folderId: 'f' })] });
    await screen.findByText('Prod');
    fireEvent.contextMenu(row('Prod'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }));
    const input = await screen.findByLabelText('Rename folder');
    fireEvent.change(input, { target: { value: 'Production' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(tree().folders[0]!.name).toBe('Production'));
    expect(tree().connections[0]!.folderId).toBe('f'); // contents unaffected
  });
});

describe('multi-selection', () => {
  const seed = () =>
    mountApp({
      folders: [fld('f', 'Lab')],
      connections: [
        conn('a', 'alpha'),
        conn('b', 'bravo'),
        conn('c', 'charlie'),
        conn('x', 'x-ray', { folderId: 'f' }),
        conn('y', 'yankee', { folderId: 'f' }),
      ],
    });
  const selected = () => useConnections.getState().selection.sort();

  it('Ctrl+click toggles, Shift+click selects a range', async () => {
    seed();
    await screen.findByText('alpha');
    click(row('alpha'));
    click(row('charlie'), { ctrlKey: true });
    expect(selected()).toEqual(['c:a', 'c:c']);
    click(row('charlie'), { ctrlKey: true });
    expect(selected()).toEqual(['c:a']);
    click(row('alpha')); // a plain click resets the range anchor
    click(row('bravo'), { shiftKey: true });
    expect(selected()).toEqual(['c:a', 'c:b']);
    click(row('charlie'), { shiftKey: true });
    expect(selected()).toEqual(['c:a', 'c:b', 'c:c']);
    expect(row('bravo').getAttribute('aria-selected')).toBe('true');
  });

  it('Ctrl+A selects the siblings in the focused folder, then everything', async () => {
    seed();
    await screen.findByText('x-ray');
    click(row('x-ray'));
    fireEvent.keyDown(row('x-ray'), { key: 'a', ctrlKey: true });
    expect(selected()).toEqual(['c:x', 'c:y']);
    fireEvent.keyDown(row('x-ray'), { key: 'a', ctrlKey: true });
    expect(selected()).toHaveLength(6); // folder + 5 connections
  });

  it('arrow keys move the selection and Shift extends it', async () => {
    seed();
    await screen.findByText('alpha');
    click(row('alpha'));
    fireEvent.keyDown(row('alpha'), { key: 'ArrowDown' });
    expect(selected()).toEqual(['c:b']);
    fireEvent.keyDown(row('bravo'), { key: 'ArrowDown', shiftKey: true });
    expect(selected()).toEqual(['c:b', 'c:c']);
  });

  it('bulk delete asks once, lists the counts and removes only the selection', async () => {
    seed();
    await screen.findByText('alpha');
    click(row('alpha'));
    click(row('charlie'), { ctrlKey: true });
    fireEvent.keyDown(row('charlie'), { key: 'Delete' });
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 items' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1); // one consolidated dialog
    const notice = await within(dialog).findByRole('status');
    expect(within(notice).getByText(/2 connections/, { selector: 'strong' })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      tree()
        .connections.map((c) => c.id)
        .sort(),
    ).toEqual(['b', 'x', 'y']);
  });

  it('cancelling a delete changes nothing', async () => {
    seed();
    await screen.findByText('alpha');
    click(row('alpha'));
    fireEvent.keyDown(row('alpha'), { key: 'Delete' });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(tree().connections).toHaveLength(5);
  });

  it('deleting a folder offers to keep its contents (default) or delete them', async () => {
    seed();
    await screen.findByText('Lab');
    click(row('Lab'));
    fireEvent.keyDown(row('Lab'), { key: 'Delete' });
    const dialog = await screen.findByRole('dialog', { name: 'Delete folder' });
    const keep = within(dialog).getByLabelText(/Keep them/) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    await within(dialog).findByText(/move 2 connections up one level/);
    fireEvent.click(within(dialog).getByLabelText(/Delete the folders together/));
    await within(dialog).findByText(/This will delete/);
    expect(
      within(dialog).getByText(/2 connections and 1 folder/, { selector: 'strong' }),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/Keep them/));
    await within(dialog).findByText(/move 2 connections/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(tree().folders).toHaveLength(0);
    expect(tree().connections).toHaveLength(5);
    expect(tree().connections.every((c) => c.folderId === null)).toBe(true);
  });

  it('warns that open tabs keep running when their saved entry is deleted', async () => {
    seed();
    await screen.findByText('alpha');
    act(() => {
      useTabs.getState().openTab(conn('a', 'alpha'));
    });
    click(row('alpha'));
    fireEvent.keyDown(row('alpha'), { key: 'Delete' });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/1 open tab uses these connections/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useTabs.getState().tabs).toHaveLength(1); // session untouched
  });
});

describe('moving without the mouse', () => {
  it('Move to… moves the selection into a folder; invalid targets explain why', async () => {
    mountApp({
      folders: [fld('A', 'A'), fld('B', 'B', 'A'), fld('C', 'C', 'B'), fld('D', 'D')],
      connections: [conn('s', 'server')],
    });
    await screen.findByText('server');
    fireEvent.contextMenu(row('D'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Move to/ }));
    const dialog = await screen.findByRole('dialog');
    // D into C would be level 4, D into itself is a cycle
    const optionFor = (label: string) =>
      within(dialog).getByText(label, { selector: 'span' }).closest('label')!;
    expect(optionFor('C').getAttribute('data-disabled')).toBe('true');
    expect(within(optionFor('C')).getByText(/at most 3 levels/)).toBeTruthy();
    expect(within(optionFor('D')).getByText(/cannot be moved into itself/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(
      (within(dialog).getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(optionFor('B')).getByRole('radio'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(tree().folders.find((f) => f.id === 'D')!.parentId).toBe('B');
  });

  it('Alt+Arrow reorders within a folder and the order is stored', async () => {
    mountApp({
      connections: [conn('a', 'alpha'), conn('b', 'bravo'), conn('c', 'charlie')],
    });
    await screen.findByText('alpha');
    click(row('charlie'));
    fireEvent.keyDown(row('charlie'), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(names()).toEqual(['alpha', 'charlie', 'bravo']));
    fireEvent.keyDown(row('charlie'), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(names()).toEqual(['charlie', 'alpha', 'bravo']));
    click(row('charlie'));
    fireEvent.keyDown(row('charlie'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(names()).toEqual(['alpha', 'charlie', 'bravo']));
    // connection data is unchanged by reordering
    expect(tree().connections.find((c) => c.id === 'c')).toMatchObject({
      name: 'charlie',
      host: 'c.example.com',
    });
  });

  it('shows a notice for legacy folders nested deeper than three levels, without changing them', async () => {
    mountApp({
      folders: [
        fld('1', 'one'),
        fld('2', 'two', '1'),
        fld('3', 'three', '2'),
        fld('4', 'four', '3'),
      ],
      connections: [],
    });
    expect(await screen.findByText(/nested deeper than 3 levels/)).toBeTruthy();
    expect(tree().folders).toHaveLength(4);
  });
});

describe('folder context menu and the nesting limit', () => {
  const menuLabels = () =>
    within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((m) => m.textContent);

  it('offers a plain "New sub-folder…" where nesting is allowed and hides it at the deepest level', async () => {
    mountApp({
      folders: [fld('f1', 'L1'), fld('f2', 'L2', 'f1'), fld('f3', 'L3', 'f2')],
      connections: [],
    });
    await screen.findByText('L3');
    for (const name of ['L1', 'L2']) {
      fireEvent.contextMenu(row(name));
      const labels = menuLabels();
      expect(labels).toContain('New sub-folder…');
      expect(labels.join(' ')).not.toMatch(/limit/i);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    }
    fireEvent.contextMenu(row('L3'));
    const labels = menuLabels();
    expect(labels).toContain('New connection here…');
    expect(labels.join(' ')).not.toMatch(/sub-folder|limit|levels/i);
    // no dangling or doubled separators after the entry disappeared
    const kids = [...screen.getByRole('menu').children].map((c) =>
      c.getAttribute('role') === 'separator' ? '-' : 'i',
    );
    expect(kids[0]).toBe('i');
    expect(kids.at(-1)).toBe('i');
    expect(kids.join('')).not.toContain('--');
  });
});
