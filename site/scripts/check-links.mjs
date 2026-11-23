// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Checks the BUILT site (dist/): every local file referenced by a page exists, every
// #anchor has a target, and every image has alt text and dimensions.
//   node scripts/check-links.mjs             local checks only
//   node scripts/check-links.mjs --external  also request the external links (HEAD)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const problems = [];
// An absolute base such as "/peachterm/" (SITE_BASE) is mapped back onto dist/.
const base =
  process.env.SITE_BASE && process.env.SITE_BASE.startsWith('/') ? process.env.SITE_BASE : '';

const refs = [...html.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].flatMap((m) =>
  // srcset: "url 720w, url 1440w"
  m[0].startsWith('srcset') ? m[1].split(',').map((p) => p.trim().split(/\s+/)[0]) : [m[1]],
);
const external = new Set();
for (const ref of refs) {
  if (/^https?:\/\//.test(ref)) {
    external.add(ref);
  } else if (ref.startsWith('#')) {
    const id = ref.slice(1);
    if (id && !html.includes(`id="${id}"`)) problems.push(`missing anchor target ${ref}`);
  } else if (!/^(mailto:|data:)/.test(ref)) {
    let file = ref.split('#')[0].split('?')[0];
    if (base && file.startsWith(base)) file = file.slice(base.length);
    file = file.replace(/^\.\//, '').replace(/^\//, '');
    if (file && !existsSync(join(dist, file))) problems.push(`missing file ${ref}`);
  }
}
for (const img of html.matchAll(/<img\b[^>]*>/g)) {
  if (!/\balt="/.test(img[0])) problems.push(`image without alt: ${img[0].slice(0, 80)}`);
  if (!/\bwidth="/.test(img[0]) || !/\bheight="/.test(img[0])) {
    problems.push(`image without width/height: ${img[0].slice(0, 80)}`);
  }
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i)))
  problems.push(`duplicate id ${id}`);

if (process.argv.includes('--external')) {
  for (const url of external) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (res.status >= 400) problems.push(`external ${url} -> HTTP ${res.status}`);
    } catch (error) {
      problems.push(`external ${url} -> ${error.message}`);
    }
  }
}

console.log(`${refs.length} references checked (${external.size} external)`);
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('all links, images and anchors are fine');
