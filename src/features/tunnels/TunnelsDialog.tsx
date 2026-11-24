// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// SSH tunnels (local port forwarding, `ssh -L`) of one SSH tab. A tunnel is
// carried by THIS tab's SSH connection: it stops when that connection ends.
// Saved definitions hold no credentials; whether a tunnel runs is never saved.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { ipc, toAppError } from '../../shared/ipc';
import type { TunnelState, TunnelView } from '../../shared/types';
import { useTabs } from '../sessions/store';

const STATE_LABEL: Record<TunnelState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  // The local socket is bound; this does not promise the remote service answers.
  listening: 'Listening',
  connectionUnavailable: 'Connection unavailable',
  error: 'Error',
};

/** Services that do not speak HTTP: no "Open in Browser" for them. */
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
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    const localPort = Number(form.localPort);
    const remotePort = Number(form.remotePort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      setError('The local port must be a number between 1 and 65535.');
      return;
    }
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      setError('The remote port must be a number between 1 and 65535.');
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
      setError(toAppError(e).message);
      setBusy(false);
    }
  };

  return (
    <form
      className="dialog-body tunnel-form"
      aria-label="SSH Port Forwarding"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          value={form.name}
          maxLength={64}
          data-autofocus
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Local bind address</span>
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
        <span>Local port</span>
        <input
          className="input"
          inputMode="numeric"
          value={form.localPort}
          onChange={(e) => set({ localPort: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Remote destination</span>
        <input
          className="input"
          value={form.remoteHost}
          onChange={(e) => set({ remoteHost: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Remote port</span>
        <input
          className="input"
          inputMode="numeric"
          value={form.remotePort}
          onChange={(e) => set({ remotePort: e.target.value })}
        />
      </label>
      <p className="hint">
        The destination is reached from the SSH server, not from this computer: 127.0.0.1 means the
        server&apos;s own loopback interface. The local port is listened on this computer only.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={form.autoStart}
          onChange={(e) => set({ autoStart: e.target.checked })}
        />
        Start automatically when SSH connects
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="update-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

export function TunnelsDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
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
      setError(toAppError(e).message);
    }
    await reload();
  };

  const ownedElsewhere = (t: TunnelView) =>
    t.status.ownerSession !== null && t.status.ownerSession !== sessionId;

  return (
    <Dialog
      title={`SSH Tunnels — ${tab.title}`}
      onClose={onClose}
      wide
      footer={
        form ? undefined : (
          <>
            <button className="btn left" onClick={() => setForm({ ...EMPTY })}>
              Add Tunnel
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Close
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
            Forwards listen on this computer only and are carried by this tab&apos;s SSH connection.
            They stop when the connection ends.
            {!connected && ' Connect this tab to start a tunnel.'}
          </p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {tunnels && tunnels.length === 0 && <p>No tunnels saved for this connection yet.</p>}
          <ul className="tunnel-list" aria-label="Tunnels">
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
                      {STATE_LABEL[t.status.state]}
                      {ownedElsewhere(t) ? ' (in another tab)' : ''}
                      {t.status.state === 'listening' && t.status.activeConnections > 0
                        ? ` · ${t.status.activeConnections} open`
                        : ''}
                    </span>
                  </div>
                  {t.status.lastError && <p className="hint tunnel-error">{t.status.lastError}</p>}
                  <div className="tunnel-actions">
                    {running ? (
                      <button className="btn" onClick={() => act(() => ipc.tunnelStop(t.id))}>
                        Stop
                      </button>
                    ) : (
                      <button
                        className="btn"
                        disabled={!connected}
                        onClick={() => act(() => ipc.tunnelStart(sessionId!, t.id))}
                      >
                        Start
                      </button>
                    )}
                    <button
                      className="btn"
                      disabled={running}
                      title={running ? 'Stop the tunnel to edit it' : undefined}
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
                      Edit
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(address(t))
                          .catch(() => setError('The address could not be copied.'));
                      }}
                    >
                      Copy Local Address
                    </button>
                    {web && here && (
                      <button
                        className="btn"
                        onClick={() => act(() => ipc.tunnelOpenBrowser(t.id))}
                      >
                        Open in Browser
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
                        Confirm Delete
                      </button>
                    ) : (
                      <button className="btn" onClick={() => setConfirmDelete(t.id)}>
                        Delete
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
