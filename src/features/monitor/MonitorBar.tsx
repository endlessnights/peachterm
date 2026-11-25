// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The compact resource readout in the status bar, for the active tab's server
// (in Split View: the focused pane). A click opens a small details popover.

import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../settings/store';
import { useTabs } from '../sessions/store';
import {
  formatAge,
  formatSize,
  formatUptime,
  formatUptimeLong,
  formatUsage,
  percent,
  reasonText,
} from './format';
import { useMonitor, type MonitorEntry } from './store';

function Meter({ value }: { value: number }) {
  return (
    <span className="mon-meter" aria-hidden="true">
      <span
        className="mon-meter-fill"
        data-level={value >= 90 ? 'high' : value >= 75 ? 'warn' : 'ok'}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </span>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function MonitorBar() {
  const sessionId = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.sessionId ?? null);
  const entry: MonitorEntry | undefined = useMonitor((s) =>
    sessionId ? s.entries[sessionId] : undefined,
  );
  const cfg = useSettings((s) => s.settings.monitoring);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ left: 0, bottom: 0 });
  const now = useNow(!!entry);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!entry) return null;

  const stale =
    entry.phase === 'live' && entry.at !== null && now - entry.at > cfg.intervalSecs * 3000;
  const m = entry.phase === 'live' ? entry.metrics : null;

  let body;
  if (entry.phase === 'waiting') {
    body = <span className="mon-note">Server resources…</span>;
  } else if (entry.phase === 'unavailable') {
    body = (
      <span className="mon-note" title={reasonText(entry.reason)}>
        Monitoring unavailable
      </span>
    );
  } else if (m) {
    body = (
      <>
        {cfg.cpu && (
          <span className="mon-item" title="CPU utilisation (all cores)">
            CPU {m.cpuPercent === null ? '—' : percent(m.cpuPercent)}
            {m.cpuPercent !== null && <Meter value={m.cpuPercent} />}
          </span>
        )}
        {cfg.ram && (
          <span className="mon-item" title="Memory in use (MemTotal − MemAvailable)">
            RAM {m.memory ? formatUsage(m.memory.usedKib, m.memory.totalKib) : 'N/A'}
            {m.memory && <Meter value={(m.memory.usedKib / m.memory.totalKib) * 100} />}
          </span>
        )}
        {cfg.disk && (
          <span className="mon-item" title="Root filesystem (/) only, not every disk">
            Disk / {m.disk ? percent(m.disk.percent) : 'N/A'}
            {m.disk && <Meter value={m.disk.percent} />}
          </span>
        )}
        {cfg.uptime && (
          <span className="mon-item" title="Server uptime (not the session duration)">
            Up {m.uptimeSecs === null ? 'N/A' : formatUptime(m.uptimeSecs)}
          </span>
        )}
      </>
    );
  }

  return (
    <span className="mon-wrap">
      <button
        type="button"
        className="mon-bar"
        data-stale={stale || undefined}
        aria-label="Server resources"
        aria-expanded={open}
        title={stale ? 'Readings are stale' : 'Server resources (click for details)'}
        ref={button}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          // fixed positioning: the status bar clips its children
          if (r)
            setAnchor({
              left: Math.max(4, Math.min(r.left, window.innerWidth - 370)),
              bottom: window.innerHeight - r.top + 6,
            });
          setOpen((v) => !v);
        }}
      >
        {body}
        {stale && <span className="mon-note">stale</span>}
      </button>
      {open && entry && (
        <div
          className="mon-popover"
          role="dialog"
          aria-label="Server Resources"
          style={{ left: anchor.left, bottom: anchor.bottom }}
        >
          <h4>Server Resources</h4>
          {entry.phase !== 'live' || !m ? (
            <p className="mon-detail-note">
              {entry.phase === 'waiting'
                ? 'Waiting for the first reading…'
                : reasonText(entry.reason)}
            </p>
          ) : (
            <dl className="mon-detail">
              <dt>CPU</dt>
              <dd>{m.cpuPercent === null ? '— (needs two readings)' : percent(m.cpuPercent)}</dd>
              {m.load && (
                <>
                  <dt>Load</dt>
                  <dd>{m.load.map((v) => v.toFixed(2)).join('  ')}</dd>
                </>
              )}
              <dt>Memory</dt>
              <dd>{m.memory ? formatUsage(m.memory.usedKib, m.memory.totalKib) : 'N/A'}</dd>
              {m.memory && (
                <>
                  <dt>Available</dt>
                  <dd>{formatSize(m.memory.availableKib)}</dd>
                </>
              )}
              <dt>Root FS</dt>
              <dd>{m.disk ? percent(m.disk.percent) : 'N/A'}</dd>
              {m.disk && (
                <>
                  <dt>Used</dt>
                  <dd>{formatUsage(m.disk.usedKib, m.disk.totalKib)}</dd>
                </>
              )}
              <dt>Uptime</dt>
              <dd>{m.uptimeSecs === null ? 'N/A' : formatUptimeLong(m.uptimeSecs)}</dd>
            </dl>
          )}
          {entry.at !== null && (
            <p className="mon-detail-note">Last updated: {formatAge(now - entry.at)}</p>
          )}
          <p className="mon-detail-note">
            Live values only: nothing is saved. Disk shows the root filesystem /, not every disk or
            storage pool.
          </p>
        </div>
      )}
    </span>
  );
}
