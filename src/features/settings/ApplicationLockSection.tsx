// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { notify, reportError } from '../../components/Toasts';
import { ipc, toAppError } from '../../shared/ipc';
import { lockApplication } from '../../app/commands';
import { useLock } from '../lock/store';
import { Field, type PageProps } from './controls';

const INTERVALS: { value: 0 | 1 | 5 | 15 | 30; label: string }[] = [
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 0, label: 'Never' },
];

type Mode = 'set' | 'change' | 'remove';

/**
 * Settings → Security → Application Lock. Setting, changing or removing the
 * password is an immediate action (the hash is stored by the backend at once);
 * turning the lock on/off and the inactivity interval follow Apply/OK.
 */
export function ApplicationLockSection({ draft, patch }: PageProps) {
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
      <h3>Application lock</h3>
      <div className="hint">
        Optional. Locking hides all connections and terminals and blocks every action until the
        password is entered. It does not replace locking your operating system and does not protect
        against someone who already controls your user account.
      </div>
      <label className="check">
        <input type="checkbox" checked={lock.enabled} onChange={(e) => toggle(e.target.checked)} />
        Enable application lock
      </label>
      <Field label="Lock after inactivity">
        <select
          className="select"
          value={lock.inactivityMinutes}
          disabled={!lock.enabled}
          onChange={(e) =>
            setLock({ inactivityMinutes: Number(e.target.value) as 0 | 1 | 5 | 15 | 30 })
          }
        >
          {INTERVALS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="hint">
        Unlock method: password (stored only as an Argon2id hash). Windows Hello, Touch ID and
        locking together with the operating-system session are not available in this version.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={!active} onClick={lockApplication}>
          Lock now
        </button>
        {configured ? (
          <>
            <button className="btn" onClick={() => setMode('change')}>
              Change password…
            </button>
            <button className="btn" onClick={() => setMode('remove')}>
              Remove password…
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setMode('set')}>
            Set lock password…
          </button>
        )}
      </div>
      {!active && lock.enabled && (
        <div className="hint">The lock becomes active when you press Apply or OK.</div>
      )}
      {mode && (
        <PasswordDialog
          mode={mode}
          onClose={() => setMode(null)}
          onDone={async () => {
            await refresh();
            if (mode === 'set') setLock({ enabled: true });
            if (mode === 'remove') setLock({ enabled: false });
            notify(
              mode === 'remove'
                ? 'Lock password removed.'
                : 'Lock password saved. Press Apply to turn the lock on.',
            );
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
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsCurrent = mode !== 'set';
  const needsNew = mode !== 'remove';

  const submit = async () => {
    setError(null);
    if (needsNew && next.length < 8) return setError('Use at least 8 characters.');
    if (needsNew && next !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      if (mode === 'remove') await ipc.lockRemovePassword(current);
      else await ipc.lockSetPassword(next, needsCurrent ? current : undefined);
      await onDone();
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'locked') reportError(e);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'set'
      ? 'Set lock password'
      : mode === 'change'
        ? 'Change lock password'
        : 'Remove lock password';
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {mode === 'remove' ? 'Remove' : 'Save password'}
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
            <span>Current password</span>
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
              <span>New password (at least 8 characters)</span>
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
              <span>Repeat the new password</span>
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
        {mode === 'remove' && (
          <div className="hint">Removing the password also turns the application lock off.</div>
        )}
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
