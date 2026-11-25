// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { newFolder } from '../../app/actions';
import { __setBackendForTests } from '../../shared/ipc';
import type { Folder } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { useConnections } from './store';
import { validateFolderPath } from './folderPath';

afterEach(() => __setBackendForTests(null));

const fld = (
  id: string,
  name: string,
  parentId: string | null = null,
  expanded = true,
): Folder => ({
  id,
  name,
  parentId,
  expanded,
  sortOrder: 0,
});
const tree = () => useConnections.getState().tree;
const paths = () => {
  const byId = new Map(tree().folders.map((f) => [f.id, f]));
  const path = (f: Folder): string =>
    (f.parentId ? `${path(byId.get(f.parentId)!)}/` : '') + f.name;
  return tree().folders.map(path).sort();
};

async function create(text: string, parent: string | null = null) {
  act(() => newFolder(parent));
  const dialog = await screen.findByRole('dialog');
  const input = within(dialog).getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
  return dialog;
}

describe('creating nested connection folders', () => {
  it('describes the field and accepts a plain name', async () => {
    mountApp({ folders: [], connections: [] });
    await screen.findByRole('tree');
    act(() => newFolder(null));
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    expect(within(dialog).getByText('Folder name or path (e.g. ops/docker)')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Docker' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(paths()).toEqual(['Docker']));
  });

  it('creates ops/docker as ops → docker and selects the last folder', async () => {
    mountApp({ folders: [], connections: [] });
    await screen.findByRole('tree');
    await create('ops/docker');
    await waitFor(() => expect(paths()).toEqual(['ops', 'ops/docker']));
    const docker = tree().folders.find((f) => f.name === 'docker')!;
    expect(useConnections.getState().selectedId).toBe(docker.id);
    // the parents are expanded: the new folder is visible
    expect(tree().folders.every((f) => f.expanded)).toBe(true);
    expect(await screen.findByText('docker', { selector: '.row-label' })).toBeTruthy();
  });

  it('creates three levels and reuses existing parents', async () => {
    mountApp({ folders: [fld('o', 'ops', null, false)], connections: [] });
    await screen.findByRole('tree');
    await create('ops/docker/production');
    await waitFor(() => expect(paths()).toEqual(['ops', 'ops/docker', 'ops/docker/production']));
    expect(tree().folders.filter((f) => f.name === 'ops')).toHaveLength(1);
    expect(tree().folders.find((f) => f.id === 'o')!.expanded).toBe(true);
  });

  it('an existing full path creates nothing and selects it', async () => {
    mountApp({ folders: [fld('o', 'ops'), fld('d', 'docker', 'o')], connections: [] });
    await screen.findByRole('tree');
    await create('ops/docker');
    await waitFor(() => expect(useConnections.getState().selectedId).toBe('d'));
    expect(tree().folders).toHaveLength(2);
  });

  it('starts from the chosen parent and keeps the depth limit', async () => {
    mountApp({ folders: [fld('a', 'a'), fld('b', 'b', 'a')], connections: [] });
    await screen.findByRole('tree');
    await create('c/d', 'a');
    await waitFor(() => expect(paths()).toContain('a/c/d'));
    // below a/b (level 2) only one more level fits
    act(() => newFolder('b'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'x/y' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(paths().some((p) => p.startsWith('a/b/x'))).toBe(false);
  });

  it('never touches existing connections', async () => {
    const connections = [conn('c1', 'alpha', { folderId: 'o' }), conn('c2', 'beta')];
    mountApp({ folders: [fld('o', 'ops')], connections });
    await screen.findByRole('tree');
    const before = JSON.stringify(tree().connections);
    await create('ops/docker');
    await waitFor(() => expect(paths()).toContain('ops/docker'));
    expect(JSON.stringify(tree().connections)).toBe(before);
  });

  it.each(['a//b', '/abs', 'a/', './a', 'a/../b', '..', 'a/b/c/d', '   '])(
    'rejects %j and creates nothing',
    async (text) => {
      mountApp({ folders: [], connections: [] });
      await screen.findByRole('tree');
      const dialog = await create(text);
      expect(await within(dialog).findByRole('alert')).toBeTruthy();
      expect(tree().folders).toHaveLength(0);
    },
  );

  it('the validator mirrors the backend rules', () => {
    const t = { version: 2, connections: [], folders: [fld('a', 'a'), fld('b', 'b', 'a')] };
    expect(validateFolderPath(t, null, 'ops/docker')).toBeNull();
    expect(validateFolderPath(t, 'b', 'one')).toBeNull();
    expect(validateFolderPath(t, 'b', 'one/two')).toMatch(/at most 3 levels/);
    expect(validateFolderPath(t, null, 'x'.repeat(129))).toBeTruthy();
    expect(validateFolderPath(t, null, 'a\u0000b')).toBeTruthy();
    expect(validateFolderPath(t, null, 'Привет/мир ü')).toBeNull();
  });
});
