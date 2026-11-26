import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { LiveBinding } from "../form-engine/render/live/contract.js";
import { createDatumDateAdapter, createDatumDateStateBuilder, datumDateAdapter, type DatumDateOptions } from "../form-engine/render/live/datum/date.js";
import { datumContainerComponents, type DatumContainerOptions } from "../form-engine/render/live/datum/containers.js";
import { datumButton } from "../form-engine/render/live/datum/buttons.js";
import { createNumberAdapter, createTextAdapter, datumTextComponents } from "../form-engine/render/live/datum/text-fields.js";
import { resolveFieldOptions, type DatumFieldOptionsInput } from "../form-engine/render/live/datum/field-scaffold.js";
import { createFieldsFeature } from "../form-engine/render/live/fields.js";
import { createDataGridFeature } from "../form-engine/render/live/data-grid.js";
import { stepsFeature } from "../form-engine/render/live/steps.js";
import { createTabsFeature } from "../form-engine/render/live/tabs.js";
import type { LiveFeature, LiveMountOptions } from "../form-engine/render/live/mount.js";
import { mounted, runtimeOf, type Mounted } from "./live-chrome-harness.js";

/*
 * Shared setup for the tests of the Datum binding's adapters for dates, numbers and containers:
 * a Datum binding assembled from the adapters under test, the renderer modules that feed them, a
 * mount, and readers of what a person or a screen reader gets from the drawn DOM (roles, names,
 * ids, descriptions, states).
 */

export interface DatumBindingOptions {
  date?: DatumDateOptions;
  fields?: DatumFieldOptionsInput;
  containers?: DatumContainerOptions;
}

export function datumBinding(options: DatumBindingOptions = {}): LiveBinding {
  const field = resolveFieldOptions(options.fields);
  return {
    id: "datum",
    label: "Datum",
    components: {
      ...datumTextComponents(options.fields),
      date: createDatumDateAdapter(options.date, field),
      button: datumButton,
      ...datumContainerComponents(options.containers)
    }
  };
}

/** The renderer modules the adapters under test need, listed as a host lists them. */
export function datumFeatures(options: DatumBindingOptions = {}): LiveFeature[] {
  return [createFieldsFeature({ date: createDatumDateStateBuilder(options.date) }), createTabsFeature(), createDataGridFeature(), stepsFeature()];
}

export async function mountDatum(definition: FormDefinition, options: DatumBindingOptions & Partial<LiveMountOptions> & { runtime?: FormRuntime } = {}): Promise<Mounted> {
  const { date, fields, containers, features, ...rest } = options;
  const binding = datumBinding({ ...(date ? { date } : {}), ...(fields ? { fields } : {}), ...(containers ? { containers } : {}) });
  return mounted(definition, { binding, datum: binding, ...rest, features: [...datumFeatures({ ...(date ? { date } : {}) }), ...(features ?? [])], runtime: options.runtime ?? runtimeOf(definition) });
}

export { createNumberAdapter, createTextAdapter, datumDateAdapter };

// ── Facts: what a person or a screen reader gets from the DOM ──────────────────────────────

const text = (node: Element | null | undefined): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const byId = (scope: ParentNode, id: string): Element | null => scope.querySelector(`[id="${id}"]`);
const idsOf = (value: string | null): string[] => (value ?? "").split(/\s+/).filter((id) => id !== "");

/** The accessible name of a control: its labelledby targets, else its label, else its aria-label. */
function nameOf(scope: ParentNode, element: Element): string {
  const labelledBy = idsOf(element.getAttribute("aria-labelledby"));
  if (labelledBy.length > 0) {
    return labelledBy.map((id) => text(byId(scope, id))).join(" ");
  }
  const id = element.getAttribute("id");
  const label = id !== null ? scope.querySelector(`label[for="${id}"]`) : element.closest("label");
  return label !== null ? text(label) : (element.getAttribute("aria-label") ?? "");
}

export interface ControlFacts {
  tag: string;
  type: string | null;
  id: string | null;
  name: string;
  describedBy: string[];
  describedText: string[];
  invalid: string | null;
  required: string | null;
  disabled: boolean;
  readOnly: boolean;
  value: string;
  min: string | null;
  max: string | null;
  inputMode: string | null;
  autocomplete: string | null;
}

export function controlFacts(scope: ParentNode): ControlFacts[] {
  return Array.from(scope.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")).map((element) => {
    const describedBy = idsOf(element.getAttribute("aria-describedby"));
    return {
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type"),
      id: element.getAttribute("id"),
      name: nameOf(scope, element),
      describedBy,
      describedText: describedBy.map((id) => text(byId(scope, id))),
      invalid: element.getAttribute("aria-invalid"),
      required: element.getAttribute("aria-required"),
      disabled: (element as HTMLInputElement).disabled,
      readOnly: (element as HTMLInputElement).readOnly === true,
      value: element.value,
      min: element.getAttribute("min"),
      max: element.getAttribute("max"),
      inputMode: element.getAttribute("inputmode"),
      autocomplete: element.getAttribute("autocomplete")
    };
  });
}

export interface GroupFacts {
  legend: string;
  name: string;
  describedBy: string[];
  describedText: string[];
  invalid: string | null;
}

/** The legend of a fieldset: its direct child (`:scope` does not reach into a shadow tree under jsdom). */
const legendOf = (fieldset: Element): Element | undefined => Array.from(fieldset.children).find((child) => child.tagName === "LEGEND");

/** Every fieldset that is a labelled group (has a legend). */
export function groupFacts(scope: ParentNode): GroupFacts[] {
  return Array.from(scope.querySelectorAll("fieldset"))
    .filter((fieldset) => legendOf(fieldset) !== undefined)
    .map((fieldset) => {
      const describedBy = idsOf(fieldset.getAttribute("aria-describedby"));
      return {
        legend: text(legendOf(fieldset)),
        name: nameOf(scope, fieldset) || text(legendOf(fieldset)),
        describedBy,
        describedText: describedBy.map((id) => text(byId(scope, id))),
        invalid: fieldset.getAttribute("aria-invalid")
      };
    });
}

/** The text of the elements an error is drawn in (an alert region). */
export const alertsOf = (scope: ParentNode): string[] => Array.from(scope.querySelectorAll('[role="alert"]')).map((element) => text(element));
export { text as textOf };
