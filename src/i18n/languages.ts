// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

/** Interface languages shipped with PeachTerm. English is the source and the fallback. */
export const SUPPORTED_LANGUAGES = ['en', 'ru', 'de', 'fr', 'es', 'sr-Latn'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** What the user can store: a fixed language or "follow the system". */
export type LanguagePreference = 'system' | Language;

export const FALLBACK_LANGUAGE: Language = 'en';

/**
 * Native names, deliberately not translated: a user who cannot read the current
 * interface language must still be able to find their own.
 */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  'sr-Latn': 'Srpski (latinica)',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Anything unknown or empty becomes `system`: old files and bad backups stay valid. */
export function normalizePreference(value: unknown): LanguagePreference {
  return value === 'system' || isLanguage(value) ? value : 'system';
}

/**
 * Maps one BCP 47 tag (`de-CH`, `sr-Cyrl-RS`, `fr_CA`, `zh`) to a supported
 * language, or null. Matches on the parsed primary subtag only, never on
 * substrings. Serbian in any script maps to the Latin interface; there is no
 * Cyrillic translation.
 */
export function matchLocale(tag: string): Language | null {
  const primary = tag.trim().replace(/_/g, '-').split('-')[0]?.toLowerCase() ?? '';
  switch (primary) {
    case 'en':
    case 'ru':
    case 'de':
    case 'fr':
    case 'es':
      return primary;
    case 'sr':
      return 'sr-Latn';
    default:
      return null;
  }
}

/** First supported language in the system's preference order, else English. */
export function detectSystemLanguage(locales: readonly string[]): Language {
  for (const tag of locales) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return FALLBACK_LANGUAGE;
}

export function resolveLanguage(preference: unknown, systemLocales: readonly string[]): Language {
  const p = normalizePreference(preference);
  return p === 'system' ? detectSystemLanguage(systemLocales) : p;
}

export function systemLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];
}
