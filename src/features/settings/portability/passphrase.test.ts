// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { MIN_PASSPHRASE_CHARS, assessPassphrase } from './passphrase';

describe('passphrase guidance', () => {
  it('matches the minimum length enforced by Rust', () => {
    expect(MIN_PASSPHRASE_CHARS).toBe(12);
    expect(assessPassphrase('').strength).toBe('empty');
    expect(assessPassphrase('short').strength).toBe('tooShort');
    expect(assessPassphrase('a'.repeat(11)).strength).toBe('tooShort');
    expect(assessPassphrase('a'.repeat(12)).strength).not.toBe('tooShort');
  });

  it('counts characters, not bytes, so Cyrillic phrases are not penalised', () => {
    expect(assessPassphrase('двенадцать!!').strength).not.toBe('tooShort');
  });

  it('rates repetition and common words low and long mixed phrases high', () => {
    expect(assessPassphrase('aaaaaaaaaaaaaaaa').strength).toBe('weak');
    expect(assessPassphrase('password1234').strength).toBe('weak');
    expect(['good', 'strong']).toContain(assessPassphrase('plum-orbit-VELVET-9-harbor').strength);
  });

  it('is only advice: a weak but long-enough passphrase is still rated, never rejected', () => {
    const a = assessPassphrase('abcdefghijkl');
    expect(a.level).toBeGreaterThan(0);
  });
});
