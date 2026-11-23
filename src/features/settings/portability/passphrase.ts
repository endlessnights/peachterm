// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

/** Rust enforces the same minimum (`MIN_PASSPHRASE_CHARS`); this only guides. */
export const MIN_PASSPHRASE_CHARS = 12;

export type Strength = 'empty' | 'tooShort' | 'weak' | 'fair' | 'good' | 'strong';

export interface Assessment {
  strength: Strength;
  /** 0-4, for the meter. */
  level: number;
  label: string;
  advice: string;
}

const COMMON = ['password', 'qwerty', '123456', 'letmein', 'peachterm', 'пароль', 'йцукен'];

/**
 * A rough estimate, deliberately conservative. It is advice, not a gate (the
 * only hard rule is the minimum length): real strength depends on how random
 * the phrase is, which no heuristic can measure.
 */
export function assessPassphrase(value: string): Assessment {
  const chars = [...value.normalize('NFC')];
  if (chars.length === 0) {
    return { strength: 'empty', level: 0, label: '', advice: '' };
  }
  if (chars.length < MIN_PASSPHRASE_CHARS) {
    return {
      strength: 'tooShort',
      level: 1,
      label: 'Too short',
      advice: `Use at least ${MIN_PASSPHRASE_CHARS} characters.`,
    };
  }
  const lower = value.toLowerCase();
  const distinct = new Set(chars).size;
  const pool =
    (/[a-zа-яё]/i.test(value) ? 26 : 0) +
    (/[A-ZА-ЯЁ]/.test(value) ? 26 : 0) +
    (/\d/.test(value) ? 10 : 0) +
    (/[^\p{L}\d]/u.test(value) ? 32 : 0) +
    (/[^\p{ASCII}]/u.test(value) && !/[а-яё]/i.test(value) ? 30 : 0);
  let bits = distinct * Math.log2(Math.max(pool, 2)) * 0.8 + (chars.length - distinct) * 0.5;
  if (COMMON.some((word) => lower.includes(word))) bits *= 0.5;
  if (distinct <= 3) bits = Math.min(bits, 20);
  if (bits < 40) {
    return {
      strength: 'weak',
      level: 1,
      label: 'Weak',
      advice: 'Add more words or mix in different kinds of characters.',
    };
  }
  if (bits < 60) {
    return { strength: 'fair', level: 2, label: 'Fair', advice: 'A longer phrase would be safer.' };
  }
  if (bits < 85) {
    return { strength: 'good', level: 3, label: 'Good', advice: 'Reasonably strong.' };
  }
  return { strength: 'strong', level: 4, label: 'Strong', advice: 'Strong.' };
}
