# PeachTerm website — design system

Status: **direction chosen — concept C, "Workspace".** Sections 1–6 are the shared rules; section 7 records the concepts
that were considered; section 8 is the specification the site is built to.

## 0. How this was derived

- **Inputs:** the existing site, the application's own themes (`src/styles/theme.css`, `olive.css`), the real screenshots,
  and the product's character: a small, careful, independent developer tool for Windows, Linux and macOS.
- **OpenDesign** ([nexu-io/open-design](https://github.com/nexu-io/open-design)) was reviewed, not installed. Its useful ideas are
  borrowed as _conventions_: a plain-Markdown `DESIGN.md` as the single source of design truth, tokens written once and referenced
  everywhere, and a written "anti-AI-slop" checklist (section 2). Its application, agents and cloud services are not needed for a
  four-section static site, and adding them would contradict the "minimal dependencies" rule. This file follows the same shape
  (prose + tokens) so it can be dropped into that tool later without rewriting.

## 1. Identity

PeachTerm is a **tool, not a startup**. The site should read like the manual of a good instrument: precise, calm, a little austere,
with the real application as the hero. Three words: _exact, quiet, tactile_.

- The application window is always the biggest, most carefully presented thing on screen.
- Typography and layout do the work that decoration usually does.
- One accent color, used sparingly. The rest is a controlled range of neutrals.
- Echo the application: thin rectangular borders, small radii (0–2 px), compact density, flat surfaces with a hint of bevel.

## 2. Rules and anti-patterns (checklist)

Adapted from OpenDesign's `craft/anti-ai-slop.md`; each item is checkable by eye or by `grep`.

1. No gradients on backgrounds or buttons. (A single, very quiet radial tint behind a hero is the most that is allowed — and the
   preferred answer is none.)
2. No glow, no blur-glass, no big colored shadows. A shadow is allowed only to lift a screenshot off the page.
3. The accent color appears **at most twice per screen** (one primary action, one small marker). No accent-colored buttons in rows.
4. No emoji or stock icons as feature markers. Numbers, labels or nothing.
5. No rounded "card with colored left border". Use rules (1 px lines) and whitespace instead of boxes.
6. No invented metrics, testimonials or logos. Copy states only what exists in the repository.
7. No fake interfaces: every picture of the product is a real screenshot from the packaged application (demo data only).
8. No centered-everything hero with a pill badge, and no "hero → 3 cards → CTA" skeleton. Vary density; allow asymmetry.
9. No decorative illustrations or abstract blobs.
10. Motion: none by default. Hover/focus state changes only; everything respects `prefers-reduced-motion`.
11. Copy: plain, specific, verbs first. "Download" beats "Get started for free". Say "No public release yet" when true.

## 3. Typography

| Role             | Rule                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display (h1)     | One size per concept, `clamp()` between mobile and desktop; tight tracking (−0.02 to −0.04 em); ≤ 2 lines                                                                                                           |
| Section heading  | 1.4–2.3 rem, same family as display                                                                                                                                                                                 |
| Body             | 15–16 px, line height 1.6–1.7, max measure 62–68 characters                                                                                                                                                         |
| Labels, captions | 11–13 px, monospace, uppercase only for short labels with 0.08–0.1 em tracking                                                                                                                                      |
| Fonts            | Only **self-hosted** or system fonts. No Google Fonts, no external CDN. JetBrains Mono (OFL, 21 KB per weight, the font bundled in the app) is the only web font allowed; serif display uses the system serif stack |
| Weights          | 400 and 700 only                                                                                                                                                                                                    |

## 4. Spacing and grid

- Base unit **8 px**; scale 4, 8, 12, 16, 24, 32, 48, 64, 96. Section padding 56–84 px desktop, 40–56 px mobile.
- Content width 1120–1280 px with 20–32 px gutters; 12 columns with a 24 px column gap on desktop; single column below 900–960 px.
- Prefer hairline rules (1 px) over boxes to separate content. Keep generous vertical rhythm, but no section may be mostly empty.

## 5. Components

| Component     | Rule                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Button        | Rectangular, radius 0–2 px, 1 px border, 13–16 px label, ≥ 40 px tall. One primary per view; secondary is outlined/quiet |
| Link          | Underlined (offset 3 px) or clearly differentiated; never color alone                                                    |
| Navigation    | Compact (≤ 36–56 px). Anchors only. On mobile either a horizontal scroll strip or a toggle with `aria-expanded`          |
| Table         | Hairline rules, left-aligned, small caps header; scrolls inside its own container on mobile                              |
| Notice        | A tinted block with a 1 px border, used for the single "no public release yet" / "unsigned" statements                   |
| Focus         | 1–2 px outline in the accent or ink color, 2–3 px offset, always visible                                                 |
| Tabs (themes) | `role="tablist"`, arrow-key navigation, `aria-selected`; shows screenshots only                                          |

## 6. Screenshots

- Real, 1440×900 captures from the packaged Windows build, connected to a throw-away demo server. Demo data only (host `127.0.0.1`,
  user `demo`). Re-capture rather than edit.
- Delivered as WebP: full size plus a 720 px thumbnail; always with `width`/`height` (no layout shift), `loading="lazy"` below the fold.
- Presentation: a 1 px border, optionally a short title strip ("PeachTerm — Industrial Olive") and a caption that says what is
  shown. Never crop the application chrome, never tilt, never mock up a device.
- The first screenshot is large and appears above the fold on desktop; every theme appears at least once.
- Alt text describes the scene and the theme.

## 7. Concepts that were considered

Three directions were prototyped with identical copy and screenshots and compared in the browser:

- **A — Field Manual:** Industrial Olive as a technical manual (sticky numbered index, spec lists, "plates"). Recommended by the
  designer for its originality; not selected.
- **B — Editorial Plates:** light paper, serif display, full-bleed Source Gray plates, a contact sheet of all four themes.
  Not selected.
- **C — Workspace:** the page built like the application. **Selected.**

The prototypes were removed after the decision.

## 8. Chosen direction — C, "Workspace"

The page is built like PeachTerm itself: a **tab bar** for navigation, content in **panes with headers** separated by 1 px
dividers, the hero as a two-pane split (text pane beside the real window), `[ bracketed ]` buttons, and a **status-bar footer**.
Everything is monospace (JetBrains Mono, the font bundled in the application). The peach accent appears only on the active tab,
the primary button and the focus ring.

### Tokens (single `:root` block in `src/style.css`)

| Token       | Value                           | Use                                    |
| ----------- | ------------------------------- | -------------------------------------- |
| `--bg`      | `#121212`                       | page                                   |
| `--bar`     | `#181817`                       | tab bar, pane headers, notices, footer |
| `--pane`    | `#161615`                       | reserved                               |
| `--line`    | `#2d2b28`                       | dividers (1 px)                        |
| `--line-hi` | `#4a4640`                       | button borders, hover edges            |
| `--text`    | `#f1ede8`                       | headings, body                         |
| `--text-2`  | `#bfb8af`                       | secondary text (9.5:1)                 |
| `--text-3`  | `#968f86`                       | captions, labels (5.9:1)               |
| `--peach`   | `#f6a07a` (on-accent `#1a0f08`) | active tab, primary button, focus      |
| `--ok`      | `#86c08f`                       | status dots, "tested" cells            |
| radius      | 2 px (buttons), 0 elsewhere     |                                        |

### Structure

| Area        | Rule                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tab bar     | 36 px, sticky; brand, five anchor tabs, GitHub link. The tab of the section in view is marked `on` (2 px peach line, `aria-current`). On narrow screens it scrolls sideways; there is no hamburger                                               |
| Panes       | `.pane` = header (28 px, status dot, title, right-aligned note) + body. Grids: `.split` (5fr/8fr), `.split-wide-left` (8fr/5fr), `.trip` (3 equal), `.duo` (2 equal). Dividers are the panes' own borders; below 960 px everything is one column |
| Hero        | Left: h1, lead, two buttons, fine print. Right: the real split-view screenshot (`fetchpriority=high`, `srcset`) with a pane header listing the three open sessions                                                                               |
| Features    | Three panes of hairline-separated lists; no cards                                                                                                                                                                                                |
| Screenshots | Six real screenshots in a two-column grid of panes, each a `<button>` that opens a lightbox (`<dialog>`, arrows, Esc, focus returns)                                                                                                             |
| Themes      | A pane with `role="tablist"` (Dark, Light, Industrial Olive, Source Gray) swapping real screenshots                                                                                                                                              |
| Download    | Platforms table + a notice; the notice or the file list is generated at build time from the latest GitHub release                                                                                                                                |
| Footer      | Status bar: copyright and license, version if a release exists, GitHub, Releases, License, Report a bug                                                                                                                                          |

### Checklist result (section 2)

No gradients or glow; accent used on the active tab, one button and focus only; no emoji or stock icons; no cards with colored
borders; no invented metrics; every product picture is a real screenshot; asymmetric split layouts; no animation (smooth scroll only,
disabled under `prefers-reduced-motion`).

## 9. Implementation notes

- Vite + TypeScript, no runtime dependencies. Fonts: the two JetBrains Mono `woff2` files (weights 400, 700) and the OFL text
  live in `site/public/fonts/`; `font-display: swap`; only the 400 weight is preloaded.
- Tokens live in one `:root` block; the only raw colors outside it are the lightbox backdrop and the black image matte.
- Preserved from the first version: download area rendered at build time, lightbox, theme tabs, relative base path,
  canonical/OG tags, `check:links`.
- Verified at 1440 and 390 px (no horizontal overflow); keep verifying 1024/768 when changing the grid.
