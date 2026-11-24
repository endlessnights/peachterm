// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Turning documents into a small, closed document tree that React renders as
// elements. There is NO innerHTML anywhere: raw HTML inside Markdown is shown as
// text, an HTML document is reduced to this tree (scripts, styles, forms,
// frames, event handlers, inline styles and every unknown tag are dropped), and
// links are limited to http(s)/mailto and in-page anchors. Images are never loaded
// (their alt text is shown). So even a hostile document cannot run code, load
// anything or reach the application.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'em'; c: Inline[] }
  | { t: 'strong'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; id: string; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }
  | { t: 'details'; summary: Inline[]; c: Block[] }
  /** An invisible target for in-page links (`#id`). */
  | { t: 'anchor'; id: string };

export const MAX_BLOCKS = 20000;
const MAX_DEPTH = 40;

// ---------------------------------------------------------------------------
// Safe links
// ---------------------------------------------------------------------------

/** What a link in a document may become: an in-page anchor, or a web/mail address. */
export type SafeLink = { kind: 'anchor'; id: string } | { kind: 'external'; url: string };

export function safeLink(href: string): SafeLink | null {
  const h = href.trim();
  if (h.startsWith('#') && h.length > 1 && h.length < 200) {
    try {
      return { kind: 'anchor', id: decodeURIComponent(h.slice(1)) };
    } catch {
      return { kind: 'anchor', id: h.slice(1) };
    }
  }
  if (h.length > 2048 || [...h].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    return null;
  }
  try {
    const u = new URL(h);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      if (u.username || u.password || !u.hostname) return null;
      return { kind: 'external', url: u.toString() };
    }
    if (u.protocol === 'mailto:') return { kind: 'external', url: u.toString() };
  } catch {
    /* relative or malformed: not clickable */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const slug = (text: string, used: Map<string, number>): string => {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section';
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
};

export function plainText(inline: Inline[]): string {
  return inline
    .map((i) => (i.t === 'text' || i.t === 'code' ? i.v : i.t === 'br' ? ' ' : plainText(i.c)))
    .join('');
}

/** Emphasis, code, links; everything else is literal text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~<]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const ticks = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + ticks.length, end).replace(/^ (.*) $/s, '$1') });
        i = end + ticks.length;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || (ch === '_' && (i === 0 || /\W/.test(src[i - 1]!)))) {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && !/\s/.test(src[i + 1]!)) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      // an image: never loaded, its description is shown instead
      const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'text', v: m[1] ? `[${m[1]}]` : '[image]' });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(
        src.slice(i),
      );
      if (m) {
        flush();
        const label = parseInline(m[1]!);
        const href = m[2]!;
        // an unsafe or relative target is shown as its text only (not clickable)
        if (safeLink(href)) out.push({ t: 'link', href, c: label });
        else out.push(...label);
        i += m[0].length;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: m[1]!, c: [{ t: 'text', v: m[1]! }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === ' ' && src.slice(i, i + 3) === '  \n') {
      flush();
      out.push({ t: 'br' });
      i += 3;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};

function parseBlocks(lines: string[], used: Map<string, number>, depth: number): Block[] {
  const blocks: Block[] = [];
  if (depth > MAX_DEPTH) return [{ t: 'p', c: [{ t: 'text', v: lines.join('\n') }] }];
  let i = 0;
  while (i < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const body: string[] = [];
      i += 1;
      while (
        i < lines.length &&
        !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)
      ) {
        body.push(lines[i]!);
        i += 1;
      }
      if (i >= lines.length) while (body.length && !body[body.length - 1]!.trim()) body.pop();
      i += 1; // the closing fence (an unclosed fence runs to the end)
      blocks.push({ t: 'code', lang: fence[3] ?? '', v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const c = parseInline(heading[2]!);
      blocks.push({
        t: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        id: slug(plainText(c), used),
        c,
      });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        i += 1;
      }
      blocks.push({ t: 'quote', c: parseBlocks(body, used, depth + 1) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i += 1;
      }
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (!m || /\d/.test(m[2]!) !== ordered) break;
        const indent = m[1]!.length + m[2]!.length + 1;
        const body = [m[3]!];
        i += 1;
        while (i < lines.length) {
          const next = lines[i]!;
          if (!next.trim()) {
            // a blank line continues the item only when an indented line follows
            if (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!)) {
              body.push('');
              i += 1;
              continue;
            }
            break;
          }
          if (/^\s{2,}\S/.test(next)) {
            body.push(next.slice(Math.min(indent, next.search(/\S/))));
            i += 1;
            continue;
          }
          if (LIST_ITEM.test(next) || HEADING.test(next) || FENCE.test(next)) break;
          body.push(next); // lazy continuation of the paragraph
          i += 1;
        }
        items.push(parseBlocks(body, used, depth + 1));
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    // a paragraph: until a blank line or the start of another block
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !(
        para.length &&
        (FENCE.test(lines[i]!) ||
          HEADING.test(lines[i]!) ||
          HR.test(lines[i]!) ||
          LIST_ITEM.test(lines[i]!) ||
          /^ {0,3}>/.test(lines[i]!))
      )
    ) {
      para.push(lines[i]!.replace(/\s+$/, (m) => (m.length >= 2 ? '  ' : '')));
      i += 1;
    }
    blocks.push({
      t: 'p',
      c: parseInline(para.join('\n').replace(/\n/g, ' ').replace(/ {2} /g, '  \n')),
    });
  }
  return blocks;
}

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), new Map(), 0);
}

export function parseText(text: string): Block[] {
  return [{ t: 'code', lang: '', v: text.replace(/\r\n?/g, '\n') }];
}

// ---------------------------------------------------------------------------
// HTML (inert parse, allow-list conversion)
// ---------------------------------------------------------------------------

const DROP = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'link',
  'meta',
  'base',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'source',
  'track',
  'dialog',
  'head',
  'title',
]);
const BLOCK_CONTAINERS = new Set([
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'body',
  'html',
  'center',
  'address',
  'fieldset',
  'dl',
  'dd',
  'dt',
  'menu',
]);

function inlineFrom(node: Node, out: Inline[], budget: { n: number }) {
  if (budget.n-- <= 0) return;
  if (node.nodeType === 3) {
    const v = (node.textContent ?? '').replace(/\s+/g, ' ');
    if (v) out.push({ t: 'text', v });
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag)) return;
  const kids = (): Inline[] => {
    const c: Inline[] = [];
    el.childNodes.forEach((n) => inlineFrom(n, c, budget));
    return c;
  };
  switch (tag) {
    case 'br':
      out.push({ t: 'br' });
      return;
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      out.push({ t: 'code', v: (el.textContent ?? '').replace(/\s+/g, ' ') });
      return;
    case 'strong':
    case 'b':
      out.push({ t: 'strong', c: kids() });
      return;
    case 'em':
    case 'i':
    case 'cite':
    case 'var':
      out.push({ t: 'em', c: kids() });
      return;
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const c = kids();
      if (href && safeLink(href)) out.push({ t: 'link', href, c });
      else out.push(...c);
      return;
    }
    case 'img': {
      const alt = el.getAttribute('alt');
      if (alt) out.push({ t: 'text', v: `[${alt}]` });
      return;
    }
    default:
      out.push(...kids());
  }
}

const inlinesOf = (el: Element, budget: { n: number }): Inline[] => {
  const out: Inline[] = [];
  el.childNodes.forEach((n) => inlineFrom(n, out, budget));
  // trim edge whitespace
  const first = out[0];
  if (first?.t === 'text') first.v = first.v.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last?.t === 'text') last.v = last.v.replace(/\s+$/, '');
  return out.filter((i) => !(i.t === 'text' && i.v === ''));
};

function htmlBlocks(
  parent: Node,
  used: Map<string, number>,
  budget: { n: number },
  depth: number,
): Block[] {
  const blocks: Block[] = [];
  let run: Inline[] = [];
  const flushRun = () => {
    const c = run.filter((i) => !(i.t === 'text' && !i.v.trim()));
    if (c.length) blocks.push({ t: 'p', c: run });
    run = [];
  };
  if (depth > MAX_DEPTH) return blocks;
  parent.childNodes.forEach((node) => {
    if (budget.n <= 0 || blocks.length >= MAX_BLOCKS) return;
    budget.n -= 1;
    if (node.nodeType === 3) {
      const v = (node.textContent ?? '').replace(/\s+/g, ' ');
      if (v.trim() || run.length) run.push({ t: 'text', v });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return;
    const id = el.getAttribute('id') ?? (tag === 'a' ? el.getAttribute('name') : null);
    const heading = /^h([1-6])$/.exec(tag);
    const isBlock =
      heading ||
      BLOCK_CONTAINERS.has(tag) ||
      ['p', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'hr', 'details'].includes(tag);
    if (!isBlock) {
      if (id) {
        flushRun();
        blocks.push({ t: 'anchor', id });
      }
      inlineFrom(el, run, budget);
      return;
    }
    flushRun();
    if (id && !heading) blocks.push({ t: 'anchor', id });
    if (heading) {
      const c = inlinesOf(el, budget);
      blocks.push({
        t: 'heading',
        level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6,
        id: id ?? slug(plainText(c), used),
        c,
      });
      return;
    }
    switch (tag) {
      case 'p': {
        const c = inlinesOf(el, budget);
        if (c.length) blocks.push({ t: 'p', c });
        return;
      }
      case 'ul':
      case 'ol': {
        const items: Block[][] = [];
        el.childNodes.forEach((li) => {
          if (li.nodeType === 1 && (li as Element).tagName.toLowerCase() === 'li') {
            items.push(htmlBlocks(li, used, budget, depth + 1));
          }
        });
        blocks.push({ t: 'list', ordered: tag === 'ol', items });
        return;
      }
      case 'li':
        blocks.push({
          t: 'list',
          ordered: false,
          items: [htmlBlocks(el, used, budget, depth + 1)],
        });
        return;
      case 'pre': {
        const codeEl = el.querySelector('code');
        const cls = (codeEl ?? el).getAttribute('class') ?? '';
        const lang = /(?:language|lang)-([\w+-]+)/.exec(cls)?.[1] ?? '';
        blocks.push({
          t: 'code',
          lang,
          v: (el.textContent ?? '').replace(/^\n/, '').replace(/\n$/, ''),
        });
        return;
      }
      case 'blockquote':
        blocks.push({ t: 'quote', c: htmlBlocks(el, used, budget, depth + 1) });
        return;
      case 'hr':
        blocks.push({ t: 'hr' });
        return;
      case 'details': {
        const summaryEl = [...el.children].find((c) => c.tagName.toLowerCase() === 'summary');
        const rest = document.implementation.createHTMLDocument('').createElement('div');
        el.childNodes.forEach((n) => {
          if (n !== summaryEl) rest.appendChild(n.cloneNode(true));
        });
        blocks.push({
          t: 'details',
          summary: summaryEl ? inlinesOf(summaryEl, budget) : [{ t: 'text', v: 'Details' }],
          c: htmlBlocks(rest, used, budget, depth + 1),
        });
        return;
      }
      case 'table': {
        const rowsEl = [...el.querySelectorAll('tr')];
        const cells = (tr: Element) =>
          [...tr.children]
            .filter((c) => /^t[dh]$/i.test(c.tagName))
            .map((c) => inlinesOf(c, budget));
        const headRow = rowsEl.find((tr) =>
          [...tr.children].some((c) => c.tagName.toLowerCase() === 'th'),
        );
        const head = headRow ? cells(headRow) : [];
        const rows = rowsEl.filter((tr) => tr !== headRow).map(cells);
        blocks.push({ t: 'table', head, rows });
        return;
      }
      default:
        // div, section, …: only their content matters
        blocks.push(...htmlBlocks(el, used, budget, depth + 1));
    }
  });
  flushRun();
  return blocks;
}

/**
 * HTML → the closed tree. `DOMParser` makes an inert document: its scripts never
 * run, its images and styles are never fetched.
 */
export function parseHtml(text: string): Block[] {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return htmlBlocks(doc.body ?? doc.documentElement, new Map(), { n: 200000 }, 0);
}

/** Zoom that makes content of `scroll` px fit into `client` px (never below 50%). */
export function fitZoom(current: number, client: number, scroll: number): number {
  if (client <= 0 || scroll <= client) return current;
  const fitted = Math.floor((current * client) / scroll / 10) * 10;
  return Math.max(50, Math.min(200, fitted));
}

export const ZOOM_STEP = 10;
export const clampZoom = (z: number) => Math.max(50, Math.min(200, Math.round(z)));
