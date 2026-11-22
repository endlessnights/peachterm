// One interactive SSH terminal. The xterm instance lives as long as its tab:
// the pane is only hidden when another tab is active, so scrollback and the
// running remote program are untouched by tab switches.
//
// Output path: Rust → Tauri Channel (base64) → xterm.write. The write
// callback acknowledges the bytes so Rust can throttle the SSH channel when
// the renderer falls behind (flow control, see docs/ssh.md).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { Icon } from '../../components/Icon';
import { reportError } from '../../components/Toasts';
import { ipc, toAppError } from '../../shared/ipc';
import type { SessionState, TerminalEvent } from '../../shared/types';
import { useSettings } from '../settings/store';
import { usePrompts } from '../ssh/promptStore';
import { useTabs, type Tab, type TabStatus } from '../sessions/store';
import { TERMINAL_SEARCH_EVENT } from './events';
import { terminalTheme } from './theme';

const ACK_BATCH_BYTES = 32 * 1024;
const ACK_DELAY_MS = 16;

/** Short, fixed explanations for the backend's failure tokens (never raw errors). */
const REASONS: Record<string, string> = {
  connect_failed: 'Could not connect to the server.',
  timeout: 'The connection timed out.',
  host_key_rejected: 'The server host key was not trusted.',
  auth_failed: 'Authentication failed.',
  cancelled: 'Connection cancelled.',
  key_unreadable: 'The private key could not be read.',
  agent_unavailable: 'No SSH agent is available.',
  protocol_error: 'The SSH connection failed (protocol error).',
};

const STATUS: Record<SessionState, TabStatus> = {
  connecting: 'connecting',
  awaitingHostKey: 'connecting',
  authenticating: 'connecting',
  connected: 'connected',
  disconnected: 'disconnected',
  failed: 'failed',
};

const toBytes = (b64: string): Uint8Array => {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
};

const encoder = new TextEncoder();

type Ref<T> = { current: T };

/**
 * Tell Rust how many output bytes were rendered. On failure (for instance
 * while the application is locked) the credit is kept and retried, otherwise
 * the remote end would stay throttled forever.
 */
function flushCredits(
  session: Ref<string | null>,
  unacked: Ref<number>,
  timer: Ref<number | null>,
): void {
  if (timer.current !== null) {
    window.clearTimeout(timer.current);
    timer.current = null;
  }
  const id = session.current;
  if (!id || unacked.current === 0) return;
  const bytes = unacked.current;
  unacked.current = 0;
  void ipc.sshAck(id, bytes).catch(() => {
    unacked.current += bytes;
    if (timer.current === null) {
      timer.current = window.setTimeout(() => flushCredits(session, unacked, timer), 500);
    }
  });
}

interface Props {
  tab: Tab;
  active: boolean;
}

export function TerminalView({ tab, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const generation = useRef(0);
  const attempt = useRef(0);
  const unacked = useRef(0);
  const ackTimer = useRef<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [needle, setNeedle] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);

  const settings = useSettings((s) => s.settings.appearance);
  const tabId = tab.id;
  const connectionId = tab.connectionId;

  const flushAck = useCallback(() => flushCredits(sessionRef, unacked, ackTimer), []);

  const ack = useCallback(
    (bytes: number) => {
      unacked.current += bytes;
      if (unacked.current >= ACK_BATCH_BYTES) flushAck();
      else if (ackTimer.current === null) {
        ackTimer.current = window.setTimeout(flushAck, ACK_DELAY_MS);
      }
    },
    [flushAck],
  );

  const endSession = useCallback((closeBackend: boolean) => {
    const id = sessionRef.current;
    sessionRef.current = null;
    unacked.current = 0;
    if (id) {
      usePrompts.getState().dropSession(id);
      if (closeBackend) void ipc.sshClose(id).catch(() => undefined);
    }
  }, []);

  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    endSession(true);
    const mine = (generation.current += 1);
    const tabs = useTabs.getState();
    setReason(null);
    tabs.setStatus(tabId, 'connecting');
    tabs.setSession(tabId, null);
    tabs.setSftp(tabId, 'idle');
    const onEvent = (event: TerminalEvent) => {
      if (generation.current !== mine) return;
      if (event.kind === 'data') {
        const bytes = toBytes(event.data);
        term.write(bytes, () => ack(bytes.length));
      } else if (event.kind === 'sftp') {
        useTabs.getState().setSftp(tabId, event.state);
      } else if (event.kind === 'status') {
        useTabs.getState().setStatus(tabId, STATUS[event.state]);
      } else {
        const text = event.reason ? (REASONS[event.reason] ?? 'The connection failed.') : null;
        setReason(text);
        term.write(`\r\n\x1b[2m[${text ?? 'Connection closed'}]\x1b[0m\r\n`);
        endSession(false);
        useTabs.getState().setSftp(tabId, 'idle');
        useTabs.getState().setStatus(tabId, event.reason ? 'failed' : 'disconnected');
      }
    };
    const tries = attempt.current;
    attempt.current += 1;
    ipc
      .sshOpen(connectionId, term.cols, term.rows, onEvent, tries)
      .then(({ sessionId }) => {
        if (generation.current !== mine) {
          void ipc.sshClose(sessionId).catch(() => undefined);
          return;
        }
        sessionRef.current = sessionId;
        useTabs.getState().setSession(tabId, sessionId);
        flushAck();
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        const message = toAppError(error).message;
        setReason(message);
        term.write(`\r\n\x1b[31m[${message}]\x1b[0m\r\n`);
        useTabs.getState().setStatus(tabId, 'failed');
        reportError(error);
      });
  }, [ack, connectionId, endSession, flushAck, tabId]);

  // Create the terminal once per tab.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const s = useSettings.getState().settings.appearance;
    const term = new Terminal({
      fontFamily: s.terminalFontFamily,
      fontSize: s.terminalFontSize,
      lineHeight: s.terminalLineHeight,
      scrollback: s.scrollback,
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const send = (bytes: Uint8Array) => {
      const id = sessionRef.current;
      if (id && bytes.length > 0) void ipc.sshWrite(id, toBase64(bytes)).catch(() => undefined);
    };
    const subs = [
      term.onData((text) => send(encoder.encode(text))),
      // Binary reports (legacy mouse encodings) are latin1 bytes in a string.
      term.onBinary((text) => send(Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff))),
      term.onResize(({ cols, rows }) => {
        const id = sessionRef.current;
        if (id) void ipc.sshResize(id, cols, rows).catch(() => undefined);
      }),
    ];

    const copy = () => {
      const text = term.getSelection();
      if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
      return text.length > 0;
    };
    const paste = () => {
      void navigator.clipboard
        ?.readText()
        .then((text) => text && term.paste(text))
        .catch(() => undefined);
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && e.shiftKey && key === 'c') {
        copy();
        return false;
      }
      if ((ctrl && e.shiftKey && key === 'v') || (e.shiftKey && e.key === 'Insert')) {
        paste();
        return false;
      }
      if (ctrl && e.key === 'Insert') {
        copy();
        return false;
      }
      return true;
    });
    // Right click: copy a selection, otherwise paste (PuTTY-style).
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      if (!copy()) paste();
    };
    host.addEventListener('contextmenu', onContext);

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.offsetParent !== null && host.clientWidth > 0 && host.clientHeight > 0) {
          try {
            fit.fit();
          } catch {
            /* hidden or zero-sized: fitted again when shown */
          }
        }
      });
    });
    observer.observe(host);

    // Re-theme when the application theme changes.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });

    // Deferred so React StrictMode's mount/unmount/mount opens one session.
    const start = window.setTimeout(() => {
      try {
        fit.fit();
      } catch {
        /* sized later */
      }
      connect();
    }, 0);

    return () => {
      window.clearTimeout(start);
      generation.current += 1;
      endSession(true);
      if (ackTimer.current !== null) window.clearTimeout(ackTimer.current);
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      host.removeEventListener('contextmenu', onContext);
      subs.forEach((d) => d.dispose());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // The terminal is created once per tab; `connect` is stable per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Appearance settings apply live.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.terminalFontFamily;
    term.options.fontSize = settings.terminalFontSize;
    term.options.lineHeight = settings.terminalLineHeight;
    term.options.scrollback = settings.scrollback;
    try {
      fitRef.current?.fit();
    } catch {
      /* hidden */
    }
  }, [settings]);

  // Fit and focus when this tab is shown.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* not laid out yet */
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // Search (shortcut event is delivered to the active terminal only).
  useEffect(() => {
    if (!active) return undefined;
    const open = () => {
      setSearching(true);
      requestAnimationFrame(() => searchInput.current?.select());
    };
    window.addEventListener(TERMINAL_SEARCH_EVENT, open);
    return () => window.removeEventListener(TERMINAL_SEARCH_EVENT, open);
  }, [active]);

  const closeSearch = () => {
    setSearching(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };
  const find = (backwards: boolean, text = needle) => {
    if (!text) return;
    const options = { caseSensitive: false, incremental: false };
    if (backwards) searchRef.current?.findPrevious(text, options);
    else searchRef.current?.findNext(text, options);
  };

  const ended = tab.status === 'disconnected' || tab.status === 'failed';

  return (
    <div className="terminal-view" data-terminal data-status={tab.status}>
      <div className="terminal-host" ref={hostRef} />
      {searching && (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            className="input"
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            value={needle}
            onChange={(e) => {
              setNeedle(e.target.value);
              find(false, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                find(e.shiftKey);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              }
            }}
            data-autofocus
          />
          <button className="icon-btn" onClick={() => find(true)} aria-label="Previous match">
            <Icon name="chevronUp" />
          </button>
          <button className="icon-btn" onClick={() => find(false)} aria-label="Next match">
            <Icon name="chevronDown" />
          </button>
          <button className="icon-btn" onClick={closeSearch} aria-label="Close search">
            <Icon name="close" />
          </button>
        </div>
      )}
      {ended && (
        <div className="terminal-ended" role="status">
          <span>
            {tab.status === 'failed' ? (reason ?? 'The connection failed.') : 'Disconnected.'}
          </span>
          <button className="btn btn-primary" onClick={connect} data-autofocus>
            <Icon name="refresh" /> Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
