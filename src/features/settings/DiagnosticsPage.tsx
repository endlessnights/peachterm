// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { reportError } from '../../components/Toasts';
import { ipc, isTauri } from '../../shared/ipc';
import type { ExportOutcome, ExportPreview, LogLevel, LoggingStatus } from '../../shared/types';
import { Field, Segmented, numberInput, type PageProps } from './controls';

const LEVELS: { value: LogLevel; label: string }[] = [
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
  { value: 'trace', label: 'Trace' },
];

const REASONS: Record<string, string> = {
  permission_denied: 'permission denied',
  not_found: 'folder not found',
  not_a_directory: 'the path is not a folder',
  is_a_directory: 'the path is a folder',
  disk_full: 'the disk is full',
  read_only: 'the location is read-only',
  invalid_path: 'the path is invalid',
  relative_path: 'the folder must be an absolute path',
  timeout: 'the logger did not respond',
  writer_stopped: 'the logger has stopped',
};

export const describeReason = (token: string | null) =>
  token ? (REASONS[token] ?? token.replace(/_/g, ' ')) : '';

const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

type ExportState =
  | { step: 'idle' }
  | { step: 'review'; preview: ExportPreview }
  | { step: 'done'; outcome: ExportOutcome };

interface Props extends PageProps {
  /** Increments whenever the dialog applied settings, so the status is re-read. */
  appliedTick: number;
}

export function DiagnosticsPage({ draft, patch, appliedTick }: Props) {
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
      title: 'Select log folder',
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
      <h3>File logging</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={d.fileLogging}
          onChange={(e) => patch('diagnostics', { fileLogging: e.target.checked })}
        />
        Write diagnostic logs to a file
      </label>
      <Field
        label="Log level"
        hint="Debug and Trace add detail about events, never about content: passwords, keys, host names, paths and terminal data are never written at any level."
      >
        <Segmented
          value={d.level}
          options={LEVELS}
          onChange={(level) => patch('diagnostics', { level })}
        />
      </Field>
      <Field label="Log folder" hint="Leave empty to use the default location.">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={d.logDir ?? ''}
            placeholder={status && !status.customDir ? status.effectiveDir : 'Default location'}
            onChange={(e) => patch('diagnostics', { logDir: e.target.value || null })}
            spellCheck={false}
            aria-label="Log folder"
          />
          {isTauri() && (
            <button type="button" className="btn" onClick={() => void browse()}>
              Browse…
            </button>
          )}
          {d.logDir && (
            <button
              type="button"
              className="btn"
              onClick={() => patch('diagnostics', { logDir: null })}
            >
              Default
            </button>
          )}
        </div>
      </Field>
      <div className="settings-grid">
        <Field label="Keep logs for">
          <Segmented
            value={d.retentionDays}
            options={[
              { value: 7, label: '7 days' },
              { value: 14, label: '14 days' },
              { value: 30, label: '30 days' },
            ]}
            onChange={(retentionDays) => patch('diagnostics', { retentionDays })}
          />
        </Field>
        <Field label="Maximum total size (MB)" hint="Oldest files are removed first.">
          {numberInput(d.maxTotalMb, (n) => patch('diagnostics', { maxTotalMb: n }), 10, 1000)}
        </Field>
      </div>
      <h3>Status</h3>
      <div className="hint">
        Shows the applied configuration. Changes take effect on Apply or OK.
      </div>
      <LoggingStatusView status={status} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => ipc.loggingOpenDir().catch(reportError)}>
          Open log folder
        </button>
        <button className="btn" onClick={() => void startExport()} disabled={busy}>
          Export diagnostic logs…
        </button>
      </div>

      {exporting.step === 'review' && (
        <div className="notice" role="region" aria-label="Export review">
          <strong>These files will be exported (sanitised copies):</strong>
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
            {exporting.preview.files.map((f) => (
              <li key={f.name} style={{ userSelect: 'text' }}>
                {f.name}
                {f.bytes > 0 && <span className="hint"> — {formatBytes(f.bytes)}</span>}
              </li>
            ))}
          </ul>
          <div className="hint">
            Not included: settings, connections, saved passwords, host keys. Nothing is uploaded;
            you choose where the archive is saved and can open it before sharing.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" onClick={() => void runExport()} disabled={busy}>
              Choose location and export
            </button>
            <button className="btn" onClick={() => setExporting({ step: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {exporting.step === 'done' && (
        <div className="notice" role="status">
          <strong>Archive saved</strong>
          <div style={{ userSelect: 'text', wordBreak: 'break-all' }}>
            {exporting.outcome.savedTo} ({formatBytes(exporting.outcome.archiveBytes)})
          </div>
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
            {exporting.outcome.entries.map((e) => (
              <li key={e.name}>
                {e.name}: {e.linesKept} lines kept
                {e.linesDropped > 0 && `, ${e.linesDropped} dropped by the sanitiser`}
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => ipc.loggingRevealExport().catch(reportError)}>
            Show in folder
          </button>
        </div>
      )}
    </>
  );
}

function LoggingStatusView({ status }: { status: LoggingStatus | null }) {
  if (!status) return <div className="hint">Checking…</div>;
  const warn = status.enabled && !status.active;
  return (
    <div className={warn ? 'notice notice-warn' : 'notice'} role="status">
      {!status.enabled ? (
        <div>File logging is off.</div>
      ) : status.active ? (
        <div>Logging is active at level “{status.level}”.</div>
      ) : (
        <div>
          File logging is unavailable ({describeReason(status.error)}). PeachTerm keeps working
          without it.
        </div>
      )}
      <div style={{ userSelect: 'text', wordBreak: 'break-all' }}>
        Folder: {status.effectiveDir} {status.customDir ? '(custom)' : '(default)'}
      </div>
      <div>
        {status.fileCount} file{status.fileCount === 1 ? '' : 's'}, {formatBytes(status.totalBytes)}{' '}
        · keeping {status.retentionDays} days, up to {status.maxTotalMb} MB
        {status.droppedLines > 0 && ` · ${status.droppedLines} lines dropped (queue full)`}
      </div>
    </div>
  );
}
