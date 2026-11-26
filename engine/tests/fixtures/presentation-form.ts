import type { Expression } from "../../form-engine/core/expressions/expression.js";
import type { ValidationContext, ValidationResult } from "../../form-engine/core/schema/contracts.js";
import type { Journey, PresentationNode } from "../../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";

/**
 * The shared fixture for presentations: one form, a journey that asks it through
 * nodes of its own, and a one-page variant. Every side is tested against it — the path engine,
 * the validation kernel in-process and in QuickJS, the browser runtime, the renderer, the
 * submissions service — so they are all judged on the same definition.
 *
 * **The form** is the submission:
 * - `email`, required;
 * - `name`;
 * - `annual_income`, a number, required, at most {@link INCOME_CEILING}, inside the fieldset
 *   `money` — which no page of either presentation lists;
 * - `approved_amount`, a number, optional.
 *
 * **The journey `apply`** has three pages:
 * - `details` holds one own field, `work_email`, an **alias**: it fills `email`;
 * - `income` holds three own number fields `m1`…`m3` and a **worked-out value**,
 *   `income_total`, which sets `annual_income` to their sum; its first route goes to `assist`
 *   when `annual_income` is at least {@link ASSIST_THRESHOLD}, its second ends the journey;
 * - `assist` lists the form's `approved_amount`, a reused field.
 *
 * So `email` stands on `details` and `annual_income` on `income` although neither page lists
 * them, `money` is a structural ancestor, `name` is on no page, and the path turns on a value
 * the browser worked out. A route reads the form field, never `m1`.
 *
 * **The variant `public`** is one questions page with no routes: an own `columns` layout
 * holding references to `email` and `name`, and an own paragraph. It leaves `annual_income`
 * out — which the form requires, so a submission through it is refused unless the answer is
 * there all the same (a host that prefills it): form rules always hold.
 *
 * `max` on `annual_income` is what a number input carries, and the browser's field-constraints
 * stage and the kernel hold the answer to it themselves (`number.max`).
 * {@link incomeCeilingValidator} is the same ceiling as a plugin validator (code `max`) for a test of
 * the plugin path.
 *
 * Everything is returned fresh, so a test may change what it is given.
 */

/** The most `annual_income` may be. */
export const INCOME_CEILING = 1_000_000;

/** From this `annual_income` up, the journey `apply` goes on to its `assist` page. */
export const ASSIST_THRESHOLD = 50_000;

const read = (name: string): Expression => ({ kind: "path", path: name });

/** `annual_income >= 50000`: a route condition over a form field the browser works out. */
export function assistCondition(): Expression {
  return { kind: "binary", operator: "gte", left: read("annual_income"), right: { kind: "literal", value: ASSIST_THRESHOLD } };
}

/** `sum(m1, m2, m3)`: what the worked-out value is worked out with, over own fields of its page. */
export function incomeExpression(): Expression {
  return { kind: "call", name: "sum", args: [read("m1"), read("m2"), read("m3")] };
}

/** The form's tree. */
export function presentationRoot(): ComponentNode {
  return {
    id: "form",
    type: "form",
    configuration: { title: "Income support" },
    children: {
      content: [
        { id: "email", type: "text", configuration: { label: "Email", required: true } },
        { id: "name", type: "text", configuration: { label: "Name" } },
        {
          id: "money",
          type: "fieldset",
          configuration: { label: "Money" },
          children: {
            content: [{ id: "annual_income", type: "number", configuration: { label: "Annual income", required: true, max: INCOME_CEILING } }]
          }
        },
        { id: "approved_amount", type: "number", configuration: { label: "Approved amount" } }
      ]
    }
  };
}

/** The alias on `details`: an own field whose answer is the form's `email`. */
export function workEmailAlias(): PresentationNode {
  return { id: "work_email", type: "text", configuration: { label: "Work email", fills: "email", required: true } };
}

/** The worked-out value on `income`: `annual_income`, from the page's own `m1`…`m3`. */
export function incomeTotal(): PresentationNode {
  return { id: "income_total", type: "journey-value", configuration: { to: "annual_income", value: incomeExpression(), label: "Annual income" } };
}

/** The journey `apply`: an alias, a worked-out value a route reads, and a reused field. */
export function applyJourney(): Journey {
  return {
    id: "apply",
    name: "Apply",
    validation: { continue: "page" },
    pages: [
      { id: "details", title: "Your details", components: [workEmailAlias()] },
      {
        id: "income",
        title: "Your income",
        components: [
          { id: "m1", type: "number", configuration: { label: "Month 1" } },
          { id: "m2", type: "number", configuration: { label: "Month 2" } },
          { id: "m3", type: "number", configuration: { label: "Month 3" } },
          incomeTotal()
        ],
        routes: [{ when: assistCondition(), to: "assist" }, { to: "$end" }]
      },
      { id: "assist", title: "Assistance", components: ["approved_amount"] }
    ]
  };
}

/** The variant `public`: one page, references inside an own layout, and an own paragraph. */
export function publicVariant(): Journey {
  return {
    id: "public",
    name: "Public",
    pages: [
      {
        id: "all",
        title: "Tell us about you",
        components: [
          {
            id: "contact",
            type: "grid",
            configuration: { columns: 2 },
            children: {
              content: [
                { type: "journey-field", configuration: { componentId: "email" } },
                { type: "journey-field", configuration: { componentId: "name" } }
              ]
            }
          },
          { id: "public_note", type: "html", configuration: { tag: "p", content: "We only use your email to reply to you." } }
        ]
      }
    ]
  };
}

/** The definition: the form with both presentations, `apply` first (so the default). */
export function presentationForm(): FormDefinition {
  return {
    id: "presentation",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: presentationRoot(),
    journey: { journeys: [applyJourney(), publicVariant()] }
  };
}

/**
 * The form's own rule that `annual_income` is at most {@link INCOME_CEILING}, as a validator
 * every side can run: a `WasmValidator` for the in-process kernel and the browser's sandbox,
 * and — it closes over nothing — portable source for QuickJS (`toSourceModule`). It reads the
 * form value alone, so a worked-out value is held to it exactly as a typed one is.
 */
export const incomeCeilingValidator = {
  id: "income-ceiling",
  version: "1.0.0",
  validate(context: ValidationContext): ValidationResult {
    const income = context.values["annual_income"];
    if (typeof income === "number" && income > 1000000) {
      return {
        errors: [{ code: "max", componentId: "annual_income", path: "annual_income", stage: "plugin", source: "custom", parameters: { max: 1000000 } }]
      };
    }
    return { errors: [] };
  }
};

/**
 * Answers as an honest browser submits them through `apply` — form values only: the alias's
 * answer at `email`, the worked-out `annual_income`, never an own field's. Below the
 * threshold the journey ends after `income`; from it up, `assist` asks for the amount.
 */
export const APPLY_BELOW = { email: "ada@example.org", annual_income: 36000 };
export const APPLY_ABOVE = { email: "ada@example.org", annual_income: 60000, approved_amount: 500 };
