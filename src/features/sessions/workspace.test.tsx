// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runAction } from '../../app/commands';
import type { MockSsh } from '../../shared/mockBackend';
import type { LocalProfile, SavedNode, WorkspaceLayout } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { __setPersistenceEnabled, fromLayout, toLayout } from './persistence';
import { countLeaves, leaves, place, validate } from './layout';
import { useTabs } from './store';

const A = conn('a', 'alpha');
const B = conn('b', 'beta');
const seed = () => ({ connections: [structuredClone(A), structuredClone(B)] });
const PS: LocalProfile = { id: 'pwsh', name: 'PowerShell 7', kind: 'local', detail: 'pwsh.exe' };

const leaf = (tab: number): SavedNode => ({ kind: 'leaf', tab });
const row = (a: SavedNode, b: SavedNode, ratio = 0.5): SavedNode => ({
  kind: 'branch',
  dir: 'row',
  ratio,
  a,
  b,
});
const col = (a: SavedNode, b: SavedNode, ratio = 0.5): SavedNode => ({
  kind: 'branch',
  dir: 'column',
  ratio,
  a,
  b,
});
const ssh = (connectionId: string, title: string | null = null) => ({
  kind: 'ssh' as const,
  connectionId,
  profileId: null,
  title,
  colors: null,
});

/**   ┌───┬───┐
 *    │ 0 │ 1 │
 *    │   ├───┤      three panes: one tall, two stacked
 *    │   │ 2 │
 *    └───┴───┘                                         */
const saved: WorkspaceLayout = {
  tabs: [
    ssh('a', 'prod web'),
    ssh('b'),
    { kind: 'local', connectionId: null, profileId: 'pwsh', title: null, colors: null },
  ],
  active: 1, // with a split the focused pane's tab is the active one
  tree: row(leaf(0), col(leaf(1), leaf(2), 0.3), 0.4),
  focus: 1,
};

describe('layout conversion', () => {
  it('round-trips titles, order, nesting, ratios, local tabs and the focused pane', () => {
    const r = fromLayout(saved, [A, B], false, [PS]);
    expect(r.tabs.map((t) => t.title)).toEqual(['prod web', 'beta', 'PowerShell 7']);
    expect(r.tabs.map((t) => t.kind)).toEqual(['ssh', 'ssh', 'local']);
    expect(r.tabs[2]!.profileId).toBe('pwsh');
    expect(new Set(r.tabs.map((t) => t.id)).size).toBe(3);
    expect(countLeaves(r.layout!)).toBe(3);
    expect(validate(r.layout)).toEqual([]);
    expect(r.activeId).toBe(r.tabs[1]!.id); // the focused pane decides
    expect(leaves(r.layout!).find((l) => l.id === r.focusLeaf)?.tabId).toBe(r.tabs[1]!.id);
    expect(toLayout(r.tabs, r.activeId, r.layout, r.focusLeaf)).toEqual(saved);
  });

  it('keeps up to six panes and drops a tree that is bigger or malformed', () => {
    const chain = (n: number): SavedNode => {
      let node = leaf(0);
      for (let i = 1; i < n; i += 1) node = row(node, leaf(i));
      return node;
    };
    const tabs = (n: number) => Array.from({ length: n }, () => ssh('a'));
    const six = fromLayout({ tabs: tabs(6), active: 0, tree: chain(6), focus: 0 }, [A], false);
    expect(countLeaves(six.layout!)).toBe(6);
    expect(
      fromLayout({ tabs: tabs(7), active: 0, tree: chain(7), focus: 0 }, [A], false).layout,
    ).toBeNull();
    const twice = { tabs: tabs(2), active: 0, tree: row(leaf(0), leaf(0)), focus: 0 };
    expect(fromLayout(twice, [A], false).layout).toBeNull(); // one tab in two panes
    const wild = fromLayout(
      { tabs: tabs(2), active: 0, tree: row(leaf(0), leaf(1), 9), focus: 0 },
      [A],
      false,
    );
    expect(place(wild.layout!).branches[0]!.branch.ratio).toBe(0.9);
  });

  it('restored tabs are not connected and carry no session; local shells never auto-start', () => {
    const { tabs } = fromLayout(saved, [A, B], false, [PS]);
    expect(tabs.every((t) => t.restored && t.status === 'idle' && t.sessionId === null)).toBe(true);
    const auto = fromLayout(saved, [A, B], true, [PS]).tabs;
    expect(auto.filter((t) => t.kind === 'ssh').every((t) => !t.restored)).toBe(true);
    expect(auto.find((t) => t.kind === 'local')!.restored).toBe(true);
  });

  it('drops tabs of deleted connections and collapses the tree around them', () => {
    const r = fromLayout(saved, [B], false, [PS]); // connection a was deleted
    expect(r.tabs.map((t) => t.title)).toEqual(['beta', 'PowerShell 7']);
    expect(countLeaves(r.layout!)).toBe(2);
    const alone = fromLayout(saved, [], false, []);
    expect(alone.tabs).toHaveLength(1); // only the local shell is left
    expect(alone.layout).toBeNull();
  });

  it('an unknown local profile keeps its tab, named by its id, and still never auto-starts', () => {
    const r = fromLayout(saved, [A, B], false, []);
    expect(r.tabs[2]!.title).toBe('pwsh');
    expect(r.tabs[2]!.restored).toBe(true);
  });

  it('a pane still waiting for a choice is not saved, and a lone pane is no split', () => {
    useTabs.setState({ tabs: [], activeId: null, layout: null, focusLeaf: null });
    useTabs.getState().openTab(A);
    useTabs.getState().startSplit('vertical');
    const { tabs, activeId, layout, focusLeaf } = useTabs.getState();
    expect(toLayout(tabs, activeId, layout, focusLeaf).tree).toBeNull();
  });

  it('contains nothing but metadata', () => {
    useTabs.setState({ tabs: [], activeId: null, layout: null, focusLeaf: null });
    useTabs.getState().openTab(A);
    useTabs.getState().openLocal({ id: 'pwsh', name: 'PowerShell 7', kind: 'local' });
    useTabs.getState().setSession(useTabs.getState().tabs[0]!.id, 'session-secret-id');
    const { tabs, activeId, layout, focusLeaf } = useTabs.getState();
    const text = JSON.stringify(toLayout(tabs, activeId, layout, focusLeaf));
    expect(text).not.toContain('session-secret-id');
    expect(text).not.toMatch(/password|secret|status|sftp|command/i);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['active', 'focus', 'tabs', 'tree']);
  });
});

describe('restoring the workspace at start-up', () => {
  it('brings the tabs and the split back WITHOUT connecting anything', async () => {
    const mounted = mountApp(seed(), {
      restoreLayout: {
        ...saved,
        tabs: saved.tabs.slice(0, 2),
        active: 0,
        tree: row(leaf(0), leaf(1), 0.4),
        focus: 0,
      },
    });
    const ssh_ = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));
    expect(useTabs.getState().tabs.map((t) => t.title)).toEqual(['prod web', 'beta']);
    expect(countLeaves(useTabs.getState().layout!)).toBe(2);
    expect(ssh_.opens).toHaveLength(0);
    expect(ssh_.writes).toEqual([]);
    expect(
      (await screen.findAllByText('Restored tab — not connected yet.')).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /Connect/ })[0]!);
    await waitFor(() => expect(ssh_.opens).toHaveLength(1));
    expect(ssh_.opens[0]!.attempt).toBe(0);
  });

  it('reconnects on its own only when the user opted in (SSH tabs only)', async () => {
    const mounted = mountApp(seed(), {
      restoreLayout: { ...saved, tabs: saved.tabs.slice(0, 2), active: 0, tree: null, focus: null },
      settings: (s) => ({ ...s, general: { ...s.general, autoReconnectRestored: true } }),
    });
    const ssh_ = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await waitFor(() => expect(ssh_.opens).toHaveLength(2));
    expect(new Set(ssh_.opens.map((o) => o.sessionId)).size).toBe(2);
  });

  it('does nothing when restoring is off', async () => {
    mountApp(seed());
    await screen.findByRole('tree');
    expect(useTabs.getState().tabs).toHaveLength(0);
  });

  it('skips tabs whose saved connection was deleted meanwhile', async () => {
    mountApp({ connections: [structuredClone(B)] }, { restoreLayout: saved });
    await waitFor(() => expect(useTabs.getState().tabs.length).toBeGreaterThan(0));
    expect(useTabs.getState().tabs.every((t) => t.connectionId !== 'a')).toBe(true);
  });
});

describe('saving the layout while working', () => {
  it('stores order, titles and the split tree a moment after they change', async () => {
    const mounted = mountApp(seed(), {
      restoreLayout: { tabs: [], active: null, tree: null, focus: null },
    });
    const ssh_ = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    __setPersistenceEnabled(true);
    act(() => useTabs.getState().setArea(3000, 1800));
    const tree = within(screen.getByRole('tree'));
    fireEvent.doubleClick(tree.getByText('alpha'));
    fireEvent.doubleClick(tree.getByText('beta'));
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));
    const [t0, t1] = useTabs.getState().tabs;
    act(() => useTabs.getState().renameTab(t0!.id, 'mine'));
    act(() => useTabs.getState().activate(t0!.id));
    act(() => runAction('splitVertical'));
    act(() => {
      const picker = leaves(useTabs.getState().layout!).find((l) => l.tabId === null)!;
      useTabs.getState().fillLeaf(picker.id, t1!.id);
    });
    act(() => {
      const b = place(useTabs.getState().layout!).branches[0]!.branch;
      useTabs.getState().setBranchRatio(b.id, 0.6);
    });
    await waitFor(() => {
      expect(ssh_.workspaceSaves.at(-1)).toEqual({
        tabs: [
          { kind: 'ssh', connectionId: 'a', profileId: null, title: 'mine', colors: null },
          { kind: 'ssh', connectionId: 'b', profileId: null, title: null, colors: null },
        ],
        active: 1,
        tree: row(leaf(0), leaf(1), 0.6),
        focus: 1,
      });
    });
    const saves = ssh_.workspaceSaves.length;
    act(() => useTabs.getState().setStatus(t0!.id, 'failed')); // not a layout fact
    await new Promise((r) => setTimeout(r, 450));
    expect(ssh_.workspaceSaves.length).toBe(saves);
  });

  it('what is saved never contains a session id', async () => {
    const mounted = mountApp(seed(), {
      restoreLayout: { tabs: [], active: null, tree: null, focus: null },
    });
    const ssh_ = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    __setPersistenceEnabled(true);
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(ssh_.workspaceSaves.length).toBeGreaterThan(0));
    await waitFor(() => expect(useTabs.getState().tabs[0]!.sessionId).not.toBeNull());
    expect(JSON.stringify(ssh_.workspaceSaves)).not.toContain(
      useTabs.getState().tabs[0]!.sessionId!,
    );
  });
});
