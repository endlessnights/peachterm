// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { reportError } from '../../../components/Toasts';
import { ipc, toAppError } from '../../../shared/ipc';
import type { DuplicateChoice, ImportPreview, RestoreResult } from '../../../shared/types';
import { useConnections } from '../../connections/store';
import { ItemTable, NotesSummary, ResultSummary, Stat, plural } from './shared';

/**
 * Import PeachTerm connection JSON. Choosing a file only stages it in Rust and
 * shows a preview; nothing changes until "Import". Existing profiles are never
 * overwritten silently: the default skips duplicates.
 */
export function ImportConnectionsDialog({ onClose }: { onClose: () => void }) {
  const refresh = useConnections((s) => s.refresh);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [policy, setPolicy] = useState<DuplicateChoice>('skip');
  // Notes in the file are added only when this stays ticked; nothing existing is overwritten.
  const [importNotes, setImportNotes] = useState(true);
  const [update, setUpdate] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The staged import is discarded when the dialog goes away without applying.
  const pending = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (pending.current) void ipc.portabilityCancel(pending.current).catch(() => undefined);
    },
    [],
  );

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await ipc.connectionsImportPick();
      if (!next) return; // dialog cancelled
      pending.current = next.token;
      setPreview(next);
      setPolicy('skip');
      setUpdate(new Set());
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await ipc.connectionsImportApply(
        preview.token,
        policy,
        [...update],
        importNotes && !!preview.notes,
      );
      pending.current = null;
      await refresh();
      setResult(outcome);
    } catch (e) {
      setError(toAppError(e).message);
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const duplicates = preview?.items.filter((i) => i.status === 'duplicate') ?? [];
  const willImport = !preview
    ? 0
    : preview.newCount +
      (policy === 'copy' ? preview.duplicateCount + preview.changedCount : 0) +
      (policy === 'update' ? update.size : 0);

  if (result) {
    return (
      <Dialog
        title="Import finished"
        onClose={onClose}
        footer={
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        }
      >
        <ResultSummary result={result} />
      </Dialog>
    );
  }

  if (!preview) {
    return (
      <Dialog
        title="Import connections"
        onClose={onClose}
        footer={
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void choose()} disabled={busy}>
              Choose file…
            </button>
          </>
        }
      >
        <div className="dialog-body">
          <p>
            Select a PeachTerm connections file (<span className="kbd">.json</span>). You will see a
            preview before anything is changed.
          </p>
          <div className="hint">
            Only files exported by PeachTerm are supported. Nothing in the file is executed, and no
            connection is opened.
          </div>
          {error && (
            <div className="error-text" role="alert">
              {error}
            </div>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Import connections"
      wide
      persistent
      onClose={onClose}
      footer={
        <>
          <span className="left settings-status" role="status">
            {error && <span className="error-text">{error}</span>}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void apply()}
            disabled={busy || willImport === 0}
          >
            {willImport === 0
              ? 'Nothing to import'
              : `Import ${plural(willImport, 'profile', 'profiles')}`}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <div className="hint" style={{ wordBreak: 'break-all' }}>
          {preview.fileName} · format version {preview.formatVersion}
        </div>
        <div className="stat-grid" role="group" aria-label="Import summary">
          <Stat value={preview.connectionCount} label="Connections" />
          <Stat value={preview.folderCount} label="Folders" />
          <Stat value={preview.newCount} label="New" />
          <Stat value={preview.duplicateCount + preview.changedCount} label="Possible duplicates" />
          <Stat value={preview.invalidCount} label="Invalid" warn={preview.invalidCount > 0} />
        </div>
        {preview.invalidCount > 0 && (
          <div className="notice notice-warn">
            {plural(preview.invalidCount, 'entry', 'entries')} cannot be imported:{' '}
            {preview.invalid
              .slice(0, 3)
              .map((i) => `${i.kind} #${i.index + 1} (${i.reason})`)
              .join('; ')}
            {preview.invalid.length > 3 ? '…' : ''}
          </div>
        )}
        {preview.unsupportedFields.length > 0 && (
          <div className="notice">
            Unsupported fields were ignored: {preview.unsupportedFields.join(', ')}.
          </div>
        )}
        {preview.relocatedCount > 0 && (
          <div className="notice">
            {plural(preview.relocatedCount, 'profile was', 'profiles were')} moved out of a folder
            that cannot be imported.
          </div>
        )}
        {(preview.keyPathsMissing > 0 || preview.needsKey > 0) && (
          <div className="notice">
            {preview.keyPathsMissing > 0 &&
              `${plural(preview.keyPathsMissing, 'key file path does', 'key file paths do')} not exist on this computer. `}
            {preview.needsKey > 0 &&
              `${plural(preview.needsKey, 'profile needs', 'profiles need')} an SSH key file chosen after import.`}
          </div>
        )}

        {preview.notes && (
          <>
            <NotesSummary notes={preview.notes} invalid={preview.notesInvalid} />
            <label className="check">
              <input
                type="checkbox"
                checked={importNotes}
                onChange={(e) => setImportNotes(e.target.checked)}
              />
              Import the server notes (existing notes are never overwritten)
            </label>
          </>
        )}
        {preview.duplicateCount + preview.changedCount > 0 && (
          <fieldset className="fieldset">
            <legend>Possible duplicates</legend>
            <label className="check">
              <input
                type="radio"
                name="dup"
                checked={policy === 'skip'}
                onChange={() => setPolicy('skip')}
              />
              Skip duplicates (default)
            </label>
            <label className="check">
              <input
                type="radio"
                name="dup"
                checked={policy === 'copy'}
                onChange={() => setPolicy('copy')}
              />
              Import as copies
            </label>
            <label className="check">
              <input
                type="radio"
                name="dup"
                checked={policy === 'update'}
                onChange={() => setPolicy('update')}
              />
              Update selected existing connections
            </label>
            {policy === 'update' && (
              <div className="hint">
                Updates the name, authentication, timeout and directory. Host, port and user are
                never changed, and saved passwords stay as they are.
              </div>
            )}
          </fieldset>
        )}

        <ItemTable
          items={preview.items}
          truncated={preview.itemsTruncated}
          renderPick={
            policy === 'update'
              ? (item) =>
                  item.status === 'duplicate' ? (
                    <input
                      type="checkbox"
                      aria-label={`Update ${item.name}`}
                      checked={update.has(item.index)}
                      onChange={() =>
                        setUpdate((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.index)) next.delete(item.index);
                          else next.add(item.index);
                          return next;
                        })
                      }
                    />
                  ) : null
              : undefined
          }
        />
        {policy === 'update' && duplicates.length === 0 && (
          <div className="hint">There are no duplicates that can be updated.</div>
        )}
      </div>
    </Dialog>
  );
}
