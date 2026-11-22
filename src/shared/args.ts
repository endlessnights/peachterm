// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Quote-aware conversion between an argument list and a single text field.
// Only used for display/editing; Rust receives the argv array and never runs
// a shell, so quoting here has no security meaning.

export function formatArgs(args: string[]): string {
  return args
    .map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
}

export function parseArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '"') {
      current += '"';
      hasToken = true;
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
    } else if (/\s/.test(ch) && !inQuotes) {
      if (hasToken) out.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) out.push(current);
  return out;
}
