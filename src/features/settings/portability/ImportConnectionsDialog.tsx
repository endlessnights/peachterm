// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../../i18n/errors';
import { Trans, useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { reportError } from '../../../components/Toasts';
import { ipc } from '../../../shared/ipc';
import type { DuplicateChoice, ImportPreview, RestoreResult } from '../../../shared/types';
import { useConnections } from '../../connections/store';
import { ItemTable, NotesSummary, ResultSummary, Stat } from './shared';

/**
 * Import PeachTerm connection JSON. Choosing a file only stages it in Rust and
 * shows a preview; nothing changes until "Import". Existing profiles are never
 * overwritten silently: the default skips duplicates.
 */
export function ImportConnectionsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
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
      setError(errorMessage(e));
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
      setError(errorMessage(e));
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
        title={t('port.import.finished')}
        onClose={onClose}
        footer={
          <button className="btn btn-primary" onClick={onClose}>
            {t('common.close')}
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
        title={t('port.import.title')}
        onClose={onClose}
        footer={
          <>
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void choose()} disabled={busy}>
              {t('port.import.chooseFile')}
            </button>
          </>
        }
      >
        <div className="dialog-body">
          <p>
            <Trans i18nKey="port.import.select" components={{ kbd: <span className="kbd" /> }} />
          </p>
          <div className="hint">{t('port.import.supported')}</div>
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
      title={t('port.import.title')}
      wide
      persistent
      onClose={onClose}
      footer={
        <>
          <span className="left settings-status" role="status">
            {error && <span className="error-text">{error}</span>}
          </span>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void apply()}
            disabled={busy || willImport === 0}
          >
            {willImport === 0
              ? t('port.import.nothing')
              : t('port.import.button', { count: willImport })}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <div className="hint" style={{ wordBreak: 'break-all' }}>
          {t('port.import.fileLine', { name: preview.fileName, version: preview.formatVersion })}
        </div>
        <div className="stat-grid" role="group" aria-label={t('port.import.summaryAria')}>
          <Stat value={preview.connectionCount} label={t('port.stat.connections')} />
          <Stat value={preview.folderCount} label={t('port.stat.folders')} />
          <Stat value={preview.newCount} label={t('port.stat.new')} />
          <Stat
            value={preview.duplicateCount + preview.changedCount}
            label={t('port.stat.possibleDup')}
          />
          <Stat
            value={preview.invalidCount}
            label={t('port.stat.invalid')}
            warn={preview.invalidCount > 0}
          />
        </div>
        {preview.invalidCount > 0 && (
          <div className="notice notice-warn">
            {t('port.import.invalidList', {
              count: preview.invalidCount,
              list:
                preview.invalid
                  .slice(0, 3)
                  .map((i) => `${i.kind} #${i.index + 1} (${i.reason})`)
                  .join('; ') + (preview.invalid.length > 3 ? '…' : ''),
            })}
          </div>
        )}
        {preview.unsupportedFields.length > 0 && (
          <div className="notice">
            {t('port.import.unsupportedFields', { fields: preview.unsupportedFields.join(', ') })}
          </div>
        )}
        {preview.relocatedCount > 0 && (
          <div className="notice">
            {t('port.import.relocated', { count: preview.relocatedCount })}
          </div>
        )}
        {(preview.keyPathsMissing > 0 || preview.needsKey > 0) && (
          <div className="notice">
            {preview.keyPathsMissing > 0 &&
              `${t('port.keyPathsMissing', { count: preview.keyPathsMissing })} `}
            {preview.needsKey > 0 && t('port.needsKey', { count: preview.needsKey })}
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
              {t('port.import.notesCheck')}
            </label>
          </>
        )}
        {preview.duplicateCount + preview.changedCount > 0 && (
          <fieldset className="fieldset">
            <legend>{t('port.dup.legend')}</legend>
            <label className="check">
              <input
                type="radio"
                name="dup"
                checked={policy === 'skip'}
                onChange={() => setPolicy('skip')}
              />
              {t('port.dup.skip')}
            </label>
            <label className="check">
              <input
                type="radio"
                name="dup"
                checked={policy === 'copy'}
                onChange={() => setPolicy('copy')}
              />
              {t('port.dup.copy')}
            </label>
            <label className="check">
              <input
                type="radio"
                name="dup"
                checked={policy === 'update'}
                onChange={() => setPolicy('update')}
              />
              {t('port.dup.update')}
            </label>
            {policy === 'update' && <div className="hint">{t('port.dup.updateHint')}</div>}
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
                      aria-label={t('port.updateAria', { name: item.name })}
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
          <div className="hint">{t('port.noUpdatable')}</div>
        )}
      </div>
    </Dialog>
  );
}
