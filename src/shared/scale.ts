// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

/**
 * The terminal font is configured in its own setting and must not change with
 * the interface scale. The scale is a WebView zoom, so the CSS size is divided
 * by it: the glyphs end up at exactly the configured size on screen (no
 * double scaling).
 */
export const effectiveFontSize = (appearance: {
  terminalFontSize: number;
  interfaceScale: number;
}): number => appearance.terminalFontSize / (appearance.interfaceScale / 100);
