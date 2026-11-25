// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../i18n/errors';
import { memo, useEffect, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Icon } from '../../components/Icon';
import { useNotes } from '../notes/store';
import type { TabStatus } from '../sessions/store';
import type { Zone } from './dropTarget';
import type { Row } from './tree';
import { useTranslation } from 'react-i18next';

export interface DropMark {
  zone: Zone;
  invalid: boolean;
}

interface RowProps {
  row: Row;
  active: boolean;
  selected: boolean;
  /** Folder: number of connections inside. */
  count: number;
  status?: TabStatus;
  renaming: boolean;
  dragDisabled: boolean;
  drop: DropMark | null;
  focusable: boolean;
  onClick: (row: Row, e: React.MouseEvent) => void;
  onDoubleClick: (row: Row) => void;
  onToggle: (row: Row) => void;
  onContextMenu: (row: Row, e: React.MouseEvent) => void;
  onRename: (row: Row, name: string) => Promise<void>;
  onCancelRename: () => void;
}

export const SidebarRow = memo(function SidebarRow(props: RowProps) {
  const { t } = useTranslation();
  const { row, active, selected, count, status, renaming, drop, focusable } = props;
  // a quiet document mark, only for connections that have notes
  const notes = useNotes((s) =>
    row.node.kind === 'connection' ? (s.counts[row.node.connection.id] ?? 0) : 0,
  );
  const draggable = useDraggable({ id: row.key, disabled: props.dragDisabled || renaming });
  const droppable = useDroppable({ id: row.key });
  const isFolder = row.node.kind === 'folder';
  const node = row.node;
  const label = node.kind === 'folder' ? node.folder.name : node.connection.name;
  const hostMeta =
    node.kind === 'connection' && node.connection.name !== node.connection.host
      ? node.connection.host
      : null;
  const title =
    node.kind === 'connection'
      ? `${node.connection.username ? `${node.connection.username}@` : ''}${node.connection.host}:${node.connection.port}`
      : undefined;

  return (
    <div
      ref={(el) => {
        draggable.setNodeRef(el);
        droppable.setNodeRef(el);
      }}
      {...draggable.attributes}
      {...draggable.listeners}
      className="tree-row"
      role="treeitem"
      data-row-key={row.key}
      data-active={active || undefined}
      data-dragging={draggable.isDragging || undefined}
      data-drop={drop?.zone}
      data-drop-invalid={drop?.invalid || undefined}
      tabIndex={focusable ? 0 : -1}
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={isFolder ? row.expanded : undefined}
      style={{ paddingLeft: 6 + row.depth * 14 + (isFolder ? 0 : 18) }}
      title={title}
      onClick={(e) => props.onClick(row, e)}
      onDoubleClick={() => props.onDoubleClick(row)}
      onContextMenu={(e) => props.onContextMenu(row, e)}
    >
      {isFolder && (
        <span
          className="chevron"
          data-chevron
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle(row);
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
      )}
      <Icon name={isFolder ? 'folder' : 'server'} className="row-icon" />
      {renaming ? (
        <InlineRename
          initial={label}
          kind={isFolder ? 'folder' : 'connection'}
          onCommit={(name) => props.onRename(row, name)}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span className="row-label">{label}</span>
      )}
      {!renaming && hostMeta && <span className="row-meta">{hostMeta}</span>}
      {!renaming && isFolder && <span className="row-count">{count}</span>}
      {!renaming && notes > 0 && (
        <span
          className="row-notes"
          role="img"
          aria-label={t('conn.notesAria', { count: notes })}
          title={t('conn.notesAria', { count: notes })}
        >
          <Icon name="file" size={11} />
        </span>
      )}
      {!renaming && status && (
        <span className="status-dot" data-status={status} aria-label={t(`status.${status}`)} />
      )}
    </div>
  );
});

/**
 * In-place name editor. Enter confirms, Escape cancels. A failed validation
 * keeps the editor open with the original name still stored; leaving the field
 * saves a valid change and otherwise discards it.
 */
function InlineRename({
  initial,
  kind,
  onCommit,
  onCancel,
}: {
  initial: string;
  kind: 'folder' | 'connection';
  onCommit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const validate = (text: string): string | null => {
    const trimmed = text.trim();
    if (!trimmed)
      return kind === 'folder' ? t('conn.rename.emptyFolder') : t('conn.rename.emptyConnection');
    if (trimmed.length > 128) return t('conn.rename.tooLong');
    return null;
  };

  const commit = async (fromBlur: boolean) => {
    if (done.current) return;
    const problem = validate(value);
    if (value.trim() === initial) {
      done.current = true;
      return onCancel();
    }
    if (problem) {
      if (fromBlur) {
        done.current = true;
        return onCancel(); // keep the original name
      }
      return setError(problem);
    }
    try {
      done.current = true;
      await onCommit(value.trim());
    } catch (e) {
      done.current = false;
      if (fromBlur) {
        done.current = true;
        return onCancel();
      }
      setError(errorMessage(e));
    }
  };

  return (
    <span
      className="rename-wrap"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <input
        ref={input}
        className="input rename-input"
        value={value}
        aria-label={
          kind === 'folder' ? t('conn.rename.folderAria') : t('conn.rename.connectionAria')
        }
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        maxLength={200}
        spellCheck={false}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onBlur={() => void commit(true)}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep tree/global shortcuts away from the editor
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit(false);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
      />
      {error && (
        <span className="rename-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
