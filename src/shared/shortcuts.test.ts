// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import definitions from './shortcutDefaults.json';
import {
  ACTION_IDS,
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  checkBindings,
  effectiveBindings,
  eventToAccelerator,
  formatAccelerator,
  isTerminalUnsafe,
  isWebViewDefault,
  matchesCombo,
  parseAccelerator,
  suggestAlternative,
  withShift,
} from './shortcuts';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
const parse = (accel: string, mac = false) => {
  const p = parseAccelerator(accel, mac);
  if (!p.ok) throw new Error(p.error);
  return p;
};

describe('definitions', () => {
  it('every action has a label and a default; ids match the shared JSON', () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual([...ACTION_IDS].sort());
    expect(ACTION_IDS).toEqual(definitions.actions.map((a) => a.id));
    for (const id of ACTION_IDS) expect(DEFAULT_BINDINGS[id]).toBeTruthy();
  });

  it('ships the requested defaults', () => {
    expect(DEFAULT_BINDINGS).toMatchObject({
      newTab: 'Mod+T',
      newConnection: 'Mod+N',
      closeTab: 'Mod+W',
      openSettings: 'Mod+,',
      toggleSidebar: 'Mod+B',
      searchConnections: 'Mod+Shift+F',
      rename: 'F2',
      lockApp: 'Mod+Shift+L',
    });
  });

  it('defaults are valid, unique and unreserved on every platform', () => {
    for (const mac of [false, true]) expect(checkBindings({}, mac)).toEqual([]);
  });
});

describe('parsing and formatting', () => {
  it('resolves Mod per platform and canonicalizes order', () => {
    expect(parse('Mod+Shift+L').combo).toMatchObject({ ctrl: true, meta: false, shift: true });
    expect(parse('Mod+Shift+L', true).combo).toMatchObject({
      ctrl: false,
      meta: true,
      shift: true,
    });
    expect(parse('Mod+Shift+Alt+L').canonical).toBe('Mod+Alt+Shift+L');
  });

  it('rejects malformed accelerators and keys without a modifier', () => {
    for (const bad of ['', 'L', 'Mod+', 'Mod+Mod+L', 'Hyper+L', 'Mod+l', 'Shift', 'Mod+F25']) {
      expect(parseAccelerator(bad, false).ok, bad).toBe(false);
    }
    expect(parseAccelerator('F2', false).ok).toBe(true);
    expect(parseAccelerator('F13', false).ok).toBe(false); // only F1-F12 may stand alone
  });

  it('formats for Windows/Linux and macOS conventions', () => {
    expect(formatAccelerator('Mod+Shift+L', false)).toBe('Ctrl+Shift+L');
    expect(formatAccelerator('Mod+Shift+L', true)).toBe('⇧⌘L');
    expect(formatAccelerator('F2', false)).toBe('F2');
    expect(formatAccelerator('', false)).toBe('Not set');
    expect(withShift('Mod+W')).toBe('Mod+Shift+W');
  });
});

describe('event matching', () => {
  it('matches by physical key, so other keyboard layouts keep working', () => {
    const combo = parse('Mod+T').combo;
    // Russian layout: the key labelled "е" sits where T is.
    expect(matchesCombo(key({ code: 'KeyT', key: 'е', ctrlKey: true }), combo)).toBe(true);
    expect(
      matchesCombo(key({ code: 'KeyT', key: 't', ctrlKey: true, shiftKey: true }), combo),
    ).toBe(false);
    expect(matchesCombo(key({ code: 'KeyT', key: 't', ctrlKey: true, altKey: true }), combo)).toBe(
      false,
    );
    expect(matchesCombo(key({ code: 'KeyY', key: 'y', ctrlKey: true }), combo)).toBe(false);
  });

  it('matches punctuation, function and named keys', () => {
    expect(
      matchesCombo(key({ code: 'Comma', key: ',', ctrlKey: true }), parse('Mod+,').combo),
    ).toBe(true);
    expect(matchesCombo(key({ code: 'F2', key: 'F2' }), parse('F2').combo)).toBe(true);
    expect(
      matchesCombo(
        key({ code: 'Tab', key: 'Tab', ctrlKey: true, shiftKey: true }),
        parse('Ctrl+Shift+Tab').combo,
      ),
    ).toBe(true);
  });

  it('the recorder produces canonical accelerators and ignores modifier-only presses', () => {
    expect(
      eventToAccelerator(key({ code: 'KeyK', key: 'k', ctrlKey: true, shiftKey: true }), false),
    ).toBe('Mod+Shift+K');
    expect(
      eventToAccelerator(key({ code: 'KeyK', key: 'k', metaKey: true, shiftKey: true }), true),
    ).toBe('Mod+Shift+K');
    expect(eventToAccelerator(key({ code: 'KeyK', key: 'k', ctrlKey: true }), true)).toBe('Ctrl+K');
    expect(
      eventToAccelerator(key({ code: 'ControlLeft', key: 'Control', ctrlKey: true }), false),
    ).toBeNull();
    expect(
      eventToAccelerator(key({ code: 'Digit5', key: '5', ctrlKey: true, altKey: true }), false),
    ).toBe('Mod+Alt+5');
  });
});

describe('validation', () => {
  it('detects duplicates, including Mod/Ctrl aliasing, and names the other action', () => {
    const problems = checkBindings({ closeTab: 'Mod+T' }, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ action: 'closeTab', kind: 'conflict' });
    expect(problems[0]!.message).toContain('New terminal tab');
    expect(checkBindings({ closeTab: 'Ctrl+T' }, false)).toHaveLength(1);
    expect(checkBindings({ closeTab: 'Ctrl+T' }, true)).toHaveLength(0);
  });

  it('allows swapping and unassigning', () => {
    expect(checkBindings({ newTab: 'Mod+W', closeTab: 'Mod+T' }, false)).toEqual([]);
    expect(checkBindings({ newTab: '', closeTab: 'Mod+T' }, false)).toEqual([]);
  });

  it('refuses reserved combinations with a reason', () => {
    for (const accel of ['F5', 'F12', 'Mod+R', 'Mod+Shift+I', 'Alt+F4', 'Mod+P', 'Mod+0']) {
      const p = checkBindings({ lockApp: accel }, false);
      expect(
        p.some((x) => x.action === 'lockApp' && x.kind === 'reserved'),
        accel,
      ).toBe(true);
    }
    expect(checkBindings({ lockApp: 'Meta+Q' }, true)[0]!.message).toContain('macOS');
    expect(checkBindings({ lockApp: 'Meta+L' }, false)[0]!.kind).toBe('reserved');
  });

  it('suggests a free alternative that is also safe in terminals', () => {
    const alt = suggestAlternative('Mod+T', { closeTab: 'Mod+T' }, 'closeTab', false);
    expect(alt).toBe('Mod+Shift+T');
    expect(suggestAlternative('Mod+Shift+L', { newTab: 'Mod+Shift+L' }, 'newTab', false)).toBe(
      'Mod+Alt+Shift+L',
    );
  });

  it('effectiveBindings overlays overrides on the defaults', () => {
    expect(effectiveBindings({ lockApp: 'Mod+Shift+K' }).lockApp).toBe('Mod+Shift+K');
    expect(effectiveBindings({}).lockApp).toBe('Mod+Shift+L');
  });
});

describe('terminal safety', () => {
  it('flags keys that terminal programs consume', () => {
    for (const accel of ['Mod+W', 'Mod+T', 'Mod+B', 'Alt+X', 'F2']) {
      expect(isTerminalUnsafe(parse(accel).combo, false), accel).toBe(true);
    }
    for (const accel of ['Mod+Shift+W', 'Mod+Shift+L', 'Mod+,', 'Ctrl+Tab', 'Mod+Alt+L']) {
      expect(isTerminalUnsafe(parse(accel).combo, false), accel).toBe(false);
    }
    // On macOS Cmd shortcuts never reach the terminal.
    expect(isTerminalUnsafe(parse('Mod+W', true).combo, true)).toBe(false);
  });

  it('suppresses web view defaults that would disrupt the app', () => {
    expect(isWebViewDefault(key({ code: 'F5', key: 'F5' }), false)).toBe(true);
    expect(isWebViewDefault(key({ code: 'KeyR', key: 'r', ctrlKey: true }), false)).toBe(true);
    expect(isWebViewDefault(key({ code: 'KeyP', key: 'p', ctrlKey: true }), false)).toBe(true);
    expect(isWebViewDefault(key({ code: 'KeyF', key: 'f', ctrlKey: true }), false)).toBe(true);
    expect(
      isWebViewDefault(key({ code: 'KeyI', key: 'I', ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
    expect(isWebViewDefault(key({ code: 'KeyW', key: 'w', ctrlKey: true }), false)).toBe(false);
    expect(isWebViewDefault(key({ code: 'KeyA', key: 'a', ctrlKey: true }), false)).toBe(false);
  });
});

describe('new split and tab actions (migration safety)', () => {
  const NEW = [
    'duplicateTab',
    'splitVertical',
    'splitHorizontal',
    'toggleSplitOrientation',
    'focusNextPane',
    'unsplit',
  ] as const;

  it('have valid, unreserved, mutually conflict-free defaults that never steal terminal keys', () => {
    expect(checkBindings({})).toEqual([]);
    for (const id of NEW) {
      const parsed = parse(DEFAULT_BINDINGS[id]);
      expect(isTerminalUnsafe(parsed.combo), id).toBe(false);
      expect(ACTION_LABELS[id], id).toBeTruthy();
    }
    const combos = NEW.map((id) => parse(DEFAULT_BINDINGS[id]).canonical);
    expect(new Set(combos).size).toBe(NEW.length);
  });

  it('are bound when the user has no clashing binding', () => {
    const bindings = effectiveBindings({});
    for (const id of NEW) expect(bindings[id]).toBe(DEFAULT_BINDINGS[id]);
  });

  it('are left unassigned instead of overriding a binding the user already uses', () => {
    const mine = { closeTab: DEFAULT_BINDINGS.duplicateTab, newTab: 'Mod+Shift+O' };
    const bindings = effectiveBindings(mine);
    expect(bindings.closeTab).toBe(DEFAULT_BINDINGS.duplicateTab); // the user's choice wins
    expect(bindings.newTab).toBe('Mod+Shift+O');
    expect(bindings.duplicateTab).toBe('');
    expect(bindings.splitHorizontal).toBe('');
    expect(bindings.splitVertical).toBe(DEFAULT_BINDINGS.splitVertical);
    // nothing is double-bound after the migration
    expect(checkBindings(bindings)).toEqual([]);
  });

  it('an explicit "unassigned" stays unassigned and frees the combination for others', () => {
    const bindings = effectiveBindings({
      duplicateTab: '',
      closeTab: DEFAULT_BINDINGS.duplicateTab,
    });
    expect(bindings.duplicateTab).toBe('');
    expect(bindings.closeTab).toBe(DEFAULT_BINDINGS.duplicateTab);
  });
});
