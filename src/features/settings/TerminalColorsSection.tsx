// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Settings → Appearance → Terminal Colors.
//
// Rules (kept simple on purpose):
//  * Linked (default): the terminal palette follows the application theme.
//  * Picking a palette by hand, or any custom colour, switches to independent
//    mode; later application-theme changes then leave the terminal alone.
//  * Custom colours always imply independent mode, so "linked" and "custom"
//    are never both active.
//  * "Restore theme-recommended" removes custom colours AND re-enables linking.
// Only validated #rrggbb values are stored; nothing is silently corrected.

import { useState } from 'react';
import type { CustomTerminalColors, Settings } from '../../shared/types';
import {
  ANSI_KEYS,
  ANSI_NAMES,
  PRESETS,
  PRESET_ORDER,
  effectivePreset,
  effectiveSource,
  isHexColor,
  readabilityWarning,
  recommendedPreset,
  type TerminalPresetId,
} from '../terminal/palettes';
import { terminalTheme } from '../terminal/theme';
import { Field, type PageProps } from './controls';

type Appearance = Settings['appearance'];

const EMPTY: CustomTerminalColors = {
  background: null,
  foreground: null,
  cursor: null,
  selectionBackground: null,
  ansi: null,
};

/** `#rrggbb` for a colour input from a palette value (which may be `rgba(...)`). */
export function pickerHex(value: string | undefined): string {
  if (!value) return '#000000';
  if (isHexColor(value)) return value.toLowerCase();
  const m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(value);
  if (!m) return '#000000';
  const h = (n: string) => Math.min(255, Number(n)).toString(16).padStart(2, '0');
  return `#${h(m[1]!)}${h(m[2]!)}${h(m[3]!)}`;
}

export function TerminalColorsSection({ draft, patch }: PageProps) {
  const a = draft.appearance;
  const colors = a.terminalColors;
  const effective = effectivePreset(a);
  const source = effectiveSource(a);
  const recommended = recommendedPreset(a.theme);
  const theme = terminalTheme(a);

  const setColors = (next: Partial<Appearance['terminalColors']>) =>
    patch('appearance', { terminalColors: { ...colors, ...next } });
  const setCustom = (values: Partial<CustomTerminalColors>) => {
    // Starting from a linked palette: remember which palette "reset" returns to.
    setColors({
      linked: false,
      preset: effective,
      custom: { ...(colors.custom ?? EMPTY), ...values },
    });
  };

  const bg = String(theme.background);
  const fg = String(theme.foreground);
  const warning = readabilityWarning(bg, fg);
  const sourceText =
    source === 'linked'
      ? `linked to the ${a.theme === 'system' ? 'system' : 'application'} theme`
      : source === 'custom'
        ? `based on ${PRESETS[colors.preset as TerminalPresetId]?.name ?? 'a preset'}, with custom colours`
        : 'selected manually';

  return (
    <>
      <h3>Terminal colours</h3>
      <div className="settings-grid">
        <Field label="Terminal theme">
          <select
            className="select"
            aria-label="Terminal theme"
            value={effective}
            onChange={(e) =>
              // choosing a palette by hand = independent mode (custom colours are replaced)
              setColors({ linked: false, preset: e.target.value, custom: null })
            }
          >
            {PRESET_ORDER.map((id) => (
              <option key={id} value={id}>
                {PRESETS[id].name}
                {id === recommended ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={source === 'linked'}
          disabled={!!colors.custom}
          onChange={(e) => setColors({ linked: e.target.checked })}
        />
        Link terminal theme to application theme
      </label>
      {colors.custom && (
        <p className="hint">
          Custom colours are active, so the link is off. Restore the recommended colours to link
          again.
        </p>
      )}
      <p className="hint" data-testid="effective-palette">
        Effective palette: <strong>{PRESETS[effective].name}</strong> — {sourceText}.
      </p>
      <button
        className="btn"
        type="button"
        onClick={() => setColors({ linked: true, custom: null })}
        title="Removes custom colours and links the terminal to the application theme again"
      >
        Restore Theme-Recommended Terminal Colors
      </button>

      <TerminalPreview theme={theme} appearance={a} />

      <h3>Custom terminal colours</h3>
      <div className="color-grid">
        <ColorRow
          label="Background"
          value={pickerHex(bg)}
          custom={colors.custom?.background ?? null}
          onChange={(v) => setCustom({ background: v })}
        />
        <ColorRow
          label="Foreground"
          value={pickerHex(fg)}
          custom={colors.custom?.foreground ?? null}
          onChange={(v) => setCustom({ foreground: v })}
        />
        <ColorRow
          label="Cursor"
          value={pickerHex(String(theme.cursor))}
          custom={colors.custom?.cursor ?? null}
          onChange={(v) => setCustom({ cursor: v })}
        />
        <ColorRow
          label="Selection background"
          value={pickerHex(String(theme.selectionBackground))}
          custom={colors.custom?.selectionBackground ?? null}
          onChange={(v) => setCustom({ selectionBackground: v })}
        />
      </div>
      {warning && (
        <p className="notice" role="status">
          {warning} Your colours are kept as chosen; pick a lighter or darker value to improve
          readability.
        </p>
      )}
      <details className="color-advanced">
        <summary>ANSI colours (advanced)</summary>
        <div className="color-grid">
          {ANSI_KEYS.map((key, i) => (
            <ColorRow
              key={key}
              label={ANSI_NAMES[i]!}
              value={pickerHex(String(theme[key]))}
              custom={colors.custom?.ansi?.[i] ?? null}
              onChange={(v) => {
                const base = (
                  colors.custom?.ansi ?? ANSI_KEYS.map((k) => pickerHex(String(theme[k])))
                ).slice();
                base[i] = v;
                setCustom({ ansi: base });
              }}
            />
          ))}
        </div>
      </details>
      <button
        className="btn"
        type="button"
        disabled={!colors.custom}
        onClick={() => setColors({ custom: null })}
      >
        Reset to selected preset
      </button>
    </>
  );
}

function ColorRow({
  label,
  value,
  custom,
  onChange,
}: {
  label: string;
  value: string;
  custom: string | null;
  onChange: (hex: string) => void;
}) {
  // The text field is validated before anything is stored.
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value;
  const invalid = text !== null && !isHexColor(text);
  return (
    <div className="color-row" data-custom={custom ? '' : undefined}>
      <span>{label}</span>
      <input
        type="color"
        aria-label={`${label} colour`}
        value={value}
        onChange={(e) => {
          setText(null);
          onChange(e.target.value.toLowerCase());
        }}
      />
      <input
        className="input color-hex"
        aria-label={`${label} hex value`}
        aria-invalid={invalid || undefined}
        value={shown}
        spellCheck={false}
        maxLength={7}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          if (isHexColor(v)) {
            onChange(v.toLowerCase());
            setText(null);
          }
        }}
        onBlur={() => setText(null)}
      />
      {invalid && (
        <span className="hint" role="alert">
          Use a colour like #1a2b3c.
        </span>
      )}
    </div>
  );
}

/** A static sample (no session needed) drawn with the real palette. */
export function TerminalPreview({
  theme,
  appearance,
}: {
  theme: ReturnType<typeof terminalTheme>;
  appearance: Appearance;
}) {
  const c = (key: (typeof ANSI_KEYS)[number]) => String(theme[key]);
  return (
    <div
      className="terminal-preview"
      role="img"
      aria-label="Terminal colour preview"
      style={{
        background: String(theme.background),
        color: String(theme.foreground),
        fontFamily: appearance.terminalFontFamily,
      }}
    >
      <div>
        <span style={{ color: c('green') }}>admin@server</span>
        <span>:</span>
        <span style={{ color: c('blue') }}>~/projects</span>
        <span>$ ls --color</span>
      </div>
      <div>
        <span style={{ color: c('blue'), fontWeight: 'bold' }}>src/</span>{' '}
        <span style={{ color: c('cyan') }}>link</span>{' '}
        <span style={{ color: c('green') }}>run.sh</span>{' '}
        <span style={{ color: c('red') }}>error.log</span>{' '}
        <span style={{ color: c('yellow') }}>notes.txt</span>{' '}
        <span style={{ color: c('magenta') }}>image.png</span>
      </div>
      <div className="terminal-preview-swatches" aria-hidden>
        {ANSI_KEYS.map((key) => (
          <span key={key} style={{ background: c(key) }} />
        ))}
      </div>
      <div>
        <span
          data-part="selection"
          style={{
            background: String(theme.selectionBackground),
            color: theme.selectionForeground ? String(theme.selectionForeground) : undefined,
          }}
        >
          selected text
        </span>{' '}
        <span style={{ color: c('brightBlack') }}># dim comment</span>
      </div>
      <div>
        <span>$ </span>
        <span
          data-part="cursor"
          style={{ background: String(theme.cursor), color: String(theme.cursorAccent) }}
        >
          {' '}
        </span>
      </div>
    </div>
  );
}
