# PeachTerm website

The official site of [PeachTerm](https://github.com/endlessnights/peachterm): a small static page
(Vite + TypeScript + plain CSS, about 3 KB of JavaScript) deployed with GitHub Pages. It is independent of the
desktop application: its own `package.json`, no shared code, no backend, no analytics and no third-party
requests (the one font, JetBrains Mono, is self-hosted; no scripts or trackers).

```
site/
├── index.html            page content
├── DESIGN.md             visual identity: rules, tokens, components (read this before changing the look)
├── src/style.css         styles; all colors are tokens in one :root block (PeachTerm's Dark theme)
├── src/main.ts           mobile menu, screenshot lightbox, theme preview tabs
├── src/download.ts       download area, rendered at build time from the real release
├── public/               favicon, social image, screenshots, JetBrains Mono (fonts/, OFL)
├── scripts/              fetch-release, check-links, preview-subpath
└── vite.config.ts        base path and canonical/social URLs
```

## Local development

```powershell
cd site
npm install
npm run dev          # http://localhost:5173, hot reload
```

## Production build

```powershell
cd site
npm run build        # type-checks, looks up the latest release, writes dist/
npm run check:links  # every local file, anchor and image of dist/ exists; alt text and sizes are set
```

`npm run build` asks the GitHub API for the latest published release of this repository (see
[Download links](#download-links)). To build offline: `SITE_OFFLINE=1 npm run build` (PowerShell:
`$env:SITE_OFFLINE=1; npm run build`).

### Test it at a repository sub-path

GitHub Pages serves a project site at `https://<owner>.github.io/<repo>/`. To check that exact situation locally:

```powershell
$env:SITE_BASE = "/peachterm/"
npm run build
node scripts/preview-subpath.mjs /peachterm/ 4399     # open http://localhost:4399/peachterm/
$env:SITE_BASE = "/peachterm/"; npm run check:links
```

The default base is `./` (relative URLs), so the same build also works at the root of a custom domain.
`SITE_BASE` is only needed for this kind of test.

## GitHub Pages deployment

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds `site/` and deploys only `site/dist`.

One-time setup (repository owner): **Settings → Pages → Build and deployment → Source: GitHub Actions.**
Without it, the first deployment fails with a "Pages is not enabled" error.

It runs when `site/**` or the workflow changes on `main`, when a GitHub Release is published (so the download
area follows releases without any code change), and manually (_Actions → Website → Run workflow_). Pull requests
only build the site.

## Download links

The Download button points to `https://github.com/<owner>/<repo>/releases/latest` and the platform table lists the
real files of that release. Both are generated **at build time** by `scripts/fetch-release.mjs` from the GitHub
API (the repository is taken from `GITHUB_REPOSITORY` or the `origin` remote), so no URL or file name is
hard-coded and nothing is requested from the visitor's browser.

While the repository has no published release, the page shows a "No public release yet" message instead of a
download button. When a release is published, the Website workflow runs again and the buttons appear. Draft and
pre-release versions are not offered as "latest".

## Screenshots

Screenshots live in `public/screenshots/` as WebP: a full-size file (1440×900) and a `-720` thumbnail for each.
They were captured from the packaged Windows application connected to a throw-away demo server, with no real
hosts, users or data. To replace one:

1. Capture a 1440×900 PNG of the new scene (use demo data only: no real host names, IP addresses, user names, tokens
   or terminal output).
2. Convert it, for example with Python and Pillow:

   ```python
   from PIL import Image
   im = Image.open("scene.png").convert("RGB")
   im.save("public/screenshots/workspace.webp", "WEBP", quality=82, method=6)
   im.resize((720, 450), Image.LANCZOS).save("public/screenshots/workspace-720.webp", "WEBP", quality=80, method=6)
   ```

3. Keep the file names (or update the references in `index.html` and `src/main.ts`) and run `npm run check:links`.

`public/og.png` (1200×630) is the social-sharing image.

## Theme gallery

The previews in the "Themes" section are the `split-*.webp` screenshots. The list of themes is the `THEMES` table in
`src/main.ts` plus the matching `<button role="tab">` entries in `index.html`. To add a theme: add a screenshot
(`split-<name>.webp`), one table entry and one tab button.

## Custom domain

No custom domain is configured. If you add one later (Settings → Pages → Custom domain, plus a `CNAME` DNS record),
nothing in the site has to change: the build uses relative URLs, and the canonical and social-image addresses come
from the `base_url` that `actions/configure-pages` reports. Do not add a `CNAME` file by hand unless you also set
the domain in the repository settings.

## License

Apache-2.0, like the rest of the project. Copyright 2026 Bakhti Baymukhamedov.
