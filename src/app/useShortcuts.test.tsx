// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { __setBackendForTests } from '../shared/ipc';
import { useTabs } from '../features/sessions/store';
import { conn, mountApp, press } from '../test/appHarness';
import { buildTable } from './useShortcuts';

afterEach(() => __setBackendForTests(null));

const ready = async () => screen.findByRole('tree');

describe('global shortcuts', () => {
  it('Ctrl+N opens the new-connection editor', async () => {
    mountApp();
    await ready();
    act(() => {
      press({ code: 'KeyN', key: 'n', ctrlKey: true });
    });
    expect(await screen.findByRole('dialog', { name: 'New connection' })).toBeTruthy();
  });

  it('Ctrl+, opens Settings', async () => {
    mountApp();
    await ready();
    act(() => {
      press({ code: 'Comma', key: ',', ctrlKey: true });
    });
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('Ctrl+B hides and shows the sidebar', async () => {
    mountApp();
    await ready();
    act(() => {
      press({ code: 'KeyB', key: 'b', ctrlKey: true });
    });
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());
    act(() => {
      press({ code: 'KeyB', key: 'b', ctrlKey: true });
    });
    expect(await screen.findByRole('tree')).toBeTruthy();
  });

  it('Ctrl+Shift+F focuses the connection search', async () => {
    mountApp();
    await ready();
    act(() => {
      press({ code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(document.activeElement?.id).toBe('sidebar-search'));
  });

  it('Ctrl+T opens another session for the active tab; Ctrl+W closes the active tab', async () => {
    mountApp({ connections: [conn('a', 'alpha')] });
    await ready();
    await screen.findByText('alpha');
    act(() => {
      useTabs.getState().openTab(conn('a', 'alpha'));
    });
    expect(useTabs.getState().tabs).toHaveLength(1);
    act(() => {
      press({ code: 'KeyT', key: 't', ctrlKey: true });
    });
    expect(useTabs.getState().tabs).toHaveLength(2);
    act(() => {
      press({ code: 'KeyW', key: 'w', ctrlKey: true });
    });
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('works on non-Latin keyboard layouts (matches the physical key)', async () => {
    mountApp();
    await ready();
    act(() => {
      press({ code: 'KeyN', key: 'т', ctrlKey: true }); // Russian layout
    });
    expect(await screen.findByRole('dialog', { name: 'New connection' })).toBeTruthy();
  });

  it('ignores held-down auto-repeat so tabs cannot be closed in a burst', async () => {
    mountApp();
    await ready();
    act(() => {
      useTabs.getState().openTab(conn('a', 'alpha'));
      useTabs.getState().openTab(conn('b', 'beta'));
    });
    act(() => {
      press({ code: 'KeyW', key: 'w', ctrlKey: true, repeat: true });
    });
    expect(useTabs.getState().tabs).toHaveLength(2);
  });

  it('does not run app shortcuts while a dialog is open', async () => {
    mountApp();
    await ready();
    act(() => {
      press({ code: 'KeyN', key: 'n', ctrlKey: true });
    });
    await screen.findByRole('dialog');
    act(() => {
      press({ code: 'Comma', key: ',', ctrlKey: true });
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});

describe('terminal input is preserved', () => {
  const terminal = () => {
    const el = document.createElement('textarea');
    el.setAttribute('data-terminal', '');
    document.body.appendChild(el);
    return el;
  };

  it('bare Ctrl+letter is left to the terminal; Ctrl+Shift+letter still reaches the app', async () => {
    mountApp();
    await ready();
    act(() => {
      useTabs.getState().openTab(conn('a', 'alpha'));
    });
    const term = terminal();
    let e!: KeyboardEvent;
    act(() => {
      e = press({ code: 'KeyW', key: 'w', ctrlKey: true }, term);
    });
    expect(e.defaultPrevented).toBe(false); // the shell gets Ctrl+W
    expect(useTabs.getState().tabs).toHaveLength(1);
    act(() => {
      e = press({ code: 'KeyW', key: 'W', ctrlKey: true, shiftKey: true }, term);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(useTabs.getState().tabs).toHaveLength(0);
    term.remove();
  });

  it('F2 and the tmux prefix Ctrl+B are not intercepted while a terminal has focus', async () => {
    mountApp();
    await ready();
    const term = terminal();
    let e!: KeyboardEvent;
    act(() => {
      e = press({ code: 'F2', key: 'F2' }, term);
    });
    expect(e.defaultPrevented).toBe(false);
    act(() => {
      e = press({ code: 'KeyB', key: 'b', ctrlKey: true }, term);
    });
    expect(e.defaultPrevented).toBe(false);
    term.remove();
  });
});

describe('web view defaults', () => {
  it('reload, print, find and developer-tool shortcuts are suppressed', async () => {
    mountApp();
    await ready();
    for (const init of [
      { code: 'F5', key: 'F5' },
      { code: 'KeyR', key: 'r', ctrlKey: true },
      { code: 'KeyP', key: 'p', ctrlKey: true },
      { code: 'KeyF', key: 'f', ctrlKey: true },
      { code: 'F12', key: 'F12' },
    ]) {
      let e!: KeyboardEvent;
      act(() => {
        e = press(init);
      });
      expect(e.defaultPrevented, init.code).toBe(true);
    }
  });
});

describe('lookup table', () => {
  it('adds Ctrl+Shift aliases for terminal-owned bindings and never shadows taken ones', () => {
    const table = buildTable({});
    const alias = table.filter((t) => t.alias).map((t) => `${t.id}:${t.combo.key}`);
    expect(alias).toEqual(
      expect.arrayContaining(['newTab:T', 'closeTab:W', 'toggleSidebar:B', 'newConnection:N']),
    );
    // Ctrl+Shift+F is already "search connections".
    expect(table.filter((t) => t.combo.key === 'F' && t.combo.shift)).toHaveLength(1);
  });

  it('an unassigned action has no entry', () => {
    expect(buildTable({ lockApp: '' }).some((t) => t.id === 'lockApp')).toBe(false);
  });
});
