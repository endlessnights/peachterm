// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The integrated SFTP browser of one tab. It uses the tab's SSH session (no
// separate login). If the server has no SFTP subsystem the panel says so and
// the terminal keeps working.

import { errorMessage } from '../../i18n/errors';
import { useTranslation } from 'react-i18next';
import { useActivity } from '../exit/activity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { notify, reportError } from '../../components/Toasts';
import { confirmAction, promptText } from '../../app/dialogs';
import { ipc } from '../../shared/ipc';
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
  validateRemoteName,
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
  const { t } = useTranslation();
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
  const pendingSelect = useRef<string | null>(null);
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
        setSelected(pendingSelect.current);
        pendingSelect.current = null;
        setPathText(null);
      } catch (e) {
        if (requestNo.current !== mine) return;
        const message = errorMessage(e);
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
    if (isDir(entry)) {
      void load(entry.path);
    } else if (onOpenFile) {
      onOpenFile(entry);
    } else if (sessionId) {
      ipc
        .editorOpenRemote(sessionId, entry.path)
        .then((opened) =>
          notify(
            opened.alreadyOpen
              ? t('sftp.alreadyOpen', { name: opened.name })
              : t('sftp.opened', { name: opened.name }),
          ),
        )
        .catch(reportError);
    }
  };
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, ascending: !s.ascending } : { key, ascending: true }));

  // ---- transfers -------------------------------------------------------------
  // Exiting asks first while a transfer is running.
  const running = transfers.filter((t) => t.state === 'running').length;
  useEffect(() => {
    useActivity.getState().setTransfers(tab.id, running);
    return () => useActivity.getState().setTransfers(tab.id, 0);
  }, [running, tab.id]);
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
          title: t('sftp.replaceTitle'),
          message: t(clashes.length === 1 ? 'sftp.replaceOne' : 'sftp.replaceMany', {
            names:
              clashes.length > 5
                ? t('sftp.namesMore', {
                    names: clashes.slice(0, 5).join(', '),
                    count: clashes.length - 5,
                  })
                : clashes.join(', '),
          }),
          confirmLabel: t('sftp.replace'),
          danger: true,
          onConfirm: () => void start(true),
        });
      }
    } catch (e) {
      reportError(e);
    }
  };

  // ---- file operations -------------------------------------------------------
  /**
   * New file / new folder in the directory that is shown NOW (captured when the
   * dialog opens, so a later navigation cannot redirect it). Both use SFTP
   * requests; nothing is run in a shell.
   */
  const createEntry = (kind: 'file' | 'folder') => {
    if (!sessionId || !listing) return;
    const dir = listing.path;
    const existing = listing.entries.map((e) => e.name);
    promptText({
      title: kind === 'file' ? t('sftp.newFile') : t('folder.newTitle'),
      label: kind === 'file' ? t('sftp.fileName') : t('folder.name'),
      hint: t('sftp.createdIn', { dir }),
      initial: '',
      confirmLabel: t('folder.create'),
      validate: (name) => validateRemoteName(name, existing),
      onSubmit: (name) => {
        const create =
          kind === 'file'
            ? ipc.sftpCreateFile(sessionId, dir, name)
            : ipc.sftpMkdir(sessionId, dir, name);
        create
          .then((path) => {
            pendingSelect.current = path;
            // only refresh when the user is still looking at that directory
            if (lastPath.current === dir) refresh();
          })
          .catch(reportError);
      },
    });
  };

  const newMenu = (): MenuEntry[] => [
    {
      kind: 'item',
      label: t('sftp.menu.newFile'),
      icon: 'newFile',
      onSelect: () => createEntry('file'),
    },
    {
      kind: 'item',
      label: t('sftp.menu.newFolder'),
      icon: 'newFolder',
      onSelect: () => createEntry('folder'),
    },
  ];

  /** The menu for the empty area: acts on the current directory, never on a selection. */
  const backgroundMenu = (x: number, y: number) => {
    setSelected(null);
    setMenu({
      x,
      y,
      entries: [
        ...newMenu(),
        { kind: 'separator' },
        { kind: 'item', label: t('sftp.refresh'), icon: 'refresh', onSelect: refresh },
      ],
    });
  };

  const menuAtElement = (element: Element | null, entries: MenuEntry[]) => {
    const rect = element?.getBoundingClientRect();
    setMenu({ x: (rect?.left ?? 0) + 8, y: (rect?.bottom ?? 0) + 2, entries });
  };

  const rename = (entry: RemoteEntry) => {
    if (!sessionId) return;
    promptText({
      title: t('sftp.renameTitle'),
      label: t('sftp.newName'),
      initial: entry.name,
      confirmLabel: t('rename.submit'),
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
          if (removed > 1) notify(t('sftp.deletedMany', { count: removed }));
          refresh();
        })
        .catch(reportError);
    if (!confirmDelete) {
      void run();
      return;
    }
    confirmAction({
      title: isDir(entry) ? t('sftp.deleteFolderTitle') : t('sftp.deleteFileTitle'),
      message: isDir(entry)
        ? t('sftp.deleteFolderMessage', { name: entry.name })
        : t('sftp.deleteFileMessage', { name: entry.name }),
      confirmLabel: t('conn.delete.submit'),
      danger: true,
      onConfirm: () => void run(),
    });
  };

  const entryMenu = (entry: RemoteEntry, x: number, y: number) => {
    const entries: MenuEntry[] = [
      {
        kind: 'item',
        label: isDir(entry) ? t('sftp.menu.open') : t('sftp.menu.openEditor'),
        icon: 'edit',
        onSelect: () => open(entry),
      },
    ];
    if (!isDir(entry)) {
      entries.push({
        kind: 'item',
        label: t('sftp.downloadTitle'),
        icon: 'download',
        onSelect: () => download(entry),
      });
    }
    entries.push(
      { kind: 'separator' },
      { kind: 'item', label: t('sftp.menu.rename'), icon: 'edit', onSelect: () => rename(entry) },
      {
        kind: 'item',
        label: t('sftp.menu.copyPath'),
        icon: 'copy',
        onSelect: () => void navigator.clipboard?.writeText(entry.path).catch(() => undefined),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('conn.menu.delete'),
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
        <p>{t('sftp.unavailable')}</p>
        <p className="hint">{t('sftp.unavailableHint')}</p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="sftp-message" role="status">
        <p className="hint">
          {tab.status === 'connected' || tab.status === 'connecting'
            ? t('sftp.starting')
            : t('sftp.connectToBrowse')}
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
          aria-label={t('sftp.parent')}
          title={t('sftp.parent')}
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <Icon name="parent" />
        </button>
        <button
          className="icon-btn"
          aria-label={t('sftp.refresh')}
          title={t('sftp.refresh')}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
        <button
          className="icon-btn"
          aria-label={t('sftp.newEntry')}
          aria-haspopup="menu"
          title={t('sftp.newEntry')}
          onClick={(e) => menuAtElement(e.currentTarget, newMenu())}
        >
          <Icon name="plus" />
        </button>
        <button
          className="icon-btn"
          aria-label={t('sftp.uploadAria')}
          title={t('sftp.uploadTitle')}
          onClick={upload}
        >
          <Icon name="upload" />
        </button>
        <button
          className="icon-btn"
          aria-label={t('sftp.downloadAria')}
          title={t('sftp.downloadTitle')}
          disabled={!current || isDir(current)}
          onClick={() => current && download(current)}
        >
          <Icon name="download" />
        </button>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label={t('settings.sftp.showHidden')}
          aria-pressed={showHidden}
          title={t('settings.sftp.showHidden')}
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
          aria-label={t('sftp.remotePath')}
          spellCheck={false}
          value={pathText ?? listing?.path ?? ''}
          onChange={(e) => setPathText(e.target.value)}
          onBlur={() => setPathText(null)}
        />
      </form>
      {listing && (
        <nav className="sftp-crumbs" aria-label={t('sftp.pathAria')}>
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
            aria-label={t('sftp.sortBy', { column: t(`sftp.colAria.${key}`) })}
          >
            {t(`sftp.col.${key}`)}
            {sort.key === key && (sort.ascending ? ' ▲' : ' ▼')}
          </button>
        ))}
      </div>
      <div
        className="sftp-list"
        role="listbox"
        aria-label={t('sftp.remoteFiles')}
        aria-busy={loading}
        tabIndex={0}
        // Right click on the empty area: the folder's own menu.
        onContextMenu={(e) => {
          e.preventDefault();
          backgroundMenu(e.clientX, e.clientY);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            // keyboard alternative to a right click
            e.preventDefault();
            const row = current
              ? e.currentTarget.querySelector('.sftp-row[aria-selected="true"]')
              : null;
            if (current && row) {
              const rect = row.getBoundingClientRect();
              entryMenu(current, rect.left + 24, rect.bottom);
            } else {
              const rect = e.currentTarget.getBoundingClientRect();
              backgroundMenu(rect.left + 24, rect.top + 24);
            }
          } else if (e.key === 'ArrowDown') {
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
        {rows.length === 0 && !loading && <div className="sftp-empty">{t('sftp.empty')}</div>}
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
              e.stopPropagation(); // an item has its own menu, not the folder's
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
        <ul className="sftp-transfers" aria-label={t('sftp.transfers')}>
          {transfers.map((x) => (
            <li key={x.id} data-state={x.state}>
              <Icon name={x.direction === 'upload' ? 'upload' : 'download'} />
              <span className="sftp-transfer-name">{baseName(x.name)}</span>
              {x.state === 'running' ? (
                <>
                  <progress value={x.done} max={Math.max(1, x.total)} />
                  <button
                    className="icon-btn"
                    aria-label={t('sftp.cancelTransfer', { name: x.name })}
                    onClick={() => void ipc.sftpCancel(x.id).catch(reportError)}
                  >
                    <Icon name="close" />
                  </button>
                </>
              ) : (
                <span className="sftp-transfer-state">
                  {x.state === 'done'
                    ? t('sftp.state.done')
                    : x.state === 'cancelled'
                      ? t('sftp.state.cancelled')
                      : t('sftp.state.failed', { note: x.note ?? '' })}
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
