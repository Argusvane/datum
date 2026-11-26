# @argusvane/datum-binding-quebec

The Québec design system binding for Datum: it draws Datum's components in design.quebec.ca's own
markup (`qc-textfield`, `qc-choice-group`, `qc-checkbox`, `qc-notice`, `button.qc-button`), pinned to
release 1.6.1 (the `qc-trousse-sdg-1.6.1` devDependency alias; updating it is a manual refresh).
Nothing of the design system ships with the binding: the host gives its stylesheet and classic script.

Datum is not affiliated with or endorsed by the Gouvernement du Québec. The Québec design system is theirs; this binding is an independent reference for it.

| | |
|---|---|
| tier 1 | text, number, textarea (`qc-textfield`), radios, checkboxes (`qc-choice-group`), a single checkbox (`qc-checkbox`), a date (three `qc-textfield`s in a fieldset), button, fieldset, button group, a stacked data grid, the error summary and the receipt (`qc-notice`), a journey page |
| tier 2 | `select` is Datum's native select in the toolkit's face; the official listbox is the package type `qc-select` (base `select`, `quebecPlugin`) |
| Datum's own, tinted | tabs, steps, file, signature, chrome parts (the toolkit has none) |
| language pack | English and French (`src/texts.ts`) |
| dark scheme | drawn, through the toolkit's `.qc-dark-theme` class |
| side effects | [docs/side-effects.md](docs/side-effects.md) |

```
npm install
npm run kit:check      # package, build, equality, behaviour, the package's own checks, datum-binding-check
npm run reference      # rewrite reference/*.html
npm test               # tests/extras.mjs
```

The host gives the page's assets as `binding-check.json` does: the stylesheet, and the script as a
classic script with `sdg-css-path` and `sdg-assets-base-path` in its `attributes` (the script reads
`document.currentScript`). The stylesheet's `rem` is the page's root font size: the `rfz100` sheet
expects 16px.

```ts
import { bindings, plugins } from "@argusvane/datum";
import { createBinding, quebecPlugin } from "@argusvane/datum-binding-quebec";

bindings.register(bindings.fromFactory(createBinding), { assets });   // the stylesheet and qc-sdg.min.js of the one pinned release
plugins.register(quebecPlugin);                                        // the official listbox, qc-select (base select)
```

The package's `exports` point `import` at the TypeScript source (`src/index.ts`), for a bundler
that compiles TypeScript. A page without a bundler loads `dist/quebec.iife.js` (`npm run build`;
the global `DatumBindingQuebec`), or imports `dist/quebec.js`. Serve the one pinned release to
every form on the page; the CSP, CORS and Trusted Types a host page needs are in
[docs/host-security.md](../../docs/host-security.md).

Tier-2 baselines (`tests/tier2/baseline/`) are recorded with `--update-baseline` and need a human
sign-off in `manifest.json` before `kit:equality` passes them.
