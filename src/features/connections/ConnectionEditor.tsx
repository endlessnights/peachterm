// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { Dialog } from '../../components/Dialog';
import { isTauri, ipc, toAppError } from '../../shared/ipc';
import type { AuthMethod, Connection, ConnectionInput, Uuid } from '../../shared/types';
import { useSettings } from '../settings/store';
import { useConnections } from './store';
import { folderPath } from './tree';
import { useCredentialStatus } from './useCredentialStatus';

interface Props {
  /** Existing connection to edit, or `null` for a new one. */
  connection: Connection | null;
  defaultFolderId: Uuid | null;
  onClose: () => void;
}

const AUTH_LABELS: Record<AuthMethod, string> = {
  password: 'Password',
  publicKey: 'Public key',
  keyboardInteractive: 'Keyboard-interactive',
  agent: 'SSH agent',
};

import { useActivity } from '../exit/activity';

export function ConnectionEditor({ connection, defaultFolderId, onClose }: Props) {
  const settings = useSettings((s) => s.settings);
  const folders = useConnections((s) => s.tree.folders);
  const saveConnection = useConnections((s) => s.saveConnection);
  const refresh = useConnections((s) => s.refresh);
  const credentials = useCredentialStatus();

  const [form, setForm] = useState<ConnectionInput>(() =>
    connection
      ? {
          id: connection.id,
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          auth: connection.auth,
          keyPath: connection.keyPath,
          savePassword: connection.savePassword,
          timeoutSecs: connection.timeoutSecs,
          initialDirectory: connection.initialDirectory,
          folderId: connection.folderId,
        }
      : {
          id: null,
          name: '',
          host: '',
          port: 22,
          username: settings.ssh.defaultUsername,
          auth: settings.ssh.preferredAuth,
          keyPath: null,
          savePassword: false,
          timeoutSecs: settings.ssh.connectTimeoutSecs,
          initialDirectory: null,
          folderId: defaultFolderId,
        },
  );
  // The password lives only in this component until it is handed to Rust.
  const [password, setPassword] = useState('');
  // Exiting asks first while this dialog holds changes that were not saved.
  const [initial] = useState(() => JSON.stringify(form));
  const unsaved = JSON.stringify(form) !== initial || password !== '';
  useEffect(() => {
    useActivity.getState().setUnsaved('connection', unsaved);
    return () => useActivity.getState().setUnsaved('connection', false);
  }, [unsaved]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const folderOptions = useMemo(
    () =>
      folders
        .map((f) => ({ id: f.id, label: folderPath(folders, f.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [folders],
  );

  const update = <K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const secretCapable = form.auth === 'password' || form.auth === 'publicKey';
  const canSavePassword = credentials?.available === true && secretCapable;

  const browseKey = async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      title: 'Select private key',
    });
    if (typeof picked === 'string') update('keyPath', picked);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const input: ConnectionInput = {
        ...form,
        name: form.name.trim() || form.host.trim(),
        savePassword: canSavePassword && form.savePassword,
        keyPath: form.auth === 'publicKey' ? form.keyPath : null,
      };
      const saved = await saveConnection(input);
      if (input.savePassword && password) {
        await ipc.credentialsSetPassword(saved.id, password);
        setPassword('');
        await refresh();
      }
      onClose();
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const secretLabel = form.auth === 'publicKey' ? 'Key passphrase' : 'Password';

  return (
    <Dialog
      title={connection ? `Edit ${connection.name}` : 'New connection'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {connection ? 'Save' : 'Create'}
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
        <div className="field-row">
          <label className="field">
            <span>Host or IP address</span>
            <input
              className="input"
              value={form.host}
              onChange={(e) => update('host', e.target.value)}
              placeholder="server.example.com"
              spellCheck={false}
              autoCapitalize="off"
              data-autofocus
            />
          </label>
          <label className="field">
            <span>Port</span>
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => update('port', Number(e.target.value) || 0)}
            />
          </label>
        </div>
        <label className="field">
          <span>Display name</span>
          <input
            className="input"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder={form.host || 'My server'}
          />
        </label>
        <div className="field-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label className="field">
            <span>Username</span>
            <input
              className="input"
              value={form.username}
              onChange={(e) => update('username', e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="field">
            <span>Authentication</span>
            <select
              className="select"
              value={form.auth}
              onChange={(e) => update('auth', e.target.value as AuthMethod)}
            >
              {(Object.keys(AUTH_LABELS) as AuthMethod[]).map((m) => (
                <option key={m} value={m}>
                  {AUTH_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {form.auth === 'publicKey' && (
          <label className="field">
            <span>Private key file</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                value={form.keyPath ?? ''}
                onChange={(e) => update('keyPath', e.target.value || null)}
                placeholder="Path to id_ed25519"
                spellCheck={false}
              />
              {isTauri() && (
                <button type="button" className="btn" onClick={() => void browseKey()}>
                  Browse…
                </button>
              )}
            </div>
            <span className="hint">The key stays where it is; only its path is saved.</span>
          </label>
        )}

        {secretCapable && (
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={canSavePassword && form.savePassword}
                disabled={!canSavePassword}
                onChange={(e) => update('savePassword', e.target.checked)}
              />
              Save {secretLabel.toLowerCase()} in {credentials?.backend ?? 'the system keychain'}
            </label>
            {credentials && !credentials.available && (
              <span className="notice notice-warn">
                Secure credential storage is not available on this system. PeachTerm never stores
                passwords in plain text, so you will be asked when connecting.
              </span>
            )}
            {canSavePassword && form.savePassword && (
              <label className="field">
                <span>{secretLabel}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={connection?.hasStoredSecret ? 'Saved — leave empty to keep' : ''}
                />
              </label>
            )}
          </div>
        )}

        <div className="field-row" style={{ gridTemplateColumns: '1fr 120px' }}>
          <label className="field">
            <span>Folder</span>
            <select
              className="select"
              value={form.folderId ?? ''}
              onChange={(e) => update('folderId', e.target.value || null)}
            >
              <option value="">(root)</option>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Timeout (s)</span>
            <input
              className="input"
              type="number"
              min={1}
              max={300}
              value={form.timeoutSecs}
              onChange={(e) => update('timeoutSecs', Number(e.target.value) || 0)}
            />
          </label>
        </div>
        <label className="field">
          <span>Initial remote directory (optional)</span>
          <input
            className="input"
            value={form.initialDirectory ?? ''}
            onChange={(e) => update('initialDirectory', e.target.value || null)}
            placeholder="/var/www"
            spellCheck={false}
          />
        </label>
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
