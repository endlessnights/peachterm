// Global test setup: xterm.js needs a real layout engine, which jsdom lacks, so
// tests use a small in-memory stand-in that records what the app does to it.

import { vi } from 'vitest';

export interface FakeTerminal {
  cols: number;
  rows: number;
  written: string[];
  pasted: string[];
  selection: string;
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
    handle: FakeTerminal;
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      this.handle = {
        cols: 80,
        rows: 24,
        written: [],
        pasted: [],
        selection: '',
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
