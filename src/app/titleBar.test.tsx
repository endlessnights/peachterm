// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { __setBackendForTests } from '../shared/ipc';
import { TITLE_BAR_PALETTE, toHex } from '../shared/titleBar';
import { openSettings } from './dialogs';
import { mountApp } from '../test/appHarness';

afterEach(() => __setBackendForTests(null));

interface ThemeCall {
  theme: string;
  caption: string;
  text: string;
  border: string;
}

/** Backend wrapper that records every window_apply_theme call. */
const recorder = () => {
  const calls: ThemeCall[] = [];
  const wrap = (backend: ReturnType<typeof import('../shared/mockBackend').createMockBackend>) => {
    const wrapped = (async (command: string, args?: Record<string, unknown>) => {
      if (command === 'window_apply_theme') calls.push(args as unknown as ThemeCall);
      return backend(command, args);
    }) as typeof backend;
    return Object.assign(wrapped, { saves: backend.saves });
  };
  return { calls, wrap };
};

describe('palette', () => {
  it('equals the CSS theme tokens it mirrors', () => {
    const css = readFileSync('src/styles/theme.css', 'utf8');
    const light = css.indexOf(":root[data-theme='light'] {");
    const olive = css.indexOf(":root[data-theme='olive'] {");
    const blocks = {
      dark: css.slice(0, light),
      light: css.slice(light, olive),
      olive: css.slice(olive),
    };
    for (const theme of ['dark', 'light', 'olive'] as const) {
      const p = TITLE_BAR_PALETTE[theme];
      expect(blocks[theme]).toContain(`--surface-1: ${p.caption}`);
      expect(blocks[theme]).toContain(`--text-1: ${p.text}`);
      expect(blocks[theme]).toContain(`--line: ${p.border}`);
    }
  });

  it('normalises computed colours', () => {
    expect(toHex('#AABBCC')).toBe('#aabbcc');
    expect(toHex('rgb(24, 24, 23)')).toBe('#181817');
    expect(toHex('rgba(255, 0, 16, 0.5)')).toBe('#ff0010');
    expect(toHex('')).toBeNull();
    expect(toHex('red')).toBeNull();
  });
});

describe('native title bar follows the theme', () => {
  it('is coloured for the dark theme at start-up', async () => {
    const { calls, wrap } = recorder();
    mountApp(undefined, {}, wrap);
    await screen.findByRole('tree');
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toEqual({ theme: 'dark', ...TITLE_BAR_PALETTE.dark });
  });

  it('previews a theme change while Settings is open and restores it on Cancel', async () => {
    const { calls, wrap } = recorder();
    mountApp(undefined, {}, wrap);
    await screen.findByRole('tree');
    act(() => openSettings('appearance'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Light' }));
    await waitFor(() => expect(calls.at(-1)?.theme).toBe('light'));
    expect(calls.at(-1)).toEqual({ theme: 'light', ...TITLE_BAR_PALETTE.light });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.at(-1)?.theme).toBe('dark'));
    expect(calls.at(-1)).toEqual({ theme: 'dark', ...TITLE_BAR_PALETTE.dark });
  });

  it('keeps the light title bar after Apply', async () => {
    const { calls, wrap } = recorder();
    const { backend } = mountApp(undefined, {}, wrap);
    await screen.findByRole('tree');
    act(() => openSettings('appearance'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Light' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(backend.saves!.at(-1)!.appearance.theme).toBe('light');
    expect(calls.at(-1)?.theme).toBe('light');
  });

  it('does not repeat identical requests', async () => {
    const { calls, wrap } = recorder();
    mountApp(undefined, {}, wrap);
    await screen.findByRole('tree');
    act(() => openSettings('appearance'));
    const dialog = await screen.findByRole('dialog');
    const before = calls.length;
    // changing only the accent re-runs the theme effect but yields the same colours
    fireEvent.click(within(dialog).getByRole('button', { name: 'teal' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(before);
  });

  it('follows the operating-system theme when set to "System"', async () => {
    let light = true;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes('light') ? light : false;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })) as unknown as typeof window.matchMedia;
    const { calls, wrap } = recorder();
    mountApp(undefined, {}, wrap);
    await screen.findByRole('tree');
    act(() => openSettings('appearance'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'System' }));
    await waitFor(() => expect(calls.at(-1)?.theme).toBe('light'));
    light = false;
    act(() => listeners.forEach((l) => l()));
    await waitFor(() => expect(calls.at(-1)?.theme).toBe('dark'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });
});
