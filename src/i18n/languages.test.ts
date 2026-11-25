// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LANGUAGE,
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  detectSystemLanguage,
  isLanguage,
  matchLocale,
  normalizePreference,
  resolveLanguage,
} from './languages';

describe('system locale matching', () => {
  it.each([
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['en', 'en'],
    ['ru-RU', 'ru'],
    ['ru', 'ru'],
    ['de-CH', 'de'],
    ['de-AT', 'de'],
    ['fr-CA', 'fr'],
    ['fr-FR', 'fr'],
    ['es-MX', 'es'],
    ['es-ES', 'es'],
    ['sr-RS', 'sr-Latn'],
    ['sr-Latn-RS', 'sr-Latn'],
    ['sr-Cyrl-RS', 'sr-Latn'], // there is no Cyrillic interface: Serbian Latin is used
    ['sr_RS', 'sr-Latn'],
    ['DE-ch', 'de'],
  ])('%s -> %s', (tag, expected) => {
    expect(matchLocale(tag)).toBe(expected);
  });

  it.each(['zh-CN', 'ja-JP', 'pt-BR', 'it-IT', 'hr-HR', 'bs-BA', 'uk-UA', '', '-', 'x'])(
    'an unsupported or malformed tag (%j) does not match',
    (tag) => {
      expect(matchLocale(tag)).toBeNull();
    },
  );

  it('matches the language subtag, never a substring', () => {
    expect(matchLocale('english')).toBeNull();
    expect(matchLocale('russian')).toBeNull();
    expect(matchLocale('hu-DE')).toBeNull(); // "de" appears, but as the region
    expect(matchLocale('fil-PH')).toBeNull(); // "fil" is not "fr"
    expect(matchLocale('esu-US')).toBeNull(); // starts with "es", is not Spanish
  });

  it('takes the first supported language in the system order, else English', () => {
    expect(detectSystemLanguage(['ja-JP', 'de-DE', 'ru-RU'])).toBe('de');
    expect(detectSystemLanguage(['zh-CN', 'ja-JP'])).toBe(FALLBACK_LANGUAGE);
    expect(detectSystemLanguage([])).toBe('en');
  });
});

describe('language preference', () => {
  it('knows exactly six interface languages with native names', () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'ru', 'de', 'fr', 'es', 'sr-Latn']);
    expect(LANGUAGE_NAMES).toEqual({
      en: 'English',
      ru: 'Русский',
      de: 'Deutsch',
      fr: 'Français',
      es: 'Español',
      'sr-Latn': 'Srpski (latinica)',
    });
  });

  it('keeps valid values and turns everything else into "system"', () => {
    expect(normalizePreference('system')).toBe('system');
    for (const code of SUPPORTED_LANGUAGES) expect(normalizePreference(code)).toBe(code);
    for (const bad of ['', 'xx', 'EN', 'sr', 'sr-Cyrl', null, undefined, 7, {}, 'de-CH']) {
      expect(normalizePreference(bad)).toBe('system');
    }
    expect(isLanguage('ru')).toBe(true);
    expect(isLanguage('system')).toBe(false);
  });

  it('an explicit choice overrides the system language; "system" follows it', () => {
    expect(resolveLanguage('fr', ['ru-RU'])).toBe('fr');
    expect(resolveLanguage('system', ['ru-RU'])).toBe('ru');
    expect(resolveLanguage('system', ['sr-Cyrl-RS'])).toBe('sr-Latn');
    expect(resolveLanguage('system', ['ko-KR'])).toBe('en');
    expect(resolveLanguage('garbage', ['es-AR'])).toBe('es'); // bad value acts like "system"
  });
});
