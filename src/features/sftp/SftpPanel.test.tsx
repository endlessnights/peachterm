import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockOptions, MockSsh } from '../../shared/mockBackend';
import { conn, lastSaved, mountApp } from '../../test/appHarness';
import { useTabs } from '../sessions/store';

const seed = { connections: [conn('a', 'alpha')] };

async function openSession(options: MockOptions = {}) {
  const mounted = mountApp(seed, options);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  fireEvent.doubleClick(within(await screen.findByRole('tree')).getByText('alpha'));
  await waitFor(() => expect(ssh.opens).toHaveLength(1));
  return { ...mounted, ssh };
}

const list = () => screen.findByRole('listbox', { name: 'Remote files' });
const names = async () =>
  within(await list())
    .getAllByRole('option')
    .map((o) => o.querySelector('.sftp-name span:last-child')?.textContent);

describe('SFTP panel', () => {
  it('starts on its own after login and lists the login directory, hiding dotfiles', async () => {
    const { ssh } = await openSession();
    await waitFor(async () => expect(await names()).toEqual(['etc', 'home', 'readme.txt']));
    expect(ssh.sftp.lists[0]).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Remote path' })).toHaveProperty('value', '/');
  });

  it('shows hidden files when asked and remembers the choice in the settings', async () => {
    const { ssh, backend } = await openSession();
    await names();
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }));
    await waitFor(async () => expect(await names()).toContain('.profile'));
    expect(lastSaved(backend)?.sftp.showHidden).toBe(true);
    expect(ssh.sftp.lists).toHaveLength(1); // no refetch needed
  });

  it('opens folders by double-click and goes up again', async () => {
    const { ssh } = await openSession();
    await names();
    fireEvent.doubleClick(screen.getByRole('option', { name: /home/ }));
    await waitFor(async () => expect(await names()).toEqual(['notes.md']));
    expect(ssh.sftp.lists.at(-1)).toBe('/home');
    fireEvent.click(screen.getByRole('button', { name: 'Parent folder' }));
    await waitFor(async () => expect(await names()).toContain('readme.txt'));
    // typing a path
    const path = screen.getByRole('textbox', { name: 'Remote path' });
    fireEvent.change(path, { target: { value: '/etc' } });
    fireEvent.submit(path.closest('form')!);
    await waitFor(() => expect(ssh.sftp.lists.at(-1)).toBe('/etc'));
    await screen.findByText('This folder is empty.');
  });

  it('reports a path that cannot be opened and keeps the previous listing', async () => {
    await openSession();
    await names();
    const path = screen.getByRole('textbox', { name: 'Remote path' });
    fireEvent.change(path, { target: { value: '/nope' } });
    fireEvent.submit(path.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('No such file');
    expect(await names()).toContain('readme.txt');
  });

  it('sorts by clicking the column headers', async () => {
    const { ssh } = await openSession();
    ssh.sftp.fs['/'] = [
      { name: 'b.txt', dir: false, size: 1 },
      { name: 'a.txt', dir: false, size: 99 },
      { name: 'dir', dir: true, size: 0 },
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(async () => expect(await names()).toEqual(['dir', 'a.txt', 'b.txt']));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by size' }));
    await waitFor(async () => expect(await names()).toEqual(['dir', 'b.txt', 'a.txt']));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by size' }));
    await waitFor(async () => expect(await names()).toEqual(['dir', 'a.txt', 'b.txt']));
  });

  it('renames through the backend and refreshes', async () => {
    const { ssh } = await openSession();
    await names();
    fireEvent.contextMenu(screen.getByRole('option', { name: /readme\.txt/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rename/ }));
    fireEvent.change(await screen.findByLabelText('New name'), { target: { value: 'README' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(ssh.sftp.renames).toEqual([{ path: '/readme.txt', newName: 'README' }]),
    );
  });

  it('asks before deleting and deletes only after confirmation', async () => {
    const { ssh } = await openSession();
    await names();
    fireEvent.click(screen.getByRole('option', { name: /readme\.txt/ }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Delete' });
    expect(await screen.findByText('Delete file?')).toBeTruthy();
    expect(ssh.sftp.deletes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ssh.sftp.deletes).toEqual([]);

    fireEvent.contextMenu(screen.getByRole('option', { name: /home/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    expect(await screen.findByText('Delete folder?')).toBeTruthy();
    expect(screen.getByText(/everything inside it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(ssh.sftp.deletes).toEqual(['/home']));
  });

  it('uploads picked files, asking first when they would replace existing ones', async () => {
    const { ssh } = await openSession();
    await names();
    ssh.sftp.nextPick = [{ name: 'new.txt', size: 5 }];
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    expect(ssh.sftp.uploads[0]).toEqual({ pickId: 'pick-1', remoteDir: '/', overwrite: false });

    ssh.sftp.nextPick = [{ name: 'readme.txt', size: 5 }];
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    expect(await screen.findByText('Replace existing files?')).toBeTruthy();
    expect(ssh.sftp.uploads).toHaveLength(1); // nothing sent yet
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(2));
    expect(ssh.sftp.uploads[1]!.overwrite).toBe(true);
  });

  it('cancelling the native file picker uploads nothing', async () => {
    const { ssh } = await openSession();
    await names();
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(ssh.sftp.uploads).toHaveLength(0);
  });

  it('starts a download for the selected file only', async () => {
    const { ssh } = await openSession();
    await names();
    const button = screen.getByRole('button', { name: 'Download selected file' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('option', { name: /home/ }));
    expect(button).toHaveProperty('disabled', true); // folders cannot be downloaded
    fireEvent.click(screen.getByRole('option', { name: /readme\.txt/ }));
    fireEvent.click(button);
    await waitFor(() => expect(ssh.sftp.downloads).toEqual(['/readme.txt']));
  });

  it('shows progress, completion and failure notes for transfers, and can cancel', async () => {
    const { ssh } = await openSession();
    await names();
    ssh.sftp.nextPick = [{ name: 'x.bin', size: 100 }];
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    await waitFor(() => expect(ssh.sftp.uploads).toHaveLength(1));
    const id = '11111111-1111-4111-8111-111111111111';
    act(() =>
      ssh.sftp.emitTransfer({
        kind: 'started',
        transferId: id,
        name: 'x.bin',
        direction: 'upload',
        total: 100,
        index: 1,
        count: 1,
      }),
    );
    const transfers = await screen.findByRole('list', { name: 'Transfers' });
    expect(within(transfers).getByText('x.bin')).toBeTruthy();
    act(() => ssh.sftp.emitTransfer({ kind: 'progress', transferId: id, done: 40, total: 100 }));
    expect(within(transfers).getByRole('progressbar').getAttribute('value')).toBe('40');
    fireEvent.click(within(transfers).getByRole('button', { name: 'Cancel x.bin' }));
    await waitFor(() => expect(ssh.sftp.cancels).toEqual([id]));
    act(() => ssh.sftp.emitTransfer({ kind: 'cancelled', transferId: id }));
    expect(await within(transfers).findByText('cancelled')).toBeTruthy();

    const id2 = '22222222-2222-4222-8222-222222222222';
    act(() => {
      ssh.sftp.emitTransfer({
        kind: 'started',
        transferId: id2,
        name: 'y.bin',
        direction: 'upload',
        total: 10,
        index: 1,
        count: 1,
      });
      ssh.sftp.emitTransfer({
        kind: 'failed',
        transferId: id2,
        reason: 'already_exists',
        message: 'An item with that name already exists',
      });
    });
    expect(await screen.findByText(/failed: already exists on the server/)).toBeTruthy();
    // the end of a batch refreshes the listing
    const before = ssh.sftp.lists.length;
    act(() => ssh.sftp.emitTransfer({ kind: 'finished' }));
    await waitFor(() => expect(ssh.sftp.lists.length).toBe(before + 1));
  });

  it('explains when the server has no SFTP and leaves the terminal alone', async () => {
    await openSession({ noSftp: true });
    expect(await screen.findByText('This server does not offer SFTP.')).toBeTruthy();
    expect(useTabs.getState().tabs[0]?.status).toBe('connected');
    expect(screen.queryByRole('listbox', { name: 'Remote files' })).toBeNull();
  });
});

describe('SFTP dock', () => {
  it('can be moved to the left and back, and the choice is saved', async () => {
    const { backend } = await openSession();
    await names();
    const body = () => document.querySelector('.session-body') as HTMLElement;
    expect(body().dataset.side).toBe('right');
    fireEvent.click(screen.getByRole('button', { name: 'Dock panel left' }));
    await waitFor(() => expect(body().dataset.side).toBe('left'));
    expect(body().firstElementChild?.className).toContain('sftp-panel');
    await waitFor(() => expect(lastSaved(backend)?.ui.sftpSide).toBe('left'));
    fireEvent.click(screen.getByRole('button', { name: 'Dock panel right' }));
    await waitFor(() => expect(body().dataset.side).toBe('right'));
    expect(body().lastElementChild?.className).toContain('sftp-panel');
  });

  it('collapses to a thin button and comes back, remembering it', async () => {
    const { backend } = await openSession();
    await names();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse SFTP panel' }));
    expect(await screen.findByRole('button', { name: 'Show SFTP panel' })).toBeTruthy();
    expect(screen.queryByRole('listbox', { name: 'Remote files' })).toBeNull();
    await waitFor(() => expect(lastSaved(backend)?.sftp.defaultVisible).toBe(false));
    // the terminal is still there
    expect(document.querySelector('.terminal-view')).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Show SFTP panel' })));
    await list();
    await waitFor(() => expect(lastSaved(backend)?.sftp.defaultVisible).toBe(true));
  });

  it('has an adjustable width that is saved', async () => {
    const { backend } = await openSession();
    await names();
    const handle = screen.getByRole('separator', { name: 'Resize SFTP panel' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // right-docked: left grows the panel
    await waitFor(() => expect(lastSaved(backend)?.ui.sftpWidth).toBe(376));
  });
});
