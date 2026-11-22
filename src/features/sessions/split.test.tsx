import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runAction } from '../../app/commands';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { MAX_RATIO, MIN_RATIO, useTabs } from './store';

const seed = {
  connections: [conn('a', 'alpha'), conn('b', 'beta', { username: 'ops' })],
};

async function mount() {
  const mounted = mountApp(seed);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  const open = async (name: string) => {
    const before = ssh.opens.length;
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText(name));
    await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
  };
  return { ...mounted, ssh, open };
}

const sessionsReady = () =>
  waitFor(() => expect(useTabs.getState().tabs.every((t) => t.sessionId !== null)).toBe(true));

const panes = () => document.querySelectorAll<HTMLElement>('.terminal-pane:not([hidden])');
const split = () => useTabs.getState().split;

describe('split view', () => {
  it('splits the active tab and the new pane can start a NEW session of the same connection', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    expect(split()).toMatchObject({
      orientation: 'vertical',
      ratio: 0.5,
      panes: [expect.any(String), null],
    });
    const picker = await screen.findByRole('group', { name: /Choose what to show/ });
    expect(ssh.opens).toHaveLength(1);
    fireEvent.click(within(picker).getByRole('button', { name: /New session — alpha/ }));
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
    const s = split()!;
    expect(s.panes[1]).not.toBeNull();
    expect(s.focus).toBe(1);
    const tabs = useTabs.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.connectionId).toBe(tabs[1]!.connectionId);
    expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
    expect(panes()).toHaveLength(2);
    expect(screen.getByRole('separator', { name: 'Resize split panes' })).toBeTruthy();
    expect(ssh.opens[0]!.sessionId).not.toBe(ssh.opens[1]!.sessionId);
  });

  it('can show an existing tab in the second pane without touching its session', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('beta');
    act(() => useTabs.getState().activate(useTabs.getState().tabs[0]!.id));
    act(() => runAction('splitHorizontal'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: /Choose what to show/ })).getByRole(
        'button',
        {
          name: /beta/,
        },
      ),
    );
    expect(split()).toMatchObject({ orientation: 'horizontal' });
    expect(split()!.panes).toEqual(useTabs.getState().tabs.map((t) => t.id));
    expect(ssh.opens).toHaveLength(2); // nothing was reconnected
    expect(ssh.closes).toEqual([]);
  });

  it('keeps every session when the orientation changes and when the split is closed', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    await open('beta');
    act(() => useTabs.getState().activate(useTabs.getState().tabs[0]!.id));
    act(() => runAction('splitVertical'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: /Choose what to show/ })).getByRole(
        'button',
        {
          name: /beta/,
        },
      ),
    );
    const terminalsBefore = fakeTerminals.slice();
    const before = split()!.panes;

    act(() => runAction('toggleSplitOrientation'));
    expect(split()!.orientation).toBe('horizontal');
    expect(split()!.panes).toEqual(before);
    act(() => runAction('toggleSplitOrientation'));
    expect(split()!.orientation).toBe('vertical');

    act(() => runAction('unsplit'));
    expect(split()).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(ssh.opens).toHaveLength(2);
    expect(ssh.closes).toEqual([]);
    expect(fakeTerminals).toEqual(terminalsBefore); // same xterm instances, nothing remounted
    expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true);
  });

  it('resizes the divider with the keyboard and keeps the ratio within limits', async () => {
    const { open } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    const divider = screen.getByRole('separator', { name: 'Resize split panes' });
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(split()!.ratio).toBeCloseTo(0.52);
    for (let i = 0; i < 60; i += 1) fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(split()!.ratio).toBe(MAX_RATIO);
    for (let i = 0; i < 80; i += 1) fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(split()!.ratio).toBe(MIN_RATIO);
    fireEvent.doubleClick(divider);
    expect(split()!.ratio).toBe(0.5);
    expect(divider.getAttribute('aria-valuenow')).toBe('50');
  });

  it('lays the panes out for both orientations', async () => {
    const { open } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    const [first, second] = [...panes()];
    expect(first!.style.width).toContain('50%');
    expect(second!.style.left).toContain('50%');
    act(() => runAction('toggleSplitOrientation'));
    await waitFor(() => expect([...panes()][0]!.style.height).toContain('50%'));
    expect([...panes()][1]!.style.top).toContain('50%');
  });

  it('focus moves with clicks, the shortcut action and tab activation; input goes to the focused terminal', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    await sessionsReady();
    const [t0, t1] = useTabs.getState().tabs;
    expect(useTabs.getState().activeId).toBe(t1!.id); // the new pane has the focus

    act(() => fakeTerminals[1]!.type('right'));
    await waitFor(() => expect(ssh.writes).toHaveLength(1));
    expect(ssh.writes[0]).toEqual({ sessionId: t1!.sessionId, text: 'right' });

    act(() => runAction('focusNextPane'));
    expect(useTabs.getState().activeId).toBe(t0!.id);
    expect(split()!.focus).toBe(0);
    fireEvent.mouseDown(panes()[1]!);
    expect(useTabs.getState().activeId).toBe(t1!.id);
    act(() => fakeTerminals[0]!.type('left'));
    await waitFor(() => expect(ssh.writes).toHaveLength(2));
    expect(ssh.writes[1]).toEqual({ sessionId: t0!.sessionId, text: 'left' });
  });

  it('each pane reports its own PTY size to its own session, in both orientations', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    await sessionsReady();
    const [t0, t1] = useTabs.getState().tabs;
    act(() => fakeTerminals[0]!.resize(60, 40));
    act(() => fakeTerminals[1]!.resize(61, 40));
    await waitFor(() => expect(ssh.resizes).toHaveLength(2));
    expect(ssh.resizes).toEqual([
      { sessionId: t0!.sessionId, cols: 60, rows: 40 },
      { sessionId: t1!.sessionId, cols: 61, rows: 40 },
    ]);
    // stacked: wide and short panes
    act(() => runAction('toggleSplitOrientation'));
    act(() => fakeTerminals[0]!.resize(122, 19));
    act(() => fakeTerminals[1]!.resize(122, 20));
    await waitFor(() => expect(ssh.resizes).toHaveLength(4));
    expect(ssh.resizes.slice(2)).toEqual([
      { sessionId: t0!.sessionId, cols: 122, rows: 19 },
      { sessionId: t1!.sessionId, cols: 122, rows: 20 },
    ]);
  });

  it("closing a pane's tab ends the split but never the other session", async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    await sessionsReady();
    const [t0, t1] = useTabs.getState().tabs;
    act(() => useTabs.getState().closeTab(t1!.id));
    expect(split()).toBeNull();
    expect(useTabs.getState().activeId).toBe(t0!.id);
    await waitFor(() => expect(ssh.closes).toEqual([t1!.sessionId]));
    expect(useTabs.getState().tabs[0]!.status).toBe('connected');
  });

  it('cancelling the picker leaves a normal single-tab view', async () => {
    const { open } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel split' }));
    expect(split()).toBeNull();
    expect(panes()).toHaveLength(1);
  });
});

describe('SFTP follows the focused session', () => {
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
    // the server answers differently now: refresh the focused panel
    fireEvent.click(
      within(document.querySelector('.sftp-slot:not([hidden])') as HTMLElement).getByRole(
        'button',
        {
          name: 'Refresh',
        },
      ),
    );
    expect(identity()).toContain('ops@b.example.com');
    await waitFor(() => expect(visibleFiles()).toEqual(['only-on-beta.txt']));

    // focus the first server: its own listing, never beta's
    act(() => useTabs.getState().activate(t0!.id));
    expect(identity()).toContain('alpha');
    await waitFor(() => expect(visibleFiles()).toEqual(['etc', 'home', 'readme.txt']));
    fireEvent.doubleClick(screen.getByRole('option', { name: /home/ }));
    await waitFor(() => expect(visibleFiles()).toEqual(['notes.md']));

    // back and forth: each keeps its directory
    act(() => useTabs.getState().activate(t1!.id));
    expect(visibleFiles()).toEqual(['only-on-beta.txt']);
    act(() => useTabs.getState().activate(t0!.id));
    expect(visibleFiles()).toEqual(['notes.md']);
  });

  it('in split view the panel switches with the pane focus', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    act(() => runAction('splitVertical'));
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    await sessionsReady();
    const [t0, t1] = useTabs.getState().tabs;
    ssh.sftp.perSession[t1!.sessionId!] = { '/': [{ name: 'second.txt', dir: false, size: 1 }] };
    act(() => useTabs.getState().focusPane(0));
    const files = () =>
      [...document.querySelectorAll('.sftp-slot:not([hidden]) .sftp-row .sftp-name')].map(
        (n) => n.textContent,
      );
    await waitFor(() => expect(files()).toContain('readme.txt'));
    act(() => useTabs.getState().focusPane(1));
    expect(screen.getByTestId('sftp-identity').textContent).toContain(t1!.title);
    expect(t0!.id).not.toBe(t1!.id);
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
