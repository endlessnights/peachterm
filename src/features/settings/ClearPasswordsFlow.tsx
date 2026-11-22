// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { notify, reportError } from '../../components/Toasts';
import { ipc, toAppError } from '../../shared/ipc';
import { useConnections } from '../connections/store';

/** The answer to a question such as "7 + 5" or "4 × 3". */
export function solveChallenge(question: string): number | null {
  const m = /^(\d+) ([+×]) (\d+)$/.exec(question.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  return m[2] === '+' ? a + b : a * b;
}

interface Challenge {
  token: string;
  question: string;
  count: number;
}

/**
 * Two-stage confirmation for "Clear all saved passwords". Stage 1 explains the
 * consequences; stage 2 shows how many entries are affected and asks a small
 * arithmetic question. Rust creates the question and checks the answer
 * together with a short-lived single-use token, so this UI cannot skip the check.
 */
export function ClearPasswordsFlow({ onClose }: { onClose: () => void }) {
  const refreshConnections = useConnections((s) => s.refresh);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Leaving the flow in any way invalidates the pending confirmation.
  useEffect(() => () => void ipc.credentialsClearCancel().catch(() => undefined), []);

  const cont = async () => {
    setBusy(true);
    setError(null);
    try {
      setChallenge(await ipc.credentialsClearBegin());
    } catch (e) {
      reportError(e);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const expected = challenge ? solveChallenge(challenge.question) : null;
  const typed = answer.trim() === '' ? NaN : Number(answer);
  const correct = expected !== null && typed === expected;

  const finish = async () => {
    if (!challenge || !correct) return;
    setBusy(true);
    try {
      const { deleted, failed } = await ipc.credentialsClearAll(challenge.token, typed);
      await refreshConnections();
      if (failed > 0) {
        reportError({
          code: 'partial',
          message: `Removed ${deleted} saved password${deleted === 1 ? '' : 's'}; ${failed} could not be removed and are still saved.`,
        });
      } else {
        notify(`Removed ${deleted} saved password${deleted === 1 ? '' : 's'}.`);
      }
      onClose();
    } catch (e) {
      setError(toAppError(e).message);
      setAnswer('');
    } finally {
      setBusy(false);
    }
  };

  if (!challenge) {
    return (
      <Dialog
        title="Remove all saved passwords?"
        onClose={onClose}
        persistent
        footer={
          <>
            <button className="btn btn-primary" onClick={onClose} data-autofocus>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={() => void cont()} disabled={busy}>
              Continue
            </button>
          </>
        }
      >
        <div className="dialog-body">
          <p>
            <strong>
              Are you sure you want to remove all saved passwords and SSH key passphrases from
              PeachTerm?
            </strong>
          </p>
          <ul className="plain-list">
            <li>Saved passwords and passphrases will be deleted.</li>
            <li>Saved connection profiles will remain.</li>
            <li>SSH private key files will not be deleted.</li>
            <li>You may need to enter credentials again.</li>
            <li>This cannot be undone automatically.</li>
          </ul>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Confirm deletion"
      onClose={onClose}
      persistent
      footer={
        <>
          <button className="btn" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void finish()}
            disabled={!correct || busy}
          >
            Delete {challenge.count} saved password{challenge.count === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          void finish();
        }}
      >
        <p>
          <strong>{challenge.count}</strong> saved password or passphrase{' '}
          {challenge.count === 1 ? 'entry' : 'entries'} will be removed.
        </p>
        <label className="field">
          <span>To confirm, solve: {challenge.question} = ?</span>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="off"
            aria-label={`${challenge.question} equals`}
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
              setError(null);
            }}
          />
        </label>
        <p className="hint">This only guards against accidental clicks.</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
