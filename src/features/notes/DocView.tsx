// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Renders the closed document tree (see doc.ts) as React elements. Nothing here
// uses innerHTML or evaluates anything; code blocks have a Copy button that only
// copies (a command is never run); links open the system browser through a fixed,
// validated command, or scroll inside the document.

import { Fragment, useRef, type ReactNode } from 'react';
import { notify, reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import { safeLink, type Block, type Inline } from './doc';

/** Copy text to the clipboard. This never executes anything. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="doc-hit">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (from === 0) return text;
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="doc-copy"
      title="Copy to the clipboard (does not run anything)"
      aria-label={`${label} code`}
      onClick={() => {
        void copyText(text).then((ok) => notify(ok ? 'Copied.' : 'Could not copy.'));
      }}
    >
      {label}
    </button>
  );
}

interface Ctx {
  query: string;
  root: React.RefObject<HTMLDivElement | null>;
}

function Inlines({ list, ctx }: { list: Inline[]; ctx: Ctx }) {
  return (
    <>
      {list.map((i, k) => {
        switch (i.t) {
          case 'text':
            return (
              <Fragment key={k}>
                <Highlight text={i.v} query={ctx.query} />
              </Fragment>
            );
          case 'code':
            return (
              <code key={k} className="doc-inline-code">
                <Highlight text={i.v} query={ctx.query} />
              </code>
            );
          case 'em':
            return (
              <em key={k}>
                <Inlines list={i.c} ctx={ctx} />
              </em>
            );
          case 'strong':
            return (
              <strong key={k}>
                <Inlines list={i.c} ctx={ctx} />
              </strong>
            );
          case 'br':
            return <br key={k} />;
          case 'link':
            return (
              <a
                key={k}
                className="doc-link"
                // never a real navigation: the click handler decides
                href={safeLink(i.href)?.kind === 'external' ? i.href : '#'}
                onClick={(e) => {
                  e.preventDefault();
                  const target = safeLink(i.href);
                  if (target?.kind === 'anchor') {
                    ctx.root.current
                      ?.querySelector(`[data-anchor="${CSS.escape(target.id)}"]`)
                      ?.scrollIntoView?.({ block: 'start' });
                  } else if (target?.kind === 'external') {
                    ipc.noteOpenLink(target.url).catch(reportError);
                  }
                }}
              >
                <Inlines list={i.c} ctx={ctx} />
              </a>
            );
        }
      })}
    </>
  );
}

function Blocks({ list, ctx }: { list: Block[]; ctx: Ctx }) {
  return (
    <>
      {list.map((b, k) => {
        switch (b.t) {
          case 'heading': {
            const Tag = `h${b.level}` as 'h1';
            return (
              <Tag key={k} data-anchor={b.id} className="doc-heading">
                <Inlines list={b.c} ctx={ctx} />
              </Tag>
            );
          }
          case 'p':
            return (
              <p key={k}>
                <Inlines list={b.c} ctx={ctx} />
              </p>
            );
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={k}>
                {b.items.map((item, n) => (
                  <li key={n}>
                    <Blocks list={item} ctx={ctx} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={k}>
                <Blocks list={b.c} ctx={ctx} />
              </blockquote>
            );
          case 'code':
            return (
              <div key={k} className="doc-code">
                {b.lang && <span className="doc-code-lang">{b.lang}</span>}
                <CopyButton text={b.v} />
                {/* never wrapped: a long command stays one line you can scroll and copy */}
                <pre tabIndex={0}>
                  <code>
                    <Highlight text={b.v} query={ctx.query} />
                  </code>
                </pre>
              </div>
            );
          case 'table':
            return (
              <div key={k} className="doc-table-wrap" tabIndex={0}>
                <table>
                  {b.head.length > 0 && (
                    <thead>
                      <tr>
                        {b.head.map((c, n) => (
                          <th key={n}>
                            <Inlines list={c} ctx={ctx} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((c, n) => (
                          <td key={n}>
                            <Inlines list={c} ctx={ctx} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={k} />;
          case 'details':
            return (
              <details key={k} open>
                <summary>
                  <Inlines list={b.summary} ctx={ctx} />
                </summary>
                <Blocks list={b.c} ctx={ctx} />
              </details>
            );
          case 'anchor':
            return <span key={k} data-anchor={b.id} className="doc-anchor" />;
        }
      })}
    </>
  );
}

export function DocView({
  blocks,
  query,
  zoom,
  rootRef,
}: {
  blocks: Block[];
  query: string;
  zoom: number;
  rootRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const own = useRef<HTMLDivElement>(null);
  const root = rootRef ?? own;
  return (
    <div
      ref={root}
      className="doc"
      // the zoom changes the document only: not the terminal, not the interface
      style={{ fontSize: `${(13 * zoom) / 100}px` }}
      data-zoom={zoom}
    >
      <Blocks list={blocks} ctx={{ query, root }} />
    </div>
  );
}
