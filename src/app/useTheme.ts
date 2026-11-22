import { useEffect } from 'react';
import type { Settings } from '../shared/types';

/** Apply theme + accent to <html>; "system" follows the OS preference live. */
export function useTheme(appearance: Settings['appearance']) {
  const { theme, accent } = appearance;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = accent;
    if (theme !== 'system') {
      root.dataset.theme = theme;
      return;
    }
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      root.dataset.theme = query.matches ? 'light' : 'dark';
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme, accent]);
}
