# ADR 0067: The Marketing Site in site/

## Status

Accepted.

## Context

The README is an engineering document and `docs/` holds decision records and guides. The product
needs a public page that says what it is, in its own terms, and that can be hosted for free from
the repository.

Every other project in the repository is a Vite or TypeScript project installed with npm and built
by a hand-written CI job; the packages depend on each other through `file:` links, and a job that
needs the engine installs it first. A site that imported the engine or the packages as dependencies
would inherit that whole chain. A site that never ran the product would only describe it.

The embeddable bundles in `packages/datum/dist` are what a page outside the repository hosts, every
lazy resource they load resolves against the module's own URL, and `check-bundles.mjs` guards their
layering on every build, so a demo built on them is a demo of the shipped files, not of the source.

## Decision

1. **`site/` is a static Vite multi-page app**: HTML entries (home, features, partners,
   bindings, and one page per binding: `datum` and the nine reference
   bindings), one stylesheet, small TypeScript
   modules, no framework. It uses the same toolchain as the rest of the repository. The docs
   site (VitePress) builds into the same artifact under `<base>docs/`.
2. **The site has no `file:` dependency on any package.** The bundles are a build input, not a
   dependency: `site/scripts/copy-demo-assets.mjs` copies an allowlist of built files into
   `site/public/demo/`, which is gitignored.
   - From `packages/datum/dist`: the builder module (it defines both elements) with its lazy chunks
     (the PDF executor, the pdf.js page imagery, the Journeys mode and engine, the small browser
     stubs), its companion sheet, the form module and its agent chunks, the PDF module and the fonts
     it embeds, and the pdf.js data folder.
   - From `packages/datum/dist` too, the sandbox module (`datum-wasm.js`), which the builder's
     previews load beside its own bundle.
   - From `plugins/icons-fontawesome/dist`: the opt-in Font Awesome bundle, loaded before the
     builder.
   - `site/scripts/copy-binding-assets.mjs` then copies what the binding pages load into
     `public/demo/bindings/`: each binding's bundle from `bindings/<id>/dist`, and only the design
     system's files `scripts/binding-assets-spec.mjs` lists, from the pinned release, with a
     `NOTICE.txt` beside each package (GDS Transport and the crest are never copied), plus a
     `manifest.json` of addresses relative to itself.
   - Source maps, the IIFE builds, the typings, the standalone page-imagery module and the server
     programs are left out.
3. **The copy runs in two modes.** `npm run demo-assets` is strict and fails without the
   bundles. `npm run build` runs it with `--if-present`, so a checkout that never built the
   bundles still builds the site and the demo sections show their fallback paragraph. The build
   test asserts the bundles only when they are present or `CI` is set.
4. **The home page runs the shipped product.** `src/render-demo.ts` loads the builder module from `${import.meta.env.BASE_URL}demo/` once the demo section nears the viewport, with a module script tag rather than `import()`: Vite's development server routes dynamic imports through its module pipeline and refuses files under `public/`, while a script element is served as-is in both modes. The builder and the form get the example form as the `definition` property and never as the `src` attribute, which fetches against the page and would depend on the base. Preview PDF opens the rendered PDF over a blob URL that is revoked when the dialog closes, and hides itself when the PDF module is not beside the bundle. With no server behind the page, an accepted submit gets its receipt after a beat, and the form's notice says nothing was sent. The rest of the live demo, and the page's own controls around it, are described in `site/README.md` ("The live demo").
5. **The site's copy is hand-maintained and names requirements, never audiences.** It lives in `src/pillars.ts` (the demo's example forms in `src/demo-forms.ts`); the rules for it are `site/README.md` ("Content rules"). The order of the capabilities on the features page is fixed and changes only on a decision.
6. **Light is the default theme**; a toggle switches to dark and the choice is kept in local storage.
7. **Deployment is GitHub Actions to GitHub Pages** (`.github/workflows/pages.yml`):
   `actions/configure-pages`, `upload-pages-artifact`, `deploy-pages`. The workflow runs only
   when a maintainer starts it by hand from the Actions tab: a deploy publishes the live site,
   so it follows a decision to publish rather than every merge. The job builds the
   packages/datum bundles and the plugin packages the home page's live demo loads, the
   reference bindings the binding pages draw live, then the site.
   - No `gh-pages` branch.
   - The Pages source must be set to "GitHub Actions" once in the repository settings.
   - The Pages and CI jobs build the bundles first through one composite action,
     `.github/actions/build-datum`, which repeats the install chain of the `packages/datum` CI job
     (workflow YAML cannot share steps between workflows).
8. **The live examples are docs pages.** The docs site (decision 1) carries them as native pages under `<base>docs/examples`, loading the same bundles from `public/demo/`; the marketing pages link there from the "Examples" sub-navigation beside the binding demos, and repeat nothing of them.
9. **The base path is an environment variable**, `SITE_BASE`, read by `vite.config.ts` and
   passed by the workflow from a repository variable or the Pages configuration. The default is
   `/`, for a custom domain or user pages; project pages set `/<repo>/`. Page links are
   relative so they work under any base, and a test builds under a project-pages base and
   checks the output.

## Reasoning

A static site with no package dependencies stays cheap to keep green and is the safest thing to
host. Copying the built bundles as an allowlisted build input keeps that property while still
showing the builder and the renderer doing what the copy says. The alternative, importing the
packages, would put the whole `file:` chain in the site's own install and make every engine
change a site dependency change.

## Consequences

- The site's package stays dependency-free of the repository; the trade is CI time: the Pages
  and CI site jobs take the packages/datum install chain.
- The deploy ships megabytes of public files, fetched lazily: the builder module when
  the demo section scrolls near, the PDF module and fonts on the first Preview PDF, the
  designer's chunks on first use, pdf.js data only when a template PDF is opened, a design
  system's files when its binding page opens.
- The home page's demo and the docs site's live examples (decision 8) load the same copied bundles,
  the way a page outside the repository loads the files.
- The copy duplicates facts from the README and the decision records and is maintained by hand.
