// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import type { NotesPreview, PreviewItem, RestoreResult } from '../../../shared/types';

export const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Stat({ value, label, warn }: { value: ReactNode; label: string; warn?: boolean }) {
  return (
    <div className={`stat${warn ? ' stat-warn' : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function StepHeader({ step, total, title }: { step: number; total: number; title: string }) {
  return (
    <div className="wizard-step" aria-live="polite">
      <span className="hint">
        Step {step} of {total}
      </span>
      <strong>{title}</strong>
    </div>
  );
}

const STATUS_LABEL: Record<PreviewItem['status'], string> = {
  new: 'New',
  duplicate: 'Duplicate',
  changed: 'Changed',
};

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
  return (
    <div className="preview-table" role="table" aria-label="Profiles">
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
            {STATUS_LABEL[item.status]}
          </span>
        </div>
      ))}
      {truncated && <div className="hint">Only the first {items.length} profiles are listed.</div>}
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
  const c = result.credentials;
  return (
    <div className="dialog-body" role="status">
      <div className="stat-grid">
        <Stat value={result.created + result.copied} label="Imported" />
        <Stat value={result.updated} label="Updated" />
        <Stat value={result.skipped} label="Skipped" />
        <Stat value={result.failed} label="Failed" warn={result.failed > 0} />
      </div>
      {result.foldersCreated > 0 && (
        <div className="hint">{plural(result.foldersCreated, 'folder', 'folders')} created.</div>
      )}
      {result.settingsRestored && <div className="hint">Application settings restored.</div>}
      {showCredentials && (
        <div className="hint">
          Saved passwords: {c.restored} restored
          {c.replaced > 0 ? `, ${c.replaced} replaced` : ''}
          {c.keptExisting > 0 ? `, ${c.keptExisting} kept as they were` : ''}
          {c.skipped > 0 ? `, ${c.skipped} skipped` : ''}
          {c.failed > 0 ? `, ${c.failed} failed` : ''}.
        </div>
      )}
      {result.safetyCopy && (
        <div className="hint">
          A copy of your previous connections was kept next to connections.json.
        </div>
      )}
      {result.warnings.map((w) => (
        <div className="notice notice-warn" key={w}>
          {w}
        </div>
      ))}
      <div className="hint">PeachTerm did not connect to any server.</div>
    </div>
  );
}

/** What a file or backup says about its server notes: counts only, never content. */
export function NotesSummary({ notes, invalid = 0 }: { notes: NotesPreview; invalid?: number }) {
  const parts = [
    notes.internal > 0 && plural(notes.internal, 'written note', 'written notes'),
    notes.linkedFiles > 0 && plural(notes.linkedFiles, 'linked file', 'linked files'),
    notes.webDocuments > 0 && plural(notes.webDocuments, 'web document', 'web documents'),
  ].filter(Boolean);
  return (
    <div className="notes-summary" aria-label="Server notes in this file">
      <strong>Server notes: {plural(notes.notes, 'note', 'notes')}</strong>
      <div className="hint">
        {parts.join(', ')}
        {notes.snapshots > 0
          ? `; ${plural(notes.snapshots, 'offline copy', 'offline copies')}`
          : ''}
        {notes.shared > 0 ? `; ${notes.shared} shared between connections` : ''}.
      </div>
      {notes.linkedFiles > 0 && (
        <div className="hint">
          Linked files are stored as paths only, never as their contents.
          {notes.missingFiles > 0 &&
            ` ${plural(notes.missingFiles, 'linked file was', 'linked files were')} not found on this computer.`}
        </div>
      )}
      {notes.conflicts > 0 && (
        <div className="hint">
          {plural(notes.conflicts, 'note already exists', 'notes already exist')} here and{' '}
          {notes.conflicts === 1 ? 'is' : 'are'} kept as{' '}
          {notes.conflicts === 1 ? 'it is' : 'they are'}; only missing attachments are added.
        </div>
      )}
      {(notes.unattached > 0 || invalid > 0) && (
        <div className="hint">
          {notes.unattached > 0 &&
            `${plural(notes.unattached, 'note belongs', 'notes belong')} to connections that are not part of this operation and ${notes.unattached === 1 ? 'is' : 'are'} left out. `}
          {invalid > 0 && `${plural(invalid, 'invalid note was', 'invalid notes were')} ignored.`}
        </div>
      )}
    </div>
  );
}
