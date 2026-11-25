// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
import { formatDecimal, formatNumber, formatUnitList } from '../../../i18n/format';
import type { ReactNode } from 'react';
import type { NotesPreview, PreviewItem, RestoreResult } from '../../../shared/types';

export const formatBytes = (n: number) =>
  n < 1024
    ? `${formatNumber(n)} B`
    : n < 1024 * 1024
      ? `${formatDecimal(n / 1024, 1)} KB`
      : `${formatDecimal(n / 1024 / 1024, 1)} MB`;

export function Stat({ value, label, warn }: { value: ReactNode; label: string; warn?: boolean }) {
  return (
    <div className={`stat${warn ? ' stat-warn' : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function StepHeader({ step, total, title }: { step: number; total: number; title: string }) {
  const { t } = useTranslation();
  return (
    <div className="wizard-step" aria-live="polite">
      <span className="hint">{t('port.step', { step, total })}</span>
      <strong>{title}</strong>
    </div>
  );
}

/** Profile summaries only: never credentials. */
export function ItemTable({
  items,
  truncated,
  renderPick,
}: {
  items: PreviewItem[];
  truncated: boolean;
  renderPick?: (item: PreviewItem) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="preview-table" role="table" aria-label={t('port.profiles')}>
      {items.map((item) => (
        <div className="preview-row" role="row" key={item.index}>
          {renderPick && <span className="preview-pick">{renderPick(item)}</span>}
          <span className="preview-main" role="cell">
            <strong>{item.name}</strong>
            <span className="hint">
              {item.username ? `${item.username}@` : ''}
              {item.host.includes(':') ? `[${item.host}]` : item.host}:{item.port}
              {item.folderPath ? ` · ${item.folderPath}` : ''}
            </span>
          </span>
          <span className={`badge badge-${item.status}`} role="cell">
            {t(`port.status.${item.status}`)}
          </span>
        </div>
      ))}
      {truncated && <div className="hint">{t('port.truncated', { count: items.length })}</div>}
    </div>
  );
}

/** Counts only. Credential values never reach the renderer. */
export function ResultSummary({
  result,
  showCredentials,
}: {
  result: RestoreResult;
  showCredentials?: boolean;
}) {
  const { t } = useTranslation();
  const c = result.credentials;
  return (
    <div className="dialog-body" role="status">
      <div className="stat-grid">
        <Stat value={result.created + result.copied} label={t('port.result.imported')} />
        <Stat value={result.updated} label={t('port.result.updated')} />
        <Stat value={result.skipped} label={t('port.result.skipped')} />
        <Stat value={result.failed} label={t('port.result.failed')} warn={result.failed > 0} />
      </div>
      {result.foldersCreated > 0 && (
        <div className="hint">{t('port.result.folders', { count: result.foldersCreated })}</div>
      )}
      {result.settingsRestored && <div className="hint">{t('port.result.settings')}</div>}
      {showCredentials && (
        <div className="hint">
          {t('port.result.credentials', {
            parts: formatUnitList(
              [
                t('port.result.credRestored', { count: c.restored }),
                c.replaced > 0 && t('port.result.credReplaced', { count: c.replaced }),
                c.keptExisting > 0 && t('port.result.credKept', { count: c.keptExisting }),
                c.skipped > 0 && t('port.result.credSkipped', { count: c.skipped }),
                c.failed > 0 && t('port.result.credFailed', { count: c.failed }),
              ].filter((x): x is string => typeof x === 'string'),
            ),
          })}
        </div>
      )}
      {result.safetyCopy && <div className="hint">{t('port.result.safetyCopy')}</div>}
      {result.warnings.map((w) => (
        <div className="notice notice-warn" key={w}>
          {w}
        </div>
      ))}
      <div className="hint">{t('port.result.noConnect')}</div>
    </div>
  );
}

/** What a file or backup says about its server notes: counts only, never content. */
export function NotesSummary({ notes, invalid = 0 }: { notes: NotesPreview; invalid?: number }) {
  const { t } = useTranslation();
  const parts = [
    notes.internal > 0 && t('count.writtenNote', { count: notes.internal }),
    notes.linkedFiles > 0 && t('count.linkedFile', { count: notes.linkedFiles }),
    notes.webDocuments > 0 && t('count.webDocument', { count: notes.webDocuments }),
  ].filter((x): x is string => typeof x === 'string');
  return (
    <div className="notes-summary" aria-label={t('port.notes.aria')}>
      <strong>{t('port.notes.heading', { count: notes.notes })}</strong>
      <div className="hint">
        {parts.join(', ')}
        {notes.snapshots > 0 ? `; ${t('count.offlineCopy', { count: notes.snapshots })}` : ''}
        {notes.shared > 0 ? `; ${t('port.notes.shared', { count: notes.shared })}` : ''}.
      </div>
      {notes.linkedFiles > 0 && (
        <div className="hint">
          {t('port.notes.pathsOnly')}
          {notes.missingFiles > 0 && ` ${t('port.notes.missing', { count: notes.missingFiles })}`}
        </div>
      )}
      {notes.conflicts > 0 && (
        <div className="hint">{t('port.notes.conflicts', { count: notes.conflicts })}</div>
      )}
      {(notes.unattached > 0 || invalid > 0) && (
        <div className="hint">
          {notes.unattached > 0 && `${t('port.notes.unattached', { count: notes.unattached })} `}
          {invalid > 0 && t('port.notes.invalid', { count: invalid })}
        </div>
      )}
    </div>
  );
}
