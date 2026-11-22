// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Release guard: checks that a Git tag is a valid version tag and that it matches
// the version in every place PeachTerm keeps one.
//
//   node scripts/check-release-version.mjs v0.1.0          # validate a tag
//   node scripts/check-release-version.mjs                 # only check the files agree
//
// Prints `version=...` and `prerelease=true|false` (also written to $GITHUB_OUTPUT).

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// vMAJOR.MINOR.PATCH with an optional -alpha.N / -beta.N / -rc.N suffix.
export const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/;

export function versions() {
  const cargoToml = read('src-tauri/Cargo.toml');
  const cargoLock = read('src-tauri/Cargo.lock');
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'package-lock.json': JSON.parse(read('package-lock.json')).version,
    'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
    'src-tauri/Cargo.toml': /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1],
    'src-tauri/Cargo.lock': /name = "peachterm"\nversion = "([^"]+)"/.exec(cargoLock)?.[1],
  };
}

export function check(tag) {
  const found = versions();
  const distinct = new Set(Object.values(found));
  if (distinct.size !== 1 || distinct.has(undefined)) {
    return { ok: false, error: `Version files disagree: ${JSON.stringify(found, null, 2)}` };
  }
  const [version] = distinct;
  if (tag === undefined) return { ok: true, version, prerelease: version.includes('-') };
  const m = TAG.exec(tag);
  if (!m) {
    return {
      ok: false,
      error: `"${tag}" is not a valid release tag (expected vX.Y.Z, vX.Y.Z-alpha.N, -beta.N or -rc.N).`,
    };
  }
  if (tag !== `v${version}`) {
    return { ok: false, error: `Tag ${tag} does not match the application version ${version}.` };
  }
  return { ok: true, version, prerelease: m[4] !== undefined };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = check(process.argv[2]);
  if (!result.ok) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }
  const lines = [`version=${result.version}`, `prerelease=${result.prerelease}`];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
}
