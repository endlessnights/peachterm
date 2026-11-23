// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runAction } from '../../app/commands';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { useDrag } from './dragStore';
import { MAX_LEAVES, countLeaves, findLeafByTab, leaves, place, validate } from './layout';
import { useTabs } from './store';

const seed = () => ({
  connections: [conn('a', 'alpha'), conn('b', 'beta', { username: 'ops' })],
});

async function mount() {
  const mounted = mountApp(seed());
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  act(() => useTabs.getState().setArea(3000, 1800)); // an ultrawide, high-resolution workspace
  const open = async (name: string) => {
    const before = ssh.opens.length;
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText(name));
    await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
  };
  return { ...mounted, ssh, open };
}

const layout = () => useTabs.getState().layout;
const panes = () => document.querySelectorAll<HTMLElement>('.terminal-pane:not([hidden])');
const sessionsReady = () =>
  waitFor(() => expect(useTabs.getState().tabs.every((t) => t.sessionId !== null)).toBe(true));
const picker = () => screen.findByRole('group', { name: /Choose what to show/ });
const newSession = async () =>
  fireEvent.click(within(await picker()).getByRole('button', { name: /New session/ }));
const shown = () =>
  leaves(layout()!)
    .map((l) => l.tabId)
    .filter(Boolean);

/** Split the focused pane and start a new session in the new pane. */
async function splitWithNew(orientation: 'splitVertical' | 'splitHorizontal', ssh: MockSsh) {
  const before = ssh.opens.length;
  act(() => runAction(orientation));
  await newSession();
  await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
}

describe('split view', () => {
  it('splits the active tab; the new pane can start a NEW session of the same connection', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    expect(layout()!.kind).toBe('branch');
    expect(leaves(layout()!).map((l) => l.tabId)).toEqual([useTabs.getState().tabs[0]!.id, null]);
    expect(ssh.opens).toHaveLength(1);
    await newSession();
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
    const tabs = useTabs.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.connectionId).toBe(tabs[1]!.connectionId);
    expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
    expect(ssh.opens[0]!.sessionId).not.toBe(ssh.opens[1]!.sessionId);
    expect(panes()).toHaveLength(2);
    expect(validate(layout())).toEqual([]);
    expect(useTabs.getState().activeId).toBe(tabs[1]!.id); // the new pane has the focus
  });

  it('builds 3, 4, 5 and 6 panes in mixed layouts and refuses the seventh without closing anything', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const orientations = [
      'splitVertical',
      'splitHorizontal',
      'splitVertical',
      'splitHorizontal',
      'splitVertical',
    ] as const;
    for (const [i, o] of orientations.entries()) {
      await splitWithNew(o, ssh);
      expect(countLeaves(layout()!)).toBe(i + 2);
      expect(validate(layout())).toEqual([]);
    }
    expect(countLeaves(layout()!)).toBe(MAX_LEAVES);
    expect(panes()).toHaveLength(6);
    const dirs = new Set(place(layout()!).branches.map((b) => b.branch.dir));
    expect(dirs).toEqual(new Set(['row', 'column']));

    const sessionsBefore = ssh.opens.length;
    act(() => runAction('splitVertical'));
    expect(await screen.findByText(/at most 6 panes/)).toBeTruthy();
    expect(countLeaves(layout()!)).toBe(6);
    expect(ssh.opens).toHaveLength(sessionsBefore);
    expect(ssh.closes).toEqual([]);
    expect(useTabs.getState().tabs).toHaveLength(6);
  });

  it('refuses a split that would make panes too small and explains why', async () => {
    const { open } = await mount();
    await open('alpha');
    act(() => useTabs.getState().setArea(500, 300));
    act(() => runAction('splitVertical')); // the first split is always possible
    await newSession();
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));
    act(() => runAction('splitVertical')); // 250 < 2 * 240 + 6: no room
    expect(await screen.findByText(/not enough room to split this pane/)).toBeTruthy();
    expect(countLeaves(layout()!)).toBe(2);
    act(() => runAction('splitHorizontal')); // 300 high: stacking still fits
    expect(countLeaves(layout()!)).toBe(3);
  });

  it('every pane keeps its own PTY size and input, also with 3 or more panes', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await splitWithNew('splitVertical', ssh);
    await splitWithNew('splitHorizontal', ssh);
    await sessionsReady();
    const tabs = useTabs.getState().tabs;
    expect(fakeTerminals).toHaveLength(3);
    const sizes: [number, number][] = [
      [60, 40],
      [61, 20],
      [61, 19],
    ];
    sizes.forEach(([c, r], i) => act(() => fakeTerminals[i]!.resize(c, r)));
    await waitFor(() => expect(ssh.resizes).toHaveLength(3));
    sizes.forEach(([cols, rows], i) =>
      expect(ssh.resizes).toContainEqual({ sessionId: tabs[i]!.sessionId, cols, rows }),
    );
    const focused = useTabs.getState().activeId;
    const focusedIndex = tabs.findIndex((t) => t.id === focused);
    act(() => fakeTerminals[focusedIndex]!.type('hello'));
    await waitFor(() => expect(ssh.writes).toHaveLength(1));
    expect(ssh.writes[0]).toEqual({ sessionId: tabs[focusedIndex]!.sessionId, text: 'hello' });
  });

  it('focus follows clicks and the focus-next command cycles through all panes', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await splitWithNew('splitVertical', ssh);
    await splitWithNew('splitHorizontal', ssh);
    const order = leaves(layout()!).map((l) => l.tabId!);
    const seen = [useTabs.getState().activeId!];
    for (let i = 0; i < 3; i += 1) {
      act(() => runAction('focusNextPane'));
      seen.push(useTabs.getState().activeId!);
    }
    expect(seen[3]).toBe(seen[0]); // a full cycle
    expect(new Set(seen.slice(0, 3))).toEqual(new Set(order));
    fireEvent.mouseDown(panes()[0]!);
    expect(useTabs.getState().focusLeaf).toBe(leaves(layout()!)[0]!.id);
  });

  it('toggling the orientation changes only the split around the focused pane', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await splitWithNew('splitVertical', ssh); // [a | b]
    await splitWithNew('splitHorizontal', ssh); // [a | b / c]
    const dirsOf = () =>
      place(layout()!)
        .branches.map((b) => b.branch.dir)
        .sort();
    expect(dirsOf()).toEqual(['column', 'row']);
    const terminals = fakeTerminals.slice();
    act(() => runAction('toggleSplitOrientation')); // flips the (b / c) split
    expect(dirsOf()).toEqual(['row', 'row']);
    expect(fakeTerminals).toEqual(terminals); // nothing was remounted
    expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true);
  });

  it("closing the split keeps every session; closing a pane's tab collapses only that pane", async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await splitWithNew('splitVertical', ssh);
    await splitWithNew('splitHorizontal', ssh);
    await sessionsReady();
    const [t0, t1, t2] = useTabs.getState().tabs;
    act(() => useTabs.getState().closeTab(t1!.id));
    expect(countLeaves(layout()!)).toBe(2);
    expect(shown()).toEqual([t0!.id, t2!.id]);
    await waitFor(() => expect(ssh.closes).toEqual([t1!.sessionId]));
    act(() => runAction('unsplit'));
    expect(layout()).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(ssh.closes).toHaveLength(1); // unsplitting closed nothing
    expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true);
  });

  it('cancelling the new pane leaves the sessions as they were', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(within(await picker()).getByRole('button', { name: 'Cancel' }));
    expect(layout()).toBeNull();
    expect(ssh.closes).toEqual([]);
    expect(panes()).toHaveLength(1);
  });

  it('a divider moves with the keyboard, stays within its limits and resets on double-click', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await splitWithNew('splitVertical', ssh);
    const ratio = () => (layout() as { ratio: number }).ratio;
    const divider = screen.getByRole('separator', { name: 'Resize split panes' });
    expect(ratio()).toBe(0.5);
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(ratio()).toBeCloseTo(0.52);
    for (let i = 0; i < 60; i += 1) fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(ratio()).toBeLessThanOrEqual(0.9);
    for (let i = 0; i < 80; i += 1) fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(ratio()).toBeGreaterThanOrEqual(0.1);
    fireEvent.doubleClick(divider);
    expect(ratio()).toBe(0.5);
    expect(divider.getAttribute('aria-valuenow')).toBe('50');
    // on a narrow workspace the limits keep both panes above their minimum width
    act(() => useTabs.getState().setArea(800, 600));
    for (let i = 0; i < 60; i += 1) fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(ratio() * 800).toBeGreaterThanOrEqual(240);
  });
});

describe('moving tabs between panes (drag-and-drop commands)', () => {
  async function three() {
    const m = await mount();
    await m.open('alpha');
    await m.open('beta');
    await m.open('alpha');
    await sessionsReady();
    const [a, b, c] = useTabs.getState().tabs;
    return { ...m, a: a!, b: b!, c: c! };
  }

  it('dropping a tab near an edge splits that side and MOVES the running session', async () => {
    const { ssh, a, b, c } = await three();
    const terminals = fakeTerminals.slice();
    act(() => useTabs.getState().activate(a.id));
    expect(useTabs.getState().dropTab(b.id, 'single', 'right')).toBe('ok');
    expect(shown()).toEqual([a.id, b.id]);
    expect(place(layout()!).branches[0]!.branch.dir).toBe('row');
    const paneA = findLeafByTab(layout()!, a.id)!;
    expect(useTabs.getState().dropTab(c.id, paneA.id, 'top')).toBe('ok');
    expect(shown()).toEqual([c.id, a.id, b.id]);
    expect(ssh.opens).toHaveLength(3);
    expect(ssh.closes).toEqual([]);
    expect(fakeTerminals).toEqual(terminals);
    expect(useTabs.getState().tabs.map((t) => t.sessionId)).toEqual(
      ssh.opens.map((o) => o.sessionId),
    );
    expect(validate(layout())).toEqual([]);
  });

  it('a session that is already visible moves instead of being shown twice', async () => {
    const { ssh, a, b, c } = await three();
    act(() => useTabs.getState().activate(a.id));
    useTabs.getState().dropTab(b.id, 'single', 'right'); // [a | b]
    useTabs.getState().dropTab(c.id, findLeafByTab(layout()!, b.id)!.id, 'bottom'); // [a | b / c]
    expect(shown()).toEqual([a.id, b.id, c.id]);
    const target = findLeafByTab(layout()!, a.id)!.id;
    expect(useTabs.getState().dropTab(c.id, target, 'left')).toBe('ok');
    expect(shown()).toEqual([c.id, a.id, b.id]);
    expect(new Set(shown()).size).toBe(3);
    await waitFor(() => expect(panes()).toHaveLength(3));
    expect(ssh.closes).toEqual([]);
    const before = layout();
    expect(useTabs.getState().dropTab(a.id, findLeafByTab(layout()!, a.id)!.id, 'left')).toBe(
      'none',
    );
    expect(layout()).toBe(before);
  });

  it('keeps the session state of moved tabs: titles, SFTP directory and connection', async () => {
    const { ssh, a, b } = await three();
    act(() => useTabs.getState().renameTab(b.id, 'prod db'));
    act(() => useTabs.getState().activate(b.id));
    fireEvent.doubleClick(await screen.findByRole('option', { name: /home/ }));
    await waitFor(() => expect(ssh.sftp.lists.at(-1)).toBe('/home'));
    const listsBefore = ssh.sftp.lists.length;
    act(() => useTabs.getState().activate(a.id));
    useTabs.getState().dropTab(b.id, 'single', 'left');
    act(() => useTabs.getState().activate(b.id));
    expect(useTabs.getState().tabs.find((t) => t.id === b.id)!.title).toBe('prod db');
    expect(useTabs.getState().tabs.find((t) => t.id === b.id)!.status).toBe('connected');
    const slot = document.querySelector('.sftp-slot:not([hidden])') as HTMLElement;
    await waitFor(() => expect(within(slot).getByText('notes.md')).toBeTruthy());
    expect(ssh.sftp.lists).toHaveLength(listsBefore);
    expect(ssh.opens).toHaveLength(3);
  });

  it('dropping on the middle of a pane offers the valid targets', async () => {
    const { a, b } = await three();
    act(() => useTabs.getState().activate(a.id));
    act(() => useDrag.getState().set({ chooser: { tabId: b.id, leafId: 'single' } }));
    const chooser = await screen.findByRole('dialog', { name: 'Where should the tab go?' });
    for (const label of [
      'Left of this pane',
      'Right of this pane',
      'Above this pane',
      'Below this pane',
      'Replace this pane',
      'Cancel',
    ]) {
      expect(within(chooser).getByRole('button', { name: label })).toBeTruthy();
    }
    fireEvent.click(within(chooser).getByRole('button', { name: 'Below this pane' }));
    expect(shown()).toEqual([a.id, b.id]);
    expect(place(layout()!).branches[0]!.branch.dir).toBe('column');
    expect(screen.queryByRole('dialog', { name: 'Where should the tab go?' })).toBeNull();
  });

  it('shows the resulting layout as a preview before the button is released', async () => {
    const { a, b } = await three();
    act(() => useTabs.getState().activate(a.id));
    act(() =>
      useDrag
        .getState()
        .set({ tabId: b.id, preview: { leafId: 'single', zone: 'right', valid: true } }),
    );
    const preview = document.querySelector('.drop-preview') as HTMLElement;
    expect(preview.dataset.zone).toBe('right');
    expect(preview.textContent).toBe('Split right');
    expect(preview.style.left).toContain('50');
    expect(preview.getAttribute('aria-hidden')).toBe('true'); // never steals the pointer
    for (const [zone, label] of [
      ['left', 'Split left'],
      ['top', 'Split above'],
      ['bottom', 'Split below'],
      ['center', 'Drop for options'],
    ] as const) {
      act(() => useDrag.getState().set({ preview: { leafId: 'single', zone, valid: true } }));
      expect((document.querySelector('.drop-preview') as HTMLElement).textContent).toBe(label);
    }
    act(() => useDrag.getState().set({ tabId: null, preview: null }));
    expect(document.querySelector('.drop-preview')).toBeNull();
  });

  it('the tab context menu offers the same moves', async () => {
    const { ssh, a, b } = await three();
    act(() => useTabs.getState().activate(a.id));
    fireEvent.contextMenu(screen.getAllByRole('tab')[1]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show in New Pane: Right' }));
    expect(shown()).toEqual([a.id, b.id]);
    fireEvent.contextMenu(screen.getAllByRole('tab')[1]!);
    expect(screen.getByRole('menuitem', { name: 'Remove from Split' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Split' }));
    expect(layout()).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(3); // the tab is still open
    expect(ssh.closes).toEqual([]);
  });

  it('stays valid and within six panes however the tabs are dragged around', async () => {
    const { ssh, open } = await mount();
    for (let i = 0; i < 7; i += 1) await open(i % 2 ? 'beta' : 'alpha');
    const tabs = useTabs.getState().tabs.map((t) => t.id);
    const zones = ['left', 'right', 'top', 'bottom'] as const;
    let refused = 0;
    for (let i = 0; i < 40; i += 1) {
      const tab = tabs[(i * 5) % tabs.length]!;
      const l = layout();
      const target = l ? leaves(l)[(i * 3) % leaves(l).length]!.id : 'single';
      const result = useTabs.getState().dropTab(tab, target, zones[i % 4]!);
      if (result === 'limit') refused += 1;
      expect(validate(layout())).toEqual([]);
      expect(layout() ? countLeaves(layout()!) : 1).toBeLessThanOrEqual(MAX_LEAVES);
    }
    expect(refused).toBeGreaterThan(0); // the limit was reached and respected
    expect(ssh.opens).toHaveLength(7);
    expect(ssh.closes).toEqual([]);
    expect(useTabs.getState().tabs).toHaveLength(7);
  });
});

describe('SFTP follows the focused pane', () => {
  it("shows the focused server's files and name, remembers each session's directory", async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('beta');
    await sessionsReady();
    const [t0, t1] = useTabs.getState().tabs;
    ssh.sftp.perSession[t1!.sessionId!] = {
      '/': [{ name: 'only-on-beta.txt', dir: false, size: 7 }],
    };
    const identity = () => screen.getByTestId('sftp-identity').textContent;
    const visibleFiles = () =>
      [...document.querySelectorAll('.sftp-slot:not([hidden]) .sftp-row .sftp-name')].map(
        (n) => n.textContent,
      );
    await waitFor(() => expect(identity()).toContain('beta'));
    expect(identity()).toContain('ops@b.example.com');
    fireEvent.click(
      within(document.querySelector('.sftp-slot:not([hidden])') as HTMLElement).getByRole(
        'button',
        {
          name: 'Refresh',
        },
      ),
    );
    await waitFor(() => expect(visibleFiles()).toEqual(['only-on-beta.txt']));
    act(() => useTabs.getState().activate(t0!.id));
    expect(identity()).toContain('alpha');
    await waitFor(() => expect(visibleFiles()).toEqual(['etc', 'home', 'readme.txt']));
    fireEvent.doubleClick(screen.getByRole('option', { name: /home/ }));
    await waitFor(() => expect(visibleFiles()).toEqual(['notes.md']));
    act(() => useTabs.getState().activate(t1!.id));
    expect(visibleFiles()).toEqual(['only-on-beta.txt']);
    act(() => useTabs.getState().activate(t0!.id));
    expect(visibleFiles()).toEqual(['notes.md']);
  });

  it('in a split the panel switches with the pane focus', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await splitWithNew('splitVertical', ssh);
    await sessionsReady();
    const [t0, t1] = useTabs.getState().tabs;
    act(() => useTabs.getState().focusPane(findLeafByTab(layout()!, t0!.id)!.id));
    expect(useTabs.getState().activeId).toBe(t0!.id);
    expect(screen.getByTestId('sftp-identity').textContent).toContain(t0!.title);
    act(() => useTabs.getState().focusPane(findLeafByTab(layout()!, t1!.id)!.id));
    expect(useTabs.getState().activeId).toBe(t1!.id);
  });

  it('a session without SFTP says so only for that session', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('beta');
    await sessionsReady();
    const [t0, t1] = useTabs.getState().tabs;
    act(() => ssh.emit(t1!.sessionId!, { kind: 'sftp', state: 'unavailable' }));
    expect(await screen.findByText('This server does not offer SFTP.')).toBeTruthy();
    act(() => useTabs.getState().activate(t0!.id));
    const visibleSlot = () => document.querySelector('.sftp-slot:not([hidden])') as HTMLElement;
    await waitFor(() =>
      expect(within(visibleSlot()).queryByText('This server does not offer SFTP.')).toBeNull(),
    );
    expect(within(visibleSlot()).getByRole('listbox', { name: 'Remote files' })).toBeTruthy();
  });
});

describe('dragging the ACTIVE tab into a split zone', () => {
  async function tabsOpen(names: string[]) {
    const m = await mount();
    for (const n of names) await m.open(n);
    await sessionsReady();
    return { ...m, tabs: useTabs.getState().tabs };
  }
  type T = ReturnType<typeof useTabs.getState>['tabs'][number];
  const snapshot = (ssh: MockSsh) => ({
    opens: ssh.opens.length,
    closes: ssh.closes.length,
    terminals: fakeTerminals.slice(),
  });
  const consistent = () => {
    expect(validate(layout())).toEqual([]);
    const ids = shown();
    expect(new Set(ids).size).toBe(ids.length); // no session shown twice
  };

  it('two tabs, active tab dragged: it moves to the new pane and the other one stays', async () => {
    const { ssh, tabs } = await tabsOpen(['alpha', 'beta']);
    const [pve1, pve2] = tabs as [T, T];
    expect(useTabs.getState().activeId).toBe(pve2.id);
    const before = snapshot(ssh);
    expect(useTabs.getState().dropTab(pve2.id, 'single', 'right')).toBe('ok');
    expect(shown()).toEqual([pve1.id, pve2.id]); // original pane: pve1, new pane: pve2
    expect(useTabs.getState().activeId).toBe(pve2.id);
    expect(findLeafByTab(layout()!, pve2.id)!.id).toBe(useTabs.getState().focusLeaf);
    expect(snapshot(ssh)).toEqual(before); // no reconnect, no close, same terminals
    consistent();
  });

  it('two tabs, inactive tab dragged: unchanged behaviour', async () => {
    const { ssh, tabs } = await tabsOpen(['alpha', 'beta']);
    const [pve1, pve2] = tabs as [T, T];
    const before = snapshot(ssh);
    expect(useTabs.getState().dropTab(pve1.id, 'single', 'right')).toBe('ok');
    expect(shown()).toEqual([pve2.id, pve1.id]);
    expect(useTabs.getState().activeId).toBe(pve1.id);
    expect(snapshot(ssh)).toEqual(before);
    consistent();
  });

  it.each(['left', 'right', 'top', 'bottom'] as const)('active tab dragged to %s', async (zone) => {
    const { tabs } = await tabsOpen(['alpha', 'beta']);
    const [pve1, pve2] = tabs as [T, T];
    expect(useTabs.getState().dropTab(pve2.id, 'single', zone)).toBe('ok');
    const order = zone === 'left' || zone === 'top' ? [pve2.id, pve1.id] : [pve1.id, pve2.id];
    expect(shown()).toEqual(order);
    const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
    expect((layout() as { dir: string }).dir).toBe(dir);
    consistent();
  });

  it('several tabs: the tab that takes its place in the bar fills the original pane', async () => {
    const { ssh, tabs } = await tabsOpen(['alpha', 'beta', 'alpha']);
    const [a, b, c] = tabs as [T, T, T];
    act(() => useTabs.getState().activate(b.id));
    const before = snapshot(ssh);
    expect(useTabs.getState().dropTab(b.id, 'single', 'left')).toBe('ok');
    expect(shown()).toEqual([b.id, c.id]); // c took b's place; a stays a background tab
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(snapshot(ssh)).toEqual(before);
    consistent();
  });

  it('a lone tab cannot be split off itself', async () => {
    const { tabs } = await tabsOpen(['alpha']);
    expect(useTabs.getState().dropTab(tabs[0]!.id, 'single', 'right')).toBe('none');
    expect(layout()).toBeNull();
    expect(useTabs.getState().activeId).toBe(tabs[0]!.id);
  });

  it('moving the focused tab between existing panes keeps a valid tree', async () => {
    const { ssh, tabs } = await tabsOpen(['alpha', 'beta', 'alpha']);
    const [a, b, c] = tabs as [T, T, T];
    act(() => useTabs.getState().activate(a.id));
    useTabs.getState().dropTab(b.id, 'single', 'right'); // [a | b]
    useTabs.getState().dropTab(c.id, findLeafByTab(layout()!, b.id)!.id, 'bottom'); // [a | b / c]
    const before = snapshot(ssh);
    const focused = useTabs.getState().activeId!;
    const other = shown().find((t) => t !== focused)!;
    const target = findLeafByTab(layout()!, other)!.id;
    expect(useTabs.getState().dropTab(focused, target, 'top')).toBe('ok');
    expect(shown()).toHaveLength(3);
    expect(useTabs.getState().activeId).toBe(focused);
    expect(snapshot(ssh)).toEqual(before);
    consistent();
  });

  it('canDrop never changes anything and a cancelled drag leaves the selection alone', async () => {
    const { tabs } = await tabsOpen(['alpha', 'beta']);
    expect(useTabs.getState().canDrop(tabs[1]!.id, 'single', 'right')).toBe('ok');
    expect(useTabs.getState().layout).toBeNull();
    expect(useTabs.getState().activeId).toBe(tabs[1]!.id);
    act(() => useDrag.getState().set({ tabId: tabs[0]!.id, preview: null }));
    act(() => useDrag.getState().set({ tabId: null, preview: null })); // what a cancel does
    expect(useTabs.getState().activeId).toBe(tabs[1]!.id);
    expect(useTabs.getState().layout).toBeNull();
  });

  it('at six panes the drop is refused, nothing closes and the preview says so', async () => {
    const m = await mount();
    for (let i = 0; i < 7; i += 1) await m.open('alpha');
    await sessionsReady();
    const all = useTabs.getState().tabs;
    act(() => useTabs.getState().activate(all[0]!.id));
    useTabs.getState().dropTab(all[1]!.id, 'single', 'right');
    for (let i = 2; i < MAX_LEAVES; i += 1) {
      const last = leaves(layout()!).at(-1)!.id;
      expect(useTabs.getState().dropTab(all[i]!.id, last, 'right')).toBe('ok');
    }
    expect(countLeaves(layout()!)).toBe(MAX_LEAVES);
    const hidden = all[6]!;
    const before = layout();
    const target = leaves(layout()!)[0]!.id;
    expect(useTabs.getState().canDrop(hidden.id, target, 'left')).toBe('limit');
    expect(useTabs.getState().dropTab(hidden.id, target, 'left')).toBe('limit');
    expect(layout()).toBe(before);
    expect(m.ssh.closes).toEqual([]);
    act(() =>
      useDrag.getState().set({
        tabId: hidden.id,
        preview: { leafId: target, zone: 'left', valid: false, reason: 'At most 6 panes' },
      }),
    );
    const preview = document.querySelector('.drop-preview') as HTMLElement;
    expect(preview.dataset.invalid).toBe('true');
    expect(preview.textContent).toContain('Cannot drop');
    act(() => useDrag.getState().set({ tabId: null, preview: null }));
  });
});
