// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Notes & documentation of one saved connection, shown in the auxiliary panel
// (the same dock that holds the SFTP browser: left or right, resizable,
// collapsible). Compact on purpose: a document list only when there is more than
// one document, a small toolbar, the document.

import { Trans, useTranslation } from 'react-i18next';
import { formatDateTime, formatPercent } from '../../i18n/format';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmAction, promptText } from '../../app/dialogs';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { Icon } from '../../components/Icon';
import { ipc } from '../../shared/ipc';
import { reportError } from '../../components/Toasts';
import type { NoteContent, NoteSummary, Uuid } from '../../shared/types';
import { useConnections } from '../connections/store';
import {
  ZOOM_STEP,
  clampZoom,
  fitZoom,
  parseHtml,
  parseMarkdown,
  parseText,
  type Block,
} from './doc';
import { DocView, copyText } from './DocView';
import { useNotes } from './store';

const when = (seconds: number) => formatDateTime(seconds * 1000);

function hostOf(url: string | null): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

function blocksFor(content: NoteContent | undefined, text: string | null): Block[] | null {
  if (text === null) return null;
  const format = content?.format ?? 'markdown';
  if (format === 'html') return parseHtml(text);
  if (format === 'text') return parseText(text);
  return parseMarkdown(text);
}

export function NotesPanel({
  connectionId,
  connectionName,
}: {
  connectionId: Uuid;
  connectionName: string;
}) {
  const { t } = useTranslation();
  const overview = useNotes((s) => s.overview[connectionId]);
  const entry = useNotes((s) => {
    const o = s.overview[connectionId];
    const id = o?.lastSelected ?? o?.notes[0]?.id;
    return id ? s.content[id] : undefined;
  });
  const drafts = useNotes((s) => s.drafts);
  const notes = overview?.notes;
  const list: NoteSummary[] = useMemo(() => notes ?? [], [notes]);
  const selected: NoteSummary | undefined =
    list.find((n) => n.id === overview?.lastSelected) ?? list[0];
  const actions = useNotes.getState();

  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  // a note that was just created opens straight in the editor
  const [editNext, setEditNext] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [hits, setHits] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const docRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the list for this connection; saving what is being typed before moving on.
  useEffect(() => {
    void useNotes.getState().load(connectionId);
    return () => {
      void useNotes.getState().flushAll();
    };
  }, [connectionId]);

  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) void useNotes.getState().loadContent(selectedId);
  }, [selectedId]);

  // A different note starts in preview, with a clean search.
  const [shownId, setShownId] = useState(selectedId);
  if (shownId !== selectedId) {
    setShownId(selectedId);
    setMode(editNext !== null && editNext === selectedId ? 'edit' : 'preview');
    setQuery('');
    setHit(0);
  }

  const content = entry?.status === 'ready' ? entry.data : undefined;
  const draft = selectedId ? drafts[selectedId] : undefined;
  const text = draft?.text ?? content?.text ?? null;
  const editable = selected?.kind === 'internal' && selected.format !== 'html';
  const blocks = useMemo(
    () => (mode === 'preview' ? blocksFor(content, text) : null),
    [mode, content, text],
  );
  const zoom = selected?.zoom ?? 100;

  // Count and number the search hits in the rendered document.
  useEffect(() => {
    const marks = docRef.current?.querySelectorAll('mark.doc-hit') ?? [];
    setHits(marks.length);
    marks.forEach((m, i) => m.classList.toggle('doc-hit-current', i === hit));
    marks[hit]?.scrollIntoView?.({ block: 'center' });
  }, [query, hit, blocks]);

  const setZoom = useCallback(
    (value: number) => {
      if (selected) void actions.setZoom(connectionId, selected.id, clampZoom(value));
    },
    [actions, connectionId, selected],
  );

  const addMenu = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const entries: MenuEntry[] = [
      {
        kind: 'item',
        label: t('notes.menu.newMarkdown'),
        icon: 'newFile',
        onSelect: () => newNote('markdown'),
      },
      {
        kind: 'item',
        label: t('notes.menu.newText'),
        icon: 'newFile',
        onSelect: () => newNote('text'),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('notes.menu.attachFile'),
        icon: 'file',
        onSelect: () => void actions.attachFile(connectionId),
      },
      { kind: 'item', label: t('notes.menu.addUrl'), onSelect: addUrl },
    ];
    entries.push({
      kind: 'item',
      label: t('notes.menu.attachExisting'),
      onSelect: () => void attachExisting(),
    });
    setMenu({ x: r.left, y: r.bottom + 2, entries });
  };

  const newNote = (format: 'markdown' | 'text') =>
    promptText({
      title: format === 'markdown' ? t('notes.newMarkdownTitle') : t('notes.newTextTitle'),
      label: t('notes.titleLabel'),
      initial: '',
      confirmLabel: t('folder.create'),
      validate: (v) => (v.trim() ? null : t('notes.needTitle')),
      onSubmit: (title) => {
        void actions.createNote(connectionId, title, format).then((id) => {
          if (id) {
            setEditNext(id);
            setMode('edit');
          }
        });
      },
    });

  const addUrl = () =>
    promptText({
      title: t('notes.addUrlTitle'),
      label: t('notes.addUrlLabel'),
      initial: '',
      confirmLabel: t('notes.add'),
      hint: t('notes.addUrlHint'),
      validate: (v) => (/^https:\/\//i.test(v.trim()) ? null : t('notes.httpsOnly')),
      onSubmit: (url) => void actions.attachUrl(connectionId, url.trim()),
    });

  const attachExisting = async () => {
    let all: NoteSummary[];
    try {
      all = await ipc.notesAll();
    } catch (e) {
      reportError(e);
      return;
    }
    const mine = new Set(list.map((n) => n.id));
    const free = all.filter((n) => !mine.has(n.id)).slice(0, 25);
    const anchor = document.activeElement?.getBoundingClientRect();
    setMenu({
      x: anchor?.left ?? 200,
      y: (anchor?.bottom ?? 120) + 2,
      entries: free.length
        ? free.map((n) => ({
            kind: 'item' as const,
            label: n.orphan ? t('notes.unattached', { title: n.title }) : n.title,
            onSelect: () => void actions.attachExisting(connectionId, n.id),
          }))
        : [{ kind: 'item', label: t('notes.noOthers'), disabled: true, onSelect: () => undefined }],
    });
  };

  const rename = (n: NoteSummary) =>
    promptText({
      title: t('notes.renameTitle'),
      label: t('notes.titleLabel'),
      initial: n.title,
      confirmLabel: t('rename.submit'),
      validate: (v) => (v.trim() ? null : t('notes.needTitle')),
      onSubmit: (title) => void actions.rename(connectionId, n.id, title),
    });

  const moreMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (!selected) return;
    const n = selected;
    const r = e.currentTarget.getBoundingClientRect();
    const idx = list.findIndex((x) => x.id === n.id);
    const entries: MenuEntry[] = [
      { kind: 'item', label: t('sftp.menu.rename'), icon: 'edit', onSelect: () => rename(n) },
      {
        kind: 'item',
        label: t('notes.copyAll'),
        icon: 'copy',
        disabled: text === null,
        onSelect: () => void copyText(text ?? ''),
      },
    ];
    if (n.kind === 'localFile') {
      entries.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: t('notes.reload'),
          icon: 'refresh',
          onSelect: () => void actions.loadContent(n.id, true),
        },
        {
          kind: 'item',
          label: t('notes.openExternal'),
          onSelect: () => void ipc.noteOpenExternal(n.id).catch(reportError),
        },
        {
          kind: 'item',
          label: t('notes.locate'),
          onSelect: () => void actions.relocate(connectionId, n.id),
        },
      );
    }
    if (n.kind === 'remoteUrl') {
      entries.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: t('notes.refreshSource'),
          icon: 'refresh',
          onSelect: () => void actions.loadContent(n.id, true),
        },
        n.offline
          ? {
              kind: 'item',
              label: t('notes.removeOffline'),
              onSelect: () => void actions.removeOffline(connectionId, n.id),
            }
          : {
              kind: 'item',
              label: t('notes.saveOffline'),
              icon: 'download',
              onSelect: () => void actions.saveOffline(connectionId, n.id),
            },
        {
          kind: 'item',
          label: t('notes.openOriginal'),
          onSelect: () => void ipc.noteOpenExternal(n.id).catch(reportError),
        },
      );
    }
    entries.push(
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('conn.menu.moveUp'),
        disabled: idx <= 0,
        onSelect: () => void actions.move(connectionId, n.id, -1),
      },
      {
        kind: 'item',
        label: t('conn.menu.moveDown'),
        disabled: idx >= list.length - 1,
        onSelect: () => void actions.move(connectionId, n.id, 1),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('notes.detach'),
        onSelect: () => void actions.detach(connectionId, n.id),
      },
      {
        kind: 'item',
        label: t('notes.deleteEverywhere'),
        danger: true,
        icon: 'trash',
        onSelect: () =>
          confirmAction({
            title: t('notes.deleteTitle'),
            message: n.shared
              ? t('notes.deleteShared', { title: n.title, count: n.sharedWith.length + 1 })
              : t('notes.deleteOne', { title: n.title }),
            confirmLabel: t('notes.deleteConfirm'),
            danger: true,
            onConfirm: () => void actions.remove(connectionId, n.id),
          }),
      },
    );
    setMenu({ x: r.right - 180, y: r.bottom + 2, entries });
  };

  const names = useConnections((s) => s.tree.connections);
  const sharedNames = (n: NoteSummary) =>
    n.sharedWith.map((id) => names.find((c) => c.id === id)?.name).filter((x): x is string => !!x);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = list.findIndex((n) => n.id === selected?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) void actions.select(connectionId, next.id);
  };

  // ---- empty ----------------------------------------------------------------
  if (overview && list.length === 0) {
    return (
      <div
        className="notes-panel notes-empty"
        aria-label={t('notes.panelAria', { name: connectionName })}
      >
        <p className="hint">{t('notes.noneFor', { name: connectionName })}</p>
        <div className="notes-empty-actions">
          <button className="btn" onClick={() => newNote('markdown')}>
            {t('notes.newNote')}
          </button>
          <button className="btn" onClick={() => void actions.attachFile(connectionId)}>
            {t('notes.menu.attachFile')}
          </button>
          <button className="btn" onClick={addUrl}>
            {t('notes.menu.addUrl')}
          </button>
          <button className="btn" onClick={() => void attachExisting()}>
            {t('notes.menu.attachExisting')}
          </button>
        </div>
        {menu && (
          <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
        )}
      </div>
    );
  }

  const failure = entry?.status === 'failed' ? entry.message : null;
  const loading = !entry || entry.status === 'loading';

  return (
    <div className="notes-panel" aria-label={t('notes.panelAria', { name: connectionName })}>
      <div className="notes-head">
        <span className="notes-title" title={t('notes.headTitle', { name: connectionName })}>
          <Trans
            i18nKey="notes.headTitleRich"
            values={{ name: connectionName }}
            components={{ name: <span className="notes-title-name" /> }}
          />
        </span>
        <button
          className="icon-btn"
          aria-label={t('notes.addNote')}
          title={t('notes.addNote')}
          onClick={addMenu}
        >
          <Icon name="plus" />
        </button>
      </div>

      {list.length > 1 && (
        <ul
          className="notes-list"
          role="listbox"
          aria-label={t('notes.documents')}
          onKeyDown={onListKey}
        >
          {list.map((n) => (
            <li key={n.id} role="presentation">
              <button
                className="notes-item"
                role="option"
                aria-selected={n.id === selected?.id}
                title={
                  n.shared
                    ? t('notes.sharedWith', {
                        title: n.title,
                        names: sharedNames(n).join(', ') || t('notes.otherConnections'),
                      })
                    : n.title
                }
                tabIndex={n.id === selected?.id ? 0 : -1}
                onClick={() => void actions.select(connectionId, n.id)}
              >
                <span className="notes-item-title">{n.title}</span>
                {n.shared && <span className="notes-badge">{t('notes.sharedBadge')}</span>}
                {drafts[n.id] && (
                  <span className="notes-badge" title={t('notes.unsavedBadge')}>
                    •
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <>
          <div className="notes-doc-head">
            <div className="notes-doc-title">
              <strong>{selected.title}</strong>
              <span className="hint">
                {t(`notes.kind.${selected.kind}.${content?.format ?? selected.format}`)}
                {selected.shared &&
                  ` · ${t('notes.sharedWithShort', {
                    names:
                      sharedNames(selected).join(', ') ||
                      t('notes.sharedMore', { count: selected.sharedWith.length }),
                  })}`}
              </span>
            </div>
            <button
              className="icon-btn"
              aria-label={t('notes.actions')}
              title={t('notes.actions')}
              onClick={moreMenu}
            >
              <Icon name="chevronDown" />
            </button>
          </div>

          <div className="notes-toolbar">
            {editable && (
              <div className="segmented" role="group" aria-label={t('notes.mode')}>
                <button
                  type="button"
                  aria-pressed={mode === 'preview'}
                  onClick={() => setMode('preview')}
                >
                  {t('notes.preview')}
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'edit'}
                  onClick={() => setMode('edit')}
                >
                  {t('notes.edit')}
                </button>
              </div>
            )}
            <input
              className="input notes-search"
              type="search"
              placeholder={t('notes.search')}
              aria-label={t('notes.searchAria')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHit(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits > 0)
                  setHit((h) => (h + (e.shiftKey ? hits - 1 : 1)) % hits);
              }}
            />
            {query.trim() && (
              <span className="hint" aria-live="polite" data-testid="search-count">
                {hits ? `${Math.min(hit + 1, hits)} / ${hits}` : t('notes.noMatches')}
              </span>
            )}
            <div className="notes-zoom" role="group" aria-label={t('notes.zoom')}>
              <button
                className="icon-btn"
                aria-label={t('notes.zoomOut')}
                title={t('notes.zoomOut')}
                disabled={zoom <= 50}
                onClick={() => setZoom(zoom - ZOOM_STEP)}
              >
                −
              </button>
              <button
                className="notes-zoom-value"
                aria-label={t('notes.zoomResetAria')}
                title={t('notes.zoomReset')}
                onClick={() => setZoom(100)}
              >
                {formatPercent(zoom)}
              </button>
              <button
                className="icon-btn"
                aria-label={t('notes.zoomIn')}
                title={t('notes.zoomIn')}
                disabled={zoom >= 200}
                onClick={() => setZoom(zoom + ZOOM_STEP)}
              >
                +
              </button>
              <button
                className="icon-btn"
                aria-label={t('notes.fit')}
                title={t('notes.fit')}
                onClick={() => {
                  // wide code blocks and tables scroll inside the document; fit makes the widest one fit
                  const el = docRef.current;
                  if (!el) return;
                  let widest = el.clientWidth;
                  el.querySelectorAll('.doc-code pre, .doc-table-wrap').forEach((n) => {
                    widest = Math.max(widest, n.scrollWidth);
                  });
                  setZoom(fitZoom(zoom, el.clientWidth, widest));
                }}
              >
                ↔
              </button>
            </div>
          </div>

          <div className="notes-body" ref={scrollRef}>
            {loading && <p className="hint">{t('notes.loading')}</p>}
            {failure && (
              <div className="notes-problem" role="alert">
                <p>{failure}</p>
                <button className="btn" onClick={() => void actions.loadContent(selected.id, true)}>
                  {t('notes.tryAgain')}
                </button>
              </div>
            )}
            {content && content.status !== 'ok' && (
              <div className="notes-problem" role="alert">
                <p>{content.problem ?? t('notes.cannotShow')}</p>
                <div className="notes-empty-actions">
                  {content.status === 'missing' && (
                    <button
                      className="btn"
                      onClick={() => void actions.relocate(connectionId, selected.id)}
                    >
                      {t('notes.locate')}
                    </button>
                  )}
                  {(content.status === 'offline' || content.status === 'error') && (
                    <button
                      className="btn"
                      onClick={() => void actions.loadContent(selected.id, true)}
                    >
                      {t('notes.tryAgain')}
                    </button>
                  )}
                  {selected.kind === 'remoteUrl' && (
                    <button
                      className="btn"
                      onClick={() => void ipc.noteOpenExternal(selected.id).catch(reportError)}
                    >
                      {t('notes.openBrowser')}
                    </button>
                  )}
                  {selected.kind === 'localFile' && content.status !== 'missing' && (
                    <button
                      className="btn"
                      onClick={() => void ipc.noteOpenExternal(selected.id).catch(reportError)}
                    >
                      {t('notes.openExternal')}
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => void actions.detach(connectionId, selected.id)}
                  >
                    {t('notes.detachShort')}
                  </button>
                </div>
              </div>
            )}
            {content?.status === 'ok' && content.fromOffline && content.problem && (
              <p className="hint notes-banner" role="status">
                {content.problem}
              </p>
            )}
            {mode === 'edit' && editable && text !== null && (
              <textarea
                className="notes-editor"
                aria-label={t('notes.editAria')}
                spellCheck={false}
                value={text}
                style={{ fontSize: `${(13 * zoom) / 100}px` }}
                onChange={(e) => actions.edit(selected.id, e.target.value)}
              />
            )}
            {mode === 'preview' && blocks && (
              <DocView blocks={blocks} query={query} zoom={zoom} rootRef={docRef} />
            )}
          </div>

          <div className="notes-foot hint">
            {draft?.state === 'failed' ? (
              <>
                <span role="alert">{t('notes.notSaved', { error: draft.error })}</span>
                <button className="btn" onClick={() => void actions.flush(selected.id)}>
                  {t('notes.retry')}
                </button>
              </>
            ) : draft ? (
              <span>{draft.state === 'saving' ? t('notes.saving') : t('notes.unsaved')}</span>
            ) : selected.kind === 'internal' ? (
              <span>{t('notes.savedHere')}</span>
            ) : selected.kind === 'localFile' ? (
              <span title={selected.source ?? ''}>{t('notes.linkedReadOnly')}</span>
            ) : (
              <span title={selected.source ?? ''}>
                {content?.fromOffline
                  ? t('notes.offlineSaved', {
                      when: selected.offline ? when(selected.offline.savedAt) : '',
                    })
                  : t('notes.readOnlyHost', { host: hostOf(selected.source) })}
                {selected.offline && !content?.fromOffline
                  ? ` · ${t('notes.offlineSaved', { when: when(selected.offline.savedAt) })}`
                  : ''}
              </span>
            )}
          </div>
        </>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
