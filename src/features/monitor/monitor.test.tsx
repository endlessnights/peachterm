// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MockSsh } from '../../shared/mockBackend';
import type { MonitorMetrics, Settings } from '../../shared/types';
import { conn, mountApp } from '../../test/appHarness';
import { useLock } from '../lock/store';
import { useSettings } from '../settings/store';
import { useTabs } from '../sessions/store';
import { useMonitor } from './store';

const GIB = 1024 * 1024;

const metrics = (over: Partial<MonitorMetrics> = {}): MonitorMetrics => ({
  cpuPercent: 18.4,
  load: [0.42, 0.51, 0.38],
  memory: { usedKib: 39.2 * GIB, totalKib: 62.7 * GIB, availableKib: 23.5 * GIB },
  disk: { usedKib: 338 * GIB, totalKib: 470 * GIB, availableKib: 100 * GIB, percent: 72 },
  uptimeSecs: 12 * 86400 + 8 * 3600,
  ...over,
});

const on = (s: Settings): Settings => ({ ...s, monitoring: { ...s.monitoring, enabled: true } });

async function mount(
  options: { enabled?: boolean; monitoring?: 'inherit' | 'enabled' | 'disabled' } = {},
) {
  const mounted = mountApp(
    {
      connections: [
        conn('a', 'alpha', { monitoring: options.monitoring ?? 'inherit' }),
        conn('b', 'beta'),
      ],
    },
    { settings: options.enabled ? on : undefined },
  );
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  const open = async (name: string) => {
    const before = ssh.opens.length;
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText(name));
    await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
    return ssh.opens[before]!.sessionId;
  };
  return { ...mounted, ssh, open };
}

const bar = () => screen.queryByRole('button', { name: 'Server resources' });

describe('server monitoring in the UI', () => {
  it('is off by default: nothing is requested and nothing is shown', async () => {
    const { ssh, open } = await mount();
    await open('alpha');
    await new Promise((r) => setTimeout(r, 30));
    expect(bar()).toBeNull();
    expect(useMonitor.getState().entries).toEqual({});
    expect(ssh.monitor.starts).toEqual([]);
  });

  it('shows compact CPU, RAM, disk and uptime once readings arrive', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const sid = await open('alpha');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid]));
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(bar()!.textContent).toContain('Server resources…');
    act(() => ssh.monitor.emit(sid, { kind: 'sample', metrics: metrics() }));
    const text = bar()!.textContent!;
    expect(text).toContain('CPU 18%');
    expect(text).toContain('RAM 39.2 / 62.7 GiB');
    expect(text).toContain('Disk / 72%');
    expect(text).toContain('Up 12d 8h');
  });

  it('shows a dash instead of a made-up CPU value and N/A for missing metrics', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const sid = await open('alpha');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid]));
    act(() =>
      ssh.monitor.emit(sid, {
        kind: 'sample',
        metrics: metrics({ cpuPercent: null, memory: null, disk: null, uptimeSecs: null }),
      }),
    );
    const text = bar()!.textContent!;
    expect(text).toContain('CPU —');
    expect(text).toContain('RAM N/A');
    expect(text).toContain('Disk / N/A');
    expect(text).toContain('Up N/A');
  });

  it('shows a calm unavailable state and no old numbers', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const sid = await open('alpha');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid]));
    act(() => ssh.monitor.emit(sid, { kind: 'sample', metrics: metrics() }));
    act(() =>
      ssh.monitor.emit(sid, { kind: 'unavailable', reason: 'unsupported', permanent: true }),
    );
    expect(bar()!.textContent).toBe('Monitoring unavailable');
    expect(bar()!.textContent).not.toMatch(/\d%/);
  });

  it('only the selected metrics are shown', async () => {
    const mounted = mountApp(
      { connections: [conn('a', 'alpha')] },
      {
        settings: (s) => ({
          ...s,
          monitoring: { ...s.monitoring, enabled: true, ram: false, disk: false },
        }),
      },
    );
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(ssh.monitor.starts).toHaveLength(1));
    act(() => ssh.monitor.emit(ssh.opens[0]!.sessionId, { kind: 'sample', metrics: metrics() }));
    const text = bar()!.textContent!;
    expect(text).toContain('CPU');
    expect(text).toContain('Up');
    expect(text).not.toContain('RAM');
    expect(text).not.toContain('Disk');
  });

  it('opens a details popover with the honest labels', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const sid = await open('alpha');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid]));
    act(() => ssh.monitor.emit(sid, { kind: 'sample', metrics: metrics() }));
    fireEvent.click(bar()!);
    const dialog = screen.getByRole('dialog', { name: 'Server Resources' });
    expect(dialog.textContent).toContain('Root FS');
    expect(dialog.textContent).toContain('0.42  0.51  0.38');
    expect(dialog.textContent).toContain('12 days, 8 hours');
    expect(dialog.textContent).toContain('nothing is saved');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Server Resources' })).toBeNull();
  });

  it('respects the per-connection override in both directions', async () => {
    const off = await mount({ enabled: true, monitoring: 'disabled' });
    await off.open('alpha');
    await new Promise((r) => setTimeout(r, 30));
    expect(off.ssh.monitor.starts).toEqual([]);
    expect(bar()).toBeNull();
    off.unmount();

    const forced = await mount({ enabled: false, monitoring: 'enabled' });
    const sid = await forced.open('alpha');
    await waitFor(() => expect(forced.ssh.monitor.starts).toEqual([sid]));
  });

  it('shows the readings of the active tab only, and never mixes servers', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const a = await open('alpha');
    const b = await open('beta');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([a, b]));
    act(() => {
      ssh.monitor.emit(a, { kind: 'sample', metrics: metrics({ cpuPercent: 11 }) });
      ssh.monitor.emit(b, { kind: 'sample', metrics: metrics({ cpuPercent: 77 }) });
    });
    expect(bar()!.textContent).toContain('CPU 77%'); // beta is active
    const tabA = useTabs.getState().tabs.find((t) => t.sessionId === a)!;
    act(() => useTabs.getState().activate(tabA.id));
    expect(bar()!.textContent).toContain('CPU 11%');
    expect(ssh.monitor.starts).toEqual([a, b]); // switching tabs restarts nothing
    expect(ssh.monitor.stops).toEqual([]);
  });

  it('drops readings when the application locks and starts afresh after unlock', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const sid = await open('alpha');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid]));
    act(() => ssh.monitor.emit(sid, { kind: 'sample', metrics: metrics() }));
    expect(bar()).not.toBeNull();
    act(() => useLock.getState().setLocked(true));
    expect(useMonitor.getState().entries).toEqual({});
    expect(bar()).toBeNull();
    await waitFor(() => expect(ssh.monitor.stops).toContain(sid));
    act(() => useLock.getState().setLocked(false));
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid, sid]));
    // fresh: waiting, not the old numbers
    expect(bar()!.textContent).toContain('Server resources…');
  });

  it('stops and clears when the session disconnects; a reconnect starts fresh', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const sid = await open('alpha');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid]));
    act(() => ssh.monitor.emit(sid, { kind: 'sample', metrics: metrics() }));
    act(() => ssh.emit(sid, { kind: 'status', state: 'disconnected' }));
    await waitFor(() => expect(bar()).toBeNull());
    expect(ssh.monitor.stops).toContain(sid);
    expect(useMonitor.getState().entries).toEqual({});
  });

  it('turning monitoring off while connected stops it', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const sid = await open('alpha');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([sid]));
    act(() => ssh.monitor.emit(sid, { kind: 'sample', metrics: metrics() }));
    await act(async () => {
      const current = useSettings.getState().settings;
      await useSettings
        .getState()
        .save({ ...current, monitoring: { ...current.monitoring, enabled: false } });
    });
    await waitFor(() => expect(bar()).toBeNull());
    expect(ssh.monitor.stops).toContain(sid);
    expect(useMonitor.getState().entries).toEqual({});
  });

  it('closing a tab stops its monitoring and nothing else', async () => {
    const { ssh, open } = await mount({ enabled: true });
    const a = await open('alpha');
    const b = await open('beta');
    await waitFor(() => expect(ssh.monitor.starts).toEqual([a, b]));
    const tab = useTabs.getState().tabs.find((t) => t.sessionId === a)!;
    act(() => useTabs.getState().closeTab(tab.id));
    await waitFor(() => expect(ssh.monitor.stops).toEqual([a]));
    expect(Object.keys(useMonitor.getState().entries)).toEqual([b]);
  });
});
