// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { openSettings } from '../../app/dialogs';
import { __setBackendForTests } from '../../shared/ipc';
import { conn, mountApp, press } from '../../test/appHarness';
import { useTabs } from '../sessions/store';
import { useLock } from './store';

afterEach(() => __setBackendForTests(null));

const PASSWORD = 'correct horse';
const seed = { connections: [conn('a', 'alpha'), conn('b', 'bravo')] };
const unlockWith = async (password: string) => {
  const input = await screen.findByLabelText('Lock password');
  fireEvent.change(input, { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock PeachTerm' }));
};

describe('lock is off by default', () => {
  it('shows no lock button and guides the user to set a password instead of a fake lock', async () => {
    mountApp(seed);
    await screen.findByRole('tree');
    expect(screen.queryByRole('button', { name: 'Lock PeachTerm' })).toBeNull();
    act(() => {
      press({ code: 'KeyL', key: 'L', ctrlKey: true, shiftKey: true });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByText('Application lock')).toBeTruthy();
    expect(useLock.getState().view?.locked).toBe(false); // nothing was "locked"
  });

  it('guided setup validates the password, then Apply turns the lock on and shows the button', async () => {
    const { backend } = mountApp(seed);
    await screen.findByRole('tree');
    act(() => openSettings('security'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(dialog).getByLabelText('Enable application lock'));
    const setup = await screen.findByRole('dialog', { name: 'Set lock password' });
    const [first, second] = within(setup).getAllByDisplayValue('') as HTMLInputElement[];
    fireEvent.change(first!, { target: { value: 'short' } });
    fireEvent.click(within(setup).getByRole('button', { name: 'Save password' }));
    expect((await within(setup).findByRole('alert')).textContent).toMatch(/at least 8/);
    fireEvent.change(first!, { target: { value: PASSWORD } });
    fireEvent.change(second!, { target: { value: 'something else' } });
    fireEvent.click(within(setup).getByRole('button', { name: 'Save password' }));
    expect((await within(setup).findByRole('alert')).textContent).toMatch(/do not match/);
    fireEvent.change(second!, { target: { value: PASSWORD } });
    fireEvent.click(within(setup).getByRole('button', { name: 'Save password' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Set lock password' })).toBeNull(),
    );

    // the password exists now, but the lock only turns on with Apply
    expect(useLock.getState().view).toMatchObject({ configured: true, enabled: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(backend.saves!.at(-1)!.security.appLock.enabled).toBe(true));
    await waitFor(() => expect(useLock.getState().view?.enabled).toBe(true));
    const button = await screen.findAllByRole('button', { name: 'Lock PeachTerm' });
    expect(button[0]!.getAttribute('title')).toMatch(/^Lock PeachTerm \(Ctrl\+Shift\+L\)$/);
  });

  it('the backend refuses to enable the lock without a password', async () => {
    const { backend } = mountApp(seed);
    await screen.findByRole('tree');
    const settings = structuredClone(
      (await import('../settings/store')).useSettings.getState().settings,
    );
    settings.security.appLock.enabled = true;
    await expect(
      (await import('../../shared/ipc')).ipc.settingsSave(settings),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(backend.saves).toHaveLength(0);
  });
});

describe('locking', () => {
  const lockedApp = async () => {
    const view = mountApp(seed, { lockPassword: PASSWORD, lockEnabled: true });
    await screen.findByText('alpha');
    return view;
  };

  it('the sidebar button and the shortcut lock immediately; the screen hides everything', async () => {
    await lockedApp();
    act(() => useTabs.getState().openTab(conn('a', 'alpha')));
    fireEvent.click(screen.getAllByRole('button', { name: 'Lock PeachTerm' })[0]!);
    const screen_ = await screen.findByRole('dialog', { name: 'PeachTerm is locked' });
    expect(within(screen_).getByRole('button', { name: 'Unlock PeachTerm' })).toBeTruthy();
    const app = document.querySelector('.app')!;
    expect(app.hasAttribute('inert')).toBe(true);
    expect(app.getAttribute('aria-hidden')).toBe('true');
    // nothing about connections or tabs is exposed to assistive tech or focus
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText('alpha', { ignore: '.app *' })).toBeNull();
    // the open tab itself is preserved
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('Ctrl+Shift+L locks, and while locked no shortcut does anything', async () => {
    await lockedApp();
    act(() => {
      press({ code: 'KeyL', key: 'L', ctrlKey: true, shiftKey: true });
    });
    await screen.findByRole('dialog', { name: 'PeachTerm is locked' });
    act(() => {
      press({ code: 'KeyN', key: 'n', ctrlKey: true });
      press({ code: 'Comma', key: ',', ctrlKey: true });
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('closes open dialogs when it locks, and Escape cannot dismiss the lock screen', async () => {
    await lockedApp();
    act(() => openSettings('general'));
    await screen.findByRole('dialog', { name: 'Settings' });
    await act(async () => {
      await useLock.getState().lockNow();
    });
    await screen.findByRole('dialog', { name: 'PeachTerm is locked' });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(document.body);
    expect(screen.getByRole('dialog', { name: 'PeachTerm is locked' })).toBeTruthy();
  });

  it('a wrong password keeps it locked; the right one restores the workspace and tabs', async () => {
    await lockedApp();
    act(() => useTabs.getState().openTab(conn('b', 'bravo')));
    await act(async () => {
      await useLock.getState().lockNow();
    });
    await unlockWith('not the password');
    expect(await screen.findByText(/Wrong password/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'PeachTerm is locked' })).toBeTruthy();
    await unlockWith(PASSWORD);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'PeachTerm is locked' })).toBeNull(),
    );
    expect(await screen.findByRole('tree')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(document.querySelector('.app')!.hasAttribute('inert')).toBe(false);
  });

  it('repeated wrong passwords trigger a visible delay', async () => {
    await lockedApp();
    await act(async () => {
      await useLock.getState().lockNow();
    });
    for (let i = 0; i < 3; i++) {
      await unlockWith('nope-' + i);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Unlock PeachTerm' })).toBeTruthy(),
      );
    }
    expect(await screen.findByText(/Try again in/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Unlock PeachTerm' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('started locked (after a restart)', () => {
  it('loads nothing until unlocked and never shows connection data on the lock screen', async () => {
    const { backend } = mountApp(seed, { lockPassword: PASSWORD, startLocked: true });
    await screen.findByRole('dialog', { name: 'PeachTerm is locked' });
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.queryByText('bravo')).toBeNull();
    // the backend itself refuses data while locked
    await expect(backend('connections_load')).rejects.toMatchObject({ code: 'locked' });
    await expect(backend('settings_load')).rejects.toMatchObject({ code: 'locked' });
    await expect(backend('credentials_status')).rejects.toMatchObject({ code: 'locked' });
    await expect(backend('logging_status')).rejects.toMatchObject({ code: 'locked' });

    await unlockWith(PASSWORD);
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'PeachTerm is locked' })).toBeNull();
  });
});

describe('inactivity', () => {
  it('reports user activity to the backend timer only while the inactivity lock is on', async () => {
    const calls: string[] = [];
    mountApp(seed, { lockPassword: PASSWORD, lockEnabled: true }, (b) => {
      const wrapped = (async (command: string, args?: Record<string, unknown>) => {
        calls.push(command);
        return b(command, args);
      }) as typeof b;
      return Object.assign(wrapped, { saves: b.saves });
    });
    await screen.findByText('alpha');
    expect(calls).not.toContain('lock_touch'); // interval is "never"
  });
});
