// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockNote, MockSsh } from '../../../shared/mockBackend';
import type { ImportPreview, NotesPreview, RestorePreview } from '../../../shared/types';
import { conn, mountApp } from '../../../test/appHarness';
import { useNotes } from '../../notes/store';

const PASS = 'correct horse battery';

const note = (id: string, title: string, extra: Partial<MockNote> = {}): MockNote => ({
  id,
  title,
  kind: 'internal',
  format: 'markdown',
  source: null,
  zoom: 100,
  connections: ['a'],
  text: 'SECRET-BODY',
  offlineText: null,
  offlineAt: null,
  ...extra,
});

const notesPreview = (over: Partial<NotesPreview> = {}): NotesPreview => ({
  notes: 4,
  internal: 2,
  linkedFiles: 1,
  webDocuments: 1,
  snapshots: 1,
  shared: 1,
  missingFiles: 1,
  conflicts: 1,
  unattached: 0,
  ...over,
});

async function openDataPage(withNotes: boolean) {
  useNotes.setState({ counts: {}, overview: {}, content: {}, drafts: {}, view: 'files' });
  const mounted = mountApp({ connections: [conn('a', 'alpha'), conn('b', 'beta')] });
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  if (withNotes) ssh.notes.items.push(note('n1', 'Commands'), note('n2', 'Network'));
  await screen.findByRole('tree');
  await useNotes.getState().refreshCounts();
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const settings = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(settings).getByRole('button', { name: 'Data & Backup' }));
  return { ...mounted, ssh, settings };
}

describe('JSON export and server notes', () => {
  it('offers nothing about notes on an installation without notes', async () => {
    const { settings } = await openDataPage(false);
    fireEvent.click(within(settings).getByRole('button', { name: 'Export Connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export connections' });
    expect(within(dialog).queryByRole('checkbox', { name: /server notes/i })).toBeNull();
  });

  it('notes are off by default; opting in shows the warning and a separate choice for offline copies', async () => {
    const { settings, ssh } = await openDataPage(true);
    fireEvent.click(within(settings).getByRole('button', { name: 'Export Connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export connections' });
    const box = within(dialog).getByRole('checkbox', {
      name: /Include server notes \(2\)/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(within(dialog).queryByText(/unencrypted JSON/)).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: /offline copies/ })).toBeNull();
    // the default export carries no notes option at all
    fireEvent.click(within(dialog).getByRole('button', { name: /Export 2 connections/ }));
    await screen.findByRole('dialog', { name: 'Connections exported' });
    expect(ssh.portability.exports[0]!.notes).toBeUndefined();
  });

  it('with the opt-in the file is marked, the warning is shown and offline copies are a second choice', async () => {
    const { settings, ssh } = await openDataPage(true);
    fireEvent.click(within(settings).getByRole('button', { name: 'Export Connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export connections' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Include server notes/ }));
    expect(within(dialog).getByText(/unencrypted JSON/)).toBeTruthy();
    expect(within(dialog).getByText(/never included/)).toBeTruthy();
    const snaps = within(dialog).getByRole('checkbox', {
      name: /offline copies/,
    }) as HTMLInputElement;
    expect(snaps.checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: /Export 2 connections/ }));
    await screen.findByRole('dialog', { name: 'Connections exported' });
    expect(ssh.portability.exports[0]!.notes).toEqual({ include: true, snapshots: false });
    expect(screen.getByText(/contains 2 server notes in plain text/)).toBeTruthy();
  });
});

describe('JSON import and server notes', () => {
  const preview = (): ImportPreview => ({
    token: 'imp-1',
    fileName: 'n.json',
    formatVersion: 1,
    exportedAt: null,
    folderCount: 0,
    connectionCount: 1,
    newCount: 1,
    duplicateCount: 0,
    changedCount: 0,
    invalidCount: 0,
    relocatedCount: 0,
    unsupportedFields: [],
    keyPathsPresent: 0,
    keyPathsMissing: 0,
    needsKey: 0,
    invalid: [],
    items: [
      {
        index: 0,
        name: 'pve1',
        host: 'pve1.example.com',
        port: 22,
        username: 'root',
        folderPath: '',
        status: 'new',
        existingName: null,
        keyPath: 'none',
        hasCredential: false,
      },
    ],
    itemsTruncated: false,
    notes: notesPreview(),
    notesInvalid: 2,
  });

  it('shows counts only, never content, and imports notes only while the option stays ticked', async () => {
    const { settings, ssh } = await openDataPage(false);
    ssh.portability.nextImport = preview();
    fireEvent.click(within(settings).getByRole('button', { name: 'Import Connections' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    const dialog = screen.getByRole('dialog', { name: 'Import connections' });
    const summary = await within(dialog).findByLabelText('Server notes in this file');
    expect(summary.textContent).toContain('4 notes');
    expect(summary.textContent).toContain('2 written notes');
    expect(summary.textContent).toContain('1 shared between connections');
    expect(summary.textContent).toContain('1 linked file was not found on this computer');
    expect(summary.textContent).toContain('1 note already exists here');
    expect(summary.textContent).toContain('2 invalid notes were ignored');
    expect(summary.textContent).not.toContain('SECRET-BODY');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Import the server notes/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1 profile' }));
    await screen.findByRole('dialog', { name: 'Import finished' });
    expect(ssh.portability.imports[0]).toMatchObject({ importNotes: false });
  });
});

describe('encrypted backup and server notes', () => {
  async function toData(withNotes: boolean) {
    const ctx = await openDataPage(withNotes);
    fireEvent.click(within(ctx.settings).getByRole('button', { name: 'Create Encrypted Backup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create encrypted backup' });
    return { ...ctx, dialog };
  }

  it('the option does not exist on an installation without notes', async () => {
    const { dialog, ssh } = await toData(false);
    expect(within(dialog).queryByRole('checkbox', { name: /Server Notes/i })).toBeNull();
    expect(ssh.portability.backups).toEqual([]);
  });

  it('is on by default when notes exist, leaves the password option off, and reports what went in', async () => {
    const { dialog, ssh } = await toData(true);
    const notes = within(dialog).getByRole('checkbox', {
      name: /Include Server Notes \(2\)/,
    }) as HTMLInputElement;
    expect(notes.checked).toBe(true);
    const creds = within(dialog).getByRole('checkbox', {
      name: /Include saved passwords and SSH key passphrases/,
    }) as HTMLInputElement;
    expect(creds.checked).toBe(false);
    expect(within(dialog).getByText(/Linked local files are saved as paths only/)).toBeTruthy();
    ssh.notes.items.push(
      note('w1', 'README', {
        kind: 'remoteUrl',
        source: 'https://example.com/a.md',
        offlineText: 'x',
        offlineAt: 1,
      }),
    );
    ssh.notes.items.push(
      note('f1', 'Guide', { kind: 'localFile', format: 'html', source: 'C:\\g.html' }),
    );
    ssh.portability.nextDestination = 'C:\\backups\\b.peachbackup';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.change(within(dialog).getByLabelText('Passphrase'), { target: { value: PASS } });
    fireEvent.change(within(dialog).getByLabelText('Confirm passphrase'), {
      target: { value: PASS },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Choose location…' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Create encrypted backup' }));
    const report = await within(dialog).findByTestId('backup-notes-report');
    expect(report.textContent).toContain('4 notes, 1 offline copy included');
    expect(report.textContent).toContain('1 offline copy');
    expect(report.textContent).toContain('1 linked file: only the path is saved, not the contents');
    expect(ssh.portability.backups[0]).toMatchObject({
      includeNotes: true,
      includeCredentials: false,
    });
  });

  it('can be unticked: the backup then carries no notes', async () => {
    const { dialog, ssh } = await toData(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Include Server Notes/ }));
    ssh.portability.nextDestination = 'C:\\backups\\b.peachbackup';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.change(within(dialog).getByLabelText('Passphrase'), { target: { value: PASS } });
    fireEvent.change(within(dialog).getByLabelText('Confirm passphrase'), {
      target: { value: PASS },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Choose location…' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Create encrypted backup' }));
    await within(dialog).findByText(/encrypted, written and verified/);
    expect(ssh.portability.backups[0]).toMatchObject({ includeNotes: false });
    expect(within(dialog).queryByTestId('backup-notes-report')).toBeNull();
  });
});

describe('restore and server notes', () => {
  const restore = (over: Partial<RestorePreview> = {}): RestorePreview => ({
    token: 'rst-1',
    createdAt: '2026-11-23T12:00:00Z',
    appVersion: '0.4.0',
    connectionCount: 1,
    folderCount: 0,
    invalidCount: 0,
    newCount: 1,
    duplicateCount: 0,
    changedCount: 0,
    settingsIncluded: false,
    credentialsRequested: false,
    credentialCount: 0,
    credentialStoreAvailable: true,
    keyPathsPresent: 0,
    keyPathsMissing: 0,
    needsKey: 0,
    unsupportedFields: [],
    items: [
      {
        index: 0,
        name: 'pve1',
        host: 'pve1.example.com',
        port: 22,
        username: 'root',
        folderPath: '',
        status: 'new',
        existingName: null,
        keyPath: 'none',
        hasCredential: false,
      },
    ],
    itemsTruncated: false,
    ...over,
  });

  async function toOptions(preview: RestorePreview) {
    const ctx = await openDataPage(false);
    ctx.ssh.portability.nextRestoreFile = {
      token: 'rst-1',
      fileName: 'b.peachbackup',
      sizeBytes: 2048,
      formatVersion: 1,
    };
    ctx.ssh.portability.restorePreview = preview;
    fireEvent.click(within(ctx.settings).getByRole('button', { name: 'Restore Encrypted Backup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore encrypted backup' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose backup file…' }));
    fireEvent.change(await within(dialog).findByLabelText('Backup passphrase'), {
      target: { value: PASS },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decrypt' }));
    await within(dialog).findByRole('group', { name: 'Backup contents' });
    return { ...ctx, dialog };
  }

  it('shows no notes section for a backup without notes', async () => {
    const { dialog } = await toOptions(restore());
    expect(within(dialog).queryByText('Server notes')).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: /Restore server notes/ })).toBeNull();
  });

  it('previews counts and conflicts, keeps existing notes by default and sends the choice', async () => {
    const { dialog, ssh } = await toOptions(restore({ notes: notesPreview(), notesInvalid: 0 }));
    const summary = within(dialog).getByLabelText('Server notes in this file');
    expect(summary.textContent).toContain('4 notes');
    expect(summary.textContent).toContain('1 offline copy');
    expect(summary.textContent).toContain('1 shared between connections');
    expect(summary.textContent).toContain('1 linked file was not found');
    expect(summary.textContent).toContain('only missing attachments are added');
    expect(summary.textContent).not.toContain('SECRET');
    const box = within(dialog).getByRole('checkbox', {
      name: /Restore server notes/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await within(dialog).findByText(/PeachTerm did not connect to any server/);
    expect(ssh.portability.restores[0]!.options).toMatchObject({
      restoreNotes: true,
      mode: 'merge',
    });
  });

  it('notes can be left out of a restore', async () => {
    const { dialog, ssh } = await toOptions(restore({ notes: notesPreview() }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Restore server notes/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(ssh.portability.restores).toHaveLength(1));
    expect(ssh.portability.restores[0]!.options).toMatchObject({ restoreNotes: false });
  });
});
