import { useEffect, useMemo, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import type { SettingsPage } from '../../app/dialogs';
import { Dialog } from '../../components/Dialog';
import { notify, reportError } from '../../components/Toasts';
import { formatArgs, parseArgs } from '../../shared/args';
import { ipc, isTauri, toAppError } from '../../shared/ipc';
import { checkBindings } from '../../shared/shortcuts';
import { effectiveFontSize } from '../../shared/scale';
import {
  INTERFACE_SCALES,
  RECENT_LIMITS,
  type Accent,
  type AuthMethod,
  type EditorPreset,
  type KnownHost,
  type Settings,
} from '../../shared/types';
import { useRecent } from '../sessions/recentStore';
import { useConnections } from '../connections/store';
import { useLock } from '../lock/store';
import { Field, Segmented, numberInput, type PageProps } from './controls';
import { ApplicationLockSection } from './ApplicationLockSection';
import { DiagnosticsPage } from './DiagnosticsPage';
import { ShortcutsPage } from './ShortcutsPage';
import { useCredentialStatus } from '../connections/useCredentialStatus';
import { useSettings } from './store';

const PAGES: { id: SettingsPage; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'ssh', label: 'SSH' },
  { id: 'sftp', label: 'SFTP & editor' },
  { id: 'security', label: 'Security' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

const ACCENTS: { id: Accent; color: string }[] = [
  { id: 'peach', color: '#f6a07a' },
  { id: 'teal', color: '#5cc8b8' },
  { id: 'violet', color: '#b39cf0' },
  { id: 'blue', color: '#78aef0' },
];

/** Settings whose change is only picked up by the next launch. */
const RESTART_FIELDS: { label: string; get: (s: Settings) => unknown }[] = [
  { label: 'Interface language', get: (s) => s.general.language },
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
  const saved = useSettings((s) => s.settings);
  const startup = useSettings((s) => s.startupSnapshot);
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

  // Live preview of theme/accent while editing. Cancel (or any close) removes
  // it again; only Apply/OK persist anything.
  useEffect(() => {
    useSettings.getState().setPreview(draft.appearance);
  }, [draft.appearance]);
  useEffect(() => () => useSettings.getState().setPreview(null), []);

  const apply = async (): Promise<boolean> => {
    if (problems.length > 0) {
      setError('Resolve the keyboard shortcut conflicts first.');
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
      setError(toAppError(e).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ok = async () => {
    if (!dirty || (await apply())) onClose();
  };

  const needsRestart = startup
    ? RESTART_FIELDS.filter((f) => f.get(baseline) !== f.get(startup)).map((f) => f.label)
    : [];

  return (
    <Dialog
      title="Settings"
      wide
      persistent
      onClose={onClose}
      footer={
        <>
          <span className="left settings-status" role="status">
            {error ? (
              <span className="error-text">{error}</span>
            ) : needsRestart.length > 0 ? (
              <span className="hint">Restart PeachTerm to apply: {needsRestart.join(', ')}.</span>
            ) : dirty ? (
              <span className="hint">Unapplied changes</span>
            ) : null}
          </span>
          <button
            className="btn btn-primary"
            onClick={() => void ok()}
            disabled={busy || problems.length > 0}
          >
            OK
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={() => void apply()}
            disabled={!dirty || busy || problems.length > 0}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {PAGES.map((p) => (
            <button
              key={p.id}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => setPage(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div className="settings-page">
          {page === 'general' && <GeneralPage draft={draft} patch={patch} replace={replace} />}
          {page === 'appearance' && (
            <AppearancePage draft={draft} patch={patch} replace={replace} />
          )}
          {page === 'shortcuts' && (
            <ShortcutsPage draft={draft} patch={patch} replace={replace} problems={problems} />
          )}
          {page === 'ssh' && <SshPage draft={draft} patch={patch} replace={replace} />}
          {page === 'sftp' && <SftpPage draft={draft} patch={patch} replace={replace} />}
          {page === 'security' && <SecurityPage draft={draft} patch={patch} replace={replace} />}
          {page === 'diagnostics' && (
            <DiagnosticsPage draft={draft} patch={patch} replace={replace} appliedTick={applied} />
          )}
        </div>
      </div>
    </Dialog>
  );
}

function GeneralPage({ draft, patch }: PageProps) {
  const g = draft.general;
  return (
    <>
      <h3>Startup</h3>
      <Field label="When PeachTerm starts" hint="Applies the next time PeachTerm starts.">
        <select
          className="select"
          value={g.startup}
          onChange={(e) =>
            patch('general', { startup: e.target.value as Settings['general']['startup'] })
          }
        >
          <option value="empty">Start with no tabs</option>
          <option value="restoreTabs">Restore previous tabs (layout only)</option>
        </select>
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={g.autoReconnectRestored}
          onChange={(e) => patch('general', { autoReconnectRestored: e.target.checked })}
        />
        Reconnect restored tabs automatically
      </label>
      <span className="hint">
        Restoring never re-runs commands. Every restored connection is a new session and asks again
        before uploading edited files.
      </span>
      <h3>Home screen</h3>
      <Field
        label="Recent sessions limit"
        hint="How many recently used saved connections the home screen lists."
      >
        <select
          className="select"
          aria-label="Recent sessions limit"
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
      <h3>Tabs</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={g.confirmCloseActive}
          onChange={(e) => patch('general', { confirmCloseActive: e.target.checked })}
        />
        Confirm before closing a connected tab
      </label>
      <h3>Language</h3>
      <Field label="Interface language" hint="Takes effect after restarting PeachTerm.">
        <select
          className="select"
          value={g.language}
          onChange={(e) => patch('general', { language: e.target.value })}
        >
          <option value="en">English</option>
        </select>
      </Field>
    </>
  );
}

function AppearancePage({ draft, patch }: PageProps) {
  const a = draft.appearance;
  return (
    <>
      <h3>Theme</h3>
      <Segmented
        value={a.theme}
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'System' },
        ]}
        onChange={(theme) => patch('appearance', { theme })}
      />
      <Field label="Accent colour">
        <div className="swatches">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              className="swatch"
              aria-label={accent.id}
              aria-pressed={a.accent === accent.id}
              style={{ background: accent.color }}
              onClick={() => patch('appearance', { accent: accent.id })}
            />
          ))}
        </div>
      </Field>
      <h3>Interface scale</h3>
      <Field
        label="Interface scale"
        hint="Zooms the whole interface. The terminal font size below is separate and is not scaled again."
      >
        <div className="scale-row">
          <input
            type="range"
            aria-label="Interface scale"
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
            Reset to 100%
          </button>
        </div>
      </Field>
      <h3>Terminal</h3>
      <Field label="Font family" hint="CSS font list; the first installed font is used.">
        <input
          className="input"
          value={a.terminalFontFamily}
          onChange={(e) => patch('appearance', { terminalFontFamily: e.target.value })}
          spellCheck={false}
        />
      </Field>
      <div className="settings-grid">
        <Field label="Font size">
          {numberInput(
            a.terminalFontSize,
            (n) => patch('appearance', { terminalFontSize: n }),
            8,
            32,
          )}
        </Field>
        <Field label="Scrollback lines">
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
    </>
  );
}

function SshPage({ draft, patch }: PageProps) {
  const s = draft.ssh;
  return (
    <>
      <h3>Connection</h3>
      <div className="settings-grid">
        <Field label="Default timeout (seconds)">
          {numberInput(
            s.connectTimeoutSecs,
            (n) => patch('ssh', { connectTimeoutSecs: n }),
            1,
            300,
          )}
        </Field>
        <Field label="Keepalive interval (seconds)" hint="0 disables keepalive.">
          {numberInput(s.keepaliveSecs, (n) => patch('ssh', { keepaliveSecs: n }), 0, 3600)}
        </Field>
      </div>
      <h3>Defaults for new connections</h3>
      <div className="settings-grid">
        <Field label="Username">
          <input
            className="input"
            value={s.defaultUsername}
            onChange={(e) => patch('ssh', { defaultUsername: e.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label="Authentication">
          <select
            className="select"
            value={s.preferredAuth}
            onChange={(e) => patch('ssh', { preferredAuth: e.target.value as AuthMethod })}
          >
            <option value="password">Password</option>
            <option value="publicKey">Public key</option>
            <option value="keyboardInteractive">Keyboard-interactive</option>
            <option value="agent">SSH agent</option>
          </select>
        </Field>
      </div>
      <div className="notice">
        Host keys are always verified. Unknown keys must be approved and changed keys are blocked
        with a warning — this cannot be turned off.
      </div>
    </>
  );
}

function SftpPage({ draft, patch }: PageProps) {
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
      title: 'Select editor',
    });
    if (typeof picked === 'string') patch('editor', { program: picked });
  };

  return (
    <>
      <h3>File browser</h3>
      <div className="settings-grid">
        <Field label="Default panel position">
          <Segmented
            value={f.defaultPosition}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
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
            Show panel for new sessions
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.showHidden}
              onChange={(ev) => patch('sftp', { showHidden: ev.target.checked })}
            />
            Show hidden files
          </label>
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={f.confirmDelete}
          onChange={(ev) => patch('sftp', { confirmDelete: ev.target.checked })}
        />
        Confirm before deleting remote files
      </label>

      <h3>External editor</h3>
      {presets.length > 0 && (
        <Field label="Preset">
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
            <option value="">Choose a detected editor…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Editor executable">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={e.program ?? ''}
            onChange={(ev) => patch('editor', { program: ev.target.value || null })}
            placeholder="Not configured"
            spellCheck={false}
          />
          {isTauri() && (
            <button type="button" className="btn" onClick={() => void browse()}>
              Browse…
            </button>
          )}
        </div>
      </Field>
      <Field
        label="Arguments"
        hint="Space-separated; quote arguments that contain spaces. {file} is replaced by the local copy of the remote file."
      >
        <ArgsInput key={argsKey} args={e.args} onChange={(args) => patch('editor', { args })} />
      </Field>
      <Field label="Temporary directory" hint="Leave empty to use the application cache directory.">
        <input
          className="input"
          value={e.tempDir ?? ''}
          onChange={(ev) => patch('editor', { tempDir: ev.target.value || null })}
          spellCheck={false}
        />
      </Field>
      <div className="notice">
        Uploading an edited file always asks for confirmation. “Yes to all” applies only to the
        current connection session and is forgotten on disconnect, reconnect and restart.
      </div>
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
  const credentials = useCredentialStatus();
  const refreshConnections = useConnections((s) => s.refresh);
  const [hosts, setHosts] = useState<KnownHost[] | null>(null);

  const reload = () => ipc.knownHostsList().then(setHosts).catch(reportError);
  useEffect(() => {
    void reload();
  }, []);

  const clearAll = async () => {
    try {
      const { cleared } = await ipc.credentialsClearAll();
      await refreshConnections();
      notify(`Removed ${cleared} saved password${cleared === 1 ? '' : 's'}.`);
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <>
      <ApplicationLockSection draft={draft} patch={patch} replace={replace} />

      <h3>Credential storage</h3>
      {credentials ? (
        <div className={credentials.available ? 'notice' : 'notice notice-warn'}>
          {credentials.available
            ? `Passwords are stored in ${credentials.backend}. They are never written to PeachTerm's own files.`
            : `${credentials.backend} is unavailable${credentials.detail ? ` (${credentials.detail})` : ''}. Passwords cannot be saved and will be requested when connecting.`}
        </div>
      ) : (
        <div className="hint">Checking…</div>
      )}
      <div>
        <button className="btn" onClick={() => void clearAll()} disabled={!credentials?.available}>
          Clear all saved passwords
        </button>
      </div>

      <h3>Known host keys</h3>
      {hosts === null ? (
        <div className="hint">Loading…</div>
      ) : hosts.length === 0 ? (
        <div className="hint">No host keys trusted yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Key</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={`${h.host}:${h.port}:${h.algorithm}`}>
                <td>
                  {h.host}:{h.port}
                </td>
                <td className="mono">
                  {h.algorithm}
                  <br />
                  {h.fingerprint}
                </td>
                <td>
                  <button
                    className="btn"
                    onClick={() =>
                      ipc.knownHostsRemove(h.host, h.port).then(reload).catch(reportError)
                    }
                  >
                    Forget
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Session security</h3>
      <div className="notice">
        Remote-file uploads from external editors require confirmation in every new connection
        session. This is enforced by the backend and has no global off switch.
      </div>
    </>
  );
}

/** Clears only the recent-connection history (takes effect immediately, outside Apply/Cancel). */
function ClearHistory() {
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
          Clear Recent Sessions History
        </button>
        <span className="hint" style={{ marginLeft: 8 }}>
          Saved connections, passwords and open sessions are not affected.
        </span>
      </div>
    );
  }
  return (
    <div role="group" aria-label="Confirm clearing history" className="inline-confirm">
      <span>Forget the recent sessions list?</span>
      <button
        className="btn btn-danger"
        type="button"
        onClick={() => {
          void useRecent.getState().clear();
          setConfirming(false);
        }}
      >
        Clear history
      </button>
      <button className="btn" type="button" onClick={() => setConfirming(false)}>
        Keep
      </button>
    </div>
  );
}
