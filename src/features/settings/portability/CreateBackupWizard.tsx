// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../../i18n/errors';
import { useTranslation } from 'react-i18next';
import { formatUnitList } from '../../../i18n/format';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { ipc } from '../../../shared/ipc';
import type { BackupSummary } from '../../../shared/types';
import { useConnections } from '../../connections/store';
import { useNotes } from '../../notes/store';
import { MIN_PASSPHRASE_CHARS, assessPassphrase } from './passphrase';
import { Stat, StepHeader, formatBytes } from './shared';

type Step = 'data' | 'passphrase' | 'destination' | 'result';

const ORDER: Step[] = ['data', 'passphrase', 'destination', 'result'];

/**
 * Four steps: data, passphrase, destination, encryption. All encryption runs in
 * Rust; the passphrase leaves this component exactly once (the create call)
 * and is wiped from state straight away.
 */
export function CreateBackupWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const tree = useConnections((s) => s.tree);
  const [step, setStep] = useState<Step>('data');
  const [includeSettings, setIncludeSettings] = useState(true);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  // Offered only when some connection has notes; on by default then.
  const [includeNotes, setIncludeNotes] = useState(true);
  const noteTotal = useNotes((st) => Object.values(st.counts).reduce((a, b) => a + b, 0));
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [destination, setDestination] = useState<{ token: string; path: string } | null>(null);
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingToken = useRef<string | null>(null);
  useEffect(() => {
    void useNotes.getState().refreshCounts();
  }, []);
  useEffect(
    () => () => {
      if (pendingToken.current)
        void ipc.portabilityCancel(pendingToken.current).catch(() => undefined);
    },
    [],
  );

  const credentialCount = tree.connections.filter((c) => c.hasStoredSecret).length;
  const strength = assessPassphrase(passphrase);
  const longEnough = [...passphrase.normalize('NFC')].length >= MIN_PASSPHRASE_CHARS;
  const matches = passphrase === confirm;
  const passphraseOk = longEnough && matches;

  const chooseDestination = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await ipc.backupChooseDestination();
      if (picked) {
        pendingToken.current = picked.token;
        setDestination(picked);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!destination) return;
    setBusy(true);
    setError(null);
    try {
      const made = await ipc.backupCreate(
        destination.token,
        { includeSettings, includeCredentials, includeNotes: includeNotes && noteTotal > 0 },
        passphrase,
        confirm,
      );
      pendingToken.current = null;
      setSummary(made);
      setStep('result');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      // The passphrase is never kept longer than needed.
      setPassphrase('');
      setConfirm('');
      setBusy(false);
    }
  };

  const index = ORDER.indexOf(step);
  const back = () => {
    setError(null);
    setStep(ORDER[Math.max(0, index - 1)] ?? 'data');
  };

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
        {step !== 'data' && (
          <button className="btn" onClick={back} disabled={busy}>
            {t('port.back')}
          </button>
        )}
        <button className="btn" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </button>
        {step === 'data' && (
          <button className="btn btn-primary" onClick={() => setStep('passphrase')}>
            {t('port.next')}
          </button>
        )}
        {step === 'passphrase' && (
          <button
            className="btn btn-primary"
            onClick={() => setStep('destination')}
            disabled={!passphraseOk}
          >
            {t('port.next')}
          </button>
        )}
        {step === 'destination' && (
          <button
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={!destination || busy}
          >
            {busy ? t('port.backup.encrypting') : t('port.backup.createButton')}
          </button>
        )}
      </>
    );
  }

  return (
    <Dialog title={t('port.backup.title')} onClose={onClose} persistent footer={footer}>
      <div className="dialog-body">
        <StepHeader step={index + 1} total={ORDER.length} title={t(`port.backup.step.${step}`)} />

        {step === 'data' && (
          <>
            <label className="check">
              <input type="checkbox" checked disabled readOnly />
              {t('port.backup.profiles', {
                connections: tree.connections.length,
                folders: tree.folders.length,
              })}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={includeSettings}
                onChange={(e) => setIncludeSettings(e.target.checked)}
              />
              {t('port.backup.settings')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={includeCredentials}
                onChange={(e) => setIncludeCredentials(e.target.checked)}
              />
              {t('port.backup.credentials', { count: credentialCount })}
            </label>
            {noteTotal > 0 && (
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={includeNotes}
                    onChange={(e) => setIncludeNotes(e.target.checked)}
                  />
                  {t('port.backup.notes', { count: noteTotal })}
                </label>
                {includeNotes && <div className="hint">{t('port.backup.notesHint')}</div>}
              </>
            )}
            {includeCredentials && (
              <div className="notice notice-warn">{t('port.backup.credsWarn')}</div>
            )}
            <div className="hint">{t('port.backup.keysNever')}</div>
          </>
        )}

        {step === 'passphrase' && (
          <>
            <div className="notice notice-warn">{t('port.backup.lostWarn')}</div>
            <label className="field">
              <span>{t('port.passphrase')}</span>
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
            <label className="field">
              <span>{t('port.passphraseConfirm')}</span>
              <input
                className="input"
                type={show ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={confirm !== '' && !matches}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
              {t('port.showPassphrase')}
            </label>
            <div className="pw-meter" aria-hidden="true">
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={n <= strength.level ? `on on-${strength.level}` : ''} />
              ))}
            </div>
            <div className="hint" role="status">
              {strength.strength === 'empty'
                ? t('port.passphraseEmpty', { min: MIN_PASSPHRASE_CHARS })
                : t('port.passphraseRated', { label: strength.label, advice: strength.advice })}
              {confirm !== '' && !matches && ` ${t('port.passphraseMismatch')}`}
            </div>
          </>
        )}

        {step === 'destination' && (
          <>
            <p>{t('port.dest.text')}</p>
            <div>
              <button className="btn" onClick={() => void chooseDestination()} disabled={busy}>
                {destination ? t('port.dest.another') : t('port.dest.choose')}
              </button>
            </div>
            {destination && (
              <div className="hint" style={{ userSelect: 'text', wordBreak: 'break-all' }}>
                {destination.path}
              </div>
            )}
          </>
        )}

        {step === 'result' && summary && (
          <div role="status">
            <p>
              <strong>{t('port.backup.done')}</strong>
            </p>
            <div className="hint" style={{ userSelect: 'text', wordBreak: 'break-all' }}>
              {t('port.backup.savedTo', {
                path: summary.savedTo,
                size: formatBytes(summary.sizeBytes),
              })}
            </div>
            <div className="stat-grid">
              <Stat value={summary.connections} label={t('port.stat.connections')} />
              <Stat value={summary.folders} label={t('port.stat.folders')} />
              <Stat value={summary.credentialsIncluded} label={t('port.stat.passIncluded')} />
              <Stat
                value={summary.credentialsSkipped}
                label={t('port.stat.passSkipped')}
                warn={summary.credentialsSkipped > 0}
              />
            </div>
            {summary.notesRequested && (
              <div className="hint" data-testid="backup-notes-report">
                {t('port.backup.notesReport', {
                  what: formatUnitList(
                    [
                      t('count.note', { count: summary.notesIncluded ?? 0 }),
                      (summary.snapshotsIncluded ?? 0) > 0 &&
                        t('count.offlineCopy', { count: summary.snapshotsIncluded ?? 0 }),
                    ].filter((x): x is string => typeof x === 'string'),
                  ),
                })}
                {(summary.linkedFiles ?? 0) > 0
                  ? ` ${t('port.backup.linkedReport', { count: summary.linkedFiles ?? 0 })}`
                  : ''}
              </div>
            )}
            <div className="hint">
              {t('port.backup.formatVersion', { version: summary.formatVersion })}
            </div>
            {summary.credentialsSkipped > 0 && (
              <div className="notice notice-warn">
                {t('port.backup.skipped', { count: summary.credentialsSkipped })}
                {summary.credentialsUnreadable > 0
                  ? ` ${t('port.backup.unreadable', { count: summary.credentialsUnreadable })}`
                  : ''}
              </div>
            )}
            {summary.credentialsRequested && summary.credentialsIncluded > 0 && (
              <div className="notice">{t('port.backup.containsPasswords')}</div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
