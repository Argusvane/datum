/**
 * What the Try it panel's seams are made of: the types a host
 * lends the builder (a WebAssembly validator, PDF support) and the ones the canvas and the
 * lazy chunk (`try-it.ts`) share. Types only, so the builder's main bundle carries none of it
 * and the chunk stays a chunk.
 */
import type { ComponentNode } from "../../core/schema/types.js";
import type { ValidationResult } from "../../core/schema/contracts.js";
import type { PdfFontProvider, PdfRenderProvider } from "../../render/pdf/pdf-provider.js";
import type { BuilderController } from "../controller/builder-controller.js";
import type { DatumFormRendererElement } from "../../render/web-component/form-renderer-element.js";
import type { BuilderPreviewRuntime } from "../preview/builder-preview-runtime.js";
import type { BuilderMode, BuilderTrySession } from "./builder-modes.js";
// A type only: the canvas is eager code, and a value import from the Tests chunk would pull it into the entry.
import type { CanvasScenarioShowing, TestsAssertSnapshot, TestsRecordListener } from "../form-tests/tests-model.js";

/** A scenario's given the canvas could not apply to a showing: the bar's note names each. */
export type TryShowingGiven = "today" | "locale" | "options";

/**
 * A mode's session that runs pages under ids of its own (the Journeys mode's preview runs each
 * page under its designer node id): `pageIdOf` gives the journey's page id for one,
 * so Record and Assert this name pages as a test does. Optional; absent, the id is the page's.
 */
export interface TrySessionPages {
  pageIdOf?(runtimePageId: string): string | undefined;
}

/**
 * A host's way to run the server's checks on the answers tried (the WebAssembly sandbox's run):
 * the same verdict a submission would get. `label` names it in the panel.
 */
export interface TryItServerChecks {
  label?: string | undefined;
  /**
   * `kinds` is the form's `kinds` map as the builder would save it (`BuilderController.definitionKinds()`
   * over the opened file's `openedKinds`), present when the form uses a plugin's or a binding's type:
   * put it into the kernel's run context (`context.kinds`), so a `gcds-date` is checked as a date
   * there too. A host that drops it checks such a type as nothing on the server.
   *
   * `hostContext` is what Try it's Settings gave the form's `host.` paths, present when the
   * author gave any: put it into the kernel's run context (`context.hostContext`), so a `host.`
   * rule is judged there as it is in the preview. A host that drops it judges those rules with no
   * host values.
   */
  run(request: {
    root: ComponentNode;
    answers: Record<string, unknown>;
    locale: string;
    kinds?: Readonly<Record<string, string>>;
    hostContext?: Readonly<Record<string, unknown>>;
  }): Promise<{ errors: ValidationResult["errors"] }>;
}

/**
 * The server's checks as a host lends them: in hand, or a loader the panel calls the
 * first time the author turns the WebAssembly validator on, its result kept once it resolves.
 */
export type TryItServerChecksSource = TryItServerChecks | (() => Promise<TryItServerChecks>);

/** What Preview PDF renders with: the host's PDF provider and fonts. */
export interface TryItPdfSupport {
  provider: PdfRenderProvider;
  fonts?: PdfFontProvider | undefined;
}

/** The support itself, or a way to load it on the first Preview PDF (the PDF program is large). */
export type TryItPdfSource = TryItPdfSupport | (() => Promise<TryItPdfSupport>);

/** One problem the checks found, worded for the panel. */
export interface TryCheckProblem {
  componentId?: string | undefined;
  label: string;
  message: string;
}

/**
 * Where the WebAssembly validator stands: none lent, lent but not loaded, loading, ready, or its
 * loader failed (`reason`).
 */
export type TryWasmStatus = "none" | "idle" | "loading" | "ready" | "failed";

/** What the form's Submit last did in Try it. */
export type TrySubmitStatus =
  | { state: "none" }
  | { state: "submitting" }
  | { state: "accepted"; reference?: string | undefined; at: Date }
  | { state: "refused"; at: Date }
  | { state: "failed"; at: Date }
  | { state: "invalid"; count: number; at: Date };

/**
 * Detail of `builder-try-submit`: what the form's Submit did in Try it, against the
 * stand-in server the Settings panel sets up. `invalid`, the checks found problems and nothing
 * was sent; otherwise the stand-in accepted (with the receipt's `reference`), refused or failed.
 * Bubbles and is composed, from the canvas.
 */
export interface BuilderTrySubmitDetail {
  outcome: "invalid" | "accepted" | "refused" | "failed";
  /** The answers as a submission carries them. */
  answers: Record<string, unknown>;
  reference?: string | undefined;
}

/**
 * What an agent's Submit in Try it ended with: the same detail
 * `builder-try-submit` carries, under the name the agent seams use. A new name, not a new shape.
 *
 * @internal
 */
export type TrySubmitOutcome = BuilderTrySubmitDetail;

/**
 * What an agent's Check in Try it found: the problems the panel draws (the
 * browser's or the mode's session's, then the server's not already said), and whether the
 * server's checks ran: `"off"` when the person has them off (an agent never turns them on),
 * `"ran"` when they answered, `"failed"` when they were on and did not.
 *
 * @internal
 */
export interface TryCheckOutcome {
  problems: TryCheckProblem[];
  server: "off" | "ran" | "failed";
}

/** What the Try it panel draws from (`tryPanelHtml`); a mode's cards are handed it too. */
export interface TryPanelView {
  mode: "interactive" | "readonly";
  answers: string;
  live: boolean;
  /** The browser's problems, once checked; `undefined` before the first check. */
  problems?: TryCheckProblem[] | undefined;
  server: {
    status: TryWasmStatus;
    /** The validator's name once loaded (its `label`). */
    label: string;
    reason?: string | undefined;
    on: boolean;
    busy: boolean;
    problems?: TryCheckProblem[] | undefined;
    failure?: string | undefined;
  };
  submit: TrySubmitStatus;
  pdf: boolean;
  pdfBusy: boolean;
  pdfError?: string | undefined;
  /** How many answers are tried (non-empty ones): with it, Clear answers is offered. */
  answered?: number | undefined;
  /**
   * The mode's PDF card, first, saying this (the open layout): Preview PDF and Clear answers move
   * there from Show the form. Only in the mode's own workspace.
   */
  pdfCard?: string | undefined;
  /** The mode's own cards' markup, drawn ahead of the standard ones (`BuilderModeTryIt.cards`). */
  modeCards?: string | undefined;
}

/**
 * What the canvas lends the chunk: everything is read through functions, since the
 * controller, the preview and what a host lent change after the chunk is made.
 */
export interface TryItOptions {
  /** The canvas, for the events the panel raises (`canvas-results-close`, `builder-try-submit`). */
  canvas: HTMLElement;
  root: () => ShadowRoot;
  /** The canvas's controller: its locale (the bar's language, the chrome's switcher) is the one the checks word problems in. */
  controller: () => BuilderController | undefined;
  preview: () => BuilderPreviewRuntime | undefined;
  renderer: () => DatumFormRendererElement | undefined;
  /** The controller whose Submitting in Try it settings apply: the form's, else the canvas's own. */
  trySettings: () => BuilderController | undefined;
  /** What a host lent: read on every use, so a later assignment reaches a panel already made. */
  serverChecks: () => TryItServerChecksSource | undefined;
  pdf: () => TryItPdfSource | undefined;
  /** How the form shows (Fill in or Read only) is the canvas's: it sets the renderer's mode in its chrome. */
  mode: () => "interactive" | "readonly";
  setMode: (mode: "interactive" | "readonly") => void;
  /** The mode whose workspace Try it runs in; `undefined` on the form's own canvas. */
  builderMode?: () => BuilderMode | undefined;
  /** The workspace Try it runs in ("form", "journeys", "pdf"). */
  workspace?: () => string | undefined;
  /** The mode that lends `tryIt.pdf` (the PDF designer), on the page or not: Preview PDF goes through it from every workspace. */
  pdfMode?: () => BuilderMode | undefined;
  /** The mode's session while it runs (`BuilderModeTryIt.session`); `undefined`: the preview is tried. */
  session?: () => BuilderTrySession | undefined;
  /**
   * The scenario step the canvas shows (Show me), read on every draw: the
   * bar says which step of which test is on show, with Step back, Step forward and Stop showing.
   */
  showing?: () => CanvasScenarioShowing | undefined;
  /** Stop showing: the canvas forgets the showing and tells the panel once (its `onStop`). */
  stopShowing?: () => void;
  /** The showing's givens the canvas could not apply (a host value, a day a session cannot take): the bar names them after the label. */
  showingUnapplied?: () => readonly TryShowingGiven[] | undefined;
  /**
   * Record, read on every draw: while the canvas records for the Tests
   * panel, the listener its settled events go to, and the bar reads "Recording" with Stop recording.
   */
  recording?: () => TestsRecordListener | undefined;
  /** Stop recording (the bar's button, Clear answers): the canvas drops the listener and says so. */
  stopRecording?: () => void;
}

/** The panel and its logic, made once the chunk is in; see `createTryIt` in `try-it.ts`. */
export interface TryItController {
  /** Draws the panel from its state, its focus kept on the control that had it. */
  render(): void;
  /** An answer changed: the data follows at once, the checks a beat later when they run as answers change. */
  answersChanged(): void;
  /** A click inside the panel; `path` is the event's composed path. */
  click(path: HTMLElement[]): void;
  /** The form's Submit in Try it. */
  submit(): Promise<void>;
  /** Back to editing or Fill in: the submit's receipt, errors and status line go. */
  clearSubmit(): void;
  /** The host lent (or took away) the server's checks: the validator's state starts over. */
  serverChecksChanged(): void;
  /** Clear answers: the shared answers emptied, a session started over, the panel drawn again. */
  clearAnswers(): void;
  /**
   * The canvas's showing came, moved or went: the bar's step control is drawn again
   * from `showing()`, whether or not the panel itself is on show.
   */
  showingChanged(): void;
  /**
   * The canvas's recording listener came or went, or the tried runtime may have changed (a
   * session's runtime arrived): the chunk follows the runtime tried, flushes what it held back to
   * a listener that goes, and draws the bar's Recording control again.
   */
  recordingChanged(): void;
  /** Assert this: every field of the tried runtime as it stands, what a recording held back sent first. */
  assertSnapshot(): TestsAssertSnapshot | undefined;
  /**
   * Check now for an agent: the body of the panel's own Check, which draws
   * the panel exactly as the person's press does, returning what it drew. Not recorded as a
   * test line: the person did not press it. While a validator the person turned on still loads,
   * it waits for the load, so the server's lines are in (or the failed load is said).
   *
   * @internal
   */
  check(): Promise<TryCheckOutcome>;
  /**
   * The form's Submit for an agent: the body of {@link submit}, answering
   * with the detail `builder-try-submit` carries (which still fires). While the person's focus is
   * outside the canvas, or the page lacks focus (the browser's assistant panel), it moves none
   *: no first error, notice or field is focused or
   * revealed, and a mode's session moves its page without taking focus. One at a time: a Submit
   * already in flight, the person's or an agent's, answers `{ state: "busy" }` at once. Rejects
   * when there is no form to submit, or when the Submit was dropped before the stand-in answered
   * (Back to editing, Clear answers).
   *
   * @internal
   */
  submitForAgent(): Promise<TrySubmitOutcome | { state: "busy" }>;
  /**
   * Whether the person turned the server's checks on in the panel (an agent reads it, never
   * sets it): on from the tick, while the validator loads, as the panel draws the switch.
   *
   * @internal
   */
  serverChecksOn(): boolean;
}
