// The integrated SFTP browser of one tab. It uses the tab's SSH session (no
// separate login). If the server has no SFTP subsystem the panel says so and
// the terminal keeps working.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { notify, reportError } from '../../components/Toasts';
import { confirmAction, promptText } from '../../app/dialogs';
import { ipc, toAppError } from '../../shared/ipc';
import type { Listing, RemoteEntry, TransferEvent } from '../../shared/types';
import { useSettings } from '../settings/store';
import type { Tab } from '../sessions/store';
import {
  baseName,
  breadcrumbs,
  describeFailure,
  formatMode,
  formatSize,
  formatTime,
  isDir,
  sortEntries,
  visibleEntries,
  type Sort,
  type SortKey,
} from './model';

interface Transfer {
  id: string;
  name: string;
  direction: 'upload' | 'download';
  done: number;
  total: number;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  note?: string;
}

interface Props {
  tab: Tab;
  /** Open a remote file with the external editor (set by the editor flow). */
  onOpenFile?: (entry: RemoteEntry) => void;
}

export function SftpPanel({ tab, onOpenFile }: Props) {
  const sessionId = tab.sessionId;
  const showHidden = useSettings((s) => s.settings.sftp.showHidden);
  const confirmDelete = useSettings((s) => s.settings.sftp.confirmDelete);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: 'name', ascending: true });
  const [pathText, setPathText] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const lastPath = useRef<string | null>(null);
  const requestNo = useRef(0);

  const ready = tab.sftp === 'ready' && sessionId !== null;

  const load = useCallback(
    async (path: string | null) => {
      if (!sessionId) return;
      const mine = (requestNo.current += 1);
      setLoading(true);
      try {
        const result = await ipc.sftpList(sessionId, path);
        if (requestNo.current !== mine) return;
        lastPath.current = result.path;
        setListing(result);
        setError(null);
        setSelected(null);
        setPathText(null);
      } catch (e) {
        if (requestNo.current !== mine) return;
        const message = toAppError(e).message;
        setError(message);
        // A path that cannot be opened keeps the previous listing visible.
      } finally {
        if (requestNo.current === mine) setLoading(false);
      }
    },
    [sessionId],
  );

  // First listing when SFTP becomes ready (a reconnect starts again at the
  // directory that was open, falling back to the login directory).
  useEffect(() => {
    if (!ready) return;
    void load(lastPath.current).then(() => undefined);
  }, [ready, load]);

  const rows = useMemo(
    () => (listing ? sortEntries(visibleEntries(listing.entries, showHidden), sort) : []),
    [listing, showHidden, sort],
  );

  const refresh = () => void load(listing?.path ?? null);
  // Transfer callbacks outlive renders: always refresh through the latest closure.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  const open = (entry: RemoteEntry) => {
    if (isDir(entry)) void load(entry.path);
    else onOpenFile?.(entry);
  };
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, ascending: !s.ascending } : { key, ascending: true }));

  // ---- transfers -------------------------------------------------------------
  const onTransfer = useCallback((event: TransferEvent) => {
    setTransfers((list) => {
      switch (event.kind) {
        case 'started':
          return [
            ...list.filter((t) => t.state === 'running'),
            {
              id: event.transferId,
              name: event.name,
              direction: event.direction,
              done: 0,
              total: event.total,
              state: 'running' as const,
            },
          ].slice(-6);
        case 'progress':
          return list.map((t) =>
            t.id === event.transferId ? { ...t, done: event.done, total: event.total } : t,
          );
        case 'completed':
          return list.map((t) =>
            t.id === event.transferId ? { ...t, state: 'done', done: t.total } : t,
          );
        case 'failed':
          return list.map((t) =>
            t.id === event.transferId
              ? { ...t, state: 'failed', note: describeFailure(event.reason) }
              : t,
          );
        case 'cancelled':
          return list.map((t) => (t.id === event.transferId ? { ...t, state: 'cancelled' } : t));
        default:
          return list;
      }
    });
    if (event.kind === 'finished') refreshRef.current();
  }, []);

  const download = (entry: RemoteEntry) => {
    if (!sessionId || isDir(entry)) return;
    ipc.sftpDownload(sessionId, entry.path, onTransfer).catch(reportError);
  };

  const upload = async () => {
    if (!sessionId || !listing) return;
    try {
      const picked = await ipc.sftpPickUpload(sessionId);
      if (!picked) return;
      const existing = new Set(listing.entries.map((e) => e.name));
      const clashes = picked.files.filter((f) => existing.has(f.name)).map((f) => f.name);
      const start = (overwrite: boolean) =>
        ipc
          .sftpUpload(sessionId, picked.pickId, listing.path, overwrite, onTransfer)
          .catch(reportError);
      if (clashes.length === 0) {
        await start(false);
      } else {
        confirmAction({
          title: 'Replace existing files?',
          message: `${clashes.slice(0, 5).join(', ')}${clashes.length > 5 ? ` and ${clashes.length - 5} more` : ''} already exist${clashes.length === 1 ? 's' : ''} in this folder on the server. Uploading replaces ${clashes.length === 1 ? 'it' : 'them'}.`,
          confirmLabel: 'Replace',
          danger: true,
          onConfirm: () => void start(true),
        });
      }
    } catch (e) {
      reportError(e);
    }
  };

  // ---- file operations -------------------------------------------------------
  const newFolder = () => {
    if (!sessionId || !listing) return;
    promptText({
      title: 'New folder',
      label: 'Folder name',
      initial: '',
      confirmLabel: 'Create',
      onSubmit: (name) => {
        ipc.sftpMkdir(sessionId, listing.path, name).then(refresh).catch(reportError);
      },
    });
  };

  const rename = (entry: RemoteEntry) => {
    if (!sessionId) return;
    promptText({
      title: 'Rename',
      label: 'New name',
      initial: entry.name,
      confirmLabel: 'Rename',
      onSubmit: (name) => {
        ipc.sftpRename(sessionId, entry.path, name).then(refresh).catch(reportError);
      },
    });
  };

  const remove = (entry: RemoteEntry) => {
    if (!sessionId) return;
    const run = () =>
      ipc
        .sftpDelete(sessionId, entry.path)
        .then(({ removed }) => {
          if (removed > 1) notify(`Deleted ${removed} items.`);
          refresh();
        })
        .catch(reportError);
    if (!confirmDelete) {
      void run();
      return;
    }
    confirmAction({
      title: isDir(entry) ? 'Delete folder?' : 'Delete file?',
      message: isDir(entry)
        ? `"${entry.name}" and everything inside it will be deleted from the server. This cannot be undone.`
        : `"${entry.name}" will be deleted from the server. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => void run(),
    });
  };

  const entryMenu = (entry: RemoteEntry, x: number, y: number) => {
    const entries: MenuEntry[] = [
      {
        kind: 'item',
        label: isDir(entry) ? 'Open' : 'Open in editor',
        icon: 'edit',
        onSelect: () => open(entry),
      },
    ];
    if (!isDir(entry)) {
      entries.push({
        kind: 'item',
        label: 'Download…',
        icon: 'download',
        onSelect: () => download(entry),
      });
    }
    entries.push(
      { kind: 'separator' },
      { kind: 'item', label: 'Rename…', icon: 'edit', onSelect: () => rename(entry) },
      {
        kind: 'item',
        label: 'Copy path',
        icon: 'copy',
        onSelect: () => void navigator.clipboard?.writeText(entry.path).catch(() => undefined),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Delete…',
        icon: 'trash',
        danger: true,
        onSelect: () => remove(entry),
      },
    );
    setSelected(entry.path);
    setMenu({ x, y, entries });
  };

  // ---- rendering -------------------------------------------------------------
  if (tab.sftp === 'unavailable') {
    return (
      <div className="sftp-message" role="status">
        <Icon name="folder" size={22} />
        <p>This server does not offer SFTP.</p>
        <p className="hint">The terminal is not affected.</p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="sftp-message" role="status">
        <p className="hint">
          {tab.status === 'connected' || tab.status === 'connecting'
            ? 'Starting SFTP…'
            : 'Connect to browse files.'}
        </p>
      </div>
    );
  }

  const moveSelection = (delta: number) => {
    if (rows.length === 0) return;
    const index = rows.findIndex((r) => r.path === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
    if (next) setSelected(next.path);
  };
  const current = rows.find((r) => r.path === selected) ?? null;

  return (
    <div className="sftp-browser">
      <div className="sftp-toolbar">
        <button
          className="icon-btn"
          aria-label="Parent folder"
          title="Parent folder"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <Icon name="parent" />
        </button>
        <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={refresh}>
          <Icon name="refresh" />
        </button>
        <button className="icon-btn" aria-label="New folder" title="New folder" onClick={newFolder}>
          <Icon name="newFolder" />
        </button>
        <button className="icon-btn" aria-label="Upload files" title="Upload…" onClick={upload}>
          <Icon name="upload" />
        </button>
        <button
          className="icon-btn"
          aria-label="Download selected file"
          title="Download…"
          disabled={!current || isDir(current)}
          onClick={() => current && download(current)}
        >
          <Icon name="download" />
        </button>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="Show hidden files"
          aria-pressed={showHidden}
          title="Show hidden files"
          data-active={showHidden || undefined}
          onClick={() => {
            const settings = useSettings.getState().settings;
            void useSettings
              .getState()
              .save({ ...settings, sftp: { ...settings.sftp, showHidden: !showHidden } })
              .catch(reportError);
          }}
        >
          <Icon name="eye" />
        </button>
      </div>

      <form
        className="sftp-path"
        onSubmit={(e) => {
          e.preventDefault();
          if (pathText !== null && pathText.trim()) void load(pathText.trim());
        }}
      >
        <input
          className="input"
          aria-label="Remote path"
          spellCheck={false}
          value={pathText ?? listing?.path ?? ''}
          onChange={(e) => setPathText(e.target.value)}
          onBlur={() => setPathText(null)}
        />
      </form>
      {listing && (
        <nav className="sftp-crumbs" aria-label="Path">
          {breadcrumbs(listing.path).map((c) => (
            <button key={c.path} className="crumb" onClick={() => void load(c.path)}>
              {c.name}
            </button>
          ))}
        </nav>
      )}
      {error && (
        <div className="sftp-error" role="alert">
          {error}
        </div>
      )}

      <div className="sftp-head" role="row">
        {(['name', 'size', 'modified'] as const).map((key) => (
          <button
            key={key}
            className={`sftp-col sftp-col-${key}`}
            onClick={() => toggleSort(key)}
            aria-label={`Sort by ${key}`}
          >
            {key[0]!.toUpperCase() + key.slice(1)}
            {sort.key === key && (sort.ascending ? ' ▲' : ' ▼')}
          </button>
        ))}
      </div>
      <div
        className="sftp-list"
        role="listbox"
        aria-label="Remote files"
        aria-busy={loading}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveSelection(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveSelection(-1);
          } else if (e.key === 'Enter' && current) {
            e.preventDefault();
            open(current);
          } else if (e.key === 'Backspace' && listing?.parent) {
            e.preventDefault();
            void load(listing.parent);
          } else if (e.key === 'Delete' && current) {
            e.preventDefault();
            remove(current);
          }
        }}
      >
        {rows.length === 0 && !loading && <div className="sftp-empty">This folder is empty.</div>}
        {rows.map((entry) => (
          <div
            key={entry.path}
            role="option"
            aria-selected={entry.path === selected}
            className="sftp-row"
            data-selected={entry.path === selected || undefined}
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => open(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              entryMenu(entry, e.clientX, e.clientY);
            }}
            title={`${entry.path}\n${formatMode(entry.mode, entry.kind)}`}
          >
            <span className="sftp-name">
              <Icon name={isDir(entry) ? 'folder' : 'file'} />
              <span>{entry.name}</span>
            </span>
            <span className="sftp-size">{isDir(entry) ? '' : formatSize(entry.size)}</span>
            <span className="sftp-mtime">{formatTime(entry.modified)}</span>
          </div>
        ))}
      </div>

      {transfers.length > 0 && (
        <ul className="sftp-transfers" aria-label="Transfers">
          {transfers.map((t) => (
            <li key={t.id} data-state={t.state}>
              <Icon name={t.direction === 'upload' ? 'upload' : 'download'} />
              <span className="sftp-transfer-name">{baseName(t.name)}</span>
              {t.state === 'running' ? (
                <>
                  <progress value={t.done} max={Math.max(1, t.total)} />
                  <button
                    className="icon-btn"
                    aria-label={`Cancel ${t.name}`}
                    onClick={() => void ipc.sftpCancel(t.id).catch(reportError)}
                  >
                    <Icon name="close" />
                  </button>
                </>
              ) : (
                <span className="sftp-transfer-state">
                  {t.state === 'done'
                    ? 'done'
                    : t.state === 'cancelled'
                      ? 'cancelled'
                      : `failed: ${t.note ?? ''}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
