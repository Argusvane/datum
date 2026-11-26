import type { FieldKind } from "../kinds.js";

/**
 * What a drawing surface can draw around a field, as plain data.
 *
 * These are the other half of the capabilities in `field-capabilities.ts`: an *editor*
 * capability is a property the inspector offers an author (a configuration key plus its editor
 * field); a *drawing* capability is a thing a surface — the Datum renderer, a design-system
 * binding, the builder canvas — may or may not know how to put on screen. They share a few
 * names (`hideLabel`, `tooltip`, `prefix`) because one authored property is often both, but they
 * are kept apart on purpose: whether a property can be authored says nothing about whether a
 * given design system can draw it, and a binding answers only the drawing set.
 *
 * Each entry says which field kinds the capability applies to. A binding answers, per kind per
 * capability, {@link DrawingSupport}; the builder shows a capability the binding draws, shows a
 * degraded one with a note, and hides one it does not draw. Nothing here is sandbox-unsafe: it is data only.
 */

/** How a surface answers one capability: put on screen as authored, put on screen in a reduced form, or not at all. */
export type DrawingSupport = "drawn" | "degraded" | "none";

export type DrawingCapabilityId =
  /** A warning or info message on the field: non-blocking, never styled or announced as an error. */
  | "notice"
  /** An async check covering the field is running. */
  | "pending"
  /** Short help shown on hover and focus. */
  | "tooltip"
  /** Text drawn before the control, inside the field's box. */
  | "prefix"
  /** Text drawn after the control, inside the field's box. */
  | "suffix"
  /** The running count of characters against a limit. */
  | "characterCount"
  /** The label kept as the accessible name but not shown. */
  | "hideLabel"
  /** Ghost text inside an empty control. */
  | "placeholder"
  /** The row number heading of a collection's rows. */
  | "rowNumbers"
  /** A journey page's line saying the value is worked out from other answers. */
  | "workedOut";

export interface DrawingCapability {
  id: DrawingCapabilityId;
  /** The field kinds the capability applies to; a surface is asked about no other kind. */
  kinds: readonly FieldKind[];
  /** What drawing it means, for a binding author and the builder's note on a degraded one. */
  description: string;
}

/** Every kind of field, the group and the collection included. */
const ALL_KINDS: readonly FieldKind[] = ["text", "number", "date", "boolean", "choice", "multichoice", "collection", "file", "signature", "group"];

export const DRAWING_CAPABILITIES: readonly DrawingCapability[] = [
  {
    id: "notice",
    kinds: ALL_KINDS,
    description: "Warnings and info on a field, drawn apart from its errors with what the surface offers for a non-blocking message."
  },
  {
    id: "pending",
    kinds: ALL_KINDS,
    description: "That an async check on the field is running; degraded is a word in the hint."
  },
  {
    id: "tooltip",
    kinds: ALL_KINDS,
    description: "Help text on hover and focus; degraded is the text folded into the hint."
  },
  {
    id: "prefix",
    kinds: ["text", "number"],
    description: "Text before the control, inside the field's box."
  },
  {
    id: "suffix",
    kinds: ["text", "number"],
    description: "Text after the control, inside the field's box."
  },
  {
    id: "characterCount",
    kinds: ["text"],
    description: "The running count against the field's character limit."
  },
  {
    id: "hideLabel",
    kinds: ALL_KINDS,
    description: "The label visually hidden and still the control's accessible name."
  },
  {
    id: "placeholder",
    kinds: ["text", "number", "choice"],
    description: "Ghost text inside an empty control, or a select's empty caption."
  },
  {
    id: "rowNumbers",
    kinds: ["collection"],
    description: "The number heading of each row of a collection-bound container."
  },
  {
    id: "workedOut",
    kinds: ALL_KINDS,
    description:
      "A journey page's line saying the value is worked out from other answers, drawn as its own element under its id; degraded is the line folded into the hint. Not drawn by the adapter, the renderer draws it in the field's wrapper."
  }
];

const BY_ID: ReadonlyMap<DrawingCapabilityId, DrawingCapability> = new Map(DRAWING_CAPABILITIES.map((capability) => [capability.id, capability]));

export function drawingCapability(id: DrawingCapabilityId): DrawingCapability {
  const capability = BY_ID.get(id);
  if (!capability) {
    throw new Error(`No drawing capability: ${id}`);
  }
  return capability;
}

/** The drawing capabilities that apply to a field kind, in registry order. */
export function drawingCapabilitiesOf(kind: FieldKind): DrawingCapability[] {
  return DRAWING_CAPABILITIES.filter((capability) => capability.kinds.includes(kind));
}

/** Whether `capability` is one a surface is asked about for `kind`. */
export function appliesToKind(capability: DrawingCapabilityId, kind: FieldKind): boolean {
  return drawingCapability(capability).kinds.includes(kind);
}
