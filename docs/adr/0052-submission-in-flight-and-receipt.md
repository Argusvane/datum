# ADR 0052: Submission: in flight, the receipt, host-supplied errors and the download action

## Status
Accepted.

## Context

A submission takes as long as the server takes. `<datum-form>.submit()` awaits the runtime,
dispatches `datum-submit` and resolves, while the page's `fetch` runs inside a listener the
element never waits for. If the form did nothing about that, then while the reply was on its way
it would look exactly as it had before Submit was pressed: no message, every field and the
language switcher live, the button ready for a second press that starts a second `runtime.submit`
and a second delivery. Nothing would say "submitting", so nothing could be said in French
either. And when the server answers, the way back into the form for a verdict is `setErrors`
(decision 9); a receipt, the confirmation number a 200 carries, needs a way in too.

Three things are needed, in one shape: the form has to *hold still and say so* for exactly the
window the page is busy, the page has to be able to *tell the form how long that is*, and the
outcome has to have a way *in* whether it is a verdict or a receipt.

**Errors after delivery.** The embeddable `<datum-form>` (ADR 0038) hands the canonical
submission envelope to the page through `datum-submit` and leaves delivery to the page. That puts
the server's verdict outside `submit()`: by the time the page's `fetch` resolves, the runtime has
already validated, accepted, and returned. ADR 0001's orchestration, in which a blocking server
error aborts the submission and is stored for display, assumes the server-validation stage runs
*inside* `submit()`, which the bundles switch off (`serverValidation: false`, no runner), and
which in any case models a privileged server-side hook rather than an HTTP round trip from a
browser. So a failed delivery needs a way back into the form. `FormRuntime`'s error store is
private and written only by `validate()`, the wasm stage and the server stage; the element's
`errors` is a getter; submission handlers report a throwing deliverer as `handlerErrors` without
displaying anything. And an error that names no component, such as "the form could not be sent",
must still render: a summary that listed `byComponent` entries only would show a count over an
empty list.

**The download.** A `button` component asks its host to do one thing, named by a closed
`ButtonAction` vocabulary (`core/schema/button.ts`). The renderer reports the press as
`datum-form-action` and acts on nothing, because `runtime.submit(modeId, versionContext)` needs
arguments only the host has; the host's dispatcher (`<datum-form>` in `packages/datum`) is where
an action gets its meaning. People who fill in a form may have no server to post it to. They need
the validated answers in a file the browser downloads, to attach to an email, upload somewhere,
or keep. `FormRuntime.submit()` validates, canonicalizes and optionally signs; the missing piece
is the file. A fuller submission package, a wrapper with a digest, a `submissionId` and an Import
on the receiving side, is a separate record (ADR 0064).

## Decision

1. **The renderer draws a submitting state.** While the form is busy submitting (the renderer
   element's `submitting` property, or the runtime's submission in flight) the live renderer
   (`render/live/mount.ts`) puts `aria-busy="true"` and `datum-form--submitting` on the
   `<form>`, draws a status line (`role="status"`, polite, with the `submitting` text; the
   binding's `status` hook, else Datum's `datum-form__status`), and puts `inert` on every field
   and container of the body and on the header and footer chrome regions. `inert` takes every
   field, button and switcher out of focus and pointer reach in one attribute; the status line
   stays live so what it says can be read. Print and the builder canvas never draw it.
   `submittingPlacement` lists the ends the line goes at, by the same rule as a notice's `placement`
   (decision 6): the top by default (between the header and the summary), the bottom beside the
   button the person pressed, or both with
   the bottom copy a visual echo hidden from assistive technology so the line is announced once.
   The renderer and host elements take it as a property; on `<datum-form>` it is the
   `submitting-placement` attribute, the ends separated by spaces, an end that is neither reported
   as `datum-error`.

2. **Writes are refused while it runs.** Inert regions deliver no events in a current browser,
   and the renderer's write guard drops any write that still arrives while the form is
   submitting, so nothing reaches the runtime and no action is dispatched. Datum's stylesheet
   dims the locked regions. Focus is remembered when the lock comes and put back when it lifts,
   unless something else took it meanwhile (the first error, a notice).

3. **The wording is the page's, per locale.** A `FormTextCatalog` (`texts` on the renderer, the
   host element and `<datum-form>`, JSON in the attribute) holds the form's own chrome text as
   `LocalizedText` entries, `submitting` among them, resolved like host data. Left out, the engine
   says "Submitting…". It is distinct from `messages`, which is validation text keyed by error
   code.

4. **`detail.waitUntil(promise)` on `datum-submit`.** The Service Worker `ExtendableEvent`
   pattern: the listener keeps its shape and hands its delivery over. `<datum-form>` locks the
   renderer before `runtime.submit`, dispatches the event, awaits every extension (by index, so
   one added while an earlier one is awaited is awaited too) and unlocks in `finally`.
   `waitUntil` throws once the dispatch is over and no extension is pending. A rejected extension
   is reported as `datum-error` and lifts the lock like a resolved one; what the person sees for
   it is the page's `catch`, through `setErrors`. There is no timeout of the form's own: the lock
   lasts exactly as long as the page's promise, and the page carries the deadline
   (`AbortSignal.timeout` on its fetch).

5. **One submit at a time.** A `submit()` while one is in flight joins it only when it asks the
   same thing, so a double click still reaches one delivery. `FormRuntime.submit` compares every
   argument (deep equality over plain data; functions and class instances match by identity). The
   element compares the definition, the runtime and the route (local copy, journey end check,
   signer, signing, agent) and ignores a button's `trigger`. Any other call rejects with
   `SubmitBusyError` (`code: "submission.busy"`), never joining the run and never starting a
   second; the slot clears when the promise settles. A second press of the button reaches nothing
   (the regions are inert, the listeners return).

   Two more calls are refused the same way (`submitWaitsOnHost`), because a call that awaits the
   run it sits inside would wait on itself:
   - a `submit()` made while the run is waiting on one of its own hooks (beforeSubmit,
     transformValues, beforeValidation, afterValidation, afterSubmit; only when that list is not
     empty). Delivery is not counted: a double click during delivery is the case the join is for;
   - a `submit()` asked from a `datum-submit` listener while the event is being dispatched. The
     refusal reaches the page as a delivery failure and no confirmation is shown.

   The refusal names the form in flight, not the one now held. `submit()` resolves once the
   runtime has answered and every extension has settled, so `submitAndDownload()` downloads after
   delivery. `submitting` is readable on `<datum-form>` and reflected as its `submitting`
   attribute, for `datum-form[submitting]` styling or an observer.

6. **`setNotice(notice)`, the receipt counterpart of `setErrors`.** A `FormNotice`
   (`{ kind?, title?, message?, details?, data? }`, every text a `LocalizedText`) is drawn by the engine
   as a focusable panel where the error summary goes, worded for the locale like a label, styled
   in the outcome's colour, and carried into the printed form so a printed copy keeps the
   confirmation number. Focus moves to it as it moves to the summary.

   Its `placement` lists the
   ends of the form it goes at:
   - `["top"]` (the default, where the summary goes).
   - `["bottom"]`
     (after the fields, beside the button the person just pressed).
   - Both.

   A list rather than an
   enum with a "both" value, so a further place would be one more name, not more combinations;
   missing or empty means the default, and order and repeats do not matter. Listed at both ends,
   the top copy is the status region (announced, focusable)
   and the bottom one a visual echo hidden from assistive technology, so the receipt is read
   once.

   `data` is the receipt as plain JSON (`{ reference: "GC-48213" }`), never drawn by itself: a
   printed form's header and footer read it as `{{receipt.<path>}}` (ADR 0174), and a notice that
   carries only `data` draws nothing and takes no focus.

   The next `submit()` clears it, as it replaces errors; `setNotice(undefined)` clears it
   too; a rebuilt runtime starts without one. What happens to the answers is the page's choice
   with what exists: leave them editable, or `mode = "readonly"` to keep them as sent.

7. **A notice has four kinds.** `FormNotice.kind` is `"success" | "info" | "warning" | "error"`
   (`FormNoticeKind`), so a host can say a delivery is held, or failed, in the notice's own voice
   instead of faking it with a success. A missing or unknown kind is a success. The renderer draws
   no icon: a binding that draws one does it in its own notice adapter.
   - **Role and live region.** An error is `role="alert"` (assertive), as the error summary is and
     for the same reason: the person pressed Submit and it did not work, and the sentence has to
     interrupt. A warning stays `role="status"` (polite), with success and info: it asks for
     attention without a verdict, and WCAG 4.1.3 asks for a status message, not an alert. Every
     kind keeps `tabindex="-1"` and takes focus (`<datum-form-renderer>.focusNotice()`, as
     `focusFirstError()` does for the summary), and at both placements the bottom copy is the
     silent, `aria-hidden` echo with no role, so the text is read once.
   - **The alert is drawn once.** The error's `role="alert"` is drawn on the draw that first shows
     the notice only (`FormNoticeState.assertive`, `render/live/contract.ts`); every later draw of
     the same notice draws the region as a `role="status"`, since a new alert node would be
     announced again. The summary can be an alert on every draw because its list changes as errors
     are fixed; the notice's sentence never does.
   - **Colour.** A warning notice's focus ring is the form's `focus-ring-color`, not its amber
     edge, which falls under 3:1 on a light page. An error notice's fill and words are the
     summary's own pair, which the Datum token sets are already held to.
   - `FormNotice` is host-to-element data, absent from the sandbox and PDF kernels, so no ABI
     carries it.

8. **A retry carries one submission key.** The `datum-submit` event carries
   `detail.submissionKey`, a UUID the browser mints once per submit attempt and reuses for every
   retry of it. The receiving service keeps the key with the stored record and treats the same key
   with the same digest as the same submission (ADR 0064 holds the server's rules).

**Errors after delivery.**

9. **`FormRuntime.setErrors(errors: HostError[]): FormError[]`.** The host's errors replace the
   store's contents and are announced through `ERRORS_CHANGED`, the same contract the wasm and
   server stages hand renderers, so inline field errors, the summary and localization by code
   all apply unchanged. A `HostError` is `{ code, message?, componentId?, path?, severity?,
   parameters?, source? }`; it is stored under `stage: "host"` with `source` defaulting to
   `"server"`.

   The form's validity follows the blocking errors. Submission status is untouched
   and no `VALIDATION_COMPLETED` is published: nothing was validated.

10. **Replace, not merge, and validation replaces in turn.** After an accepted submit the store
    is empty, so replacing is the deterministic choice; the next `validate()` or `submit()`
    replaces the host's errors with the pipeline's verdict, which is the intended lifecycle.
    `setErrors([])` clears.

11. **Form-level errors render.** `RenderErrorSummary` carries the errors with no `componentId`
    as `formErrors`; the summary lists them first, as text (nothing to focus, so no focus
    button), ahead of the per-field entries. The summary is `tabindex="-1"` so it can take
    focus.

12. **Focus follows, as after validation (ADR 0001).** `<datum-form-renderer>` has a public
    `focusFirstError()`, which `validate()` also uses: once the draw the errors triggered has
    landed, focus moves to the first blocking field error, or to the summary when only
    form-level errors remain.

13. **`<datum-form>.setErrors(errors)`** calls the runtime's method and then the renderer's
    focus. No event is dispatched: the page initiated it, and `errors` reflects it. A rejected `fetch` is
    reported as a form-level `delivery.failed`; `docs/reference/embedding.md` ("Render a form")
    shows the pattern.

**The download action.**

14. **`"download"` is a `ButtonAction`.** It means: submit, and when accepted hand the canonical
    envelope to the person as a JSON file. `BUTTON_ACTION_OPTIONS` presents it as "Submit and
    download JSON" after "Submit form", so the builder's Action picker offers it. A rejected
    submit shows its errors and downloads nothing: the file always holds validated, canonical
    data, never raw state (raw state is what a draft file is for).

15. **The host still submits; the renderer still only reports.** `<datum-form>` handles
    `"download"` beside `"submit"` in its dispatcher and exposes the same route as
    `submitAndDownload()` for a page's own control. A host with its own dispatcher adds its own
    case, exactly as for any other action. `readButtonAction` passes an unknown action string
    through, so the form still renders and a host's dispatcher warns about an action it has no
    case for, rather than the renderer failing.

16. **The file is the envelope itself.** `core/submission/submission-file.ts` (pure, in the core
    layer) serializes the `CanonicalSubmission` in canonical key order, pretty-printed, and names
    it `<form id>-submission-<YYYYMMDD-HHMMSS>.json` with the id reduced to file-safe
    characters. No wrapper: a file the form owner opens reads as the same envelope every other
    delivery route carries, and a host that accepts `datum-submit` payloads accepts the file
    unchanged. Stable ordering keeps two saves of the same answers byte-identical; the indent is
    for the person, since unlike the wire form this one is meant to be read.

17. **`downloadSubmission(target, submission)` is the one way onto the disk.**
    `render/web-component/submission-download.ts` (DOM only inside its functions, so the render
    barrel stays importable under Node) dispatches a cancelable `datum-download` from `target`
    (bubbling and composed, carrying the envelope, the file name and the exact text) and unless
    it was cancelled saves the text through a temporary `<a download>` on an object URL, the
    pattern the renderer uses for attachments. `preventDefault()` hands the file to a host that
    stores it itself: the same seam shape as `datum-print` (ADR 0035).

## Consequences

- A screen reader hears the status line once per paint that inserts it; the runtime's own writes
  at the start of a submit can repaint a few times in quick succession. Polite, not assertive,
  keeps that from interrupting.
- A host that calls `FormRuntime.submit()` directly gets the same one-at-a-time refusal; the
  renderer's `submitting` lock is the host's to set around its own submit-and-deliver when it does
  not use `<datum-form>`.
- Host markup inside a notice is not supported: the `html` component stays the one place host
  markup enters the form.
- A page has one path for anything it learns after the envelope leaves the form: a field the
  server rejected, a reply it could not get. Message wording comes from the host's `messages`
  catalog by code when it has an entry, else from the error's own `message`.
- Host errors on a field the person then edits stay until the next validation, as client errors
  do; the form does not lock after an accepted submit, so resubmitting is the recovery.
- The engine's own submission paths are unchanged: the wasm and server stages still block
  inside `submit()` as ADR 0001 describes. `setErrors` is for what happens after.
- `submit`'s side effects apply to `download` too: `datum-submit` is dispatched and submission
  handlers run, because a download is a delivery route beside them, not instead of them. A page
  that wants the file only leaves `datum-submit` unhandled.
- The file carries the `signatures` an envelope has when the submission mode signed it, and
  attachments travel inside `values` as base64 (ADR 0034), so it is self-contained and
  correspondingly large for a form with big attachments.
- The submission package of ADR 0064 wraps this file's content (`canonical`) rather than
  replacing it; `datum-download` is where a package-producing host takes over.
