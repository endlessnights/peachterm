// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import { ipc } from '../../shared/ipc';
import { useLock } from './store';

/**
 * While the inactivity lock is on, tell the backend (at most every 5 s) that
 * the user is active. The timer itself runs in Rust, so a hung or compromised
 * renderer cannot keep the application unlocked by stopping these calls.
 */
export function useActivityTouch() {
  const minutes = useLock((s) =>
    s.view?.enabled && !s.view.locked ? s.view.inactivityMinutes : 0,
  );
  useEffect(() => {
    if (!minutes) return;
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < 5000) return;
      last = now;
      ipc.lockTouch().catch(() => undefined);
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    events.forEach((name) =>
      window.addEventListener(name, touch, { passive: true, capture: true }),
    );
    touch();
    return () =>
      events.forEach((name) => window.removeEventListener(name, touch, { capture: true }));
  }, [minutes]);
}
