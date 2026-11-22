/** Window event asking the active terminal to open its search bar. */
export const TERMINAL_SEARCH_EVENT = 'peachterm:terminal-search';

export const requestTerminalSearch = () => window.dispatchEvent(new Event(TERMINAL_SEARCH_EVENT));
