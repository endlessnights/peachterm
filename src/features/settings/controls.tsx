// Small form controls shared by the settings pages.

import type { ReactNode } from 'react';
import type { Settings } from '../../shared/types';

export type PageProps = {
  draft: Settings;
  patch: <S extends keyof Settings>(section: S, values: Partial<Settings[S]>) => void;
};

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export const numberInput = (
  value: number,
  onChange: (n: number) => void,
  min: number,
  max: number,
) => (
  <input
    className="input"
    type="number"
    min={min}
    max={max}
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
  />
);
