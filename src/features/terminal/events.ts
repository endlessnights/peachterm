// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

/** Window event asking the active terminal to open its search bar. */
export const TERMINAL_SEARCH_EVENT = 'peachterm:terminal-search';

export const requestTerminalSearch = () => window.dispatchEvent(new Event(TERMINAL_SEARCH_EVENT));
