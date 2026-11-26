/**
 * The Submit button a new form starts with, and the one Try it's notice adds to a form that has
 * none: one definition of it, so the id, the type, the label and the action are the same wherever
 * the builder makes it. Plain functions with nothing to load, for any bundle to take.
 */
import type { ComponentNode } from "../../core/schema/types.js";

/** The button as a component node: a form with no way to send it is the first thing a new author meets. */
export function starterSubmitButton(): ComponentNode {
  return { id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } };
}

/**
 * Whether `node` is still the button {@link starterSubmitButton} makes: nothing about it set
 * beyond its label and action, and nothing inside. The empty form's prompt and File > New's
 * "nothing to lose" read it, so a form holding only this button counts as not started.
 */
export function isStarterSubmitButton(node: ComponentNode): boolean {
  const { id, type, configuration, children, ...rest } = node;
  const set = Object.entries(configuration ?? {}).filter(([, value]) => value !== undefined);
  const { label, action } = (configuration ?? {}) as { label?: unknown; action?: unknown };
  return (
    id === "submit" &&
    type === "button" &&
    set.length === 2 &&
    label === "Submit" &&
    action === "submit" &&
    Object.values(children ?? {}).every((group) => (group?.length ?? 0) === 0) &&
    Object.values(rest).every((value) => value === undefined)
  );
}
