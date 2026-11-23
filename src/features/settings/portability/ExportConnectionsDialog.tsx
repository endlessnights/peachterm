// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { reportError } from '../../../components/Toasts';
import { ipc } from '../../../shared/ipc';
import type { ConnectionsExportOutcome } from '../../../shared/types';
import { useConnections } from '../../connections/store';
import { plural } from './shared';

/**
 * Export saved connection profiles as portable JSON. The file never contains
 * passwords, passphrases, key contents or credential-store identifiers; key
 * file paths only with the explicit checkbox below. Rust opens the save
 * dialog, so this component never handles a path.
 */
export function ExportConnectionsDialog({ onClose }: { onClose: () => void }) {
  const tree = useConnections((s) => s.tree);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [keyPaths, setKeyPaths] = useState(false);
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
      const outcome = await ipc.connectionsExport(scope === 'all' ? null : [...picked], keyPaths);
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
        title="Connections exported"
        onClose={onClose}
        footer={
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        }
      >
        <div className="dialog-body" role="status">
          <p>
            Exported {plural(done.connections, 'connection', 'connections')} and{' '}
            {plural(done.folders, 'folder', 'folders')}.
          </p>
          <div className="hint" style={{ userSelect: 'text', wordBreak: 'break-all' }}>
            {done.savedTo}
          </div>
          <div className="notice">
            Passwords and key passphrases are not in this file. To move them too, use an encrypted
            backup.
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Export connections"
      onClose={onClose}
      persistent
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={busy || count === 0}
          >
            Export {plural(count, 'connection', 'connections')}…
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
          All connections ({tree.connections.length})
        </label>
        <label className="check">
          <input
            type="radio"
            name="export-scope"
            checked={scope === 'selected'}
            onChange={() => setScope('selected')}
          />
          Selected connections
        </label>
        {scope === 'selected' && (
          <div className="preview-table" role="group" aria-label="Connections to export">
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
          Include SSH key file paths ({withKeys})
        </label>
        {keyPaths && (
          <div className="notice notice-warn">
            Key paths can reveal your user name and folder layout. Only the path is exported, never
            the key itself.
          </div>
        )}
        <div className="hint">
          The file contains no passwords, passphrases or private keys. Private SSH key files are
          never exported.
        </div>
      </div>
    </Dialog>
  );
}
