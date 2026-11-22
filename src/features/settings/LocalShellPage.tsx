// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Settings → Terminal → Local Shell.
//
// Profiles are DETECTED by Rust (never typed here). The only free-form input is
// a custom executable: an absolute path plus fixed arguments, which Rust checks
// again before it ever starts anything. Nothing here is run through a shell.

import { useEffect } from 'react';
import { Icon } from '../../components/Icon';
import { formatArgs, parseArgs } from '../../shared/args';
import type { CustomShell } from '../../shared/types';
import { useProfiles } from '../terminal/profilesStore';
import { Field, type PageProps } from './controls';

/** A path the backend will accept: absolute (drive letter, UNC or leading slash). */
const BACKSLASH = String.fromCharCode(92);
export const isAbsolutePath = (p: string) => {
  const t = p.trim();
  const drive = t.length > 2 && t[1] === ':' && (t[2] === '/' || t[2] === BACKSLASH);
  return t.startsWith('/') || t.startsWith(BACKSLASH + BACKSLASH) || drive;
};

const newId = () => Math.random().toString(36).slice(2, 10);

export function LocalShellPage({ draft, patch }: PageProps) {
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
      <h3>Local Shell</h3>
      <div className="settings-grid">
        <Field label="Default shell" hint="Started by a plain click on + in the tab bar.">
          <select
            className="select"
            aria-label="Default shell"
            value={t.defaultProfile ?? ''}
            onChange={(e) => patch('terminal', { defaultProfile: e.target.value || null })}
          >
            <option value="">Automatic</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Preferred WSL distribution"
          hint={wsl.length === 0 ? 'No WSL distributions were found.' : undefined}
        >
          <select
            className="select"
            aria-label="Preferred WSL distribution"
            value={t.wslDistro ?? ''}
            disabled={wsl.length === 0}
            onChange={(e) => patch('terminal', { wslDistro: e.target.value || null })}
          >
            <option value="">First installed</option>
            {wsl.map((p) => (
              <option key={p.id} value={p.detail}>
                {p.detail}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Start directory"
          hint="Empty = your home directory. Must be an existing folder."
        >
          <input
            className="input"
            value={t.startDir ?? ''}
            onChange={(e) => patch('terminal', { startDir: e.target.value || null })}
            spellCheck={false}
            aria-label="Start directory"
          />
        </Field>
      </div>

      <h3>Detected shells</h3>
      <ul className="profile-list" aria-label="Detected shells">
        {profiles.map((p) => (
          <li key={p.id}>
            <Icon name="terminal" />
            <span>{p.name}</span>
            <span className="hint">{p.kind === 'wsl' ? 'WSL' : p.detail}</span>
          </li>
        ))}
        {profiles.length === 0 && <li className="hint">No local shells were found.</li>}
      </ul>
      <button className="btn" onClick={() => void refresh()} disabled={loading}>
        <Icon name="refresh" /> {loading ? 'Detecting…' : 'Refresh profiles'}
      </button>

      <h3>Custom shells</h3>
      <div className="notice">
        A custom shell is an executable (full path) with fixed arguments. It is started directly,
        never through another shell.
      </div>
      {t.customProfiles.map((c) => {
        const bad = c.program.trim() !== '' && !isAbsolutePath(c.program);
        return (
          <div className="settings-grid custom-shell" key={c.id}>
            <Field label="Name">
              <input
                className="input"
                value={c.name}
                onChange={(e) => update(c.id, { name: e.target.value })}
                aria-label="Custom shell name"
              />
            </Field>
            <Field
              label="Executable (full path)"
              hint={bad ? 'Use a full path such as C:/Tools/nu.exe or /usr/bin/fish.' : undefined}
            >
              <input
                className="input"
                value={c.program}
                aria-invalid={bad || undefined}
                onChange={(e) => update(c.id, { program: e.target.value })}
                spellCheck={false}
                aria-label="Custom shell executable"
              />
            </Field>
            <Field label="Arguments">
              <input
                className="input"
                defaultValue={formatArgs(c.args)}
                onBlur={(e) => update(c.id, { args: parseArgs(e.target.value) })}
                spellCheck={false}
                aria-label="Custom shell arguments"
              />
            </Field>
            <button
              className="btn"
              onClick={() => setCustom(t.customProfiles.filter((x) => x.id !== c.id))}
            >
              <Icon name="trash" /> Remove
            </button>
          </div>
        );
      })}
      <button
        className="btn"
        disabled={t.customProfiles.length >= 16}
        onClick={() =>
          setCustom([...t.customProfiles, { id: newId(), name: 'My shell', program: '', args: [] }])
        }
      >
        <Icon name="plus" /> Add custom shell
      </button>
    </>
  );
}
