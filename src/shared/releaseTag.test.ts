// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const run = (...args: string[]) =>
  spawnSync('node', ['scripts/check-release-version.mjs', ...args], { encoding: 'utf8' });
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

describe('release version guard', () => {
  it('all version files agree and the current tag is accepted', () => {
    const out = execFileSync('node', ['scripts/check-release-version.mjs', `v${version}`], {
      encoding: 'utf8',
    });
    expect(out).toContain(`version=${version}`);
  });

  it('refuses a tag that differs from the application version', () => {
    const r = run('v99.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match/);
  });

  it.each([
    '0.1.0',
    'v1',
    'v1.2',
    'v1.2.3.4',
    'v01.2.3',
    'v1.2.3-gamma.1',
    'v1.2.3-rc',
    'v1.2.3+x',
    '',
  ])('refuses the malformed tag %j', (tag) => {
    const r = run(tag);
    expect(r.status).toBe(1);
  });
});
