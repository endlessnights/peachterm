// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Validates the interface translations. Runs offline (no translation service):
//   npm run i18n:check
//
// It fails when a locale file is invalid JSON or has a duplicate key, when a
// locale misses or invents a key, when a value is empty, when interpolation
// placeholders or markup differ from English, when plural forms are incomplete
// for the language, when a key is no longer used by the application, or when a
// translation could inject markup. It also guards the scripts (no Cyrillic in
// Latin-script locales, no Latin-only Russian) and `dangerouslySetInnerHTML`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = join(root, 'src', 'i18n', 'locales');
const srcDir = join(root, 'src');

export const LOCALES = ['en', 'ru', 'de', 'fr', 'es', 'sr-Latn'];
const SOURCE = 'en';
const ALLOWED_TAGS = new Set(['strong', 'kbd', 'name']);

const errors = [];
const fail = (locale, message) => errors.push(`${locale}: ${message}`);

/** Parses JSON and reports duplicate keys (JSON.parse silently keeps the last one). */
export function parseStrict(text, file) {
  let i = 0;
  const problems = [];
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  const str = () => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i));
  };
  const value = (path) => {
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const seen = new Set();
      const out = {};
      ws();
      if (text[i] === '}') {
        i += 1;
        return out;
      }
      for (;;) {
        ws();
        const key = str();
        if (seen.has(key)) problems.push(`duplicate key "${[...path, key].join('.')}"`);
        seen.add(key);
        ws();
        i += 1; // :
        out[key] = value([...path, key]);
        ws();
        if (text[i] === ',') i += 1;
        else break;
      }
      ws();
      i += 1; // }
      return out;
    }
    if (c === '"') return str();
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?|^true|^false|^null/.exec(text.slice(i));
    if (!m) throw new SyntaxError(`unexpected token at ${i}`);
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  let parsed;
  try {
    parsed = value([]);
    ws();
    if (i < text.length) throw new SyntaxError('trailing data');
  } catch (e) {
    problems.push(`invalid JSON in ${file}: ${e.message}`);
    parsed = {};
  }
  return { parsed, problems };
}

/** Flattens nested objects to dotted keys. */
export function flatten(object, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') Object.assign(out, flatten(value, path));
    else out[path] = value;
  }
  return out;
}

const placeholders = (text) => [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
const tags = (text) =>
  [...text.matchAll(/<\/?([A-Za-z][\w-]*)\s*\/?>/g)].map((m) => m[0].replace(/\s+/g, ''));

export function splitPlural(key) {
  const m = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
  return m ? { base: m[1], form: m[2] } : { base: key, form: null };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'locales') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'i18next.d.ts') {
      out.push(full);
    }
  }
  return out;
}

export function run() {
  const data = {};
  for (const locale of LOCALES) {
    const file = join(localesDir, `${locale}.json`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      fail(locale, `missing file ${relative(root, file)}`);
      continue;
    }
    const { parsed, problems } = parseStrict(text, relative(root, file));
    problems.forEach((p) => fail(locale, p));
    data[locale] = flatten(parsed);
  }
  const en = data[SOURCE];
  if (!en) return errors;
  const enKeys = Object.keys(en);

  for (const locale of LOCALES) {
    const flat = data[locale];
    if (!flat) continue;
    const keys = new Set(Object.keys(flat));
    for (const key of enKeys) {
      const { base, form } = splitPlural(key);
      // Plural forms are checked per language below; every other key must exist.
      if (!form && !keys.has(key)) fail(locale, `missing key "${key}"`);
      if (form && !Object.keys(flat).some((k) => splitPlural(k).base === base)) {
        fail(locale, `missing plural key "${base}"`);
      }
    }
    for (const key of keys) {
      const { base, form } = splitPlural(key);
      if (!form && !(key in en)) fail(locale, `unexpected key "${key}" (not in ${SOURCE})`);
      if (form && !enKeys.some((k) => splitPlural(k).base === base)) {
        fail(locale, `unexpected plural key "${base}" (not in ${SOURCE})`);
      }
    }
    const latinScript = locale !== 'ru';
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== 'string') {
        fail(locale, `"${key}" must be a string`);
        continue;
      }
      if (value.trim() === '') fail(locale, `empty value for "${key}"`);
      // Markup: only the few tags the interface knows, balanced, and the same as English.
      for (const tag of tags(value)) {
        const name = tag.replace(/[</>]/g, '');
        if (!ALLOWED_TAGS.has(name)) fail(locale, `"${key}" contains an unsupported tag ${tag}`);
      }
      if (/[<>]/.test(value.replace(/<\/?(strong|kbd|name)>/g, ''))) {
        fail(locale, `"${key}" contains markup characters outside the allowed tags`);
      }
      if (/javascript:|on\w+\s*=|<script/i.test(value)) fail(locale, `"${key}" looks like script`);
      if (value.split('{{').length !== value.split('}}').length) {
        fail(locale, `"${key}" has unbalanced {{ }}`);
      }
      if (latinScript && /[Ѐ-ӿ]/.test(value)) {
        fail(locale, `"${key}" contains Cyrillic in a Latin-script locale`);
      }
    }

    // Placeholders and tags must match English (per key; per plural group by union).
    const groups = new Map();
    for (const [key, value] of Object.entries(en)) {
      const { base } = splitPlural(key);
      const g = groups.get(base) ?? { ph: new Set(), tg: new Set(), plural: false };
      placeholders(value).forEach((p) => g.ph.add(p));
      tags(value).forEach((t) => g.tg.add(t));
      if (splitPlural(key).form) g.plural = true;
      groups.set(base, g);
    }
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== 'string') continue;
      const { base, form } = splitPlural(key);
      const g = groups.get(base);
      if (!g) continue;
      const have = new Set(placeholders(value));
      for (const p of have) {
        if (!g.ph.has(p)) fail(locale, `"${key}" uses {{${p}}}, which English does not`);
      }
      // A plural form may spell the singular out ("One folder") instead of using {{count}}.
      const required = form
        ? form === 'one'
          ? []
          : [...g.ph].filter((p) => p === 'count')
        : [...g.ph];
      for (const p of required) {
        if (!have.has(p)) fail(locale, `"${key}" lacks {{${p}}}`);
      }
      const haveTags = new Set(tags(value));
      for (const t of g.tg) {
        if (!haveTags.has(t) && !(form && !haveTags.size)) {
          fail(locale, `"${key}" lacks ${t}`);
        }
      }
    }

    // Plural completeness for this language.
    const needed = new Intl.PluralRules(locale === 'sr-Latn' ? 'sr-Latn' : locale).resolvedOptions()
      .pluralCategories;
    const bases = new Set([...keys].map((k) => splitPlural(k).base));
    for (const base of bases) {
      const forms = [...keys]
        .map(splitPlural)
        .filter((k) => k.base === base && k.form)
        .map((k) => k.form);
      if (forms.length === 0) continue;
      for (const category of needed) {
        if (!forms.includes(category))
          fail(locale, `plural "${base}" lacks the "${category}" form`);
      }
      for (const form of forms) {
        if (!needed.includes(form) && form !== 'other') {
          fail(locale, `plural "${base}" has a "${form}" form this language does not use`);
        }
      }
    }
  }

  // Unused keys: every key must be referenced by the application.
  const files = walk(srcDir);
  const code = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const literals = new Set(
    [...code.matchAll(/['"`]([A-Za-z][\w]*(?:\.[\w]+)+)['"`]/g)].map((m) => m[1]),
  );
  const dynamic = [...code.matchAll(/`([A-Za-z][\w]*(?:\.[\w]+)*\.)\$\{/g)].map((m) => m[1]);
  const dynamicPrefix = [...code.matchAll(/['"]([A-Za-z][\w]*(?:\.[\w]+)*\.)['"]\s*\+/g)].map(
    (m) => m[1],
  );
  const prefixes = [...dynamic, ...dynamicPrefix];
  // Keys the backend names (see src-tauri/src/**): `errors.<key>` / `errors.remote.<token>`.
  const rustFiles = [];
  const rustDir = join(root, 'src-tauri', 'src');
  const walkRust = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkRust(full);
      else if (name.endsWith('.rs')) rustFiles.push(full);
    }
  };
  try {
    walkRust(rustDir);
  } catch {
    // No backend sources available: skip the backend-key cross-check.
  }
  const rustKeys = new Set();
  for (const f of rustFiles) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/"([a-z][A-Za-z]*\.[A-Za-z]+)"/g)) rustKeys.add(`errors.${m[1]}`);
  }
  const used = (base) =>
    literals.has(base) ||
    prefixes.some((p) => base.startsWith(p)) ||
    rustKeys.has(base) ||
    base.startsWith('errors.remote.') ||
    base.startsWith('errors.what.');
  const bases = new Set(enKeys.map((k) => splitPlural(k).base));
  for (const base of bases) {
    if (!used(base)) fail(SOURCE, `unused key "${base}" (not referenced by the application)`);
  }

  // No unsafe HTML in the sources.
  for (const f of files) {
    if (/dangerouslySetInnerHTML/.test(readFileSync(f, 'utf8'))) {
      if (!/doc\/|DocView/.test(f)) fail('src', `dangerouslySetInnerHTML in ${relative(root, f)}`);
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = run();
  if (problems.length > 0) {
    console.error(`i18n:check found ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 200)) console.error(`  - ${p}`);
    if (problems.length > 200) console.error(`  … and ${problems.length - 200} more`);
    process.exit(1);
  }
  console.log(`i18n:check OK (${LOCALES.length} locales)`);
}
