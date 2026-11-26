/**
 * Whether an assistant may write a field, as data only: the reason a write is refused, never the words. The
 * renderer's `guards.ts` words a reason through its own `notWritable`; the builder's Try it
 * tool words it in its own catalogue.
 */

import type { RenderComponentModel } from "../../render/core/component-model.js";
import { isCalculated, isNestedCollection, unfillableStaticKind, type FieldKind } from "./kinds.js";

export type WhyNotWritable = "hidden" | "disabled" | "readonly" | "calculated" | "unfillable" | "group" | "presentation";
export type UnfillableKind = "file" | "signature" | "button" | "static" | "nested-rows";

export interface Writability {
  writable: boolean;
  why?: WhyNotWritable;
  unfillableKind?: UnfillableKind;
}

/** The effective-state flags a write reads (the runtime's `EffectiveNodeState` fits it). */
export interface WritableState {
  visible?: boolean;
  disabled?: boolean;
  readonly?: boolean;
}

/**
 * Where the field stands, for the one reason that depends on the page shown: this module knows no pages, so the caller says.
 */
export interface WritabilityPlace {
  /**
   * True when the field is a journey presentation's own value field (an `@<presentation>.<id>`
   * answer) drawn on the page the person sees now. Such a field is written like any form field,
   * by its kind and effective state. An own field of another page, any other `@` node (the
   * presentation's container, an own layout or drawing, a form field's placeholder), and one the
   * caller cannot place (this flag absent) are `presentation`, never written.
   */
  ownFieldOnPage?: boolean;
}

/** The static half of writability (kind and calculation); the effective state is judged at write time by `writabilityOfState`. */
export function writabilityOf(model: RenderComponentModel, kind: FieldKind, place?: WritabilityPlace): Writability {
  // A presentation's own field (its answer under `@<presentation>.<id>`) is writable
  // where the person sees it; elsewhere, or unplaced, it is not.
  if (model.valuePath.startsWith("@") && place?.ownFieldOnPage !== true) {
    return { writable: false, why: "presentation" };
  }
  const staticKind = unfillableStaticKind(model);
  if (staticKind !== undefined) {
    return { writable: false, why: "unfillable", unfillableKind: staticKind };
  }
  if (kind === "group") {
    return { writable: false, why: "group" };
  }
  if (kind === "file" || kind === "signature") {
    return { writable: false, why: "unfillable", unfillableKind: kind };
  }
  if (kind === "collection" && isNestedCollection(model)) {
    return { writable: false, why: "unfillable", unfillableKind: "nested-rows" };
  }
  if (!model.visible) {
    return { writable: false, why: "hidden" };
  }
  if (model.disabled) {
    return { writable: false, why: "disabled" };
  }
  if (kind !== "collection" && isCalculated(model)) {
    return { writable: false, why: model.node.rules?.value !== undefined ? "calculated" : "readonly" };
  }
  if (kind === "collection" && model.readOnly) {
    return { writable: false, why: "readonly" };
  }
  return { writable: true };
}

/**
 * Writability at write time: the static reasons of {@link writabilityOf} that no state can lift
 * (a presentation's own field, a button or static drawing, a group, a file or signature, a
 * nested table, a calculation), then the effective state read fresh from the runtime, which
 * the memo's `visible` / `disabled` / `readOnly` may lag: hidden, then disabled, then read-only
 * (`calculated` when the field has a value rule). `state` is the field's own effective state
 * (for a row cell, its collection's); `cell` is the cell's own when the write names a row cell.
 * A table is read-only only by its own model (its cells' state is judged per cell). `place` is
 * {@link writabilityOf}'s: an own field is judged by its state only on the page shown.
 */
export function writabilityOfState(model: RenderComponentModel, kind: FieldKind, state: WritableState | undefined, cell?: WritableState, place?: WritabilityPlace): Writability {
  const fixed = writabilityOf(model, kind, place);
  if (!fixed.writable && fixed.why !== "hidden" && fixed.why !== "disabled" && fixed.why !== "readonly") {
    return fixed;
  }
  if (state?.visible === false || cell?.visible === false || !model.visible) {
    return { writable: false, why: "hidden" };
  }
  if (state?.disabled === true || cell?.disabled === true || model.disabled) {
    return { writable: false, why: "disabled" };
  }
  if (kind !== "collection" && (state?.readonly === true || cell?.readonly === true || model.readOnly)) {
    return { writable: false, why: model.node.rules?.value !== undefined ? "calculated" : "readonly" };
  }
  if (kind === "collection" && model.readOnly) {
    return { writable: false, why: "readonly" };
  }
  return { writable: true };
}
