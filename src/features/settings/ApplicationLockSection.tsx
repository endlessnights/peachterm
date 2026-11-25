// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { errorMessage } from '../../i18n/errors';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { notify, reportError } from '../../components/Toasts';
import { ipc, toAppError } from '../../shared/ipc';
import { lockApplication } from '../../app/commands';
import { useLock } from '../lock/store';
import { Field, type PageProps } from './controls';

const INTERVALS: (0 | 1 | 5 | 15 | 30)[] = [1, 5, 15, 30, 0];

type Mode = 'set' | 'change' | 'remove';

/**
 * Settings → Security → Application Lock. Setting, changing or removing the
 * password is an immediate action (the hash is stored by the backend at once);
 * turning the lock on/off and the inactivity interval follow Apply/OK.
 */
export function ApplicationLockSection({ draft, patch }: PageProps) {
  const { t } = useTranslation();
  const view = useLock((s) => s.view);
  const refresh = useLock((s) => s.refresh);
  const [mode, setMode] = useState<Mode | null>(null);
  const lock = draft.security.appLock;
  const configured = view?.configured === true;
  const active = view?.enabled === true;

  const setLock = (values: Partial<typeof lock>) =>
    patch('security', { appLock: { ...lock, ...values } });

  const toggle = (on: boolean) => {
    if (on && !configured) return setMode('set'); // guided setup, never an empty lock
    setLock({ enabled: on });
  };

  return (
    <>
      <h3>{t('lock.section.heading')}</h3>
      <div className="hint">{t('lock.section.description')}</div>
      <label className="check">
        <input type="checkbox" checked={lock.enabled} onChange={(e) => toggle(e.target.checked)} />
        {t('lock.section.enable')}
      </label>
      <Field label={t('lock.section.afterInactivity')}>
        <select
          className="select"
          value={lock.inactivityMinutes}
          disabled={!lock.enabled}
          onChange={(e) =>
            setLock({ inactivityMinutes: Number(e.target.value) as 0 | 1 | 5 | 15 | 30 })
          }
        >
          {INTERVALS.map((value) => (
            <option key={value} value={value}>
              {value === 0 ? t('lock.section.never') : t('lock.section.minutes', { count: value })}
            </option>
          ))}
        </select>
      </Field>
      <div className="hint">{t('lock.section.method')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={!active} onClick={lockApplication}>
          {t('lock.section.lockNow')}
        </button>
        {configured ? (
          <>
            <button className="btn" onClick={() => setMode('change')}>
              {t('lock.section.change')}
            </button>
            <button className="btn" onClick={() => setMode('remove')}>
              {t('lock.section.remove')}
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setMode('set')}>
            {t('lock.section.set')}
          </button>
        )}
      </div>
      {!active && lock.enabled && <div className="hint">{t('lock.section.activeOnApply')}</div>}
      {mode && (
        <PasswordDialog
          mode={mode}
          onClose={() => setMode(null)}
          onDone={async () => {
            await refresh();
            if (mode === 'set') setLock({ enabled: true });
            if (mode === 'remove') setLock({ enabled: false });
            notify(mode === 'remove' ? t('lock.section.removed') : t('lock.section.saved'));
            setMode(null);
          }}
        />
      )}
    </>
  );
}

function PasswordDialog({
  mode,
  onClose,
  onDone,
}: {
  mode: Mode;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsCurrent = mode !== 'set';
  const needsNew = mode !== 'remove';

  const submit = async () => {
    setError(null);
    if (needsNew && next.length < 8) return setError(t('lock.dialog.minLength'));
    if (needsNew && next !== confirm) return setError(t('lock.dialog.mismatch'));
    setBusy(true);
    try {
      if (mode === 'remove') await ipc.lockRemovePassword(current);
      else await ipc.lockSetPassword(next, needsCurrent ? current : undefined);
      await onDone();
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'locked') reportError(e);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'set'
      ? t('lock.dialog.setTitle')
      : mode === 'change'
        ? t('lock.dialog.changeTitle')
        : t('lock.dialog.removeTitle');
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {mode === 'remove' ? t('lock.dialog.remove') : t('lock.dialog.save')}
          </button>
        </>
      }
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {needsCurrent && (
          <label className="field">
            <span>{t('lock.dialog.current')}</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              data-autofocus
            />
          </label>
        )}
        {needsNew && (
          <>
            <label className="field">
              <span>{t('lock.dialog.new')}</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                data-autofocus={!needsCurrent || undefined}
              />
            </label>
            <label className="field">
              <span>{t('lock.dialog.repeat')}</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          </>
        )}
        {mode === 'remove' && <div className="hint">{t('lock.dialog.removeHint')}</div>}
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
