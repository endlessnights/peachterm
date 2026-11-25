// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../i18n/errors';
import { useEffect, useMemo, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { Dialog } from '../../components/Dialog';
import { isTauri, ipc } from '../../shared/ipc';
import type {
  AuthMethod,
  Connection,
  ConnectionInput,
  MonitorMode,
  Uuid,
} from '../../shared/types';
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

const AUTH_METHODS: AuthMethod[] = ['password', 'publicKey', 'keyboardInteractive', 'agent'];

import { useActivity } from '../exit/activity';
import { useTranslation } from 'react-i18next';

export function ConnectionEditor({ connection, defaultFolderId, onClose }: Props) {
  const { t } = useTranslation();
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
          monitoring: connection.monitoring,
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
          monitoring: 'inherit',
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
      title: t('editor.selectKey'),
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
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const secretLabel = form.auth === 'publicKey' ? t('editor.passphrase') : t('editor.password');

  return (
    <Dialog
      title={
        connection ? t('editor.editTitle', { name: connection.name }) : t('conn.newConnection')
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {connection ? t('editor.save') : t('editor.create')}
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
            <span>{t('editor.host')}</span>
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
            <span>{t('editor.port')}</span>
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
          <span>{t('editor.displayName')}</span>
          <input
            className="input"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder={form.host || t('editor.displayPlaceholder')}
          />
        </label>
        <div className="field-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label className="field">
            <span>{t('editor.username')}</span>
            <input
              className="input"
              value={form.username}
              onChange={(e) => update('username', e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="field">
            <span>{t('editor.authentication')}</span>
            <select
              className="select"
              value={form.auth}
              onChange={(e) => update('auth', e.target.value as AuthMethod)}
            >
              {AUTH_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`settings.ssh.auth.${m}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {form.auth === 'publicKey' && (
          <label className="field">
            <span>{t('editor.privateKey')}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                value={form.keyPath ?? ''}
                onChange={(e) => update('keyPath', e.target.value || null)}
                placeholder={t('editor.keyPlaceholder')}
                spellCheck={false}
              />
              {isTauri() && (
                <button type="button" className="btn" onClick={() => void browseKey()}>
                  {t('settings.editor.browse')}
                </button>
              )}
            </div>
            <span className="hint">{t('editor.keyHint')}</span>
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
              {t(form.auth === 'publicKey' ? 'editor.savePassphrase' : 'editor.savePassword', {
                where: credentials?.backend ?? t('editor.systemKeychain'),
              })}
            </label>
            {credentials && !credentials.available && (
              <span className="notice notice-warn">{t('editor.noKeychain')}</span>
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
                  placeholder={connection?.hasStoredSecret ? t('editor.savedKeep') : ''}
                />
              </label>
            )}
          </div>
        )}

        <div className="field-row" style={{ gridTemplateColumns: '1fr 120px' }}>
          <label className="field">
            <span>{t('editor.folder')}</span>
            <select
              className="select"
              value={form.folderId ?? ''}
              onChange={(e) => update('folderId', e.target.value || null)}
            >
              <option value="">{t('editor.root')}</option>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('editor.timeout')}</span>
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
          <span>{t('editor.initialDir')}</span>
          <input
            className="input"
            value={form.initialDirectory ?? ''}
            onChange={(e) => update('initialDirectory', e.target.value || null)}
            placeholder="/var/www"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>{t('editor.monitoring')}</span>
          <select
            className="select"
            value={form.monitoring ?? 'inherit'}
            onChange={(e) => update('monitoring', e.target.value as MonitorMode)}
          >
            <option value="inherit">{t('editor.monitorInherit')}</option>
            <option value="enabled">{t('editor.monitorOn')}</option>
            <option value="disabled">{t('editor.monitorOff')}</option>
          </select>
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
