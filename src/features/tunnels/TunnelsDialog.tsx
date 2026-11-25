// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// SSH tunnels (local port forwarding, `ssh -L`) of one SSH tab. A tunnel is
// carried by THIS tab's SSH connection: it stops when that connection ends.
// Saved definitions hold no credentials; whether a tunnel runs is never saved.

import { errorMessage } from '../../i18n/errors';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { ipc } from '../../shared/ipc';
import type { TunnelView } from '../../shared/types';
import { useTabs } from '../sessions/store';

const NOT_WEB = new Set([
  21, 22, 23, 25, 53, 110, 143, 389, 445, 1433, 1521, 3306, 3389, 5432, 5672, 6379, 9092, 11211,
  27017,
]);

const address = (t: Pick<TunnelView, 'bindAddress' | 'localPort'>) =>
  t.bindAddress.includes(':')
    ? `[${t.bindAddress}]:${t.localPort}`
    : `${t.bindAddress}:${t.localPort}`;
const remoteAddress = (t: Pick<TunnelView, 'remoteHost' | 'remotePort'>) =>
  t.remoteHost.includes(':')
    ? `[${t.remoteHost}]:${t.remotePort}`
    : `${t.remoteHost}:${t.remotePort}`;

interface FormState {
  id: string | null;
  name: string;
  bindAddress: string;
  localPort: string;
  remoteHost: string;
  remotePort: string;
  autoStart: boolean;
}

const EMPTY: FormState = {
  id: null,
  name: '',
  bindAddress: '127.0.0.1',
  localPort: '',
  remoteHost: '127.0.0.1',
  remotePort: '',
  autoStart: false,
};

function TunnelForm({
  initial,
  connectionId,
  onDone,
  onCancel,
}: {
  initial: FormState;
  connectionId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t: tl } = useTranslation();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    const localPort = Number(form.localPort);
    const remotePort = Number(form.remotePort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      setError(tl('tunnels.localPortInvalid'));
      return;
    }
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      setError(tl('tunnels.remotePortInvalid'));
      return;
    }
    setBusy(true);
    try {
      await ipc.tunnelSave(connectionId, {
        id: form.id,
        name: form.name,
        bindAddress: form.bindAddress,
        localPort,
        remoteHost: form.remoteHost,
        remotePort,
        autoStart: form.autoStart,
      });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="dialog-body tunnel-form"
      aria-label={tl('tunnels.formAria')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span>{tl('tunnels.name')}</span>
        <input
          className="input"
          value={form.name}
          maxLength={64}
          data-autofocus
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>{tl('tunnels.bind')}</span>
        <select
          className="select"
          value={form.bindAddress}
          onChange={(e) => set({ bindAddress: e.target.value })}
        >
          <option value="127.0.0.1">127.0.0.1</option>
          <option value="::1">::1</option>
        </select>
      </label>
      <label className="field">
        <span>{tl('tunnels.localPort')}</span>
        <input
          className="input"
          inputMode="numeric"
          value={form.localPort}
          onChange={(e) => set({ localPort: e.target.value })}
        />
      </label>
      <label className="field">
        <span>{tl('tunnels.remoteDest')}</span>
        <input
          className="input"
          value={form.remoteHost}
          onChange={(e) => set({ remoteHost: e.target.value })}
        />
      </label>
      <label className="field">
        <span>{tl('tunnels.remotePort')}</span>
        <input
          className="input"
          inputMode="numeric"
          value={form.remotePort}
          onChange={(e) => set({ remotePort: e.target.value })}
        />
      </label>
      <p className="hint">{tl('tunnels.destHint')}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={form.autoStart}
          onChange={(e) => set({ autoStart: e.target.checked })}
        />
        {tl('tunnels.autoStart')}
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="update-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {tl('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {tl('tunnels.save')}
        </button>
      </div>
    </form>
  );
}

export function TunnelsDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { t: tl } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const [tunnels, setTunnels] = useState<TunnelView[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const alive = useRef(true);

  const connectionId = tab?.connectionId ?? '';
  const sessionId = tab?.sessionId ?? null;
  const connected = tab?.status === 'connected' && sessionId !== null;

  const reload = useCallback(async () => {
    if (!connectionId) return;
    try {
      const list = await ipc.tunnelList(connectionId);
      if (alive.current) setTunnels(list);
    } catch {
      /* locked or closing */
    }
  }, [connectionId]);

  useEffect(() => {
    alive.current = true;
    const first = setTimeout(() => void reload(), 0);
    // The state of a running tunnel can change without a click (the connection
    // drops, a forwarded connection fails): look again now and then.
    const timer = setInterval(() => void reload(), 1500);
    return () => {
      alive.current = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [reload]);

  if (!tab || tab.kind !== 'ssh') return null;

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    }
    await reload();
  };

  const ownedElsewhere = (t: TunnelView) =>
    t.status.ownerSession !== null && t.status.ownerSession !== sessionId;

  return (
    <Dialog
      title={tl('tunnels.title', { title: tab.title })}
      onClose={onClose}
      wide
      footer={
        form ? undefined : (
          <>
            <button className="btn left" onClick={() => setForm({ ...EMPTY })}>
              {tl('tunnels.add')}
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              {tl('common.close')}
            </button>
          </>
        )
      }
    >
      {form ? (
        <TunnelForm
          initial={form}
          connectionId={connectionId}
          onCancel={() => setForm(null)}
          onDone={() => {
            setForm(null);
            void reload();
          }}
        />
      ) : (
        <div className="dialog-body">
          <p className="hint">
            {tl('tunnels.hint')}
            {!connected && ` ${tl('tunnels.hintConnect')}`}
          </p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {tunnels && tunnels.length === 0 && <p>{tl('tunnels.none')}</p>}
          <ul className="tunnel-list" aria-label={tl('tunnels.listAria')}>
            {(tunnels ?? []).map((t) => {
              const running = t.status.state !== 'stopped';
              const here = !ownedElsewhere(t);
              const web = t.status.state === 'listening' && !NOT_WEB.has(t.remotePort);
              return (
                <li key={t.id} className="tunnel-row" data-state={t.status.state}>
                  <div className="tunnel-main">
                    <strong>{t.name}</strong>
                    <span className="tunnel-route">
                      {address(t)} → {remoteAddress(t)}
                    </span>
                    <span className="tunnel-status" role="status">
                      {t.status.state === 'listening' && t.status.activeConnections > 0
                        ? tl('tunnels.open', {
                            state: tl('tunnels.state.listening'),
                            count: t.status.activeConnections,
                          })
                        : ownedElsewhere(t)
                          ? tl('tunnels.otherTab', { state: tl(`tunnels.state.${t.status.state}`) })
                          : tl(`tunnels.state.${t.status.state}`)}
                    </span>
                  </div>
                  {t.status.lastError && <p className="hint tunnel-error">{t.status.lastError}</p>}
                  <div className="tunnel-actions">
                    {running ? (
                      <button className="btn" onClick={() => act(() => ipc.tunnelStop(t.id))}>
                        {tl('tunnels.stop')}
                      </button>
                    ) : (
                      <button
                        className="btn"
                        disabled={!connected}
                        onClick={() => act(() => ipc.tunnelStart(sessionId!, t.id))}
                      >
                        {tl('tunnels.start')}
                      </button>
                    )}
                    <button
                      className="btn"
                      disabled={running}
                      title={running ? tl('tunnels.stopToEdit') : undefined}
                      onClick={() =>
                        setForm({
                          id: t.id,
                          name: t.name,
                          bindAddress: t.bindAddress,
                          localPort: String(t.localPort),
                          remoteHost: t.remoteHost,
                          remotePort: String(t.remotePort),
                          autoStart: t.autoStart,
                        })
                      }
                    >
                      {tl('tunnels.edit')}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(address(t))
                          .catch(() => setError(tl('tunnels.copyFailed')));
                      }}
                    >
                      {tl('tunnels.copyLocal')}
                    </button>
                    {web && here && (
                      <button
                        className="btn"
                        onClick={() => act(() => ipc.tunnelOpenBrowser(t.id))}
                      >
                        {tl('tunnels.openBrowser')}
                      </button>
                    )}
                    {confirmDelete === t.id ? (
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          setConfirmDelete(null);
                          void act(() => ipc.tunnelDelete(t.id));
                        }}
                      >
                        {tl('tunnels.confirmDelete')}
                      </button>
                    ) : (
                      <button className="btn" onClick={() => setConfirmDelete(t.id)}>
                        {tl('tunnels.delete')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
