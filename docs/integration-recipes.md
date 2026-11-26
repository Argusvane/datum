# Integration recipes

Copy-paste starting points, smallest first. Every attribute used here is in the generated
[attribute reference](reference/attributes.md). File names are the bundles in `packages/datum/dist` (the engine), in each binding's `dist` (`bindings/<id>/dist`) and in each plugin's `dist` (`plugins/<id>/dist`), built by `npm run build` in that package.

## A design-system binding

A form is drawn with Datum's own look unless its `binding` property names another. A
design-system binding is a package the page loads and registers once, with the design system's
files, which the page serves itself (Datum ships none of them). The nine under `bindings/` are
reference implementations to start from; [Writing a design-system
binding](binding-authoring.md) explains how one is made.

```html
<script type="module">
  import { bindings } from "/dist/datum-form.js";
  import { createBinding } from "/bindings/uswds/dist/uswds.js";

  bindings.register(bindings.fromFactory(createBinding), {
    assets: { stylesheets: [{ url: "/ds/uswds-3.14.0/dist/css/uswds.min.css", integrity: "sha384-…" }] }
  });
  const form = document.querySelector("datum-form");
  form.binding = "uswds";
</script>
<datum-form src="/forms/intake.json"></datum-form>
```

`bindings.fromFactory` hands the binding the page's lit and Datum's own binding. `assets` takes
`stylesheets`, `fonts` and `scripts` (`{ url, integrity?, classic?, attributes? }`). A form or the
builder's canvas whose binding is registered draws with those files unless it is given `assets`
of its own. A stylesheet or script that cannot be loaded (no CORS, a CSP refusal, an integrity
mismatch) puts an alert in the form's place and fires `datum-binding-error`. Serve one release of
each design system per page. [Host security](host-security.md) has the CSP, CORS, SRI and
Trusted Types a page needs, and says why `file://` pages cannot draw a design-system binding.

## Form only

```html
<link rel="stylesheet" href="datum-form.css">
<script type="module" src="datum-form.js"></script>

<datum-form id="f" src="/forms/intake.json"></datum-form>
<script type="module">
  document.getElementById("f").addEventListener("datum-submit", (e) => {
    if (!e.detail.accepted) return;
    e.detail.waitUntil(fetch("/api/submissions", { method: "POST", body: JSON.stringify({ document: e.detail.submission, submissionKey: e.detail.submissionKey }) }));
  });
</script>
```

The body is `{ document, submissionKey }`: the key is minted once per submit attempt and is the same on a retry, so
the server keeps one record for it (ADR 0064, 0052). A body without a key is refused with a 400.

Nothing heavy loads unless an attribute asks for it: no PDF kernel, no validation sandbox, no data
sources. To fix the form at a single page with render, validate and submit only, add
`features="minimal"`; name more by token (`journeys`, `print`, `translations`, `data-sources`,
`drafts`, `server-validation`, `signing`, `pdf`, `wasm`, `agent`), for example `features="minimal drafts"`. A minus takes one out of everything: `features="-drafts"`.
A left-out part is ignored with one console warning and its methods reject. `agent` (the agent
tools a browser assistant can call through WebMCP, [Agent tools](agent-tools.md), ADR 0155) is
opt-in: it is not part of `all` or of the absent attribute, so write `features="all agent"` to add
it.

## Form plus PDF

`pdf="auto"` fetches the PDF module the first time a PDF is asked for. Keep `datum-pdf.js`,
`datum-pdf-program.js`, `datum-pdf-pages.js` and the `fonts/` folder beside `datum-form.js` (or
point `pdf` at the module URL).

```html
<script type="module" src="datum-form.js"></script>
<datum-form src="/forms/permit.json" pdf="auto" pdf-theme="datum-plain"></datum-form>
```

`pdfLayouts()` lists the layouts the definition carries; `submitAndDownload()` and `print()` use them.
`pdf-theme` takes `default` (Datum's `datum-pdf`), `datum-plain`, or the id of a theme the page
registered with `pdfThemes.register`. A binding can suggest a PDF theme of its own (GCDS suggests
`gcds`), used only when nothing above it on the ladder names one: the render call, the layout,
the host's `pdf-theme` ([Writing a design-system binding](binding-authoring.md), section 12).

## Form plus translations plus data sources

```html
<datum-form
  src="/forms/intake.json"
  locale="fr"
  language-switcher
  translations='{"fr":{"intake.name.label":"Nom"}}'
  data-sources='{"provinces":{"url":"/api/provinces"}}'
  data-source-timeout="8000"></datum-form>
```

The form paints first while its sources load; `data-source-wait="all"` holds it until every source
has answered. Sources that need functions are set through the `dataSources` property instead.

## Signing with a passkey

WebAuthn signing is optional and its code loads as a lazy chunk, fetched only when a signing
provider is configured (the `signing-*` and `sign-with` attributes, or `signingProviders`). A page
that never signs never downloads it (ADR 0143). Keep the `datum-form-webauthn-*.js` chunk beside
`datum-form.js`; if it is missing the form reports a `datum-error` and signing rejects with a
clear error, and the rest of the form keeps working. A host that imports the provider itself uses
the `./webauthn` subpath (`createWebAuthnSigningProvider`, `verifyWebAuthnSubmission`). With a
`features` list, `signing` must be in it.

```html
<datum-form src="/forms/consent.json" signing-scope="submission" sign-with="webauthn"></datum-form>
```

### Verifying a passkey signature in your own server (ADR 0063)

A host in another language rebuilds the signed text from the delivered document and checks the
assertion against it; nothing of the engine is needed. `verifyWebAuthnSubmission` in the engine is
the reference, and `engine/tests/fixtures/jcs-vectors.json` holds the shared canonical-text vectors
to test against.

The signed text is RFC 8785 (JSON Canonicalization Scheme), because it is the one text every
language can rebuild byte for byte:

- Object members are sorted by their names as UTF-16 code units, never with a locale comparison
  (`localeCompare` puts `"a"` before `"B"` and `"text_1"` before `"text1"`, and no other language
  reproduces that).
- Numbers are written as ECMAScript's Number-to-string writes them; NaN, the infinities, big
  integers and circular values are refused.
- Strings are escaped as `JSON.stringify` escapes them, with unescaped Unicode and slashes.
- The engine writes the members one by one and never through a JavaScript object, whose own key
  order puts integer-like names (`"2"`, `"10"`) first whatever the sort said, so write them in the
  sorted order yourself.
- There is no whitespace, and an `undefined` member is left out.

For each WebAuthn signature on the document:

1. Take the envelope (the `payload` under the wrapper placement, else the document) and remove
   `signatures`.
2. Take the part `format.scope` names: the envelope, its `submission`, or its `submission.values`.
3. When the signature has a non-empty `statement`, wrap the part as
   `{ "document": <part>, "statement": <statement> }`.
4. Refuse the signature as invalid unless `format.canonicalization` is `"jcs"` (a signature with no
   readable format is invalid, never merely unverifiable), then canonicalize with RFC 8785. Libraries
   exist for it (Python `rfc8785`, Node `canonicalize`, Java `java-json-canonicalization`, Go
   `gowebpki/jcs`), or a few lines per language tested against the shared vectors.
5. Hash the UTF-8 text with SHA-256 and compare the base64url of the hash to
   `clientDataJSON.challenge`.
6. Check `clientDataJSON.type` is `webauthn.get` and `origin` is an allowed one. Check
   `authenticatorData[0..32]` equals the SHA-256 of the relying-party id, the user-presence flag
   (the user-verified flag too when your policy requires it), and the counter.
7. Verify `signature` over `authenticatorData || SHA-256(clientDataJSON)` with the registered
   public key (SPKI) and algorithm: for a signature made with a discoverable passkey the page did
   not know, the archived `algorithm` is an ES256 assumption and the archived assertion has no
   `publicKey`, so take both from what you registered for that `credentialId`. ES256 as a DER-encoded ECDSA signature over P-256 and SHA-256
   (Python `cryptography`: `ec.ECDSA(SHA256())`; `node:crypto`: `verify("sha256", data, key, sig)` with
   `dsaEncoding: "der"`; Java `SHA256withECDSA`; .NET `ECDsa.VerifyData(...,
   DSASignatureFormat.Rfc3279DerSequence)`) or RS256 as PKCS#1 v1.5.

The time the page recorded (`signedAt`) is outside the signed text: the signer's device does not
vouch for it. Refuse a signature outside your signing window, or whose two copies of the time
(`signedAt` on the signature and on its `webauthn` record) disagree by more than a skew you set (the
Spring Boot host's default is 60 seconds).

## Builder, minimal

`features` is the master list (ADR 0143): only what it names exists, and a left-out part fetches
none of its chunks. `minimal` is the Form workspace with its canvas, inspector and component
palette, plus the canvas's Edit / Preview toggle.

```html
<script type="module" src="datum-builder.js"></script>
<datum-form-builder
  layout="contained"
  features="minimal"
  file-actions="none"
  style="height: 100vh"></datum-form-builder>
```

Add parts by name: `features="minimal logic"` is the form plus the Logic workspace;
`features="minimal logic try-it json"` also gives Try it and the JSON view. Tokens: logic, data,
languages, translations, journeys, pdf, variables, header-footer, data-model, palette, try-it,
json, binding-picker, advanced-fields, agent; presets all and minimal (`agent` is opt-in: not part
of all; write `features="all agent"` to add it). `pdf="off"`, `journeys="off"`,
`hidden-workspaces`, `hidden-panels`, `file-actions` and `component-types` can only take more
away from the list, never put a part back. The attribute is read at connect; changing it later
rebuilds the builder, except an agent-only change, which only registers or withdraws the agent
tools. Leave it off and the builder is exactly what it was.

The canvas draws the form with a design-system binding the page registers (`bindings.register`); `binding-picker`
only shows the picker, and the `binding` property still sets the value. The host saves through
`datum-builder-change` and `markSaved()`.

What a `datum-builder-change` detail says about history. Three fields name what a step carried, so a
host that keeps references of its own can follow them:

- `renameStepped` is `{ from, to, by }` when the change is an Undo or a Redo of a rename: `from` and
  `to` are the ids as the step runs now, and `by` is `"undo"` or `"redo"`. An Undo carries the rename
  turned round (the id put back), a Redo the rename again.
- `dataMoved` is the list of `{ from, to }` data-path moves the change made. An Undo carries the
  moves the step made, reversed; a Redo carries them again, so a host that followed them the first
  time follows them back and forth with the history. The arrays are copies: draining one in a
  listener changes nothing for the next listener.
- `historyStep` is set when the change came from the history rather than from an edit. A rewrite
  that is already inside the step's entry (a mode's follow, the form tests, the layouts) is not run a
  second time for it.

Page and journey ids in the form's tests (ADR 0154). When the author gives a page or a journey
another id, the Journeys mode tells the builder itself (a bubbling `builder-journey-rename` event on
the builder's root) and the tests that name it are rewritten, as one more undo step. A host forwards
nothing, whether it uses `<datum-form-builder>` or mounts `createJourneyBuilderMode` by hand through
`builder.addMode(...)`. A journey the host gives another id (`replaceJourney`) before the Journeys
workspace was first opened is told to the builder when the workspace opens. `datum-journey-change` still carries the `page-rename` and `journey-rename`
reasons, with `renamed: { journeyId, from, to }`, for a host that keeps its own references. Only a
mode mounted outside the builder's tree (its event never reaches the builder) has the host call
`builder.followJourneyChange(detail)` with the mode's `onChange` detail.

## A journey form without the journeys runtime (ADR 0144)

A definition with journeys runs on the journeys runtime, one lazy file
(`datum-form-journey-engine-chunk-*.js`, listed under the `journeys` token below, and deletable
like every other feature file). `<datum-form>` fetches it by itself and is ready one chunk load later (see "Knowing when a form is ready" below). `journey="form"`
does not skip it: the journey can be switched later without a rebuild, so the chunk is still
needed, and if the file is missing the form shows the error card with Retry, not the whole form.
To avoid the chunk, leave `journeys` out of `features` (or set `journeys="off"`); the form then
runs as one page with one console warning.

A host that builds runtimes itself on `datum-form.js` gets the pair from the loader and gives it to both parts:

```js
import { createFormRuntime, loadJourneyEngine } from "@argusvane/datum/form";
const { engine, renderKit } = await loadJourneyEngine();
const runtime = createFormRuntime(definition, { journeyEngine: engine });
renderer.journeyKit = renderKit; // without the kit the journey is drawn as one page
renderer.runtime = runtime;
```

`renderKit` draws a Check answers page (`kind: "review"`) with no list of answers. For a journey
with one, ask the bundle for the definition's pair: it loads the Check answers chunk and
answers the kit built over it. `<datum-form>` fetches that chunk beside the journeys chunk;
a host that wants the same passes the chunk's bundle (`loadJourneyReview()`) as the second argument.

```js
const { engine, renderKit } = await (await loadJourneyEngine()).forDefinition(definition);
```

## Knowing when a form is ready (ADR 0144)

Every `<datum-form>` builds its runtime the same way, in a microtask after the definition lands;
a form with journeys also waits for the journeys runtime. Do not read `form.runtime` or call
`setErrors()` straight after setting `definition`: await `ready`, or listen for `datum-ready`.

```js
const form = document.querySelector("datum-form");
form.definition = definition;
try {
  await form.ready; // resolves after datum-ready, whatever the form is made of
  form.setErrors(errorsFromTheServer);
} catch (error) {
  // the journeys runtime did not arrive (the card with Retry is up), or the runtime refused the definition
}
```

`ready` follows the form becoming ready, not one build: a definition replaced while the first is
building does not reject it, and it resolves for the one that lands. It rejects with why a build
failed, once; after Retry (or a new definition) `form.ready` is a fresh promise. With no
definition yet it settles once one is set and built; a `src` that cannot be fetched or is not a
usable definition rejects it with why. An element taken out of the page keeps `ready` pending until
it is attached again and built, so do not await it on an element you never re-attach. The promise-returning methods (`validate()`,
`submit()`, `nextPage()`, `goToPage()`, `previousPage()`, `print()`, `renderPdf()`, the draft
methods) wait for the build by themselves; `setErrors()` and `setLocale()` return at once, so they
throw "still building" until `ready`.

## Assistants in the browser: the per-form switch and provenance (ADR 0155)

Whether an assistant can fill a form is decided in three places, and each says who has the word.
The `agent` token of `features` is opt-in (not part of `all`) and loads the tools. The
`agent-access` attribute on `<datum-form>` is the host's policy for the element: `always` (the
host enforces: the tools are live whatever the definition says), `definition` (the definition
decides, the default: the form's own `root.configuration.agentTools` is `"allowed"` for live,
anything else registers it sealed) or `never` (the host forbids: nothing registers and nothing
loads for that element). The form author sets `agentTools` in the builder's Form settings,
Browser assistants.

```html
<!-- the form's own setting decides: live only if its author allowed assistants -->
<datum-form id="claim" src="/forms/travel-claim.json" features="all agent" agent-access="definition"></datum-form>
<!-- this site fills it with an assistant whatever the definition says -->
<datum-form id="intake" src="/forms/intake.json" features="all agent" agent-access="always"></datum-form>
<!-- this one never: nothing is loaded or registered for it, though the site-wide list carries the token -->
<datum-form id="declaration" src="/forms/statutory-declaration.json" features="all agent" agent-access="never"></datum-form>
<!-- and this one has no token at all: the same as never, with nothing to configure -->
<datum-form id="notice" src="/forms/notice.json" features="all"></datum-form>
```

A sealed form (`definition`, and the author has not allowed assistants) is still on the page's
tool list, but every call answers `agent-off`, except `describe_form`, which says the form is the
person's to fill; its submissions carry no `agent` account because the tools were never live.
A host may make it a per-form setting. A host that writes the token without `agent-access` gets the
default, `definition`.

This is the strong form of an attestation rule. For a legal declaration, set the form's own
switch (`agentTools: "off"`, Form settings, Browser assistants), which every page on the default
`agent-access="definition"` honours; or, on a page you control, write `agent-access="never"` (or
leave the token off) on that element, which holds even where the site allows assistants on every
form. Pair it with a signed submit (a WebAuthn button,
[Signing with a passkey](#signing-with-a-passkey)), so the server verifies the person's own
signature and needs no account of who typed. A host's `always` overrides the author's `off`, so
the author's switch alone is a strong form only on pages that follow the form.

Where a form does carry the token, the page can ask which answers the assistant's tools wrote.
`context.agent` (an `AgentProvenance`) is on both submit hooks and `detail.agent` on `datum-submit`
and `datum-pdf`; it is absent exactly when the tools were never live for that element (a form that has only ever been sealed adds nothing).
It is the page's own account, computed in the browser, so a server trusts it only as far as it
trusts the submitted values, and it covers the tools only (an assistant that types into the page
like a person is indistinguishable from the person). The hook copy is frozen, so copy before
sorting: `[...ctx.agent.paths].sort()`.

```js
// An attestation answer must be the person's own: refuse the submission, for the person's Submit
// and for an assistant's submit tool alike, when the assistant wrote it (or may have).
plugins.register({ id: "attest", version: "1", hooks: { beforeSubmit: [(ctx) => {
  if (ctx.agent?.paths.includes("declaration") || (ctx.agent?.complete === false && ctx.values.declaration === true)) {
    throw new Error("Please tick the declaration yourself.");
  }
}] } });

// A review banner: tell the person before the answers go anywhere.
document.querySelector("datum-form").addEventListener("datum-submit", (e) => {
  const touched = e.detail.agent?.paths.length ?? 0;
  if (touched > 0) showBanner(`An assistant filled ${touched} of these answers. Please review them.`);
});
```

For an audit trail, store `{ involved, complete, submittedBy, paths.length }` beside the submission
record as request metadata, never inside the signed or canonical envelope. `complete: false` means
the runtime was rebuilt or a draft restored after the assistant wrote, or the tools were withdrawn:
read it as "the assistant may have written anything". A `beforeSubmit` hook that throws settles the
submission as failed and the form goes back to idle, so the assistant's tools (and the person's
Submit) work again at once.

Two assistant tools hand data off the page, `drafts` (save) and `download_pdf`, so the browser asks
the person before each; and a form that keeps its draft on a server already saves it as answers
change, the assistant's included ([Agent tools](agent-tools.md), "What leaves the page").

## Removing a feature's files

A feature that the page never uses can be left off the server. Every build writes
`dist/feature-files.json` (`node scripts/feature-files.mjs` in `packages/datum`, the last
step of `npm run build`): for each feature token, the files that only that feature needs, with
their size.

```json
{
  "features": {
    "pdf": { "bundle": "both", "files": ["datum-form-pdf-service-DqN0PLed.js", "datum-pdf.js", "fonts/DejaVuSans.ttf", "..."], "bytes": 6461492, "gzipBytes": 3011154 },
    "journeys": { "bundle": "both", "files": ["datum-builder-journey-map-D1PHXrhH.js", "..."], "bytes": 322679, "gzipBytes": 102309 }
  },
  "aliases": { "signing": "webauthn", "server-validation": "validate-url" },
  "core": [{ "file": "datum-builder-surface-sheet-CVIifVJj.js", "note": "shared by data and logic (...)" }],
  "unattributed": []
}
```

Tokens are the renderer's (`journeys`, `print`, `translations`, `data-sources`, `drafts`,
`server-validation`, `signing`, `pdf`, `wasm`, `agent`) and the builder's (`logic`, `data`, `languages`,
`translations`, `journeys`, `pdf`, `variables`, `header-footer`, `data-model`, `palette`,
`try-it`, `tests`, `json`, `binding-picker`, `advanced-fields`, `agent`), plus `pdf-pages`, `webauthn` and
`validate-url`. `agent` is opt-in (not part of `all`) and lists five files: one chunk per bundle
(`datum-form-agent-*.js`, `datum-builder-agent-*.js`) and the builder's three body chunks
(`datum-builder-agentpart-{try,languages,documents}-*.js`, each fetched on its tool's first call). `signing` and `server-validation` name the same files as `webauthn` and
`validate-url`. A token that is only a switch (`drafts`, `binding-picker`, ...) lists no
files; `print` is not one of those: its chunk is listed. `bundle` says which bundle's chunks the list holds. The entry bundles
(`datum-form.js`, `datum-builder.js`, and their `.iife.js` twins) are never listed. A file two
features share is `core`: it stays, and its note says why.

**Worked example: a form without PDF.** Do both halves, in this order:

1. Leave the feature out, so the page never asks for the files: `features="minimal"` (or the list
   of what you do use, without `pdf`) on `<datum-form>`. A `pdf` attribute or a definition with
   layouts is then ignored with one console warning, and `renderPdf()` / `downloadPdf()` reject
   with a message naming the feature.
2. Delete every path in `features.pdf.files` from the deployment, relative to the folder that
   holds `datum-form.js`.

Delete without leaving the feature out, and the page still asks for the files the first time the
feature is used: `<datum-form>` fires a `datum-error` whose `detail.message` says what could not
be loaded and whose `detail.cause` is the browser's original error (the failed dynamic import's
`TypeError`), the affected surface shows an inline alert (the builder's PDF side shows "The
layouts didn't load." with Retry; `<datum-form>` puts a message in its notice area, a
`role="alert"` element), and everything else keeps working. The error the method rejects with,
and the one carried in `detail`, is a `ChunkLoadError` naming the file; the browser's error is
always its `cause`, for the PDF module and the WASM host alike. A later attempt asks the server
again, so putting the files back needs no reload.

Which tokens are proven in a real browser. `npm run absent-code:browser` (headless Chrome;
`scripts/absent-code-browser.mjs`) deletes or blocks the files of `pdf`, `journeys`, `try-it`,
`wasm` and `signing` (`webauthn`), for the form's own `pdf="auto"` as well as the builder's PDF
side, and checks excluded (zero requests), deleted and blocked (a `datum-error`, a failure state
that names the failure, no uncaught error) and restored (the retry asks again and succeeds). The
Header & footer and Variables panels are checked for their loading and failure cards. The other
tokens (`logic`, `data`, `languages`, `palette`, `json`, `data-model`, `validate-url`,
`pdf-pages`) are covered by jsdom tests of their loaders only.

Deleting files is for module builds only. The `.iife.js` bundles inline their chunks into the
single classic script, so there is nothing to remove from a host that loads `datum-form.iife.js`
or `datum-builder.iife.js`; the list above describes the ES-module build (`datum-form.js`,
`datum-builder.js`) and its chunk files.

A Content-Security-Policy that blocks the files, or a network that drops them, looks exactly like
a 404: the dynamic import rejects, the same `datum-error` and inline alert follow, and nothing
hangs. If a policy allows only `script-src 'self'`, allow the folder that holds the chunks, or
leave the feature out. The rest of what a policy has to allow is in [Host security](host-security.md).

Two cautions. Delete only paths read from the manifest of the same build: the chunk names carry a
content hash that changes with every build, so a list copied from an earlier build, or a pattern
such as `datum-form-*.js`, deletes the wrong files or none. And never delete a `core` file, an
entry bundle, or a chunk that is not listed under the feature: other features import them, and
the page breaks in ways the `datum-error` above does not cover.
