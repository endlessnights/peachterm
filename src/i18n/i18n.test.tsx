// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSettings } from '../app/dialogs';
import { useSettings } from '../features/settings/store';
import { useTabs } from '../features/sessions/store';
import { __emitSshPromptForTests } from '../shared/ipc';
import type { MockSsh } from '../shared/mockBackend';
import type { Settings } from '../shared/types';
import { conn, mountApp } from '../test/appHarness';
import { applyLanguagePreference, currentLanguage, i18n, resources, t } from './index';
import { formatDateTime, formatDecimal, formatList, formatNumber, formatPercent } from './format';
import { errorMessage } from './errors';

const withLanguage =
  (language: string) =>
  (s: Settings): Settings => ({ ...s, general: { ...s.general, language } });

afterEach(() => {
  vi.restoreAllMocks();
  applyLanguagePreference('en');
});

describe('language selection', () => {
  it('follows the system language when the preference is "system"', async () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['de-CH', 'en']);
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('de-CH');
    mountApp({ connections: [conn('a', 'alpha')] }, { settings: withLanguage('system') });
    await screen.findByRole('tree');
    expect(currentLanguage()).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    expect(screen.getByRole('complementary', { name: 'Gespeicherte Verbindungen' })).toBeTruthy();
  });

  it.each([
    ['ru-RU', 'Сохранённые подключения'],
    ['de-AT', 'Gespeicherte Verbindungen'],
    ['fr-CA', 'Connexions enregistrées'],
    ['es-MX', 'Conexiones guardadas'],
    ['sr-RS', 'Sačuvane veze'],
    ['sr-Cyrl-RS', 'Sačuvane veze'],
    ['ja-JP', 'Saved connections'],
  ])('system locale %s shows the sidebar as "%s"', async (locale, label) => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue([locale]);
    mountApp({ connections: [] }, { settings: withLanguage('system') });
    await screen.findByRole('tree');
    expect(screen.getByRole('complementary', { name: label })).toBeTruthy();
  });

  it('a manual choice beats the system language and is stored in the settings', async () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['ru-RU']);
    mountApp({ connections: [] }, { settings: withLanguage('fr') });
    await screen.findByRole('tree');
    expect(currentLanguage()).toBe('fr');
    expect(useSettings.getState().settings.general.language).toBe('fr');
  });

  it('an unknown stored value is treated as "system" and the app still starts', async () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['es-ES']);
    mountApp({ connections: [] }, { settings: withLanguage('klingon') });
    await screen.findByRole('tree');
    expect(currentLanguage()).toBe('es');
  });

  it('switching in Settings → Appearance applies at once, without a restart', async () => {
    const { backend } = mountApp({ connections: [conn('a', 'alpha')] });
    await screen.findByRole('tree');
    act(() => openSettings('appearance'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const select = within(dialog).getByLabelText('Interface language') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'System default',
      'English',
      'Русский',
      'Deutsch',
      'Français',
      'Español',
      'Srpski (latinica)',
    ]);
    fireEvent.change(select, { target: { value: 'ru' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    // the open dialog, the sidebar and the status bar all change language
    expect(await screen.findByRole('dialog', { name: 'Настройки' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Сохранённые подключения' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Применить' })).toBeTruthy();
    expect((backend as unknown as { saves: Settings[] }).saves.at(-1)?.general.language).toBe('ru');
    // back to the system default: stored as "system"
    fireEvent.change(screen.getByLabelText('Язык интерфейса'), { target: { value: 'system' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() =>
      expect((backend as unknown as { saves: Settings[] }).saves.at(-1)?.general.language).toBe(
        'system',
      ),
    );
  });

  it('keeps live sessions, tabs and user data untouched when the language changes', async () => {
    const mounted = mountApp({ connections: [conn('a', 'Mój serwer — prod')] });
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    await screen.findByRole('tree');
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('Mój serwer — prod'));
    await waitFor(() => expect(ssh.opens).toHaveLength(1));
    act(() => ssh.emit(ssh.opens[0]!.sessionId, { kind: 'status', state: 'connected' }));
    const before = useTabs.getState().tabs.map((tab) => ({ ...tab }));
    act(() => applyLanguagePreference('de'));
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Gespeicherte Verbindungen' })).toBeTruthy(),
    );
    expect(ssh.closes).toEqual([]);
    expect(useTabs.getState().tabs).toEqual(before);
    expect(useTabs.getState().tabs[0]!.status).toBe('connected');
    // names the user typed are never translated
    expect(
      within(screen.getByRole('tree')).getAllByText('Mój serwer — prod').length,
    ).toBeGreaterThan(0);
    expect(ssh.opens).toHaveLength(1); // no reconnect
  });
});

describe('security-sensitive text in every language', () => {
  const hostKey = (previous: string | null) =>
    ({
      kind: 'hostKey',
      promptId: 'p1',
      sessionId: 's1',
      host: 'srv.example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      previousFingerprint: previous,
    }) as const;

  it.each([
    ['ru', 'Ключ хоста изменился', 'Отключиться'],
    ['de', 'Hostschlüssel hat sich geändert', 'Trennen'],
    ['fr', 'La clé d’hôte a changé', 'Se déconnecter'],
    ['es', 'La clave del host ha cambiado', 'Desconectar'],
    ['sr-Latn', 'Ključ hosta se promenio', 'Prekini vezu'],
  ])(
    '%s: a changed host key is a warning and "disconnect" is the safe default',
    async (lng, title, disconnect) => {
      mountApp({ connections: [] }, { settings: withLanguage(lng) });
      await screen.findByRole('tree');
      act(() => __emitSshPromptForTests(hostKey('SHA256:old')));
      expect(await screen.findByText(title)).toBeTruthy();
      // technical data is shown exactly as it is
      expect(screen.getByText('SHA256:abc')).toBeTruthy();
      expect(screen.getByText('SHA256:old')).toBeTruthy();
      expect(screen.getByRole('button', { name: disconnect }).hasAttribute('data-autofocus')).toBe(
        true,
      );
      expect(screen.getByText(/srv\.example\.com:22/)).toBeTruthy(); // host and port are not translated
    },
  );

  it('every language says the lock password is never recoverable by PeachTerm', () => {
    for (const lng of ['en', 'ru', 'de', 'fr', 'es', 'sr-Latn'] as const) {
      expect(i18n.getFixedT(lng)('port.backup.lostWarn').length).toBeGreaterThan(20);
      expect(i18n.getFixedT(lng)('errors.lock.wrong').length).toBeGreaterThan(5);
      expect(i18n.getFixedT(lng)('port.restore.replaceConfirm').length).toBeGreaterThan(10);
    }
  });
});

describe('translation behaviour', () => {
  it('falls back to English for a key a language does not have', async () => {
    expect(i18n.options.fallbackLng).toEqual(['en']);
    // same configuration, with a partial Russian bundle, on a separate instance
    const instance = i18n.createInstance();
    await instance.init({
      resources: {
        en: { translation: { only: 'English only', both: 'English' } },
        ru: { translation: { both: 'Русский' } },
      },
      lng: 'ru',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
    const tt = instance.t.bind(instance) as unknown as (key: string) => string;
    expect(tt('both')).toBe('Русский');
    expect(tt('only')).toBe('English only');
    expect(tt('missing.everywhere')).toBe('missing.everywhere');
  });

  it('interpolates values instead of concatenating', () => {
    expect(i18n.getFixedT('de')('sftp.createdIn', { dir: '/var/www' })).toBe(
      'Wird erstellt in /var/www',
    );
    expect(i18n.getFixedT('fr')('tabs.closeNamed', { title: 'prod <1>' })).toBe(
      'Fermer prod <1>', // values are text, never markup
    );
  });

  it('uses the correct plural forms for Russian', () => {
    const ru = i18n.getFixedT('ru');
    expect(ru('conn.menu.deleteMany', { count: 1 })).toBe('Удалить 1 элемент…');
    expect(ru('conn.menu.deleteMany', { count: 2 })).toBe('Удалить 2 элемента…');
    expect(ru('conn.menu.deleteMany', { count: 5 })).toBe('Удалить 5 элементов…');
    expect(ru('conn.menu.deleteMany', { count: 11 })).toBe('Удалить 11 элементов…');
    expect(ru('conn.menu.deleteMany', { count: 21 })).toBe('Удалить 21 элемент…');
    expect(ru('conn.menu.deleteMany', { count: 22 })).toBe('Удалить 22 элемента…');
    expect(ru('conn.menu.deleteMany', { count: 25 })).toBe('Удалить 25 элементов…');
  });

  it('uses the correct plural forms for Serbian (Latin)', () => {
    const sr = i18n.getFixedT('sr-Latn');
    expect(sr('conn.menu.deleteMany', { count: 1 })).toBe('Obriši 1 stavku…');
    expect(sr('conn.menu.deleteMany', { count: 3 })).toBe('Obriši 3 stavke…');
    expect(sr('conn.menu.deleteMany', { count: 5 })).toBe('Obriši 5 stavki…');
    expect(sr('conn.menu.deleteMany', { count: 11 })).toBe('Obriši 11 stavki…');
    expect(sr('conn.menu.deleteMany', { count: 21 })).toBe('Obriši 21 stavku…');
    expect(sr('conn.menu.deleteMany', { count: 24 })).toBe('Obriši 24 stavke…');
  });

  it('English, German, French and Spanish use one/other (and French/Spanish large numbers)', () => {
    expect(i18n.getFixedT('en')('conn.menu.deleteMany', { count: 1 })).toBe('Delete 1 item…');
    expect(i18n.getFixedT('en')('conn.menu.deleteMany', { count: 2 })).toBe('Delete 2 items…');
    expect(i18n.getFixedT('de')('conn.menu.deleteMany', { count: 2 })).toBe('2 Elemente löschen …');
    expect(i18n.getFixedT('fr')('conn.menu.deleteMany', { count: 0 })).toBe('Supprimer 0 élément…');
    expect(i18n.getFixedT('fr')('conn.menu.deleteMany', { count: 2 })).toBe(
      'Supprimer 2 éléments…',
    );
    expect(i18n.getFixedT('es')('conn.menu.deleteMany', { count: 1_000_000 })).toBe(
      'Eliminar 1000000 elementos…',
    );
  });

  it('every language ships exactly the keys English has (no free-form dictionaries)', () => {
    const flat = (o: object, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? flat(v, `${p}${k}.`) : [`${p}${k}`],
      );
    const baseOf = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '');
    const bases = (lng: keyof typeof resources) =>
      new Set(flat(resources[lng].translation).map(baseOf));
    const en = bases('en');
    for (const lng of ['ru', 'de', 'fr', 'es', 'sr-Latn'] as const) {
      expect([...bases(lng)].sort(), lng).toEqual([...en].sort());
    }
  });
});

describe('locale-aware formatting', () => {
  it('formats numbers, percentages, lists and dates with the interface language', () => {
    applyLanguagePreference('de');
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(formatDecimal(39.2)).toBe('39,2');
    expect(formatList(['a', 'b', 'c'])).toBe('a, b und c');
    expect(formatDateTime(Date.UTC(2026, 0, 5, 12, 0))).toMatch(/2026/);
    applyLanguagePreference('en');
    expect(formatNumber(1234.5)).toBe('1,234.5');
    expect(formatDecimal(39.2)).toBe('39.2');
    expect(formatPercent(18)).toBe('18%');
    expect(formatList(['a', 'b', 'c'])).toBe('a, b, and c');
    applyLanguagePreference('fr');
    expect(formatDecimal(39.2)).toBe('39,2');
    applyLanguagePreference('sr-Latn');
    expect(formatDecimal(39.2)).toBe('39,2');
    expect(formatList(['a', 'b'])).toBe('a i b');
  });

  it('keeps machine data exactly as it is', () => {
    applyLanguagePreference('ru');
    expect(t('sftp.createdIn', { dir: '/srv/www-data/ключ' })).toBe(
      'Будет создано в /srv/www-data/ключ',
    );
    expect(t('tunnels.otherTab', { state: '127.0.0.1:8080' })).toContain('127.0.0.1:8080');
  });
});

describe('backend errors', () => {
  it('translates stable keys and parameters, never message text', () => {
    applyLanguagePreference('de');
    expect(
      errorMessage({
        code: 'validation',
        message: 'The lock password must have at least 8 characters.',
        key: 'lock.minLength',
        params: { min: '8' },
      }),
    ).toBe('Das Sperrpasswort muss mindestens 8 Zeichen haben.');
    expect(errorMessage({ code: 'remote', message: 'x', token: 'permission_denied' })).toBe(
      'Zugriff auf dem Server verweigert.',
    );
    expect(errorMessage({ code: 'locked', message: 'PeachTerm is locked' })).toBe(
      'PeachTerm ist gesperrt. Entsperren Sie es zuerst.',
    );
    expect(errorMessage({ code: 'not_found', message: 'session was not found' })).toBe(
      'Die Sitzung wurde nicht gefunden.',
    );
  });

  it('shows the English text for anything that has no key, and keeps technical detail', () => {
    applyLanguagePreference('ru');
    expect(errorMessage({ code: 'storage', message: 'invalid data file: EOF at line 3' })).toBe(
      'invalid data file: EOF at line 3',
    );
    expect(errorMessage({ code: 'validation', message: 'Something new', key: 'no.such.key' })).toBe(
      'Something new',
    );
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain text')).toBe('plain text');
  });

  it('never puts an error with an unknown token into the interface as a key', () => {
    applyLanguagePreference('fr');
    expect(
      errorMessage({
        code: 'remote',
        message: 'The update could not be downloaded.',
        token: 'zzz',
      }),
    ).toBe('The update could not be downloaded.');
  });
});
