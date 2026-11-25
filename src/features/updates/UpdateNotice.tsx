// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
import { t as tr } from '../../i18n';
import { formatPercent } from '../../i18n/format';
import { Dialog } from '../../components/Dialog';
import { useUpdates, updateProblem } from './store';

/** First meaningful line of the release notes, kept short. */
function summaryOf(notes: string | null): string {
  // the first line of prose: headings and list markers are skipped
  const line = (notes ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^[>*\-\s]+/, '').trim())
    .find((l) => l.length > 0);
  return line ? (line.length > 140 ? `${line.slice(0, 137)}…` : line) : tr('update.summaryDefault');
}

/**
 * The compact, non-modal notice. It opens once per new version (and when the user
 * clicks the small indicator); "Later" closes it and leaves only the indicator.
 */
export function UpdateNotice() {
  const { t } = useTranslation();
  const phase = useUpdates((s) => s.phase);
  const open = useUpdates((s) => s.noticeOpen);
  const info = useUpdates((s) => s.info);
  const status = useUpdates((s) => s.status);
  const progress = useUpdates((s) => s.progress);
  const problem = useUpdates((s) => s.problem);
  const { closeNotice, download, requestInstall, openNotes } = useUpdates.getState();
  if (!open || !info || phase === 'idle' || phase === 'upToDate') return null;

  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <aside className="update-notice" role="region" aria-label={t('update.region')}>
      {phase === 'ready' || phase === 'installing' ? (
        <>
          <strong>{t('update.ready', { version: info.version })}</strong>
          <p className="hint">{t('update.readyHint')}</p>
          <div className="update-actions">
            <button
              className="btn btn-primary"
              onClick={() => void requestInstall()}
              disabled={phase === 'installing'}
            >
              {t('update.installRestart')}
            </button>
            <button className="btn" onClick={closeNotice}>
              {t('update.later')}
            </button>
          </div>
        </>
      ) : (
        <>
          <strong>{t('update.available', { version: info.version })}</strong>
          <p className="hint">
            {t('update.yourVersion', { version: status?.currentVersion ?? '' })}
          </p>
          <p>{summaryOf(info.notes)}</p>
          {phase === 'downloading' && (
            <p role="status" className="hint">
              {percent === null
                ? t('update.downloading')
                : t('update.downloadingPercent', { percent: formatPercent(percent) })}
            </p>
          )}
          {problem && <p className="field-error">{updateProblem(problem)}</p>}
          {status && !status.canInstall && <p className="hint">{t('update.noSelfUpdate')}</p>}
          <div className="update-actions">
            <button className="btn" onClick={openNotes}>
              {status && !status.canInstall ? t('update.releasePage') : t('update.releaseNotes')}
            </button>
            <button className="btn" onClick={closeNotice}>
              {t('update.later')}
            </button>
            {(!status || status.canInstall) && (
              <button
                className="btn btn-primary"
                onClick={() => void download()}
                disabled={phase === 'downloading'}
              >
                {t('update.download')}
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/** Asked before installing when something would be lost. "Install Later" is the default. */
export function InstallConfirm() {
  const { t } = useTranslation();
  const summary = useUpdates((s) => s.confirm);
  const info = useUpdates((s) => s.info);
  const { cancelInstall, install } = useUpdates.getState();
  if (!summary) return null;
  const lines: string[] = [];
  if (summary.sshActive > 0) lines.push(t('update.have.ssh', { count: summary.sshActive }));
  if (summary.tunnels > 0) lines.push(t('update.have.tunnels', { count: summary.tunnels }));
  if (summary.localActive > 0) lines.push(t('update.have.local', { count: summary.localActive }));
  if (summary.connecting > 0)
    lines.push(t('update.have.connecting', { count: summary.connecting }));
  if (summary.transfers > 0) lines.push(t('update.have.transfers', { count: summary.transfers }));
  if (summary.pendingUploads > 0)
    lines.push(t('update.have.uploads', { count: summary.pendingUploads }));
  if (summary.unsavedConnection) lines.push(t('update.have.unsavedConnection'));
  if (summary.unsavedSettings) lines.push(t('update.have.unsavedSettings'));
  if (summary.unsavedNotes) lines.push(t('update.have.unsavedNotes'));
  return (
    <Dialog
      title={t('update.confirmTitle')}
      onClose={cancelInstall}
      footer={
        <>
          <button className="btn btn-primary" onClick={cancelInstall} data-autofocus>
            {t('update.installLater')}
          </button>
          <button className="btn btn-danger" onClick={() => void install()}>
            {t('update.installRestart')}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p>{t('update.confirmIntro', { version: info?.version ?? '' })}</p>
        <ul className="exit-list" aria-label={t('update.confirmList')}>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>{t('update.confirmBody')}</p>
      </div>
    </Dialog>
  );
}
