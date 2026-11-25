// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Formatting of live server readings. Memory and disk use binary units
// (MiB, GiB, TiB) throughout; the kernel reports KiB.

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

const num = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

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
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

/** Compact: "12d 8h", "3h 25m", "5m", "40s". */
export function formatUptime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Long form for the details view: "12 days, 8 hours". */
export function formatUptimeLong(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (d > 0) return `${plural(d, 'day')}, ${plural(h, 'hour')}`;
  if (h > 0) return `${plural(h, 'hour')}, ${plural(m, 'minute')}`;
  return plural(m, 'minute');
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 2 ? 'just now' : `${s} seconds ago`;
}

/** Concise, fixed explanations for the reason tokens Rust sends. */
export function reasonText(reason: string | undefined): string {
  switch (reason) {
    case 'unsupported':
      return 'This server does not expose the Linux /proc information PeachTerm reads (Linux servers only).';
    case 'timeout':
      return 'The server did not answer in time. PeachTerm will keep trying.';
    case 'channel':
      return 'The server refused the monitoring request. PeachTerm will keep trying.';
    case 'toolarge':
    case 'failed':
      return 'The server returned an unexpected answer. PeachTerm will keep trying.';
    default:
      return 'Monitoring is not available right now.';
  }
}
