// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { openSettings } from '../../app/dialogs';
import { __setBackendForTests } from '../../shared/ipc';
import { lastSaved, mountApp } from '../../test/appHarness';

afterEach(() => __setBackendForTests(null));

const open = async (page?: Parameters<typeof openSettings>[0]) => {
  await screen.findByRole('tree');
  act(() => openSettings(page));
  return screen.findByRole('dialog');
};
const button = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole('button', { name }) as HTMLButtonElement;

describe('Settings access', () => {
  it('has a visible Settings button that does not depend on the credential indicator', async () => {
    mountApp();
    await screen.findByRole('tree');
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('the credential status indicator is informational only', async () => {
    mountApp();
    await screen.findByRole('tree');
    const indicator = await screen.findByText(/memory \(dev mock\)/);
    fireEvent.click(indicator);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Settings stays reachable when the sidebar is collapsed', async () => {
    mountApp();
    await screen.findByRole('tree');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('Apply / OK / Cancel', () => {
  it('Apply is disabled until something changes, then persists and keeps the dialog open', async () => {
    const { backend } = mountApp();
    const dialog = await open();
    expect(button(dialog, 'Apply').disabled).toBe(true);

    fireEvent.click(within(dialog).getByText('SSH'));
    const keepalive = within(dialog).getByLabelText(/Keepalive interval/) as HTMLInputElement;
    fireEvent.change(keepalive, { target: { value: '77' } });
    expect(button(dialog, 'Apply').disabled).toBe(false);
    expect(backend.saves).toHaveLength(0); // nothing persisted yet

    fireEvent.click(button(dialog, 'Apply'));
    await waitFor(() => expect(backend.saves).toHaveLength(1));
    expect(lastSaved(backend)!.ssh.keepaliveSecs).toBe(77);
    expect(screen.getByRole('dialog')).toBeTruthy(); // still open
    await waitFor(() => expect(button(dialog, 'Apply').disabled).toBe(true));
  });

  it('OK saves and closes; OK without changes just closes', async () => {
    const { backend } = mountApp();
    let dialog = await open();
    fireEvent.click(button(dialog, 'OK'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(backend.saves).toHaveLength(0);

    dialog = await open();
    fireEvent.click(within(dialog).getByText('SSH'));
    fireEvent.change(within(dialog).getByLabelText(/Keepalive interval/), {
      target: { value: '12' },
    });
    fireEvent.click(button(dialog, 'OK'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(lastSaved(backend)!.ssh.keepaliveSecs).toBe(12);
  });

  it('Cancel discards unapplied changes and removes the live theme preview', async () => {
    const { backend } = mountApp();
    const dialog = await open();
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(within(dialog).getByText('Appearance'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Light' }));
    // live preview while editing...
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(backend.saves).toHaveLength(0);
    fireEvent.click(button(dialog, 'Cancel'));
    // ...reverted on Cancel, and nothing was written
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(backend.saves).toHaveLength(0);

    const again = await open();
    fireEvent.click(within(again).getByText('Appearance'));
    expect(within(again).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('Apply keeps the preview and the saved theme in agreement', async () => {
    const { backend } = mountApp();
    const dialog = await open();
    fireEvent.click(within(dialog).getByText('Appearance'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Light' }));
    fireEvent.click(button(dialog, 'Apply'));
    await waitFor(() => expect(lastSaved(backend)?.appearance.theme).toBe('light'));
    fireEvent.click(button(dialog, 'Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.documentElement.dataset.theme).toBe('light'); // persisted, so it stays
  });

  it('Escape closes like Cancel and the backdrop never discards edits', async () => {
    const { backend } = mountApp();
    const dialog = await open();
    fireEvent.click(within(dialog).getByText('SSH'));
    fireEvent.change(within(dialog).getByLabelText(/Keepalive interval/), {
      target: { value: '5' },
    });
    fireEvent.mouseDown(dialog.parentElement!); // backdrop click must not discard edits
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(backend.saves).toHaveLength(0);
  });

  it('marks settings that need a restart', async () => {
    mountApp();
    const dialog = await open();
    const field = within(dialog).getByText('Interface language').closest('label')!;
    expect(field.textContent).toMatch(/restarting PeachTerm/);
  });
});
