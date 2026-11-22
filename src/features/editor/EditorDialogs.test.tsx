// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { __emitEditorEventForTests } from '../../shared/ipc';
import type { EditorEvent } from '../../shared/types';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, lastSaved, mountApp } from '../../test/appHarness';
import { useEditor } from './store';

const seed = { connections: [conn('a', 'alpha')] };
const EDIT = '33333333-3333-4333-8333-333333333333';

async function openSession() {
  useEditor.setState({ edits: {}, questions: [] });
  const mounted = mountApp(seed);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  fireEvent.doubleClick(within(await screen.findByRole('tree')).getByText('alpha'));
  await waitFor(() => expect(ssh.opens).toHaveLength(1));
  await screen.findByRole('listbox', { name: 'Remote files' });
  return { ...mounted, ssh, sessionId: ssh.opens[0]!.sessionId };
}

const emit = (event: EditorEvent) => act(() => __emitEditorEventForTests(event));

const confirm = (sessionId: string, name = 'sshd_config'): EditorEvent => ({
  kind: 'confirm',
  editId: EDIT,
  sessionId,
  name,
  remotePath: `/etc/ssh/${name}`,
  size: 2048,
});

afterEach(() => localStorage.clear());

describe('opening a remote file in the external editor', () => {
  it('double-clicking a file starts the editor round trip for that session and path', async () => {
    const { ssh, sessionId } = await openSession();
    fireEvent.doubleClick(await screen.findByRole('option', { name: /readme\.txt/ }));
    await waitFor(() =>
      expect(ssh.editor.opens).toEqual([{ sessionId, remotePath: '/readme.txt' }]),
    );
    expect(await screen.findByText(/Opened readme\.txt in your editor/)).toBeTruthy();
  });

  it('the context menu offers "Open in editor" for files only', async () => {
    const { ssh } = await openSession();
    fireEvent.contextMenu(await screen.findByRole('option', { name: /home/ }));
    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Open in editor/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.contextMenu(screen.getByRole('option', { name: /readme\.txt/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Open in editor/ }));
    await waitFor(() => expect(ssh.editor.opens).toHaveLength(1));
  });
});

describe('"Remote file modified" prompt', () => {
  it('offers Yes / Yes to all / No / Cancel and sends exactly the chosen answer', async () => {
    const { ssh, sessionId } = await openSession();
    for (const [label, answer] of [
      ['Yes', 'yes'],
      ['Yes to all', 'yesToAll'],
      ['No', 'no'],
      ['Cancel', 'cancel'],
    ] as const) {
      emit(confirm(sessionId));
      const dialog = await screen.findByRole('dialog', { name: 'Remote file modified' });
      expect(within(dialog).getByText('sshd_config')).toBeTruthy();
      expect(within(dialog).getByText('/etc/ssh/sshd_config')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: label }));
      await waitFor(() => expect(ssh.editor.answers.at(-1)).toEqual({ editId: EDIT, answer }));
      expect(screen.queryByRole('dialog', { name: 'Remote file modified' })).toBeNull();
    }
    expect(ssh.editor.answers).toHaveLength(4);
  });

  it('never stacks two dialogs for the same file, and shows other files one after another', async () => {
    const { ssh, sessionId } = await openSession();
    emit(confirm(sessionId));
    emit(confirm(sessionId)); // duplicate event for the same edit
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    emit({ ...confirm(sessionId, 'other.conf'), editId: '44444444-4444-4444-8444-444444444444' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1); // second waits its turn
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(ssh.editor.answers).toHaveLength(1));
    expect(await screen.findByText('other.conf')).toBeTruthy();
  });

  it('Escape means Cancel: it never uploads', async () => {
    const { ssh, sessionId } = await openSession();
    emit(confirm(sessionId));
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(ssh.editor.answers).toEqual([{ editId: EDIT, answer: 'cancel' }]));
  });

  it('a backdrop click does not answer the question', async () => {
    const { ssh, sessionId } = await openSession();
    emit(confirm(sessionId));
    const dialog = await screen.findByRole('dialog');
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(ssh.editor.answers).toEqual([]);
  });

  it('"Yes to all" is explained as per-connection and is never written anywhere', async () => {
    const { backend, sessionId } = await openSession();
    emit(confirm(sessionId));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/until it ends/)).toBeTruthy();
    expect(within(dialog).getByText(/never saved/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes to all' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // not in the settings Rust persists, not in browser storage
    const saved = lastSaved(backend);
    expect(JSON.stringify(saved ?? {})).not.toMatch(/yesToAll|autoUpload|alwaysAllow/i);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    // and the renderer keeps no memory of it: the next question is a full prompt again
    emit(confirm(sessionId));
    expect(await screen.findByRole('dialog', { name: 'Remote file modified' })).toBeTruthy();
  });

  it('questions of a session that ended are withdrawn', async () => {
    const { ssh, sessionId } = await openSession();
    emit(confirm(sessionId));
    await screen.findByRole('dialog');
    act(() => {
      ssh.emit(sessionId, { kind: 'closed', reason: null });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('remote conflict prompt', () => {
  it('warns, defaults to keeping the local copy and only overwrites on request', async () => {
    const { ssh, sessionId } = await openSession();
    const conflict = {
      kind: 'conflict',
      editId: EDIT,
      sessionId,
      name: 'sshd_config',
      remotePath: '/etc/ssh/sshd_config',
    } as const;
    emit(conflict);
    const dialog = await screen.findByRole('dialog', { name: 'Remote file changed' });
    expect(within(dialog).getByText(/discard those remote changes/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep my local copy only' }));
    await waitFor(() =>
      expect(ssh.editor.conflicts).toEqual([{ editId: EDIT, choice: 'keepLocal' }]),
    );
    emit(conflict);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Overwrite remote file',
      }),
    );
    await waitFor(() =>
      expect(ssh.editor.conflicts.at(-1)).toEqual({ editId: EDIT, choice: 'overwrite' }),
    );
  });
});

describe('edit progress', () => {
  it('reports uploads and failures without losing track of the local copy', async () => {
    const { sessionId } = await openSession();
    emit({ kind: 'opened', editId: EDIT, sessionId, name: 'a.txt', remotePath: '/a.txt' });
    emit({ kind: 'uploading', editId: EDIT, sessionId, name: 'a.txt' });
    expect(useEditor.getState().edits[EDIT]?.state).toBe('uploading');
    emit({ kind: 'uploaded', editId: EDIT, sessionId, name: 'a.txt', atomic: true });
    expect(useEditor.getState().edits[EDIT]?.state).toBe('uploaded');
    expect(await screen.findByText('Uploaded a.txt.')).toBeTruthy();
    emit({
      kind: 'uploadFailed',
      editId: EDIT,
      sessionId,
      name: 'a.txt',
      reason: 'permission_denied',
      message: 'Permission denied on the server',
    });
    expect(await screen.findByText(/was not uploaded.*local copy is kept/)).toBeTruthy();
    emit({ kind: 'closed', editId: EDIT, sessionId, name: 'a.txt', keptLocal: true });
    expect(useEditor.getState().edits[EDIT]).toBeUndefined();
    expect(await screen.findByText(/local copy was kept/)).toBeTruthy();
  });
});
