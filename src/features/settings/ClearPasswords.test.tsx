// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockOptions, MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { useConnections } from '../connections/store';
import { solveChallenge } from './ClearPasswordsFlow';

const seed = () => ({
  connections: [
    conn('a', 'alpha', { savePassword: true, hasStoredSecret: true }),
    conn('b', 'beta', { savePassword: true, hasStoredSecret: true }),
    conn('c', 'gamma'),
  ],
});

async function openSecurity(options: MockOptions = {}) {
  const mounted = mountApp(seed(), options);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Security' }));
  return { ...mounted, ssh, dialog };
}

const stored = () =>
  useConnections.getState().tree.connections.filter((c) => c.hasStoredSecret).length;

describe('clearing saved passwords needs two confirmations', () => {
  it('the button alone deletes nothing: stage 1 explains the consequences', async () => {
    const { ssh, dialog } = await openSecurity();
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: /Clear all saved passwords/ }),
      ).toHaveProperty('disabled', false),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /Clear all saved passwords/ }));
    const first = await screen.findByRole('dialog', { name: 'Remove all saved passwords?' });
    expect(
      within(first).getByText(
        'Are you sure you want to remove all saved passwords and SSH key passphrases from PeachTerm?',
      ),
    ).toBeTruthy();
    for (const line of [
      'Saved passwords and passphrases will be deleted.',
      'Saved connection profiles will remain.',
      'SSH private key files will not be deleted.',
      'You may need to enter credentials again.',
      'This cannot be undone automatically.',
    ]) {
      expect(within(first).getByText(line)).toBeTruthy();
    }
    // the safe button has the focus
    expect(document.activeElement).toBe(within(first).getByRole('button', { name: 'Cancel' }));
    expect(ssh.clears.begins).toBe(0); // no confirmation was even created yet
    expect(ssh.clears.attempts).toEqual([]);
    expect(stored()).toBe(2);
  });

  it('Cancel at stage 1 deletes nothing', async () => {
    const { ssh, dialog } = await openSecurity();
    fireEvent.click(within(dialog).getByRole('button', { name: /Clear all saved passwords/ }));
    const first = await screen.findByRole('dialog', { name: 'Remove all saved passwords?' });
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Remove all saved passwords?' })).toBeNull(),
    );
    expect(ssh.clears.attempts).toEqual([]);
    expect(stored()).toBe(2);
  });

  it('stage 2 shows the number of entries and keeps the delete button disabled until the answer is right', async () => {
    const { ssh, dialog } = await openSecurity();
    fireEvent.click(within(dialog).getByRole('button', { name: /Clear all saved passwords/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const second = await screen.findByRole('dialog', { name: 'Confirm deletion' });
    expect(within(second).getByText('2')).toBeTruthy();
    expect(within(second).getByText(/solve: 7 \+ 5 = \?/)).toBeTruthy();
    const del = within(second).getByRole('button', { name: 'Delete 2 saved passwords' });
    expect(del).toHaveProperty('disabled', true);
    const input = within(second).getByLabelText('7 + 5 equals');
    fireEvent.change(input, { target: { value: '13' } });
    expect(del).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: '' } });
    expect(del).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: '12' } });
    expect(del).toHaveProperty('disabled', false);
    expect(ssh.clears.begins).toBe(1);
    expect(ssh.clears.attempts).toEqual([]); // still nothing sent for deletion
    expect(stored()).toBe(2);
  });

  it('Cancel at stage 2 deletes nothing and cancels the pending confirmation', async () => {
    const { ssh, dialog } = await openSecurity();
    fireEvent.click(within(dialog).getByRole('button', { name: /Clear all saved passwords/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const second = await screen.findByRole('dialog', { name: 'Confirm deletion' });
    fireEvent.change(within(second).getByLabelText('7 + 5 equals'), { target: { value: '12' } });
    fireEvent.click(within(second).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.clears.cancels).toBeGreaterThan(0));
    expect(ssh.clears.attempts).toEqual([]);
    expect(stored()).toBe(2);
  });

  it('the right answer deletes the saved passwords and keeps the connection profiles', async () => {
    const { ssh, dialog } = await openSecurity();
    fireEvent.click(within(dialog).getByRole('button', { name: /Clear all saved passwords/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const second = await screen.findByRole('dialog', { name: 'Confirm deletion' });
    fireEvent.change(within(second).getByLabelText('7 + 5 equals'), { target: { value: '12' } });
    fireEvent.click(within(second).getByRole('button', { name: 'Delete 2 saved passwords' }));
    await waitFor(() => expect(ssh.clears.deleted).toBe(2));
    expect(await screen.findByText('Removed 2 saved passwords.')).toBeTruthy();
    expect(stored()).toBe(0);
    expect(useConnections.getState().tree.connections).toHaveLength(3); // profiles stay
    // the token that was sent is the one Rust issued
    expect(ssh.clears.attempts).toEqual([{ token: 'clear-1', answer: 12 }]);
  });

  it('reports partial failures with both counts and leaves the failed ones saved', async () => {
    const { dialog } = await openSecurity({ clearFailures: 1 });
    fireEvent.click(within(dialog).getByRole('button', { name: /Clear all saved passwords/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const second = await screen.findByRole('dialog', { name: 'Confirm deletion' });
    fireEvent.change(within(second).getByLabelText('7 + 5 equals'), { target: { value: '12' } });
    fireEvent.click(within(second).getByRole('button', { name: 'Delete 2 saved passwords' }));
    expect(
      await screen.findByText(
        /Removed 1 saved password; 1 could not be removed and are still saved/,
      ),
    ).toBeTruthy();
    expect(stored()).toBe(1);
  });

  it('the backend, not the UI, refuses a forged request', async () => {
    const { backend } = await openSecurity();
    const invoke = backend as unknown as (
      c: string,
      a?: Record<string, unknown>,
    ) => Promise<unknown>;
    // no confirmation was started: a direct call is refused
    await expect(
      invoke('credentials_clear_all', { token: 'made-up', answer: 12 }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
    const begun = (await invoke('credentials_clear_begin')) as { token: string };
    await expect(
      invoke('credentials_clear_all', { token: begun.token, answer: 11 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not the right answer'),
    });
    await expect(
      invoke('credentials_clear_all', { token: 'other', answer: 12 }),
    ).rejects.toBeTruthy();
    expect(stored()).toBe(2);
  });
});

describe('known host keys are no longer managed in Settings', () => {
  it('the Security page has no host-key list and no Forget buttons', async () => {
    const { dialog } = await openSecurity();
    expect(within(dialog).queryByText('Known host keys')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Forget/ })).toBeNull();
    expect(within(dialog).getByText('Credential storage')).toBeTruthy();
  });
});

describe('challenge parsing', () => {
  it('solves sums and products', () => {
    expect(solveChallenge('7 + 5')).toBe(12);
    expect(solveChallenge('4 × 3')).toBe(12);
    expect(solveChallenge('12 × 12')).toBe(144);
    expect(solveChallenge('seven + five')).toBeNull();
  });
});
