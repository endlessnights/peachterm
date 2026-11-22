import { useEffect } from 'react';
import { matchesShortcut, SHORTCUTS } from '../shared/platform';
import { useSettings } from '../features/settings/store';
import { useTabs } from '../features/sessions/store';
import { requestCloseTab } from './actions';
import { openConnectionEditor, openSettings, useDialogs } from './dialogs';

/**
 * Global application shortcuts. Registered in the capture phase so they work
 * while xterm has focus (Phase 2), but they only match chords that terminal
 * programs do not use (see shared/platform.ts).
 */
export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (useDialogs.getState().dialog) return;
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (matchesShortcut(e, SHORTCUTS.settings)) return run(openSettings);
      if (matchesShortcut(e, SHORTCUTS.newConnection)) return run(() => openConnectionEditor(null));
      if (matchesShortcut(e, SHORTCUTS.toggleSidebar))
        return run(() => {
          const { settings, setUi, persistUi } = useSettings.getState();
          setUi({ sidebarVisible: !settings.ui.sidebarVisible });
          void persistUi();
        });
      if (matchesShortcut(e, SHORTCUTS.search))
        return run(() => {
          const { settings, setUi } = useSettings.getState();
          if (!settings.ui.sidebarVisible) setUi({ sidebarVisible: true });
          requestAnimationFrame(() => document.getElementById('sidebar-search')?.focus());
        });
      if (matchesShortcut(e, SHORTCUTS.closeTab))
        return run(() => {
          const id = useTabs.getState().activeId;
          if (id) requestCloseTab(id);
        });
      if (matchesShortcut(e, SHORTCUTS.nextTab))
        return run(() => useTabs.getState().activateNext(e.shiftKey ? -1 : 1));
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
