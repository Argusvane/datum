# ADR 0141: Try it on the builder's canvas

## Status

Accepted.

## Context

Try it hands the form back on the canvas: its controls work, its rules run, and the author types answers. It works in the Form workspace (ADR 0126) and in the journey and PDF designers, which run inside the same studio shell on the same canvas. They should look and behave like the Form workspace: the canvas bar with zoom, Fit and Try it, the selection bar, the shell's sizes and tiers, and a Try it that runs the journey or fills the PDF with answers the author has typed. That needs a few mode-level choices to hold:

- A fixed-width sheet (the journey's, the PDF paper) must not hide the canvas bar or refuse to shrink under a narrow canvas.
- A mode's controls must be drawn as the shell's own controls: its views switch with the bar's navigation, its actions with the canvas's tools, folding on a narrow canvas.
- Popovers and dialogs size from the builder's box, not the window, so they are right in a contained builder.
- Try it works wherever there is a canvas, with one set of answers.

## Decision

### 1. One canvas

1. **A fixed sheet keeps the bar.** A sheet with a width (`sheetWidth`) hides only the device widths and their grips; `previewWidths: false` hides them on the journey's fluid sheet too. Zoom, Fit and Try it stay, and the selection bar works on fixed sheets.
2. **A fixed sheet fits the canvas.** One that overflows the canvas page opens at fit-width and follows the canvas (`fitIfOverflowing`, a border-box `ResizeObserver`) until the author zooms (`zoomChosen`). `zoomTo("fit-width")` is the phone drawer's Fit. The sheet zooms up to 2x, and a surface that passes `zoom` up to 8x (`SURFACE_ZOOM_MAX`).
3. **A surface declares what the bar may do.** `showCanvasSurface(surface, { zoom, zoomable, tryable, selectionBar })`; nothing is zoomable or tryable by default. The template page viewer is zoomable and tryable. The journey map is neither: the canvas bar shows no zoom group for it, because the map zooms itself (25% to 200%, `docs/reference/journeys.md`, "The map in detail"), and Try it runs from the pages. A surface that draws a selection bar of its own, as the map does for its selected step, turns the canvas's off with `selectionBar: false`.
4. **The journey's Step view sheet is fluid.** It follows the Form sheet rule.

### 2. Mode controls: navigation on the bar, actions in the canvas's toolbar

1. **The top bar is navigation.** A `data-segmented` child of a mode's `barActions` (the switch between its views, Map | Step) is drawn in one `.bar-group` pill on the shell's bar as a segmented control of `bar-btn` buttons, so the Short and coarse-pointer sizes apply. The pill is not drawn while nothing in it shows.
2. **A mode's actions are the canvas's tools.** Every other control in `barActions` (a worded action: Suggest mappings, Create form fields, Preview PDF) is handed to the canvas (`DatumBuilderCanvasElement.setModeActions(controls, modeLabel)`), which moves the elements themselves into its toolbar in the order Print's toolbar uses: worded tools (`canvas-tool canvas-word`) before the width and zoom groups, then the `data-builder-primary` one (`canvas-try`, the accent pill) just before Try it. The canvas watches their `hidden` attribute, so the bar and its fold follow what the mode offers.
3. **They fold with the canvas's tools.** Under 520px of the canvas bar's zone (its container query) the worded tools fold with the width and zoom groups behind the canvas's one `⋯` button (`[data-canvas-more]`, its card `[data-canvas-more-pop]`), named "More PDF tools" (`shell.doc.moreTools`) while a worded tool is in it; the primary action and Try it stay. Opening the card takes focus to its first tool; running one, Escape or a click outside puts the card away. The canvas draws no count on an action; a mode that needs one draws it inside its own button.
4. **A phone has no canvas toolbar.** There every control stays in the bar's group, which the menu drawer takes (ADR 0137), and they go back to the canvas when the shell widens.
5. **The bar gives way to the name.** Under 1100px `data-bar-tight` hides the document face's chips.
6. **Sizes come from the shell's box.** The width observer sets `--db-shell-w` through a `:host` rule, on `.wrap` and on the dialogs. Popovers and dialogs size from it, never `vw` or `vh`, and on a phone the PDF designer's dialogs take a full sheet (`.wrap[data-phone] ~ dialog.dpd`).

### 3. Try it everywhere there is a canvas, with one set of answers

1. **Try it is a lazy chunk.** The panel and the canvas code that only runs while trying live in `datum-builder-try-it-*.js` (`builder/web-component/try-it.ts`, types in `try-it-types.ts`), loaded on the first Try it through a retrying memo. While it loads the panel's place shows a note, and a failed load shows Try again (`[data-try-load-retry]`), drawn by the eager module. `data-try-wasm` is also the sentinel `check-bundles.mjs` looks for, besides being the live status attribute of the WebAssembly part of the panel.
2. **The seam on the mode.** `BuilderMode.tryIt` is `{ session?(answers, dirty?), pdf?: { label(), preview(runtime, { workspace, root? }) }, cards?(view), onTryClick?(action) }`. A `BuilderTrySession` is `{ runtime, answers(), submit(), check?(), refresh(), restart(), dispose() }`. `BuilderMode.valuesChanged?()` is called on every mode a microtask after Back to editing. `BuilderPreviewRuntime` offers `pdfConfiguration()`, `submittableValues()`, `today()`, `clearValues()` and `replaceValues()`.
3. **Designers try the form.** In the Journeys and PDF workspaces the canvas draws the form's tree, binding, component adapters and data sources over the session's runtime, or the shared preview runtime, in one paint. A host's own mode in the Form workspace tries its own tree.
4. **It ends when its subject changes.** On every workspace, mode or document switch and on disconnect. The palette's `view:try-it` and the bar's button go through `requestLeave`. The phone bottom bar and drawer offer Try it in designers.
5. **One store, for as long as Try it is on.** The canvas's preview store holds the answers, so what was typed in Form carries into Journeys and PDF and back while Try it stays on.
   - Ending Try it empties it: Back to editing and a workspace switch end it, a mode or document switch ends it through the same canvas event, and a disconnect leaves the store to go with the canvas. The edit canvas then draws the form's defaults and the next Try it starts empty.
   - `DatumBuilderElement.triedAnswers()` returns the typed (dirty) answers only, `clearTriedAnswers()` empties them, and the Try panel offers Clear answers. Both are public on `<datum-form-builder>`.
6. **The form stays the form's.** Cmd/Ctrl+Z inside a tried field stays the field's. A tried form's locale switch does not change the builder's locale over a designer. Links never open in Try it.

### 4. Journeys

1. **Views are Map and Step** (ADR 0171, ADR 0119). Try it runs the journey on the canvas through a session of its own (`createJourneyPreviewSession`, chunk `datum-builder-journey-preview-*.js`, sentinel `data-journey-try-session`), the inspector live beside it.
2. **Loading.** The chunk loads ahead once a built journey is shown. If Try it starts before it arrives, the plain form runs and the journey takes over on arrival. Answers are carried both ways.
3. **The runtime.** The session is a real runtime handed `journeyConfiguration`, which makes it a preview: no page is checked against a server, which knows the registered definition and not the one being edited. The host supplies the runtime (`previewRuntime`; `<datum-form-builder>` builds it through `createFormRuntime`, as it builds its forms). Otherwise the engine builds one over the form's field constraints alone, with drafts, plugins and the wasm host off. The Journey card says which checks are off.
4. **The Journey card** leads the Try panel with the path so far, the problem or notice the last Submit or link left, Restart and "Open this step", with the journey's map between the head and the path line, marking the current step and the ways taken (ADR 0119). Open this step ends Try it and opens the Step view on the step the person was on. The card's notice is a live region (`role="status"`, `aria-live="polite"`) that stays in the accessibility tree while empty, so what it says is announced.
5. **Edits refresh the run in place.** Every edit, drafts included, re-reads the journey (`refreshJourney`), so the answers stay. A new form tree or new locales rebuild the runtime with the answers replayed, and the page is kept where the path still takes it; another locale is only switched to. Restart starts over with no answers. The runtime's journey names each page by its designer node id, so the page on screen is kept by node while its id is typed or saved; `startJourney` could not reopen a later page, since nothing is completed when a journey starts.
6. **Checks.** `check()` is read-only: it validates a scratch runtime holding the same answers and lists the problems on the path so far. Submit is kept to the session: the answers are checked as a submit checks them, nothing is sent, and the card says "The journey would submit here." or, held back, takes the person to the first page of the path holding an answer that needs attention.
7. **Journey-only `@` answers** (a journey's own questions, `@<journey id>.<own id>`) are dropped when Try it ends. The session's runtime indexes the journey's own nodes afresh on every edit, so a field dropped in is asked at once; a rebuilt runtime keeps the journey's own answers and drops any other journey's. The Map and the empty states are not tryable.
8. **The tried form** keeps a language switch, Cmd/Ctrl+Z typed in a box and a drag to itself, and a link the author wrote does not open (section 3, rule 6).
9. **Another definition** (Open form file, New form, a host's `definition`) starts the run over with no answers.

### 5. PDF: fill in, then Preview PDF

1. **The PDF card.** In the PDF workspace the Try panel leads with it: the label from `tryIt.pdf.label()` (the layout's name and paper for a generated layout, the name alone for a template), Preview PDF, "N typed answers" and Clear answers.
2. **Preview PDF goes through the PDF mode from any workspace.** `renderPdf({ layoutId?, runtime?, byAnswers? })` takes the tried runtime. Outside the PDF workspace it renders the layout the answers choose (`byAnswers`, ADR 0044), inside it the open layout, in the mode's own dialog. The `tryPdf` loader serves hosts without a PDF mode, and `BuilderMode.definitionPdf?()` serves host modes on a page with no PDF mode.
3. **The canvas's runtime is completed.** The mode wraps it in a Proxy that adds `pdfConfiguration` and, where the runtime lacks them, `translationCatalog`, `pdfRenditionSources` and `formId` from the host's runtime, so the PDF matches the toolbar's Preview PDF.
4. **The toolbar's Preview PDF and the sheet's previews use the tried answers**, only while Try it is on. After Back to editing they render with blank answers, and the button's tooltip says the answers are those in Try it now, none once it has ended. They read `values()` merged by the host, plus `triedRuntime`, `triedCount` and `clearTried` on the mode's options; the wrapper (`builder-element.ts`) passes all three. Back to editing calls `valuesChanged()`, which reruns `ensureFresh`; that swaps the component definitions so the canvas repaints. A template layout's page viewer is tryable.

### 6. The Try it panel

While the canvas previews a form tree, a column of cards takes the inspector's place and the page leaves room for it.

1. **The inspector gives way.** Its drawer steps aside while the canvas previews (`data-trying` on the shell); the selection is kept, so Back to editing brings it back. Turning Try it on asks about unapplied edits first, as leaving the selection does, because a prompt in a drawer put away would go unseen. The side column closes too, and opens again on Back to editing unless the author opened another meanwhile.
2. **Show the form.** Fill in or Read only (the renderer's `mode`), Print (the renderer's `print()`) and Preview PDF. A read-only form draws its tabs stacked, each a panel with its name as a heading (the rule is ADR 0081's, and ADR 0035's for a print; the markup is `section.datum-form__panel.datum-form__tabs-section` with `data-tab-panel`, so going to an error inside it still finds it); a binding draws these sections as it draws panels, and the datum binding's `panelRegion: "none"` leaves them unnamed.
3. **Checks.**
   - *In the browser.* Check now runs the browser's field rules on the answers through the field-constraints stage (the preview runtime runs no pipeline), handing the stage the runtime's `invalidMap()` so a `validWhen` rule is judged (ADR 0120). Components a rule hides are left out. Each problem is worded with the form's message catalog, falling back to the engine's description of the code, and goes to its field. "Check as answers change" reruns the checks a beat after each answer.
   - *On the server.* The server's checks run when the host lends `serverChecks` (`{ label?, run({ root, answers, locale }) }`), with the same verdict a submission would get.
   - *WebAssembly validation* is always a part of Checks: a toggle with a line saying where the validator stands; once loaded, the source's `label` names it. `serverChecks` takes the checks in hand or a function that loads them (`TryItServerChecksSource`); the loader is called the first time the author turns the toggle on, and its result is kept. A rejection says "Not available:" with its reason, leaves the toggle off and offers Try again. With none lent, the part says the page provides no WebAssembly validator and the toggle is disabled, which is state, not a problem to fix. `<datum-form-builder>`'s `wasm` attribute lends the loader (`auto`, the default, is `datum-wasm.js` beside the bundle; a URL; or `off`), and a page's own `serverChecks` wins over it (`docs/reference/attributes.md`).
4. **Submission data.** The answers as the envelope carries them (`kernelJsonAnswers`), live, with Copy.
5. **Preview PDF** renders the answers tried, through `tryPdf` (a host's `{ provider, fonts? }`, or a loader). `<datum-form-builder>` lends its PDF side's support, loaded on the first preview. The file opens in a new tab, or downloads when the window is blocked.
6. **Submit answers as a server would.** The form's Submit (a journey's own too) is not swallowed while the canvas previews. A stand-in for the page's server answers it, set up in the Settings panel under "Submitting in Try it": what the server does (accepts, refuses, cannot be reached), how long it takes, the receipt, the refusal message, and whether the answers stay editable after an accept. These live on the controller as session state (`trySubmission()` and `setTrySubmission(update)`, a `TrySubmissionSettings` kept to what each value may be), never in the definition.
   - *The checks first.* Submit runs the browser's checks, and the WebAssembly validator's when it is on. Problems go on the form through the preview runtime's `setErrors`, drawn at their fields and in the summary, and the Checks card lists them. Nothing is sent. A field's errors go when its value changes.
   - *Then the answer.* The form shows `submitting` for the delay (ADR 0052), then the receipt as its `notice`, or a refusal or a failure as an error of the form's own.
   - *One at a time.* A submit in flight ignores another. Back to editing, leaving Try it and Fill in clear the receipt, the errors and the status line.
   - *The panel and the event.* A "Last submit" card says what happened. The canvas reports `builder-try-submit` with `outcome` (`invalid`, `accepted`, `refused`, `failed`), the `answers` and the `reference`.
7. **Host values for `host.` rules.** The Settings panel's "Host values" box takes a JSON object that the preview's rules read under `host.`. It lives on the controller as session state, like the simulated lists (`tryHostContext()` and `setTryHostContext(record)`, a `"preview"` change: never an edit, never undoable, never in the definition). The box applies when it is left, so the canvas and Try it do not repaint as it is typed in, and a box with the caret is never rewritten. Text that is not JSON, or JSON that is not an object, is said under the box (the problem sits with its box, nothing is disabled) and the last good values stay applied; an empty box is no context.

   A record goes through `plainHostContext` (`core/state/host-context.ts`), the same sanitiser `<datum-form>`'s `hostContext` property uses, so one set of rules says what plain data is. The preview applies it in place (`BuilderPreviewRuntime.setHostContext`, the orchestrator keeps the typed answers); a mode's session runtime takes it when it has `setHostContext`. Try it hands the same record to the server's checks as `hostContext` in the request, so both sides judge a `host.` rule alike. The control is always drawn, with a line saying the form reads host values only when a rule does, and it goes with the `try-it` feature.

## Reasoning

- **Try it, not a separate preview.** A separate surface for the run would need its own runtime and bar. Running the journey on the canvas through a session gives it the canvas's bar, tiers, answers and Submit, and one place to maintain.
- **Answers are shared while Try it is on and gone after.** Keeping them in the canvas's one store lets an author type once and see the form, the journey and the PDF; keeping them after Try it ended made the edit canvas show a stranger's typing as if it were the form's own.
- **Preview PDF uses typed answers.** A PDF rendered over the host's sample values gave the author no way to see their own answers on paper.

## Consequences

- Journeys and PDF layouts get the Form canvas's bar, Try it and tiers; the PDF paper stays at its paper width and fits.
- A host page tries its rules in Try it, since the edit canvas takes a field's click as a selection (ADR 0126).
- Hosts can lend Try it `serverChecks` and `tryPdf` (on `<datum-builder>`; `serverChecks` also on `<datum-form-builder>`).
- The builder's reference documents `triedAnswers()` and `clearTriedAnswers()` on `<datum-form-builder>`.
