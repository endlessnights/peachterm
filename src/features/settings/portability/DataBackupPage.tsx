// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { CreateBackupWizard } from './CreateBackupWizard';
import { ExportConnectionsDialog } from './ExportConnectionsDialog';
import { ImportConnectionsDialog } from './ImportConnectionsDialog';
import { RestoreBackupWizard } from './RestoreBackupWizard';

type Open = 'export' | 'import' | 'backup' | 'restore' | null;

/** Settings → Data & Backup. Two independent groups; nothing else in the UI. */
export function DataBackupPage() {
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  return (
    <>
      <h3>Connection profiles</h3>
      <section className="data-group" aria-label="Connection profiles">
        <p className="hint">
          Transfer saved connection profiles without passwords or other secrets.
        </p>
        <div className="data-actions">
          <button className="btn" onClick={() => setOpen('export')}>
            Export Connections
          </button>
          <button className="btn" onClick={() => setOpen('import')}>
            Import Connections
          </button>
        </div>
      </section>

      <h3>Encrypted backups</h3>
      <section className="data-group" aria-label="Encrypted backups">
        <p className="hint">
          Back up connections, application preferences and optionally saved credentials using strong
          encryption.
        </p>
        <div className="data-actions">
          <button className="btn" onClick={() => setOpen('backup')}>
            Create Encrypted Backup
          </button>
          <button className="btn" onClick={() => setOpen('restore')}>
            Restore Encrypted Backup
          </button>
        </div>
        <div className="hint">
          SSH private key files are never included. A connections-only export does not contain
          passwords.
        </div>
      </section>

      {open === 'export' && <ExportConnectionsDialog onClose={close} />}
      {open === 'import' && <ImportConnectionsDialog onClose={close} />}
      {open === 'backup' && <CreateBackupWizard onClose={close} />}
      {open === 'restore' && <RestoreBackupWizard onClose={close} />}
    </>
  );
}
