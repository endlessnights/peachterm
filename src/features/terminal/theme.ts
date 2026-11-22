// xterm colours follow the application theme (CSS variables on <html>).

import type { ITheme } from '@xterm/xterm';

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const DARK_ANSI = {
  black: '#1d1c1a',
  red: '#e06c5f',
  green: '#86c08f',
  yellow: '#e9be6e',
  blue: '#7fb3e6',
  magenta: '#c79bd9',
  cyan: '#6fcbc4',
  white: '#d8d2ca',
  brightBlack: '#6f6962',
  brightRed: '#f28b7d',
  brightGreen: '#a2d6aa',
  brightYellow: '#f3d08d',
  brightBlue: '#9cc6ee',
  brightMagenta: '#dab4e8',
  brightCyan: '#8fdcd5',
  brightWhite: '#f6f2ec',
};

const LIGHT_ANSI = {
  black: '#23201d',
  red: '#b83a2a',
  green: '#2f7d3d',
  yellow: '#8d5f00',
  blue: '#265f9e',
  magenta: '#8a4a9e',
  cyan: '#1e7f78',
  white: '#8d867e',
  brightBlack: '#5b554e',
  brightRed: '#d24a38',
  brightGreen: '#3b9a4c',
  brightYellow: '#a87400',
  brightBlue: '#3478c0',
  brightMagenta: '#a65fba',
  brightCyan: '#2a9a92',
  brightWhite: '#bdb6ac',
};

export function terminalTheme(): ITheme {
  const light = document.documentElement.dataset.theme === 'light';
  const accent = css('--accent', '#f6a07a');
  return {
    ...(light ? LIGHT_ANSI : DARK_ANSI),
    background: css('--surface-0', light ? '#fbfaf8' : '#121212'),
    foreground: css('--text-1', light ? '#23201d' : '#f1ede8'),
    cursor: accent,
    cursorAccent: css('--surface-0', light ? '#fbfaf8' : '#121212'),
    selectionBackground: light ? 'rgba(38, 95, 158, 0.28)' : 'rgba(127, 179, 230, 0.32)',
  };
}
