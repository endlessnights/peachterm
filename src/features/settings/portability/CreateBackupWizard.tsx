// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../../components/Dialog';
import { ipc, toAppError } from '../../../shared/ipc';
import type { BackupSummary } from '../../../shared/types';
import { useConnections } from '../../connections/store';
import { MIN_PASSPHRASE_CHARS, assessPassphrase } from './passphrase';
import { Stat, StepHeader, formatBytes, plural } from './shared';

type Step = 'data' | 'passphrase' | 'destination' | 'result';

const TITLES: Record<Step, string> = {
  data: 'What to include',
  passphrase: 'Backup passphrase',
  destination: 'Destination',
  result: 'Backup created',
};
const ORDER: Step[] = ['data', 'passphrase', 'destination', 'result'];

/**
 * Four steps: data, passphrase, destination, encryption. All encryption runs in
 * Rust; the passphrase leaves this component exactly once (the create call)
 * and is wiped from state straight away.
 */
export function CreateBackupWizard({ onClose }: { onClose: () => void }) {
  const tree = useConnections((s) => s.tree);
  const [step, setStep] = useState<Step>('data');
  const [includeSettings, setIncludeSettings] = useState(true);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [destination, setDestination] = useState<{ token: string; path: string } | null>(null);
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingToken = useRef<string | null>(null);
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
      setError(toAppError(e).message);
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
        { includeSettings, includeCredentials },
        passphrase,
        confirm,
      );
      pendingToken.current = null;
      setSummary(made);
      setStep('result');
    } catch (e) {
      setError(toAppError(e).message);
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
        Close
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
            Back
          </button>
        )}
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {step === 'data' && (
          <button className="btn btn-primary" onClick={() => setStep('passphrase')}>
            Next
          </button>
        )}
        {step === 'passphrase' && (
          <button
            className="btn btn-primary"
            onClick={() => setStep('destination')}
            disabled={!passphraseOk}
          >
            Next
          </button>
        )}
        {step === 'destination' && (
          <button
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={!destination || busy}
          >
            {busy ? 'Encrypting…' : 'Create encrypted backup'}
          </button>
        )}
      </>
    );
  }

  return (
    <Dialog title="Create encrypted backup" onClose={onClose} persistent footer={footer}>
      <div className="dialog-body">
        <StepHeader step={index + 1} total={ORDER.length} title={TITLES[step]} />

        {step === 'data' && (
          <>
            <label className="check">
              <input type="checkbox" checked disabled readOnly />
              Connection profiles ({tree.connections.length}) and folders ({tree.folders.length})
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={includeSettings}
                onChange={(e) => setIncludeSettings(e.target.checked)}
              />
              Application settings (themes, terminal palette, shortcuts)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={includeCredentials}
                onChange={(e) => setIncludeCredentials(e.target.checked)}
              />
              Include saved passwords and SSH key passphrases ({credentialCount})
            </label>
            {includeCredentials && (
              <div className="notice notice-warn">
                Passwords will be stored inside the encrypted file. Anyone who has the file and the
                passphrase can read them. Never put such a backup in a public Git repository or a
                shared folder.
              </div>
            )}
            <div className="hint">
              SSH private key files are never included. Profiles that use a key file need the key
              copied to the new computer and may need to be reconfigured.
            </div>
          </>
        )}

        {step === 'passphrase' && (
          <>
            <div className="notice notice-warn">
              If you lose this passphrase, your backup cannot be recovered. PeachTerm does not store
              it anywhere.
            </div>
            <label className="field">
              <span>Passphrase</span>
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
              <span>Confirm passphrase</span>
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
              Show passphrase
            </label>
            <div className="pw-meter" aria-hidden="true">
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={n <= strength.level ? `on on-${strength.level}` : ''} />
              ))}
            </div>
            <div className="hint" role="status">
              {strength.strength === 'empty'
                ? `At least ${MIN_PASSPHRASE_CHARS} characters. A few unrelated words make a good passphrase.`
                : `${strength.label}. ${strength.advice}`}
              {confirm !== '' && !matches && ' The two entries do not match.'}
            </div>
          </>
        )}

        {step === 'destination' && (
          <>
            <p>Choose where to save the backup. The file is encrypted before it is written.</p>
            <div>
              <button className="btn" onClick={() => void chooseDestination()} disabled={busy}>
                {destination ? 'Choose another location…' : 'Choose location…'}
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
              <strong>The backup was encrypted, written and verified.</strong>
            </p>
            <div className="hint" style={{ userSelect: 'text', wordBreak: 'break-all' }}>
              {summary.savedTo} ({formatBytes(summary.sizeBytes)})
            </div>
            <div className="stat-grid">
              <Stat value={summary.connections} label="Connections" />
              <Stat value={summary.folders} label="Folders" />
              <Stat value={summary.credentialsIncluded} label="Passwords included" />
              <Stat
                value={summary.credentialsSkipped}
                label="Passwords skipped"
                warn={summary.credentialsSkipped > 0}
              />
            </div>
            <div className="hint">Backup format version {summary.formatVersion}.</div>
            {summary.credentialsSkipped > 0 && (
              <div className="notice notice-warn">
                {plural(summary.credentialsSkipped, 'saved password', 'saved passwords')} could not
                be included
                {summary.credentialsUnreadable > 0
                  ? ` (${summary.credentialsUnreadable} could not be read from the system credential store)`
                  : ''}
                . This backup does not contain all of your saved passwords.
              </div>
            )}
            {summary.credentialsRequested && summary.credentialsIncluded > 0 && (
              <div className="notice">
                This file contains passwords. Keep it private and do not publish it.
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
