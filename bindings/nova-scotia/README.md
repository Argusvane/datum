# @argusvane/datum-binding-nova-scotia

The Nova Scotia UI Pattern Library (Bootstrap 3, saltire.css) binding for Datum: it draws Datum's
components in nsgov.github.io/patternlibrary's own markup, pinned to commit 663c256 of
https://github.com/nsgov/patternlibrary (the vendored `vendor/saltire/saltire.css`; updating it is a
manual refresh). A reference implementation: it validates the binding infrastructure against a
design system that ships a stylesheet and HTML snippets and no script; it carries no support
promise.

Datum is not affiliated with or endorsed by the Government of Nova Scotia. The Nova Scotia UI Pattern Library is theirs; this binding is an independent reference for it.

## What is drawn

- Fields: text, textarea, number (`type=number`), select, radios, checkboxes, a lone checkbox, a
  date (three boxes in the library's label and box markup: the library has no date), buttons.
- Containers: fieldset, a data grid (the library's table), steps (its progress tracker), a button
  group.
- Form: the error summary and the host's receipt (the library's alert block), the required note, the
  language links, a journey page's heading and buttons. English and French words (`src/texts.ts`).
- Warnings and info are the library's warning colour and glyphs and a help block with the info glyph,
  never an error. Pending and tooltip are folded into the hint.
- Everything else (tabs, files, signatures, chrome parts) is drawn by Datum's adapter tinted with the
  library's colours and listed by `unsupported()`.

No tier-2 type and no FormPlugin: every component the library has is plain HTML and CSS, so there is
no drastically different official component to judge. The date, which has no library component, is
compared with its own baseline (`tests/tier2/`).

## Host files

`binding-check.json` is the list the kit uses: `saltire.css` and Font Awesome 4.7's stylesheet. The
library ships no script, so there is nothing to start and nothing scoped. `docs/side-effects.md`
says what the binding does outside the form (nothing), what the host must provide (the sheets and
their font folders) and the choices it makes where the library is silent.

## Use

```ts
import { bindings } from "@argusvane/datum";
import { createBinding } from "@argusvane/datum-binding-nova-scotia";

bindings.register(bindings.fromFactory(createBinding), { assets });   // saltire.css and Font Awesome 4.7's stylesheet
```

The package's `exports` point `import` at the TypeScript source (`src/index.ts`), for a bundler that compiles TypeScript. A page without a bundler loads `dist/nova-scotia.iife.js` (`npm run build`; the global `DatumBindingNovaScotia`), or imports `dist/nova-scotia.js`. The CSP and CORS a host page needs are in [docs/host-security.md](../../docs/host-security.md).

## Checks

```
npm run kit:check      # package, build, equality, behaviour, datum-binding-check
npm test               # build, tests/checks.mjs (browser), tests/hooks.mjs (form-level hooks), reference/generate.mjs --check
npm run reference      # rewrite reference/*.html from reference/generate.mjs
```

`reference/*.html` are written by hand from the library's snippets (`generate.mjs` holds them) and each
cites the snippet it follows. They carry the binding's restatement of the Bootstrap 3 rules the
sheet dropped, so they gate drawing losses, not whether an attribute is right.

## Vendored files

`vendor/saltire/saltire.css` is `css/saltire.css` of https://github.com/nsgov/patternlibrary at commit
663c256 (2021-09-15, MIT), byte-identical to https://nsgov.github.io/patternlibrary/css/saltire.css
except for one change: the `url()` of its 7 Open Sans `.woff` faces points at the copies in
`vendor/saltire/fonts/` instead of novascotia.ca. Its other `url()`s (the `.eot`, `.ttf` and `.svg`
faces, and Font Awesome's) stay on novascotia.ca, and nothing else is changed. A comment at the top
of the file says so.

- `vendor/saltire/fonts/` holds those 7 faces, the library's own files from
  https://novascotia.ca/clf/fonts/opensans, with Open Sans's Apache 2.0 licence.
- To refresh: fetch `css/saltire.css` at the new commit and the `.woff` faces it names, rewrite the 7
  `.woff` `url()`s to `fonts/<file>`, and update the commit here, in the file's comment and in
  `datumBinding.release`.

`font-awesome-4.7.0` (the devDependency alias of `font-awesome@4.7.0`) is the icon font its
stylesheet expects.
