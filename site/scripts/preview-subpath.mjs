// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Serves the BUILT site (dist/) under a sub-path, the way GitHub Pages serves a
// project site:   node scripts/preview-subpath.mjs [/peachterm/] [port]
// Build it with the same base first:   SITE_BASE=/peachterm/ npm run build

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const base = (process.argv[2] ?? '/peachterm/').replace(/\/?$/, '/');
const port = Number(process.argv[3] ?? 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404).end('Not found (this server only serves ' + base + ')');
    return;
  }
  let rel = normalize(decodeURIComponent(url.pathname.slice(base.length)));
  if (rel === '' || rel === '.') rel = 'index.html';
  const file = join(dist, rel);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`http://localhost:${port}${base}`));
