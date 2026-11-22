// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetAppliedScale } from '../../app/useInterfaceScale';
import {
  BUNDLED_FONTS,
  RECOMMENDED_FONTS,
  availableFonts,
  buildStack,
  detectInstalled,
  parseFamilies,
  primaryFamily,
  type Measure,
} from '../../shared/fonts';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { TITLE_BAR_PALETTE } from '../../shared/titleBar';
import type { MockOptions, MockSsh } from '../../shared/mockBackend';
import { conn, lastSaved, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { terminalTheme } from '../terminal/theme';
import { useTabs } from '../sessions/store';
import { __resetFontCache } from './FontPicker';

beforeEach(() => {
  __resetAppliedScale();
  __resetFontCache();
});

async function mount(options: MockOptions = {}) {
  const mounted = mountApp({ connections: [conn('a', 'alpha')] }, options);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  return { ...mounted, ssh };
}
async function openPage(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name }));
  return dialog;
}

// ---- Industrial Olive ----------------------------------------------------------------

const luminance = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const oliveTokens = () => {
  const css = readFileSync('src/styles/theme.css', 'utf8');
  const block = css.slice(css.indexOf(":root[data-theme='olive'] {"));
  const token = (name: string) =>
    new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1] ?? '';
  return { token, block };
};

describe('Industrial Olive', () => {
  it('has readable text, controls and accent (WCAG contrast)', () => {
    const { token } = oliveTokens();
    const surfaces = ['--surface-0', '--surface-1', '--surface-2'];
    for (const s of surfaces) {
      expect(contrast(token('--text-1'), token(s)), `text-1 on ${s}`).toBeGreaterThanOrEqual(6);
      expect(contrast(token('--text-2'), token(s)), `text-2 on ${s}`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(token('--text-3'), token(s)),
        `text-3 (hints, disabled) on ${s}`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(
      contrast(token('--accent-text'), token('--accent')),
      'text on accent',
    ).toBeGreaterThanOrEqual(6.5);
    expect(
      contrast(token('--accent'), token('--surface-1')),
      'accent as a highlight',
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(token('--text-1'), token('--surface-4')),
      'selected row',
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--danger'), token('--surface-1')), 'errors').toBeGreaterThanOrEqual(3);
    expect(
      contrast(token('--line-strong'), token('--surface-1')),
      'visible borders',
    ).toBeGreaterThanOrEqual(1.8);
  });

  it('is compact and flat: small radii, no gradients or large shadows', () => {
    const { block } = oliveTokens();
    expect(block).toMatch(/--radius-s:\s*1px/);
    expect(block).toMatch(/--radius-l:\s*2px/);
    const sheet = readFileSync('src/styles/olive.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(sheet).not.toMatch(/gradient/);
    expect(sheet).not.toMatch(/blur\(/);
  });

  it('can be chosen without a restart, previews live, and is saved', async () => {
    const { backend } = await mount();
    expect(document.documentElement.dataset.theme).toBe('dark');
    const dialog = await openPage('Appearance');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Industrial Olive' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('olive'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastSaved(backend)?.appearance.theme).toBe('olive'));
    // Cancel after changing again reverts to the saved theme
    fireEvent.click(within(dialog).getByRole('button', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('olive'));
  });

  it('starts in Olive when it was saved, and the title bar gets its colours', async () => {
    const calls: unknown[] = [];
    mountApp(
      { connections: [] },
      { settings: (s) => ({ ...s, appearance: { ...s.appearance, theme: 'olive' } }) },
      (backend) => {
        const wrapped = (async (command: string, args?: Record<string, unknown>) => {
          if (command === 'window_apply_theme') calls.push(args);
          return backend(command, args);
        }) as typeof backend;
        return Object.assign(wrapped, { saves: backend.saves, ssh: backend.ssh });
      },
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('olive'));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({ theme: 'olive', ...TITLE_BAR_PALETTE.olive }),
    );
  });

  it('keeps the other themes and the accent choice', async () => {
    const { backend } = await mount({
      settings: (s) => ({ ...s, appearance: { ...s.appearance, accent: 'violet' } }),
    });
    const dialog = await openPage('Appearance');
    for (const label of ['Dark', 'Light', 'System']) {
      expect(within(dialog).getByRole('button', { name: label })).toBeTruthy();
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Industrial Olive' }));
    expect(within(dialog).getByText(/uses its own mustard accent/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(lastSaved(backend)?.appearance).toMatchObject({ theme: 'olive', accent: 'violet' }); // accent kept
    expect(document.documentElement.dataset.accent).toBe('violet');
  });

  it('gives the terminal its own matching palette, and leaves Dark exactly as it was', () => {
    const base = { ...DEFAULT_SETTINGS.appearance };
    const dark = terminalTheme({ ...base, theme: 'dark' });
    expect(dark.background).toBe('#121212');
    expect(dark.foreground).toBe('#f1ede8');
    expect(dark.red).toBe('#e06c5f');
    const olive = terminalTheme({ ...base, theme: 'olive' });
    expect(olive.background).toBe('#30392d');
    expect(olive.foreground).toBe('#d8d9c8');
    expect(olive.background).not.toBe('#121212');
  });
});

// ---- Status bar ----------------------------------------------------------------------------

describe('status bar', () => {
  it('is shown by default and can be turned off and on again', async () => {
    const { backend, ssh } = await mount();
    expect(document.querySelector('.statusbar')).toBeTruthy();
    expect(document.querySelector('.app')?.getAttribute('data-statusbar')).toBe('on');
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(ssh.opens).toHaveLength(1));

    const dialog = await openPage('General');
    const box = within(dialog).getByRole('checkbox', {
      name: 'Show status bar',
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(document.querySelector('.statusbar')).toBeNull());
    expect(document.querySelector('.app')?.getAttribute('data-statusbar')).toBe('off');
    expect(lastSaved(backend)?.general.showStatusBar).toBe(false);
    // tracking continues: the tab state is still updated
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
    expect(ssh.closes).toEqual([]);

    const again = await openPage('General');
    fireEvent.click(within(again).getByRole('checkbox', { name: 'Show status bar' }));
    fireEvent.click(within(again).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(document.querySelector('.statusbar')).toBeTruthy());
  });

  it('starts hidden when it was saved hidden, and the layout gives the room back', async () => {
    await mount({ settings: (s) => ({ ...s, general: { ...s.general, showStatusBar: false } }) });
    expect(document.querySelector('.statusbar')).toBeNull();
    const css = readFileSync('src/styles/layout.css', 'utf8');
    expect(css).toMatch(/\.app\[data-statusbar='off'\][^}]*grid-template-rows:\s*1fr;/s);
  });

  it('terminals still resize when the layout changes', async () => {
    const { ssh } = await mount();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(useTabs.getState().tabs[0]?.sessionId).not.toBeNull());
    const dialog = await openPage('General');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Show status bar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    // the extra row is reported by xterm as a resize
    fakeTerminals[0]!.resize(100, 31);
    await waitFor(() => expect(ssh.resizes.at(-1)).toMatchObject({ cols: 100, rows: 31 }));
  });
});

// ---- Fonts ------------------------------------------------------------------------------------------

/** A fake canvas: installed fonts render differently from the generic fallbacks. */
const fakeMeasure = (installed: Record<string, 'mono' | 'proportional'>): Measure => {
  const generic: Record<string, number> = { monospace: 300, serif: 310, 'sans-serif': 305 };
  return (family, text) => {
    const m = /^"([^"]+)",\s*(.+)$/.exec(family);
    const name = m?.[1];
    const base = m ? m[2]! : family;
    const kind = name ? installed[name] : undefined;
    if (kind) {
      if (text.startsWith('i')) return kind === 'mono' ? 50 : 20;
      if (text.startsWith('W')) return kind === 'mono' ? 50 : 80;
      return 1000 + name!.length; // different from every generic family
    }
    if (text.startsWith('i') || text.startsWith('W')) return 50;
    return generic[base] ?? 0;
  };
};

describe('font detection', () => {
  const measure = fakeMeasure({
    Consolas: 'mono',
    'DejaVu Sans Mono': 'mono',
    'Lucida Console': 'proportional',
  });

  it('lists only fonts that are really there and skips proportional ones', () => {
    expect(
      detectInstalled([...RECOMMENDED_FONTS, 'Lucida Console', 'Made Up Mono'], measure),
    ).toEqual(['Consolas', 'DejaVu Sans Mono']);
  });

  it('adds the bundled font, recommended fonts first', () => {
    const list = availableFonts(measure);
    expect(list.map((f) => f.family)).toEqual(['JetBrains Mono', 'Consolas', 'DejaVu Sans Mono']);
    expect(list[0]).toMatchObject({ bundled: true, recommended: true });
    expect(list[1]).toMatchObject({ bundled: false, recommended: true });
    expect(BUNDLED_FONTS).toEqual(['JetBrains Mono']);
  });

  it('finds nothing (instead of guessing) when measuring is impossible', () => {
    expect(detectInstalled(RECOMMENDED_FONTS, () => 0)).toEqual([]);
    // the bundled font is still offered
    expect(availableFonts(() => 0).map((f) => f.family)).toEqual(['JetBrains Mono']);
  });

  it('builds a safe fallback stack: chosen font, bundled font, system fonts, monospace', () => {
    expect(buildStack('Consolas')).toBe(
      'Consolas, "JetBrains Mono", "Cascadia Mono", "DejaVu Sans Mono", Menlo, monospace',
    );
    expect(buildStack('JetBrains Mono').startsWith('"JetBrains Mono", "Cascadia Mono"')).toBe(true);
    expect(buildStack('X').endsWith(', monospace')).toBe(true);
    expect(primaryFamily('"Fira Code", monospace')).toBe('Fira Code');
    expect(parseFamilies(buildStack('Source Code Pro'))[0]).toBe('Source Code Pro');
  });
});

describe('font picker', () => {
  it('lists the bundled font, filters by search, previews in the real font and saves the choice', async () => {
    const { backend } = await mount();
    const dialog = await openPage('Appearance');
    const list = await within(dialog).findByRole('listbox', { name: 'Terminal font' });
    const option = within(list).getByRole('option', { name: /JetBrains Mono/ });
    expect(within(option).getByText('bundled')).toBeTruthy();
    expect(option.querySelector('.font-name')?.getAttribute('style')).toContain('JetBrains Mono');
    // a made-up name is never listed
    fireEvent.change(within(dialog).getByLabelText('Search fonts'), { target: { value: 'zzz' } });
    expect(within(dialog).getByText('No matching font was found.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Search fonts'), {
      target: { value: 'jetbrains' },
    });
    fireEvent.click(within(list).getByRole('option', { name: /JetBrains Mono/ }));
    expect(within(dialog).getByLabelText('Font preview').style.fontFamily).toContain(
      'JetBrains Mono',
    );
    expect(within(dialog).getByLabelText('Font preview').textContent).toContain('Привет');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(lastSaved(backend)?.appearance.terminalFontFamily).toBe(buildStack('JetBrains Mono')),
    );
  });

  it('says so when the saved font is not available instead of pretending', async () => {
    await mount({
      settings: (s) => ({
        ...s,
        appearance: { ...s.appearance, terminalFontFamily: '"Totally Fake Mono", monospace' },
      }),
    });
    const dialog = await openPage('Appearance');
    expect(await within(dialog).findByText(/“Totally Fake Mono” was not found/)).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: /Totally Fake Mono/ })).toBeNull();
  });

  it('carries the licence notice for the bundled font', async () => {
    await mount();
    const dialog = await openPage('Appearance');
    expect(await within(dialog).findByText(/SIL Open Font License/)).toBeTruthy();
    expect(readFileSync('public/licenses/JetBrainsMono-OFL.txt', 'utf8')).toContain(
      'SIL OPEN FONT LICENSE',
    );
  });

  it('the terminal font size stays independent of the font choice and of the interface scale', async () => {
    const { backend } = await mount();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(fakeTerminals).toHaveLength(1));
    const dialog = await openPage('Appearance');
    fireEvent.click(await within(dialog).findByRole('option', { name: /JetBrains Mono/ }));
    await waitFor(() =>
      expect(String(fakeTerminals[0]!.options.fontFamily)).toContain('JetBrains Mono'),
    );
    expect(fakeTerminals[0]!.options.fontSize).toBe(14);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastSaved(backend)?.appearance.terminalFontSize).toBe(14));
  });
});
