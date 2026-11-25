// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../i18n/errors';
import { Trans, useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { notify, reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
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
  const { t } = useTranslation();
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
          message: t('clearpw.partial', { count: deleted, deleted, failed }),
        });
      } else {
        notify(t('clearpw.done', { count: deleted }));
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setAnswer('');
    } finally {
      setBusy(false);
    }
  };

  if (!challenge) {
    return (
      <Dialog
        title={t('clearpw.title')}
        onClose={onClose}
        persistent
        footer={
          <>
            <button className="btn btn-primary" onClick={onClose} data-autofocus>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" onClick={() => void cont()} disabled={busy}>
              {t('clearpw.continue')}
            </button>
          </>
        }
      >
        <div className="dialog-body">
          <p>
            <strong>{t('clearpw.sure')}</strong>
          </p>
          <ul className="plain-list">
            <li>{t('clearpw.l1')}</li>
            <li>{t('clearpw.l2')}</li>
            <li>{t('clearpw.l3')}</li>
            <li>{t('clearpw.l4')}</li>
            <li>{t('clearpw.l5')}</li>
          </ul>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('clearpw.confirmTitle')}
      onClose={onClose}
      persistent
      footer={
        <>
          <button className="btn" onClick={onClose} data-autofocus>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void finish()}
            disabled={!correct || busy}
          >
            {t('clearpw.deleteButton', { count: challenge.count })}
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
          <Trans
            i18nKey="clearpw.willRemove"
            count={challenge.count}
            components={{ strong: <strong /> }}
          />
        </p>
        <label className="field">
          <span>{t('clearpw.solve', { question: challenge.question })}</span>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="off"
            aria-label={t('clearpw.equals', { question: challenge.question })}
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
              setError(null);
            }}
          />
        </label>
        <p className="hint">{t('clearpw.guard')}</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
