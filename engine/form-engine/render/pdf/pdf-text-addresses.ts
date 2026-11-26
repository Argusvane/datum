/**
 * Where a PDF layout keeps the translations of its texts: `pdf › <layoutId> › <path>`
 * in the definition's map, the path built from the layout's own ids and the property's name and
 * never from an index. One small module so the render model (which resolves a text), the designer
 * (which lists and edits them) and the Languages workspace agree on every path without either
 * pulling in the other:
 *
 * - the layout: `name`, `accessibility › title`, `conformance › attachment › description`,
 *   `signature › reason`;
 * - a node of a generated layout: `nodes › <node id> › <property>`, under `nodes` so a node whose
 *   id is `name` never meets the layout's own texts beside it;
 * - a template's mapping: `fields › <AcroForm field name> › text`, `areas › <area id> › text`.
 */
import { addressOf, type TextAddress } from "../../core/localization/translations.js";

/** A text on the layout itself, named by its property path in the layout (`accessibility.title`). */
export function pdfLayoutTextAddress(layoutId: string, propertyPath: string): TextAddress {
  return addressOf.pdf(layoutId, propertyPath.split("."));
}

/** A text of a generated layout's node (`label`, `text`, `emptyText`, `alt`). */
export function pdfNodeTextAddress(layoutId: string, nodeId: string, property: string): TextAddress {
  return addressOf.pdf(layoutId, ["nodes", nodeId, property]);
}

/** A template mapping's fill text: a field by its AcroForm name, an area by its id. */
export function pdfFillTextAddress(layoutId: string, list: "fields" | "areas", key: string): TextAddress {
  return addressOf.pdf(layoutId, [list, key, "text"]);
}
