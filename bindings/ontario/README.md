# @argusvane/datum-binding-ontario

The Ontario Design System binding for Datum: it draws Datum's components in designsystem.ontario.ca's own components, pinned to release 9.2.2 (the `ontario-design-system-component-library-9.2.2` and `ontario-design-system-global-styles-9.2.2` devDependency aliases; updating them is a manual refresh). Datum ships none of Ontario's files: the host supplies the global stylesheet and the component library's script (and the `assets/` and `fonts/` folders beside them).

Datum is not affiliated with or endorsed by the Government of Ontario. The Ontario Design System is theirs; this binding is an independent reference for it.

## What it draws

- Fields: text (`ontario-input`), number (the same, a text box with a numeric keyboard), textarea, select (`ontario-dropdown-list`), radios, checkboxes, button (`ontario-button`), and a date in Ontario's HTML and tokens (tier 2, below).
- Containers: fieldset (`ontario-fieldset`), a data grid (stacked `ontario-fieldset` rows with `ontario-button`s), steps (`ontario-step-indicator` over each step's heading, Back and Continue as `ontario-button`s).
- Form level: the error summary (an error `ontario-page-alert`), the host's receipt (a page alert by kind), the language toggle (`ontario-language-toggle`, for a form in exactly one English and one French locale; any other set of locales gets Datum's switcher), a journey page's heading (at `PageState.headingLevel`, in Ontario's heading class) and buttons.
- Warnings and info as `ontario-callout` (yellow, teal) with the severity word, never as errors. A pending check is `degraded` (the renderer folds its word into the hint; Ontario's loading indicator is unfinished). A tooltip is `drawn` as the component's own field-level hint expander (help opened on demand), its words also describing the box; on the dates it is `degraded` (folded into the hint). The character count `drawn` beside the box (Ontario has none), the worked-out line `degraded`.
- Not drawn: prefix, suffix, placeholder (bar the select's empty option) and a hidden label (the components take none); tabs, a lone checkbox, files, signatures and chrome parts are Datum's, tinted with Ontario's colours through `fallbackTokens` and listed in `unsupported()`. There is no dark scheme (Ontario ships none) and no print or PDF theme yet.
- An English and a French language pack: Ontario's own words where it has them, in its register where it has none. The French is the author's and wants a native reader's pass.

## Tiers

- **Tier 1:** Ontario's own component wherever its behaviour fits.
- **Tier 2:** the date. `<ontario-date-input>` validates by itself when a box is blurred and has no property for an error someone else found (a rule, a date refused by the form), and its value is a timestamp. So `date` is Datum's date in Ontario's markup and tokens (year, month, day), and the official component is the package's `ontarioPlugin` type `ontario-date` (base `date`): it takes Datum's error beside it and has its own check switched off. The first baselines of the tier-2 pictures are the user's to sign off (`tests/tier2/baseline/manifest.json`).

## The design system's script

Ontario's library is Stencil: each element upgrades itself in the form's shadow root, so no scope is needed and the binding has no `connect`. Without the script the elements are inert. One thing reaches past the form: an `<ontario-language-toggle>` writes `<html lang>` of the page and broadcasts `setAppLanguage` to every Ontario component. Every side effect, measured, and what the host provides: [docs/side-effects.md](docs/side-effects.md).

## Use

```ts
import { bindings, plugins } from "@argusvane/datum";
import { createBinding, ontarioPlugin } from "@argusvane/datum-binding-ontario";

bindings.register(bindings.fromFactory(createBinding), { assets });   // the global stylesheet and the component library's script of the one pinned release
plugins.register(ontarioPlugin);                                       // the official date input, ontario-date (base date)
```

The package's `exports` point `import` at the TypeScript source (`src/binding.ts`), for a bundler that compiles TypeScript. A page without a bundler loads `dist/ontario.iife.js` (`npm run build`; the global `DatumBindingOntario`), or imports `dist/ontario.js`. Serve the one pinned release to every form on the page; the CSP, CORS and Trusted Types a host page needs are in [docs/host-security.md](../../docs/host-security.md).

## Checks

```
npm run kit:check         # package, build (budgetKb 14), equality, behaviour, tests/checks.mjs, datum-binding-check
npm run checks            # the binding's own browser checks (notices, descriptions, count, number, dates, steps)
npm run checks:hooks      # the form-level hooks and adapter answers drawn into jsdom (needs the build)
npm run test:official-date   # datum-binding-check with the official date drawing every `date`
```

`reference/*.html` are hand-written: Ontario ships Stencil components with no template files, so each case is the components' documented use (designsystem.ontario.ca, the library's readmes and sources), the pages and props cited in each file's `source`. A hand-written reference can agree with a wrong binding, so it gates what the binding loses in drawing (wrapper, margins, the shadow root), not attribute correctness. Ontario has no component to reference for the date, the count, the notices, the grid or the steps: those are covered by `tests/checks.mjs` and the tier-2 baselines.
