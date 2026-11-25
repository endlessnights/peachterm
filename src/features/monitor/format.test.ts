// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  formatSize,
  formatUptime,
  formatUptimeLong,
  formatUsage,
  percent,
  reasonText,
} from './format';

describe('monitor formatting', () => {
  it('uses binary units consistently', () => {
    expect(formatSize(512)).toBe('512 KiB');
    expect(formatSize(1024)).toBe('1.0 MiB');
    expect(formatSize(1024 * 1024)).toBe('1.0 GiB');
    expect(formatSize(1024 ** 3)).toBe('1.0 TiB');
    expect(formatSize(0)).toBe('0.0 KiB');
  });

  it('shows used and total in the unit of the total', () => {
    expect(formatUsage(39.2 * 1024 * 1024, 62.7 * 1024 * 1024)).toBe('39.2 / 62.7 GiB');
    expect(formatUsage(100, 4 * 1024 * 1024)).toBe('0.0 / 4.0 GiB');
    expect(formatUsage(338 * 1024 * 1024, 470 * 1024 * 1024)).toBe('338 / 470 GiB');
  });

  it('rounds and clamps percentages', () => {
    expect(percent(18.4)).toBe('18%');
    expect(percent(99.6)).toBe('100%');
    expect(percent(-3)).toBe('0%');
    expect(percent(140)).toBe('100%');
  });

  it('formats uptime compactly and in words', () => {
    expect(formatUptime(12 * 86400 + 8 * 3600 + 59)).toBe('12d 8h');
    expect(formatUptime(3 * 3600 + 25 * 60)).toBe('3h 25m');
    expect(formatUptime(300)).toBe('5m');
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptimeLong(86400 + 3600)).toBe('1 day, 1 hour');
    expect(formatUptimeLong(2 * 86400 + 5 * 3600)).toBe('2 days, 5 hours');
  });

  it('only ever shows fixed explanations, never remote text', () => {
    expect(reasonText('unsupported')).toMatch(/Linux/);
    expect(reasonText('anything else <script>')).toBe('Monitoring is not available right now.');
  });
});
