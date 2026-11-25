// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../i18n/errors';
import { useEffect, useMemo, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import type { SettingsPage } from '../../app/dialogs';
import { Dialog } from '../../components/Dialog';
import { formatArgs, parseArgs } from '../../shared/args';
import { ipc, isTauri } from '../../shared/ipc';
import { checkBindings } from '../../shared/shortcuts';
import { effectiveFontSize } from '../../shared/scale';
import {
  INTERFACE_SCALES,
  RECENT_LIMITS,
  type Accent,
  type AuthMethod,
  type EditorPreset,
  type Settings,
} from '../../shared/types';
import { useRecent } from '../sessions/recentStore';
import { useLock } from '../lock/store';
import { Field, Segmented, numberInput, type PageProps } from './controls';
import { ApplicationLockSection } from './ApplicationLockSection';
import { ClearPasswordsFlow } from './ClearPasswordsFlow';
import { FontPicker } from './FontPicker';
import { TerminalColorsSection } from './TerminalColorsSection';
import { AboutPage } from './AboutPage';
import { LocalShellPage } from './LocalShellPage';
import { DiagnosticsPage } from './DiagnosticsPage';
import { DataBackupPage } from './portability/DataBackupPage';
import { ShortcutsPage } from './ShortcutsPage';
import { useCredentialStatus } from '../connections/useCredentialStatus';
import { useActivity } from '../exit/activity';
import { useSettings } from './store';
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, normalizePreference } from '../../i18n/languages';

const PAGES: SettingsPage[] = [
  'general',
  'appearance',
  'terminal',
  'shortcuts',
  'ssh',
  'sftp',
  'security',
  'data',
  'diagnostics',
  'about',
];

const ACCENTS: { id: Accent; color: string }[] = [
  { id: 'peach', color: '#f6a07a' },
  { id: 'teal', color: '#5cc8b8' },
  { id: 'violet', color: '#b39cf0' },
  { id: 'blue', color: '#78aef0' },
];

/** Layout (`ui`) is saved by its own controls, so it does not make the dialog dirty. */
const comparable = (s: Settings) => JSON.stringify({ ...s, ui: null });

export function SettingsDialog({
  onClose,
  initialPage = 'general',
}: {
  onClose: () => void;
  initialPage?: SettingsPage;
}) {
  const { t } = useTranslation();
  const saved = useSettings((s) => s.settings);
  const save = useSettings((s) => s.save);
  const [draft, setDraft] = useState<Settings>(saved);
  const [baseline, setBaseline] = useState<Settings>(saved);
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(0);

  const patch = <S extends keyof Settings>(section: S, values: Partial<Settings[S]>) =>
    setDraft((d) => ({ ...d, [section]: { ...d[section], ...values } }));

  const replace = <S extends keyof Settings>(section: S, value: Settings[S]) =>
    setDraft((d) => ({ ...d, [section]: value }));

  const dirty = comparable(draft) !== comparable(baseline);
  const problems = useMemo(() => checkBindings(draft.shortcuts), [draft.shortcuts]);
  // Exiting asks first while this dialog holds changes that were not applied.
  useEffect(() => {
    useActivity.getState().setUnsaved('settings', dirty);
    return () => useActivity.getState().setUnsaved('settings', false);
  }, [dirty]);

  // Live preview of theme/accent while editing. Cancel (or any close) removes
  // it again; only Apply/OK persist anything.
  useEffect(() => {
    useSettings.getState().setPreview(draft.appearance);
  }, [draft.appearance]);
  useEffect(() => () => useSettings.getState().setPreview(null), []);

  const apply = async (): Promise<boolean> => {
    if (problems.length > 0) {
      setError(t('settings.shortcutConflicts'));
      setPage('shortcuts');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      // Layout may have changed while the dialog was open; keep the live value.
      const result = await save({ ...draft, ui: useSettings.getState().settings.ui });
      setBaseline(result);
      setDraft(result);
      setApplied((n) => n + 1);
      void useRecent.getState().refresh(); // a changed limit shows at once
      // The lock may have been turned on/off or re-timed by this save.
      await useLock.getState().refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ok = async () => {
    if (!dirty || (await apply())) onClose();
  };

  return (
    <Dialog
      title={t('settings.title')}
      wide
      persistent
      onClose={onClose}
      footer={
        <>
          <span className="left settings-status" role="status">
            {error ? (
              <span className="error-text">{error}</span>
            ) : dirty ? (
              <span className="hint">{t('settings.unapplied')}</span>
            ) : null}
          </span>
          <button
            className="btn btn-primary"
            onClick={() => void ok()}
            disabled={busy || problems.length > 0}
          >
            {t('settings.ok')}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn"
            onClick={() => void apply()}
            disabled={!dirty || busy || problems.length > 0}
          >
            {t('settings.apply')}
          </button>
        </>
      }
    >
      <div className="settings">
        <nav className="settings-nav" aria-label={t('settings.sections')}>
          {PAGES.map((id) => (
            <button
              key={id}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => setPage(id)}
            >
              {t(`settings.page.${id}`)}
            </button>
          ))}
        </nav>
        <div className="settings-page">
          {page === 'general' && <GeneralPage draft={draft} patch={patch} replace={replace} />}
          {page === 'appearance' && (
            <AppearancePage draft={draft} patch={patch} replace={replace} />
          )}
          {page === 'terminal' && <LocalShellPage draft={draft} patch={patch} replace={replace} />}
          {page === 'shortcuts' && (
            <ShortcutsPage draft={draft} patch={patch} replace={replace} problems={problems} />
          )}
          {page === 'ssh' && <SshPage draft={draft} patch={patch} replace={replace} />}
          {page === 'sftp' && <SftpPage draft={draft} patch={patch} replace={replace} />}
          {page === 'security' && <SecurityPage draft={draft} patch={patch} replace={replace} />}
          {page === 'data' && <DataBackupPage />}
          {page === 'about' && <AboutPage />}
          {page === 'diagnostics' && (
            <DiagnosticsPage draft={draft} patch={patch} replace={replace} appliedTick={applied} />
          )}
        </div>
      </div>
    </Dialog>
  );
}

function GeneralPage({ draft, patch }: PageProps) {
  const { t } = useTranslation();
  const g = draft.general;
  return (
    <>
      <h3>{t('settings.general.startup')}</h3>
      <Field label={t('settings.general.whenStarts')} hint={t('settings.general.whenStartsHint')}>
        <select
          className="select"
          value={g.startup}
          onChange={(e) =>
            patch('general', { startup: e.target.value as Settings['general']['startup'] })
          }
        >
          <option value="empty">{t('settings.general.startEmpty')}</option>
          <option value="restoreTabs">{t('settings.general.restoreTabs')}</option>
        </select>
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={g.autoReconnectRestored}
          onChange={(e) => patch('general', { autoReconnectRestored: e.target.checked })}
        />
        {t('settings.general.autoReconnect')}
      </label>
      <span className="hint">{t('settings.general.autoReconnectHint')}</span>
      <h3>{t('settings.general.home')}</h3>
      <Field label={t('settings.general.recentLimit')} hint={t('settings.general.recentLimitHint')}>
        <select
          className="select"
          aria-label={t('settings.general.recentLimit')}
          value={g.recentSessionsLimit}
          onChange={(e) => patch('general', { recentSessionsLimit: Number(e.target.value) })}
        >
          {RECENT_LIMITS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
      <ClearHistory />
      <h3>{t('settings.general.window')}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={g.showStatusBar}
          onChange={(e) => patch('general', { showStatusBar: e.target.checked })}
        />
        {t('settings.general.showStatusBar')}
      </label>
      <h3>{t('settings.general.updates')}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={g.checkUpdates}
          onChange={(e) => patch('general', { checkUpdates: e.target.checked })}
        />
        {t('settings.general.autoUpdates')}
      </label>
      <p className="hint">{t('settings.general.autoUpdatesHint')}</p>
      <h3>{t('settings.general.tabs')}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={g.confirmCloseActive}
          onChange={(e) => patch('general', { confirmCloseActive: e.target.checked })}
        />
        {t('settings.general.confirmClose')}
      </label>
    </>
  );
}

function AppearancePage({ draft, patch, replace }: PageProps) {
  const { t } = useTranslation();
  const a = draft.appearance;
  return (
    <>
      <h3>{t('settings.language.heading')}</h3>
      <Field label={t('settings.language.label')} hint={t('settings.language.hint')}>
        <select
          className="select"
          aria-label={t('settings.language.label')}
          value={normalizePreference(draft.general.language)}
          onChange={(e) => patch('general', { language: e.target.value })}
        >
          <option value="system">{t('settings.language.system')}</option>
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code} lang={code}>
              {LANGUAGE_NAMES[code]}
            </option>
          ))}
        </select>
      </Field>
      <h3>{t('settings.appearance.theme')}</h3>
      <Segmented
        value={a.theme}
        options={[
          { value: 'dark', label: t('settings.appearance.dark') },
          { value: 'light', label: t('settings.appearance.light') },
          { value: 'olive', label: 'Industrial Olive' },
          { value: 'gray', label: 'Source Gray' },
          { value: 'system', label: t('settings.appearance.system') },
        ]}
        onChange={(theme) => patch('appearance', { theme })}
      />
      <Field
        label={t('settings.appearance.accent')}
        hint={
          a.theme === 'olive'
            ? t('settings.appearance.accentOlive')
            : a.theme === 'gray'
              ? t('settings.appearance.accentGray')
              : undefined
        }
      >
        <div className="swatches">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              className="swatch"
              aria-label={t(`settings.appearance.accentNames.${accent.id}`)}
              aria-pressed={a.accent === accent.id}
              style={{ background: accent.color }}
              onClick={() => patch('appearance', { accent: accent.id })}
            />
          ))}
        </div>
      </Field>
      <h3>{t('settings.appearance.scaleHeading')}</h3>
      <Field
        label={t('settings.appearance.scaleHeading')}
        hint={t('settings.appearance.scaleHint')}
      >
        <div className="scale-row">
          <input
            type="range"
            aria-label={t('settings.appearance.scaleHeading')}
            aria-valuetext={`${a.interfaceScale}%`}
            min={INTERFACE_SCALES[0]}
            max={INTERFACE_SCALES[INTERFACE_SCALES.length - 1]}
            step={10}
            value={a.interfaceScale}
            onChange={(e) => patch('appearance', { interfaceScale: Number(e.target.value) })}
          />
          <output aria-live="polite">{a.interfaceScale}%</output>
          <button
            className="btn"
            type="button"
            disabled={a.interfaceScale === 100}
            onClick={() => patch('appearance', { interfaceScale: 100 })}
          >
            {t('settings.appearance.resetScale')}
          </button>
        </div>
      </Field>
      <h3>{t('settings.appearance.terminal')}</h3>
      <Field label={t('settings.appearance.font')} hint={t('settings.appearance.fontHint')}>
        <FontPicker
          value={a.terminalFontFamily}
          onChange={(terminalFontFamily) => patch('appearance', { terminalFontFamily })}
        />
      </Field>
      <div className="settings-grid">
        <Field label={t('settings.appearance.fontSize')}>
          {numberInput(
            a.terminalFontSize,
            (n) => patch('appearance', { terminalFontSize: n }),
            8,
            32,
          )}
        </Field>
        <Field label={t('settings.appearance.scrollback')}>
          {numberInput(a.scrollback, (n) => patch('appearance', { scrollback: n }), 500, 200000)}
        </Field>
      </div>
      <div
        className="notice"
        style={{
          fontFamily: a.terminalFontFamily,
          fontSize: effectiveFontSize(a),
          color: 'var(--text-1)',
        }}
      >
        root@server:~# htop — 0Oo 1lI |{'{}'}[]
      </div>
      <TerminalColorsSection draft={draft} patch={patch} replace={replace} />
    </>
  );
}

function SshPage({ draft, patch }: PageProps) {
  const { t } = useTranslation();
  const s = draft.ssh;
  return (
    <>
      <h3>{t('settings.ssh.connection')}</h3>
      <div className="settings-grid">
        <Field label={t('settings.ssh.timeout')}>
          {numberInput(
            s.connectTimeoutSecs,
            (n) => patch('ssh', { connectTimeoutSecs: n }),
            1,
            300,
          )}
        </Field>
        <Field label={t('settings.ssh.keepalive')} hint={t('settings.ssh.keepaliveHint')}>
          {numberInput(s.keepaliveSecs, (n) => patch('ssh', { keepaliveSecs: n }), 0, 3600)}
        </Field>
      </div>
      <h3>{t('settings.ssh.defaults')}</h3>
      <div className="settings-grid">
        <Field label={t('settings.ssh.username')}>
          <input
            className="input"
            value={s.defaultUsername}
            onChange={(e) => patch('ssh', { defaultUsername: e.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label={t('settings.ssh.authentication')}>
          <select
            className="select"
            value={s.preferredAuth}
            onChange={(e) => patch('ssh', { preferredAuth: e.target.value as AuthMethod })}
          >
            <option value="password">{t('settings.ssh.auth.password')}</option>
            <option value="publicKey">{t('settings.ssh.auth.publicKey')}</option>
            <option value="keyboardInteractive">
              {t('settings.ssh.auth.keyboardInteractive')}
            </option>
            <option value="agent">{t('settings.ssh.auth.agent')}</option>
          </select>
        </Field>
      </div>
      <h3>{t('settings.monitoring.heading')}</h3>
      <div className="settings-grid">
        <Field label={t('settings.monitoring.enable')} hint={t('settings.monitoring.enableHint')}>
          <input
            type="checkbox"
            aria-label={t('settings.monitoring.enable')}
            checked={draft.monitoring.enabled}
            onChange={(e) => patch('monitoring', { enabled: e.target.checked })}
          />
        </Field>
        <Field label={t('settings.monitoring.interval')}>
          <select
            className="select"
            aria-label={t('settings.monitoring.intervalAria')}
            value={draft.monitoring.intervalSecs}
            onChange={(e) => patch('monitoring', { intervalSecs: Number(e.target.value) })}
          >
            {[5, 10, 30].map((n) => (
              <option key={n} value={n}>
                {t('settings.monitoring.every', { count: n })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('settings.monitoring.visible')}>
          <span className="monitor-metrics-pick">
            {(['cpu', 'ram', 'disk', 'uptime'] as const).map((key) => (
              <label key={key} className="check-inline">
                <input
                  type="checkbox"
                  checked={draft.monitoring[key]}
                  onChange={(e) => patch('monitoring', { [key]: e.target.checked })}
                />{' '}
                {t(`settings.monitoring.metric.${key}`)}
              </label>
            ))}
          </span>
        </Field>
      </div>
      <div className="notice">{t('settings.monitoring.notice')}</div>
      <div className="notice">{t('settings.ssh.hostKeyNotice')}</div>
    </>
  );
}

function SftpPage({ draft, patch }: PageProps) {
  const { t } = useTranslation();
  const f = draft.sftp;
  const e = draft.editor;
  const [presets, setPresets] = useState<EditorPreset[]>([]);
  const [argsKey, setArgsKey] = useState(0);
  useEffect(() => {
    ipc
      .editorPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  const browse = async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      title: t('settings.editor.select'),
    });
    if (typeof picked === 'string') patch('editor', { program: picked });
  };

  return (
    <>
      <h3>{t('settings.sftp.fileBrowser')}</h3>
      <div className="settings-grid">
        <Field label={t('settings.sftp.panelPosition')}>
          <Segmented
            value={f.defaultPosition}
            options={[
              { value: 'left', label: t('settings.sftp.left') },
              { value: 'right', label: t('settings.sftp.right') },
            ]}
            onChange={(defaultPosition) => patch('sftp', { defaultPosition })}
          />
        </Field>
        <div className="field" style={{ alignContent: 'end', gap: 8 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={f.defaultVisible}
              onChange={(ev) => patch('sftp', { defaultVisible: ev.target.checked })}
            />
            {t('settings.sftp.showForNew')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.showHidden}
              onChange={(ev) => patch('sftp', { showHidden: ev.target.checked })}
            />
            {t('settings.sftp.showHidden')}
          </label>
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={f.confirmDelete}
          onChange={(ev) => patch('sftp', { confirmDelete: ev.target.checked })}
        />
        {t('settings.sftp.confirmDelete')}
      </label>

      <h3>{t('settings.editor.heading')}</h3>
      {presets.length > 0 && (
        <Field label={t('settings.editor.preset')}>
          <select
            className="select"
            value=""
            onChange={(ev) => {
              const preset = presets.find((p) => p.id === ev.target.value);
              if (!preset) return;
              patch('editor', { program: preset.program, args: preset.args });
              setArgsKey((k) => k + 1);
            }}
          >
            <option value="">{t('settings.editor.choosePreset')}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t('settings.editor.executable')}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={e.program ?? ''}
            onChange={(ev) => patch('editor', { program: ev.target.value || null })}
            placeholder={t('settings.editor.notConfigured')}
            spellCheck={false}
          />
          {isTauri() && (
            <button type="button" className="btn" onClick={() => void browse()}>
              {t('settings.editor.browse')}
            </button>
          )}
        </div>
      </Field>
      <Field label={t('settings.editor.arguments')} hint={t('settings.editor.argumentsHint')}>
        <ArgsInput key={argsKey} args={e.args} onChange={(args) => patch('editor', { args })} />
      </Field>
      <Field label={t('settings.editor.tempDir')} hint={t('settings.editor.tempDirHint')}>
        <input
          className="input"
          value={e.tempDir ?? ''}
          onChange={(ev) => patch('editor', { tempDir: ev.target.value || null })}
          spellCheck={false}
        />
      </Field>
      <div className="notice">{t('settings.editor.uploadNotice')}</div>
    </>
  );
}

/**
 * Uncontrolled so quotes and spaces are not re-formatted mid-edit; the parent
 * changes `key` when a preset replaces the arguments.
 */
function ArgsInput({ args, onChange }: { args: string[]; onChange: (args: string[]) => void }) {
  return (
    <input
      className="input"
      defaultValue={formatArgs(args)}
      onChange={(ev) => onChange(parseArgs(ev.target.value))}
      spellCheck={false}
    />
  );
}

function SecurityPage({ draft, patch, replace }: PageProps) {
  const { t } = useTranslation();
  const credentials = useCredentialStatus();
  const [confirmingClear, setConfirmingClear] = useState(false);

  return (
    <>
      <ApplicationLockSection draft={draft} patch={patch} replace={replace} />

      <h3>{t('settings.security.credentialStorage')}</h3>
      {credentials ? (
        <div className={credentials.available ? 'notice' : 'notice notice-warn'}>
          {credentials.available
            ? t('settings.security.storedIn', { backend: credentials.backend })
            : credentials.detail
              ? t('settings.security.unavailableDetail', {
                  backend: credentials.backend,
                  detail: credentials.detail,
                })
              : t('settings.security.unavailable', { backend: credentials.backend })}
        </div>
      ) : (
        <div className="hint">{t('settings.security.checking')}</div>
      )}
      <div>
        <button
          className="btn"
          onClick={() => setConfirmingClear(true)}
          disabled={!credentials?.available}
        >
          {t('settings.security.clearAll')}
        </button>
      </div>
      {confirmingClear && <ClearPasswordsFlow onClose={() => setConfirmingClear(false)} />}
    </>
  );
}

/** Clears only the recent-connection history (takes effect immediately, outside Apply/Cancel). */
function ClearHistory() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const count = useRecent((s) => s.ids.length);
  if (!confirming) {
    return (
      <div>
        <button
          className="btn"
          type="button"
          onClick={() => setConfirming(true)}
          disabled={count === 0}
        >
          {t('settings.history.clear')}
        </button>
        <span className="hint" style={{ marginLeft: 8 }}>
          {t('settings.history.clearHint')}
        </span>
      </div>
    );
  }
  return (
    <div role="group" aria-label={t('settings.history.confirmAria')} className="inline-confirm">
      <span>{t('settings.history.confirm')}</span>
      <button
        className="btn btn-danger"
        type="button"
        onClick={() => {
          void useRecent.getState().clear();
          setConfirming(false);
        }}
      >
        {t('settings.history.clearButton')}
      </button>
      <button className="btn" type="button" onClick={() => setConfirming(false)}>
        {t('settings.history.keep')}
      </button>
    </div>
  );
}
