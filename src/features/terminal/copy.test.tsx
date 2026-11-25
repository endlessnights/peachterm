// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import type { Settings } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { useLock } from '../lock/store';
import { useSettings } from '../settings/store';
import { useTabs } from '../sessions/store';

const writes: string[] = [];
beforeEach(() => {
  writes.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (t: string) => void writes.push(t)),
      readText: vi.fn(async () => 'PASTED'),
    },
  });
});
afterEach(() => vi.restoreAllMocks());

async function open(mode?: 'selection' | 'rightClick') {
  const mounted = mountApp(
    { connections: [conn('a', 'alpha'), conn('b', 'beta')] },
    mode
      ? { settings: (s: Settings) => ({ ...s, terminal: { ...s.terminal, copyMode: mode } }) }
      : {},
  );
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByText('alpha');
  fireEvent.doubleClick(screen.getByText('alpha'));
  await waitFor(() => expect(ssh.opens).toHaveLength(1));
  await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
  return { ...mounted, ssh, host: document.querySelector('.terminal-host')! };
}

/** A selection made with the mouse: press, (xterm selects), release. */
async function drag(text: string, host: Element, term = fakeTerminals[0]!) {
  fireEvent.mouseDown(host, { button: 0 });
  act(() => term.select(text));
  fireEvent.mouseUp(document.body, { button: 0 });
  await new Promise((r) => setTimeout(r, 5));
}

describe('copy on selection (the default)', () => {
  it('is the default for new settings and for old files without the field', async () => {
    await open();
    expect(useSettings.getState().settings.terminal.copyMode).toBe('selection');
  });

  it('copies once, when the mouse is released, not while the selection grows', async () => {
    const { host } = await open();
    const term = fakeTerminals[0]!;
    fireEvent.mouseDown(host, { button: 0 });
    act(() => term.select('he'));
    act(() => term.select('hello'));
    act(() => term.select('hello world'));
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual([]); // still dragging
    fireEvent.mouseUp(document.body, { button: 0 });
    await waitFor(() => expect(writes).toEqual(['hello world']));
  });

  it('copies a double-click word and a triple-click line', async () => {
    const { host } = await open();
    await drag('word', host);
    await drag('the whole line with spaces', host);
    expect(writes).toEqual(['word', 'the whole line with spaces']);
  });

  it('keeps multiline text and Unicode exactly', async () => {
    const { host } = await open();
    await drag('строка 1\nzeile 2 — ü ß 日本\n', host);
    expect(writes).toEqual(['строка 1\nzeile 2 — ü ß 日本\n']);
  });

  it('never copies an empty selection, and clearing a selection leaves the clipboard alone', async () => {
    const { host } = await open();
    await drag('keep', host);
    expect(writes).toEqual(['keep']);
    const term = fakeTerminals[0]!;
    fireEvent.mouseDown(host, { button: 0 });
    act(() => term.clearSelection());
    fireEvent.mouseUp(document.body, { button: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual(['keep']);
  });

  it('a plain click on an old selection, a resize or a tab switch do not copy again', async () => {
    const { host, ssh } = await open();
    const term = fakeTerminals[0]!;
    await drag('once', host);
    fireEvent.mouseDown(host, { button: 0 });
    fireEvent.mouseUp(document.body, { button: 0 }); // a click that selects nothing new
    act(() => term.resize(100, 30));
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual(['once']);
    expect(ssh.writes).toEqual([]); // nothing was typed into the session either
  });

  it('only the primary button and a press that started in the terminal count', async () => {
    const { host } = await open();
    const term = fakeTerminals[0]!;
    act(() => term.select('elsewhere'));
    fireEvent.mouseUp(document.body, { button: 0 }); // no press in the terminal
    fireEvent.mouseDown(host, { button: 2 });
    fireEvent.mouseUp(document.body, { button: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual([]);
  });

  it('a right click pastes (and never sends the clipboard text unasked)', async () => {
    const { host } = await open();
    const term = fakeTerminals[0]!;
    await drag('copied', host);
    fireEvent.contextMenu(host);
    await waitFor(() => expect(term.pasted).toEqual(['PASTED']));
    expect(writes).toEqual(['copied']); // no second write
  });

  it('does not copy while the application is locked', async () => {
    const { host } = await open();
    act(() => useLock.getState().setLocked(true));
    await drag('secret', host);
    expect(writes).toEqual([]);
  });

  it('the keyboard copy shortcut still works', async () => {
    await open();
    // handled by xterm's custom key handler; the explicit action stays independent of the mode
    expect(useSettings.getState().settings.terminal.copyMode).toBe('selection');
  });
});

describe('copy on right-click', () => {
  it('copies on the right click, once, and does not copy on selection', async () => {
    const { host } = await open('rightClick');
    const term = fakeTerminals[0]!;
    await drag('selected text', host);
    expect(writes).toEqual([]);
    fireEvent.contextMenu(host);
    await waitFor(() => expect(writes).toEqual(['selected text']));
    expect(term.pasted).toEqual([]);
  });

  it('pastes on a right click when nothing is selected', async () => {
    const { host } = await open('rightClick');
    fireEvent.contextMenu(host);
    await waitFor(() => expect(fakeTerminals[0]!.pasted).toEqual(['PASTED']));
    expect(writes).toEqual([]);
  });
});

describe('changing the mode', () => {
  it('applies immediately: no reconnect, same session and terminal', async () => {
    const { host, ssh } = await open('rightClick');
    const term = fakeTerminals[0]!;
    await drag('before', host);
    expect(writes).toEqual([]);
    await act(async () => {
      const cur = useSettings.getState().settings;
      await useSettings
        .getState()
        .save({ ...cur, terminal: { ...cur.terminal, copyMode: 'selection' } });
    });
    await drag('after', host);
    expect(writes).toEqual(['after']);
    expect(ssh.opens).toHaveLength(1);
    expect(ssh.closes).toEqual([]);
    expect(fakeTerminals[0]).toBe(term);
  });

  it('each tab and split pane copies on its own selection', async () => {
    const { ssh } = await open();
    fireEvent.doubleClick(screen.getByText('beta'));
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
    await waitFor(() => expect(fakeTerminals).toHaveLength(2));
    const hosts = [...document.querySelectorAll('.terminal-host')];
    await drag('from second', hosts[hosts.length - 1]!, fakeTerminals[1]!);
    await drag('from first', hosts[0]!, fakeTerminals[0]!);
    expect(writes).toEqual(['from second', 'from first']);
  });
});
