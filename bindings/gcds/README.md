# @argusvane/datum-binding-gcds

The GC Design System binding for Datum: it draws Datum's components in design-system.canada.ca's own markup, pinned to release 1.7.0 (the `gcds-components-1.7.0` devDependency alias; updating it is a manual refresh).

Datum is not affiliated with or endorsed by the Government of Canada. The GC Design System is theirs; this binding is an independent reference for it.

| | |
|---|---|
| `src/` | the binding (`createBinding(lit, datum)`) and `gcdsPlugin`, the package's FormPlugin |
| `print/` | the print theme, the worked example of a design system's paper (styled from the tokens, no script) |
| `pdf/` | the PDF theme (`pdfThemes.register(gcdsPdfTheme)`), the binding's suggestion (`pdfTheme: "gcds"`) |
| `tokens.json` | the token contract: every `--gcds-*` the package reads, with its unit; `scripts/generate-tokens.mjs` cuts it and `pdf/tokens.generated.ts` from the pinned release |
| `reference/*.html` | the design system's markup per case, each citing its source (the kit's equality gate) |
| `tests/` | tier-2 cases and their baselines (`tests/tier2`), extra probes (`extras.mjs`), print and PDF checks |
| `docs/side-effects.md` | what the binding and the design system's script do outside the form |

## Two tiers

1. **Tier 1, the official component.** text and number (`gcds-input`), textarea, select, radios and checkboxes (two options or more), a lone checkbox (`gcds-checkboxes` with one option), group (`gcds-fieldset`), panel (a `section` named by `gcds-heading`, its hint a `gcds-hint`, plain unless the author ticks a look), data grid (stacked `gcds-fieldset` rows with `gcds-button`s), steps (`gcds-stepper`), button, the error summary, the host's receipt (`gcds-notice`), the language toggle, a journey page's heading and buttons.
2. **Tier 2, Datum's component in GCDS's HTML and tokens.** The date (a fieldset of Month / Day / Year in the design system's label, hint and error pieces; month first in English), a text or number field with a prefix or suffix, and the character count beside a field. The tier-2 CSS (`src/css.ts`) is written from the tokens and counted in `budgetKb`. The official `<gcds-date-input>` is the plugin's `gcds-date` (base `date`).

A panel's looks (`panel-plain`, the default, `panel-outlined`, `panel-shaded`, `panel-card`) are the binding's `cssClasses`, shared with every binding that declares them and written in `src/css.ts` from `--gcds-*` tokens; `tests/panel.test.ts` holds the markup and keeps the declarations equal to the engine's.

Everything else (tabs, files, signatures, button groups, radios or checkboxes with fewer than two options) is drawn by Datum's adapter tinted with GCDS's tokens (`fallbackTokens`) and reported by `unsupported()`.

## Use

```ts
import { bindings, pdfThemes, plugins } from "@argusvane/datum";
import { createBinding, gcdsPlugin } from "@argusvane/datum-binding-gcds";
import { gcdsPdfTheme } from "@argusvane/datum-binding-gcds/pdf";
import { gcdsPrintTheme } from "@argusvane/datum-binding-gcds/print";

bindings.register(bindings.fromFactory(createBinding), { assets });   // gcds.css and gcds.esm.js of the one pinned release
plugins.register(gcdsPlugin);                                          // GC date, header, card, link, details, notice, icon
pdfThemes.register(gcdsPdfTheme);                                      // the binding's paper
form.printTheme = gcdsPrintTheme;                                      // print: the same stylesheet, never the script
```

The package's `exports` point `import` at the TypeScript source (`.` at `src/binding.ts`, `./print` at `print/index.ts`, `./pdf` at `pdf/index.ts`), for a bundler that compiles TypeScript. A page without a bundler loads `dist/gcds.iife.js` (`npm run build`; the global `DatumBindingGcds`), or imports `dist/gcds.js`; the print and PDF themes have no built bundle. A server host maps the binding to the PDF theme in its catalog instead (`datum.bindings.catalog.gcds.pdf-theme=gcds`, and the theme object as JSON under `datum.bindings.pdf-themes.gcds`; [docs/binding-authoring.md](../../docs/binding-authoring.md) section 12).

`gcds.css` starts with an `@import` of Google Fonts, which the renderer fetches as well, and GCDS's components load their icon font from `cdn.design-system.canada.ca`: a page's CSP allows both ([docs/host-security.md](../../docs/host-security.md)). Serve the one pinned release to every form on the page.

English and French wording is the binding's own pack (`src/texts.ts`): a form's `texts` translations win over it.

## Checks

```
npm run kit:check          # package, build, tokens, equality (reference/ and tier-2), behaviour, datum-binding-check
npm test                   # the token contract (with its negative cases), the PDF theme, the print filled rendition and the panel, run for real
npm run test:extras        # probes beyond the corpus (number, steps, receipt, plugin, notices, pending, date order, French)
npm run test:print         # the engine's print fixtures printed under the print theme in Chromium
npm run test:official-date # datum-binding-check with the official date component drawing every date
```

Tier-2 baselines are written only with `--update-baseline` and need a person's sign-off in `tests/tier2/baseline/manifest.json` (reviewer, date); until then those cases fail.
