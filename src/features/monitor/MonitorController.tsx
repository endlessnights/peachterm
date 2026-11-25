// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Keeps one backend poller per connected SSH session. Rust decides whether
// monitoring is on (settings + the connection's own choice); this component only
// asks. It never touches the terminal and never starts anything for sessions that
// are not connected, or while the application is locked.

import { useEffect, useRef } from 'react';
import { ipc } from '../../shared/ipc';
import { useConnections } from '../connections/store';
import { useLock } from '../lock/store';
import { useTabs } from '../sessions/store';
import { useSettings } from '../settings/store';
import { useMonitor } from './store';

export function MonitorController() {
  const tabs = useTabs((s) => s.tabs);
  const connections = useConnections((s) => s.tree.connections);
  const monitoring = useSettings((s) => s.settings.monitoring);
  const locked = useLock((s) => s.view?.locked === true);
  // sessionId -> the configuration it was started with
  const running = useRef(new Map<string, string>());

  const desired = new Map<string, string>();
  if (!locked) {
    for (const tab of tabs) {
      if (tab.kind !== 'ssh' || tab.status !== 'connected' || !tab.sessionId) continue;
      const mode = connections.find((c) => c.id === tab.connectionId)?.monitoring ?? 'inherit';
      desired.set(tab.sessionId, `${JSON.stringify(monitoring)}|${mode}`);
    }
  }
  const signature = JSON.stringify([...desired.entries()]);

  useEffect(() => {
    const live = running.current;
    for (const [sid, key] of desired) {
      if (live.get(sid) === key) continue;
      live.set(sid, key);
      useMonitor.getState().begin(sid);
      ipc
        .monitorStart(sid, (event) => {
          if (live.has(sid)) useMonitor.getState().apply(sid, event);
        })
        .then((on) => {
          if (!on) {
            // not enabled for this connection: nothing to show
            useMonitor.getState().drop(sid);
          }
        })
        .catch(() => useMonitor.getState().drop(sid));
    }
    for (const sid of [...live.keys()]) {
      if (desired.has(sid)) continue;
      live.delete(sid);
      useMonitor.getState().drop(sid);
      void ipc.monitorStop(sid).catch(() => undefined);
    }
    // `desired` is derived from `signature`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // The values leave the renderer as soon as the application locks.
  useEffect(() => {
    if (locked) useMonitor.getState().clear();
  }, [locked]);

  useEffect(() => {
    const live = running.current;
    return () => {
      for (const sid of live.keys()) void ipc.monitorStop(sid).catch(() => undefined);
      live.clear();
      useMonitor.getState().clear();
    };
  }, []);

  return null;
}
