// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  fitZoom,
  parseHtml,
  parseInline,
  parseMarkdown,
  plainText,
  safeLink,
  type Block,
  type Inline,
} from './doc';

const kinds = (blocks: Block[]) => blocks.map((b) => b.t);

/** Every link and every piece of text found anywhere in a tree. */
function walkInline(list: Inline[], out: { links: string[]; text: string[] }) {
  for (const i of list) {
    if (i.t === 'link') out.links.push(i.href);
    if (i.t === 'text' || i.t === 'code') out.text.push(i.v);
    if (i.t === 'em' || i.t === 'strong' || i.t === 'link') walkInline(i.c, out);
  }
}
function collect(blocks: Block[], out = { links: [] as string[], text: [] as string[] }) {
  for (const b of blocks) {
    if (b.t === 'heading' || b.t === 'p') walkInline(b.c, out);
    if (b.t === 'code') out.text.push(b.v);
    if (b.t === 'list') b.items.forEach((item) => collect(item, out));
    if (b.t === 'quote') collect(b.c, out);
    if (b.t === 'details') {
      walkInline(b.summary, out);
      collect(b.c, out);
    }
    if (b.t === 'table') {
      [b.head, ...b.rows].forEach((row) => row.forEach((cell) => walkInline(cell, out)));
    }
  }
  return out;
}

describe('safe links', () => {
  it('allows http(s), mailto and in-page anchors only', () => {
    expect(safeLink('https://example.com/a?b=c')).toEqual({
      kind: 'external',
      url: 'https://example.com/a?b=c',
    });
    expect(safeLink('http://example.com')?.kind).toBe('external');
    expect(safeLink('mailto:ops@example.com')?.kind).toBe('external');
    expect(safeLink('#install')).toEqual({ kind: 'anchor', id: 'install' });
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'vbscript:x',
      'ssh://root@host',
      'tauri://localhost',
      'ipc://x',
      '/relative/path',
      'relative.md',
      'https://user:pw@example.com/',
      'https://exa\nmple.com',
      '',
      '#',
    ]) {
      expect(safeLink(bad), bad).toBeNull();
    }
  });
});

describe('Markdown', () => {
  it('reads headings, paragraphs, lists, tables, quotes, rules and fenced code', () => {
    const md = [
      '# Proxmox commands',
      '',
      'Intro with `inline code`, **bold** and *italic*.',
      '',
      '- first',
      '- second',
      '  - nested',
      '',
      '1. one',
      '2. two',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| a | `b` |',
      '',
      '> quoted',
      '',
      '---',
      '',
      '```bash',
      'vps-ip-pool list   # not **bold**',
      '```',
    ].join('\n');
    const blocks = parseMarkdown(md);
    expect(kinds(blocks)).toEqual(['heading', 'p', 'list', 'list', 'table', 'quote', 'hr', 'code']);
    const h = blocks[0]!;
    expect(h.t === 'heading' && h.id).toBe('proxmox-commands');
    const bullets = blocks[2]!;
    expect(bullets.t === 'list' && bullets.items).toHaveLength(2);
    expect(bullets.t === 'list' && bullets.items[1]!.map((b) => b.t)).toEqual(['p', 'list']);
    const table = blocks[4]!;
    expect(table.t === 'table' && table.head.map(plainText)).toEqual(['Name', 'Value']);
    expect(table.t === 'table' && table.rows[0]!.map(plainText)).toEqual(['a', 'b']);
    const code = blocks[7]!;
    expect(code.t === 'code' && code.lang).toBe('bash');
    expect(code.t === 'code' && code.v).toBe('vps-ip-pool list   # not **bold**');
  });

  it('keeps code blocks verbatim, long lines intact, and an unclosed fence to the end', () => {
    const long = `ssh -o StrictHostKeyChecking=no root@host '${'x'.repeat(500)}'`;
    const [block] = parseMarkdown('```\n' + long + '\n');
    expect(block).toEqual({ t: 'code', lang: '', v: long });
    const [html] = parseMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html!.t === 'code' && html!.v).toBe('<script>alert(1)</script>');
  });

  it('shows raw HTML as plain text and never as markup', () => {
    const blocks = parseMarkdown(
      [
        '<script>alert(1)</script>',
        '',
        '<img src=x onerror=alert(1)>',
        '',
        'text <b onclick="x()">b</b> <iframe src="https://evil.example"></iframe>',
      ].join('\n'),
    );
    const { text, links } = collect(blocks);
    expect(links).toEqual([]);
    expect(text.join('|')).toContain('<script>alert(1)</script>');
    expect(text.join('|')).toContain('<img src=x onerror=alert(1)>');
    // every tree node is one of the known kinds, so nothing can become an element but ours
    for (const b of blocks) expect(['p', 'code', 'heading']).toContain(b.t);
  });

  it('turns only safe addresses into links; the rest is text, and images are never loaded', () => {
    const inline = parseInline(
      '[ok](https://example.com) [bad](javascript:alert(1)) [rel](./x.md) ![logo](https://t.example/p.png) <https://auto.example> [a](#top)',
    );
    const { links, text } = collect([{ t: 'p', c: inline }]);
    expect(links).toEqual(['https://example.com', 'https://auto.example', '#top']);
    const all = text.join('');
    expect(all).toContain('bad');
    expect(all).toContain('rel');
    expect(all).toContain('[logo]');
    expect(all).not.toContain('javascript');
    expect(all).not.toContain('p.png');
  });

  it('escapes and weird input do not hang or throw', () => {
    expect(() =>
      parseMarkdown('*'.repeat(5000) + '\n' + '['.repeat(2000) + '`'.repeat(999)),
    ).not.toThrow();
    expect(() => parseMarkdown('> '.repeat(300) + 'deep')).not.toThrow();
    expect(() => parseMarkdown('- a\n'.repeat(3000))).not.toThrow();
    expect(plainText(parseInline('a \\*not italic\\* b'))).toBe('a *not italic* b');
  });
});

describe('HTML documents', () => {
  const PAGE = `<!doctype html><html><head><title>Guide</title><style>body{background:red}</style>
    <script>globalThis.__pwned = true</script></head>
    <body onload="globalThis.__pwned = true">
    <nav><a href="#ip">IP pool</a> <a href="javascript:alert(1)">evil</a> <a href="https://docs.example.com/x">docs</a></nav>
    <h1 id="top">Proxmox VPS commands</h1>
    <section id="ip"><h2>IP pools</h2>
    <p>Run <code>vps-ip-pool list</code> <button onclick="copy()">Copy</button></p>
    <pre><code class="language-bash">vps-ip-pool list
vps-ip-pool add 10.0.0.5</code></pre>
    <img src="https://tracker.example/p.png" alt="diagram" onerror="globalThis.__pwned = true">
    <form action="https://evil.example" method="post"><input name="pw" type="password"><button>Send</button></form>
    <iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y">
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>b</td></tr></table>
    <details><summary>More</summary><p>hidden text</p></details>
    </section></body></html>`;

  it('keeps the readable structure: headings, text, code, tables, details and anchors', () => {
    const blocks = parseHtml(PAGE);
    const flat = JSON.stringify(blocks);
    expect(flat).toContain('Proxmox VPS commands');
    expect(blocks.some((b) => b.t === 'heading' && b.id === 'top')).toBe(true);
    expect(blocks.some((b) => b.t === 'anchor' && b.id === 'ip')).toBe(true);
    const code = JSON.parse(flat).find((b: Block) => b.t === 'code') as Block;
    expect(code.t === 'code' && code.v).toBe('vps-ip-pool list\nvps-ip-pool add 10.0.0.5');
    expect(code.t === 'code' && code.lang).toBe('bash');
    const table = blocks.find((b) => b.t === 'table')!;
    expect(table.t === 'table' && table.head.map(plainText)).toEqual(['Name', 'Value']);
    expect(blocks.some((b) => b.t === 'details')).toBe(true);
  });

  it('drops scripts, styles, forms, frames, objects, handlers and unsafe links', () => {
    const blocks = parseHtml(PAGE);
    const text = JSON.stringify(blocks);
    for (const gone of [
      '__pwned',
      'background:red',
      'evil.example',
      'onclick',
      'onerror',
      'javascript',
      'password',
      'Send',
      'tracker.example',
    ]) {
      expect(text, gone).not.toContain(gone);
    }
    const { links } = collect(blocks);
    expect(links.sort()).toEqual(['#ip', 'https://docs.example.com/x']);
    expect(text).toContain('[diagram]');
  });

  it('never executes anything while parsing', () => {
    (globalThis as Record<string, unknown>).__pwned = false;
    parseHtml(PAGE);
    parseHtml(
      '<img src=x onerror="globalThis.__pwned=true"><svg onload="globalThis.__pwned=true"></svg>',
    );
    expect((globalThis as Record<string, unknown>).__pwned).toBe(false);
  });

  it('survives hostile and huge input', () => {
    expect(() => parseHtml('<div>'.repeat(5000) + 'x')).not.toThrow();
    expect(() => parseHtml('<p>' + 'a'.repeat(1_000_000) + '</p>')).not.toThrow();
    expect(parseHtml('')).toEqual([]);
    expect(JSON.stringify(parseHtml('<p>a<script>b</script>c</p>'))).not.toContain('"b"');
  });
});

describe('zoom helpers', () => {
  it('fit-to-width shrinks only when something overflows and stays within 50-200', () => {
    expect(fitZoom(100, 400, 400)).toBe(100); // already fits
    expect(fitZoom(100, 400, 300)).toBe(100);
    expect(fitZoom(100, 400, 800)).toBe(50);
    expect(fitZoom(100, 400, 500)).toBe(80);
    expect(fitZoom(150, 400, 600)).toBe(100);
    expect(fitZoom(100, 100, 5000)).toBe(50);
    expect(fitZoom(100, 0, 500)).toBe(100); // not measured yet
  });
});
