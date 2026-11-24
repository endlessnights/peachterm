// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runAction } from '../../app/commands';
import type { MockSsh } from '../../shared/mockBackend';
import { conn, mountApp } from '../../test/appHarness';
import { revealTab, wheelToScroll } from './TabBar';
import { useTabs } from './store';

const connection = conn('a', 'alpha');

/** jsdom has no layout: give the strip and its tabs fixed geometry. */
function layoutStrip(visible = 600, W = 150) {
  const strip = document.querySelector('.tabs') as HTMLElement;
  const tabs = Array.from(strip.children) as HTMLElement[];
  const def = (el: HTMLElement, k: string, value: number) =>
    Object.defineProperty(el, k, { value, configurable: true });
  def(strip, 'clientWidth', visible);
  def(strip, 'scrollWidth', tabs.length * W);
  def(strip, 'offsetLeft', 0);
  tabs.forEach((t, i) => {
    def(t, 'offsetLeft', i * W);
    def(t, 'offsetWidth', W);
  });
  return { strip, tabs, W };
}

async function open(n: number) {
  const mounted = mountApp({ connections: [connection] });
  await screen.findByRole('tree');
  act(() => {
    for (let i = 0; i < n; i++) useTabs.getState().openTab(connection);
  });
  return mounted;
}

describe('tab strip with many tabs', () => {
  for (const n of [20, 30, 50]) {
    it(`opens ${n} tabs: unique ids, all reachable, Add stays available`, async () => {
      await open(n);
      const tabs = useTabs.getState().tabs;
      expect(tabs).toHaveLength(n);
      expect(new Set(tabs.map((t) => t.id)).size).toBe(n);
      expect(screen.getAllByRole('tab')).toHaveLength(n);
      // tabs past position 18 are real, activatable tabs
      act(() => useTabs.getState().activate(tabs[n - 1]!.id));
      expect(screen.getAllByRole('tab')[n - 1]!.getAttribute('aria-selected')).toBe('true');
      // the Add button is outside the scrolling strip
      const add = screen.getByRole('button', { name: 'New local terminal' });
      expect(add.closest('.tabs')).toBeNull();
    });
  }

  it('scrolling and revealing never open or reconnect a session', async () => {
    const { backend } = await open(25);
    const ssh = (backend as unknown as { ssh: MockSsh }).ssh;
    const before = ssh.opens.length;
    const ids = useTabs.getState().tabs.map((t) => t.sessionId);
    const { strip } = layoutStrip();
    strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, cancelable: true }));
    act(() => useTabs.getState().activate(useTabs.getState().tabs[3]!.id));
    expect(ssh.opens.length).toBe(before);
    expect(useTabs.getState().tabs.map((t) => t.sessionId)).toEqual(ids);
  });
});

describe('wheel scrolling', () => {
  const mk = (over: WheelEventInit, scrollable = true) => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 400 });
    Object.defineProperty(el, 'scrollWidth', { value: scrollable ? 2000 : 400 });
    return { el, ev: new WheelEvent('wheel', { cancelable: true, ...over }) };
  };

  it('vertical wheel scrolls the strip sideways, up goes back', () => {
    const { el, ev } = mk({ deltaY: 120 });
    expect(wheelToScroll(el, ev)).toBe(true);
    expect(el.scrollLeft).toBe(120);
    wheelToScroll(el, new WheelEvent('wheel', { deltaY: -50 }));
    expect(el.scrollLeft).toBe(70);
  });

  it('trackpad horizontal gestures scroll too', () => {
    const { el, ev } = mk({ deltaX: 80, deltaY: 4 });
    expect(wheelToScroll(el, ev)).toBe(true);
    expect(el.scrollLeft).toBe(80);
  });

  it('line-based wheels are scaled; nothing happens when nothing overflows', () => {
    const { el, ev } = mk({ deltaY: 3, deltaMode: 1 });
    wheelToScroll(el, ev);
    expect(el.scrollLeft).toBe(96);
    const none = mk({ deltaY: 100 }, false);
    expect(wheelToScroll(none.el, none.ev)).toBe(false);
  });

  it('a wheel over the strip is consumed; elsewhere it is untouched', async () => {
    await open(30);
    const { strip } = layoutStrip();
    const ev = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    strip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(100);
    const other = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    document.body.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
});

describe('active tab reveal', () => {
  it('revealTab scrolls only as far as needed', () => {
    const strip = document.createElement('div');
    Object.defineProperty(strip, 'clientWidth', { value: 600 });
    const tab = document.createElement('div');
    Object.defineProperty(tab, 'offsetLeft', { value: 900, configurable: true });
    Object.defineProperty(tab, 'offsetWidth', { value: 150 });
    revealTab(strip, tab);
    expect(strip.scrollLeft).toBe(450); // right edge flush
    strip.scrollLeft = 800;
    revealTab(strip, tab); // already visible: stays
    expect(strip.scrollLeft).toBe(800);
    Object.defineProperty(tab, 'offsetLeft', { value: 300, configurable: true });
    strip.scrollLeft = 1000;
    revealTab(strip, tab);
    expect(strip.scrollLeft).toBe(300); // left edge flush
  });

  it('closing a tab while the strip is scrolled does not pull it back', async () => {
    await open(30);
    const { strip } = layoutStrip();
    strip.scrollLeft = 800;
    const tabs = useTabs.getState().tabs;
    act(() => useTabs.getState().closeTab(tabs[10]!.id));
    expect(useTabs.getState().tabs).toHaveLength(29);
    expect(strip.scrollLeft).toBe(800);
  });

  it('keyboard navigation reaches tabs beyond the visible area', async () => {
    await open(30);
    act(() => useTabs.getState().activate(useTabs.getState().tabs[0]!.id));
    for (let i = 0; i < 25; i++) act(() => runAction('nextTab'));
    const state = useTabs.getState();
    expect(state.tabs.findIndex((t) => t.id === state.activeId)).toBe(25);
  });
});

describe('reordering with many tabs', () => {
  it('moveTab keeps every tab and session', async () => {
    await open(22);
    const before = useTabs.getState().tabs.map((t) => t.id);
    act(() => useTabs.getState().moveTab(before[21]!, before[0]!));
    const after = useTabs.getState().tabs.map((t) => t.id);
    expect(after[0]).toBe(before[21]);
    expect([...after].sort()).toEqual([...before].sort());
  });
});
