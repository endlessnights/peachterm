// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { currentLanguage } from './index';

// Intl formatting follows the interface language. Machine data (ports, IPs,
// paths, versions) is never passed through these helpers.

export const formatNumber = (n: number, options?: Intl.NumberFormatOptions): string =>
  new Intl.NumberFormat(currentLanguage(), options).format(n);

export const formatDecimal = (n: number, digits = 1): string =>
  formatNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const formatPercent = (percent: number): string =>
  new Intl.NumberFormat(currentLanguage(), { style: 'percent', maximumFractionDigits: 0 }).format(
    percent / 100,
  );

export const formatDateTime = (value: number | Date): string =>
  new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    value,
  );

export const formatDate = (value: number | Date): string =>
  new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium' }).format(value);

export const formatTime = (value: number | Date): string =>
  new Intl.DateTimeFormat(currentLanguage(), { timeStyle: 'medium' }).format(value);

/** "a, b and c" in the interface language (Intl.ListFormat), never a hand-written "and". */
export const formatList = (items: string[]): string =>
  new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'conjunction' }).format(items);

/** "a, b, c" without a conjunction (counts and measurements). */
export const formatUnitList = (items: string[]): string =>
  new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'unit' }).format(items);
