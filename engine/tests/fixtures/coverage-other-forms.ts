/**
 * The forms the feature-coverage harness (engine/feature-coverage) mounts for the "other
 * behaviour" group of its checklist, where the shared corpus has no form of the shape a feature
 * needs:
 *
 * - {@link coverageTooltipForm}: a text box with field help (`configuration.tooltip`) beside one
 *   without, for the help bubble's hover, focus and Escape;
 * - {@link coverageButtonsForm}: a button group holding a submit and a download button, a PDF
 *   button on its own, and a text box;
 * - {@link coverageUnknownForm}: a field type and a container type nothing draws, beside a field
 *   that is drawn, and a field inside the unknown container;
 * - {@link coverageMediaForm}: one text box, for a label that follows a media query (the harness
 *   draws it with an adapter that marks its control `data-label-media`).
 *
 * Each is a function so every mount gets a fresh copy.
 */
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";

function form(id: string, children: ComponentNode[]): FormDefinition {
  return {
    id,
    version: "1.0.0",
    schemaVersion: "1.0.0",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }] },
    root: { id: "form", type: "form", configuration: { label: `Coverage ${id}` }, children: { content: children } }
  } as FormDefinition;
}

/** A reference number with help, and a name without. */
export function coverageTooltipForm(): FormDefinition {
  return form("tooltip", [
    { id: "reference", type: "text", configuration: { label: "Reference number", tooltip: "It is printed at the top of your letter." } },
    { id: "name", type: "text", configuration: { label: "Full name" } }
  ]);
}

/** A name, a button group (Submit, Download a copy) and a PDF button on its own. */
export function coverageButtonsForm(): FormDefinition {
  return form("buttons", [
    { id: "name", type: "text", configuration: { label: "Full name" } },
    {
      id: "actions",
      type: "button-group",
      configuration: {},
      children: {
        content: [
          { id: "send", type: "button", configuration: { label: "Submit", action: "submit", variant: "primary" } },
          { id: "copy", type: "button", configuration: { label: "Download a copy", action: "download", variant: "secondary" } }
        ]
      }
    },
    { id: "print", type: "button", configuration: { label: "Download as PDF", action: "pdf" } }
  ]);
}

/** A name, a `mystery-dial` field and a `mystery-box` container around a town field. */
export function coverageUnknownForm(): FormDefinition {
  return form("unknown", [
    { id: "name", type: "text", configuration: { label: "Full name" } },
    { id: "dial", type: "mystery-dial", configuration: { label: "Dial" } },
    { id: "box", type: "mystery-box", configuration: { label: "Box" }, children: { content: [{ id: "town", type: "text", configuration: { label: "Town" } }] } }
  ]);
}

/** One text box whose name the harness's adapter makes follow the viewport. */
export function coverageMediaForm(): FormDefinition {
  return form("media", [{ id: "where", type: "text", configuration: { label: "Where you live" } }]);
}
