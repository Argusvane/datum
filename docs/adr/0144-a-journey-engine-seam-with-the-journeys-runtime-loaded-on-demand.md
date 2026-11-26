# ADR 0144: A journey engine seam, with the journeys runtime loaded on demand

## Status

Accepted.

## Context

Every renderer feature is deletable (ADR 0143) except what is woven through `FormRuntime`, the
runtime orchestrator and the shared submittable fold, and journeys were woven through all three:
the path engine, schema readers, presentation, page drawing, render, server check, the runtime's
Journeys and server-check sections, draft restore and completed-page validation, and the
orchestrator's presentation code. A plain one-page form would pay for all of it, and a host that
deployed without the journey files would have no defined failure.

Three facts shape the design:

- The shared fold already receives `evaluate` and `ownership` as input, so path and placement can
  be injected the same way.
- `journeyPath` runs on every keystroke of a journey form (no path cache; ownership is cached),
  and costs a little more per keystroke the more fields there are, independent of page count. A
  plain form pays nothing, which an "every form is a one-page journey" runtime would give up.
- `<datum-form>` builds its runtime asynchronously after a microtask, so a longer build for
  journey definitions changes a window, not the model.

The guide for the element's behaviour while the runtime loads is
[docs/reference/journeys.md](../reference/journeys.md#while-the-journeys-runtime-loads).

## Decision

1. **`FormRuntime` takes a `JourneyEngine`.** An interface (journeys, foldInput, presentation,
   view, frontier, reachable, planMove, onPath, pageStage, serverCheck, restore, describe, plus
   the navigation, checks and presentation-overlay parts the runtime builds through it) that is
   pure over (definition, state) and returns plans. `NoopJourneyEngine` serves plain forms
   (getters return undefined or `[]`, moves refuse with `no-journey`). The runtime keeps the
   state store, event bus, hook runner and error store. The public journey methods on the runtime
   and the element's API keep their signatures and, under Noop, return what they return for a form
   without a journey. `EagerJourneyEngine` is the real one.

2. **The fold takes path and placement as input.** `KernelFoldJourney` has required `path` and
   `place`; `submittable-fold.ts` does not import `journey-path.ts`. The sandbox program splices
   the same functions: the wire input, the outcomes and the ABI do not depend on which side
   supplies them. `portable-kernel.ts` imports `journey-path` for `kernelFoldSubmission` and the
   splice list (server and sandbox code, never in `datum-form.js`).

   **Kernel-owned forever**: path, frontier, reachability, placements, ownership, the submittable
   fold, `when` evaluation and the hidden-value policy are the contract on both sides, never
   pluggable and never behind an async boundary the server does not share. Whatever hooks a host is
   given around a journey, a plugin cannot add, remove or reorder pages, move the frontier, mark a
   page complete or alter answers: a real gate is data (a route's `when`, `validation.server`) that
   the server replays. `beforePageChange` is veto-only.

3. **Core keeps a small shared module** (`core/journey/journey-shared.ts`: `journeyOwn`,
   `journeyLeadingSegment`, `journeyCollectionPathOf`, `journeyHoldsOwnAnswer`), plus the definition
   readers (`readJourneys`, `readJourneyConfiguration`, `readDefaultJourneyId`, `findJourney`,
   `resolveJourneySelection`) that stay in `core/schema/journey.ts`. `journey-path.ts` re-exports the
   four helpers, so the builder, diagnostics and the kernel splice import them from there.

4. **The renderer's side sits behind a `JourneyRenderKit`** with a no-op default
   (`NoopJourneyRenderKit` in `render/core/journey-render-kit.ts`, `EagerJourneyRenderKit` in
   `render/core/journey-render-kit-eager.ts`): which components a page draws, its errors as the
   page shows them, its meta and wording, and the live renderer's page module (`pageFeature()`:
   `render/live/journey-page.ts`, the heading block, Back, Continue or Submit and focus after a
   page change, drawn through the binding's `page` hooks). Only the eager kit imports those
   modules, so they leave the entry with the engine. The page's CSS is part of the Datum binding's
   sheet, so plain-form output is identical with either kit. Render options take a `journeyKit?`
   (`RuntimeRenderOptions`, the render request, and `DatumFormRendererElement.journeyKit`); each
   falls back to the kit slot, Noop by default. The print model takes the kit too, and prints a
   journey form whole under the Noop.

5. **`<datum-form>` builds asynchronously for every form, and loads the engine chunk only for a
   definition with journeys that allows them.** "Has journeys" is
   `readJourneys(definition).length > 0`, read synchronously from the shared module.
   - A form with no journeys, or whose `features` leave journeys out, awaits the Noop pair (already
     in hand: no fetch, no chunk request).
   - A form with journeys awaits the engine chunk (`datum-form-journey-engine-chunk-*.js`, the path
     engine inside: exactly one journeys file for the renderer), which is already resolved when
     another journey form on the page loaded it; the runtime is then built with the engine and the
     render kit injected.
   - A journey with a page of kind `review` (Check answers) also awaits that page's chunk
     (`datum-form-journey-review-chunk-*.js`, the Check answers kit: the list's model, its live
     drawing and Datum's sheet for it). `<datum-form>` starts the two fetches at once, so such a
     journey waits for the slower of them, not for both in turn; `forDefinition(definition, review)`
     answers the engine and the kit for the definition from the chunk that arrived (a host that
     passes no `review` has the journeys chunk fetch it). The kit is then the journeys chunk's built
     over it, so the page is drawn with its list from its first draw. The journeys chunk's own kit
     (`createJourneyRenderKit()`) has no Check answers code, and a journey with no such page never
     requests that chunk. Its failure is the journeys chunk's: the same card, `datum-error` and
     rejections, the error naming the Check answers page.
   - The runtime, and `datum-ready` with it, is built in a later microtask for every form: a plain
     form's `datum-ready` does not fire inside `append()`, so a host that reads `element.runtime`
     straight after attaching waits for `datum-ready` or `ready`. While a build is pending the
     element queues what can queue (properties, and the promise-returning methods, which run in call
     order once built), throws for the two methods that return synchronously and cannot (`setErrors()`
     and `setLocale()`), and lets synchronous reads answer from the form being replaced until the
     swap. `element.ready` settles when the element next reaches a ready state for its current
     definition, and follows the form becoming ready, not one build, so a stale chunk failing late
     settles nothing. `datum-ready` and `ready` are the contract; the lists are in the guide.
   - A build token supersedes: a newer definition or `features` change discards a stale build,
     and the old runtime stays bound until the swap, not the request. Answers carried over a
     translations-only rebuild come from the bound runtime only when it was built for the current
     definition.
   - Failure follows ADR 0143's absent-code behaviour: an inline `[data-form-error]
     [data-journeys-error][role="alert"]` card with a `button[data-journeys-retry]`, worded by the
     `journeysUnavailable` and `retry` texts (`FormTextCatalog`, `DEFAULT_FORM_TEXTS`); the inner
     renderer is hidden; `datum-error {message, cause}` once per failure burst; the next attempt
     retries the import (a failed import is forgotten, `?retry=n` applies, since a browser keeps a
     failed dynamic import of one URL). A journey form is **never** silently rendered as one page,
     which would change what is submitted. The deliberate `features`-omits-journeys case is ignored
     with one console warning (decided from the definition, not from the Noop runtime), and the file
     is never requested.
   - `journey="form"` on a journey definition still waits for the chunk, because the journey can
     be switched later without a rebuild; a missing file then shows the card on a page that asked
     for the whole form.
   - Prefetch starts at definition time (like the WASM prefetch) when the definition has journeys
     and journeys is allowed; also at connect when `journey` (not `"form"`) is set or `features`
     lists `journeys` and a `src` is pending. Excluded means never requested.
   - Hook-driven page changes (`beforePageChange` returning a promise) settle one microtask later
     than a move without hooks, with identical order and payloads.

6. **`new FormRuntime`, `createFormRuntime` and the builder's preview stay synchronous.** The
   default engine is a slot on `globalThis[Symbol.for("datum.journeyEngine.default")]`
   (`setDefaultJourneyEngine`, `defaultJourneyEngine`; the render kit has its own slot,
   `setDefaultJourneyRenderKit`), initially Noop. The slot is global, not a module variable, so it
   survives `vi.resetModules()` and is one per page across the builder and form bundles.

   **Nothing registers on import**: `@argusvane/datum-engine` is `sideEffects: false` (ADR 0095) and its
   root exports `EagerJourneyEngine` and `EagerJourneyRenderKit` as values without registering them.
   Registration is explicit: the builder bundle entry and the vitest setup files of the engine,
   submissions, quickjs-wasm-host and site packages. `packages/datum` has no setup file.
   `datum-form.js` never registers an engine and `<datum-form>` always passes its own explicitly
   (Noop or the loaded one); it never reads the slot.

   A runtime built with Noop from a definition that has journeys (and `journey` neither `"form"` nor
   `"off"`) logs one console warning and runs as one page.
   - In `@argusvane/datum`, `createFormRuntime` / `FormRuntimeConfig` take `journeyEngine?` and do
     not default to the eager engine, so a host-built journey runtime is Noop unless the host takes
     the pair from the loader: `const { engine, renderKit } = await loadJourneyEngine()`,
     `createFormRuntime(def, { journeyEngine: engine })` and `renderer.journeyKit = renderKit`.
     Without the kit the journey is drawn as one page. `datum-form.js` exports
     `loadJourneyEngine()` and `type JourneyEngineBundle`; a failure rejects with a `ChunkLoadError`
     and is forgotten, so the next call retries.
   - `datum-engine.js` is the exception (ADR 0169): its `createFormRuntime` defaults to
     `EagerJourneyEngine`, imported statically, as a module a script chooses to import has no plain
     form to keep light. `datum-builder.js` registers `EagerJourneyEngine` and
     `EagerJourneyRenderKit` in the page slots on load (a side effect that reaches any runtime on the
     page naming no engine) and inherits `loadJourneyEngine`, which emits a
     `datum-builder-journey-engine-chunk-*.js`.

7. **Guards.** `scripts/guards/12-journeys-lazy.mjs` keeps the chunk lazy: the sentinel is in exactly
   one `datum-form-*.js` chunk and in no entry, no `datum-form-journey-path-*` file may exist, every
   moved string is absent from `datum-form.js` and present in the chunk, and both have budgets. The
   Check answers chunk has its own sentinel and budget, and its strings and source modules are in
   neither the entry nor the journeys chunk. `feature-files.json` lists both chunks under `journeys`,
   and guard 11 (`11-feature-files.mjs`) keeps `journeys` a lazy token, so a host can delete the files.
   `npm run absent-code:browser` runs the renderer's `journeys (form)` rows with the files deleted,
   excluded, deleted then restored via Retry, and CSP-blocked, beside the builder mode's `journeys`
   rows.

8. **Debug diagnostics.** The debug-only diagnostics chunk imports the engine chunk statically
   (this is how the path engine lives in exactly one file). `reportJourneyDiagnostics` runs only
   when the definition has journeys, so `debug` on a plain form does not fetch the runtime.

9. **The seam's surface in `@argusvane/datum-engine`** is `journey-engine.ts`: the `JourneyEngine`
   interface and its parts, `JOURNEY_ENGINE_MISSING`, `NoopJourneyEngine`, `setDefaultJourneyEngine`
   and `defaultJourneyEngine`. `FormRuntimeDependencies.journeyEngine?` and
   `RuntimeOrchestratorDependencies.journeyEngine?` take an engine; with none, the slot applies.
   `render/index.ts` re-exports `journey-render` and the eager kit; bundlers drop them because the
   engine is `sideEffects: false`. The kit is built by `createJourneyRenderKit(review?)` over an
   optional `JourneyReviewKit` (`EagerJourneyReviewKit` is the real one); `EagerJourneyRenderKit`
   is the kit over the real one, which the builder and the test setups register.

## Reasoning

- **Path and placement are fold inputs, not a second fold.** One kernel-shaped fold on both sides
  is what makes the browser and the server agree by construction (ADR 0178), so the seam moves
  where the path comes from and not what the fold does.
- **"Every form is a one-page journey" is rejected as a runtime unification.** It would make
  laziness impossible, tax every plain form with the per-keystroke cost, and change events,
  drafts and server input of plain forms. A one-page journey is an authoring shape (ADR 0112,
  "The page heading"), not a runtime.
- **A journey form is never rendered as one page when its runtime is missing.** That would change
  what is submitted; the card with Retry makes the failure visible and recoverable.
- **The four static route-resolution copies** (journey-path, diagnostics twice, journey-flow,
  journey-components) each cite the path engine on purpose, so they stay separate.

## Consequences

- A plain form does not carry the journeys code; a journey form pays one chunk, one request and a
  later `datum-ready`. The builder bundle keeps the engine eager (its Journeys mode is already a
  chunk). A small shared module and the definition readers stay in the entry.
- A documented "building" state with queue-or-reject behaviour; an engine-level unit-test layer
  (the engine is pure); the fold's input shape is guarded by the parity corpus.
- Deployed copies of the sandbox program need rebuilding only if the kernel bytes change.
- Plain-form keystroke cost is unchanged; a journey form's per-keystroke path cost stays.
