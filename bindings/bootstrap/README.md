# @argusvane/datum-binding-bootstrap

The Bootstrap 5 binding for Datum: it draws Datum's components in getbootstrap.com's own markup, pinned to release 5.3.8 (the `bootstrap-5.3.8` devDependency alias; updating it is a manual refresh). Datum ships none of Bootstrap's files: the host supplies `bootstrap.min.css` (no fonts, no script needed).

Datum is not affiliated with or endorsed by the Bootstrap authors. Bootstrap is theirs; this binding is an independent reference for it.

## What it draws

- Fields: text, textarea, number (a text box with a numeric keyboard, never `type="number"`), select, radios, checkboxes, a single checkbox, a date (three `form-control`s in a `row g-2`: Bootstrap has no date), button.
- Containers: fieldset, button group (a spaced row), tabs (`nav-tabs`), a data grid (`table` in `table-responsive`, or `card`s stacked), steps (`nav-pills`).
- Form level: error summary (an `alert-danger` at `state.headingLevel`), the host's receipt (an alert by kind), the required note, a language switcher (`btn-group`), a journey page's heading (at `PageState.headingLevel`) and buttons.
- Warnings and info as `alert-warning` / `alert-info`, never as errors. A pending check is Bootstrap's spinner beside the form's word, which the renderer folds into the hint (`pending: degraded`); a journey's "worked out" line is form text. The tooltip is `degraded` (Bootstrap's is a script's: the renderer folds the help into the hint).
- Everything else (files, signatures, chrome parts, the submitting line) is Datum's, tinted with Bootstrap's `--bs-*` colours through `fallbackTokens`, and listed in `unsupported()`.

## Tiers

Tier 1 only. Bootstrap has no component whose behaviour differs from Datum's in a way a type would carry: it has no date, and its scripted pieces are not drawn (below). So there is no tier-2 type, no `FormPlugin` and no `tests/tier2/` baseline to sign off.

## The design system's script

None is started. Bootstrap's plugins are delegated from `document` and look their targets up through `document`, and offer no scope, so they cannot run on a form in a shadow root. Every component is drawn as Bootstrap's no-JavaScript markup with no `data-bs-*` attribute; the renderer owns the behaviour (tabs, the count). If the host loads `bootstrap.bundle.min.js` for its page, the form is untouched. Details and every side effect outside the form: [docs/side-effects.md](docs/side-effects.md).

Not drawn: Bootstrap's dark mode (`data-bs-theme`, an ancestor attribute a shadow root's sheet cannot match).

## Use

```ts
import { bindings } from "@argusvane/datum";
import { createBinding } from "@argusvane/datum-binding-bootstrap";

bindings.register(bindings.fromFactory(createBinding), { assets });   // bootstrap.min.css of the one pinned release
```

The package's `exports` point `import` at the TypeScript source (`src/index.ts`), for a bundler that compiles TypeScript. A page without a bundler loads `dist/bootstrap.iife.js` (`npm run build`; the global `DatumBindingBootstrap`), or imports `dist/bootstrap.js`. The CSP and CORS a host page needs are in [docs/host-security.md](../../docs/host-security.md).

## Checks

```
npm run kit:check      # package, build (budgetKb 12), tokens, equality, behaviour, datum-binding-check
npm run checks         # the binding's own browser checks (notices, the script left out, focus, grid, tabs, steps)
npm run checks:hooks   # the form-level hooks and field details drawn into jsdom (needs the build)
```

`reference/*.html` are hand-written: Bootstrap ships no templates (its package is Sass and script), so each case is the markup its documentation writes (getbootstrap.com/docs/5.3/forms, components), the page cited in the file's first comment. A hand-written reference can agree with a wrong binding, so it gates what the binding loses in drawing (wrapper, margins, the shadow root), not attribute correctness. There is no reference for a date or the character count: Bootstrap has neither.
