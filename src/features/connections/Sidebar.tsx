import { memo, useCallback, useMemo, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { reportError } from '../../components/Toasts';
import {
  connect,
  duplicateConnection,
  newFolder,
  renameFolder,
  requestDeleteConnection,
  requestDeleteFolder,
} from '../../app/actions';
import { AppButtons } from '../../app/AppButtons';
import { openConnectionEditor } from '../../app/dialogs';
import type { Connection, Folder } from '../../shared/types';
import { useTabs, type TabStatus } from '../sessions/store';
import { useConnections } from './store';
import { buildTree, type TreeNode } from './tree';

type MenuTarget =
  | { kind: 'connection'; connection: Connection }
  | { kind: 'folder'; folder: Folder }
  | { kind: 'empty' };

const STATUS_RANK: Record<TabStatus, number> = {
  connected: 4,
  connecting: 3,
  failed: 2,
  disconnected: 1,
  idle: 0,
};

/** Best status among all tabs of each connection (for the sidebar dot). */
function useConnectionStatuses(): Map<string, TabStatus> {
  const tabs = useTabs((s) => s.tabs);
  return useMemo(() => {
    const map = new Map<string, TabStatus>();
    for (const tab of tabs) {
      const current = map.get(tab.connectionId);
      if (!current || STATUS_RANK[tab.status] > STATUS_RANK[current]) {
        map.set(tab.connectionId, tab.status);
      }
    }
    return map;
  }, [tabs]);
}

export function Sidebar({ width }: { width: number }) {
  const tree = useConnections((s) => s.tree);
  const query = useConnections((s) => s.query);
  const setQuery = useConnections((s) => s.setQuery);
  const selectedId = useConnections((s) => s.selectedId);
  const select = useConnections((s) => s.select);
  const toggleFolder = useConnections((s) => s.toggleFolder);
  const statuses = useConnectionStatuses();
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);

  const nodes = useMemo(() => buildTree(tree, query), [tree, query]);
  const searching = query.trim().length > 0;

  const openMenu = useCallback((e: React.MouseEvent, target: MenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  const onToggle = useCallback(
    (folder: Folder) => {
      toggleFolder(folder.id).catch(reportError);
    },
    [toggleFolder],
  );

  const menuEntries = (target: MenuTarget): MenuEntry[] => {
    switch (target.kind) {
      case 'connection': {
        const c = target.connection;
        return [
          { kind: 'item', label: 'Connect', icon: 'plug', onSelect: () => connect(c) },
          { kind: 'separator' },
          { kind: 'item', label: 'Edit…', icon: 'edit', onSelect: () => openConnectionEditor(c) },
          {
            kind: 'item',
            label: 'Duplicate',
            icon: 'copy',
            onSelect: () => duplicateConnection(c),
          },
          { kind: 'separator' },
          {
            kind: 'item',
            label: 'Delete',
            icon: 'trash',
            danger: true,
            onSelect: () => requestDeleteConnection(c),
          },
        ];
      }
      case 'folder': {
        const f = target.folder;
        return [
          {
            kind: 'item',
            label: 'New connection here…',
            icon: 'plus',
            onSelect: () => openConnectionEditor(null, f.id),
          },
          {
            kind: 'item',
            label: 'New sub-folder…',
            icon: 'folderPlus',
            onSelect: () => newFolder(f.id),
          },
          { kind: 'separator' },
          { kind: 'item', label: 'Rename…', icon: 'edit', onSelect: () => renameFolder(f) },
          {
            kind: 'item',
            label: 'Delete folder',
            icon: 'trash',
            danger: true,
            onSelect: () => requestDeleteFolder(f),
          },
        ];
      }
      case 'empty':
        return [
          {
            kind: 'item',
            label: 'New connection…',
            icon: 'plus',
            onSelect: () => openConnectionEditor(null),
          },
          {
            kind: 'item',
            label: 'New folder…',
            icon: 'folderPlus',
            onSelect: () => newFolder(null),
          },
        ];
    }
  };

  return (
    <aside className="sidebar" style={{ width }} aria-label="Saved connections">
      <div className="sidebar-header">
        <span className="sidebar-title">Connections</span>
        <button
          className="icon-btn"
          title="New folder"
          aria-label="New folder"
          onClick={() => newFolder(null)}
        >
          <Icon name="folderPlus" />
        </button>
        <button
          className="icon-btn"
          title="New connection"
          aria-label="New connection"
          onClick={() => openConnectionEditor(null)}
        >
          <Icon name="plus" />
        </button>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={13} />
        <input
          id="sidebar-search"
          className="input"
          placeholder="Search name, host, user"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
          spellCheck={false}
          aria-label="Search connections"
        />
      </div>
      <div className="tree" role="tree" onContextMenu={(e) => openMenu(e, { kind: 'empty' })}>
        {nodes.length === 0 ? (
          <div className="tree-empty">
            {searching ? (
              'No connections match your search.'
            ) : (
              <>
                No saved connections yet.
                <br />
                <button className="btn btn-primary" onClick={() => openConnectionEditor(null)}>
                  <Icon name="plus" /> New connection
                </button>
              </>
            )}
          </div>
        ) : (
          <TreeLevel
            nodes={nodes}
            depth={0}
            forceExpanded={searching}
            selectedId={selectedId}
            statuses={statuses}
            onSelect={select}
            onToggle={onToggle}
            onMenu={openMenu}
          />
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
      <div className="sidebar-footer">
        <AppButtons />
      </div>
    </aside>
  );
}

interface LevelProps {
  nodes: TreeNode[];
  depth: number;
  forceExpanded: boolean;
  selectedId: string | null;
  statuses: Map<string, TabStatus>;
  onSelect: (id: string) => void;
  onToggle: (folder: Folder) => void;
  onMenu: (e: React.MouseEvent, target: MenuTarget) => void;
}

const TreeLevel = memo(function TreeLevel(props: LevelProps) {
  const { nodes, depth, forceExpanded, selectedId, statuses, onSelect, onToggle, onMenu } = props;
  const indent = { paddingLeft: 6 + depth * 14 };
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const { folder } = node;
          const expanded = forceExpanded || folder.expanded;
          return (
            <div key={folder.id} role="group">
              <div
                className="tree-row"
                role="treeitem"
                tabIndex={0}
                aria-expanded={expanded}
                aria-selected={selectedId === folder.id}
                style={indent}
                onClick={() => {
                  onSelect(folder.id);
                  if (!forceExpanded) onToggle(folder);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggle(folder);
                  }
                }}
                onContextMenu={(e) => onMenu(e, { kind: 'folder', folder })}
              >
                <Icon name="chevron" size={12} className="chevron" />
                <Icon name="folder" className="row-icon" />
                <span className="row-label">{folder.name}</span>
                <span className="row-count">{node.count}</span>
              </div>
              {expanded && <TreeLevel {...props} nodes={node.children} depth={depth + 1} />}
            </div>
          );
        }
        const { connection } = node;
        const status = statuses.get(connection.id);
        return (
          <div
            key={connection.id}
            className="tree-row"
            role="treeitem"
            tabIndex={0}
            aria-selected={selectedId === connection.id}
            style={{ paddingLeft: 6 + depth * 14 + 18 }}
            title={`${connection.username ? `${connection.username}@` : ''}${connection.host}:${connection.port}`}
            onClick={() => onSelect(connection.id)}
            onDoubleClick={() => connect(connection)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') connect(connection);
              if (e.key === 'F2') openConnectionEditor(connection);
              if (e.key === 'Delete') requestDeleteConnection(connection);
            }}
            onContextMenu={(e) => {
              onSelect(connection.id);
              onMenu(e, { kind: 'connection', connection });
            }}
          >
            <Icon name="server" className="row-icon" />
            <span className="row-label">{connection.name}</span>
            {connection.name !== connection.host && (
              <span className="row-meta">{connection.host}</span>
            )}
            {status && <span className="status-dot" data-status={status} aria-label={status} />}
          </div>
        );
      })}
    </>
  );
});
