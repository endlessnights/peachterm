// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { ENDPOINT, buildConfig, validatePubkey } from '../../scripts/updater-config.mjs';

// A made-up value with the SHAPE of a minisign public key file (never a real key).
const FAKE_PUB = Buffer.from(
  'untrusted comment: minisign public key: 0123456789ABCDEF\nRWQFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEF\n',
).toString('base64');
const FAKE_SECRET = Buffer.from(
  'untrusted comment: rsign encrypted secret key\nRWRTY0Iy' + 'x'.repeat(80) + '\n',
).toString('base64');

const read = (path: string) => readFileSync(path, 'utf8');

describe('signed update configuration', () => {
  it('builds an HTTPS-only overlay that carries the PUBLIC key and turns on updater artifacts', () => {
    const config = buildConfig(FAKE_PUB);
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.plugins.updater.pubkey).toBe(FAKE_PUB);
    expect(config.plugins.updater.endpoints).toEqual([ENDPOINT]);
    expect(ENDPOINT.startsWith('https://github.com/endlessnights/peachterm/releases/')).toBe(true);
    expect(JSON.stringify(config)).not.toMatch(/http:\/\//);
  });

  it('refuses an empty key, garbage, and a private key', () => {
    expect(() => validatePubkey('')).toThrow(/empty/);
    expect(() => validatePubkey('not a key!')).toThrow();
    expect(() => validatePubkey(FAKE_SECRET)).toThrow(/PUBLIC key/);
  });

  it('the script prints the overlay from the environment and fails without a key', () => {
    const ok = spawnSync('node', ['scripts/updater-config.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, TAURI_UPDATER_PUBKEY: FAKE_PUB },
    });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).plugins.updater.pubkey).toBe(FAKE_PUB);
    const missing = spawnSync('node', ['scripts/updater-config.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, TAURI_UPDATER_PUBKEY: '' },
    });
    expect(missing.status).toBe(1);
  });

  it('the committed application config has no updater key, no insecure transport and no secrets', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      plugins?: Record<string, unknown>;
      bundle: Record<string, unknown>;
    };
    // Official builds add the public key through the release workflow; a source build
    // therefore has no update source at all (it cannot install unverified code).
    expect(conf.plugins?.updater).toBeUndefined();
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
    const text = read('src-tauri/tauri.conf.json');
    expect(text).not.toMatch(/dangerousInsecureTransportProtocol/i);
    expect(text).not.toMatch(/PRIVATE KEY|secret key/i);
  });

  it('the release workflow signs only with secrets, never prints them, and stays opt-in', () => {
    const wf = read('.github/workflows/release.yml');
    expect(wf).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY');
    expect(wf).toContain('vars.TAURI_UPDATER_PUBKEY');
    expect(wf).toContain('scripts/updater-config.mjs');
    // no step echoes or cats the key
    expect(wf).not.toMatch(/echo[^\n]*(\$TAURI_SIGNING_PRIVATE_KEY|\$\{\{\s*secrets\.)/);
    expect(wf).not.toMatch(/cat[^\n]*(\$TAURI_SIGNING_PRIVATE_KEY|\$\{\{\s*secrets\.)/);
    // the key is only handed to the build step as an environment variable
    expect(wf).toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  });

  it('private key files can never be committed by accident', () => {
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/\*\.key/);
    expect(ignore).toMatch(/\.tauri/);
  });
});
