// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The integrated SFTP browser of one tab. It uses the tab's SSH session (no
// separate login). If the server has no SFTP subsystem the panel says so and
// the terminal keeps working.

import { useFileDrop, type DroppedFiles } from './useFileDrop';
import { errorMessage } from '../../i18n/errors';
import { useTranslation } from 'react-i18next';
import { useActivity } from '../exit/activity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { notify, reportError } from '../../components/Toasts';
import { confirmAction, promptText } from '../../app/dialogs';
import { ipc, toAppError } from '../../shared/ipc';
import { useConnections } from '../connections/store';
import { useDialogs } from '../../app/dialogs';
import type { PermissionIssue } from '../help/PermissionDialog';
import type { PermissionOperation } from '../help/permissions';
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
  validateRemoteFilePath,
  validateRemoteFolderPath,
  folderParts,
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

const parentOf = (path: string) => path.replace(/\/[^/]*\/?$/, '') || '/';

/**
 * Create `a/b/c` below `dir` one level at a time over SFTP. A level that already
 * exists is reused; the next level then fails by itself if it is not a folder.
 * Resolves with the path of the last folder.
 */
async function createFolderPath(sessionId: string, dir: string, input: string): Promise<string> {
  const parts = folderParts(input);
  let current = dir;
  for (let i = 0; i < parts.length; i += 1) {
    try {
      current = await ipc.sftpMkdir(sessionId, current, parts[i]!);
    } catch (e) {
      const last = i === parts.length - 1;
      if (last || toAppError(e).token !== 'already_exists') throw e;
      current = current === '/' ? `/${parts[i]}` : `${current}/${parts[i]}`;
    }
  }
  return current;
}

/** Create `a/b/file.txt`: the folders in front first (reused when present), then the file. */
async function createFileAt(sessionId: string, dir: string, input: string): Promise<string> {
  const parts = folderParts(input);
  const name = parts.pop()!;
  const parent = parts.length > 0 ? await createFolderPath(sessionId, dir, parts.join('/')) : dir;
  return ipc.sftpCreateFile(sessionId, parent, name);
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
  const browserRef = useRef<HTMLDivElement>(null);
  const linuxHelp = useSettings((s) => s.settings.linuxHelp);
  const [permIssue, setPermIssue] = useState<PermissionIssue | null>(null);
  const username = useConnections(
    (s) => s.tree.connections.find((c) => c.id === tab.connectionId)?.username ?? '',
  );
  const assist = linuxHelp.enabled && linuxHelp.permissions;
  // Upload failures are grouped: one notice per batch, not one per file.
  const assistRef = useRef(assist);
  useEffect(() => {
    assistRef.current = assist;
  }, [assist]);
  const uploadDir = useRef('/');
  const permissionUploadIssue = useRef<(count: number) => PermissionIssue | null>(() => null);
  const deniedUploads = useRef(0);
  useEffect(() => {
    permissionUploadIssue.current = (count) =>
      sessionId
        ? { sessionId, operation: 'upload', dir: uploadDir.current, count, user: username }
        : null;
  }, [sessionId, username]);
  /** Report a failed operation; permission errors get the cautious explanation when it is on. */
  const failWith = (
    operation: PermissionOperation,
    dir: string,
    name?: string,
  ): ((error: unknown) => void) => {
    return (error) => {
      if (assist && sessionId && toAppError(error).token === 'permission_denied') {
        setPermIssue({ sessionId, operation, dir, name, user: username });
      } else {
        reportError(error);
      }
    };
  };

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
          if (event.reason === 'permission_denied') deniedUploads.current += 1;
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
    if (event.kind === 'finished') {
      refreshRef.current();
      const denied = deniedUploads.current;
      deniedUploads.current = 0;
      if (denied > 0 && assistRef.current) {
        setPermIssue((current) => current ?? permissionUploadIssue.current(denied));
      }
    }
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
      const start = (overwrite: boolean) => {
        uploadDir.current = listing.path;
        return ipc
          .sftpUpload(sessionId, picked.pickId, listing.path, overwrite, onTransfer)
          .catch(reportError);
      };
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
  // Files dragged in from the operating system (native events, see filedrop.rs).
  // The upload uses the same engine, progress list, cancellation and overwrite
  // question as the Upload button; nothing starts before the mouse is released.
  const dropUpload = async (drop: DroppedFiles) => {
    const discard = () => void ipc.sftpDiscardPick(drop.pickId).catch(() => undefined);
    if (!sessionId || !listing) {
      discard();
      return;
    }
    const destination = drop.target.kind === 'row' ? drop.target.path : listing.path;
    try {
      const plan = await ipc.sftpPlanUpload(sessionId, drop.pickId, destination);
      if (plan.files === 0 && plan.dirs === 0) {
        notify(t('sftp.drop.nothing'));
        discard();
        return;
      }
      const start = (overwrite: boolean) => {
        uploadDir.current = destination;
        void ipc
          .sftpUpload(sessionId, drop.pickId, destination, overwrite, onTransfer)
          .catch(reportError);
        if (plan.skipped > 0) notify(t('sftp.drop.skipped', { count: plan.skipped }));
      };
      if (plan.conflicts.count === 0) {
        start(false);
      } else {
        confirmAction({
          title: t('sftp.replaceTitle'),
          message: t('sftp.drop.conflicts', {
            count: plan.conflicts.count,
            names: plan.conflicts.samples.join(', '),
            dest: destination,
          }),
          confirmLabel: t('sftp.replace'),
          danger: true,
          onConfirm: () => start(true),
          onCancel: discard,
        });
      }
    } catch (e) {
      reportError(e);
      discard();
    }
  };
  const dragging = useFileDrop(browserRef, ready && !!listing, (drop) => void dropUpload(drop));
  const dropDestination =
    dragging?.target?.kind === 'row'
      ? dragging.target.path
      : dragging?.target
        ? (listing?.path ?? '')
        : null;

  const createEntry = (kind: 'file' | 'folder') => {
    if (!sessionId || !listing) return;
    const dir = listing.path;
    const existing = listing.entries.map((e) => e.name);
    promptText({
      title: kind === 'file' ? t('sftp.newFile') : t('folder.newTitle'),
      label: kind === 'file' ? t('sftp.fileNameOrPath') : t('folder.nameOrPath'),
      hint: t('sftp.createdIn', { dir }),
      initial: '',
      confirmLabel: t('folder.create'),
      validate: (name) =>
        kind === 'file'
          ? validateRemoteFilePath(name, existing)
          : validateRemoteFolderPath(name, existing),
      onSubmit: (name) => {
        const create =
          kind === 'file'
            ? createFileAt(sessionId, dir, name)
            : createFolderPath(sessionId, dir, name);
        create
          .then((path) => {
            pendingSelect.current = path;
            // only refresh when the user is still looking at that directory
            if (lastPath.current === dir) refresh();
          })
          .catch(failWith(kind === 'file' ? 'createFile' : 'createFolder', dir, name));
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
        ipc
          .sftpRename(sessionId, entry.path, name)
          .then(refresh)
          .catch(failWith('rename', parentOf(entry.path), entry.name));
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
        .catch(failWith('delete', parentOf(entry.path), entry.name));
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
    <div className="sftp-browser" ref={browserRef}>
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
      {permIssue && (
        <div className="sftp-error sftp-perm" role="alert">
          <span>
            {permIssue.operation === 'upload' ? t('help.perm.stripUpload') : t('help.perm.strip')}
          </span>
          <button
            className="btn"
            onClick={() => {
              useDialogs.getState().open({ kind: 'permissions', issue: permIssue });
              setPermIssue(null);
            }}
          >
            {t('help.perm.why')}
          </button>
          <button className="btn" onClick={() => setPermIssue(null)}>
            {t('help.perm.dismiss')}
          </button>
        </div>
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
        data-sftp-list
        data-drop-active={dragging?.target?.kind === 'directory' || undefined}
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
            data-sftp-row
            data-sftp-dir={isDir(entry)}
            data-sftp-path={entry.path}
            data-sftp-name={entry.name}
            data-drop-target={
              (dragging?.target?.kind === 'row' && dragging.target.path === entry.path) || undefined
            }
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

      {dragging && dropDestination !== null && (
        <div className="sftp-drop" role="presentation">
          <strong>{t('sftp.drop.title')}</strong>
          <span className="sftp-drop-label">{t('sftp.drop.destination')}</span>
          <span className="sftp-drop-path">{dropDestination}</span>
          <span className="hint">
            {[
              dragging.summary.files > 0 && t('count.file', { count: dragging.summary.files }),
              dragging.summary.dirs > 0 && t('count.directory', { count: dragging.summary.dirs }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      )}
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
