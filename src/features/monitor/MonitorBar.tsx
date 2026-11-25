// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// The compact resource readout in the status bar, for the active tab's server
// (in Split View: the focused pane). A click opens a small details popover.

import { useTranslation } from 'react-i18next';
import { formatDecimal } from '../../i18n/format';
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
  const { t } = useTranslation();
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
    body = <span className="mon-note">{t('monitor.waiting')}</span>;
  } else if (entry.phase === 'unavailable') {
    body = (
      <span className="mon-note" title={reasonText(entry.reason)}>
        {t('monitor.unavailable')}
      </span>
    );
  } else if (m) {
    body = (
      <>
        {cfg.cpu && (
          <span className="mon-item" title={t('monitor.cpuTip')}>
            {t('monitor.cpu', { value: m.cpuPercent === null ? '—' : percent(m.cpuPercent) })}
            {m.cpuPercent !== null && <Meter value={m.cpuPercent} />}
          </span>
        )}
        {cfg.ram && (
          <span className="mon-item" title={t('monitor.ramTip')}>
            {t('monitor.ram', {
              value: m.memory ? formatUsage(m.memory.usedKib, m.memory.totalKib) : t('monitor.na'),
            })}
            {m.memory && <Meter value={(m.memory.usedKib / m.memory.totalKib) * 100} />}
          </span>
        )}
        {cfg.disk && (
          <span className="mon-item" title={t('monitor.diskTip')}>
            {t('monitor.disk', { value: m.disk ? percent(m.disk.percent) : t('monitor.na') })}
            {m.disk && <Meter value={m.disk.percent} />}
          </span>
        )}
        {cfg.uptime && (
          <span className="mon-item" title={t('monitor.upTip')}>
            {t('monitor.up', {
              value: m.uptimeSecs === null ? t('monitor.na') : formatUptime(m.uptimeSecs),
            })}
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
        aria-label={t('monitor.barAria')}
        aria-expanded={open}
        title={stale ? t('monitor.staleTip') : t('monitor.barTip')}
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
        {stale && <span className="mon-note">{t('monitor.stale')}</span>}
      </button>
      {open && entry && (
        <div
          className="mon-popover"
          role="dialog"
          aria-label={t('monitor.popTitle')}
          style={{ left: anchor.left, bottom: anchor.bottom }}
        >
          <h4>{t('monitor.popTitle')}</h4>
          {entry.phase !== 'live' || !m ? (
            <p className="mon-detail-note">
              {entry.phase === 'waiting' ? t('monitor.waitingFirst') : reasonText(entry.reason)}
            </p>
          ) : (
            <dl className="mon-detail">
              <dt>{t('monitor.cpuLabel')}</dt>
              <dd>{m.cpuPercent === null ? t('monitor.cpuNeedsTwo') : percent(m.cpuPercent)}</dd>
              {m.load && (
                <>
                  <dt>{t('monitor.load')}</dt>
                  <dd>{m.load.map((v) => formatDecimal(v, 2)).join('  ')}</dd>
                </>
              )}
              <dt>{t('monitor.memory')}</dt>
              <dd>
                {m.memory ? formatUsage(m.memory.usedKib, m.memory.totalKib) : t('monitor.na')}
              </dd>
              {m.memory && (
                <>
                  <dt>{t('monitor.available')}</dt>
                  <dd>{formatSize(m.memory.availableKib)}</dd>
                </>
              )}
              <dt>{t('monitor.rootFs')}</dt>
              <dd>{m.disk ? percent(m.disk.percent) : t('monitor.na')}</dd>
              {m.disk && (
                <>
                  <dt>{t('monitor.used')}</dt>
                  <dd>{formatUsage(m.disk.usedKib, m.disk.totalKib)}</dd>
                </>
              )}
              <dt>{t('monitor.uptime')}</dt>
              <dd>{m.uptimeSecs === null ? t('monitor.na') : formatUptimeLong(m.uptimeSecs)}</dd>
            </dl>
          )}
          {entry.at !== null && (
            <p className="mon-detail-note">
              {t('monitor.lastUpdated', { age: formatAge(now - entry.at) })}
            </p>
          )}
          <p className="mon-detail-note">{t('monitor.footnote')}</p>
        </div>
      )}
    </span>
  );
}
