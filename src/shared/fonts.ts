// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Terminal font choices. Nothing here guesses: a font is offered as "installed"
// only when the WebView actually renders it differently from its fallbacks,
// and the bundled font is marked as such.

export interface FontChoice {
  family: string;
  bundled: boolean;
  /** Part of the recommended terminal fonts. */
  recommended: boolean;
}

/** Recommended terminal fonts, best first (the bundled one leads). */
export const RECOMMENDED_FONTS = [
  'JetBrains Mono',
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Menlo',
  'Monaco',
] as const;

/** Other well-known monospace fonts that are offered when they are present. */
export const OTHER_MONO_FONTS = [
  'SF Mono',
  'Fira Code',
  'Fira Mono',
  'Source Code Pro',
  'Ubuntu Mono',
  'Noto Sans Mono',
  'Roboto Mono',
  'IBM Plex Mono',
  'Hack',
  'Inconsolata',
  'Lucida Console',
  'Courier New',
  'Andale Mono',
  'Droid Sans Mono',
  'Anonymous Pro',
] as const;

/** Bundled with the application (SIL Open Font License; notice in docs/fonts.md). */
export const BUNDLED_FONTS: readonly string[] = ['JetBrains Mono'];

/** Always-present generic fallback. */
export const GENERIC_MONOSPACE = 'monospace';

/** Text that exercises Latin, Cyrillic, box drawing and symbols. */
export const PREVIEW_TEXT = 'Привет, мир! The quick brown fox 0Oo 1lI |{}[]<> → ✓ ─│┌┐';

export type Measure = (family: string, text: string) => number;

const PROBE = 'mmmmmmmmmmlliWWWИИШШ0O1l';
const BASES = ['monospace', 'serif', 'sans-serif'];

/** Width of `text` in `family`, measured on a canvas (0 when no canvas is available). */
export const canvasMeasure: Measure = (family, text) => {
  if (typeof document === 'undefined') return 0;
  const ctx = document.createElement('canvas').getContext?.('2d');
  if (!ctx) return 0;
  ctx.font = `72px ${family}`;
  return ctx.measureText(text).width;
};

/**
 * The fonts among `candidates` that really are installed: with the candidate
 * first and a generic family as fallback the text has a different width than
 * the generic family alone for at least one generic base. Candidates that are
 * not monospace (the "i" and "W" differ in width) are left out.
 */
export function detectInstalled(
  candidates: readonly string[],
  measure: Measure = canvasMeasure,
): string[] {
  const baseWidths = BASES.map((base) => measure(base, PROBE));
  if (baseWidths.every((w) => w === 0)) return [];
  return candidates.filter((family) => {
    const differs = BASES.some(
      (base, i) => measure(`"${family}", ${base}`, PROBE) !== baseWidths[i],
    );
    if (!differs) return false;
    const narrow = measure(`"${family}", monospace`, 'iiiiiiiiii');
    const wide = measure(`"${family}", monospace`, 'WWWWWWWWWW');
    return Math.abs(narrow - wide) < 0.5;
  });
}

/** Installed + bundled fonts, recommended ones first, in a stable order. */
export function availableFonts(measure: Measure = canvasMeasure): FontChoice[] {
  const installed = new Set(detectInstalled([...RECOMMENDED_FONTS, ...OTHER_MONO_FONTS], measure));
  for (const bundled of BUNDLED_FONTS) installed.add(bundled);
  const recommended = RECOMMENDED_FONTS.filter((f) => installed.has(f)).map((family) => ({
    family,
    bundled: BUNDLED_FONTS.includes(family),
    recommended: true,
  }));
  const others = OTHER_MONO_FONTS.filter((f) => installed.has(f)).map((family) => ({
    family,
    bundled: false,
    recommended: false,
  }));
  return [...recommended, ...others];
}

/** Families of a CSS font list, unquoted: `"A", B, monospace` → [A, B, monospace]. */
export function parseFamilies(stack: string): string[] {
  return stack
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** The font the terminal will use first. */
export const primaryFamily = (stack: string): string | null => parseFamilies(stack)[0] ?? null;

const quote = (family: string) =>
  family === GENERIC_MONOSPACE || /^[A-Za-z][A-Za-z0-9-]*$/.test(family) ? family : `"${family}"`;

/**
 * The stored font list for a choice: the chosen font, then the bundled font
 * (so Unicode and Cyrillic always render), then common system fonts, and the
 * generic `monospace` as the final fallback.
 */
export function buildStack(primary: string): string {
  const families = [
    primary,
    ...BUNDLED_FONTS,
    'Cascadia Mono',
    'Consolas',
    'DejaVu Sans Mono',
    'Menlo',
    GENERIC_MONOSPACE,
  ];
  const seen = new Set<string>();
  return families
    .filter((f) => (seen.has(f) ? false : (seen.add(f), true)))
    .map(quote)
    .join(', ');
}
