import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runAction } from '../../app/commands';
import type { MockSsh } from '../../shared/mockBackend';
import type { WorkspaceLayout } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { __setPersistenceEnabled, fromLayout, toLayout } from './persistence';
import { useTabs } from './store';

const A = conn('a', 'alpha');
const B = conn('b', 'beta');
const seed = { connections: [A, B] };

const layout: WorkspaceLayout = {
  tabs: [
    { connectionId: 'a', title: 'prod web' },
    { connectionId: 'b', title: null },
    { connectionId: 'a', title: null },
  ],
  active: 2,
  split: { orientation: 'horizontal', ratio: 0.3, panes: [0, 2], focus: 1 },
};

describe('layout conversion', () => {
  it('round-trips titles, order, split orientation, ratio and focus', () => {
    const { tabs, activeId, split } = fromLayout(layout, [A, B], false);
    expect(tabs.map((t) => t.title)).toEqual(['prod web', 'beta', 'alpha']);
    expect(tabs.map((t) => t.connectionId)).toEqual(['a', 'b', 'a']);
    expect(new Set(tabs.map((t) => t.id)).size).toBe(3);
    expect(split).toMatchObject({ orientation: 'horizontal', ratio: 0.3, focus: 1 });
    expect(split!.panes).toEqual([tabs[0]!.id, tabs[2]!.id]);
    expect(activeId).toBe(tabs[2]!.id);
    expect(toLayout(tabs, activeId, split)).toEqual(layout);
  });

  it('restored tabs are not connected and carry no session', () => {
    const { tabs } = fromLayout(layout, [A, B], false);
    expect(tabs.every((t) => t.restored && t.status === 'idle' && t.sessionId === null)).toBe(true);
    const auto = fromLayout(layout, [A, B], true).tabs;
    expect(auto.every((t) => !t.restored)).toBe(true);
  });

  it('drops tabs of deleted connections and repairs the indexes', () => {
    const { tabs, activeId, split } = fromLayout(layout, [B], false);
    expect(tabs.map((t) => t.connectionId)).toEqual(['b']);
    expect(split).toBeNull(); // a split that lost a pane is gone
    expect(activeId).toBe(tabs[0]!.id);
  });

  it('clamps a hostile ratio and ignores a split that names the same tab twice', () => {
    const wild = { ...layout, split: { ...layout.split!, ratio: 7 } };
    expect(fromLayout(wild, [A, B], false).split!.ratio).toBe(0.85);
    const same = { ...layout, split: { ...layout.split!, panes: [1, 1] as [number, number] } };
    expect(fromLayout(same, [A, B], false).split).toBeNull();
  });

  it('a split still waiting for its second pane is not saved', () => {
    useTabs.setState({ tabs: [], activeId: null, split: null });
    const id = useTabs.getState().openTab(A);
    useTabs.getState().startSplit('vertical');
    const { tabs, activeId, split } = useTabs.getState();
    expect(toLayout(tabs, activeId, split).split).toBeNull();
    void id;
  });

  it('contains nothing but metadata', () => {
    useTabs.setState({ tabs: [], activeId: null, split: null });
    useTabs.getState().openTab(A);
    useTabs.getState().setSession(useTabs.getState().tabs[0]!.id, 'session-secret-id');
    const { tabs, activeId, split } = useTabs.getState();
    const text = JSON.stringify(toLayout(tabs, activeId, split));
    expect(text).not.toContain('session-secret-id');
    expect(text).not.toMatch(/password|secret|status|sftp/i);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['active', 'split', 'tabs']);
  });
});

describe('restoring the workspace at start-up', () => {
  it('brings the tabs back WITHOUT connecting; connecting is explicit and creates a new session', async () => {
    const mounted = mountApp(seed, { restoreLayout: layout });
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(3));
    expect(useTabs.getState().tabs.map((t) => t.title)).toEqual(['prod web', 'beta', 'alpha']);
    expect(useTabs.getState().split).toMatchObject({ orientation: 'horizontal', ratio: 0.3 });
    expect(ssh.opens).toHaveLength(0); // nothing was connected, nothing replayed
    expect(ssh.writes).toEqual([]);
    expect(
      (await screen.findAllByText('Restored tab — not connected yet.')).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Connect/ })).toHaveLength(2); // the two visible panes
    const connectButtons = screen.getAllByRole('button', { name: /Connect/ });
    fireEvent.click(connectButtons[0]!);
    await waitFor(() => expect(ssh.opens).toHaveLength(1));
    expect(ssh.opens[0]!.attempt).toBe(0);
    await waitFor(() =>
      expect(useTabs.getState().tabs.filter((t) => t.status === 'connected')).toHaveLength(1),
    );
  });

  it('reconnects on its own only when the user opted in', async () => {
    const mounted = mountApp(seed, {
      restoreLayout: { ...layout, split: null },
      settings: (s) => ({ ...s, general: { ...s.general, autoReconnectRestored: true } }),
    });
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await waitFor(() => expect(ssh.opens).toHaveLength(3));
    expect(new Set(ssh.opens.map((o) => o.sessionId)).size).toBe(3); // new sessions
  });

  it('does nothing when restoring is off', async () => {
    const mounted = mountApp(seed);
    await screen.findByRole('tree');
    expect(useTabs.getState().tabs).toHaveLength(0);
    void mounted;
  });

  it('skips tabs whose saved connection was deleted meanwhile', async () => {
    mountApp({ connections: [B] }, { restoreLayout: layout });
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(useTabs.getState().tabs[0]!.connectionId).toBe('b');
  });
});

describe('saving the layout while working', () => {
  it('stores order, titles and split a moment after they change', async () => {
    const mounted = mountApp(seed, { restoreLayout: { tabs: [], active: null, split: null } });
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    __setPersistenceEnabled(true);
    const tree = within(screen.getByRole('tree'));
    fireEvent.doubleClick(tree.getByText('alpha'));
    fireEvent.doubleClick(tree.getByText('beta'));
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2));
    act(() => useTabs.getState().renameTab(useTabs.getState().tabs[0]!.id, 'mine'));
    act(() => useTabs.getState().activate(useTabs.getState().tabs[0]!.id));
    act(() => runAction('splitVertical'));
    act(() => useTabs.getState().setSecondPane(useTabs.getState().tabs[1]!.id));
    act(() => useTabs.getState().setRatio(0.6));
    await waitFor(() => {
      const last = ssh.workspaceSaves.at(-1);
      expect(last).toEqual({
        tabs: [
          { connectionId: 'a', title: 'mine' },
          { connectionId: 'b', title: null },
        ],
        active: 1,
        split: { orientation: 'vertical', ratio: 0.6, panes: [0, 1], focus: 1 },
      });
    });
    // unrelated updates (status, session ids) do not cause saves
    const saves = ssh.workspaceSaves.length;
    act(() => useTabs.getState().setStatus(useTabs.getState().tabs[0]!.id, 'failed'));
    await new Promise((r) => setTimeout(r, 450));
    expect(ssh.workspaceSaves.length).toBe(saves);
    expect(fakeTerminals.length).toBeGreaterThan(0);
  });

  it('what is saved never contains a session id', async () => {
    const mounted = mountApp(seed, { restoreLayout: { tabs: [], active: null, split: null } });
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    __setPersistenceEnabled(true);
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(ssh.workspaceSaves.length).toBeGreaterThan(0));
    await waitFor(() => expect(useTabs.getState().tabs[0]!.sessionId).not.toBeNull());
    const everything = JSON.stringify(ssh.workspaceSaves);
    expect(everything).not.toContain(useTabs.getState().tabs[0]!.sessionId!);
  });
});
