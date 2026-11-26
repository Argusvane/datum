/**
 * Datum's button and button group.
 *
 * A button is an action control, not a value-bearing field: no label, hint or error around it,
 * and a press writes nothing to the form. It carries the marks the renderer's buttons module
 * hears (`data-button-action`, `data-button-signature`, contract.ts), and the renderer reports
 * the press as `datum-form-action`, so the adapter has no handler of its own.
 *
 * - Emphasis and size are classes (`datum-form__button--primary`, `--sm`), never inline colours:
 *   the palette belongs to the stylesheet, so a form authored as primary and secondary keeps that
 *   relationship in any palette. A button with neither is the plain accent button.
 * - A read-only or disabled field draws a `disabled` button. While the form is submitting or
 *   changing page (`busy`) the button of an action is `aria-disabled`, so a second press cannot
 *   start a second action. While a page is changing it stays focusable, so the person's place is
 *   not lost. While a submission runs the renderer makes the form's body `inert` (focus leaves it
 *   until the lock lifts, and then goes back to the control that had it).
 * - The state's `action`, `variant` and `size` are used when the state builder gave them; else
 *   they are read from the component's model, which carries the same values.
 *
 * The button group is a flowing row of its buttons: a plain box, or a list with one item per
 * button where a form draws it so (`list`).
 */
import type { ButtonFieldState, FieldAdapter, FieldState, GroupAdapter } from "../contract.js";
import { html, ifDefined, nothing } from "../lit.js";
import { classes } from "./leaf-kit.js";

/** What a button state holds, from the state when the renderer's state builder gave it, else the model. */
export interface ButtonFigures {
  action: string | undefined;
  variant: string | undefined;
  size: string | undefined;
  signature: string | undefined;
}

/** A button's action, emphasis, size and signing provider. */
export function buttonFiguresOf(state: FieldState): ButtonFigures {
  const given = state as Partial<ButtonFieldState>;
  const model = state.model;
  const size = given.size ?? model.buttonSize;
  return {
    action: given.action ?? model.buttonAction,
    variant: given.variant ?? model.buttonVariant,
    // The default size draws no class.
    size: size !== undefined && size !== "md" ? size : undefined,
    signature: model.buttonSignature
  };
}

/** The class list of a button: the base, its emphasis and its size. */
export function buttonClassName(figures: Pick<ButtonFigures, "variant" | "size">): string {
  return classes("datum-form__button", figures.variant ? `datum-form__button--${figures.variant}` : false, figures.size ? `datum-form__button--${figures.size}` : false);
}

/** A form is working on an action: a second press of an action button would race it. */
function working(state: FieldState): boolean {
  return state.busy === "submitting" || state.busy === "navigating";
}

/** Datum's `button`. */
export const datumButton: FieldAdapter = {
  kind: "field",
  name: "datum button",
  capabilities: {},
  template(state) {
    const figures = buttonFiguresOf(state);
    return html`<button
      type="button"
      class=${buttonClassName(figures)}
      data-button-action=${ifDefined(figures.action)}
      data-button-signature=${ifDefined(figures.signature)}
      ?disabled=${state.disabled || state.readOnly}
      aria-disabled=${figures.action !== undefined && working(state) ? "true" : nothing}
    >${state.label}</button>`;
  }
};

/** What a host chooses about a button group. */
export interface DatumButtonGroupOptions {
  /** `list` draws a `<ul>` with one `<li>` per button (a design system's button list); `div` a plain box. */
  buttonGroup?: "div" | "list";
}

/** Datum's `button-group`. */
export function createDatumButtonGroup(options: DatumButtonGroupOptions = {}): GroupAdapter {
  const list = options.buttonGroup === "list";
  return {
    kind: "group",
    name: list ? "datum button list" : "datum button group",
    template(state, children) {
      return list
        ? html`<ul class="datum-form__button-group">${state.eachItem((item) => html`<li class="datum-form__button-group-item">${item.content}</li>`)}</ul>`
        : html`<div class="datum-form__button-group">${children}</div>`;
    }
  };
}

export const datumButtonGroup: GroupAdapter = createDatumButtonGroup();
