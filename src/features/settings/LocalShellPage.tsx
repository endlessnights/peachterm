// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Settings → Terminal → Local Shell.
//
// Profiles are DETECTED by Rust (never typed here). The only free-form input is
// a custom executable: an absolute path plus fixed arguments, which Rust checks
// again before it ever starts anything. Nothing here is run through a shell.

import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { Icon } from '../../components/Icon';
import { formatArgs, parseArgs } from '../../shared/args';
import type { CustomShell } from '../../shared/types';
import { useProfiles } from '../terminal/profilesStore';
import { Field, Segmented, type PageProps } from './controls';

/** A path the backend will accept: absolute (drive letter, UNC or leading slash). */
const BACKSLASH = String.fromCharCode(92);
export const isAbsolutePath = (p: string) => {
  const t = p.trim();
  const drive = t.length > 2 && t[1] === ':' && (t[2] === '/' || t[2] === BACKSLASH);
  return t.startsWith('/') || t.startsWith(BACKSLASH + BACKSLASH) || drive;
};

const newId = () => Math.random().toString(36).slice(2, 10);

export function LocalShellPage({ draft, patch }: PageProps) {
  const { t: tl } = useTranslation();
  const t = draft.terminal;
  const profiles = useProfiles((s) => s.profiles);
  const loading = useProfiles((s) => s.loading);
  const refresh = useProfiles((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const wsl = profiles.filter((p) => p.kind === 'wsl');
  const setCustom = (customProfiles: CustomShell[]) => patch('terminal', { customProfiles });
  const update = (id: string, values: Partial<CustomShell>) =>
    setCustom(t.customProfiles.map((c) => (c.id === id ? { ...c, ...values } : c)));

  return (
    <>
      <h3>{tl('copy.heading')}</h3>
      <Field label={tl('copy.label')} hint={tl('copy.hint')}>
        <Segmented
          value={t.copyMode}
          options={[
            { value: 'selection' as const, label: tl('copy.selection') },
            { value: 'rightClick' as const, label: tl('copy.rightClick') },
          ]}
          onChange={(copyMode) => patch('terminal', { copyMode })}
        />
      </Field>
      <h3>{tl('help.settings.heading')}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.linuxHelp.enabled}
          onChange={(e) => patch('linuxHelp', { enabled: e.target.checked })}
        />
        {tl('help.settings.enable')}
      </label>
      <span className="hint">{tl('help.settings.hint')}</span>
      <div className="settings-indent">
        <label className="check">
          <input
            type="checkbox"
            disabled={!draft.linuxHelp.enabled}
            checked={draft.linuxHelp.explain}
            onChange={(e) => patch('linuxHelp', { explain: e.target.checked })}
          />
          {tl('help.settings.explain')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={!draft.linuxHelp.enabled}
            checked={draft.linuxHelp.permissions}
            onChange={(e) => patch('linuxHelp', { permissions: e.target.checked })}
          />
          {tl('help.settings.permissions')}
        </label>
      </div>
      <span className="hint">{tl('help.settings.note')}</span>
      <h3>{tl('shell.heading')}</h3>
      <div className="settings-grid">
        <Field label={tl('shell.default')} hint={tl('shell.defaultHint')}>
          <select
            className="select"
            aria-label={tl('shell.default')}
            value={t.defaultProfile ?? ''}
            onChange={(e) => patch('terminal', { defaultProfile: e.target.value || null })}
          >
            <option value="">{tl('shell.automatic')}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tl('shell.wsl')} hint={wsl.length === 0 ? tl('shell.noWsl') : undefined}>
          <select
            className="select"
            aria-label={tl('shell.wsl')}
            value={t.wslDistro ?? ''}
            disabled={wsl.length === 0}
            onChange={(e) => patch('terminal', { wslDistro: e.target.value || null })}
          >
            <option value="">{tl('shell.firstInstalled')}</option>
            {wsl.map((p) => (
              <option key={p.id} value={p.detail}>
                {p.detail}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tl('shell.startDir')} hint={tl('shell.startDirHint')}>
          <input
            className="input"
            value={t.startDir ?? ''}
            onChange={(e) => patch('terminal', { startDir: e.target.value || null })}
            spellCheck={false}
            aria-label={tl('shell.startDir')}
          />
        </Field>
      </div>

      <h3>{tl('shell.detected')}</h3>
      <ul className="profile-list" aria-label={tl('shell.detected')}>
        {profiles.map((p) => (
          <li key={p.id}>
            <Icon name="terminal" />
            <span>{p.name}</span>
            <span className="hint">{p.kind === 'wsl' ? 'WSL' : p.detail}</span>
          </li>
        ))}
        {profiles.length === 0 && <li className="hint">{tl('shell.noneFound')}</li>}
      </ul>
      <button className="btn" onClick={() => void refresh()} disabled={loading}>
        <Icon name="refresh" /> {loading ? tl('shell.detecting') : tl('shell.refresh')}
      </button>

      <h3>{tl('shell.custom')}</h3>
      <div className="notice">{tl('shell.customNotice')}</div>
      {t.customProfiles.map((c) => {
        const bad = c.program.trim() !== '' && !isAbsolutePath(c.program);
        return (
          <div className="settings-grid custom-shell" key={c.id}>
            <Field label={tl('shell.name')}>
              <input
                className="input"
                value={c.name}
                onChange={(e) => update(c.id, { name: e.target.value })}
                aria-label={tl('shell.nameAria')}
              />
            </Field>
            <Field label={tl('shell.exe')} hint={bad ? tl('shell.exeHint') : undefined}>
              <input
                className="input"
                value={c.program}
                aria-invalid={bad || undefined}
                onChange={(e) => update(c.id, { program: e.target.value })}
                spellCheck={false}
                aria-label={tl('shell.exeAria')}
              />
            </Field>
            <Field label={tl('settings.editor.arguments')}>
              <input
                className="input"
                defaultValue={formatArgs(c.args)}
                onBlur={(e) => update(c.id, { args: parseArgs(e.target.value) })}
                spellCheck={false}
                aria-label={tl('shell.argsAria')}
              />
            </Field>
            <button
              className="btn"
              onClick={() => setCustom(t.customProfiles.filter((x) => x.id !== c.id))}
            >
              <Icon name="trash" /> {tl('shell.remove')}
            </button>
          </div>
        );
      })}
      <button
        className="btn"
        disabled={t.customProfiles.length >= 16}
        onClick={() =>
          setCustom([
            ...t.customProfiles,
            { id: newId(), name: tl('shell.myShell'), program: '', args: [] },
          ])
        }
      >
        <Icon name="plus" /> {tl('shell.add')}
      </button>
    </>
  );
}
