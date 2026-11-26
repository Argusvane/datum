# Datum marketing site

The public face of Datum: a static site built with Vite and deployed to GitHub Pages by
GitHub Actions. It has no `file:` dependency on the engine or on any package in
this repository, but its type check and its tests import the engine's sources and each binding's pinned
design-system release, so those folders need their own `npm ci` first (below); the home page's live demo
loads the built bundles copied in at build time.

Pages: `index.html` (home: the hero comes in two versions with a switch between them, a framed
video of the builder and a form it made (the default, `src/hero-video.ts`, its files in `public/video/`)
and the slide deck whose first slide names three ways to use Datum, run it, embed it and deliver
it, each row linking to its block on the partners page; the choice is remembered in the browser; then the "By the numbers" findings: the case for Datum
in figures from published studies, filtered by topic chips (form sprawl, who needs it, why now,
others build their own, then by subject), a sector dropdown (twenty-two sectors, from
government to intelligence) and a region dropdown (Canada, the United States, the United Kingdom, Europe,
Australia and New Zealand, Asia, Latin America, worldwide), the three filters combining, and
shown six at a time in a grid that scrolls a row at a time, each figure beside what Datum does
about it and linked to its source (the filters live in the address, `?topic=problem&sector=healthcare#numbers`,
so a filtered view is a link; the partners page links each route's figures that way), from `evidence`, `evidenceTopics`, `evidenceSectors`,
`evidenceRegions` and `evidenceLabels` in `src/pillars.ts`,; then the "Overview" section:
each problem a sprawl of forms causes and what Datum does about it; the live demo; the
"One definition" usage map; and a closing ask to bring one form to the demo), `features.html` (the fifteen capabilities, each a
sentence, a short list of specifics and an animation), the live example pages under one "Examples" nav entry
and a shared sub-navigation strip (Bindings, and a link to the docs' Live examples at `docs/examples`): `bindings.html` with one `binding-<id>.html` per reference binding (each drawn live, with its
measured numbers), `partners.html` (the three routes, each by who it
is, what they have today, what Datum gives them and where to start, then the standards Datum
works with; no programme terms, since there is no programme). The nav's "Docs" entry leads to the docs site under `docs/` (below). The marketing pages sell and show; how to configure, host and run Datum is the docs site's to say, and the marketing pages link there instead of repeating it. All
copy lives in `src/pillars.ts` (`pillars`, `advantages`, `demo`, `partners`,
`partnerLabels`, `partnerStandards`,
`GITHUB_URL`, `CONTACT_EMAIL`); `src/render-pillars.ts`, `src/render-content.ts` and
`src/render-demo.ts` fill the `[data-*]` containers from it. Adding a page means adding it to `vite.config.ts` and to the page list in
`test/build.test.ts`. Each capability on the features
page has a small CSS-only animation: its markup is a `<template id="scene-<id>">` in
`features.html`, cloned into the section by `src/render-pillars.ts`, and its styles are in
`src/scenes.css`, which `scripts/gen-scenes-css.py` generates (edit the script, then re-run
it). The hero animation on the home page is hand-written in `src/styles.css`. The look is light by default with
a dark toggle (`data-theme="dark"` on `<html>`, kept in local storage); tokens are at the top of `src/styles.css`.

## The docs site

`docs/` is the documentation site, a [VitePress](https://vitepress.dev) site served under the
marketing site at `<base>docs/`. It is written for the site, page by page, and does not render the
repository's own `../docs/` folder. `docs/.vitepress/config.ts` holds the nav, the sidebar and the
base path (`SITE_BASE` + `docs/`, the same variable the marketing build reads); the theme under
`docs/.vitepress/theme/` puts the marketing site's tokens and typefaces on VitePress's default
theme. The tree is flat on purpose: the nav's "Site" entry is the relative link `../` with a
`target`, which is what gets the docs router to hand the click to the marketing site, and it
resolves to the site root only from one level down. Adding a page means adding the Markdown file
and its sidebar entry. The one part not written by hand is the element reference: the attribute,
property and event tables on the three element pages are partials under `docs/_generated/`, written
by `npm run docs:reference` (`scripts/gen-docs-reference.mjs`) from the repository's
`../docs/reference/attributes.json` and included by the pages; run it after that file changes.
`test/docs-reference.test.ts` fails when a partial is stale, when a method of an element is missing
from its page, when a page is not in the sidebar, or when a page links to one that does not exist.
`npm run build` builds the docs after the marketing pages into
`dist/docs/`, so one Pages artifact carries both; `test/build.test.ts` builds them the same way
and checks the base path, the back link and the content rules on the docs pages too. In
development `npm run dev` (`scripts/dev.mjs`) starts the docs' own server on port 5174
(`DOCS_DEV_PORT`) and the marketing server on 5173, which forwards `/docs` there, websocket
included, so the Docs link works on 5173 as it does on the built site; `npm run dev:site` is the
marketing server alone, and `npm run docs:dev` the docs alone on VitePress's own port, 5173 (`npm run docs:dev -- --port 5174` matches the proxy).

## Run it

```sh
npm run site:setup   # at the repository root: npm ci in engine, in every bindings/<id> and in site
cd site
npm run demo-assets  # copies the built bundles in for the live demo (see below); optional
npm run dev          # http://localhost:5173, the docs under /docs/ proxied from their own server on 5174
npm run dev:site     # the marketing pages alone
npm run docs:dev     # the docs site alone, http://localhost:5173/docs/
npm run build        # dist/, with the docs site under dist/docs/
npm run docs:build   # the docs site alone, into dist/docs/
npm run preview      # serves dist/ on http://localhost:4173
npm test             # builds under a project-pages base path and checks the output
```

From the repository root the same commands are `npm run site:dev`, `site:build`,
`site:demo-assets`, `site:preview`, `site:typecheck` and `site:test`.

## The binding pages

`bindings.html` lists Datum's own theme beside the nine reference design-system bindings; `binding-datum.html` and `binding-<id>.html` (gcds, govuk, uswds, bootstrap, nova-scotia, alberta, quebec, ontario, fluent) are one page each, filled by `src/render-bindings.ts` from `src/bindings.ts` (the copy) and `src/binding-facts.json` (the numbers). The scope the words keep: Datum ships one official theme; a design-system binding is a reference, a demo and a starting point with no support promise, and no page says one is accessible. A page's title and description are in its HTML file; `test/binding-pages.test.ts` holds them to the data.

The numbers are what `kit:check` measured, not typed in: run `node packages/datum/binding-kit/check.mjs --binding <id> --report <dir>/report-<id>` for each binding and for `datum`, then `npm run binding-facts -- <dir>` writes `src/binding-facts.json` (release and size budget come from the packages, equality, behaviour and conformance counts from the reports). The test checks the release and budget against `bindings/<id>/package.json` and that every run was green: no failure in either suite. A case a binding declares `known` (a defect of the design system itself, `known` in its `binding-check.json`) is counted apart in the numbers as `known`, listed with its reason under `knownDefects`, and shown on the binding's page under the numbers; the test requires a reason for each.

Each page's live form needs files `scripts/copy-binding-assets.mjs` puts in `public/demo/bindings/` (gitignored; `npm run demo-assets` runs it after `copy-demo-assets.mjs`): each binding's IIFE from `bindings/<id>/dist` (`npm run build` there), and the design system's own files from the pinned release in `bindings/<id>/node_modules`, only those `scripts/binding-assets-spec.mjs` lists, with its redactions and a `NOTICE.txt` per package, and a `manifest.json` the page reads. What the licences keep out is left out: GDS Transport and the GOV.UK crest (the stylesheet's `@font-face` rules and crest references are removed, and the GOV.UK page says the form falls back to Arial), the Government of Québec signature, the Ontario logo, trillium and supergraphic, the GC signature and the Alberta header logos. The page makes each binding with `datum-form.js`'s own `bindings.fromFactory`, as a host does, so no second lit is loaded. The copy fails when a redaction no longer matches what it expects, and when `scripts/published-scan.mjs` finds GDS Transport or one of those marks anywhere in `public/demo/`. Without the bindings built, `npm run build` still builds and each page shows its fallback paragraph.

## The live demo

The home page's "Try it" section is the real `<datum-form-builder>` over the real
`<datum-form>`, from `packages/datum/dist`, with the Font Awesome icons plugin bundle from
`plugins/icons-fontawesome/dist`.
`scripts/copy-demo-assets.mjs` copies an allowlist of those folders into `public/demo/` (gitignored). The engine's part is: the builder module, which defines
both elements, with its lazy chunks (the PDF executor, the page imagery), its companion sheet,
the PDF module the form's PDF button loads beside it, the fonts that module embeds, the
pdf.js data the page imagery reads (about 16 MB, all fetched on demand). Build the bundles first (`npm run build` in
`packages/datum` and in `plugins/icons-fontawesome`, or `npm run datum:build` and
`plugins:build` at the root), then
`npm run demo-assets` here; a plugin whose `dist` is missing fails the copy and names the package. The script builds nothing. `npm run build` runs the copy with `--if-present`, so a checkout
without the bundles still builds and the section shows its fallback paragraph; the CI and
Pages jobs run it strictly after building the bundles. `src/render-demo.ts` loads the module
with a module script tag under the site's base path once the section nears the viewport (not
`import()`: the dev server routes dynamic imports through its module pipeline and refuses a
file under `public/` there), hands the chosen example form from `src/demo-forms.ts` (six, simplest first, the last two journeys over one form, one of them on a single page, with a journey-only alias and a worked-out value) to both elements, and
forwards `datum-builder-change` to the form. The builder keeps its own controls: New, Open and
Download lead its bar, its documents dropdown opens each PDF layout, and its View
panel holds the canvas's controls. Its light and dark mode follows the site's, one way (`followSiteScheme`): the header's
toggle (`src/site-theme.ts`) sets the builder's `scheme`, the builder's own Dark mode item changes the
builder alone, and the form on its canvas follows the builder's scheme. A bar above it
holds the example picker, a View picker shown only while the form in the builder has journeys ("As the form opens", "Whole form", each journey by name; it sets the form's `journey` attribute, follows the builder's edits and goes back to "As the form opens" on Reset or another example), and Reset, which reloads the example into the builder and the form; the renderer
section under it has tabs for the form, its data (values as they settle, the submission
envelope once sent) and the schema, plus a "Form chrome" menu
(logo, title, description, footer note, language switcher placement, frame preset, applied
as the element's `chrome`), Print, which opens the browser's print dialog with the form's
read-only rendition, and PDF, which opens the rendered PDF in the browser's viewer in a dialog. The sandbox module,
`datum-wasm.js`, is copied beside the builder; it is fetched only when an author turns on WebAssembly
validation in Try it.

## Where it is served from

The build takes its base path from the `SITE_BASE` environment variable:

| Hosting | `SITE_BASE` | Notes |
|---|---|---|
| Custom domain, or user/organization pages | `/` (the default) | The site is served at the root of https://datum.argusvane.com. The domain is set under Settings → Pages. |
| Project pages, `https://<owner>.github.io/<repo>/` | `/<repo>/` | The workflow passes `/` unless a `SITE_BASE` repository variable (Settings → Secrets and variables → Actions → Variables) is set, so set it to `/<repo>/`. |

Asset URLs are rewritten for the base path by Vite. Links between the two pages are relative
(`./features.html`), which works under any base; `test/build.test.ts` checks that nobody
adds a root-absolute page link.

### Link previews

Every page carries Open Graph and Twitter tags and a canonical link, written at build time by
`share-cards.ts` (a Vite plugin) from the page's own `<title>` and meta description, so a shared
link shows the words the page shows; change those two and the preview follows. A preview's image
and address must be absolute, so they come from the site's full address: `SITE_URL` when it is set
(base path included), else the origin in `site.json`, https://datum.argusvane.com, under
`SITE_BASE`. The Pages workflow passes the `SITE_URL` repository variable when one is set; without it, a build serves from the origin under `SITE_BASE`.
The last build step, `scripts/write-crawl-files.mjs`, writes `sitemap.xml` (every marketing page
and every docs page, as absolute addresses on the same origin) and `robots.txt` into `dist/`. The cards are `public/og/datum.png` (every page) and
`public/og/partners.png` (the partners page), 1200 x 630, drawn in the site's look by
`node scripts/render-share-cards.mjs` (a local Chrome over the DevTools protocol; `CHROME`
names the binary). They are committed: re-run the script after changing a card's words, which
live in the script.

The docs pages carry the same tags, written by `transformHead` in `docs/.vitepress/config.ts` (the page's title and
description, its clean address and the site's card).

### Every page's shell

`page-shell.ts` (a Vite plugin) adds a "Skip to content" link to each marketing page and the `id` on `<main>` it jumps to
(the docs' theme has its own skip link). On the binding pages, whose copy `src/render-bindings.ts` draws, it also writes the
non-affiliation sentence (`src/non-affiliation.ts`) into the `<noscript>` fallback, so a reader or crawler that runs no
script finds it in the HTML. `404.html` is a marketing-look page Pages serves for any address that is no page; it sits at the
artifact root, links from the base path (the address asked for could be anywhere), and is left out of the sitemap.

## Deployment

`.github/workflows/pages.yml` builds `site/` and deploys `site/dist` as a Pages artifact with
`actions/deploy-pages` when a maintainer runs it by hand from the Actions tab; no push
deploys the site. One-time repository setup:

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. For project pages, set the `SITE_BASE` repository variable to `/<repo>/`: the workflow serves from `/` otherwise.
3. Set the custom domain, datum.argusvane.com, under Settings → Pages.

The workflow does not create a `gh-pages` branch; the artifact is deployed directly.
`public/.nojekyll` is copied into the output so the site is served as-is even if the Pages
source is ever switched back to a branch.

## Content rules

- The site names requirements, never audiences: deterministic, sandboxed, signed, PAdES, PIV,
  PKI, WebAuthn, PDF/A, air-gapped, open source (MIT). The site sells no tier: the one line
  about paid help is the footer's, commercial support and services from Argusvane.
- Accessibility is stated as automated checks only ("No automated findings (axe 4.14.1)"); the
  site makes no conformance claim and no claim for a design-system binding.
- The pages' own markup and stylesheets load nothing from a third party, on the marketing pages
  and the docs alike: the three typefaces are files under `public/fonts/` (with their licence
  texts), and `test/build.test.ts` scans the built pages and sheets for any other origin. The docs
  get the faces from `@font-face` rules `docs/.vitepress/config.ts` copies from `src/styles.css`.
  "Nothing is fetched" is a claim about Datum and its own theme: a binding page's design system
  brings its own files, and the page lists what they fetch (`network` in `src/bindings.ts`).
- Every page's footer names the licence, the repository, the security policy and the contributing
  guide, and says where to write about commercial support.
- The order of the capabilities on the features page is fixed in `src/pillars.ts`. The home page
  does not repeat the list: its Overview section links to the features page instead.
- `GITHUB_URL` in `src/pillars.ts` is the one address of the repository; links that carry `data-github` or `data-github-file` take it.
