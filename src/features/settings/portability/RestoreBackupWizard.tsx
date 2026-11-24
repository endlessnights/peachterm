// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { ipc, toAppError } from '../../../shared/ipc';
import type {
  BackupFileInfo,
  CredentialConflict,
  DuplicateChoice,
  RestoreMode,
  RestorePreview,
  RestoreResult,
} from '../../../shared/types';
import { useConnections } from '../../connections/store';
import { useSettings } from '../store';
import {
  ItemTable,
  NotesSummary,
  ResultSummary,
  Stat,
  StepHeader,
  formatBytes,
  plural,
} from './shared';

type Step = 'file' | 'passphrase' | 'options' | 'result';
const ORDER: Step[] = ['file', 'passphrase', 'options', 'result'];
const TITLES: Record<Step, string> = {
  file: 'Select backup',
  passphrase: 'Enter passphrase',
  options: 'Review and restore',
  result: 'Restore finished',
};

/**
 * The backup is decrypted in Rust; this wizard only ever sees a redacted
 * preview (counts and profile summaries). It never receives a saved password.
 */
export function RestoreBackupWizard({ onClose }: { onClose: () => void }) {
  const refreshConnections = useConnections((s) => s.refresh);
  const loadSettings = useSettings((s) => s.load);
  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<BackupFileInfo | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [show, setShow] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [duplicates, setDuplicates] = useState<DuplicateChoice>('skip');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [update, setUpdate] = useState<Set<number>>(new Set());
  const [restoreSettings, setRestoreSettings] = useState(false);
  const [restoreCredentials, setRestoreCredentials] = useState(false);
  // On by default when the backup has notes; existing notes are always kept as they are.
  const [restoreNotes, setRestoreNotes] = useState(true);
  const [conflict, setConflict] = useState<CredentialConflict>('keep');
  const [confirmCredentials, setConfirmCredentials] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingToken = useRef<string | null>(null);
  useEffect(
    () => () => {
      // Closing in any way discards the decrypted backup held by Rust.
      if (pendingToken.current)
        void ipc.portabilityCancel(pendingToken.current).catch(() => undefined);
    },
    [],
  );

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await ipc.restorePick();
      if (!picked) return;
      pendingToken.current = picked.token;
      setFile(picked);
      setStep('passphrase');
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const opened = await ipc.restoreUnlock(file.token, passphrase);
      setPreview(opened);
      setSelected(new Set(opened.items.map((i) => i.index)));
      setRestoreSettings(false);
      setStep('options');
      setPassphrase('');
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await ipc.restoreApply(preview.token, {
        mode,
        selected: [...selected],
        duplicates,
        update: [...update],
        restoreSettings,
        restoreCredentials: restoreCredentials && preview.credentialCount > 0,
        restoreNotes: restoreNotes && !!preview.notes,
        credentialConflict: conflict,
        confirmReplaceCredentials: confirmCredentials,
        confirmReplaceAll: confirmReplace,
      });
      pendingToken.current = null;
      await refreshConnections();
      if (outcome.settingsRestored) await loadSettings();
      setResult(outcome);
      setStep('result');
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (set: Set<number>, put: (s: Set<number>) => void, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    put(next);
  };

  const replaceNeedsConfirm = mode === 'replace' && !confirmReplace;
  const credentialNeedsConfirm =
    restoreCredentials && conflict === 'replace' && !confirmCredentials;
  const nothingSelected = mode === 'selected' && selected.size === 0;
  const canApply = !busy && !replaceNeedsConfirm && !credentialNeedsConfirm && !nothingSelected;
  const hasCredentials = (preview?.credentialCount ?? 0) > 0;

  const index = ORDER.indexOf(step);
  let footer;
  if (step === 'result') {
    footer = (
      <button className="btn btn-primary" onClick={onClose}>
        Close
      </button>
    );
  } else {
    footer = (
      <>
        <span className="left settings-status" role="status">
          {error && <span className="error-text">{error}</span>}
        </span>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {step === 'file' && (
          <button className="btn btn-primary" onClick={() => void choose()} disabled={busy}>
            Choose backup file…
          </button>
        )}
        {step === 'passphrase' && (
          <button
            className="btn btn-primary"
            onClick={() => void unlock()}
            disabled={busy || passphrase === ''}
          >
            {busy ? 'Decrypting…' : 'Decrypt'}
          </button>
        )}
        {step === 'options' && (
          <button
            className={`btn ${mode === 'replace' ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => void apply()}
            disabled={!canApply}
          >
            {mode === 'replace' ? 'Replace and restore' : 'Restore'}
          </button>
        )}
      </>
    );
  }

  return (
    <Dialog
      title="Restore encrypted backup"
      wide={step === 'options'}
      persistent
      onClose={onClose}
      footer={footer}
    >
      <div className="dialog-body">
        <StepHeader step={index + 1} total={ORDER.length} title={TITLES[step]} />

        {step === 'file' && (
          <>
            <p>
              Select a PeachTerm backup (<span className="kbd">.peachbackup</span>). It works on any
              supported operating system.
            </p>
            <div className="hint">
              You will enter the passphrase next. Nothing is changed until you confirm the restore.
            </div>
          </>
        )}

        {step === 'passphrase' && file && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (passphrase !== '' && !busy) void unlock();
            }}
            className="dialog-body"
          >
            <div className="hint" style={{ wordBreak: 'break-all' }}>
              {file.fileName} · {formatBytes(file.sizeBytes)} · format version {file.formatVersion}
            </div>
            <label className="field">
              <span>Backup passphrase</span>
              <input
                className="input"
                type={show ? 'text' : 'password'}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-autofocus
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
              Show passphrase
            </label>
          </form>
        )}

        {step === 'options' && preview && (
          <>
            <div className="hint">
              Created {preview.createdAt || 'at an unknown time'} by PeachTerm {preview.appVersion}
            </div>
            <div className="stat-grid" role="group" aria-label="Backup contents">
              <Stat value={preview.connectionCount} label="Connections" />
              <Stat value={preview.folderCount} label="Folders" />
              <Stat value={preview.settingsIncluded ? 'Yes' : 'No'} label="Settings" />
              <Stat value={preview.credentialCount} label="Saved passwords" />
              <Stat
                value={preview.duplicateCount + preview.changedCount}
                label="Conflicts"
                warn={preview.duplicateCount + preview.changedCount > 0}
              />
            </div>
            {preview.invalidCount > 0 && (
              <div className="notice notice-warn">
                {plural(preview.invalidCount, 'entry', 'entries')} in the backup cannot be restored.
              </div>
            )}
            {(preview.keyPathsMissing > 0 || preview.needsKey > 0) && (
              <div className="notice">
                {preview.keyPathsMissing > 0 &&
                  `${plural(preview.keyPathsMissing, 'SSH key file path does', 'SSH key file paths do')} not exist on this computer. `}
                {preview.needsKey > 0 &&
                  `${plural(preview.needsKey, 'profile needs', 'profiles need')} a key file chosen. `}
                Private keys are not part of a backup; copy them yourself and re-select them.
              </div>
            )}

            <fieldset className="fieldset">
              <legend>Restore mode</legend>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'merge'}
                  onChange={() => setMode('merge')}
                />
                Merge with existing connections (default)
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'selected'}
                  onChange={() => setMode('selected')}
                />
                Restore selected profiles only
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                />
                Replace existing configuration
              </label>
            </fieldset>

            {mode === 'replace' && (
              <div className="notice notice-warn" role="alert">
                <strong>This replaces your saved connections and folders.</strong> A copy of the
                current connections file is kept. Saved passwords of connections that disappear are
                removed.
                <label className="check" style={{ marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={confirmReplace}
                    onChange={(e) => setConfirmReplace(e.target.checked)}
                  />
                  I understand that my current connections will be replaced
                </label>
              </div>
            )}

            {mode !== 'replace' && preview.duplicateCount + preview.changedCount > 0 && (
              <fieldset className="fieldset">
                <legend>Profiles that already exist</legend>
                {(
                  [
                    ['skip', 'Skip them (default)'],
                    ['copy', 'Restore as copies'],
                    ['update', 'Update the ones I select'],
                  ] as const
                ).map(([value, label]) => (
                  <label className="check" key={value}>
                    <input
                      type="radio"
                      name="dup"
                      checked={duplicates === value}
                      onChange={() => setDuplicates(value)}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            )}

            <ItemTable
              items={preview.items}
              truncated={preview.itemsTruncated}
              renderPick={
                mode === 'selected'
                  ? (item) => (
                      <input
                        type="checkbox"
                        aria-label={`Restore ${item.name}`}
                        checked={selected.has(item.index)}
                        onChange={() => toggle(selected, setSelected, item.index)}
                      />
                    )
                  : mode === 'merge' && duplicates === 'update'
                    ? (item) =>
                        item.status === 'duplicate' ? (
                          <input
                            type="checkbox"
                            aria-label={`Update ${item.name}`}
                            checked={update.has(item.index)}
                            onChange={() => toggle(update, setUpdate, item.index)}
                          />
                        ) : null
                    : undefined
              }
            />

            {preview.settingsIncluded && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={restoreSettings}
                  onChange={(e) => setRestoreSettings(e.target.checked)}
                />
                Restore application settings (themes, terminal palette, shortcuts)
              </label>
            )}

            {preview.notes && (
              <fieldset className="fieldset">
                <legend>Server notes</legend>
                <NotesSummary notes={preview.notes} invalid={preview.notesInvalid} />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={restoreNotes}
                    onChange={(e) => setRestoreNotes(e.target.checked)}
                  />
                  Restore server notes (existing notes are kept; notes are only added)
                </label>
              </fieldset>
            )}

            {hasCredentials && (
              <fieldset className="fieldset">
                <legend>Saved passwords</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={restoreCredentials}
                    disabled={!preview.credentialStoreAvailable}
                    onChange={(e) => setRestoreCredentials(e.target.checked)}
                  />
                  Restore saved passwords and passphrases ({preview.credentialCount})
                </label>
                {!preview.credentialStoreAvailable && (
                  <div className="notice notice-warn">
                    The system credential store is not available, so passwords cannot be restored.
                    They are never written to a plain file.
                  </div>
                )}
                {restoreCredentials && (
                  <>
                    <div className="hint">If a password is already saved for a profile:</div>
                    {(
                      [
                        ['keep', 'Keep the existing one (default)'],
                        ['replace', 'Replace it with the one from the backup'],
                        ['skip', 'Skip: restore nothing for existing profiles'],
                      ] as const
                    ).map(([value, label]) => (
                      <label className="check" key={value}>
                        <input
                          type="radio"
                          name="cred"
                          checked={conflict === value}
                          onChange={() => setConflict(value)}
                        />
                        {label}
                      </label>
                    ))}
                    {conflict === 'replace' && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={confirmCredentials}
                          onChange={(e) => setConfirmCredentials(e.target.checked)}
                        />
                        I confirm that existing saved passwords may be overwritten
                      </label>
                    )}
                  </>
                )}
              </fieldset>
            )}
          </>
        )}

        {step === 'result' && result && (
          <ResultSummary result={result} showCredentials={hasCredentials} />
        )}
      </div>
    </Dialog>
  );
}
