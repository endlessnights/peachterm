// Tab metadata only. Terminal output never flows through this store; in
// Phase 2 each tab's xterm instance receives bytes directly from a Tauri
// Channel. `sessionId` is the backend's per-connection-attempt id.

import { create } from 'zustand';
import type { Connection, Uuid } from '../../shared/types';

export type TabStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface Tab {
  id: string;
  connectionId: Uuid;
  title: string;
  subtitle: string;
  status: TabStatus;
  /** Set by Rust when a connection attempt starts; new on every reconnect. */
  sessionId: string | null;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  openTab: (connection: Connection) => string;
  closeTab: (id: string) => void;
  activate: (id: string) => void;
  activateNext: (direction: 1 | -1) => void;
  moveTab: (fromId: string, toId: string) => void;
  setStatus: (id: string, status: TabStatus) => void;
  setSession: (id: string, sessionId: string | null) => void;
  /** Keep tab titles in sync when a saved connection is edited or removed. */
  syncConnections: (connections: Connection[]) => void;
}

let counter = 0;
const newTabId = () => `tab-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const isActiveStatus = (status: TabStatus) =>
  status === 'connected' || status === 'connecting';

const describe = (c: Connection) =>
  `${c.username ? `${c.username}@` : ''}${c.host}${c.port === 22 ? '' : `:${c.port}`}`;

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,

  openTab: (connection) => {
    // Multiple tabs per server are allowed: each one is an independent session.
    const id = newTabId();
    const tab: Tab = {
      id,
      connectionId: connection.id,
      title: connection.name,
      subtitle: describe(connection),
      status: 'idle',
      sessionId: null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
      }
      return { tabs, activeId };
    }),

  activate: (id) => {
    if (get().tabs.some((t) => t.id === id)) set({ activeId: id });
  },

  activateNext: (direction) => {
    const { tabs, activeId } = get();
    if (tabs.length === 0) return;
    const index = tabs.findIndex((t) => t.id === activeId);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next) set({ activeId: next.id });
  },

  moveTab: (fromId, toId) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === fromId);
      const to = s.tabs.findIndex((t) => t.id === toId);
      if (from === -1 || to === -1 || from === to) return s;
      const tabs = s.tabs.slice();
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved!);
      return { tabs };
    }),

  setStatus: (id, status) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)) })),

  setSession: (id, sessionId) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sessionId } : t)) })),

  syncConnections: (connections) =>
    set((s) => {
      const byId = new Map(connections.map((c) => [c.id, c]));
      let changed = false;
      const tabs = s.tabs.map((t) => {
        const c = byId.get(t.connectionId);
        if (!c) return t; // deleted connection: keep the tab, it still works until closed
        const subtitle = describe(c);
        if (c.name === t.title && subtitle === t.subtitle) return t;
        changed = true;
        return { ...t, title: c.name, subtitle };
      });
      return changed ? { tabs } : s;
    }),
}));
