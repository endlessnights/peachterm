// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import definitions from '../shared/shortcutDefaults.json';
import { reservedText } from '../shared/shortcuts';
import { i18n } from './index';

const script = ['..', '..', 'scripts', 'i18n-check.mjs'].join('/');

type Checker = {
  parseStrict: (text: string, file: string) => { parsed: unknown; problems: string[] };
  flatten: (o: object) => Record<string, string>;
  splitPlural: (k: string) => { base: string; form: string | null };
  run: () => string[];
};
const load = async () => (await import(/* @vite-ignore */ script)) as Checker;

describe('npm run i18n:check', () => {
  it('passes for the translations that ship', async () => {
    const { run } = await load();
    expect(run()).toEqual([]);
  });

  it('runs as a command and exits cleanly', () => {
    const out = execFileSync('node', ['scripts/i18n-check.mjs'], { encoding: 'utf8' });
    expect(out).toContain('i18n:check OK');
  });

  it('reports duplicate keys and invalid JSON', async () => {
    const { parseStrict } = await load();
    expect(parseStrict('{"a":1,"a":2}', 'x.json').problems).toEqual(['duplicate key "a"']);
    expect(parseStrict('{"a":{"b":"1","b":"2"}}', 'x.json').problems).toEqual([
      'duplicate key "a.b"',
    ]);
    expect(parseStrict('{"a": ', 'x.json').problems[0]).toMatch(/invalid JSON/);
    expect(parseStrict('{"a":"1","b":{"c":"2"}}', 'x.json').problems).toEqual([]);
  });

  it('understands plural suffixes', async () => {
    const { splitPlural } = await load();
    expect(splitPlural('exit.ssh_few')).toEqual({ base: 'exit.ssh', form: 'few' });
    expect(splitPlural('exit.ssh')).toEqual({ base: 'exit.ssh', form: null });
  });
});

describe('no translation text can be turned into markup', () => {
  it('only the known tags appear in any language', () => {
    const allowed = /^(strong|kbd|name)$/;
    for (const lng of ['en', 'ru', 'de', 'fr', 'es', 'sr-Latn']) {
      const bundle = i18n.getResourceBundle(lng, 'translation') as Record<string, unknown>;
      const walk = (o: unknown, path: string) => {
        if (typeof o === 'string') {
          for (const m of o.matchAll(/<\/?([A-Za-z][\w-]*)\s*\/?>/g)) {
            expect(m[1], `${lng}:${path}`).toMatch(allowed);
          }
          expect(o.replace(/<\/?(strong|kbd|name)>/g, ''), `${lng}:${path}`).not.toMatch(/[<>]/);
        } else if (o && typeof o === 'object') {
          for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
        }
      };
      walk(bundle, '');
    }
  });
});

describe('reserved shortcut reasons', () => {
  it('every reason in the shared definitions is translated', () => {
    const reasons = [...definitions.reserved, ...definitions.reservedMac].map((r) => r.reason);
    for (const lng of ['ru', 'de', 'fr', 'es', 'sr-Latn']) {
      void i18n.changeLanguage(lng);
      for (const reason of reasons) {
        expect(reservedText(reason), `${lng}: ${reason}`).not.toBe(reason);
      }
    }
    void i18n.changeLanguage('en');
  });
});
