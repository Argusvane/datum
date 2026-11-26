# ADR 0164: Design-system files in the form's shadow root, and the reference bindings

## Status

Accepted.

## Context

A form drawn by a design-system binding (ADR 0162) needs that design system's stylesheet, fonts
and, for some, scripts. The form lives in a shadow root. That keeps page CSS out of the form and
the form's CSS out of the page, but it also means a design system's document-level stylesheet does
not reach the form, its `@font-face` rules do not register, and a script that starts components
across `document` does not find them. The design system's files also have their own licences and
releases, which Datum should neither ship nor pin.

The binding contract (ADR 0162) and the asset path are infrastructure. Only bindings for real
design systems, each different in markup, scripting and component model, show whether they hold.
A binding also needs a test that answers two questions: does it draw what the design system
draws, and does it carry every Datum feature? Both answers have to stay true when the design
system ships a new release.

## Decision

The mechanics below are described, step by step, in
[`docs/binding-authoring.md`](../binding-authoring.md), sections 6 and 9.

### The host supplies the files

The files are host configuration, never part of a binding. They go in the element's `assets`
property (stylesheets, fonts, scripts and the page's `rootFontSize`), or in the registration
(`bindings.register(binding, { assets })`) for an element that names the binding by id.

Datum ships none of these files and reads no version from them. A host moves to another release
by changing the addresses. A binding's docs name the release it was built and tested against. No
check runs on the page, so drift shows up only in `datum-binding-check --baseline`.

The assets feature (`render/live/assets-feature.ts`) loads them before the first draw. The loader
(`render/live/assets.ts`) is a chunk of its own, loaded only when a mount has files. The Datum
binding's sheet is bundled (ADR 0163) and never takes this path.

### A stylesheet is rewritten for the shadow root

A stylesheet is fetched with `fetch()`, so it must be same-origin or served with CORS. Its relative
`url()`s and leading `@import`s are resolved as text. It is then rewritten over the browser's
parsed `cssRules` (the page's `html`, `body` and `:root` selectors name `:host`, `@font-face`
rules are taken out, `rem` lengths follow the design system's expected root size) and adopted into
the root ahead of the renderer's own sheets, so the renderer's structure and the binding's `css`
win a tie. One constructed sheet per `(document, url, integrity, rewrite options)` is shared by
every form that names it, counted, and released with the last of them. On unmount the renderer
removes every sheet added since it noted the root's own, including any a design system's script
adopted into the root while the form was mounted. The rewrite is `shadowSheet`
(`render/live/assets.ts`).

### Fonts are page-wide

A face declared inside a shadow root is never registered, so the faces from the design system's
stylesheets and from `assets.fonts` go into one document-level sheet per binding
(`document.adoptedStyleSheets`). Nothing else goes there. A font sheet that cannot be loaded is
reported (`datum-binding-error`, `hook: "assets"`) and the form still draws, because text falls
back to another face.

### Scripts are the design system's, loaded once

A script is loaded once per page per absolute address and never unloaded, because the custom
elements it defines cannot be undefined. Asking for an address already loaded with a different
`integrity` is refused.

Where the browser has Trusted Types, the script's `src` is set through a policy of Datum's own,
`datum-assets`, rather than a plain string. A page that enforces Trusted Types then allows a
policy by name, as it does `lit-html` and `datum-print`, and needs no `default` policy, which
would pass every script URL on the page through one function the host must write. The policy is
created on the first script a binding asks for, so a page whose bindings load no script never
creates it, and it passes only the addresses the loader was handed from `assets.scripts`: it is
not a general way past the page's policy. A page that refuses the name refuses the script, and
the form fails as below, naming the policy. The directives a host's policy needs are in
[`docs/host-security.md`](../host-security.md).

### Integrity on every file

`integrity` must be a list of `sha256-`, `sha384-` or `sha512-` digests, or the mount fails.
`fetch()` checks it for stylesheets and font sheets. The browser checks it for scripts, which are
fetched with `crossorigin="anonymous"` so it can.

### A file that cannot be had fails loudly

If a stylesheet or a script fails (network, CORS, HTTP error, integrity), the form is not drawn.
An alert (the `formNotShown` text) takes its place, the element emits `datum-binding-error` with
`hook: "assets"` and the file's `url`, and `ready` rejects. Datum never falls back to linking the
sheet unrewritten: a form half in the design system's look and half in the browser's would look
like a working form and not be one. The builder canvas is the same element, so it fails the same
way. A design-system binding cannot run on a `file://` page, which refuses `fetch()`.

### Design-system scripts start scoped to the form, or not at all

A design system's document-wide start does not reach into the shadow root. A binding's
`connect(root, form)` runs once per mount, after the first draw is ready, and never on a redraw.
It is handed the form element as the scope: an Element inside the shadow root, where the
ShadowRoot itself is not one. It returns the cleanup that runs on unmount, and a throw is
reported as `hook: "connect"`.

- Where a design system's published files offer a scope, the binding starts only the components
  whose script touches nothing outside their own root (GOV.UK's buttons; its other components look
  things up through `document`, so they are never marked for it), and the cleanup removes what the
  start added to `window` and `document` when the design system has no teardown.
- A web-component design system (a Stencil library such as GC Design System or Ontario) upgrades
  its elements wherever they are connected, the shadow root included, so there is nothing to start.
- Where there is no scope (USWDS's bundle starts itself on `document.body`), the binding starts
  nothing and draws the design system's no-JavaScript baseline, and the behaviour that Datum owns
  under ADR 0162 (the count, tabs, summary focus) stays the renderer's.

A capability answer follows what is drawn, not whether the script runs (ADR 0162).

### Side effects outside the form are declared

Some changes a design system makes reach outside the form's root: the page-wide font sheet, the
page-wide custom-element registry (first definer wins), Ontario's language toggle writing
`<html lang>`, Québec's `qc-dark-theme` class on `<html>`. A binding declares each in
`designSystem.sideEffects` (`{ target, effect }`). `selfCheck()` reports them as `sideEffects`,
never as problems, and so does the `datum-binding-check` report. Each binding's
`docs/side-effects.md` records what was measured and how it is undone. Since the custom-element
registry is page-wide, a page draws every form of one web-component design system with one
release.

### Nine reference bindings

`bindings/<id>` holds nine reference bindings: `gcds`, `uswds`, `govuk`, `bootstrap`,
`nova-scotia`, `alberta`, `quebec`, `ontario` and `fluent`. They exist to test the infrastructure
across a broad range of design systems, and to serve as demos and starting points for anyone
writing a binding. Datum's one official look is the Datum binding (ADR 0163).

A reference binding carries no support promise: there is no matrix of design-system releases, no
support window and no check for new releases. Each binding takes its look, markup and
accessibility from its design system, which owns them. Datum claims only that a binding passes
Datum's integration checks. Datum's CI runs the kit's checks and `datum-binding-check` on each
one's pinned release (the `bindings` job). A failure there points at the contract or the
renderer first.

A package is `src/` exporting `createBinding(lit, datum)`, reference markup, `docs/side-effects.md`,
a `binding-check.json` asset list and a `package.json` with a `datumBinding` block, with the design
system pinned as a devDependency alias; the design system's files are read from that alias, and no
binding ships them. The layout is in the guide, section 2. `bindings/gcds` also carries the worked
examples of the patterns other bindings may follow: a print theme (`print/`) and a PDF theme
(`pdf/`) (ADR 0035, ADR 0098), a token contract (`tokens.json`), and a FormPlugin of GCDS-only
types drawn with real `gcds-*` components (`gcdsPlugin`).

### Two tiers

1. Where a design system's official component behaves as Datum's type does, the binding draws
   the type with that component or the design system's own HTML.
2. Where it behaves very differently (a date input with no error state, a custom listbox, a tab
   component that runs its own keys), the binding draws Datum's component in the design system's
   HTML and token CSS, so it looks like the design system and behaves like Datum. The package
   can then offer the official component as a type of its own, with a `base`
   (`gcds-date`, base `date`), in its FormPlugin. Under any other binding that type is drawn as
   its base, and on a server it validates as its base from the definition's `kinds` map
   (ADR 0162).

Which kinds go to tier 2 is the binding author's judgement.

### Equality against the design system's own markup

A reference file (`reference/<case>.html`) is the markup the design system produces for a form the
case describes. Where the design system ships its templates, the markup is generated from them
(GOV.UK's Nunjucks macros, `bindings/govuk/reference/generate.mjs`). Elsewhere it is written from
the design system's documented examples, and the file cites them. A hand-written reference can
agree with a wrong binding, which is why generated references are preferred wherever the design
system ships its templates.

`binding-kit/equality.mjs` draws each case three ways on the pinned release: `plain` in the
document, `shadow` in a shadow root with the files adopted by the renderer's `adoptInto`, and
`binding`, the form drawn by the binding through the renderer. It compares `shadow` with `binding`
on pixels, on each element's box, font and colour, and on the composed-tree text lines. That
comparison gates. `plain` against `shadow` is reported beside it as the cost of the shadow root,
which is never the binding's fault. Pixels gate in Chromium only, because of sub-pixel font noise
elsewhere; boxes and text gate in every browser. A documented gap is marked `known`: it is
reported while it differs and fails once it stops differing.

### Tier-2 drawings against their own baselines

A tier-2 drawing has no design-system markup to compare with, so it is compared with the binding's
own accepted screenshot (`tests/tier2/baseline/`). A baseline is never accepted silently:
`--update-baseline` writes candidate PNGs and their sha-256s and never writes the sign-off; a
person looks at the PNGs and records the reviewer and date; a PNG passes only when the sign-off
names it with the sha-256 it has now. Changed bytes blank the reviewer and date, so a changed
picture always needs a fresh look, and a case without a sign-off fails.

### The binding kit

`packages/datum/binding-kit/` holds the authoring tests (`kit:check` and its steps: package,
build, tokens, binding lint, equality, behaviour, the package's own checks and
`datum-binding-check`), and `scripts/new-binding.mjs` scaffolds a package. Everything runs on
Playwright. The kit's steps and options are in the guide, section 9, and the token contract in
section 10.

### `datum-binding-check`

One command answers whether a binding still carries every Datum feature. It lives in
`@argusvane/datum-conformance-suite`, beside `datum-host-check`. It mounts a fixed corpus (one
fixture form per Datum feature) through the real renderer with the binding, in headless Chromium
through Playwright. The cases are integration only: what Datum and the binding write or pass in,
never anything inside a design system's own component. The binding's capability answers choose
which cases run, and a case skipped for `none` is reported with the reason. A design system's
console warnings are reported, never failed. `--baseline` compares the run with a report from a
known-good release and prints which cases changed state, which is how a binding's CI notices drift
after an upgrade. The Datum binding must pass every case. The corpus is versioned with Datum, so
a new feature adds fixtures and cases, and a binding checked by a newer corpus reports what it does not carry. The
options, the groups of cases, the reports and the exit codes are in
[`docs/conformance-suite.md`](../conformance-suite.md).

## Consequences

- A design system's own files render the form, unmodified at the source and rewritten only as the
  shadow root needs.
- A host whose design-system CDN sends no CORS headers serves the files itself.
- A missing or tampered file is caught at mount, by name, rather than as a form that looks wrong.
- A contract change shows up across every reference binding, each a different design system, at
  once.
- A third party writes and tests a binding with the same kit and the same command Datum uses.
- Tier-2 baselines are platform-specific screenshots and need a person each time they change.
