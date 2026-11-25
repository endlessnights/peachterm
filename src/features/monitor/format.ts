// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Formatting of live server readings. Memory and disk use binary units
// (MiB, GiB, TiB) throughout; the kernel reports KiB.

import { currentLanguage, t as tr } from '../../i18n';
import { formatDecimal, formatNumber, formatPercent } from '../../i18n/format';

const UNITS = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** `kib` -> { value, unit } in the largest unit that keeps the value >= 1. */
export function binary(kib: number): { value: number; unit: string } {
  let value = Math.max(0, kib);
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i += 1;
  }
  return { value, unit: UNITS[i]! };
}

const num = (v: number) => (v >= 100 ? formatNumber(Math.round(v)) : formatDecimal(v, 1));

/** "39.2 GiB" */
export function formatSize(kib: number): string {
  const { value, unit } = binary(kib);
  return `${num(value)} ${unit}`;
}

/** "39.2 / 62.7 GiB": both numbers in the unit of the total. */
export function formatUsage(usedKib: number, totalKib: number): string {
  const { unit } = binary(totalKib);
  const idx = UNITS.indexOf(unit as (typeof UNITS)[number]);
  const div = 1024 ** idx;
  return `${num(usedKib / div)} / ${num(totalKib / div)} ${unit}`;
}

export function percent(value: number): string {
  return formatPercent(Math.round(Math.min(100, Math.max(0, value))));
}

const unitText = (
  n: number,
  unit: 'day' | 'hour' | 'minute' | 'second',
  display: 'narrow' | 'long',
) =>
  new Intl.NumberFormat(currentLanguage(), {
    style: 'unit',
    unit,
    unitDisplay: display,
    maximumFractionDigits: 0,
  }).format(n);

/** Compact: "12d 8h", "3h 25m", "5m", "40s". */
export function formatUptime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${unitText(d, 'day', 'narrow')} ${unitText(h, 'hour', 'narrow')}`;
  if (h > 0) return `${unitText(h, 'hour', 'narrow')} ${unitText(m, 'minute', 'narrow')}`;
  if (m > 0) return unitText(m, 'minute', 'narrow');
  return unitText(s, 'second', 'narrow');
}

/** Long form for the details view: "12 days, 8 hours". */
export function formatUptimeLong(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const list = (...parts: [number, 'day' | 'hour' | 'minute'][]) =>
    new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'unit' }).format(
      parts.map(([n, unit]) => unitText(n, unit, 'long')),
    );
  if (d > 0) return list([d, 'day'], [h, 'hour']);
  if (h > 0) return list([h, 'hour'], [m, 'minute']);
  return list([m, 'minute']);
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 2
    ? tr('monitor.justNow')
    : new Intl.RelativeTimeFormat(currentLanguage(), { numeric: 'always' }).format(-s, 'second');
}

/** Concise, fixed explanations for the reason tokens Rust sends. */
export function reasonText(reason: string | undefined): string {
  switch (reason) {
    case 'unsupported':
      return tr('monitor.reason.unsupported');
    case 'timeout':
      return tr('monitor.reason.timeout');
    case 'channel':
      return tr('monitor.reason.channel');
    case 'toolarge':
    case 'failed':
      return tr('monitor.reason.failed');
    default:
      return tr('monitor.reason.default');
  }
}
