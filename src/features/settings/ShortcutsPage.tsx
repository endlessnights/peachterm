// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Trans, useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import definitions from '../../shared/shortcutDefaults.json';
import {
  ACTION_IDS,
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  effectiveBindings,
  eventToAccelerator,
  formatAccelerator,
  isMac,
  isTerminalUnsafe,
  reservedText,
  parseAccelerator,
  sameCombo,
  suggestAlternative,
  withShift,
  type ActionId,
  type Problem,
} from '../../shared/shortcuts';
import type { PageProps } from './controls';
import { useRecording } from './shortcutState';

interface Props extends PageProps {
  problems: Problem[];
}

/** Does `accel` mean the same key combination as the action's default? */
function isDefault(id: ActionId, accel: string): boolean {
  const a = parseAccelerator(accel);
  const b = parseAccelerator(DEFAULT_BINDINGS[id]);
  return a.ok && b.ok && sameCombo(a.combo, b.combo);
}

export function ShortcutsPage({ draft, replace, problems }: Props) {
  const { t } = useTranslation();
  const mac = isMac();
  const overrides = draft.shortcuts;
  const bindings = effectiveBindings(overrides);
  const [recordingId, setRecordingId] = useState<ActionId | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const setRecording = useRecording((s) => s.set);

  const update = (id: ActionId, accel: string | null) => {
    const next = { ...overrides };
    if (accel === null || (accel !== '' && isDefault(id, accel))) delete next[id];
    else next[id] = accel;
    replace('shortcuts', next);
  };

  // While recording, one capture-phase listener consumes the next key press so
  // neither the app shortcuts nor the dialog see it.
  useEffect(() => {
    if (!recordingId) return;
    setRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecordingId(null);
        setRecordError(null);
        return;
      }
      if (['Backspace', 'Delete'].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        update(recordingId, '');
        setRecordingId(null);
        return;
      }
      const accel = eventToAccelerator(e, mac);
      if (!accel) return; // only modifiers so far
      const parsed = parseAccelerator(accel, mac);
      if (!parsed.ok) {
        setRecordError(
          t('keys.cannotUse', { key: formatAccelerator(accel, mac), error: parsed.error }),
        );
        return;
      }
      setRecordError(null);
      update(recordingId, accel);
      setRecordingId(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      setRecording(false);
    };
    // `update` closes over the current overrides, which is what we want per press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, overrides]);

  const problemFor = (id: string) => problems.find((p) => p.action === id);

  return (
    <>
      <h3>{t('keys.heading')}</h3>
      <div className="hint">
        <Trans i18nKey="keys.intro" components={{ strong: <strong /> }} />
      </div>
      {problems.length > 0 && (
        <div className="notice notice-warn" role="alert">
          {t('keys.problems', { count: problems.length })}
        </div>
      )}
      {recordError && (
        <div className="error-text" role="alert">
          {recordError}
        </div>
      )}
      <table className="table shortcut-table">
        <thead>
          <tr>
            <th>{t('keys.actionHeader')}</th>
            <th>{t('keys.shortcut')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ACTION_IDS.map((id) => {
            const accel = bindings[id];
            const problem = problemFor(id);
            const parsed = accel ? parseAccelerator(accel, mac) : null;
            const unsafe = parsed?.ok && isTerminalUnsafe(parsed.combo, mac);
            const alternative =
              problem && accel ? suggestAlternative(accel, overrides, id, mac) : null;
            const customised = id in overrides;
            return (
              <tr key={id} data-action={id}>
                <td>
                  {ACTION_LABELS[id]}
                  {problem && (
                    <div className="error-text" role="alert">
                      {problem.message}
                      {alternative && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => update(id, alternative)}
                          >
                            {t('keys.useInstead', { key: formatAccelerator(alternative, mac) })}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {!problem && unsafe && (
                    <div className="hint">
                      {t('keys.unsafe', { key: formatAccelerator(withShift(accel), mac) })}
                    </div>
                  )}
                </td>
                <td>
                  {recordingId === id ? (
                    <span className="kbd recording" aria-live="polite">
                      {t('keys.pressKeys')}
                    </span>
                  ) : (
                    <span
                      className="kbd"
                      aria-label={t('keys.shortcutAria', { action: ACTION_LABELS[id] })}
                    >
                      {formatAccelerator(accel, mac)}
                    </span>
                  )}
                </td>
                <td className="shortcut-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setRecordError(null);
                      setRecordingId(recordingId === id ? null : id);
                    }}
                  >
                    {recordingId === id ? t('common.cancel') : t('keys.record')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!customised}
                    onClick={() => update(id, null)}
                    title={t('keys.resetHint')}
                  >
                    {t('keys.reset')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <button
          type="button"
          className="btn"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => replace('shortcuts', {})}
        >
          {t('keys.restoreAll')}
        </button>
      </div>

      <h3>{t('keys.reservedHeading')}</h3>
      <div className="hint">{t('keys.reservedIntro')}</div>
      <details>
        <summary>{t('keys.showReserved')}</summary>
        <ul className="reserved-list">
          {[...definitions.reserved, ...(mac ? definitions.reservedMac : [])].map((r) => {
            const parsed = parseAccelerator(r.accel, mac);
            return (
              <li key={r.accel}>
                <span className="kbd">
                  {formatAccelerator(parsed.ok ? parsed.canonical : r.accel, mac)}
                </span>{' '}
                {reservedText(r.reason)}
              </li>
            );
          })}
          {!mac && <li>{t('keys.superKey')}</li>}
        </ul>
      </details>
    </>
  );
}
