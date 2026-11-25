// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Global test setup: xterm.js needs a real layout engine, which jsdom lacks, so
// tests use a small in-memory stand-in that records what the app does to it.

import { afterEach, vi } from 'vitest';
import { applyLanguagePreference } from '../i18n';

// Tests run in English unless they pick a language; undo any switch afterwards.
applyLanguagePreference('en');
afterEach(() => {
  applyLanguagePreference('en');
});

export interface FakeTerminal {
  cols: number;
  rows: number;
  written: string[];
  /** The options the application set on the terminal (font size etc.). */
  options: Record<string, unknown>;
  pasted: string[];
  selection: string;
  /** Simulate xterm.js selecting text (fires onSelectionChange, like a drag does). */
  select: (text: string) => void;
  clearSelection: () => void;
  /** Simulate the user typing / the terminal reporting a resize. */
  type: (text: string) => void;
  resize: (cols: number, rows: number) => void;
}

const terminals: FakeTerminal[] = [];
export const fakeTerminals = terminals;

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    private dataHandlers: ((text: string) => void)[] = [];
    private resizeHandlers: ((size: { cols: number; rows: number }) => void)[] = [];
    private selectionHandlers: (() => void)[] = [];
    handle: FakeTerminal;
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      this.handle = {
        cols: 80,
        rows: 24,
        written: [],
        options: this.options,
        pasted: [],
        selection: '',
        select: (text) => {
          this.handle.selection = text;
          this.selectionHandlers.forEach((h) => h());
        },
        clearSelection: () => {
          this.handle.selection = '';
          this.selectionHandlers.forEach((h) => h());
        },
        type: (text) => this.dataHandlers.forEach((h) => h(text)),
        resize: (cols, rows) => {
          this.cols = cols;
          this.rows = rows;
          this.resizeHandlers.forEach((h) => h({ cols, rows }));
        },
      };
      terminals.push(this.handle);
    }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {
      const i = terminals.indexOf(this.handle);
      if (i >= 0) terminals.splice(i, 1);
    }
    write(data: string | Uint8Array, callback?: () => void) {
      this.handle.written.push(
        typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array),
      );
      callback?.();
    }
    paste(text: string) {
      this.handle.pasted.push(text);
    }
    getSelection() {
      return this.handle.selection;
    }
    hasSelection() {
      return this.handle.selection.length > 0;
    }
    onSelectionChange(handler: () => void) {
      this.selectionHandlers.push(handler);
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler() {}
    onData(handler: (text: string) => void) {
      this.dataHandlers.push(handler);
      return { dispose: () => undefined };
    }
    onBinary() {
      return { dispose: () => undefined };
    }
    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.resizeHandlers.push(handler);
      return { dispose: () => undefined };
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = vi.fn();
    findPrevious = vi.fn();
    clearDecorations = vi.fn();
  },
}));

// jsdom has no ResizeObserver.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
