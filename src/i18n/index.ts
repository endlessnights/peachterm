// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ru from './locales/ru.json';
import srLatn from './locales/sr-Latn.json';
import {
  FALLBACK_LANGUAGE,
  normalizePreference,
  resolveLanguage,
  systemLocales,
  type Language,
} from './languages';

export * from './languages';

export const resources = {
  en: { translation: en },
  ru: { translation: ru },
  de: { translation: de },
  fr: { translation: fr },
  es: { translation: es },
  'sr-Latn': { translation: srLatn },
} as const;

const STORAGE_KEY = 'peachterm.language';

/** Last chosen preference, kept locally so the lock screen and start-up use it before settings load. */
function storedPreference(): unknown {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'system';
  } catch {
    return 'system';
  }
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(storedPreference(), systemLocales()),
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: Object.keys(resources),
  // Translations are plain text: React escapes on render, never HTML.
  interpolation: { escapeValue: false },
  returnNull: false,
  initImmediate: false,
  showSupportNotice: false,
  react: { useSuspense: false },
});

/** Applies the stored preference immediately, with no restart and no remount. */
export function applyLanguagePreference(preference: unknown): Language {
  const language = resolveLanguage(preference, systemLocales());
  try {
    localStorage.setItem(STORAGE_KEY, String(normalizePreference(preference)));
  } catch {
    // Storage may be unavailable; the preference still lives in settings.
  }
  if (i18n.language !== language) void i18n.changeLanguage(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  return language;
}

export function currentLanguage(): Language {
  return (i18n.language as Language) || FALLBACK_LANGUAGE;
}

export { i18n };
export const t = i18n.t.bind(i18n);
