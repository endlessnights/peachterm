// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Download blocks of the page, rendered at build time from what GitHub reports
// about the latest published release (see scripts/fetch-release.mjs). Nothing
// here invents a file name or a URL.

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  available: boolean;
  repo: string | null;
  repoUrl: string | null;
  releasesUrl: string | null;
  latestUrl: string | null;
  version: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export const NO_RELEASE: ReleaseInfo = {
  available: false,
  repo: 'endlessnights/peachterm',
  repoUrl: 'https://github.com/endlessnights/peachterm',
  releasesUrl: 'https://github.com/endlessnights/peachterm/releases',
  latestUrl: 'https://github.com/endlessnights/peachterm/releases/latest',
  version: null,
  publishedAt: null,
  prerelease: false,
  assets: [],
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Which platform an installer belongs to, judged from its file name only. */
export function classify(name: string): { id: string; label: string } | null {
  const n = name.toLowerCase();
  if (n.endsWith('.exe') || n.endsWith('.msi')) return { id: 'windows', label: 'Windows (x64)' };
  if (n.endsWith('.deb')) return { id: 'linux-deb', label: 'Linux (.deb)' };
  if (n.endsWith('.appimage')) return { id: 'linux-appimage', label: 'Linux (AppImage)' };
  if (n.endsWith('.dmg')) {
    return /aarch64|arm64/.test(n)
      ? { id: 'mac-arm', label: 'macOS (Apple Silicon)' }
      : { id: 'mac-intel', label: 'macOS (Intel)' };
  }
  return null;
}

/** The two calls to action in the hero. */
export function renderHeroCta(info: ReleaseInfo): string {
  const repo = esc(info.repoUrl ?? '#');
  if (info.available && info.latestUrl) {
    const label = info.version ? `Download PeachTerm ${esc(info.version)}` : 'Download PeachTerm';
    return `<a class="btn btn-primary" href="${esc(info.latestUrl)}">${label}</a>
        <a class="btn" href="${repo}">View on GitHub</a>`;
  }
  return `<a class="btn btn-primary" href="#download">Get started</a>
        <a class="btn" href="${repo}">View on GitHub</a>`;
}

/** The download area of the Platforms section. */
export function renderDownloadPanel(info: ReleaseInfo): string {
  if (!info.available) {
    return `<div class="status-note" role="status">
          <strong>No public release yet.</strong>
          PeachTerm is in active development and installers have not been published. You can
          follow the project on <a href="${esc(info.repoUrl ?? '#')}">GitHub</a> or
          <a href="${esc(info.repoUrl ?? '#')}#building">build it from source</a>.
          Releases will appear on the <a href="${esc(info.releasesUrl ?? '#')}">releases page</a>
          and on this site automatically.
        </div>`;
  }
  const known = info.assets
    .map((a) => ({ a, c: classify(a.name) }))
    .filter((x): x is { a: ReleaseAsset; c: { id: string; label: string } } => x.c !== null)
    .sort((x, y) => x.c.id.localeCompare(y.c.id));
  const rows = known
    .map(
      ({ a, c }) =>
        `<li><span>${esc(c.label)}</span><a href="${esc(a.url)}">${esc(a.name)}</a><span class="muted">${mb(a.size)}</span></li>`,
    )
    .join('\n          ');
  const pre = info.prerelease ? ' (pre-release)' : '';
  const date = info.publishedAt ? ` · ${esc(info.publishedAt.slice(0, 10))}` : '';
  return `<div class="download-panel">
          <p><strong>PeachTerm ${esc(info.version ?? '')}${pre}</strong>${date}
          — <a href="${esc(info.latestUrl ?? '#')}">release notes and all files</a></p>
          <ul class="download-list">
          ${rows || '<li>No installers are attached to this release yet.</li>'}
          </ul>
          <p class="muted">Installers are not code-signed yet, so Windows SmartScreen and macOS
          Gatekeeper will warn on first launch.
          <a href="${esc(info.repoUrl ?? '#')}/blob/main/docs/signing.md">What this means</a>.</p>
        </div>`;
}

export function renderFooterVersion(info: ReleaseInfo): string {
  return info.available && info.version ? `<span>Latest release: v${esc(info.version)}</span>` : '';
}
