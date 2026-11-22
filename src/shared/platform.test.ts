import { describe, expect, it } from 'vitest';
import { matchesShortcut, shortcutLabel, SHORTCUTS } from './platform';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('matchesShortcut', () => {
  it('never steals bare Ctrl chords from the terminal on Windows/Linux', () => {
    expect(matchesShortcut(key({ key: 'w', ctrlKey: true }), SHORTCUTS.closeTab, false)).toBe(
      false,
    );
    expect(matchesShortcut(key({ key: 'b', ctrlKey: true }), SHORTCUTS.toggleSidebar, false)).toBe(
      false,
    );
    expect(
      matchesShortcut(key({ key: 'W', ctrlKey: true, shiftKey: true }), SHORTCUTS.closeTab, false),
    ).toBe(true);
  });

  it('uses Cmd on macOS', () => {
    expect(matchesShortcut(key({ key: 'w', metaKey: true }), SHORTCUTS.closeTab, true)).toBe(true);
    expect(matchesShortcut(key({ key: 'w', ctrlKey: true }), SHORTCUTS.closeTab, true)).toBe(false);
  });

  it('allows the bare chord only where declared safe', () => {
    expect(matchesShortcut(key({ key: ',', ctrlKey: true }), SHORTCUTS.settings, false)).toBe(true);
  });

  it('formats labels per platform', () => {
    expect(shortcutLabel(SHORTCUTS.closeTab, false)).toBe('Ctrl+Shift+W');
    expect(shortcutLabel(SHORTCUTS.closeTab, true)).toBe('⌘W');
  });
});
