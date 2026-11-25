// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// One interactive SSH terminal. The xterm instance lives as long as its tab:
// the pane is only hidden when another tab is active, so scrollback and the
// running remote program are untouched by tab switches.
//
// Output path: Rust → Tauri Channel (base64) → xterm.write. The write
// callback acknowledges the bytes so Rust can throttle the SSH channel when
// the renderer falls behind (flow control, see docs/ssh.md).

import { errorMessage } from '../../i18n/errors';
import { useTranslation } from 'react-i18next';
import { t as tr } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { Icon } from '../../components/Icon';
import { reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import { effectiveFontSize } from '../../shared/scale';
import type { SessionState, TerminalEvent } from '../../shared/types';
import { useSettings } from '../settings/store';
import { useLock } from '../lock/store';
import { useEditor } from '../editor/store';
import { useRecent } from '../sessions/recentStore';
import { usePrompts } from '../ssh/promptStore';
import { useTabs, type Tab, type TabStatus } from '../sessions/store';
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { useDialogs } from '../../app/dialogs';
import { EXPLAIN_SELECTION_EVENT, TERMINAL_SEARCH_EVENT } from './events';
import { terminalTheme } from './theme';

const ACK_BATCH_BYTES = 32 * 1024;
const ACK_DELAY_MS = 16;

/** Short, fixed explanations for the backend's failure tokens (never raw errors). */
const REASON_TOKENS = [
  'connect_failed',
  'timeout',
  'host_key_rejected',
  'auth_failed',
  'cancelled',
  'key_unreadable',
  'agent_unavailable',
  'protocol_error',
] as const;

const reasonText = (token: string): string =>
  (REASON_TOKENS as readonly string[]).includes(token)
    ? tr(`terminal.reason.${token as (typeof REASON_TOKENS)[number]}`)
    : tr('terminal.connectionFailed');

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

/** The IPC calls that differ between session types (SSH, local PTY, WSL PTY). */
interface SessionApi {
  write: (id: string, data: string) => Promise<void>;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  ack: (id: string, bytes: number) => Promise<void>;
  close: (id: string) => Promise<void>;
}
const SSH_API: SessionApi = {
  write: ipc.sshWrite,
  resize: ipc.sshResize,
  ack: ipc.sshAck,
  close: ipc.sshClose,
};
const LOCAL_API: SessionApi = {
  write: ipc.localWrite,
  resize: ipc.localResize,
  ack: ipc.localAck,
  close: ipc.localClose,
};

/**
 * Tell Rust how many output bytes were rendered. On failure (for instance
 * while the application is locked) the credit is kept and retried, otherwise
 * the remote end would stay throttled forever.
 */
function flushCredits(
  api: SessionApi,
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
  void api.ack(id, bytes).catch(() => {
    unacked.current += bytes;
    if (timer.current === null) {
      timer.current = window.setTimeout(() => flushCredits(api, session, unacked, timer), 500);
    }
  });
}

interface Props {
  tab: Tab;
  active: boolean;
}

export function TerminalView({ tab, active }: Props) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  // The tab's own palette (read by the observers created once per tab).
  const colorsRef = useRef<string | null>(tab.colors);
  // Read at the moment of use: changing the mode applies at once, with no reconnect.
  const copyMode = useSettings((s) => s.settings.terminal.copyMode);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const copyModeRef = useRef(copyMode);
  useEffect(() => {
    copyModeRef.current = copyMode;
  }, [copyMode]);
  const generation = useRef(0);
  const attempt = useRef(0);
  const unacked = useRef(0);
  const ackTimer = useRef<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [needle, setNeedle] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);

  // The Settings dialog previews appearance changes (also the interface scale).
  const settings = useSettings((s) => s.preview ?? s.settings.appearance);
  const tabId = tab.id;
  const connectionId = tab.connectionId;
  const profileId = tab.profileId;
  const isSsh = tab.kind === 'ssh';
  const api = isSsh ? SSH_API : LOCAL_API;

  const flushAck = useCallback(() => flushCredits(api, sessionRef, unacked, ackTimer), [api]);

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

  const endSession = useCallback(
    (closeBackend: boolean) => {
      const id = sessionRef.current;
      sessionRef.current = null;
      unacked.current = 0;
      if (id) {
        usePrompts.getState().dropSession(id);
        useEditor.getState().dropSession(id);
        if (closeBackend) void api.close(id).catch(() => undefined);
      }
    },
    [api],
  );

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
        if (event.state === 'connected' && isSsh) void useRecent.getState().refresh();
      } else {
        const text = event.reason ? reasonText(event.reason) : null;
        setReason(text);
        term.write(`\r\n\x1b[2m[${text ?? tr('terminal.connectionClosed')}]\x1b[0m\r\n`);
        endSession(false);
        useTabs.getState().setSftp(tabId, 'idle');
        useTabs.getState().setStatus(tabId, event.reason ? 'failed' : 'disconnected');
      }
    };
    const tries = attempt.current;
    attempt.current += 1;
    const opening = isSsh
      ? ipc.sshOpen(connectionId, term.cols, term.rows, onEvent, tries)
      : profileId
        ? ipc.localOpen(profileId, term.cols, term.rows, onEvent)
        : Promise.reject(new Error(tr('terminal.noProfile')));
    opening
      .then(({ sessionId }) => {
        if (generation.current !== mine) {
          void api.close(sessionId).catch(() => undefined);
          return;
        }
        sessionRef.current = sessionId;
        useTabs.getState().setSession(tabId, sessionId);
        flushAck();
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        const message = errorMessage(error);
        setReason(message);
        term.write(`\r\n\x1b[31m[${message}]\x1b[0m\r\n`);
        useTabs.getState().setStatus(tabId, 'failed');
        reportError(error);
      });
  }, [ack, api, connectionId, endSession, flushAck, isSsh, profileId, tabId]);

  // Create the terminal once per tab.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const state = useSettings.getState();
    const s = state.preview ?? state.settings.appearance;
    const term = new Terminal({
      fontFamily: s.terminalFontFamily,
      fontSize: effectiveFontSize(s),
      lineHeight: s.terminalLineHeight,
      scrollback: s.scrollback,
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalTheme(undefined, colorsRef.current),
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
      if (id && bytes.length > 0) void api.write(id, toBase64(bytes)).catch(() => undefined);
    };
    const subs = [
      term.onData((text) => send(encoder.encode(text))),
      // Binary reports (legacy mouse encodings) are latin1 bytes in a string.
      term.onBinary((text) => send(Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff))),
      term.onResize(({ cols, rows }) => {
        const id = sessionRef.current;
        if (id) void api.resize(id, cols, rows).catch(() => undefined);
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
    // Right click. "Copy on right-click": copy a selection, otherwise paste (PuTTY style).
    // "Copy on selection": the selection was already copied, so a right click pastes.
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      // Shift + right click opens a menu, only while Linux Command Help is on.
      const help = useSettings.getState().settings.linuxHelp;
      if (e.shiftKey && help.enabled && !useLock.getState().view?.locked) {
        const selected = term.getSelection();
        const entries: MenuEntry[] = [
          {
            kind: 'item',
            label: tr('help.menu.copy'),
            disabled: !selected,
            onSelect: () => void copy(),
          },
          { kind: 'item', label: tr('help.menu.paste'), onSelect: paste },
          { kind: 'separator' },
        ];
        if (help.explain) {
          entries.push({
            kind: 'item',
            label: tr('help.menu.explain'),
            disabled: !selected,
            onSelect: () =>
              useDialogs.getState().open({ kind: 'linuxHelp', mode: 'explain', text: selected }),
          });
        }
        entries.push({
          kind: 'item',
          label: tr('help.menu.reference'),
          onSelect: () => useDialogs.getState().open({ kind: 'linuxHelp', mode: 'reference' }),
        });
        setMenu({ x: e.clientX, y: e.clientY, entries });
        return;
      }
      if (copyModeRef.current === 'rightClick') {
        if (!copy()) paste();
      } else {
        paste();
      }
    };
    host.addEventListener('contextmenu', onContext);

    // Copy on selection. xterm.js reports every change while the mouse is
    // dragged, so nothing is copied then: a selection is "complete" when the
    // primary button is released after a press that started in this terminal
    // (drag, double click and triple click all end that way). `fresh` is set
    // only by a real selection change, so clicks, tab switches, resizes and
    // mouse-reporting applications never re-copy an old selection, and clearing
    // a selection never touches the clipboard.
    let fresh = false;
    let pressed = false;
    subs.push(
      term.onSelectionChange(() => {
        fresh = term.hasSelection();
      }),
    );
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) pressed = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !pressed) return;
      pressed = false;
      // After xterm.js has finished its own mouse-up handling.
      window.setTimeout(() => {
        if (copyModeRef.current !== 'selection' || !fresh) return;
        if (useLock.getState().view?.locked) return; // a locked app never reaches the clipboard
        const text = term.getSelection();
        fresh = false;
        if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
      }, 0);
    };
    host.addEventListener('mousedown', onDown, true);
    document.addEventListener('mouseup', onUp, true);

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
      term.options.theme = terminalTheme(undefined, colorsRef.current);
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
      // A restored tab waits for the user; nothing reconnects by itself.
      const me = useTabs.getState().tabs.find((t) => t.id === tabId);
      if (!me?.restored) connect();
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
      host.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mouseup', onUp, true);
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
    // Colours only: no remount, reconnect or scrollback reset.
    colorsRef.current = tab.colors;
    term.options.theme = terminalTheme(settings, tab.colors);
    term.options.fontFamily = settings.terminalFontFamily;
    term.options.fontSize = effectiveFontSize(settings);
    term.options.lineHeight = settings.terminalLineHeight;
    term.options.scrollback = settings.scrollback;
    try {
      fitRef.current?.fit();
    } catch {
      /* hidden */
    }
  }, [settings, tab.colors]);

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

  // Linux Command Help: the shortcut explains the active terminal's selected text.
  useEffect(() => {
    if (!active) return undefined;
    const explainSelection = () => {
      const { linuxHelp } = useSettings.getState().settings;
      if (!linuxHelp.enabled || !linuxHelp.explain || useLock.getState().view?.locked) return;
      const text = termRef.current?.getSelection() ?? '';
      useDialogs.getState().open({ kind: 'linuxHelp', mode: 'explain', text });
    };
    window.addEventListener(EXPLAIN_SELECTION_EVENT, explainSelection);
    return () => window.removeEventListener(EXPLAIN_SELECTION_EVENT, explainSelection);
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
  const waiting = tab.restored && tab.status === 'idle';

  return (
    <div className="terminal-view" data-terminal data-status={tab.status}>
      <div className="terminal-host" ref={hostRef} />
      {searching && (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            className="input"
            placeholder={t('terminal.findPlaceholder')}
            aria-label={t('terminal.findPlaceholder')}
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
          <button
            className="icon-btn"
            onClick={() => find(true)}
            aria-label={t('terminal.prevMatch')}
          >
            <Icon name="chevronUp" />
          </button>
          <button
            className="icon-btn"
            onClick={() => find(false)}
            aria-label={t('terminal.nextMatch')}
          >
            <Icon name="chevronDown" />
          </button>
          <button className="icon-btn" onClick={closeSearch} aria-label={t('terminal.closeSearch')}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
      {waiting && (
        <div className="terminal-ended" role="status">
          <span>{isSsh ? t('terminal.restoredSsh') : t('terminal.restoredLocal')}</span>
          <button
            className="btn btn-primary"
            onClick={() => {
              useTabs.getState().markStarted(tabId);
              connect();
            }}
            data-autofocus
          >
            <Icon name={isSsh ? 'plug' : 'terminal'} />{' '}
            {isSsh ? t('terminal.connect') : t('terminal.startShell')}
          </button>
        </div>
      )}
      {ended && (
        <div className="terminal-ended" role="status">
          <span>
            {tab.status === 'failed'
              ? (reason ?? (isSsh ? t('terminal.connectionFailed') : t('terminal.shellFailed')))
              : isSsh
                ? t('terminal.disconnected')
                : t('terminal.shellEnded')}
          </span>
          <button className="btn btn-primary" onClick={connect} data-autofocus>
            <Icon name="refresh" /> {isSsh ? t('terminal.reconnect') : t('terminal.restartShell')}
          </button>
        </div>
      )}
    </div>
  );
}
