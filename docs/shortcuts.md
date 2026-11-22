# Keyboard shortcuts

Settings → **Keyboard Shortcuts** lists every action, lets you record a new
combination, shows conflicts before saving and restores the defaults.

## Defaults

| Action                            | Windows / Linux           | macOS        |
| --------------------------------- | ------------------------- | ------------ |
| New terminal tab                  | Ctrl+T                    | ⌘T           |
| New saved connection              | Ctrl+N                    | ⌘N           |
| Close active tab                  | Ctrl+W                    | ⌘W           |
| Settings                          | Ctrl+,                    | ⌘,           |
| Toggle sidebar                    | Ctrl+B                    | ⌘B           |
| Search connections                | Ctrl+Shift+F              | ⇧⌘F          |
| Rename selected connection/folder | F2                        | F2           |
| Lock application                  | Ctrl+Shift+L              | ⇧⌘L          |
| Next / previous tab               | Ctrl+Tab / Ctrl+Shift+Tab | ⌃Tab / ⌃⇧Tab |

Settings can also be opened with the gear button at the bottom of the sidebar
(and in the status bar while the sidebar is collapsed).

## How shortcuts are stored

Only _overrides_ are saved (`settings.json` → `shortcuts`, action id →
accelerator). Defaults live in `src/shared/shortcutDefaults.json`, which the UI
and the Rust backend both read, so they cannot drift apart. `Mod` means Ctrl on
Windows/Linux and Cmd on macOS, so a settings file works on every platform. An
empty string means "unassigned".

Rust re-validates on every save (unknown action, malformed accelerator,
reserved combination, duplicate) and refuses the whole save with a message; a
damaged file never loses the valid overrides — bad entries are dropped
individually and reported at start-up.

## Terminal input is preserved

Shells, vim, tmux, mc and htop own many keys. While a terminal has focus the
application does **not** intercept:

- bare `Ctrl+<letter>` (control characters, e.g. Ctrl+W, Ctrl+B = tmux prefix),
- `Alt+<key>` (readline/meta),
- plain `F1`–`F12` (mc, htop).

Instead, every bare-Ctrl binding gets an automatic `Ctrl+Shift+<letter>` alias
that works everywhere, including inside a terminal (for example Ctrl+Shift+W
closes the tab), unless that combination is already taken or reserved. The
recorder warns when you choose a terminal-owned key and offers the alias. On
macOS, Cmd shortcuts never reach terminal programs, so no alias is needed.

Matching uses the physical key position, so shortcuts keep working on non-Latin
keyboard layouts. Auto-repeat is ignored (holding Ctrl+W cannot close every tab).

Shortcuts are plain DOM handlers: they only exist while PeachTerm has focus.
No global (OS-wide) hotkey is ever registered.

## Reserved combinations

Cannot be assigned (reasons are shown in the UI): reload (F5, Ctrl+R,
Ctrl+Shift+R), developer tools (F12, Ctrl+Shift+I/J/C), print (Ctrl+P), view
source (Ctrl+U), zoom (Ctrl+0/=/-), Alt+F4, Alt+Tab, Alt+Esc, Alt+Space,
Ctrl+Esc, Ctrl+Alt+Delete, any Windows/Super-key combination, and on macOS
Cmd+Q/H/M/Space/Tab.

PeachTerm additionally suppresses the embedded web view's own shortcuts
(reload, print, find, save, open, zoom, developer tools) when no terminal has
focus, so they cannot reload the UI and discard open tabs.

## Platform limits

- Windows/Linux: combinations using the Windows/Super key belong to the OS.
- Linux: some desktop environments grab Ctrl+Alt+<arrows>/Ctrl+Alt+T globally;
  the window never receives them.
- macOS: Cmd+Q/H/M/Space/Tab are handled by the system before the app.
- Input-method (IME) composition suppresses shortcuts while composing.
