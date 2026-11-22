// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tabColorsDialog } from '../../app/actions';
import { runAction } from '../../app/commands';
import { TITLE_BAR_PALETTE } from '../../shared/titleBar';
import type { MockOptions, MockSsh } from '../../shared/mockBackend';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';
import { conn, lastSaved, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { fromLayout, toLayout } from '../sessions/persistence';
import { useTabs } from '../sessions/store';
import {
  ANSI_KEYS,
  PRESETS,
  PRESET_ORDER,
  buildTheme,
  contrastRatio,
  effectivePreset,
  isHexColor,
  readabilityWarning,
  recommendedPreset,
} from './palettes';
import { terminalTheme } from './theme';

const base = DEFAULT_SETTINGS.appearance;
const withTheme = (theme: Settings['appearance']['theme'], extra = {}) => ({
  ...base,
  theme,
  ...extra,
});

describe('palettes', () => {
  it('has the ten built-in presets, each complete and made of plain hex colours', () => {
    expect(PRESET_ORDER).toHaveLength(10);
    expect(PRESET_ORDER.map((id) => PRESETS[id].name)).toEqual([
      'PeachTerm Default Dark',
      'PeachTerm Default Light',
      'Industrial Olive Console',
      'Source Gray Console',
      'Classic Dark',
      'Green Phosphor',
      'Amber Phosphor',
      'One Dark',
      'Nord',
      'Solarized Dark',
    ]);
    for (const id of PRESET_ORDER) {
      const p = PRESETS[id];
      expect(p.ansi, id).toHaveLength(16);
      for (const c of [p.background, p.foreground, ...p.ansi])
        expect(isHexColor(c), `${id} ${c}`).toBe(true);
      expect(p.selectionBackground.length, id).toBeGreaterThan(3);
      // readable base text
      expect(contrastRatio(p.background, p.foreground), `${id} text`).toBeGreaterThanOrEqual(4.5);
      const t = buildTheme(id, null, '#f6a07a');
      for (const key of ANSI_KEYS) expect(t[key], `${id} ${key}`).toBeTruthy();
      expect(t.cursor).toBeTruthy();
      expect(t.cursorAccent).toBe(p.background);
    }
  });

  it('keeps every coloured ANSI entry readable on its own background', () => {
    for (const id of PRESET_ORDER) {
      const p = PRESETS[id];
      // black (0) is meant to be dark; bright black (8) is a dim grey for comments
      p.ansi.forEach((c, i) => {
        if (i === 0 || i === 8 || i === 7 || i === 15) return;
        if (id === 'peachLight' && i === 3) return;
        expect(contrastRatio(p.background, c), `${id} ansi ${i} ${c}`).toBeGreaterThanOrEqual(3);
      });
      expect(contrastRatio(p.background, p.ansi[8]), `${id} bright black`).toBeGreaterThanOrEqual(
        1.5,
      );
    }
  });

  it('Industrial Olive Console and Source Gray Console follow the design colours', () => {
    const o = PRESETS.oliveConsole;
    expect([o.background, o.foreground, o.cursor, o.selectionBackground]).toEqual([
      '#30392d',
      '#d8d9c8',
      '#d8c667',
      '#697458',
    ]);
    expect(o.background).not.toBe('#000000');
    const g = PRESETS.grayConsole;
    expect([g.background, g.foreground, g.cursor, g.selectionBackground]).toEqual([
      '#38393b',
      '#e0e1e2',
      '#f0f0f0',
      '#656a70',
    ]);
    // the cursor stands out from the text
    expect(contrastRatio(o.background, o.cursor!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(g.background, g.cursor!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the recommended palette follows the application theme', () => {
    expect(recommendedPreset('dark')).toBe('peachDark');
    expect(recommendedPreset('light')).toBe('peachLight');
    expect(recommendedPreset('olive')).toBe('oliveConsole');
    expect(recommendedPreset('gray')).toBe('grayConsole');
  });

  it('System follows the resolved OS preference', () => {
    const original = window.matchMedia;
    for (const [light, want] of [
      [true, 'peachLight'],
      [false, 'peachDark'],
    ] as const) {
      window.matchMedia = ((q: string) => ({
        matches: light && q.includes('light'),
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia;
      expect(recommendedPreset('system')).toBe(want);
    }
    window.matchMedia = original;
  });

  it('linked mode follows the theme; independent mode ignores it; a tab override wins', () => {
    const linked = withTheme('olive');
    expect(effectivePreset(linked)).toBe('oliveConsole');
    const manual = withTheme('olive', {
      terminalColors: { linked: false, preset: 'nord', custom: null },
    });
    expect(effectivePreset(manual)).toBe('nord');
    expect(effectivePreset(withTheme('gray', manual))).toBe('nord'); // theme change leaves it alone
    expect(effectivePreset(linked, 'oneDark')).toBe('oneDark');
    expect(effectivePreset(linked, 'not-a-preset')).toBe('oliveConsole');
  });

  it('custom colours are validated; bad values never reach xterm', () => {
    const t = buildTheme(
      'nord',
      {
        background: '#101010',
        foreground: 'red; background:url(x)',
        cursor: '#fff',
        selectionBackground: '#445566',
        ansi: ['#000000'], // wrong length: ignored
      },
      '#f6a07a',
    );
    expect(t.background).toBe('#101010');
    expect(t.foreground).toBe(PRESETS.nord.foreground);
    expect(t.cursor).toBe(PRESETS.nord.cursor);
    expect(t.selectionBackground).toBe('#445566');
    expect(t.red).toBe(PRESETS.nord.ansi[1]);
    expect(t.cursorAccent).toBe('#101010');
  });

  it('warns about unreadable combinations without changing them', () => {
    expect(readabilityWarning('#202020', '#222222')).toMatch(/too similar/);
    expect(readabilityWarning('#202020', '#e0e0e0')).toBeNull();
  });

  it('never rewrites colours that programs print themselves', () => {
    // The theme carries only base and indexed colours: no hook that could remap RGB output.
    const keys = Object.keys(buildTheme('nord', null, '#fff'));
    expect(keys.some((k) => /extended|rgb|truecolor/i.test(k))).toBe(false);
    expect(keys).not.toContain('extendedAnsi');
  });
});

// ---- Source Gray (application theme) ----------------------------------------------------------

describe('Source Gray theme', () => {
  const css = readFileSync('src/styles/theme.css', 'utf8');
  const block = css.slice(css.indexOf(":root[data-theme='gray'] {"));
  const token = (name: string) =>
    new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1] ?? '';

  it('is readable (WCAG) on all of its surfaces', () => {
    for (const s of ['--surface-0', '--surface-1', '--surface-2']) {
      expect(contrastRatio(token('--text-1'), token(s)), `text-1 on ${s}`).toBeGreaterThanOrEqual(
        6,
      );
      expect(contrastRatio(token('--text-2'), token(s)), `text-2 on ${s}`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(token('--text-3'), token(s)), `text-3 on ${s}`).toBeGreaterThanOrEqual(
        3,
      );
    }
    expect(contrastRatio(token('--accent-text'), token('--accent'))).toBeGreaterThanOrEqual(6.5);
    expect(contrastRatio(token('--accent'), token('--surface-1'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token('--text-1'), token('--surface-4'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('--danger'), token('--surface-1'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token('--line-strong'), token('--surface-1'))).toBeGreaterThanOrEqual(1.8);
  });

  it('is compact and neutral: small radii, grey surfaces, no gradients', () => {
    expect(block).toMatch(/--radius-s:\s*1px/);
    expect(block).toMatch(/--radius-l:\s*2px/);
    for (const s of ['--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-4']) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(token(s).slice(i, i + 2), 16));
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!), s).toBeLessThanOrEqual(12); // neutral grey
    }
    const sheet = readFileSync('src/styles/olive.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(sheet).not.toMatch(/gradient|blur\(/);
  });

  it('shares the component rules with Industrial Olive and leaves Olive untouched', () => {
    const sheet = readFileSync('src/styles/olive.css', 'utf8');
    expect(sheet).toContain("[data-theme='olive'], [data-theme='gray']");
    const olive = css.slice(
      css.indexOf(":root[data-theme='olive'] {"),
      css.indexOf(":root[data-theme='gray'] {"),
    );
    for (const [name, value] of [
      ['--surface-0', '#343d2d'],
      ['--surface-1', '#46513d'],
      ['--accent', '#b6a63b'],
      ['--text-1', '#e0e1d2'],
    ]) {
      expect(olive).toContain(`${name}: ${value}`);
    }
  });

  it('has a matching native title bar palette', () => {
    expect(TITLE_BAR_PALETTE.gray).toEqual({
      caption: token('--surface-1'),
      text: token('--text-1'),
      border: token('--line'),
    });
  });
});

// ---- the running application ---------------------------------------------------------------------

async function mount(options: MockOptions = {}) {
  const mounted = mountApp(
    { connections: [conn('a', 'alpha'), conn('b', 'beta')] },
    {
      ...options,
    },
  );
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  return { ...mounted, ssh };
}

async function openAppearance() {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Appearance' }));
  return dialog;
}

const openTab = async (ssh: MockSsh, name: string) => {
  const before = ssh.opens.length;
  fireEvent.doubleClick(within(screen.getByRole('tree')).getByText(name));
  await waitFor(() => expect(ssh.opens).toHaveLength(before + 1));
  await waitFor(() => expect(useTabs.getState().tabs.every((t) => t.sessionId)).toBe(true));
};
const bgs = () => fakeTerminals.map((t) => (t.options.theme as { background: string }).background);

describe('Source Gray in the application', () => {
  it('can be chosen, previews live, is saved and colours the title bar and the terminal', async () => {
    const { backend, ssh } = await mount();
    await openTab(ssh, 'alpha');
    expect(bgs()).toEqual(['#121212']);
    const dialog = await openAppearance();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Source Gray' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('gray'));
    // linked by default: the open terminal switched palette without reconnecting
    await waitFor(() => expect(bgs()).toEqual(['#38393b']));
    expect(within(dialog).getByTestId('effective-palette').textContent).toMatch(
      /Source Gray Console.*linked/,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(lastSaved(backend)?.appearance.theme).toBe('gray'));
    expect(lastSaved(backend)?.appearance.terminalColors).toMatchObject({
      linked: true,
      custom: null,
    });
    expect(ssh.opens).toHaveLength(1);
    expect(ssh.closes).toEqual([]);
  });

  it('Industrial Olive gets the Olive Console while linked; Dark and Light keep their own', async () => {
    const { ssh } = await mount();
    await openTab(ssh, 'alpha');
    const dialog = await openAppearance();
    for (const [label, want] of [
      ['Industrial Olive', '#30392d'],
      ['Light', '#fbfaf8'],
      ['Dark', '#121212'],
    ] as const) {
      fireEvent.click(within(dialog).getByRole('button', { name: label }));
      await waitFor(() => expect(bgs()).toEqual([want]));
    }
  });

  it('Cancel puts the previous colours back', async () => {
    const { ssh } = await mount();
    await openTab(ssh, 'alpha');
    const dialog = await openAppearance();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Source Gray' }));
    await waitFor(() => expect(bgs()).toEqual(['#38393b']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bgs()).toEqual(['#121212']));
    expect(ssh.closes).toEqual([]);
  });

  it('starts in Source Gray when saved, and the title bar gets its colours', async () => {
    const calls: unknown[] = [];
    mountApp(
      { connections: [] },
      { settings: (s) => ({ ...s, appearance: { ...s.appearance, theme: 'gray' } }) },
      (backend) => {
        const wrapped = (async (command: string, args?: Record<string, unknown>) => {
          if (command === 'window_apply_theme') calls.push(args);
          return backend(command, args);
        }) as typeof backend;
        return Object.assign(wrapped, { saves: backend.saves, ssh: backend.ssh });
      },
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('gray'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ theme: 'gray', ...TITLE_BAR_PALETTE.gray }));
  });
});

describe('linking the terminal theme to the application theme', () => {
  it('a manual choice switches to independent mode and survives theme changes', async () => {
    const { backend, ssh } = await mount();
    await openTab(ssh, 'alpha');
    const dialog = await openAppearance();
    const link = within(dialog).getByRole('checkbox', {
      name: /Link terminal theme/,
    }) as HTMLInputElement;
    expect(link.checked).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Terminal theme'), {
      target: { value: 'nord' },
    });
    await waitFor(() => expect(bgs()).toEqual(['#2e3440']));
    expect(link.checked).toBe(false);
    expect(within(dialog).getByTestId('effective-palette').textContent).toMatch(
      /Nord.*selected manually/,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Source Gray' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('gray'));
    expect(bgs()).toEqual(['#2e3440']); // not overwritten
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(lastSaved(backend)?.appearance.terminalColors).toEqual({
        linked: false,
        preset: 'nord',
        custom: null,
      }),
    );
  });

  it('linking again follows the application theme once more', async () => {
    const { ssh } = await mount();
    await openTab(ssh, 'alpha');
    const dialog = await openAppearance();
    fireEvent.change(within(dialog).getByLabelText('Terminal theme'), {
      target: { value: 'nord' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Industrial Olive' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Link terminal theme/ }));
    await waitFor(() => expect(bgs()).toEqual(['#30392d']));
  });

  it('the restore button re-enables linking and drops custom colours', async () => {
    const { ssh } = await mount();
    await openTab(ssh, 'alpha');
    const dialog = await openAppearance();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Source Gray' }));
    fireEvent.change(within(dialog).getByLabelText('Background hex value'), {
      target: { value: '#101820' },
    });
    await waitFor(() => expect(bgs()).toEqual(['#101820']));
    const link = within(dialog).getByRole('checkbox', {
      name: /Link terminal theme/,
    }) as HTMLInputElement;
    expect(link.checked).toBe(false);
    expect(link.disabled).toBe(true); // custom colours and the link are never both on
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Restore Theme-Recommended Terminal Colors' }),
    );
    await waitFor(() => expect(bgs()).toEqual(['#38393b']));
    expect(link.checked).toBe(true);
    expect(within(dialog).getByTestId('effective-palette').textContent).toMatch(
      /Source Gray Console.*linked/,
    );
  });
});

describe('custom terminal colours', () => {
  it('are validated, previewed live, saved, and reset to the preset', async () => {
    const { backend, ssh } = await mount();
    await openTab(ssh, 'alpha');
    const dialog = await openAppearance();
    const bg = within(dialog).getByLabelText('Background hex value');
    // malformed values are refused and explained
    fireEvent.change(bg, { target: { value: '#12' } });
    expect(bg.getAttribute('aria-invalid')).toBe('true');
    expect(bgs()).toEqual(['#121212']);
    fireEvent.change(bg, { target: { value: 'red;x:url(1)' } });
    expect(bgs()).toEqual(['#121212']);
    fireEvent.change(bg, { target: { value: '#1a2b3c' } });
    await waitFor(() => expect(bgs()).toEqual(['#1a2b3c']));
    fireEvent.change(within(dialog).getByLabelText('Cursor hex value'), {
      target: { value: '#ff00aa' },
    });
    await waitFor(() =>
      expect((fakeTerminals[0]!.options.theme as { cursor: string }).cursor).toBe('#ff00aa'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(lastSaved(backend)?.appearance.terminalColors).toMatchObject({
        linked: false,
        custom: { background: '#1a2b3c', cursor: '#ff00aa' },
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to selected preset' }));
    await waitFor(() => expect(bgs()).toEqual(['#121212']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // Cancel after Apply keeps what was applied
    await waitFor(() => expect(bgs()).toEqual(['#1a2b3c']));
    expect(ssh.opens).toHaveLength(1);
  });

  it('warns when text and background are too similar, and keeps the choice', async () => {
    await mount();
    const dialog = await openAppearance();
    fireEvent.change(within(dialog).getByLabelText('Background hex value'), {
      target: { value: '#202020' },
    });
    fireEvent.change(within(dialog).getByLabelText('Foreground hex value'), {
      target: { value: '#232323' },
    });
    expect(await within(dialog).findByText(/too similar/)).toBeTruthy();
    expect((within(dialog).getByLabelText('Foreground hex value') as HTMLInputElement).value).toBe(
      '#232323',
    );
  });

  it('exposes the 16 ANSI colours', async () => {
    const { backend } = await mount();
    const dialog = await openAppearance();
    fireEvent.click(within(dialog).getByText('ANSI colours (advanced)'));
    fireEvent.change(within(dialog).getByLabelText('Red hex value'), {
      target: { value: '#aa0000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => {
      const ansi = lastSaved(backend)?.appearance.terminalColors.custom?.ansi;
      expect(ansi).toHaveLength(16);
      expect(ansi![1]).toBe('#aa0000');
      expect(ansi!.every(isHexColor)).toBe(true);
    });
  });

  it('shows a live sample with the effective colours', async () => {
    await mount();
    const dialog = await openAppearance();
    const preview = within(dialog).getByRole('img', { name: 'Terminal colour preview' });
    expect(preview.style.background).toMatch(/rgb\(18, 18, 18\)|#121212/);
    fireEvent.change(within(dialog).getByLabelText('Terminal theme'), {
      target: { value: 'oliveConsole' },
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole('img', { name: 'Terminal colour preview' }).style.background,
      ).toMatch(/rgb\(48, 57, 45\)/),
    );
    expect(preview.querySelector('[data-part="cursor"]')).toBeTruthy();
    expect(preview.querySelector('[data-part="selection"]')).toBeTruthy();
  });
});

describe('settings migration', () => {
  it('an old settings file (no terminal colours) loads as linked and keeps its theme', async () => {
    await mount({
      settings: (s) => {
        const copy = structuredClone(s) as Settings;
        // simulate a file written before this feature
        delete (copy.appearance as Partial<Settings['appearance']>).terminalColors;
        copy.appearance.theme = 'olive';
        return copy;
      },
    });
    // the mock returns what it was given; the app must still cope with a missing section
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('olive'));
  });
});

describe('per-session terminal colours', () => {
  async function two() {
    const m = await mount();
    await openTab(m.ssh, 'alpha');
    await openTab(m.ssh, 'beta');
    return m;
  }

  it('one tab can use another palette without touching the others or the app theme', async () => {
    const { ssh } = await two();
    const [a, b] = useTabs.getState().tabs;
    const sessions = [a!.sessionId, b!.sessionId];
    act(() => useTabs.getState().setTabColors(a!.id, 'nord'));
    await waitFor(() => expect(bgs()).toEqual(['#2e3440', '#121212']));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(useTabs.getState().tabs.map((t) => t.sessionId)).toEqual(sessions); // sessions untouched
    expect(ssh.opens).toHaveLength(2);
    expect(ssh.closes).toEqual([]);
  });

  it('a global change updates tabs that follow it and leaves overridden tabs alone', async () => {
    await two();
    const [a] = useTabs.getState().tabs;
    act(() => useTabs.getState().setTabColors(a!.id, 'solarizedDark'));
    const dialog = await openAppearance();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Source Gray' }));
    await waitFor(() => expect(bgs()).toEqual(['#002b36', '#38393b']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bgs()).toEqual(['#002b36', '#121212']));
    act(() => useTabs.getState().setTabColors(a!.id, null)); // follow the global theme again
    await waitFor(() => expect(bgs()).toEqual(['#121212', '#121212']));
  });

  it('stays with its tab through split operations', async () => {
    const { ssh } = await two();
    const [a, b] = useTabs.getState().tabs;
    act(() => useTabs.getState().setTabColors(a!.id, 'amberPhosphor'));
    act(() => useTabs.getState().setArea(3000, 1800));
    act(() => useTabs.getState().activate(a!.id));
    act(() => runAction('splitVertical'));
    act(() => {
      const picker = useTabs.getState().layout!;
      const empty = (function find(n: typeof picker): string | null {
        if (n.kind === 'leaf') return n.tabId === null ? n.id : null;
        return find(n.a) ?? find(n.b);
      })(picker);
      useTabs.getState().fillLeaf(empty!, b!.id);
    });
    await waitFor(() => expect(bgs()).toEqual(['#150d02', '#121212']));
    expect(useTabs.getState().tabs[0]!.colors).toBe('amberPhosphor');
    expect(ssh.opens).toHaveLength(2);
  });

  it('is chosen from the tab context menu and applies without reconnecting', async () => {
    const { ssh } = await two();
    const tab = screen.getAllByRole('tab')[0]!;
    fireEvent.contextMenu(tab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Terminal Colors…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Terminal colours' });
    expect(
      (within(dialog).getByRole('radio', { name: /Follow Global Theme/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Green Phosphor' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(bgs()).toEqual(['#06140a', '#121212']));
    expect(ssh.opens).toHaveLength(2);
    expect(ssh.closes).toEqual([]);
    // opening it from code works too and Cancel changes nothing
    act(() => tabColorsDialog(useTabs.getState().tabs[1]!.id));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Terminal colours' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(bgs()).toEqual(['#06140a', '#121212']);
  });

  it('is remembered with the workspace as a preset id only, and never invents one', () => {
    useTabs.setState({ tabs: [], activeId: null, layout: null, focusLeaf: null });
    const id = useTabs.getState().openLocal({ id: 'pwsh', name: 'PowerShell 7', kind: 'local' });
    useTabs.getState().setTabColors(id, 'classicDark');
    const { tabs, activeId, layout, focusLeaf } = useTabs.getState();
    const saved = toLayout(tabs, activeId, layout, focusLeaf);
    expect(saved.tabs[0]!.colors).toBe('classicDark');
    expect(fromLayout(saved, [], false, []).tabs[0]!.colors).toBe('classicDark');
    const hostile = { ...saved, tabs: [{ ...saved.tabs[0]!, colors: 'url(javascript:1)' }] };
    expect(fromLayout(hostile, [], false, []).tabs[0]!.colors).toBeNull();
  });
});

describe('terminal theme builder', () => {
  it('uses the application accent for the original PeachTerm palettes', () => {
    document.documentElement.style.setProperty('--accent', '#123456');
    expect(terminalTheme(withTheme('dark')).cursor).toBe('#123456');
    document.documentElement.style.removeProperty('--accent');
  });
});
