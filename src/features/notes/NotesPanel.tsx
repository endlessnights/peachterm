// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Notes & documentation of one saved connection, shown in the auxiliary panel
// (the same dock that holds the SFTP browser: left or right, resizable,
// collapsible). Compact on purpose: a document list only when there is more than
// one document, a small toolbar, the document.

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

const KIND_LABEL = {
  internal: { markdown: 'Markdown note', text: 'Text note', html: 'Note' },
  localFile: {
    markdown: 'Linked Markdown file',
    text: 'Linked text file',
    html: 'Linked HTML file',
  },
  remoteUrl: { markdown: 'Web Markdown', text: 'Web text', html: 'Web page' },
} as const;

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();

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
        label: 'New Markdown note…',
        icon: 'newFile',
        onSelect: () => newNote('markdown'),
      },
      { kind: 'item', label: 'New text note…', icon: 'newFile', onSelect: () => newNote('text') },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Attach a file…',
        icon: 'file',
        onSelect: () => void actions.attachFile(connectionId),
      },
      { kind: 'item', label: 'Add a web address…', onSelect: addUrl },
    ];
    entries.push({
      kind: 'item',
      label: 'Attach an existing note…',
      onSelect: () => void attachExisting(),
    });
    setMenu({ x: r.left, y: r.bottom + 2, entries });
  };

  const newNote = (format: 'markdown' | 'text') =>
    promptText({
      title: format === 'markdown' ? 'New Markdown note' : 'New text note',
      label: 'Title',
      initial: '',
      confirmLabel: 'Create',
      validate: (v) => (v.trim() ? null : 'Give the note a title.'),
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
      title: 'Add a web document',
      label: 'Address (https://…)',
      initial: '',
      confirmLabel: 'Add',
      hint: 'A Markdown, text or HTML page, for example a GitHub README. It is read-only and is not stored unless you save an offline copy.',
      validate: (v) =>
        /^https:\/\//i.test(v.trim()) ? null : 'Use an address that starts with https://',
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
            label: n.orphan ? `${n.title} (unattached)` : n.title,
            onSelect: () => void actions.attachExisting(connectionId, n.id),
          }))
        : [{ kind: 'item', label: 'No other notes', disabled: true, onSelect: () => undefined }],
    });
  };

  const rename = (n: NoteSummary) =>
    promptText({
      title: 'Rename note',
      label: 'Title',
      initial: n.title,
      confirmLabel: 'Rename',
      validate: (v) => (v.trim() ? null : 'Give the note a title.'),
      onSubmit: (title) => void actions.rename(connectionId, n.id, title),
    });

  const moreMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (!selected) return;
    const n = selected;
    const r = e.currentTarget.getBoundingClientRect();
    const idx = list.findIndex((x) => x.id === n.id);
    const entries: MenuEntry[] = [
      { kind: 'item', label: 'Rename…', icon: 'edit', onSelect: () => rename(n) },
      {
        kind: 'item',
        label: 'Copy all',
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
          label: 'Reload from disk',
          icon: 'refresh',
          onSelect: () => void actions.loadContent(n.id, true),
        },
        {
          kind: 'item',
          label: 'Open in external application',
          onSelect: () => void ipc.noteOpenExternal(n.id).catch(reportError),
        },
        {
          kind: 'item',
          label: 'Locate file…',
          onSelect: () => void actions.relocate(connectionId, n.id),
        },
      );
    }
    if (n.kind === 'remoteUrl') {
      entries.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Refresh from source',
          icon: 'refresh',
          onSelect: () => void actions.loadContent(n.id, true),
        },
        n.offline
          ? {
              kind: 'item',
              label: 'Remove offline copy',
              onSelect: () => void actions.removeOffline(connectionId, n.id),
            }
          : {
              kind: 'item',
              label: 'Save offline copy',
              icon: 'download',
              onSelect: () => void actions.saveOffline(connectionId, n.id),
            },
        {
          kind: 'item',
          label: 'Open original in browser',
          onSelect: () => void ipc.noteOpenExternal(n.id).catch(reportError),
        },
      );
    }
    entries.push(
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Move up',
        disabled: idx <= 0,
        onSelect: () => void actions.move(connectionId, n.id, -1),
      },
      {
        kind: 'item',
        label: 'Move down',
        disabled: idx >= list.length - 1,
        onSelect: () => void actions.move(connectionId, n.id, 1),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Detach from this connection',
        onSelect: () => void actions.detach(connectionId, n.id),
      },
      {
        kind: 'item',
        label: 'Delete everywhere…',
        danger: true,
        icon: 'trash',
        onSelect: () =>
          confirmAction({
            title: 'Delete this document everywhere?',
            message: n.shared
              ? `“${n.title}” is attached to ${n.sharedWith.length + 1} connections. It will be deleted from all of them. This cannot be undone. To remove it from this connection only, use “Detach from this connection”.`
              : `“${n.title}” will be deleted. This cannot be undone.`,
            confirmLabel: 'Delete everywhere',
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
      <div className="notes-panel notes-empty" aria-label={`Notes of ${connectionName}`}>
        <p className="hint">No notes for {connectionName} yet.</p>
        <div className="notes-empty-actions">
          <button className="btn" onClick={() => newNote('markdown')}>
            New note…
          </button>
          <button className="btn" onClick={() => void actions.attachFile(connectionId)}>
            Attach a file…
          </button>
          <button className="btn" onClick={addUrl}>
            Add a web address…
          </button>
          <button className="btn" onClick={() => void attachExisting()}>
            Attach an existing note…
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
    <div className="notes-panel" aria-label={`Notes of ${connectionName}`}>
      <div className="notes-head">
        <span className="notes-title" title={`Notes — ${connectionName}`}>
          Notes — <span className="notes-title-name">{connectionName}</span>
        </span>
        <button className="icon-btn" aria-label="Add a note" title="Add a note" onClick={addMenu}>
          <Icon name="plus" />
        </button>
      </div>

      {list.length > 1 && (
        <ul className="notes-list" role="listbox" aria-label="Documents" onKeyDown={onListKey}>
          {list.map((n) => (
            <li key={n.id} role="presentation">
              <button
                className="notes-item"
                role="option"
                aria-selected={n.id === selected?.id}
                title={
                  n.shared
                    ? `${n.title} — shared with ${sharedNames(n).join(', ') || 'other connections'}`
                    : n.title
                }
                tabIndex={n.id === selected?.id ? 0 : -1}
                onClick={() => void actions.select(connectionId, n.id)}
              >
                <span className="notes-item-title">{n.title}</span>
                {n.shared && <span className="notes-badge">shared</span>}
                {drafts[n.id] && (
                  <span className="notes-badge" title="Unsaved changes">
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
                {KIND_LABEL[selected.kind][content?.format ?? selected.format]}
                {selected.shared &&
                  ` · shared with ${sharedNames(selected).join(', ') || `${selected.sharedWith.length} more`}`}
              </span>
            </div>
            <button
              className="icon-btn"
              aria-label="Document actions"
              title="Document actions"
              onClick={moreMenu}
            >
              <Icon name="chevronDown" />
            </button>
          </div>

          <div className="notes-toolbar">
            {editable && (
              <div className="segmented" role="group" aria-label="Mode">
                <button
                  type="button"
                  aria-pressed={mode === 'preview'}
                  onClick={() => setMode('preview')}
                >
                  Preview
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'edit'}
                  onClick={() => setMode('edit')}
                >
                  Edit
                </button>
              </div>
            )}
            <input
              className="input notes-search"
              type="search"
              placeholder="Search"
              aria-label="Search in document"
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
                {hits ? `${Math.min(hit + 1, hits)} / ${hits}` : 'No matches'}
              </span>
            )}
            <div className="notes-zoom" role="group" aria-label="Zoom">
              <button
                className="icon-btn"
                aria-label="Zoom out"
                title="Zoom out"
                disabled={zoom <= 50}
                onClick={() => setZoom(zoom - ZOOM_STEP)}
              >
                −
              </button>
              <button
                className="notes-zoom-value"
                aria-label="Reset zoom to 100%"
                title="Reset to 100%"
                onClick={() => setZoom(100)}
              >
                {zoom}%
              </button>
              <button
                className="icon-btn"
                aria-label="Zoom in"
                title="Zoom in"
                disabled={zoom >= 200}
                onClick={() => setZoom(zoom + ZOOM_STEP)}
              >
                +
              </button>
              <button
                className="icon-btn"
                aria-label="Fit to width"
                title="Fit to width"
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
            {loading && <p className="hint">Loading…</p>}
            {failure && (
              <div className="notes-problem" role="alert">
                <p>{failure}</p>
                <button className="btn" onClick={() => void actions.loadContent(selected.id, true)}>
                  Try again
                </button>
              </div>
            )}
            {content && content.status !== 'ok' && (
              <div className="notes-problem" role="alert">
                <p>{content.problem ?? 'This document cannot be shown.'}</p>
                <div className="notes-empty-actions">
                  {content.status === 'missing' && (
                    <button
                      className="btn"
                      onClick={() => void actions.relocate(connectionId, selected.id)}
                    >
                      Locate file…
                    </button>
                  )}
                  {(content.status === 'offline' || content.status === 'error') && (
                    <button
                      className="btn"
                      onClick={() => void actions.loadContent(selected.id, true)}
                    >
                      Try again
                    </button>
                  )}
                  {selected.kind === 'remoteUrl' && (
                    <button
                      className="btn"
                      onClick={() => void ipc.noteOpenExternal(selected.id).catch(reportError)}
                    >
                      Open in browser
                    </button>
                  )}
                  {selected.kind === 'localFile' && content.status !== 'missing' && (
                    <button
                      className="btn"
                      onClick={() => void ipc.noteOpenExternal(selected.id).catch(reportError)}
                    >
                      Open in external application
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => void actions.detach(connectionId, selected.id)}
                  >
                    Detach
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
                aria-label="Edit note"
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
                <span role="alert">Not saved: {draft.error}</span>
                <button className="btn" onClick={() => void actions.flush(selected.id)}>
                  Retry
                </button>
              </>
            ) : draft ? (
              <span>{draft.state === 'saving' ? 'Saving…' : 'Unsaved changes'}</span>
            ) : selected.kind === 'internal' ? (
              <span>Saved on this computer</span>
            ) : selected.kind === 'localFile' ? (
              <span title={selected.source ?? ''}>Linked file (read-only)</span>
            ) : (
              <span title={selected.source ?? ''}>
                {content?.fromOffline
                  ? `Offline copy saved ${selected.offline ? when(selected.offline.savedAt) : ''}`
                  : `${hostOf(selected.source)} · read-only`}
                {selected.offline && !content?.fromOffline
                  ? ` · offline copy saved ${when(selected.offline.savedAt)}`
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
