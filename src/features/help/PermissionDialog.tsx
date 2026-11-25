// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { notify } from '../../components/Toasts';
import { errorMessage } from '../../i18n/errors';
import { t as tr } from '../../i18n';
import { ipc } from '../../shared/ipc';
import type { PermissionReport } from '../../shared/types';
import { copyText } from '../notes/DocView';
import { suggestedCommands, verdicts, type PermissionOperation } from './permissions';

export interface PermissionIssue {
  sessionId: string;
  operation: PermissionOperation;
  /** The directory the operation was attempted in (a canonical remote path). */
  dir: string;
  name?: string;
  count?: number;
  /** The account name the connection uses (what the user typed, not a probe result). */
  user: string;
}

type Diagnosis =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; report: PermissionReport }
  | { state: 'error'; message: string };

const TITLE = {
  createFolder: 'help.perm.titleCreateFolder',
  createFile: 'help.perm.titleCreateFile',
  rename: 'help.perm.titleRename',
  delete: 'help.perm.titleDelete',
  upload: 'help.perm.titleUpload',
} as const;

const DENIED = {
  createFolder: 'help.perm.deniedCreateFolder',
  createFile: 'help.perm.deniedCreateFile',
  rename: 'help.perm.deniedRename',
  delete: 'help.perm.deniedDelete',
  upload: 'help.perm.deniedUpload',
} as const;

export function PermissionDialog({
  issue,
  onClose,
}: {
  issue: PermissionIssue;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [details, setDetails] = useState(false);
  const [diagnosis, setDiagnosis] = useState<Diagnosis>({ state: 'idle' });

  const run = async () => {
    setDiagnosis({ state: 'running' });
    try {
      const report = await ipc.sftpDiagnosePermissions(issue.sessionId, issue.dir);
      setDiagnosis({ state: 'done', report });
    } catch (e) {
      setDiagnosis({ state: 'error', message: errorMessage(e) });
    }
  };

  const op = issue.operation;
  const denied =
    op === 'upload'
      ? t('help.perm.deniedUpload', { count: issue.count ?? 1 })
      : t(DENIED[op], { name: issue.name ?? '' });
  const create = op === 'createFolder' || op === 'createFile' || op === 'upload';
  const report = diagnosis.state === 'done' ? diagnosis.report : null;

  return (
    <Dialog
      title={t(TITLE[op])}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
            {details ? t('help.perm.hideDetails') : t('help.perm.showDetails')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={diagnosis.state === 'running'}
          >
            {t('help.perm.diagnose')}
          </button>
          <button className="btn" onClick={onClose} data-autofocus>
            {t('help.perm.close')}
          </button>
        </>
      }
    >
      <div className="dialog-body help-dialog" role="group" aria-label={t(TITLE[op])}>
        <p>{denied}</p>
        <p className="help-path">{issue.dir}</p>
        <p>
          {t('help.perm.connectedAs')} <strong>{issue.user || t('help.perm.userUnknown')}</strong>
        </p>
        <p className="hint">{t('help.perm.cautious')}</p>

        {details && (
          <div className="notice" data-testid="perm-details">
            <p>{create ? t('help.perm.detailCreate') : t('help.perm.detailRename')}</p>
            <p>{t('help.perm.detailDirs')}</p>
            <p>{t('help.perm.detailOther')}</p>
            <p>{t('help.perm.detailAdvice')}</p>
          </div>
        )}

        {diagnosis.state === 'running' && <p role="status">{t('help.perm.diagnosing')}</p>}
        {diagnosis.state === 'error' && (
          <p className="error-text" role="alert">
            {diagnosis.message}
          </p>
        )}
        {report && <Report report={report} dir={issue.dir} />}
      </div>
    </Dialog>
  );
}

function Report({ report, dir }: { report: PermissionReport; dir: string }) {
  const { t } = useTranslation();
  const r = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const noReport = report.exec !== 'ok';
  return (
    <section className="help-report" aria-label={t('help.perm.report')}>
      <h4>{t('help.perm.report')}</h4>
      {report.exec === 'unavailable' && <p>{t('help.perm.noExec')}</p>}
      {report.exec === 'timeout' && <p>{t('help.perm.timedOut')}</p>}
      {report.exec === 'failed' && <p>{t('help.perm.failedDiag')}</p>}
      {!noReport && report.platform === 'other' && <p>{t('help.perm.notLinux')}</p>}
      {!noReport && report.platform !== 'other' && (
        <>
          {report.pathRefused && <p className="hint">{t('help.perm.pathRefused')}</p>}
          <dl className="help-facts">
            {report.user && (
              <>
                <dt>{t('help.perm.account')}</dt>
                <dd>
                  {report.user.name} (uid {report.user.uid}, gid {report.user.gid})
                </dd>
                <dt>{t('help.perm.groups')}</dt>
                <dd>{report.user.groups.map((g) => `${g.name}(${g.gid})`).join(', ') || '—'}</dd>
              </>
            )}
            {report.target && (
              <>
                <dt>{t('help.perm.directory')}</dt>
                <dd className="help-path">{report.path}</dd>
                <dt>{t('help.perm.owner')}</dt>
                <dd>
                  {report.target.owner}:{report.target.group}
                </dd>
                <dt>{t('help.perm.mode')}</dt>
                <dd>
                  <code>{report.target.mode}</code>
                </dd>
              </>
            )}
            {report.access && (
              <>
                <dt>{t('help.perm.accessCheck')}</dt>
                <dd>
                  {report.access.write ? t('help.perm.writable') : t('help.perm.notWritable')}
                </dd>
              </>
            )}
          </dl>
          {report.chain.length > 0 && (
            <details>
              <summary>{t('help.perm.chain')}</summary>
              <ul className="help-chain">
                {report.chain.map((e, i) => (
                  <li key={i}>
                    <code>{e.mode}</code> {e.owner}:{e.group} {e.name}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {verdicts(report).map((v) => (
            <p key={v.key} data-testid="perm-verdict">
              {r(v.key, v.params)}
            </p>
          ))}
          <p className="hint">{t('help.perm.guess')}</p>
        </>
      )}
      <h4>{t('help.perm.suggest')}</h4>
      <ul className="help-examples">
        {suggestedCommands(dir).map((command) => (
          <li key={command}>
            <code>{command}</code>
            <button
              className="btn"
              type="button"
              aria-label={t('help.explain.copyAria', { command })}
              onClick={() =>
                void copyText(command).then((ok) =>
                  notify(ok ? tr('help.explain.copied') : tr('notes.copyFailed')),
                )
              }
            >
              {t('help.explain.copy')}
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">{t('help.explain.exampleNote')}</p>
    </section>
  );
}
