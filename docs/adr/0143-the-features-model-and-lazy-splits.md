# ADR 0143: The `features` model and the lazy splits

## Status

Accepted.

## Context

`datum-form.js` could ship everything a form can do (WebAuthn signing, the fetch validator, PDF
theme and layout code, journeys) behind attributes that change behaviour but not bytes, and
`datum-form-builder` every workspace and both designer modes, with a hidden workspace hiding a
tab but not its code. A host that wants a one-page form, or a builder that is only a canvas,
needs a way to say so, and a host that deploys without a feature's files needs a defined failure.

## Decision

### 1. The `features` list

`features` (attribute, space or comma list; property of the same name) exists on `<datum-form>`
and on `<datum-form-builder>` (and the inner `<datum-builder>`). One model for both. The tokens of
each element and the presets are in `docs/reference/attributes.md`.

- **Absent = `all`.** The opt-in tokens, such as `agent`, are not in it. Present = only the listed
  features exist. `features=""` is `minimal`. Presets: `all`, `minimal`.
- **The list is the master.** Per-feature attributes (`pdf`, `journeys`, `wasm`, `validate-url`,
  `draft`, `translations`, `data-sources`, `signing-*`, `hidden-workspaces`, `hidden-panels`,
  `file-actions`, `component-types`) configure a feature and can only take more away, never
  enable one the list omits.
- **Read at connect; a later change rebuilds** (the sides, workspaces, strip and bar for the
  builder; the runtime for the renderer).
- **A feature the definition or configuration needs but the list omits is ignored with ONE console
  warning**, with no throw. Methods of an omitted feature (`renderPdf`, `downloadPdf`, `print`,
  `goToPage`, `previousPage`, ...) reject, or no-op where they were synchronous, with a message
  naming the feature. A word that names no feature is reported (`datum-error` `features.unknown`
  on both elements; the inner `<datum-builder>` also warns once on the console) and left out.
- **An omitted feature never fetches its chunks**: not at connect, not on definition load, not on
  any UI path (palette, phone menu, remembered panels, `workspace`, `mode`).
- **A token with a minus in front is an exclusion**, on both elements: `all -drafts` is every
  feature but drafts, and a list made only of exclusions starts from `all`. That gives a page one
  word for "everything but this", which stays right when a feature is added later, where a positive
  list would silently leave the new feature out. An exclusion wins wherever it stands and over the
  same feature named beside it. A mistyped exclusion (`-draft`, `-all`) is an unknown word like any
  other, and a list holding an unknown word is not "only exclusions": it starts from nothing, so a
  typo can narrow what exists and never widen it.
- **An opt-in token is never part of `all`**, so `all` does not equal the whole token list. ADR
  0155 holds the `agent` token.
- **Hidden workspaces `pdf` or `journeys` mean that mode is never fetched or registered.** Layouts
  and journeys pass through the seed byte for byte, and form renames are followed into them by a
  small eager module (`journey-config-rename.ts` and the layout counterpart), so an omitted or
  not-yet-loaded side still has its references rewritten.

### 2. The lazy splits

What leaves the entry bundles, each as its own chunk: the WebAuthn provider and ceremony, the fetch
validator, the PDF designer mode, the Journeys mode, the builder's PDF pipeline copy (shared by the
mode and Preview PDF), the Header & footer, Variables and Print panels, the renderer's PDF pipeline
with its theme and layout logic, and the journeys runtime (ADR 0144). `dist/feature-files.json`
lists the files each token owns (`docs/integration-recipes.md`, "Removing a feature's files"). Each
chunk has a guard under `packages/datum/scripts/guards/` that asserts exactly one chunk carries its
sentinel and the entry does not, `scripts/guards/11-feature-files.mjs` fails a build in which a lazy
token (`pdf`, `pdf-pages`, `journeys`, `webauthn`, `validate-url`, `try-it`, `wasm`, `logic`, `data`,
`languages`, `print` and `agent`) lists no file (a renamed or merged chunk would otherwise read as core and silently remove the
host's way to delete it), and `check-bundles` holds every entry to a size budget.

### 3. Absent-code behaviour

A host may deploy without a feature's files. When a feature is **excluded** the file is never
requested. When it is **included but the file is missing** (404, CSP), the surface degrades and the
page does not break:

- No uncaught exception and no unhandled rejection.
- The element dispatches `datum-error {message, cause}`.
- The affected surface shows an inline accessible card with Retry (panels; the PDF and Journeys modes in `[data-mode-status]`;
  the PDF designer's loading card); the rest keeps working.
- Methods reject with a clear Error.
- The next attempt retries: every loader forgets a failed import, and a failed `import()` is
  retried under a new address, because Chrome caches a failed `import()` until reload
  (`retryableChunkImports()` in `packages/datum/vite.config.ts`, applied to the form and builder
  module builds).

For the server validator, a missing chunk is the journey's "server unavailable" case, so
`onUnavailable: "continue"` still lets a journey go on.

`detail.cause` has one meaning everywhere: the original browser error (the failed `import()`'s
`TypeError`). The thrown or dispatched error is the package's `ChunkLoadError` naming the file; the
PDF and WASM loaders both pass the browser error as its `cause` (the PDF loader does not re-wrap an
error that is already a `ChunkLoadError`). In `<datum-form>` a missing PDF module also fills the
form's notice area (`role="alert"`) with a translatable message, so a filler sees it without a
console.

Deleting chunk files is an ES-module-build recipe only: the `.iife.js` bundles inline their chunks
(Vite cannot emit chunks for a classic script), so a host on the classic-script bundles has nothing
to delete and nothing to fail.

### 4. Loader and element API

The lazy modes are not exported as values from the builder bundle, because that would pull both
modes back into the entry; they are loaded through promise-returning loaders, and the first builder
on a page registers its modes one async hop after connect. `@argusvane/datum-engine` keeps the
synchronous factories. The lazy panels' tags are not defined by `defineDatumBuilderElement()`, and
the WebAuthn helpers (`createWebAuthnSigningProvider`, `verifyWebAuthnSubmission` and the rest) stay
exported from `form.ts` as light wrappers over the lazy chunk, with no signature change. The package's
`./webauthn` export carries the same names for hosts that import them directly: it is the built file
`dist/datum-webauthn.js`, a module only, one file with no chunks and no DOM global, so a page, a
worker or Node imports the real functions from it without the lazy hop (`scripts/guards/19-webauthn-entry.mjs`
holds it). The loader names and their rules are in `docs/reference/embedding.md`.

### 5. Attribute URLs are same-origin unless an allow-list names the origin

The `wasm`, `pdf`, `draft-store` and `validate-url` attributes name an origin for the page to fetch
from, and an attribute can be written by anyone who can put markup on a page. A value from one of
these attributes must be on the page's own origin unless the element's `allow-origins` attribute
(space-separated origins) lists the value's origin. A refused attribute reports a `datum-error`
naming the attribute and the origin and loads nothing (`wasm`, `pdf`, `draft-store`, `validate-url`
on `<datum-form>`; `wasm`, `pdf`, `pdf-pages` and `allow-origins` itself on `<datum-form-builder>`;
an absent builder `pdf-pages` means the bundled chunk). A relative value is resolved against the
page's base once, as the attribute is set: the absolute URL is what the origin check judges and what
the element keeps and later loads, so a `<base>` added afterwards cannot move it. A `wasm` or `pdf`
module that came from the attribute has its origin checked again right before it is imported. The
properties (`wasmValidationHost`, the assigned URL properties and the like) are written by script
the host controls and stay unrestricted.

## Reasoning

- **Absent means everything, present means exactly the list.** A page that says nothing keeps
  working; a page that lists features gets the bytes and behaviour it named. The list being the master
  keeps one place to read what exists.
- **A missing file is a degraded surface, not a broken page.** Included-but-missing shows an
  inline card with Retry and a `datum-error`, so a CMS that deletes unused chunk files can do so
  without writing a loader.
- **The PDF theme and layout selection stay behind a lazy chunk, but `pdfLayouts()` stays
  synchronous.** The theme lookup (`pdfThemeLookup`, through which the web components' PDF theme
  registry answers `pdfLookup(id)` synchronously) and the layout table and reader stay eager, as do
  the resolvers the builder's layout catalog, layout conditions and overview import statically; the
  merge, scale and selection logic loads with the PDF service. A lazy layout reader that made `pdfLayouts()`
  return `[]` until the PDF module loaded would change a public method for a small saving.
- **`WasmValidationHost` stays in the entry:** it is small and `form.ts` exports it as a value.
- **There is no `server-checks` attribute on the builder.** Its value is a function, which no URL
  reduces to; `wasm` is the declarative form. The renderer alone has `draft-store`.

## Consequences

- A host gets a one-page form or a canvas-only builder from one attribute, and a missing file
  degrades one surface, not the page.
- The entries are smaller (modes and panels leave); the cost is async first paint of the PDF and
  Journeys sides and two panels, and the loader API in section 4.
- Not gated by a token: formula controls in the inspector load the formula editor chunk when drawn.
