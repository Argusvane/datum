import { BUTTON_COMPONENT_TYPE } from "./button.js";

/**
 * A button group: a layout container an author puts buttons into — Save and
 * Cancel, Continue beside a Save-and-come-back-later link — so they sit together along a row
 * rather than one per row down the form. It holds no value and claims no place in the data
 * (it carries a `children` map, and only a data-scoping `container` adds a level), prints
 * nothing (a button prints nothing), and has no configuration of its own beyond what every
 * component has: its id, its CSS classes, its rules.
 *
 * The engine draws it as a `<div class="datum-form__button-group">` whose class lays its
 * children out in a wrapping row, or — under the Datum binding's `controls.buttonGroup: "list"` — as a
 * `<ul>` with each child in an `<li class="datum-form__button-group-item">`, for a binding
 * whose design system draws the group as a list (USWDS's usa-button-group). A group is the one way to group
 * buttons: loose consecutive buttons are not a group.
 */
export const BUTTON_GROUP_COMPONENT_TYPE = "button-group";

/** The group's one slot. */
export const BUTTON_GROUP_SLOT_ID = "content";

/**
 * What the group's slot takes in the builder: buttons — the link
 * look included, which is a button variant, not a type. A definition written elsewhere that
 * puts something else in a group is neither refused nor flagged; the group draws it as it
 * draws a button, as a `steps` container draws a stray non-step.
 */
export const BUTTON_GROUP_CHILD_TYPES: readonly string[] = [BUTTON_COMPONENT_TYPE];
