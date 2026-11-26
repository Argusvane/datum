import { expect } from "vitest";

import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { definitionOf } from "./live-chrome-harness.js";

/*
 * The home repair journey for Check answers, shared by the review state's and
 * the live drawing's tests: four steps, a branch that skips the landlord's step, a data grid of
 * people, a hidden field, a field listed twice, and a Check answers page with a declaration.
 */

const yesNo = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" }
];

export function homeFields(): ComponentNode[] {
  return [
    { id: "main", type: "radio", configuration: { label: "Is this your main home?", required: true, options: yesNo } },
    { id: "address", type: "text", configuration: { label: "Address of the home", required: true } },
    {
      id: "people",
      type: "dataGrid",
      configuration: { label: "People living there", initialRows: 0, rowLabel: "Person {{n}}" },
      collection: { collectionPath: "people" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "dob", type: "date", configuration: { label: "Date of birth" } }
        ]
      }
    },
    {
      id: "tenure",
      type: "radio",
      configuration: {
        label: "Do you own or rent?",
        required: true,
        options: [
          { value: "own", label: "Own" },
          { value: "rent", label: "Rent" }
        ]
      }
    },
    { id: "landlord", type: "text", configuration: { label: "Landlord's name", required: true } },
    { id: "agreed", type: "radio", configuration: { label: "Has your landlord agreed?", options: yesNo } },
    {
      id: "work",
      type: "select",
      configuration: {
        label: "Work needed",
        required: true,
        options: [
          { value: "roof", label: "Roof repair" },
          { value: "heat", label: "Heating" }
        ]
      }
    },
    { id: "cost", type: "number", configuration: { label: "Estimated cost", prefix: "$" } },
    { id: "secret", type: "text", configuration: { label: "Only for the roof" }, rules: { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "work" }, right: { kind: "literal", value: "roof" } } } } as ComponentNode,
    { id: "notes", type: "textarea", configuration: { label: "Notes" } },
    { id: "unplaced", type: "text", configuration: { label: "On no step" } }
  ];
}

export function homeJourney(review: Journey["pages"][number]["review"] = undefined): Journey {
  return {
    id: "repair",
    progress: "count",
    pages: [
      { id: "home", title: "Your home", components: ["main", "address", "people"] },
      { id: "owning", title: "Owning or renting", components: ["tenure"], routes: [{ when: { kind: "binary", operator: "eq", left: { kind: "path", path: "tenure" }, right: { kind: "literal", value: "own" } }, to: "work" }] } as Journey["pages"][number],
      { id: "landlord", title: "Your landlord", components: ["landlord", "agreed"] },
      // A step with no title is headed by its first answer; a field listed twice stays on the first step.
      { id: "work", components: ["work", "cost", "secret", "address"] },
      {
        id: "check",
        kind: "review",
        title: "Check your answers before sending your application",
        components: [{ id: "declare", type: "paragraph", configuration: { text: "By submitting this application you confirm the details are correct." } }],
        ...(review !== undefined ? { review } : {})
      },
      { id: "notes-page", title: "Not on the path", components: ["notes"] }
    ]
  };
}

export function homeDefinition(review?: Journey["pages"][number]["review"]): FormDefinition {
  return definitionOf(homeFields(), { journey: { journeys: [homeJourney(review)] } });
}

/** Answers every step but the landlord's name, renting, and goes to the Check answers page. */
export async function toCheck(runtime: FormRuntime): Promise<void> {
  runtime.startJourney("repair");
  runtime.setValue("main", "yes");
  runtime.setValue("address", "12 Elm Street\nHalifax");
  runtime.addRows("people", [{ name: "Ana Silva", dob: "1988-03-04" }, { name: "Leo Silva", dob: "2015-07-19" }]);
  expect((await runtime.nextPage()).pageId).toBe("owning");
  runtime.setValue("tenure", "rent");
  expect((await runtime.nextPage()).pageId).toBe("landlord");
  runtime.setValue("agreed", "yes");
  expect((await runtime.nextPage()).pageId).toBe("work");
  runtime.setValue("work", "heat");
  expect((await runtime.nextPage()).pageId).toBe("check");
}
