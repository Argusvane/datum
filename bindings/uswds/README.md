# @argusvane/datum-binding-uswds

The U.S. Web Design System binding for Datum: it draws Datum's components in designsystem.digital.gov's own markup, pinned to release 3.14.0 (the `uswds-3.14.0` devDependency alias; updating it is a manual refresh).

Datum is not affiliated with or endorsed by the U.S. General Services Administration. The U.S. Web Design System is theirs; this binding is an independent reference for it.

```
npm install
npm run build            # dist/uswds.js and dist/uswds.iife.js (budget 12 KB gzip)
npm run kit:check        # package, build, equality, behaviour, datum-binding-check
node src/checks.mjs      # notices, the DS script left out of the form's way, focus, grid, steps
node src/hooks-check.mjs # language selector, receipt, required note, summary, journey page
```

- `src/` the binding: `fields.ts`, `containers.ts`, `form.ts`, `texts.ts` (English, Spanish, French), `index.ts`.
- `reference/*.html` USWDS's own markup, one case per file, each citing the template it comes from (USWDS ships Twig templates, no renderer here, so these are written from them by hand).
- `docs/side-effects.md` what the binding does outside the form (nothing) and why it starts no USWDS script.

No tier-2 types: see the header of `src/index.ts`.

## Use

```ts
import { bindings } from "@argusvane/datum";
import { createBinding } from "@argusvane/datum-binding-uswds";

bindings.register(bindings.fromFactory(createBinding), { assets });   // the stylesheet of the one pinned release
```

The package's `exports` point `import` at the TypeScript source (`src/index.ts`), for a bundler that compiles TypeScript; `dist/uswds.js` and `dist/uswds.iife.js` (the global `DatumBindingUswds`) are for a page without a bundler. The CSP and CORS a host page needs are in [docs/host-security.md](../../docs/host-security.md).
