import { useEffect } from 'react';
import { useRecording } from '../features/settings/shortcutState';
import { useSettings } from '../features/settings/store';
import {
  ACTION_IDS,
  effectiveBindings,
  isTerminalUnsafe,
  isWebViewDefault,
  matchesCombo,
  parseAccelerator,
  sameCombo,
  type ActionId,
  type Combo,
} from '../shared/shortcuts';
import { runAction } from './commands';
import { useDialogs } from './dialogs';

interface Entry {
  id: ActionId;
  combo: Combo;
  /** Fires even while a terminal has focus (a `Ctrl+Shift+x` stand-in for `Ctrl+x`). */
  alias: boolean;
}

/**
 * Builds the lookup table from the user's bindings. Bare `Ctrl+letter` chords
 * belong to terminal programs, so they are skipped while a terminal has focus;
 * each of them also gets a `Ctrl+Shift+letter` alias that works everywhere
 * (unless that combination is taken or reserved).
 */
export function buildTable(overrides: Record<string, string>): Entry[] {
  const table: Entry[] = [];
  const bindings = effectiveBindings(overrides);
  for (const id of ACTION_IDS) {
    const parsed = bindings[id] ? parseAccelerator(bindings[id]) : null;
    if (parsed?.ok) table.push({ id, combo: parsed.combo, alias: false });
  }
  for (const entry of [...table]) {
    if (!isTerminalUnsafe(entry.combo) || !entry.combo.ctrl || entry.combo.shift) continue;
    const alias = { ...entry.combo, shift: true };
    const parsedReserved = parseAccelerator(`Mod+Shift+${entry.combo.key}`);
    if (!parsedReserved.ok || table.some((t) => sameCombo(t.combo, alias))) continue;
    if (isWebViewDefault(syntheticEvent(alias))) continue;
    table.push({ id: entry.id, combo: alias, alias: true });
  }
  return table;
}

const syntheticEvent = (c: Combo) =>
  ({
    ctrlKey: c.ctrl,
    metaKey: c.meta,
    shiftKey: c.shift,
    altKey: c.alt,
    code: /^[A-Z]$/.test(c.key) ? `Key${c.key}` : c.key,
    key: c.key,
  }) as KeyboardEvent;

const inTerminal = (target: EventTarget | null) =>
  target instanceof Element && target.closest('[data-terminal]') !== null;

/**
 * Global application shortcuts. They exist only while the window is focused
 * (a DOM listener, never an OS-wide hotkey). Terminal input is preserved:
 * keys that terminal programs use are passed through while a terminal has
 * focus. Browser defaults that would disrupt the app (reload, print, zoom,
 * developer tools, find) are suppressed.
 */
export function useShortcuts() {
  const overrides = useSettings((s) => s.settings.shortcuts);
  const recording = useRecording((s) => s.recording);

  useEffect(() => {
    if (recording) return;
    const table = buildTable(overrides);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) {
        if (isWebViewDefault(e)) e.preventDefault();
        return;
      }
      const terminal = inTerminal(e.target);
      const hit = table.find(
        (t) => matchesCombo(e, t.combo) && (t.alias || !terminal || !isTerminalUnsafe(t.combo)),
      );
      if (hit && !useDialogs.getState().dialog) {
        e.preventDefault();
        e.stopPropagation();
        runAction(hit.id);
        return;
      }
      if (!terminal && isWebViewDefault(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [overrides, recording]);
}
