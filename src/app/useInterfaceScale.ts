import { useEffect } from 'react';
import { ipc } from '../shared/ipc';

let lastApplied: number | undefined;

/**
 * Applies the interface scale as the WebView's own zoom (set from Rust), so
 * hit testing, pointer coordinates, menus and drag-and-drop stay correct and
 * the operating system's display scaling is left alone. Terminals notice the
 * viewport change through their ResizeObserver and refit (and resize the PTY).
 * `undefined` = settings not loaded yet (nothing to do).
 */
export function useInterfaceScale(percent: number | undefined) {
  useEffect(() => {
    if (percent === undefined || percent === lastApplied) return;
    lastApplied = percent;
    ipc.windowApplyScale(percent).catch(() => {
      lastApplied = undefined; // retry on the next change
    });
  }, [percent]);
}

/** Test hook. */
export const __resetAppliedScale = () => {
  lastApplied = undefined;
};
