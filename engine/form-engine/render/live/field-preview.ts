/**
 * One field drawn on its own, outside a mounted form: the picture of a form field a
 * design-time canvas shows beside what it is about (the PDF designer's `pdf-field` face shows the
 * bound component over the sample answers). `renderFieldPreview(node, locale)` draws a field of
 * the presentation fold (`foldPresentation`, the one walk the live form and print read too, so a
 * preview agrees with them on a field's type, its base and its words) through the binding's
 * adapter (Datum's, unless a binding is given; Datum's stands behind any other) into a detached
 * element and returns it, ready to be put where the canvas wants it.
 *
 * The preview is a picture, not a field:
 * - it is drawn read-only, with no error and no events: every write an adapter reports goes
 *   nowhere, and the element is `inert`, so nothing in it takes focus or a click;
 * - its state is the renderer's own, built the way a mount builds it (the common state, then
 *   each of the Datum feature list's per-kind builders: choices, counts, dates, files), with a
 *   draw context of one field: no typed parts, no memory, no reports;
 * - it carries none of the DOM contract (`data-component-id`, `data-value-path`, `data-instance`):
 *   the canvas it is shown on owns those attributes for its own nodes. Its wrapper carries the
 *   state hooks a stylesheet reads (`data-kind`, `data-readonly`, `data-required`), and the
 *   field's ids, which are the form's.
 *
 * The element is styled by the sheet of the root it is put in: the binding's css is not adopted
 * here. A type no adapter draws previews as its label and its answer, as text.
 */
import { createFormTextResolver } from "../../core/localization/form-texts.js";
import { countCharacters } from "../../core/schema/length-limits.js";
import { kindOf } from "../../registry/kinds.js";
import { workedOutNoteId } from "../core/component-model.js";
import type { PresentationField } from "../core/presentation-tree.js";
import { scalarText } from "../core/scalar-text.js";
import { componentTextOf } from "./component-text.js";
import { capabilityOf, resolveAdapter, type Adapter, type FieldAdapter, type FieldEvents, type FieldState, type FormDrawState, type LiveBinding, type Words } from "./contract.js";
import { createDatumBinding, createDatumFeatures } from "./datum/options.js";
import { html, render, type TemplateResult } from "./lit.js";
import type { DrawContext, LiveFeature } from "./mount.js";

export interface FieldPreviewOptions {
  /** The binding whose adapter draws the field; Datum's when left out, and Datum's stands behind it. */
  binding?: LiveBinding | undefined;
  /** The form's words; the engine's in `locale` when left out. */
  words?: Words | undefined;
  /**
   * The definition's `kinds` map: what the fold read a design system's own type as. The adapter
   * lookup reads its base from the node, so this only serves a per-kind state builder that asks.
   */
  kinds?: Readonly<Record<string, string>> | undefined;
  dir?: "ltr" | "rtl" | undefined;
}

let sharedDatum: LiveBinding | undefined;
let sharedFeatures: readonly LiveFeature[] | undefined;

/** One Datum binding and one feature list for every preview on the page: they hold no state of their own per field. */
function datumBinding(): LiveBinding {
  sharedDatum ??= createDatumBinding();
  return sharedDatum;
}

function stateFeatures(): readonly LiveFeature[] {
  sharedFeatures ??= createDatumFeatures().filter((feature) => typeof feature.fieldState === "function");
  return sharedFeatures;
}

/** Writes go nowhere: the preview is a picture. */
const NO_EVENTS: FieldEvents = Object.freeze({
  input: () => undefined,
  parts: () => undefined,
  commit: () => undefined,
  files: () => undefined,
  remove: () => undefined,
  download: () => undefined
});

/** The common state of a read-only field with no error shown, as the mount builds it. */
function baseState(node: PresentationField, words: Words, locale: string, dir: "ltr" | "rtl"): FieldState {
  const model = node.model;
  const a11y = model.accessibility;
  const notices = (model.notices ?? []).map((notice) => ({ code: notice.code, severity: notice.severity, message: notice.message }));
  const description = typeof model.description === "string" && model.description.trim() !== "" ? model.description : undefined;
  const hintId = description !== undefined ? (a11y.descriptionId ?? `${a11y.fieldId}__description`) : undefined;
  const workedOutText = model.workedOut === true ? words("workedOut") : "";
  const workedOutId = workedOutText !== "" ? workedOutNoteId(a11y.fieldId) : undefined;
  // No error is shown on a preview, so no error id is named.
  const describedBy = a11y.ariaDescribedBy.filter((id) => id !== a11y.errorId && (id !== workedOutNoteId(a11y.fieldId) || workedOutId !== undefined));
  if (hintId !== undefined && !describedBy.includes(hintId)) {
    describedBy.unshift(hintId);
  }
  if (workedOutId !== undefined && !describedBy.includes(workedOutId)) {
    describedBy.splice(hintId !== undefined ? describedBy.indexOf(hintId) + 1 : 0, 0, workedOutId);
  }
  const value = scalarText(model.value);
  const kind = kindOf(node.base)?.kind;
  return {
    key: node.key,
    componentId: model.id,
    type: node.type,
    base: node.base,
    ...(kind !== undefined ? { kind } : {}),
    id: a11y.fieldId,
    name: a11y.fieldId,
    valuePath: model.valuePath,
    label: model.label,
    labelId: a11y.labelId,
    hideLabel: model.hideLabel,
    ...(hintId !== undefined && description !== undefined ? { hint: description, hintId } : {}),
    ...(workedOutId !== undefined ? { workedOut: workedOutText, workedOutId } : {}),
    value,
    answer: model.value,
    required: a11y.required,
    readOnly: true,
    disabled: model.disabled,
    invalid: false,
    errors: [],
    notices,
    ...(notices.length > 0 ? { noticeId: a11y.noticeId ?? `${a11y.fieldId}__notice` } : {}),
    describedBy,
    pending: false,
    busy: undefined,
    overLimit: model.characterCount === true && model.maxLength !== undefined && countCharacters(value) > model.maxLength,
    locale,
    dir,
    classNames: model.classNames,
    reveal: [],
    mode: "readonly",
    words,
    text: componentTextOf(model.node, locale, words.words),
    model
  };
}

/**
 * A draw of one field: what the per-kind state builders read (the words, the form's state, the
 * lookup chain, a hook run guarded), and nothing a mounted form keeps (typed parts, memory, the
 * fields drawn, reports).
 */
function drawOfOne(binding: LiveBinding, datum: LiveBinding, form: FormDrawState, kinds: Readonly<Record<string, string>> | undefined): DrawContext {
  const live = {
    binding,
    datum,
    mode: "readonly" as const,
    mounted: () => false,
    typedParts: () => undefined,
    resolve: <A extends Adapter>(kind: A["kind"], type: string, base: string, state?: unknown) => resolveAdapter<A>(binding, datum, kind, type, base, state),
    call: <T>(_hook: string, _id: string | undefined, run: () => T): T | undefined => {
      try {
        return run();
      } catch {
        return undefined;
      }
    },
    memory: <T>(_owner: string, make: () => T): T => make(),
    warnOnce: () => undefined,
    error: () => undefined,
    report: () => undefined,
    fields: () => [],
    field: () => undefined
  };
  return { live, form, words: form.words, kinds } as unknown as DrawContext;
}

/** What a type no adapter draws previews as: its label and its answer. */
function plainPreview(state: FieldState): TemplateResult {
  return html`<p class="datum-field-preview__plain"><span class="datum-field-preview__label">${state.label}</span>${state.value !== "" ? html` <span class="datum-field-preview__value">${state.value}</span>` : ""}</p>`;
}

/**
 * The field `node` of a presentation fold drawn read-only by the binding's adapter (Datum's by
 * default) into a new, detached, `inert` element. The fold is of a read-only render output
 * (`buildRuntimeRenderOutput(runtime, "readonly")`), whose models carry the answer, the options
 * and the words in the form's locale; the node adds the type the adapter is looked up under (its
 * `base` when the definition's `kinds` map reads it as an engine type) and the row it sits in.
 */
export function renderFieldPreview(node: PresentationField, locale: string, options: FieldPreviewOptions = {}): HTMLElement {
  const datum = datumBinding();
  const binding = options.binding ?? datum;
  const words = options.words ?? createFormTextResolver(locale);
  const dir = options.dir ?? "ltr";
  const form: FormDrawState = { mode: "readonly", locale, dir, busy: undefined, colorScheme: "light", printing: false, words };
  const draw = drawOfOne(binding, datum, form, options.kinds);
  let state = baseState(node, words, locale, dir);
  for (const feature of stateFeatures()) {
    try {
      state = feature.fieldState?.(state, node, draw) ?? state;
    } catch {
      // A builder that needs a mounted form adds nothing to a picture.
    }
  }
  const resolved = resolveAdapter<FieldAdapter>(binding, binding === datum ? undefined : datum, "field", node.type, node.base, state);
  if (state.workedOut !== undefined && (resolved === undefined || capabilityOf(resolved.adapter, "workedOut") !== "drawn")) {
    // A picture has no wrapper line of its own: an adapter that does not draw the worked-out line has it in the hint.
    const { workedOut, workedOutId, ...rest } = state;
    const hintId = state.hintId ?? `${state.id}__description`;
    state = {
      ...rest,
      hint: [state.hint, workedOut].filter((part): part is string => part !== undefined && part !== "").join(" "),
      hintId,
      describedBy: [hintId, ...state.describedBy.filter((id) => id !== workedOutId && id !== hintId)]
    };
  }
  let content: TemplateResult;
  try {
    content = resolved ? resolved.adapter.template(state, NO_EVENTS) : plainPreview(state);
  } catch {
    content = plainPreview(state);
  }
  const element = document.createElement("div");
  element.className = "datum-field-preview";
  element.setAttribute("inert", "");
  element.dir = dir;
  render(
    html`<div
      class=${["datum-live-field", ...state.classNames].join(" ")}
      data-kind=${resolved ? state.base : "unknown"}
      ?data-required=${state.required}
      data-readonly
    >${content}</div>`,
    element
  );
  const wrapper = element.firstElementChild;
  if (resolved?.adapter.after && wrapper instanceof HTMLElement) {
    try {
      resolved.adapter.after(wrapper, state);
    } catch {
      // A touch the picture can do without.
    }
  }
  return element;
}
