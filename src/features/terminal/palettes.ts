// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Terminal colour palettes and the rules that pick one.
//
// A palette only provides the BASE colours and the indexed ANSI palette to
// xterm.js. Remote programs keep control of what they print: explicit 256-colour
// and True Colour (RGB) sequences are never remapped, and output is never
// parsed to colourise it.

import type { ITheme } from '@xterm/xterm';
import type { Settings, ThemeMode } from '../../shared/types';

export type TerminalPresetId =
  | 'peachDark'
  | 'peachLight'
  | 'oliveConsole'
  | 'grayConsole'
  | 'classicDark'
  | 'greenPhosphor'
  | 'amberPhosphor'
  | 'oneDark'
  | 'nord'
  | 'solarizedDark';

export type ResolvedAppTheme = 'dark' | 'light' | 'olive' | 'gray';

export interface TerminalPalette {
  id: TerminalPresetId;
  name: string;
  background: string;
  foreground: string;
  /** Absent = the application accent colour (the original PeachTerm look). */
  cursor?: string;
  selectionBackground: string;
  selectionForeground?: string;
  /** black, red, green, yellow, blue, magenta, cyan, white, then the bright eight. */
  ansi: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
}

export const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export const ANSI_NAMES = [
  'Black',
  'Red',
  'Green',
  'Yellow',
  'Blue',
  'Magenta',
  'Cyan',
  'White',
  'Bright black',
  'Bright red',
  'Bright green',
  'Bright yellow',
  'Bright blue',
  'Bright magenta',
  'Bright cyan',
  'Bright white',
] as const;

export const PRESETS: Record<TerminalPresetId, TerminalPalette> = {
  peachDark: {
    id: 'peachDark',
    name: 'PeachTerm Default Dark',
    background: '#121212',
    foreground: '#f1ede8',
    selectionBackground: 'rgba(127, 179, 230, 0.32)',
    ansi: [
      '#1d1c1a',
      '#e06c5f',
      '#86c08f',
      '#e9be6e',
      '#7fb3e6',
      '#c79bd9',
      '#6fcbc4',
      '#d8d2ca',
      '#6f6962',
      '#f28b7d',
      '#a2d6aa',
      '#f3d08d',
      '#9cc6ee',
      '#dab4e8',
      '#8fdcd5',
      '#f6f2ec',
    ],
  },
  peachLight: {
    id: 'peachLight',
    name: 'PeachTerm Default Light',
    background: '#fbfaf8',
    foreground: '#23201d',
    selectionBackground: 'rgba(38, 95, 158, 0.28)',
    ansi: [
      '#23201d',
      '#b83a2a',
      '#2f7d3d',
      '#8d5f00',
      '#265f9e',
      '#8a4a9e',
      '#1e7f78',
      '#8d867e',
      '#5b554e',
      '#d24a38',
      '#3b9a4c',
      '#a87400',
      '#3478c0',
      '#a65fba',
      '#2a9a92',
      '#bdb6ac',
    ],
  },
  oliveConsole: {
    id: 'oliveConsole',
    name: 'Industrial Olive Console',
    background: '#30392d',
    foreground: '#d8d9c8',
    cursor: '#d8c667',
    selectionBackground: '#697458',
    selectionForeground: '#f2f2e4',
    ansi: [
      '#252b24',
      '#c77265',
      '#9daf72',
      '#c9b75a',
      '#829da2',
      '#a79ab2',
      '#8cb8ae',
      '#d8d9c8',
      '#6f7a63',
      '#de8d80',
      '#b5c78b',
      '#dccb70',
      '#9bb5ba',
      '#bdb1c8',
      '#a3cdc3',
      '#eeefdf',
    ],
  },
  grayConsole: {
    id: 'grayConsole',
    name: 'Source Gray Console',
    background: '#38393b',
    foreground: '#e0e1e2',
    cursor: '#f0f0f0',
    selectionBackground: '#656a70',
    selectionForeground: '#ffffff',
    ansi: [
      '#242527',
      '#d27a75',
      '#a5be9c',
      '#d1c18f',
      '#94b3cf',
      '#bea0cc',
      '#96bec4',
      '#e0e1e2',
      '#76787d',
      '#e69a95',
      '#bdd4b4',
      '#e3d6ae',
      '#b0c9de',
      '#d2b9dc',
      '#b2d3d8',
      '#f4f4f5',
    ],
  },
  classicDark: {
    // The classic VGA-style console colours (as in Windows Terminal's "Campbell").
    id: 'classicDark',
    name: 'Classic Dark',
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#ffffff',
    selectionBackground: '#3a5f8f',
    ansi: [
      '#0c0c0c',
      '#c50f1f',
      '#13a10e',
      '#c19c00',
      '#3b78ff',
      '#b5379f',
      '#3a96dd',
      '#cccccc',
      '#767676',
      '#e74856',
      '#16c60c',
      '#f9f1a5',
      '#6a9bff',
      '#e24fcf',
      '#61d6d6',
      '#f2f2f2',
    ],
  },
  greenPhosphor: {
    // Colours only: no CRT effects. Indexed colours stay distinguishable.
    id: 'greenPhosphor',
    name: 'Green Phosphor',
    background: '#06140a',
    foreground: '#5cf47c',
    cursor: '#9dffb2',
    selectionBackground: '#1d5a2c',
    ansi: [
      '#06140a',
      '#e2745f',
      '#5cf47c',
      '#c8e05a',
      '#4fb3c9',
      '#c08ce0',
      '#4fd9b0',
      '#b5e8bf',
      '#2f7a42',
      '#f0937f',
      '#8dffa5',
      '#e0f08a',
      '#7fd0e2',
      '#d6aef0',
      '#86ecc9',
      '#e6ffea',
    ],
  },
  amberPhosphor: {
    id: 'amberPhosphor',
    name: 'Amber Phosphor',
    background: '#150d02',
    foreground: '#ffb43a',
    cursor: '#ffd37a',
    selectionBackground: '#6b4510',
    ansi: [
      '#150d02',
      '#f06a4a',
      '#c8c04a',
      '#ffb43a',
      '#6aa6c9',
      '#d08cc0',
      '#5fc9b0',
      '#f0d9b0',
      '#7d5a1e',
      '#ff8a6c',
      '#dfd86c',
      '#ffcb6a',
      '#8fc0de',
      '#e3a9d6',
      '#86dcc6',
      '#fff1d6',
    ],
  },
  oneDark: {
    id: 'oneDark',
    name: 'One Dark',
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    selectionBackground: '#3e4451',
    ansi: [
      '#282c34',
      '#e06c75',
      '#98c379',
      '#e5c07b',
      '#61afef',
      '#c678dd',
      '#56b6c2',
      '#abb2bf',
      '#5c6370',
      '#e06c75',
      '#98c379',
      '#e5c07b',
      '#61afef',
      '#c678dd',
      '#56b6c2',
      '#ffffff',
    ],
  },
  nord: {
    id: 'nord',
    name: 'Nord',
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    ansi: [
      '#3b4252',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#88c0d0',
      '#e5e9f0',
      '#4c566a',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#8fbcbb',
      '#eceff4',
    ],
  },
  solarizedDark: {
    // Bright black is #586e75 (the official #002b36 would vanish into the background).
    id: 'solarizedDark',
    name: 'Solarized Dark',
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#93a1a1',
    selectionBackground: '#124a58',
    ansi: [
      '#073642',
      '#dc322f',
      '#859900',
      '#b58900',
      '#268bd2',
      '#d33682',
      '#2aa198',
      '#eee8d5',
      '#586e75',
      '#cb4b16',
      '#8a9a5b',
      '#657b83',
      '#839496',
      '#6c71c4',
      '#93a1a1',
      '#fdf6e3',
    ],
  },
};

export const PRESET_ORDER: TerminalPresetId[] = [
  'peachDark',
  'peachLight',
  'oliveConsole',
  'grayConsole',
  'classicDark',
  'greenPhosphor',
  'amberPhosphor',
  'oneDark',
  'nord',
  'solarizedDark',
];

export const isPresetId = (id: unknown): id is TerminalPresetId =>
  typeof id === 'string' && id in PRESETS;

// ---- application theme ↔ terminal palette ----------------------------------------

/** "System" follows the OS light/dark preference. */
export function resolveAppTheme(theme: ThemeMode): ResolvedAppTheme {
  if (theme !== 'system') return theme;
  const light =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  return light ? 'light' : 'dark';
}

const RECOMMENDED: Record<ResolvedAppTheme, TerminalPresetId> = {
  dark: 'peachDark',
  light: 'peachLight',
  olive: 'oliveConsole',
  gray: 'grayConsole',
};

export const recommendedPreset = (theme: ThemeMode): TerminalPresetId =>
  RECOMMENDED[resolveAppTheme(theme)];

type Appearance = Settings['appearance'];

/**
 * The palette a terminal uses: the tab's own choice, else the global one
 * (linked to the application theme, or the manually selected preset).
 */
export function effectivePreset(
  appearance: Appearance,
  sessionPreset: string | null = null,
): TerminalPresetId {
  if (isPresetId(sessionPreset)) return sessionPreset;
  const colors = appearance.terminalColors;
  if (colors.linked && !colors.custom) return recommendedPreset(appearance.theme);
  return isPresetId(colors.preset) ? colors.preset : 'peachDark';
}

/** Where the effective palette comes from, for display. */
export function effectiveSource(appearance: Appearance): 'linked' | 'preset' | 'custom' {
  const colors = appearance.terminalColors;
  if (colors.custom) return 'custom';
  return colors.linked ? 'linked' : 'preset';
}

// ---- colour checks -----------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (value: string): boolean => HEX.test(value.trim());

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text that is hard to read on its background (below this ratio a warning is shown). */
export const MIN_READABLE_CONTRAST = 3;

/** The solid colour of a palette entry (translucent selections are approximated). */
const solid = (value: string): string | null => (isHexColor(value) ? value : null);

// ---- building the xterm theme --------------------------------------------------------

export interface CustomColorsInput {
  background?: string | null;
  foreground?: string | null;
  cursor?: string | null;
  selectionBackground?: string | null;
  ansi?: string[] | null;
}

/** The xterm.js theme for a palette, with optional validated overrides. */
export function buildTheme(
  id: TerminalPresetId,
  custom: CustomColorsInput | null,
  accent: string,
): ITheme {
  const p = PRESETS[id];
  const ok = (v: string | null | undefined) => (v && isHexColor(v) ? v : undefined);
  const background = ok(custom?.background) ?? p.background;
  const foreground = ok(custom?.foreground) ?? p.foreground;
  const ansi =
    custom?.ansi && custom.ansi.length === 16 && custom.ansi.every(isHexColor)
      ? custom.ansi
      : p.ansi;
  const theme: ITheme = {
    background,
    foreground,
    cursor: ok(custom?.cursor) ?? p.cursor ?? accent,
    cursorAccent: background,
    selectionBackground: ok(custom?.selectionBackground) ?? p.selectionBackground,
  };
  if (p.selectionForeground && !custom?.selectionBackground) {
    theme.selectionForeground = p.selectionForeground;
  }
  ANSI_KEYS.forEach((key, i) => {
    theme[key] = ansi[i];
  });
  return theme;
}

/** Problems worth telling the user about (never fixed silently). */
export function readabilityWarning(background: string, foreground: string): string | null {
  const bg = solid(background);
  const fg = solid(foreground);
  if (!bg || !fg) return null;
  return contrastRatio(bg, fg) < MIN_READABLE_CONTRAST
    ? 'Text and background are too similar to read comfortably.'
    : null;
}
