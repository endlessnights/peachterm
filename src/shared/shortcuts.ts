// Keyboard shortcut model: accelerator parsing, event matching, formatting and
// validation. Actions, defaults and reserved combinations live in
// shortcutDefaults.json, which the Rust backend reads too (it re-validates
// everything on save).
//
// Accelerator syntax: `Mod` (Ctrl on Windows/Linux, Cmd on macOS), `Ctrl`,
// `Alt`, `Shift`, `Meta`, then a key, joined by `+`, e.g. `Mod+Shift+L`, `F2`.
// Keys are matched by physical position (`KeyboardEvent.code`), so shortcuts
// keep working on non-Latin keyboard layouts.

import definitions from './shortcutDefaults.json';

export type ActionId =
  | 'newTab'
  | 'newConnection'
  | 'closeTab'
  | 'openSettings'
  | 'toggleSidebar'
  | 'searchConnections'
  | 'terminalSearch'
  | 'rename'
  | 'lockApp'
  | 'nextTab'
  | 'prevTab';

export const ACTION_LABELS: Record<ActionId, string> = {
  newTab: 'New terminal tab',
  newConnection: 'New saved connection',
  closeTab: 'Close active tab',
  openSettings: 'Settings',
  toggleSidebar: 'Toggle sidebar',
  searchConnections: 'Search connections',
  terminalSearch: 'Search in terminal',
  rename: 'Rename selected connection/folder',
  lockApp: 'Lock application',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
};

export const ACTION_IDS = definitions.actions.map((a) => a.id) as ActionId[];

export const DEFAULT_BINDINGS: Record<ActionId, string> = Object.fromEntries(
  definitions.actions.map((a) => [a.id, a.default]),
) as Record<ActionId, string>;

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const NAMED_KEYS = [
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];
const PUNCTUATION = ",./;'[]\\-=`";
const CODE_PUNCTUATION: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

const isFunctionKey = (key: string, max = 24) => {
  const m = /^F(\d{1,2})$/.exec(key);
  return !!m && Number(m[1]) >= 1 && Number(m[1]) <= max;
};

function keyIsValid(key: string): boolean {
  if (key.length === 1) return /[A-Z0-9]/.test(key) || PUNCTUATION.includes(key);
  return NAMED_KEYS.includes(key) || isFunctionKey(key);
}

export type ParseResult =
  { ok: true; combo: Combo; canonical: string } | { ok: false; error: string };

export function parseAccelerator(accel: string, mac = isMac()): ParseResult {
  const parts = accel.split('+');
  const key = parts[parts.length - 1] ?? '';
  const modifiers = parts.slice(0, -1);
  if (!keyIsValid(key)) return { ok: false, error: `unsupported key "${key}"` };
  const on = { Mod: false, Ctrl: false, Alt: false, Shift: false, Meta: false };
  for (const m of modifiers) {
    if (!(m in on)) return { ok: false, error: `unknown modifier "${m}"` };
    if (on[m as keyof typeof on]) return { ok: false, error: 'a modifier is repeated' };
    on[m as keyof typeof on] = true;
  }
  if (modifiers.length === 0 && !isFunctionKey(key, 12)) {
    return { ok: false, error: 'needs at least one modifier key (only F1–F12 may be used alone)' };
  }
  const canonical = [
    ...(['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const).filter((m) => on[m]),
    key,
  ].join('+');
  return {
    ok: true,
    canonical,
    combo: {
      ctrl: on.Ctrl || (on.Mod && !mac),
      meta: on.Meta || (on.Mod && mac),
      alt: on.Alt,
      shift: on.Shift,
      key,
    },
  };
}

/** The key part of an event, independent of keyboard layout. `null` for modifier-only. */
export function eventKey(e: Pick<KeyboardEvent, 'code' | 'key'>): string | null {
  const { code } = e;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1]!;
  if (code in CODE_PUNCTUATION) return CODE_PUNCTUATION[code]!;
  if (isFunctionKey(code)) return code;
  if (NAMED_KEYS.includes(code)) return code;
  if (code === 'Space' || e.key === ' ') return 'Space';
  return null;
}

export function matchesCombo(e: KeyboardEvent, combo: Combo): boolean {
  return (
    e.ctrlKey === combo.ctrl &&
    e.altKey === combo.alt &&
    e.shiftKey === combo.shift &&
    e.metaKey === combo.meta &&
    eventKey(e) === combo.key
  );
}

/** Canonical accelerator for a pressed key combination (used by the recorder). */
export function eventToAccelerator(e: KeyboardEvent, mac = isMac()): string | null {
  const key = eventKey(e);
  if (!key) return null;
  const mods: string[] = [];
  // The platform's primary modifier is stored as `Mod` so settings are portable.
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (mac && e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mac && e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

export function formatAccelerator(accel: string, mac = isMac()): string {
  if (!accel) return 'Not set';
  const parts = accel.split('+');
  const key = parts.pop() ?? '';
  const keyLabel = key.startsWith('Arrow') ? key.slice(5) : key === 'Escape' ? 'Esc' : key;
  if (mac) {
    const sym: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta'];
    const mods = [...parts].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return mods.map((m) => sym[m] ?? m).join('') + keyLabel;
  }
  const names: Record<string, string> = { Mod: 'Ctrl', Meta: 'Win' };
  return [...parts.map((m) => names[m] ?? m), keyLabel].join('+');
}

/**
 * Terminal programs (shells, vim, tmux, mc, htop…) consume these keys, so the
 * application does not intercept them while a terminal has focus: bare
 * Ctrl+letter (control characters), Alt+key (readline/meta) and plain F-keys.
 */
export function isTerminalUnsafe(combo: Combo, mac = isMac()): boolean {
  const control = combo.ctrl && !combo.alt && !combo.shift && !combo.meta;
  if (control && (/^[A-Z]$/.test(combo.key) || '[]\\'.includes(combo.key))) return true;
  if (combo.alt && !combo.ctrl && !combo.meta) return true;
  if (!combo.ctrl && !combo.alt && !combo.shift && !combo.meta && isFunctionKey(combo.key, 12)) {
    return true;
  }
  void mac;
  return false;
}

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];

/** The same accelerator with Shift added (`Mod+W` -> `Mod+Shift+W`). */
export function withShift(accel: string): string {
  const parts = accel.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  mods.add('Shift');
  return [...[...mods].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b)), key].join('+');
}

export type Bindings = Partial<Record<ActionId, string>>;

export function effectiveBindings(overrides: Record<string, string>): Record<ActionId, string> {
  return Object.fromEntries(
    ACTION_IDS.map((id) => [id, overrides[id] ?? DEFAULT_BINDINGS[id]]),
  ) as Record<ActionId, string>;
}

export interface Problem {
  action: string;
  kind: 'invalid' | 'reserved' | 'conflict';
  message: string;
}

function reservedReason(combo: Combo, mac: boolean): string | null {
  const lists = mac ? [definitions.reserved, definitions.reservedMac] : [definitions.reserved];
  for (const list of lists) {
    for (const entry of list) {
      const parsed = parseAccelerator(entry.accel, mac);
      if (parsed.ok && sameCombo(parsed.combo, combo)) return entry.reason;
    }
  }
  if (!mac && combo.meta) return 'uses the Windows/Super key, which the operating system owns';
  return null;
}

export const sameCombo = (a: Combo, b: Combo) =>
  a.ctrl === b.ctrl &&
  a.alt === b.alt &&
  a.shift === b.shift &&
  a.meta === b.meta &&
  a.key === b.key;

/** Same rules as the Rust validator, for instant feedback in the UI. */
export function checkBindings(overrides: Record<string, string>, mac = isMac()): Problem[] {
  const problems: Problem[] = [];
  const seen: { combo: Combo; action: ActionId }[] = [];
  for (const id of ACTION_IDS) {
    const accel = overrides[id] ?? DEFAULT_BINDINGS[id];
    if (!accel) continue;
    const parsed = parseAccelerator(accel, mac);
    if (!parsed.ok) {
      problems.push({ action: id, kind: 'invalid', message: `Invalid shortcut: ${parsed.error}` });
      continue;
    }
    const reason = reservedReason(parsed.combo, mac);
    if (reason) {
      problems.push({ action: id, kind: 'reserved', message: `Reserved: it ${reason}.` });
      continue;
    }
    const clash = seen.find((s) => sameCombo(s.combo, parsed.combo));
    if (clash) {
      problems.push({
        action: id,
        kind: 'conflict',
        message: `Already used by “${ACTION_LABELS[clash.action]}”.`,
      });
    } else {
      seen.push({ combo: parsed.combo, action: id });
    }
  }
  return problems;
}

/** The first free, valid combination that keeps the user's intent (adds Shift/Alt). */
export function suggestAlternative(
  accel: string,
  overrides: Record<string, string>,
  action: ActionId,
  mac = isMac(),
): string | null {
  const parsed = parseAccelerator(accel, mac);
  if (!parsed.ok) return null;
  const parts = parsed.canonical.split('+');
  const key = parts.pop()!;
  const base = new Set(parts);
  const candidates: string[][] = [];
  if (!base.has('Shift')) candidates.push([...base, 'Shift']);
  if (!base.has('Alt')) candidates.push([...base, 'Alt']);
  candidates.push([...base, 'Shift', 'Alt']);
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
  for (const mods of candidates) {
    const candidate = [...mods]
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .concat(key)
      .join('+');
    const trial = { ...overrides, [action]: candidate };
    const p = parseAccelerator(candidate, mac);
    if (!p.ok || isTerminalUnsafe(p.combo, mac)) continue;
    if (checkBindings(trial, mac).every((x) => x.action !== action)) return candidate;
  }
  return null;
}

/** Keys the WebView would otherwise act on (reload, devtools, print, zoom…). */
export function isWebViewDefault(e: KeyboardEvent, mac = isMac()): boolean {
  const key = eventKey(e);
  if (!key) return false;
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (key === 'F5' || key === 'F12') return !e.altKey;
  if (mod && !e.altKey) {
    if (['R', 'P', 'U', 'F', 'G', 'S', 'O', '0', '=', '-'].includes(key)) return true;
    if (e.shiftKey && ['I', 'J', 'C', 'R'].includes(key)) return true;
  }
  return false;
}
