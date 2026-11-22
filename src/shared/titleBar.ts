// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Colours for the native title bar. They come from the same CSS tokens the UI
// uses (`--surface-1`, `--text-1`, `--line`) so the title bar blends into the
// tab bar in every theme/accent. The fallback table mirrors theme.css (a test
// keeps them equal) and is also what Rust applies before the UI has loaded.

export type ResolvedTheme = 'dark' | 'light' | 'olive' | 'gray';

export interface TitleBarColors {
  caption: string;
  text: string;
  border: string;
}

export const TITLE_BAR_PALETTE: Record<ResolvedTheme, TitleBarColors> = {
  dark: { caption: '#181817', text: '#f1ede8', border: '#2d2b28' },
  light: { caption: '#f3f1ee', text: '#23201d', border: '#e1ddd7' },
  olive: { caption: '#46513d', text: '#e0e1d2', border: '#2a3124' },
  gray: { caption: '#585b5d', text: '#f2f3f3', border: '#35373a' },
};

const HEX = /^#[0-9a-f]{6}$/i;

/** `#rrggbb` from a computed CSS colour (`#rrggbb` or `rgb(r, g, b)`), else null. */
export function toHex(value: string): string | null {
  const v = value.trim();
  if (HEX.test(v)) return v.toLowerCase();
  const m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(v);
  if (!m) return null;
  const channel = (s: string) => Math.min(255, Number(s)).toString(16).padStart(2, '0');
  return `#${channel(m[1]!)}${channel(m[2]!)}${channel(m[3]!)}`;
}

export function titleBarColors(theme: ResolvedTheme, root: HTMLElement = document.documentElement) {
  const style = getComputedStyle(root);
  const read = (token: string, fallback: string) =>
    toHex(style.getPropertyValue(token)) ?? fallback;
  const palette = TITLE_BAR_PALETTE[theme];
  return {
    caption: read('--surface-1', palette.caption),
    text: read('--text-1', palette.text),
    border: read('--line', palette.border),
  } satisfies TitleBarColors;
}
