# @argusvane/datum-binding-alberta

The Alberta Design System binding for Datum: it draws Datum's components in design.alberta.ca's own components, pinned to release 3.2.0 (the `abgov-web-components-3.2.0` devDependency alias; updating it is a manual refresh).

Datum is not affiliated with or endorsed by the Government of Alberta. The Alberta Design System is theirs; this binding is an independent reference for it.

| | |
|---|---|
| `src/` | the binding (`createBinding(lit, datum)`) and `albertaPlugin`, the package's FormPlugin |
| `reference/*.html` | the design system's markup per case, each citing its source (the kit's equality gate); `reference/generate.mjs` writes them |
| `tests/` | tier-2 cases and their baselines (`tests/tier2`), extra probes (`extras.mjs`, `host.ts`) |
| `docs/side-effects.md` | what the binding and the design system's script do outside the form |

## Two tiers

1. **Tier 1, the official component.** text and number (`goa-input`), textarea, select (`goa-dropdown`, native), radios (`goa-radio-group`), checkboxes (`goa-checkbox-list`), a lone checkbox, button, each inside a `goa-form-item`; a data grid (`goa-table`, or stacked fieldsets); the error summary and the host's receipt (`goa-callout`); a journey page's heading and buttons (`goa-button-group`); a field's warnings and info (`goa-callout`, low emphasis).
2. **Tier 2, Datum's component in Alberta's pieces and tokens.** The date (a fieldset whose legend, help text and error are written as `goa-form-item` writes them, around a month dropdown and day and year boxes), a named group, the character count, and Datum's tabs and steps in `goa-tabs`' tokens. The tier-2 CSS (`src/css.ts`) is written from Alberta's tokens and counted in `budgetKb`. The official `<goa-date-picker>` is the plugin's `goa-date-picker` (base `date`) and the dropdown's own listbox is `goa-dropdown` (base `select`).

Everything else (files, signatures, tabs, steps, a language switcher, chrome parts, the submitting line) is drawn by Datum's adapter tinted with Alberta's tokens (`fallbackTokens`) and reported by `unsupported()`.

## Use

```ts
import { bindings, plugins } from "@argusvane/datum";
import { createBinding, albertaPlugin } from "@argusvane/datum-binding-alberta";

bindings.register(bindings.fromFactory(createBinding), { assets });   // index.css and index.js of the one pinned release (and Ionicons for goa-icon)
plugins.register(albertaPlugin);                                       // Alberta date picker, Alberta dropdown
```

The package's `exports` point `import` at the TypeScript source (`src/index.ts`), for a bundler that compiles TypeScript. A page without a bundler loads `dist/alberta.iife.js` (`npm run build`; the global `DatumBindingAlberta`), or imports `dist/alberta.js`. Serve the one pinned release to every form on the page; the CSP, CORS and Trusted Types a host page needs are in [docs/host-security.md](../../docs/host-security.md).

English is the only language Alberta words its components in; a form's own `texts` translations word the rest (`src/texts.ts`).

## Checks

```
npm run kit:check          # package, build, equality (reference/ and tier-2), behaviour, datum-binding-check
npm run test:extras        # probes beyond the corpus (plugin types, notices, pending, buttons, date order, receipt, summary, grid, read-only)
npm run test:page          # a journey page's heading level and buttons
```

Tier-2 baselines are written only with `--update-baseline` and need a person's sign-off in `tests/tier2/baseline/manifest.json` (reviewer, date); until then those cases fail.
