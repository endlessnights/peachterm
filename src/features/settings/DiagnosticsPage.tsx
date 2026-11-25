// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
import { t as tr } from '../../i18n';
import { formatBytes } from './portability/shared';
import { useCallback, useEffect, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { reportError } from '../../components/Toasts';
import { ipc, isTauri } from '../../shared/ipc';
import type { ExportOutcome, ExportPreview, LogLevel, LoggingStatus } from '../../shared/types';
import { Field, Segmented, numberInput, type PageProps } from './controls';

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

const REASON_TOKENS = [
  'permission_denied',
  'not_found',
  'not_a_directory',
  'is_a_directory',
  'disk_full',
  'read_only',
  'invalid_path',
  'relative_path',
  'timeout',
  'writer_stopped',
] as const;

export const describeReason = (token: string | null) =>
  token
    ? (REASON_TOKENS as readonly string[]).includes(token)
      ? tr(`diag.reason.${token as (typeof REASON_TOKENS)[number]}`)
      : token.replace(/_/g, ' ')
    : '';

type ExportState =
  | { step: 'idle' }
  | { step: 'review'; preview: ExportPreview }
  | { step: 'done'; outcome: ExportOutcome };

interface Props extends PageProps {
  /** Increments whenever the dialog applied settings, so the status is re-read. */
  appliedTick: number;
}

export function DiagnosticsPage({ draft, patch, appliedTick }: Props) {
  const { t } = useTranslation();
  const d = draft.diagnostics;
  const [status, setStatus] = useState<LoggingStatus | null>(null);
  const [exporting, setExporting] = useState<ExportState>({ step: 'idle' });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => ipc.loggingStatus().then(setStatus).catch(reportError), []);
  useEffect(() => {
    void refresh();
  }, [refresh, appliedTick]);

  const browse = async () => {
    const picked = await openFileDialog({
      directory: true,
      multiple: false,
      title: t('diag.selectFolder'),
    });
    if (typeof picked === 'string') patch('diagnostics', { logDir: picked });
  };

  const startExport = async () => {
    try {
      setExporting({ step: 'review', preview: await ipc.loggingExportPreview() });
    } catch (e) {
      reportError(e);
    }
  };

  const runExport = async () => {
    setBusy(true);
    try {
      const outcome = await ipc.loggingExport();
      setExporting(outcome.savedTo ? { step: 'done', outcome } : { step: 'idle' });
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>{t('diag.fileLogging')}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={d.fileLogging}
          onChange={(e) => patch('diagnostics', { fileLogging: e.target.checked })}
        />
        {t('diag.writeLogs')}
      </label>
      <Field label={t('diag.levelLabel')} hint={t('diag.levelHint')}>
        <Segmented
          value={d.level}
          options={LEVELS.map((value) => ({ value, label: t(`diag.level.${value}`) }))}
          onChange={(level) => patch('diagnostics', { level })}
        />
      </Field>
      <Field label={t('diag.folder')} hint={t('diag.folderHint')}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={d.logDir ?? ''}
            placeholder={
              status && !status.customDir ? status.effectiveDir : t('diag.defaultLocation')
            }
            onChange={(e) => patch('diagnostics', { logDir: e.target.value || null })}
            spellCheck={false}
            aria-label={t('diag.folder')}
          />
          {isTauri() && (
            <button type="button" className="btn" onClick={() => void browse()}>
              {t('settings.editor.browse')}
            </button>
          )}
          {d.logDir && (
            <button
              type="button"
              className="btn"
              onClick={() => patch('diagnostics', { logDir: null })}
            >
              {t('diag.default')}
            </button>
          )}
        </div>
      </Field>
      <div className="settings-grid">
        <Field label={t('diag.keepFor')}>
          <Segmented
            value={d.retentionDays}
            options={([7, 14, 30] as const).map((value) => ({
              value,
              label: t('diag.days', { count: value }),
            }))}
            onChange={(retentionDays) => patch('diagnostics', { retentionDays })}
          />
        </Field>
        <Field label={t('diag.maxSize')} hint={t('diag.maxSizeHint')}>
          {numberInput(d.maxTotalMb, (n) => patch('diagnostics', { maxTotalMb: n }), 10, 1000)}
        </Field>
      </div>
      <h3>{t('diag.status')}</h3>
      <div className="hint">{t('diag.statusHint')}</div>
      <LoggingStatusView status={status} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => ipc.loggingOpenDir().catch(reportError)}>
          {t('diag.openFolder')}
        </button>
        <button className="btn" onClick={() => void startExport()} disabled={busy}>
          {t('diag.export')}
        </button>
      </div>

      {exporting.step === 'review' && (
        <div className="notice" role="region" aria-label={t('diag.exportReview')}>
          <strong>{t('diag.exportFiles')}</strong>
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
            {exporting.preview.files.map((f) => (
              <li key={f.name} style={{ userSelect: 'text' }}>
                {f.name}
                {f.bytes > 0 && <span className="hint"> — {formatBytes(f.bytes)}</span>}
              </li>
            ))}
          </ul>
          <div className="hint">{t('diag.exportNotIncluded')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" onClick={() => void runExport()} disabled={busy}>
              {t('diag.chooseAndExport')}
            </button>
            <button className="btn" onClick={() => setExporting({ step: 'idle' })}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {exporting.step === 'done' && (
        <div className="notice" role="status">
          <strong>{t('diag.archiveSaved')}</strong>
          <div style={{ userSelect: 'text', wordBreak: 'break-all' }}>
            {exporting.outcome.savedTo} ({formatBytes(exporting.outcome.archiveBytes)})
          </div>
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
            {exporting.outcome.entries.map((e) => (
              <li key={e.name}>
                {t('diag.entryLines', { name: e.name, kept: e.linesKept })}
                {e.linesDropped > 0 && t('diag.entryDropped', { dropped: e.linesDropped })}
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => ipc.loggingRevealExport().catch(reportError)}>
            {t('diag.showInFolder')}
          </button>
        </div>
      )}
    </>
  );
}

function LoggingStatusView({ status }: { status: LoggingStatus | null }) {
  const { t } = useTranslation();
  if (!status) return <div className="hint">{t('settings.security.checking')}</div>;
  const warn = status.enabled && !status.active;
  return (
    <div className={warn ? 'notice notice-warn' : 'notice'} role="status">
      {!status.enabled ? (
        <div>{t('diag.statusOff')}</div>
      ) : status.active ? (
        <div>{t('diag.statusActive', { level: status.level })}</div>
      ) : (
        <div>{t('diag.statusUnavailable', { reason: describeReason(status.error) })}</div>
      )}
      <div style={{ userSelect: 'text', wordBreak: 'break-all' }}>
        {t('diag.folderLine', {
          dir: status.effectiveDir,
          kind: status.customDir ? t('diag.custom') : t('diag.defaultKind'),
        })}
      </div>
      <div>
        {t('diag.statLine', {
          count: status.fileCount,
          size: formatBytes(status.totalBytes),
          days: status.retentionDays,
          max: status.maxTotalMb,
        })}
        {status.droppedLines > 0 && ` · ${t('diag.dropped', { count: status.droppedLines })}`}
      </div>
    </div>
  );
}
