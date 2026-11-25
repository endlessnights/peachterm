// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { CreateBackupWizard } from './CreateBackupWizard';
import { ExportConnectionsDialog } from './ExportConnectionsDialog';
import { ImportConnectionsDialog } from './ImportConnectionsDialog';
import { RestoreBackupWizard } from './RestoreBackupWizard';

type Open = 'export' | 'import' | 'backup' | 'restore' | null;

/** Settings → Data & Backup. Two independent groups; nothing else in the UI. */
export function DataBackupPage() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  return (
    <>
      <h3>{t('port.data.profilesHeading')}</h3>
      <section className="data-group" aria-label={t('port.data.profilesHeading')}>
        <p className="hint">{t('port.data.profilesHint')}</p>
        <div className="data-actions">
          <button className="btn" onClick={() => setOpen('export')}>
            {t('port.data.export')}
          </button>
          <button className="btn" onClick={() => setOpen('import')}>
            {t('port.data.import')}
          </button>
        </div>
      </section>

      <h3>{t('port.data.backupsHeading')}</h3>
      <section className="data-group" aria-label={t('port.data.backupsHeading')}>
        <p className="hint">{t('port.data.backupsHint')}</p>
        <div className="data-actions">
          <button className="btn" onClick={() => setOpen('backup')}>
            {t('port.data.create')}
          </button>
          <button className="btn" onClick={() => setOpen('restore')}>
            {t('port.data.restore')}
          </button>
        </div>
        <div className="hint">{t('port.data.note')}</div>
      </section>

      {open === 'export' && <ExportConnectionsDialog onClose={close} />}
      {open === 'import' && <ImportConnectionsDialog onClose={close} />}
      {open === 'backup' && <CreateBackupWizard onClose={close} />}
      {open === 'restore' && <RestoreBackupWizard onClose={close} />}
    </>
  );
}
