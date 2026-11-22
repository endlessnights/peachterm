// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { openSettings, useDialogs } from '../../app/dialogs';
import { __setBackendForTests } from '../../shared/ipc';
import { lastSaved, mountApp, press } from '../../test/appHarness';
import { useConnections } from '../connections/store';
import { useSettings } from './store';

afterEach(() => __setBackendForTests(null));

const openShortcuts = async () => {
  await screen.findByRole('tree');
  act(() => openSettings('shortcuts'));
  return screen.findByRole('dialog');
};
const row = (dialog: HTMLElement, action: string) =>
  dialog.querySelector(`tr[data-action="${action}"]`) as HTMLElement;
const record = (dialog: HTMLElement, action: string, init: KeyboardEventInit) => {
  fireEvent.click(within(row(dialog, action)).getByText('Record'));
  act(() => {
    press(init, document.body);
  });
};
const apply = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement;

describe('Settings → Keyboard Shortcuts', () => {
  it('lists every action with its default shortcut', async () => {
    mountApp();
    const dialog = await openShortcuts();
    expect(within(row(dialog, 'newTab')).getByText('Ctrl+T')).toBeTruthy();
    expect(within(row(dialog, 'lockApp')).getByText('Ctrl+Shift+L')).toBeTruthy();
    expect(within(row(dialog, 'rename')).getByText('F2')).toBeTruthy();
    expect(within(row(dialog, 'searchConnections')).getByText('Ctrl+Shift+F')).toBeTruthy();
  });

  it('records a new shortcut, persists it on Apply and restores the default on Reset', async () => {
    const { backend } = mountApp();
    const dialog = await openShortcuts();
    record(dialog, 'lockApp', { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true });
    expect(within(row(dialog, 'lockApp')).getByText('Ctrl+Shift+K')).toBeTruthy();
    expect(backend.saves).toHaveLength(0);
    fireEvent.click(apply(dialog));
    await waitFor(() => expect(lastSaved(backend)!.shortcuts).toEqual({ lockApp: 'Mod+Shift+K' }));

    fireEvent.click(within(row(dialog, 'lockApp')).getByText('Reset'));
    expect(within(row(dialog, 'lockApp')).getByText('Ctrl+Shift+L')).toBeTruthy();
    fireEvent.click(apply(dialog));
    await waitFor(() => expect(lastSaved(backend)!.shortcuts).toEqual({}));
  });

  it('shows conflicts before saving and blocks Apply/OK until resolved', async () => {
    const { backend } = mountApp();
    const dialog = await openShortcuts();
    record(dialog, 'closeTab', { code: 'KeyT', key: 't', ctrlKey: true });
    const message = within(row(dialog, 'closeTab')).getByRole('alert');
    expect(message.textContent).toMatch(/Already used by “New terminal tab”/);
    expect(apply(dialog).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // The suggested alternative resolves the conflict.
    fireEvent.click(within(message).getByText(/Use Ctrl\+Shift\+T instead/));
    expect(within(row(dialog, 'closeTab')).queryByRole('alert')).toBeNull();
    expect(apply(dialog).disabled).toBe(false);
    expect(backend.saves).toHaveLength(0);
  });

  it('refuses reserved combinations and keys without a modifier', async () => {
    mountApp();
    const dialog = await openShortcuts();
    record(dialog, 'lockApp', { code: 'F5', key: 'F5' });
    expect(within(row(dialog, 'lockApp')).getByRole('alert').textContent).toMatch(/Reserved/);
    fireEvent.click(within(row(dialog, 'lockApp')).getByText('Reset'));

    fireEvent.click(within(row(dialog, 'rename')).getByText('Record'));
    act(() => {
      press({ code: 'KeyQ', key: 'q' });
    });
    expect(within(dialog).getByText(/needs at least one modifier/)).toBeTruthy();
    // still recording: Escape cancels without changing anything
    act(() => {
      press({ code: 'Escape', key: 'Escape' });
    });
    expect(within(row(dialog, 'rename')).getByText('F2')).toBeTruthy();
  });

  it('can unassign with Backspace and explains that terminals own bare Ctrl keys', async () => {
    mountApp();
    const dialog = await openShortcuts();
    expect(within(row(dialog, 'closeTab')).getByText(/only works outside terminals/)).toBeTruthy();
    expect(within(row(dialog, 'closeTab')).getByText(/Ctrl\+Shift\+W/)).toBeTruthy();
    fireEvent.click(within(row(dialog, 'nextTab')).getByText('Record'));
    act(() => {
      press({ code: 'Backspace', key: 'Backspace' });
    });
    expect(within(row(dialog, 'nextTab')).getByText('Not set')).toBeTruthy();
  });

  it('Restore all defaults clears every override', async () => {
    mountApp();
    const dialog = await openShortcuts();
    record(dialog, 'lockApp', { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true });
    record(dialog, 'openSettings', { code: 'KeyO', key: 'o', ctrlKey: true, altKey: true });
    fireEvent.click(within(dialog).getByText('Restore all defaults'));
    expect(within(row(dialog, 'lockApp')).getByText('Ctrl+Shift+L')).toBeTruthy();
    expect(within(row(dialog, 'openSettings')).getByText('Ctrl+,')).toBeTruthy();
    expect(apply(dialog).disabled).toBe(true); // back to pristine
  });

  it('documents the reserved shortcuts', async () => {
    mountApp();
    const dialog = await openShortcuts();
    expect(within(dialog).getByText('Show the reserved list')).toBeTruthy();
    expect(within(dialog).getAllByText(/reloads the web view/).length).toBeGreaterThan(0);
  });

  it('a customised shortcut is used after a restart', async () => {
    const { backend, unmount } = mountApp();
    const dialog = await openShortcuts();
    record(dialog, 'newConnection', { code: 'KeyY', key: 'y', ctrlKey: true, shiftKey: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(lastSaved(backend)!.shortcuts.newConnection).toBe('Mod+Shift+Y');
    unmount();

    // Remount against the same backend: settings are loaded from "disk".
    useDialogs.setState({ dialog: null });
    useConnections.setState({ loaded: false });
    useSettings.setState({
      loaded: false,
      settings: { ...useSettings.getState().settings, shortcuts: {} },
    });
    render(<App />);
    await screen.findByRole('tree');
    act(() => {
      press({ code: 'KeyY', key: 'Y', ctrlKey: true, shiftKey: true });
    });
    expect(await screen.findByRole('dialog', { name: 'New connection' })).toBeTruthy();
    // the old default no longer triggers it
    act(() => useDialogs.setState({ dialog: null }));
    act(() => {
      press({ code: 'KeyN', key: 'n', ctrlKey: true });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
