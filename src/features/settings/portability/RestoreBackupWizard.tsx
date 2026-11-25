// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../../i18n/errors';
import { Trans, useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { ipc } from '../../../shared/ipc';
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
import { ItemTable, NotesSummary, ResultSummary, Stat, StepHeader, formatBytes } from './shared';

type Step = 'file' | 'passphrase' | 'options' | 'result';
const ORDER: Step[] = ['file', 'passphrase', 'options', 'result'];
export function RestoreBackupWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
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
      setError(errorMessage(e));
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
      setError(errorMessage(e));
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
      setError(errorMessage(e));
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
        {t('common.close')}
      </button>
    );
  } else {
    footer = (
      <>
        <span className="left settings-status" role="status">
          {error && <span className="error-text">{error}</span>}
        </span>
        <button className="btn" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </button>
        {step === 'file' && (
          <button className="btn btn-primary" onClick={() => void choose()} disabled={busy}>
            {t('port.restore.chooseFile')}
          </button>
        )}
        {step === 'passphrase' && (
          <button
            className="btn btn-primary"
            onClick={() => void unlock()}
            disabled={busy || passphrase === ''}
          >
            {busy ? t('port.restore.decrypting') : t('port.restore.decrypt')}
          </button>
        )}
        {step === 'options' && (
          <button
            className={`btn ${mode === 'replace' ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => void apply()}
            disabled={!canApply}
          >
            {mode === 'replace' ? t('port.restore.replaceRestore') : t('port.restore.restore')}
          </button>
        )}
      </>
    );
  }

  return (
    <Dialog
      title={t('port.restore.title')}
      wide={step === 'options'}
      persistent
      onClose={onClose}
      footer={footer}
    >
      <div className="dialog-body">
        <StepHeader step={index + 1} total={ORDER.length} title={t(`port.restore.step.${step}`)} />

        {step === 'file' && (
          <>
            <p>
              <Trans
                i18nKey="port.restore.selectFile"
                components={{ kbd: <span className="kbd" /> }}
              />
            </p>
            <div className="hint">{t('port.restore.nextHint')}</div>
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
              {t('port.restore.fileLine', {
                name: file.fileName,
                size: formatBytes(file.sizeBytes),
                version: file.formatVersion,
              })}
            </div>
            <label className="field">
              <span>{t('port.restore.passphraseLabel')}</span>
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
              {t('port.showPassphrase')}
            </label>
          </form>
        )}

        {step === 'options' && preview && (
          <>
            <div className="hint">
              {t('port.restore.created', {
                when: preview.createdAt || t('port.restore.unknownTime'),
                version: preview.appVersion,
              })}
            </div>
            <div className="stat-grid" role="group" aria-label={t('port.restore.contentsAria')}>
              <Stat value={preview.connectionCount} label={t('port.stat.connections')} />
              <Stat value={preview.folderCount} label={t('port.stat.folders')} />
              <Stat
                value={preview.settingsIncluded ? t('port.stat.yes') : t('port.stat.no')}
                label={t('port.stat.settings')}
              />
              <Stat value={preview.credentialCount} label={t('port.stat.savedPasswords')} />
              <Stat
                value={preview.duplicateCount + preview.changedCount}
                label={t('port.stat.conflicts')}
                warn={preview.duplicateCount + preview.changedCount > 0}
              />
            </div>
            {preview.invalidCount > 0 && (
              <div className="notice notice-warn">
                {t('port.restore.invalidEntries', { count: preview.invalidCount })}
              </div>
            )}
            {(preview.keyPathsMissing > 0 || preview.needsKey > 0) && (
              <div className="notice">
                {preview.keyPathsMissing > 0 &&
                  `${t('port.restore.keyPathsMissing', { count: preview.keyPathsMissing })} `}
                {preview.needsKey > 0 &&
                  `${t('port.restore.needsKeyChosen', { count: preview.needsKey })} `}
                {t('port.restore.keyNote')}
              </div>
            )}

            <fieldset className="fieldset">
              <legend>{t('port.restore.modeLegend')}</legend>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'merge'}
                  onChange={() => setMode('merge')}
                />
                {t('port.restore.modeMerge')}
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'selected'}
                  onChange={() => setMode('selected')}
                />
                {t('port.restore.modeSelected')}
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                />
                {t('port.restore.modeReplace')}
              </label>
            </fieldset>

            {mode === 'replace' && (
              <div className="notice notice-warn" role="alert">
                <Trans i18nKey="port.restore.replaceWarn" components={{ strong: <strong /> }} />
                <label className="check" style={{ marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={confirmReplace}
                    onChange={(e) => setConfirmReplace(e.target.checked)}
                  />
                  {t('port.restore.replaceConfirm')}
                </label>
              </div>
            )}

            {mode !== 'replace' && preview.duplicateCount + preview.changedCount > 0 && (
              <fieldset className="fieldset">
                <legend>{t('port.restore.existingLegend')}</legend>
                {(
                  [
                    ['skip', t('port.restore.existingSkip')],
                    ['copy', t('port.restore.existingCopy')],
                    ['update', t('port.restore.existingUpdate')],
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
                        aria-label={t('port.restore.restoreAria', { name: item.name })}
                        checked={selected.has(item.index)}
                        onChange={() => toggle(selected, setSelected, item.index)}
                      />
                    )
                  : mode === 'merge' && duplicates === 'update'
                    ? (item) =>
                        item.status === 'duplicate' ? (
                          <input
                            type="checkbox"
                            aria-label={t('port.updateAria', { name: item.name })}
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
                {t('port.restore.settingsCheck')}
              </label>
            )}

            {preview.notes && (
              <fieldset className="fieldset">
                <legend>{t('port.restore.notesLegend')}</legend>
                <NotesSummary notes={preview.notes} invalid={preview.notesInvalid} />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={restoreNotes}
                    onChange={(e) => setRestoreNotes(e.target.checked)}
                  />
                  {t('port.restore.notesCheck')}
                </label>
              </fieldset>
            )}

            {hasCredentials && (
              <fieldset className="fieldset">
                <legend>{t('port.restore.credsLegend')}</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={restoreCredentials}
                    disabled={!preview.credentialStoreAvailable}
                    onChange={(e) => setRestoreCredentials(e.target.checked)}
                  />
                  {t('port.restore.credsCheck', { count: preview.credentialCount })}
                </label>
                {!preview.credentialStoreAvailable && (
                  <div className="notice notice-warn">{t('port.restore.storeUnavailable')}</div>
                )}
                {restoreCredentials && (
                  <>
                    <div className="hint">{t('port.restore.credsConflict')}</div>
                    {(
                      [
                        ['keep', t('port.restore.credsKeep')],
                        ['replace', t('port.restore.credsReplace')],
                        ['skip', t('port.restore.credsSkip')],
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
                        {t('port.restore.credsConfirm')}
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
