// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import {
  PREVIEW_TEXT,
  availableFonts,
  buildStack,
  primaryFamily,
  type FontChoice,
} from '../../shared/fonts';

/** Fonts are measured once per run; the list is cheap to keep. */
let cache: FontChoice[] | null = null;

function useFonts(): FontChoice[] | null {
  const [fonts, setFonts] = useState<FontChoice[] | null>(cache);
  useEffect(() => {
    if (cache) return undefined;
    let cancelled = false;
    // wait for the bundled font to be loaded so it is measured correctly
    const ready = typeof document !== 'undefined' && document.fonts?.ready;
    void Promise.resolve(ready)
      .then(() => document.fonts?.load?.('16px "JetBrains Mono"', 'Привет'))
      .catch(() => undefined)
      .then(() => {
        cache = availableFonts();
        if (!cancelled) setFonts(cache);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return fonts;
}

/** Test hook. */
export const __resetFontCache = () => {
  cache = null;
};

interface Props {
  /** The stored CSS font list. */
  value: string;
  onChange: (stack: string) => void;
}

/**
 * Searchable list of the monospace fonts that are really available (installed
 * or bundled), recommended ones first, each shown in its own face.
 */
export function FontPicker({ value, onChange }: Props) {
  const fonts = useFonts();
  const [query, setQuery] = useState('');
  const current = primaryFamily(value);
  const shown = useMemo(
    () => (fonts ?? []).filter((f) => f.family.toLowerCase().includes(query.trim().toLowerCase())),
    [fonts, query],
  );
  const currentKnown = fonts?.some((f) => f.family === current) ?? true;

  return (
    <div className="font-picker">
      <input
        className="input"
        type="search"
        placeholder="Search fonts"
        aria-label="Search fonts"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {fonts === null ? (
        <div className="hint">Looking for installed fonts…</div>
      ) : (
        <ul className="font-list" role="listbox" aria-label="Terminal font">
          {shown.length === 0 && <li className="hint">No matching font was found.</li>}
          {shown.map((font) => (
            <li
              key={font.family}
              role="option"
              aria-selected={font.family === current}
              tabIndex={0}
              className="font-row"
              data-selected={font.family === current || undefined}
              onClick={() => onChange(buildStack(font.family))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onChange(buildStack(font.family));
                }
              }}
            >
              <span className="font-name" style={{ fontFamily: `"${font.family}", monospace` }}>
                {font.family}
              </span>
              {font.bundled && <span className="badge">bundled</span>}
              {font.recommended && !font.bundled && (
                <span className="badge badge-soft">recommended</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {fonts !== null && !currentKnown && (
        <p className="hint" role="status">
          “{current}” was not found on this computer, so PeachTerm falls back to the next font in
          the list. Pick one above to change it.
        </p>
      )}
      <div className="font-preview" style={{ fontFamily: value }} aria-label="Font preview">
        {PREVIEW_TEXT}
      </div>
      <p className="hint">
        Includes the bundled JetBrains Mono (SIL Open Font License,{' '}
        <a href="/licenses/JetBrainsMono-OFL.txt" target="_blank" rel="noreferrer">
          licence
        </a>
        ), which also covers Cyrillic.
      </p>
    </div>
  );
}
