# Localization

PeachTerm's interface is available in six languages. English is the source and the fallback.

| Language                 | Code      | Preference value |
| ------------------------ | --------- | ---------------- |
| English                  | `en`      | `en`             |
| Russian — Русский        | `ru`      | `ru`             |
| German — Deutsch         | `de`      | `de`             |
| French — Français        | `fr`      | `fr`             |
| Spanish — Español        | `es`      | `es`             |
| Serbian (Latin) — Srpski | `sr-Latn` | `sr-Latn`        |

Serbian is Latin-only: a system set to Serbian in Cyrillic (`sr-Cyrl-*`) gets the Latin interface. There is no
Cyrillic Serbian translation. Application documentation (this folder) stays in English.

## Choosing a language

**Settings → Appearance → Language**: _System default_, English, Русский, Deutsch, Français, Español, Srpski
(latinica). The names are always shown in their own language. The choice applies immediately, with no restart:
open dialogs, the sidebar, the status bar and menus change in place. SSH sessions, SFTP transfers, tunnels,
monitoring, notes and terminal contents are not touched.

- **System default** (the default for new installations): the first language in the operating system's preferred
  languages (`navigator.languages`) that PeachTerm supports; otherwise English. `de-CH`, `fr-CA`, `es-MX`, `en-GB`…
  map to their language. Matching uses the parsed primary language subtag, never substrings. The system language is
  read at start-up (a change of the OS language while PeachTerm runs is picked up on the next launch).
- **A fixed language** overrides the system language.
- The preference is `general.language` in `settings.json` (`system`, `en`, `ru`, `de`, `fr`, `es`, `sr-Latn`).
  Old files (the field used to hold `en`) stay valid. Unknown or empty values fall back to `system`. The value is
  part of settings export/backups (it is a portable setting); a restored value that this build does not know falls
  back to `system`.
- The last choice is also kept in the WebView's local storage (`peachterm.language`) so the lock screen and the
  first frame already use it before settings are loaded. This holds a language code only.

What is not translated: user data (connection, folder, tab and note names, note text), host names, IPs, ports,
paths, commands, fingerprints, shell/editor program names, the names of the built-in terminal colour palettes and
themes (proper names), release notes fetched from GitHub, and text sent by an SSH server (keyboard-interactive
prompts, banners). Technical abbreviations (SSH, SFTP, CPU, RAM) stay as they are.

## How it is built

- `i18next` + `react-i18next`; resources are bundled (`src/i18n/locales/<code>.json`), no network, no translation
  service. `src/i18n/index.ts` initialises it, `languages.ts` holds the supported list, the locale matching and the
  preference normalisation, `format.ts` wraps `Intl` (numbers, percentages, dates, lists), `errors.ts` localizes
  backend errors.
- Keys are stable and semantic (`settings.language.label`, `exit.ssh`, `errors.lock.wrong`). Keys are typed:
  `src/i18n/i18next.d.ts` derives them from `en.json`, so a misspelt or removed key fails `npm run typecheck`.
- Components use `useTranslation()`; code outside React (stores, command helpers) uses the exported `t`.
  Never compose sentences by concatenation: use interpolation (`{{name}}`) and plural forms.
- Plurals use i18next's `_one / _few / _many / _other` suffixes and the language's own rules
  (`Intl.PluralRules`): Russian and Serbian need `few`, French and Spanish need `many`. Rich text uses
  `<Trans>` with the tags `<strong>`, `<kbd>` and (notes title) `<name>` only; React renders everything else as
  text, so a translation cannot inject markup.
- Dates, times, numbers, percentages and lists go through `Intl` with the interface language. File listings keep
  the ISO date (`2026-03-05 14:03`) and binary units (`KiB`, `MiB`), like `ls`, on purpose.

## Backend errors

The Rust side keeps English messages for diagnostics, and adds stable identifiers the interface translates:

```json
{ "code": "validation", "message": "The lock password must have at least 8 characters.",
  "key": "lock.minLength", "params": { "min": "8" } }
{ "code": "remote", "message": "No such file or directory", "token": "not_found" }
```

`key` (and `params`) come from `AppError::validation_key / storage_key(...).with_param(...)`; `token` is the
existing failure token of SFTP/editor/update errors. `src/i18n/errors.ts` looks up `errors.<key>` or
`errors.remote.<token>`, and falls back to the English `message` for anything without a translation; nothing is
matched against message text. `locked`, `not_found` and `credentials_unavailable` are translated by code.
Parameters are counts and limits only: never secrets, host names or paths.

Errors that have no key yet (mainly low-level storage/file-system failures with technical detail) are shown in
English on purpose; they contain operating-system or file details. New user-facing backend errors should get a
key.

## Checking translations

```powershell
npm run i18n:check
```

It is part of `npm run check` and of CI, runs offline, and fails on: invalid JSON or duplicate keys; a missing or
extra key compared with English; empty values; placeholders (`{{x}}`) or tags that differ from English;
incomplete plural forms for a language; unused (orphaned) keys; unsupported tags or markup characters; Cyrillic in
a Latin-script file; `dangerouslySetInnerHTML` outside the document viewer. `src/i18n/*.test.ts(x)` cover
locale detection, switching without a restart, fallback, interpolation, plurals, formatting, error mapping and
the security-relevant dialogs.

## Correcting or adding a translation

1. Edit `src/i18n/locales/<code>.json` (keep the key, placeholders and tags). For plurals edit every `_form`.
2. Run `npm run i18n:check` and `npm test`.
3. Check the text in the running app (Settings → Appearance → Language). Long German/French strings must not be
   cut off; shorten rather than shrink the text.

Terminology used consistently: connection (подключение / Verbindung / connexion / conexión / veza), session,
terminal, folder (папка / Ordner / dossier / carpeta / fascikla), upload / download, port forwarding, backup,
restore, encryption, authentication, application lock, notes, monitoring. Serbian uses the Latin script and
ekavian standard Serbian terms (not Croatian or Bosnian ones).

A new language needs: a file in `src/i18n/locales/`, an entry in `languages.ts` (`SUPPORTED_LANGUAGES`,
`LANGUAGE_NAMES`, `matchLocale`), the resource in `index.ts`, the value in the Rust list
`SUPPORTED_LANGUAGE_PREFERENCES` (`storage/settings.rs`) and `scripts/i18n-check.mjs`.

## Native dialogs

Operating-system dialogs opened from Rust (the Open/Save file pickers, with their titles and file-type filters) use
English titles. The window title bar, the update installer and the OS keychain prompts belong to the operating
system. Everything PeachTerm draws itself is localized.
