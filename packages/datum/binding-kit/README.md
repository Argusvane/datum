# The binding kit

Authoring tests for design-system bindings (`bindings/<id>`), and the tools to write one. The guide
is [docs/binding-authoring.md](../../../docs/binding-authoring.md); this is the map of the folder.

| file | what it is |
|---|---|
| `check.mjs` | `kit:check`: package block, build, token contract, binding lint (what the renderer would ignore silently), equality, behaviour, the package's own checks (`datumBinding.checks`), `datum-binding-check` |
| `build.mjs` | bundles a package (ES + IIFE) and gates: no imports, no lit-html, `budgetKb` |
| `equality.mjs` | the drawing against the design system's own markup (`reference/*.html`); tier-2 types against their own baselines |
| `behaviour.mjs` | back/forward without the page cache, autofill, host element moved in the DOM |
| `conformance.ts` | delegates to `datum-binding-check` in `@argusvane/datum-conformance-suite` (one definition of "conforms"); takes an id, `datum` or a package folder (`.`) |
| `serve.mjs` | a viewer: reference in the document, reference in a shadow root, the binding, side by side |
| `tokens.mjs`, `lib/token-units.mjs` | the token contract pattern (GCDS): `tokens.json` checked against the pinned release; px/rem/pt only to PDF points |
| `lib/` | session (esbuild build, server, Playwright), reference files, comparison, tier-2 baselines, ports |
| `page/kit-page.js`, `host/entry.ts` | the page side and the extra host module the session builds with the suite's |

```
node packages/datum/binding-kit/check.mjs --binding govuk
node packages/datum/binding-kit/check.mjs --binding datum     # npm run kit:check:datum here
node scripts/new-binding.mjs <id> --design-system "Name" --release 1.2.3 --package @scope/ds [--dir path]
# a package outside bindings/ names itself to the kit as --binding . (the scaffold writes its scripts so)
```

The kit runs offline. A design system's stylesheet that reaches a third party at load time (GCDS
imports Google Fonts) would draw the kit's pictures from whatever that host answers on the day, so
the browser the kit opens (`lib/session.mjs`, and the suite's command through `--offline`) answers
or refuses it. `binding-check.json` lists `routes` (a URL, or the start of one, answered from the
binding's own pinned packages: `stylesheets`, or `files` mirroring a CDN folder) and `network`
(a host that no pinned package replaces, with the reason; reported as a known network dependency).
`known` lists the cases (of the behaviour suite or the conformance suite) that fail because of a defect of
the design system itself, each `{ case, reason, since }`: a binding never works around such a defect, so the
run reports the case as `known` with its reason, counted apart from pass and fail, and the step exits 0 when
only known cases are left. A listed case that passes fails the step ("listed as known but passes: remove it"),
and an id that matches no case of either suite fails the `package` step. Any other request outside the kit's server is aborted and fails the step, naming the URL. The
logic is one module, `conformance-suite/binding-check/lib/routes.mjs`; the guide has the shape
([section 6](../../../docs/binding-authoring.md)). `serve.mjs` is a viewer for your own browser and
is not restricted.

Everything is Playwright (Chromium installed here; Firefox and WebKit by `--browser` when
installed). Ports 5200-5219. Exit codes: 0 pass, 1 a case failed, 2 usage error or nothing
asserted, 3 preflight, 4 internal. Tests of the kit's own pieces: `npm run kit:test` (vitest).
