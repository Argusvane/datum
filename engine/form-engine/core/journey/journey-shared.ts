import type { ComponentNode } from "../schema/types.js";

/**
 * The journey helpers every form needs, journey or not: reading an own member of a
 * record, a value key's leading segment, where a repeating section's entries live (a data grid's
 * rows among them), and whether a node holds an answer of its own. The validation kernel, the browser
 * runtime, the builder and the PDF designer read them without a journey, so they live apart from
 * the path engine (`journey-path.ts`), which the journeys runtime alone needs.
 *
 * The path engine's rules hold here too: type-only imports, top-level
 * `function` declarations only, standard globals, no module constants, plain records. Each is
 * spliced into the sandbox program through the path engine's list (`JOURNEY_PATH_FUNCTIONS`),
 * and calls nothing at all, so the path engine's functions, which call these, still call
 * nothing outside that list.
 */

/**
 * `record[key]` when the record holds `key` itself, else `undefined`: never an inherited member
 * such as `Object.prototype.constructor`.
 */
export function journeyOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** The segment of a value key before any `.` or `[`: `applicants[0].name` -> `applicants`. */
export function journeyLeadingSegment(key: string): string {
  let end = key.length;
  const dot = key.indexOf(".");
  const bracket = key.indexOf("[");
  if (dot >= 0 && dot < end) {
    end = dot;
  }
  if (bracket >= 0 && bracket < end) {
    end = bracket;
  }
  return key.slice(0, end);
}

/** Mirrors `collectionPathOf`: where a repeating section's entries live, as written; else nothing. */
export function journeyCollectionPathOf(node: ComponentNode): string | undefined {
  const binding = node.collection;
  if (!binding) {
    return undefined;
  }
  const configured = binding.collectionPath;
  return typeof configured === "string" && configured.length > 0 ? configured : node.id;
}

/**
 * Whether a node holds an answer of its own. A copy of the fold's `kernelFoldHoldsOwnAnswer`
 * (`core/state/submittable-fold.ts`), kept here because the path engine calls nothing outside
 * its own list; `engine/tests/journey-path.test.ts` holds the two to one verdict. False for a
 * repeating section, a data grid, a group — anything with a `children` map, or a grouping type
 * — and a component that carries no answer (a button, static HTML, an image, a signature).
 * What a presentation's usability rules read: the form field an alias fills or a
 * worked-out value sets must hold one (rule E), and so must the own field that fills it
 * (rule F).
 */
export function journeyHoldsOwnAnswer(node: { type: string; collection?: unknown; children?: unknown }): boolean {
  if (node.collection !== undefined || node.children !== undefined) {
    return false;
  }
  const groupTypes = [
    "form",
    "fieldset",
    "panel",
    "grid",
    "tabs",
    "tab",
    "steps",
    "step",
    "repeatingSection",
    "dataGrid",
    "container"
  ];
  if (groupTypes.indexOf(node.type) >= 0) {
    return false;
  }
  return ["button", "html", "image", "signature"].indexOf(node.type) < 0;
}
