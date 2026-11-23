// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import {
  NO_RELEASE,
  renderDownloadPanel,
  renderFooterVersion,
  renderHeroCta,
  type ReleaseInfo,
} from './src/download.ts';

// The site works at any address because every asset URL is relative ("./").
//   SITE_BASE  optional: an absolute base such as "/peachterm/" (default "./")
//   SITE_URL   optional: the public address, e.g. "https://endlessnights.github.io/peachterm/".
//              Only used for the canonical link and the social-sharing image, which
//              must be absolute URLs. Leave it empty to omit them (local builds).
const base = process.env.SITE_BASE || './';
const siteUrl = (process.env.SITE_URL || '').replace(/\/?$/, '/');

/** The latest published release as written by scripts/fetch-release.mjs (or "none"). */
function releaseInfo(): ReleaseInfo {
  const file = new URL('./src/generated/release.json', import.meta.url);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ReleaseInfo) : NO_RELEASE;
}

/** Fills the download areas of index.html at build time: no client-side request, no guessing. */
function downloadBlocks(): Plugin {
  return {
    name: 'peachterm-download-blocks',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const info = releaseInfo();
        return html
          .replace('<!--HERO_CTA-->', renderHeroCta(info))
          .replace('<!--DOWNLOAD_PANEL-->', renderDownloadPanel(info))
          .replace('<!--FOOTER_VERSION-->', renderFooterVersion(info))
          .replaceAll('<!--REPO_URL-->', info.repoUrl ?? NO_RELEASE.repoUrl ?? '');
      },
    },
  };
}

function absoluteMeta(): Plugin {
  return {
    name: 'peachterm-absolute-meta',
    transformIndexHtml() {
      if (siteUrl === '/') return [];
      return [
        { tag: 'link', attrs: { rel: 'canonical', href: siteUrl }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:url', content: siteUrl }, injectTo: 'head' },
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: `${siteUrl}og.png` },
          injectTo: 'head',
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:image', content: `${siteUrl}og.png` },
          injectTo: 'head',
        },
      ];
    },
  };
}

export default defineConfig({
  base,
  plugins: [downloadBlocks(), absoluteMeta()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
