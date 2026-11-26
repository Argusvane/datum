/** How a resolved fill value reads as "on" and as text — shared by field filling and area drawing. */
import type { PdfFillValue } from "@argusvane/datum-engine/render";

export function truthy(value: PdfFillValue): boolean {
  return value === true || value === "true" || value === "on" || value === "yes" || (typeof value === "string" && value.trim() !== "" && value !== "false" && value !== "off" && value !== "no") || (Array.isArray(value) && value.length > 0);
}

export function asText(value: PdfFillValue): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "";
  }
  return Array.isArray(value) ? value.join(", ") : value;
}
