import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../../shared/types';
import { useTabs } from './store';

const connection = (id: string, name = id): Connection => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'admin',
  auth: 'password',
  keyPath: null,
  savePassword: false,
  hasStoredSecret: false,
  timeoutSecs: 15,
  initialDirectory: null,
  folderId: null,
  createdAt: 0,
  updatedAt: 0,
});

describe('tabs store', () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));

  it('opens several independent tabs for the same server', () => {
    const a = useTabs.getState().openTab(connection('srv'));
    const b = useTabs.getState().openTab(connection('srv'));
    expect(a).not.toBe(b);
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(useTabs.getState().activeId).toBe(b);
    expect(useTabs.getState().tabs[0]!.subtitle).toBe('admin@srv.example.com');
  });

  it('activates the neighbour when the active tab closes', () => {
    const s = useTabs.getState();
    const a = s.openTab(connection('a'));
    const b = s.openTab(connection('b'));
    const c = s.openTab(connection('c'));
    useTabs.getState().activate(b);
    useTabs.getState().closeTab(b);
    expect(useTabs.getState().activeId).toBe(c);
    useTabs.getState().closeTab(c);
    expect(useTabs.getState().activeId).toBe(a);
    useTabs.getState().closeTab(a);
    expect(useTabs.getState().activeId).toBeNull();
  });

  it('reorders tabs', () => {
    const s = useTabs.getState();
    const a = s.openTab(connection('a'));
    const b = s.openTab(connection('b'));
    const c = s.openTab(connection('c'));
    useTabs.getState().moveTab(a, c);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([b, c, a]);
  });

  it('cycles through tabs', () => {
    const s = useTabs.getState();
    const a = s.openTab(connection('a'));
    s.openTab(connection('b'));
    useTabs.getState().activateNext(1);
    expect(useTabs.getState().activeId).toBe(a);
    useTabs.getState().activateNext(-1);
    expect(useTabs.getState().tabs.at(-1)!.id).toBe(useTabs.getState().activeId);
  });

  it('follows connection renames', () => {
    useTabs.getState().openTab(connection('a', 'old'));
    useTabs.getState().syncConnections([{ ...connection('a', 'new'), port: 2222 }]);
    expect(useTabs.getState().tabs[0]!.title).toBe('new');
    expect(useTabs.getState().tabs[0]!.subtitle).toBe('admin@a.example.com:2222');
  });
});
