// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import { mountApp } from '../../test/appHarness';

async function openAbout() {
  const mounted = mountApp({ connections: [] });
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'About' }));
  return { dialog, ssh };
}

describe('Settings → About', () => {
  it('names the author, the version and the license', async () => {
    const { dialog } = await openAbout();
    expect(within(dialog).getByText('Created by Bakhti Baymukhamedov.')).toBeTruthy();
    await waitFor(() =>
      expect(within(dialog).getByTestId('about-version').textContent).not.toBe(''),
    );
    expect(within(dialog).getByRole('link', { name: 'Apache-2.0' })).toBeTruthy();
    expect(dialog.textContent).toContain('Copyright 2026 Bakhti Baymukhamedov');
  });

  it('links to GitHub and Telegram and opens them through the fixed link list', async () => {
    const { dialog, ssh } = await openAbout();
    const github = within(dialog).getByRole('link', { name: 'https://github.com/endlessnights' });
    const telegram = within(dialog).getByRole('link', { name: 'https://t.me/pycarrot2' });
    expect(github.getAttribute('href')).toBe('https://github.com/endlessnights');
    expect(telegram.getAttribute('href')).toBe('https://t.me/pycarrot2');
    fireEvent.click(github);
    fireEvent.click(telegram);
    fireEvent.click(within(dialog).getByRole('link', { name: 'Open-source license notices' }));
    await waitFor(() => expect(ssh.links).toEqual(['github', 'telegram', 'notices']));
  });

  it('keeps the author out of the workspace, sidebar and status bar', async () => {
    await openAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    for (const selector of ['.statusbar', '.sidebar', '.workspace']) {
      expect(document.querySelector(selector)?.textContent ?? '').not.toContain('Baymukhamedov');
    }
  });
});
