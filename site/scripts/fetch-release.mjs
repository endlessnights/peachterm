// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Build-time lookup of the latest PUBLISHED GitHub release, written to
// src/release.json. The site never guesses file names or versions: it shows only
// what GitHub reports, and the "no release yet" message when there is none.
// No request is made from the visitor's browser.
//
//   GITHUB_REPOSITORY   "owner/repo" (set by GitHub Actions; falls back to the git remote)
//   GITHUB_TOKEN        optional, raises the API rate limit
//   SITE_OFFLINE=1      skip the lookup (offline builds)

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generated', 'release.json');

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    return /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

const repo = repository();
const base = {
  available: false,
  repo,
  repoUrl: repo ? `https://github.com/${repo}` : null,
  releasesUrl: repo ? `https://github.com/${repo}/releases` : null,
  latestUrl: repo ? `https://github.com/${repo}/releases/latest` : null,
  version: null,
  publishedAt: null,
  prerelease: false,
  assets: [],
};

async function lookup() {
  if (!repo || process.env.SITE_OFFLINE === '1') return base;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'peachterm-site-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    // "latest" never returns drafts or pre-releases; a repository without one answers 404.
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    if (res.status === 404) return base;
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = await res.json();
    return {
      ...base,
      available: true,
      version: String(r.tag_name ?? '').replace(/^v/, ''),
      publishedAt: r.published_at ?? null,
      prerelease: !!r.prerelease,
      assets: (r.assets ?? []).map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
      })),
    };
  } catch (error) {
    console.warn(`release lookup failed (${error.message}); building without release info`);
    return base;
  }
}

const info = await lookup();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
console.log(
  info.available
    ? `latest release: v${info.version} (${info.assets.length} files)`
    : 'no published release',
);
