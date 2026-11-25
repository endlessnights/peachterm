// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { quitNow, useExit } from './exit';

export function ExitDialog() {
  const { t } = useTranslation();
  const summary = useExit((s) => s.summary);
  const cancel = useExit((s) => s.cancel);
  if (!summary) return null;
  const lines: string[] = [];
  if (summary.sshActive > 0) lines.push(t('exit.ssh', { count: summary.sshActive }));
  if (summary.tunnels > 0) lines.push(t('exit.tunnels', { count: summary.tunnels }));
  if (summary.localActive > 0) lines.push(t('exit.local', { count: summary.localActive }));
  if (summary.connecting > 0) lines.push(t('exit.connecting', { count: summary.connecting }));
  if (summary.transfers > 0) lines.push(t('exit.transfers', { count: summary.transfers }));
  if (summary.pendingUploads > 0) lines.push(t('exit.uploads', { count: summary.pendingUploads }));
  if (summary.unsavedConnection) lines.push(t('exit.unsavedConnection'));
  if (summary.unsavedSettings) lines.push(t('exit.unsavedSettings'));
  if (summary.unsavedNotes) lines.push(t('exit.unsavedNotes'));
  return (
    <Dialog
      title={t('exit.title')}
      onClose={cancel}
      footer={
        <>
          {/* Cancel is the default answer: Enter and Esc keep the application open. */}
          <button className="btn btn-primary" onClick={cancel} data-autofocus>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger" onClick={quitNow}>
            {t('exit.confirm')}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p>{t('exit.intro')}</p>
        <ul className="exit-list" aria-label={t('exit.listAria')}>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
