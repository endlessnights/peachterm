// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import type { ImportPreview, RestorePreview } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';

const PASS = 'correct horse battery';

const importPreview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  token: 'imp-1',
  fileName: 'peachterm-connections-2026-11-23.json',
  formatVersion: 1,
  exportedAt: '2026-11-23T12:00:00Z',
  folderCount: 1,
  connectionCount: 3,
  newCount: 1,
  duplicateCount: 1,
  changedCount: 0,
  invalidCount: 1,
  relocatedCount: 0,
  unsupportedFields: ['connections.password'],
  keyPathsPresent: 0,
  keyPathsMissing: 1,
  needsKey: 0,
  invalid: [{ kind: 'connection', index: 2, reason: 'Port must be between 1 and 65535' }],
  items: [
    {
      index: 0,
      name: 'Новый сервер',
      host: '2001:db8::1',
      port: 2222,
      username: 'админ',
      folderPath: 'Прод',
      status: 'new',
      existingName: null,
      keyPath: 'none',
      hasCredential: false,
    },
    {
      index: 1,
      name: 'Dup',
      host: 'a.example.com',
      port: 22,
      username: 'root',
      folderPath: '',
      status: 'duplicate',
      existingName: 'alpha',
      keyPath: 'missing',
      hasCredential: false,
    },
  ],
  itemsTruncated: false,
  ...over,
});

const restorePreview = (over: Partial<RestorePreview> = {}): RestorePreview => ({
  token: 'rst-1',
  createdAt: '2026-11-23T12:00:00Z',
  appVersion: '0.1.0',
  connectionCount: 2,
  folderCount: 1,
  invalidCount: 0,
  newCount: 1,
  duplicateCount: 1,
  changedCount: 0,
  settingsIncluded: true,
  credentialsRequested: true,
  credentialCount: 2,
  credentialStoreAvailable: true,
  keyPathsPresent: 0,
  keyPathsMissing: 0,
  needsKey: 0,
  unsupportedFields: [],
  items: [
    {
      index: 0,
      name: 'One',
      host: 'one.example.com',
      port: 22,
      username: 'u',
      folderPath: '',
      status: 'new',
      existingName: null,
      keyPath: 'none',
      hasCredential: true,
    },
    {
      index: 1,
      name: 'Two',
      host: 'a.example.com',
      port: 22,
      username: 'root',
      folderPath: '',
      status: 'duplicate',
      existingName: 'alpha',
      keyPath: 'none',
      hasCredential: true,
    },
  ],
  itemsTruncated: false,
  ...over,
});

async function openDataPage() {
  const mounted = mountApp({
    connections: [
      conn('a', 'alpha', { savePassword: true, hasStoredSecret: true }),
      conn('b', 'beta', { keyPath: '/home/me/.ssh/id' }),
    ],
  });
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const settings = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(settings).getByRole('button', { name: 'Data & Backup' }));
  return { ...mounted, ssh, settings };
}

describe('Settings → Data & Backup', () => {
  it('has two separate groups with the specified descriptions and buttons', async () => {
    const { settings } = await openDataPage();
    const profiles = within(settings).getByRole('region', { name: 'Connection profiles' });
    expect(
      within(profiles).getByText(
        'Transfer saved connection profiles without passwords or other secrets.',
      ),
    ).toBeTruthy();
    expect(within(profiles).getByRole('button', { name: 'Export Connections' })).toBeTruthy();
    expect(within(profiles).getByRole('button', { name: 'Import Connections' })).toBeTruthy();
    const backups = within(settings).getByRole('region', { name: 'Encrypted backups' });
    expect(
      within(backups).getByText(
        'Back up connections, application preferences and optionally saved credentials using strong encryption.',
      ),
    ).toBeTruthy();
    expect(within(backups).getByRole('button', { name: 'Create Encrypted Backup' })).toBeTruthy();
    expect(within(backups).getByRole('button', { name: 'Restore Encrypted Backup' })).toBeTruthy();
  });
});

describe('connection export', () => {
  it('exports everything without key paths by default', async () => {
    const { settings, ssh } = await openDataPage();
    fireEvent.click(within(settings).getByRole('button', { name: 'Export Connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export connections' });
    const keyBox = within(dialog).getByRole('checkbox', { name: /Include SSH key file paths/ });
    expect((keyBox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: /Export 2 connections/ }));
    await screen.findByRole('dialog', { name: 'Connections exported' });
    expect(ssh.portability.exports).toEqual([{ ids: null, includeKeyPaths: false }]);
  });

  it('exports selected profiles and asks before including key paths', async () => {
    const { settings, ssh } = await openDataPage();
    fireEvent.click(within(settings).getByRole('button', { name: 'Export Connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export connections' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Selected connections' }));
    expect(within(dialog).getByRole('button', { name: /Export 0 connections/ })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /beta/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Include SSH key file paths/ }));
    expect(within(dialog).getByText(/can reveal your user name/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Export 1 connection…/ }));
    await screen.findByRole('dialog', { name: 'Connections exported' });
    expect(ssh.portability.exports).toEqual([{ ids: ['b'], includeKeyPaths: true }]);
    expect(screen.getByText(/Passwords and key passphrases are not in this file/)).toBeTruthy();
  });
});

describe('connection import', () => {
  it('shows a preview first; duplicates are skipped by default', async () => {
    const { settings, ssh } = await openDataPage();
    ssh.portability.nextImport = importPreview();
    fireEvent.click(within(settings).getByRole('button', { name: 'Import Connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import connections' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    const preview = await screen.findByRole('group', { name: 'Import summary' });
    expect(within(preview).getByText('Connections').previousSibling?.textContent).toBe('3');
    expect(within(preview).getByText('Invalid').previousSibling?.textContent).toBe('1');
    expect(screen.getByText(/Unsupported fields were ignored: connections.password/)).toBeTruthy();
    expect(screen.getByText(/1 key file path does not exist on this computer/)).toBeTruthy();
    expect(screen.getByText('Новый сервер')).toBeTruthy(); // Unicode survives
    expect(ssh.portability.imports).toEqual([]); // nothing applied by choosing a file
    const skip = screen.getByRole('radio', { name: /Skip duplicates/ }) as HTMLInputElement;
    expect(skip.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 profile' }));
    await screen.findByRole('dialog', { name: 'Import finished' });
    expect(ssh.portability.imports).toEqual([{ token: 'imp-1', duplicates: 'skip', update: [] }]);
  });

  it('updates only the duplicates the user ticks', async () => {
    const { settings, ssh } = await openDataPage();
    ssh.portability.nextImport = importPreview();
    fireEvent.click(within(settings).getByRole('button', { name: 'Import Connections' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    await screen.findByRole('group', { name: 'Import summary' });
    fireEvent.click(screen.getByRole('radio', { name: /Update selected existing/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Update Dup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 profiles' }));
    await screen.findByRole('dialog', { name: 'Import finished' });
    expect(ssh.portability.imports[0]).toMatchObject({ duplicates: 'update', update: [1] });
  });

  it('cancelling discards the staged file and changes nothing', async () => {
    const { settings, ssh } = await openDataPage();
    ssh.portability.nextImport = importPreview();
    fireEvent.click(within(settings).getByRole('button', { name: 'Import Connections' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    await screen.findByRole('group', { name: 'Import summary' });
    const dialog = screen.getByRole('dialog', { name: 'Import connections' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.portability.cancels).toEqual(['imp-1']));
    expect(ssh.portability.imports).toEqual([]);
  });

  it('a cancelled file dialog keeps the first screen', async () => {
    const { settings } = await openDataPage();
    fireEvent.click(within(settings).getByRole('button', { name: 'Import Connections' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file…' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy());
  });
});

describe('encrypted backup wizard', () => {
  async function toPassphrase() {
    const ctx = await openDataPage();
    fireEvent.click(within(ctx.settings).getByRole('button', { name: 'Create Encrypted Backup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create encrypted backup' });
    return { ...ctx, dialog };
  }

  it('saved credentials are off by default and the file warning appears when ticked', async () => {
    const { dialog } = await toPassphrase();
    const box = within(dialog).getByRole('checkbox', {
      name: /Include saved passwords and SSH key passphrases/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(within(dialog).getByText(/public Git repository/)).toBeTruthy();
    expect(within(dialog).getByText(/SSH private key files are never included/)).toBeTruthy();
  });

  it('requires a matching passphrase of at least 12 characters and warns about loss', async () => {
    const { dialog } = await toPassphrase();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(
      within(dialog).getByText('If you lose this passphrase, your backup cannot be recovered.', {
        exact: false,
      }),
    ).toBeTruthy();
    const next = within(dialog).getByRole('button', { name: 'Next' });
    const first = within(dialog).getByLabelText('Passphrase');
    const second = within(dialog).getByLabelText('Confirm passphrase');
    fireEvent.change(first, { target: { value: 'short' } });
    fireEvent.change(second, { target: { value: 'short' } });
    expect(next).toHaveProperty('disabled', true);
    fireEvent.change(first, { target: { value: PASS } });
    expect(next).toHaveProperty('disabled', true); // confirmation differs
    fireEvent.change(second, { target: { value: PASS } });
    expect(next).toHaveProperty('disabled', false);
    expect((first as HTMLInputElement).type).toBe('password');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Show passphrase' }));
    expect((first as HTMLInputElement).type).toBe('text');
  });

  it('runs the whole wizard and reports counts, including skipped credentials', async () => {
    const { dialog, ssh } = await toPassphrase();
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: /Include saved passwords and SSH key passphrases/,
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.change(within(dialog).getByLabelText('Passphrase'), { target: { value: PASS } });
    fireEvent.change(within(dialog).getByLabelText('Confirm passphrase'), {
      target: { value: PASS },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const create = within(dialog).getByRole('button', { name: 'Create encrypted backup' });
    expect(create).toHaveProperty('disabled', true); // no destination yet
    ssh.portability.nextDestination = '/tmp/peachterm-backup.peachbackup';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose location…' }));
    await within(dialog).findByText('/tmp/peachterm-backup.peachbackup');
    fireEvent.click(create);
    await within(dialog).findByText(/encrypted, written and verified/);
    expect(ssh.portability.backups).toEqual([
      {
        token: 'dest-1',
        includeSettings: true,
        includeCredentials: true,
        passphrase: PASS,
        confirm: PASS,
      },
    ]);
    expect(within(dialog).getByText('Connections').previousSibling?.textContent).toBe('2');
    expect(within(dialog).getByText(/Backup format version 1/)).toBeTruthy();
    // The passphrase is gone from the page.
    expect(document.body.innerHTML).not.toContain(PASS);
  });

  it('cancelling before encryption leaves nothing pending in Rust', async () => {
    const { dialog, ssh } = await toPassphrase();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.change(within(dialog).getByLabelText('Passphrase'), { target: { value: PASS } });
    fireEvent.change(within(dialog).getByLabelText('Confirm passphrase'), {
      target: { value: PASS },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    ssh.portability.nextDestination = '/tmp/x.peachbackup';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose location…' }));
    await within(dialog).findByText('/tmp/x.peachbackup');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.portability.cancels).toEqual(['dest-1']));
    expect(ssh.portability.backups).toEqual([]);
  });
});

describe('restore wizard', () => {
  async function toPassphraseStep(preview: RestorePreview = restorePreview()) {
    const ctx = await openDataPage();
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
    await within(dialog).findByLabelText('Backup passphrase');
    return { ...ctx, dialog };
  }

  const unlock = async (dialog: HTMLElement, passphrase = 'correct horse battery') => {
    fireEvent.change(within(dialog).getByLabelText('Backup passphrase'), {
      target: { value: passphrase },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decrypt' }));
  };

  it('a wrong passphrase shows a neutral error and stays on the step', async () => {
    const { dialog, ssh } = await toPassphraseStep();
    await unlock(dialog, 'not the passphrase');
    await within(dialog).findByText(/passphrase is wrong, or the backup file has been damaged/);
    expect(within(dialog).getByLabelText('Backup passphrase')).toBeTruthy();
    expect(ssh.portability.restores).toEqual([]);
  });

  it('shows only a redacted preview with safe defaults', async () => {
    const { dialog } = await toPassphraseStep();
    await unlock(dialog);
    const summary = await within(dialog).findByRole('group', { name: 'Backup contents' });
    expect(within(summary).getByText('Saved passwords').previousSibling?.textContent).toBe('2');
    expect(
      (within(dialog).getByRole('radio', { name: /Merge with existing/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole('checkbox', {
          name: /Restore saved passwords and passphrases/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        within(dialog).getByRole('checkbox', {
          name: /Restore application settings/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (within(dialog).getByRole('radio', { name: /Skip them/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('merge restore sends safe defaults', async () => {
    const { dialog, ssh } = await toPassphraseStep();
    await unlock(dialog);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Restore' }));
    await within(dialog).findByText(/PeachTerm did not connect to any server/);
    expect(ssh.portability.restores).toEqual([
      {
        token: 'rst-1',
        options: {
          mode: 'merge',
          selected: [0, 1],
          duplicates: 'skip',
          update: [],
          restoreSettings: false,
          restoreCredentials: false,
          credentialConflict: 'keep',
          confirmReplaceCredentials: false,
          confirmReplaceAll: false,
        },
      },
    ]);
  });

  it('replace is destructive: it needs an explicit confirmation', async () => {
    const { dialog } = await toPassphraseStep();
    await unlock(dialog);
    fireEvent.click(
      await within(dialog).findByRole('radio', { name: /Replace existing configuration/ }),
    );
    const go = within(dialog).getByRole('button', { name: 'Replace and restore' });
    expect(go).toHaveProperty('disabled', true);
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /current connections will be replaced/ }),
    );
    expect(go).toHaveProperty('disabled', false);
  });

  it('replacing existing passwords needs its own confirmation', async () => {
    const { dialog, ssh } = await toPassphraseStep();
    await unlock(dialog);
    fireEvent.click(
      await within(dialog).findByRole('checkbox', {
        name: /Restore saved passwords and passphrases/,
      }),
    );
    fireEvent.click(
      within(dialog).getByRole('radio', { name: /Replace it with the one from the backup/ }),
    );
    const go = within(dialog).getByRole('button', { name: 'Restore' });
    expect(go).toHaveProperty('disabled', true);
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /existing saved passwords may be overwritten/ }),
    );
    fireEvent.click(go);
    await within(dialog).findByText(/Saved passwords:/);
    expect(ssh.portability.restores[0]?.options).toMatchObject({
      restoreCredentials: true,
      credentialConflict: 'replace',
      confirmReplaceCredentials: true,
    });
  });

  it('is unavailable without a credential store; passwords are never offered as plain files', async () => {
    const { dialog } = await toPassphraseStep(restorePreview({ credentialStoreAvailable: false }));
    await unlock(dialog);
    const box = await within(dialog).findByRole('checkbox', {
      name: /Restore saved passwords and passphrases/,
    });
    expect(box).toHaveProperty('disabled', true);
    expect(within(dialog).getByText(/never written to a plain file/)).toBeTruthy();
  });

  it('selected mode restores only ticked profiles', async () => {
    const { dialog, ssh } = await toPassphraseStep();
    await unlock(dialog);
    fireEvent.click(
      await within(dialog).findByRole('radio', { name: /Restore selected profiles only/ }),
    );
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restore Two' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await within(dialog).findByText(/PeachTerm did not connect/);
    expect(ssh.portability.restores[0]?.options).toMatchObject({ mode: 'selected', selected: [0] });
  });

  it('cancelling discards the decrypted backup in Rust', async () => {
    const { dialog, ssh } = await toPassphraseStep();
    await unlock(dialog);
    await within(dialog).findByRole('group', { name: 'Backup contents' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.portability.cancels).toEqual(['rst-1']));
    expect(ssh.portability.restores).toEqual([]);
  });
});
