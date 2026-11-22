import { describe, expect, it } from 'vitest';
import type { Connection, ConnectionTree, Folder } from '../../shared/types';
import { buildTree, descendantFolderIds, folderPath, type FolderNode } from './tree';

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
  expanded: true,
});

const conn = (
  id: string,
  name: string,
  folderId: string | null,
  host = `${id}.example.com`,
): Connection => ({
  id,
  name,
  host,
  port: 22,
  username: 'root',
  auth: 'password',
  keyPath: null,
  savePassword: false,
  hasStoredSecret: false,
  timeoutSecs: 15,
  initialDirectory: null,
  folderId,
  createdAt: 0,
  updatedAt: 0,
});

const sample: ConnectionTree = {
  version: 1,
  folders: [folder('prod', 'Production'), folder('web', 'Web', 'prod'), folder('lab', 'Lab')],
  connections: [
    conn('w10', 'web-10', 'web'),
    conn('w2', 'web-2', 'web'),
    conn('db', 'database', 'prod', '10.0.0.5'),
    conn('pi', 'raspberry', null),
  ],
};

describe('buildTree', () => {
  it('nests folders and sorts naturally, folders first', () => {
    const nodes = buildTree(sample);
    expect(nodes.map((n) => (n.kind === 'folder' ? n.folder.name : n.connection.name))).toEqual([
      'Lab',
      'Production',
      'raspberry',
    ]);
    const prod = nodes[1] as FolderNode;
    expect(prod.count).toBe(3);
    const web = prod.children[0] as FolderNode;
    expect(web.children.map((n) => n.kind === 'connection' && n.connection.name)).toEqual([
      'web-2',
      'web-10',
    ]);
  });

  it('filters by host, name and user@host keeping ancestor folders', () => {
    const byHost = buildTree(sample, '10.0.0');
    expect(byHost).toHaveLength(1);
    const prod = byHost[0] as FolderNode;
    expect(prod.children).toHaveLength(1);
    expect(buildTree(sample, 'root@raspberry')).toHaveLength(0);
    expect(buildTree(sample, 'root@pi.example')).toHaveLength(1);
  });

  it('keeps all children of a folder whose name matches', () => {
    const nodes = buildTree(sample, 'web');
    const web = (nodes[0] as FolderNode).children[0] as FolderNode;
    expect(web.children).toHaveLength(2);
  });

  it('shows items with dangling folder references at the root', () => {
    const nodes = buildTree({
      version: 1,
      folders: [],
      connections: [conn('x', 'orphan', 'gone')],
    });
    expect(nodes).toHaveLength(1);
  });

  it('scales to thousands of connections', () => {
    const many: ConnectionTree = {
      version: 1,
      folders: [folder('f', 'F')],
      connections: Array.from({ length: 5000 }, (_, i) =>
        conn(`c${i}`, `host-${i}`, i % 2 ? 'f' : null),
      ),
    };
    const started = performance.now();
    buildTree(many, 'host-4');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('folder helpers', () => {
  it('computes descendants and paths', () => {
    expect([...descendantFolderIds(sample.folders, 'prod')].sort()).toEqual(['prod', 'web']);
    expect(folderPath(sample.folders, 'web')).toBe('Production / Web');
    expect(folderPath(sample.folders, null)).toBe('');
  });
});
