// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../i18n/errors';
import { useEffect, useRef, useState } from 'react';
import { Logo } from '../../components/Icon';
import { useLock } from './store';
import { useTranslation } from 'react-i18next';

/**
 * Covers the whole window while locked. It has no close button and no way to
 * dismiss it: the only exit is a successful unlock, decided by the backend.
 * It shows nothing about connections, tabs or sessions.
 */
export function LockScreen() {
  const { t } = useTranslation();
  const unlock = useLock((s) => s.unlock);
  const lockoutSeconds = useLock((s) => s.view?.lockoutSeconds ?? 0);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState(() => Date.now() + lockoutSeconds * 1000);
  const [now, setNow] = useState(() => Date.now());
  const wait = Math.max(0, Math.ceil((until - now) / 1000));
  const startWait = (seconds: number) => {
    setUntil(Date.now() + seconds * 1000);
    setNow(Date.now());
  };
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Count a lock-out down locally; the backend is the authority.
  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [until]);

  const submit = async () => {
    if (!password || busy || wait > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await unlock(password);
      setPassword('');
      if (outcome.result === 'wrong') {
        startWait(outcome.lockoutSeconds);
        setMessage(
          outcome.lockoutSeconds > 0
            ? t('lock.screen.wrongWait')
            : t('lock.screen.wrongTries', { count: outcome.attemptsLeftBeforeDelay }),
        );
      } else if (outcome.result === 'lockedOut') {
        startWait(outcome.lockoutSeconds);
        setMessage(t('lock.screen.lockedOut'));
      }
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <div
      className="lock-screen"
      role="dialog"
      aria-modal="true"
      aria-label={t('lock.screen.title')}
      onContextMenu={(e) => e.preventDefault()}
    >
      <form
        className="lock-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Logo className="logo" />
        <h1>{t('lock.screen.title')}</h1>
        <input
          ref={input}
          className="input"
          type="password"
          autoComplete="off"
          aria-label={t('lock.screen.passwordAria')}
          placeholder={t('lock.screen.passwordPlaceholder')}
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || wait > 0 || !password}>
          {t('lock.screen.unlock')}
        </button>
        <div className="lock-message" role="status" aria-live="polite">
          {wait > 0 ? t('lock.screen.wait', { seconds: wait }) : message}
          {wait > 0 && message ? ` ${message}` : ''}
        </div>
      </form>
    </div>
  );
}
