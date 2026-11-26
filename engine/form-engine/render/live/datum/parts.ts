/**
 * Part templates of the Datum binding: the `parts` seam of `createDatumBinding` (options.ts). A
 * part is one piece of Datum's drawing a host may draw its own way: a label's required or
 * optional mark, the help mark, an inline error, a choice's option row, the shell around a field,
 * a button, the steps' Back, the error summary, the receipt, the in-flight line, the required
 * note, a journey page's heading and its actions, a Check answers page's list.
 *
 * Every part is a lit template over typed values, never an HTML string. It is handed `default`,
 * Datum's own drawing of the part, and returns what is drawn in its place: `default` itself,
 * `default` wrapped (a design system's form group around the field), or a drawing of its own
 * from the values. What the renderer owns stays outside the part: the field's wrapper and its
 * state hooks, the ids the values name (a part that draws an error keeps `id`), the field order,
 * the write guard and the focus rules.
 *
 * A part that throws, or returns `undefined`, draws Datum's own (`drawPart`); the throw is said
 * on the console once per part, so a broken template never hides the form.
 */
import type {
  ChoiceOption,
  FieldState,
  FormNoticeState,
  FormStatusState,
  GridState,
  GroupState,
  PageState,
  RequiredNoteState,
  ReviewState,
  StepsState,
  SummaryEntry,
  SummaryState,
  View
} from "../contract.js";

/** What every part is handed: the state it draws from, and Datum's own drawing of it. */
export interface PartBase<State> {
  state: State;
  /** Datum's drawing of the part: return it, wrap it, or draw in its place. */
  default: View;
}

/** What carries a label, a legend or an error: a field, a container with a legend, a data grid. */
export type LabelledState = FieldState | GroupState | GridState;

/** The marker after a label or a legend: `marker` is the worded text ("*", "(optional)"; empty when unworded). */
export interface LabelMarksPart extends PartBase<LabelledState> {
  required: boolean;
  /** On a legend the marker is what assistive technology hears, so it is not hidden from it. */
  announced: boolean;
  marker: string;
}

/** The help mark beside a label. The bubble carries `id`: the control's description names it. */
export interface TooltipMarkPart extends PartBase<FieldState> {
  tooltip: string;
  id: string;
  /** The mark's accessible name ("Help"), worded. */
  label: string;
}

/** A field's inline error. Keep `id` on the element that holds the message (the control's description names it) and `role` where given. */
export interface ErrorMessagePart extends PartBase<LabelledState> {
  id: string;
  message: string;
  /** The hidden word read before the message ("Error:"); empty when unworded. */
  prefix: string;
  /** `alert` unless the form's inline errors are plain. */
  role: "alert" | undefined;
}

/** One radio or checkbox row. Keep `input` as given: it carries the id, the name and the wiring. */
export interface OptionRowPart extends PartBase<FieldState> {
  kind: "radio" | "checkbox";
  option: ChoiceOption;
  input: View;
  /** Datum's label text: the words alone, or the words and the hint in a column with their ids. */
  text: View;
  disabled: boolean;
}

/** The shell around a value-bearing field: `default` is the whole field as Datum draws it (shell, parts in order, notices). */
export interface FieldShellPart extends PartBase<FieldState> {
  /** The engine type the field is drawn as (`text`, `radio`, `date`). */
  kind: string;
}

/** An action button. `default` carries the press marks (`data-button-action`) the renderer hears: keep them on a button drawn anew. */
export interface ButtonPart extends PartBase<FieldState> {
  label: string;
  action: string | undefined;
  variant: string | undefined;
  size: string | undefined;
  /** Datum's class list for it. */
  className: string;
  busy: boolean;
}

/** The steps container's Back, beside Continue. Call `go` on a press; while `busy` draw `aria-disabled`, never `disabled`. */
export interface StepBackPart extends PartBase<StepsState> {
  label: string;
  go(): void;
  busy: boolean;
}

/** The error summary, from the renderer's entries (each with its `href` and `focus()`). */
export interface SummaryPart extends PartBase<SummaryState> {
  entries: readonly SummaryEntry[];
}

export type NoticePart = PartBase<FormNoticeState>;
export type StatusPart = PartBase<FormStatusState>;
export type RequiredNotePart = PartBase<RequiredNoteState>;

/** A journey page's heading block. Keep `state.headingId` and `tabindex="-1"` on the heading: focus goes there after a page change. */
export type JourneyHeadingPart = PartBase<PageState>;

/** A journey page's Continue (or Submit) and Back. While `state.busy` draw `aria-disabled`, never `disabled`. */
export type JourneyActionsPart = PartBase<PageState>;

/** A Check answers page's list (`default` is `state.content`). Keep each row's and card's `id`, and call a link's `go()` on its press. */
export type JourneyReviewPart = PartBase<ReviewState>;

/** The parts a host may draw; each optional, each a template over its values. */
export interface DatumParts {
  labelMarks?(part: LabelMarksPart): View | undefined;
  tooltipMark?(part: TooltipMarkPart): View | undefined;
  errorMessage?(part: ErrorMessagePart): View | undefined;
  optionRow?(part: OptionRowPart): View | undefined;
  fieldShell?(part: FieldShellPart): View | undefined;
  button?(part: ButtonPart): View | undefined;
  stepBack?(part: StepBackPart): View | undefined;
  summary?(part: SummaryPart): View | undefined;
  notice?(part: NoticePart): View | undefined;
  status?(part: StatusPart): View | undefined;
  requiredNote?(part: RequiredNotePart): View | undefined;
  journeyHeading?(part: JourneyHeadingPart): View | undefined;
  journeyActions?(part: JourneyActionsPart): View | undefined;
  journeyReview?(part: JourneyReviewPart): View | undefined;
}

export type DatumPartName = keyof DatumParts;

export const DATUM_PART_NAMES: readonly DatumPartName[] = [
  "labelMarks",
  "tooltipMark",
  "errorMessage",
  "optionRow",
  "fieldShell",
  "button",
  "stepBack",
  "summary",
  "notice",
  "status",
  "requiredNote",
  "journeyHeading",
  "journeyActions",
  "journeyReview"
];

/** The values one part is handed. */
export type PartOf<N extends DatumPartName> = Parameters<NonNullable<DatumParts[N]>>[0];

/** The known names whose value is a function; anything else dropped. `undefined` when none is left. */
export function normalizeParts(parts: unknown): Readonly<DatumParts> | undefined {
  if (parts === null || typeof parts !== "object") {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const name of DATUM_PART_NAMES) {
    const template = (parts as Record<string, unknown>)[name];
    if (typeof template === "function") {
      out[name] = template;
    }
  }
  return Object.keys(out).length === 0 ? undefined : Object.freeze(out as DatumParts);
}

const reported = new Set<string>();

/**
 * The drawing of one part: the host's template when it has one and it returns something, else
 * Datum's (`part.default`). A template that throws draws Datum's, said once per part.
 */
export function drawPart<N extends DatumPartName>(parts: Readonly<DatumParts> | undefined, name: N, part: PartOf<N>): View {
  const template = parts?.[name] as ((part: PartOf<N>) => View | undefined) | undefined;
  if (typeof template !== "function") {
    return part.default;
  }
  try {
    return template(part) ?? part.default;
  } catch (error) {
    if (!reported.has(name)) {
      reported.add(name);
      console.error(`[datum binding] the "${name}" part failed; Datum's own is drawn.`, error);
    }
    return part.default;
  }
}
