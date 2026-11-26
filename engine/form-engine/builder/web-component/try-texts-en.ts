/**
 * Try it's English (a lazy chunk the builder loads on the first Try it), kept out of the eager table in `logic/builder-texts.ts` so the builder entry
 * carries none of it (the entry's size budget). Every key here is read only by code
 * in that chunk, through this module's `builderText` and its kin (or `areaWords`, the builder words reading this table): the lookup is the builder's
 * one (`builderText`), this table only supplies the English. `engine/tests/builder-texts.test.ts`
 * holds each key to exactly one table and each table to its own readers.
 */
import { areaText } from "../logic/builder-texts.js";

export const TRY_EN = {
  // The Try it surfaces
  "try.theForm": "The form",
  "try.grab": "Drag to close or tap to expand",
  "try.close": "Close the results",
  "try.submit.none": "Not yet. Press the form's Submit to try it.",
  "try.submit.submitting": "Submitting…",
  "try.submit.accepted": "Accepted{reference} · {time}",
  "try.submit.reference": " · {reference}",
  "try.submit.refused": "Refused · {time}",
  "try.submit.failed": "Could not be sent · {time}",
  "try.submit.invalid": "{problems}: nothing was sent · {time}",
  "try.submit.title": "Last submit",
  // A form with no Submit button cannot be submitted: said above the last submit, with the way to add one.
  "try.noSubmit.message": "This form has no Submit button, so it cannot be submitted.",
  "try.noSubmit.add": "Add a Submit button",
  "try.submit.settings": "What Submit does is in Settings, under Submitting in Try it.",
  "try.wasm.title": "WebAssembly validation",
  "try.wasm.toggle": "Run the WebAssembly validator (the server's checks)",
  "try.wasm.none": "Not available: the page provides no WebAssembly validator.",
  "try.wasm.idle": "Loads the first time you turn it on.",
  "try.wasm.loading": "Loading the WebAssembly validator…",
  "try.wasm.ready": "Ready: {label}.",
  "try.wasm.failed": "Not available: {reason}",
  "try.wasm.didNotLoad": "it did not load.",
  "try.wasm.retry": "Try again",
  "try.pdf.rendering": "Rendering…",
  "try.pdf.preview": "Preview PDF",
  "try.pdf.title": "PDF",
  "try.pdf.failed": "The PDF could not be made: {reason}",
  "try.pdf.nothing": "Nothing was rendered.",
  "try.answers.none": "No typed answers yet",
  "try.answers.one": "{count} typed answer",
  "try.answers.other": "{count} typed answers",
  "try.clear": "Clear answers",
  "try.show.title": "Show the form",
  "try.mode.fill": "Fill in",
  "try.mode.readonly": "Read only",
  "try.print": "Print",
  "try.checks.title": "Checks",
  "try.checks.now": "Check now",
  "try.checks.live": "Check as answers change",
  "try.browser": "In the browser",
  "try.noProblems": "No problems.",
  "try.server": "On the server",
  "try.server.checking": "Checking…",
  "try.server.ok": "No problems: the server would accept these answers.",
  "try.server.failed": "The server's checks did not run: {reason}",
  "try.server.refused": "The server refused the form.",
  "try.data.title": "Submission data",
  "try.copy": "Copy",
  "try.data.note": "The answers as a submission carries them.",
  // Show me: the bar's step control while a test's step is on the canvas.
  "try.showing.label": "Showing step {step} of {steps} · “{name}”",
  // A journey's page is named, not gone to: the journeys canvas is a mode's session.
  "try.showing.page": "Showing step {step} of {steps} · “{name}” · page {page}",
  "try.showing.step": "Step",
  "try.showing.back": "Step back",
  "try.showing.forward": "Step forward",
  "try.showing.stop": "Stop showing",
  // The scenario's givens the canvas could not apply to the showing: named after the label.
  "try.showing.notApplied": "not applied here: {givens}",
  "try.showing.given.today": "the day",
  "try.showing.given.locale": "the language",
  "try.showing.given.options": "the lists",
  // Record: the bar while what is done in Try it becomes a test's lines.
  "try.recording.label": "Recording",
  "try.recording.stop": "Stop recording"
} as const;

export const { builderText, builderPlural, builderTemplateParts, formatListText, areaWords } = /* @__PURE__ */ areaText(TRY_EN);
