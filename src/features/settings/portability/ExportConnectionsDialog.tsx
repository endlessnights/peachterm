// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
import { formatList } from '../../../i18n/format';
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { reportError } from '../../../components/Toasts';
import { ipc } from '../../../shared/ipc';
import type { ConnectionsExportOutcome } from '../../../shared/types';
import { useConnections } from '../../connections/store';
import { useNotes } from '../../notes/store';

/**
 * Export saved connection profiles as portable JSON. The file never contains
 * passwords, passphrases, key contents or credential-store identifiers; key
 * file paths only with the explicit checkbox below. Rust opens the save
 * dialog, so this component never handles a path.
 */
export function ExportConnectionsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const tree = useConnections((s) => s.tree);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [keyPaths, setKeyPaths] = useState(false);
  // Server notes are NOT part of an export unless asked for (and only offered when some exist).
  const [withNotes, setWithNotes] = useState(false);
  const [withSnapshots, setWithSnapshots] = useState(false);
  const noteTotal = useNotes((st) => Object.values(st.counts).reduce((a, b) => a + b, 0));
  useEffect(() => {
    void useNotes.getState().refreshCounts();
  }, []);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ConnectionsExportOutcome | null>(null);

  const folderName = useMemo(
    () => new Map(tree.folders.map((f) => [f.id, f.name])),
    [tree.folders],
  );
  const sorted = useMemo(
    () => [...tree.connections].sort((a, b) => a.name.localeCompare(b.name)),
    [tree.connections],
  );
  const count = scope === 'all' ? tree.connections.length : picked.size;
  const withKeys = tree.connections.filter((c) => c.keyPath).length;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    setBusy(true);
    try {
      const outcome = await ipc.connectionsExport(
        scope === 'all' ? null : [...picked],
        keyPaths,
        withNotes && noteTotal > 0 ? { include: true, snapshots: withSnapshots } : undefined,
      );
      if (outcome.savedTo) setDone(outcome);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Dialog
        title={t('port.export.done')}
        onClose={onClose}
        footer={
          <button className="btn btn-primary" onClick={onClose}>
            {t('common.close')}
          </button>
        }
      >
        <div className="dialog-body" role="status">
          <p>
            {t('port.export.exported', {
              what: formatList([
                t('count.connection', { count: done.connections }),
                t('count.folder', { count: done.folders }),
              ]),
            })}
          </p>
          <div className="hint" style={{ userSelect: 'text', wordBreak: 'break-all' }}>
            {done.savedTo}
          </div>
          {(done.notes ?? 0) > 0 && (
            <div className="notice notice-warn">
              {t('port.export.notesWarn', { count: done.notes ?? 0 })}
            </div>
          )}
          <div className="notice">{t('port.export.noPasswords')}</div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('port.export.title')}
      onClose={onClose}
      persistent
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={busy || count === 0}
          >
            {t('port.export.button', { count })}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <label className="check">
          <input
            type="radio"
            name="export-scope"
            checked={scope === 'all'}
            onChange={() => setScope('all')}
          />
          {t('port.export.all', { count: tree.connections.length })}
        </label>
        <label className="check">
          <input
            type="radio"
            name="export-scope"
            checked={scope === 'selected'}
            onChange={() => setScope('selected')}
          />
          {t('port.export.selected')}
        </label>
        {scope === 'selected' && (
          <div className="preview-table" role="group" aria-label={t('port.export.pickAria')}>
            {sorted.map((c) => (
              <label className="check preview-row" key={c.id}>
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="preview-main">
                  <strong>{c.name}</strong>
                  <span className="hint">
                    {c.username ? `${c.username}@` : ''}
                    {c.host}:{c.port}
                    {c.folderId && folderName.get(c.folderId)
                      ? ` · ${folderName.get(c.folderId)}`
                      : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={keyPaths}
            onChange={(e) => setKeyPaths(e.target.checked)}
          />
          {t('port.export.keyPaths', { count: withKeys })}
        </label>
        {keyPaths && <div className="notice notice-warn">{t('port.export.keyPathsWarn')}</div>}
        {noteTotal > 0 && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={withNotes}
                onChange={(e) => setWithNotes(e.target.checked)}
              />
              {t('port.export.withNotes', { count: noteTotal })}
            </label>
            {withNotes && (
              <>
                <div className="notice notice-warn">{t('port.export.notesWarnLong')}</div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={withSnapshots}
                    onChange={(e) => setWithSnapshots(e.target.checked)}
                  />
                  {t('port.export.withSnapshots')}
                </label>
              </>
            )}
          </>
        )}
        <div className="hint">{t('port.export.hint')}</div>
      </div>
    </Dialog>
  );
}
