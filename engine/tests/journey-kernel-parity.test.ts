import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ValidationContext, ValidationResult } from "../form-engine/core/schema/contracts.js";
import { findJourney, validateJourneyShape, type Journey, type JourneyPageEntry, type PresentationNode } from "../form-engine/core/schema/journey.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { journeyOwnership } from "../form-engine/core/journey/journey-path.js";
import { buildPresentationIndex } from "../form-engine/core/journey/presentation.js";
import {
  kernelDefinesKey,
  kernelFlattenRows,
  kernelFoldSubmission,
  kernelNormalizeDataGrids,
  kernelIsJourney,
  kernelKnownKeyShapes,
  runKernel as kernelRun,
  type KernelOutcome,
  type KernelValidator
} from "../form-engine/validation/wasm/portable-kernel.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { JsonWasmAbi, WasmValidationHost, type WasmValidator } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { selectPdfLayoutForValues } from "../form-engine/render/pdf/pdf-layout-selection.js";
import {
  APPLY_ABOVE,
  APPLY_BELOW,
  applyJourney,
  incomeTotal,
  presentationRoot,
  publicVariant,
  workEmailAlias
} from "./fixtures/presentation-form.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";

// A host hands the kernel the function table's signatures, as the in-process and sandbox hosts
// do: a tree's calls are checked against them like a formula's. These runs do the same.
const runKernel = (
  context: Parameters<typeof kernelRun>[0],
  validators: Parameters<typeof kernelRun>[1],
  functions?: Parameters<typeof kernelRun>[2],
  signatures: Parameters<typeof kernelRun>[3] = formulaFunctionSignatures(),
  cache?: Parameters<typeof kernelRun>[4]
): ReturnType<typeof kernelRun> => kernelRun(context, validators, functions, signatures, cache);

/** The node with `id` under `root`, when there is one. */
function nodeOf(root: ComponentNode, id: string): ComponentNode | undefined {
  const stack: ComponentNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    if (node.id === id) {
      return node;
    }
    for (const children of Object.values(node.children ?? {})) {
      stack.push(...children);
    }
  }
  return undefined;
}

/**
 * The browser and the server reach one verdict: a FormRuntime submits — its own
 * validation, then the in-process validation kernel as its sandbox — and the kernel, run
 * directly on the envelope's values as a server holding only the envelope would run it,
 * agrees on whether the answers are accepted, on every error by component, and on the values.
 *
 * A blocked submission has no envelope; the values the kernel is given then are what the same
 * answers submit under a mode that does not validate — the browser's submittable view. An
 * exit path submits nothing under any mode, so the kernel is given the answers as stored and
 * must refuse them too. Rules reading `host.` are left out: a server has no host context,
 * which is a documented difference (`rule.reads-host`).
 */

const path = (name: string): Expression => ({ kind: "path", path: name });
const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const eq = (name: string, value: string | number | boolean | null): Expression => ({
  kind: "binary",
  operator: "eq",
  left: path(name),
  right: literal(value)
});
const neq = (name: string, value: string | number | boolean | null): Expression => ({
  kind: "binary",
  operator: "neq",
  left: path(name),
  right: literal(value)
});

const EXCLUDE = { hiddenValueBehavior: "exclude-from-submission" } as const;

function field(id: string, configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type: "text", configuration, ...extra };
}

function group(id: string, type: string, children: ComponentNode[], configuration: Record<string, unknown> = {}): ComponentNode {
  return { id, type, configuration, children: { content: children } };
}

function formOf(children: ComponentNode[], journey?: Journey): FormDefinition {
  return {
    id: "parity",
    version: "1",
    schemaVersion: "1",
    root: group("form", "form", children),
    ...(journey ? { journey: { journeys: [journey] } } : {})
  };
}

const envelope = {
  form: { id: "parity", version: "1" },
  client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" }
};

// --- Fixtures ---------------------------------------------------------------------------

/** Eligibility: a route to an exit page, a route between two branches, a container of contact details, a note on no page. */
function branching(): FormDefinition {
  return formOf(
    [
      field("resident", { required: true, options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "on", label: "on" }] }, { type: "select" }),
      field("employed", {}, { type: "checkbox" }),
      field("business_name", { required: true, minLength: 3 }),
      field("employer", { required: true }),
      group("contact", "container", [field("email", { required: true, pattern: "[^@]+@[^@]+" }), field("phone")]),
      field("notes", { minLength: 10 }, { type: "textarea" }),
      { id: "exit_message", type: "html", configuration: {} }
    ],
    {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"], routes: [{ when: eq("resident", "no"), to: "ineligible" }] },
        { id: "work", components: ["employed"], routes: [{ when: eq("employed", true), to: "employment" }] },
        { id: "self", components: ["business_name"], routes: [{ to: "details" }] },
        { id: "employment", components: ["employer"] },
        { id: "details", components: ["contact"], routes: [{ to: "$end" }] },
        { id: "ineligible", kind: "exit", components: ["exit_message"] }
      ]
    }
  );
}

/** A field under a data key, and a data-scoping container of keyed fields on a page the path may skip. */
function keyed(): FormDefinition {
  return formOf(
    [
      field("has_pet", {}, { type: "checkbox" }),
      field("owner", { required: true, dataKey: "owner_name" }),
      group("pet", "container", [field("pet_name", { required: true, dataKey: "name" }), field("species", { required: true })])
    ],
    {
      id: "pets",
      pages: [
        { id: "you", components: ["has_pet", "owner"], routes: [{ when: neq("has_pet", true), to: "$end" }] },
        { id: "your-pet", components: ["pet"] }
      ]
    }
  );
}

/** A field hidden by its own rule, excluded from submission, whose stored answer would take a route. */
function hiddenRoute(): FormDefinition {
  return formOf(
    [
      field("gate", {}, { type: "checkbox" }),
      field("shortcut", EXCLUDE, { rules: { visibleWhen: eq("gate", true) } }),
      field("middle", { required: true }),
      field("last", { required: true })
    ],
    {
      id: "route",
      pages: [
        { id: "first", components: ["gate", "shortcut"], routes: [{ when: eq("shortcut", "skip"), to: "third" }] },
        { id: "second", components: ["middle"] },
        { id: "third", components: ["last"] }
      ]
    }
  );
}

/** An answer on a page the path may skip, read by a later field's visibility. */
function staleBranch(): FormDefinition {
  return formOf(
    [
      field("branch", { options: [{ value: "x", label: "x" }, { value: "y", label: "y" }] }, { type: "select" }),
      field("detail"),
      field("extra", { required: true }, { rules: { visibleWhen: eq("detail", "yes") } }),
      field("final")
    ],
    {
      id: "stale",
      pages: [
        { id: "choose", components: ["branch"], routes: [{ when: neq("branch", "x"), to: "finish" }] },
        { id: "detailed", components: ["detail"] },
        { id: "finish", components: ["extra", "final"] }
      ]
    }
  );
}

/** A data-scoping section listed on a page the path may skip, holding a field also listed on a page it takes. */
function sharedField(): FormDefinition {
  return formOf(
    [
      field("kind", { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] }, { type: "select" }),
      group("section", "container", [field("shared", { required: true }), field("only_here", { required: true })])
    ],
    {
      id: "shared",
      pages: [
        { id: "start", components: ["kind"], routes: [{ when: neq("kind", "full"), to: "short" }] },
        { id: "full", components: ["section"] },
        { id: "short", components: ["shared"] }
      ]
    }
  );
}

/** No journey: a field hidden by its own rule and excluded, read by another field's visibility. */
function noJourney(): FormDefinition {
  return formOf([
    field("gate", {}, { type: "checkbox" }),
    field("secret", EXCLUDE, { rules: { visibleWhen: eq("gate", true) } }),
    field("echo", { required: true }, { rules: { visibleWhen: eq("secret", "open") } })
  ]);
}

/** No journey: an email and an upload hidden by a rule, their answers retained (the default). */
function hiddenRetained(): FormDefinition {
  const byEmail = eq("by_email", true);
  return formOf([
    field("by_email", {}, { type: "checkbox" }),
    // The two that are held to their format retain explicitly: the hidden default leaves an answer out.
    field("email", { required: true, maxLength: 20, pattern: "[^@]+@[^@]+", hiddenValueBehavior: "retain" }, { rules: { visibleWhen: byEmail } }),
    field("upload", { maxFileSizeMb: 1, accept: ".pdf", hiddenValueBehavior: "retain" }, { type: "file", rules: { visibleWhen: byEmail } }),
    field("cleared", { maxLength: 3, hiddenValueBehavior: "clear" }, { rules: { visibleWhen: byEmail } })
  ]);
}

/** Calculations: an age from a birth year, a flag from the age, a guardian asked of a minor. */
function calculated(): FormDefinition {
  return formOf([
    field("birth_year", { required: true }, { type: "number" }),
    field("age", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "subtract", left: literal(2026), right: path("birth_year") } } }),
    field("minor", {}, { type: "checkbox", rules: { value: { kind: "binary", operator: "lt", left: path("age"), right: literal(18) } } }),
    field("guardian", { required: true }, { rules: { visibleWhen: eq("minor", true) } })
  ]);
}

/** A repeating section on a page the path may skip, its entries kept at `collectionPath`. */
function collected(collectionPath: string, dotted = false): FormDefinition {
  const section: ComponentNode = {
    id: dotted ? "order_items" : "items",
    type: "repeatingSection",
    configuration: {},
    collection: { itemFields: ["sku"], collectionPath },
    children: { content: [field("sku")] }
  };
  return formOf([field("kind", { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] }, { type: "select" }), dotted ? group("order", "container", [section]) : section], {
    id: "order",
    pages: [
      { id: "start", components: ["kind"], routes: [{ when: neq("kind", "full"), to: "$end" }] },
      { id: "full", components: [section.id] }
    ]
  });
}

/** The same section with no journey: hidden by a rule, its entries excluded. */
function collectedHidden(): FormDefinition {
  return formOf([
    field("kind", { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] }, { type: "select" }),
    {
      id: "items",
      type: "repeatingSection",
      configuration: EXCLUDE,
      rules: { visibleWhen: eq("kind", "full") },
      collection: { itemFields: ["sku"], collectionPath: "order_lines" },
      children: { content: [field("sku")] }
    }
  ]);
}

/** A generated PDF layout, printed when `when` holds. */
function layout(id: string, when?: Expression): PdfGeneratedLayout {
  return { id, kind: "generated", ...(when ? { when } : {}), root: { id: `${id}-doc`, type: "pdf-document", configuration: {}, children: { body: [] } } };
}

const ratioKnown: Expression = { kind: "binary", operator: "neq", left: path("ratio"), right: literal(null) };

/**
 * A household ratio that comes to no answer when the household is left empty or 0 — what the Rules
 * tab's "ratio / does not equal / null" row reads — feeding a field's visibility, a route, a
 * calculation of its own and a PDF layout's `when`. A server holds the ratio as JSON's `null`.
 */
function ratioForm(): FormDefinition {
  return {
    ...formOf(
      [
        field("income", { required: true }, { type: "number" }),
        field("members", {}, { type: "number" }),
        field("ratio", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "divide", left: path("income"), right: path("members") } } }),
        field("per_person", {}, { type: "number", rules: { value: { kind: "call", name: "coalesce", args: [path("ratio"), literal(0)] } } }),
        field("explain", { required: true }, { rules: { visibleWhen: ratioKnown } }),
        field("shared", { required: true }),
        field("contact")
      ],
      {
        id: "household",
        pages: [
          { id: "money", components: ["income", "members", "ratio", "per_person", "explain"], routes: [{ when: ratioKnown, to: "reach" }] },
          { id: "sharing", components: ["shared"] },
          { id: "reach", components: ["contact"], routes: [{ to: "$end" }] }
        ]
      }
    ),
    pdf: { layouts: [layout("standard"), layout("per-person", ratioKnown)], defaultLayoutId: "standard" }
  };
}

/** A value under a key no component owns (`campaign`), read by a field's visibility and a layout's `when`. */
function campaignForm(): FormDefinition {
  const spring = eq("campaign", "spring");
  return {
    ...formOf([field("name", { required: true }), field("promo", { required: true }, { rules: { visibleWhen: spring } })]),
    pdf: { layouts: [layout("standard"), layout("campaign", spring)], defaultLayoutId: "standard" }
  };
}

/**
 * A required calculation that comes to no answer when the household is left empty or 0: the
 * browser holds `undefined`, the envelope no key, and both must call it unanswered.
 */
function requiredRatioForm(): FormDefinition {
  return formOf(
    [
      field("income", { required: true }, { type: "number" }),
      field("members", {}, { type: "number" }),
      field("ratio", { required: true }, { type: "number", rules: { value: { kind: "arithmetic", operator: "divide", left: path("income"), right: path("members") } } }),
      field("contact")
    ],
    {
      id: "household",
      pages: [
        { id: "money", components: ["income", "members", "ratio"] },
        { id: "reach", components: ["contact"], routes: [{ to: "$end" }] }
      ]
    }
  );
}

const bigOrder: Expression = { kind: "binary", operator: "gt", left: path("orders[0].qty"), right: literal(5) };

/**
 * A data grid whose rows the runtime keeps at `orders[i].<column>`: its first row's quantity
 * shows a required field, takes a route past a page with a required field, and chooses a PDF
 * layout. The rows are keys the schema defines, so every side reads them and a server that
 * strips unknown fields keeps them.
 */
function gridForm(): FormDefinition {
  const grid: ComponentNode = {
    id: "orders_grid",
    type: "dataGrid",
    // A data grid: rows at its collection path, its children the fields of a row.
    // It opens with no rows (`initialRows: 0`), so the browser holds exactly the rows a test adds.
    configuration: { initialRows: 0 },
    collection: { collectionPath: "orders" },
    children: {
      content: [
        { id: "qty", type: "number", configuration: {} },
        { id: "sku", type: "text", configuration: {} }
      ]
    }
  };
  return {
    ...formOf(
      [grid, field("rush", { required: true }, { rules: { visibleWhen: bigOrder } }), field("reason", { required: true }), field("contact")],
      {
        id: "ordering",
        pages: [
          { id: "order", components: ["orders_grid", "rush"], routes: [{ when: bigOrder, to: "reach" }] },
          { id: "why", components: ["reason"] },
          { id: "reach", components: ["contact"], routes: [{ to: "$end" }] }
        ]
      }
    ),
    pdf: { layouts: [layout("standard"), layout("bulk", bigOrder)], defaultLayoutId: "standard" }
  };
}

/**
 * Required when, one fixture for every side: `phone` while the contact method is
 * phone; `echo` reading an answer hidden and excluded; `extra` reading an answer on a page the
 * path may skip; a keyed field in a data-scoping container; a rule reading `host.`; a ticked
 * field whose rule is false; a rule reading a calculation that comes to no answer.
 */
function requiredWhenForm(): FormDefinition {
  return formOf(
    [
      field("contact", { options: [{ value: "phone", label: "phone" }, { value: "email", label: "email" }, { value: "post", label: "post" }, { value: "on", label: "on" }] }, { type: "radio" }),
      field("phone", {}, { rules: { requiredWhen: eq("contact", "phone") } }),
      field("gate", {}, { type: "checkbox" }),
      field("secret", EXCLUDE, { rules: { visibleWhen: eq("gate", true) } }),
      field("echo", {}, { rules: { requiredWhen: eq("secret", "open") } }),
      field("branch", { options: [{ value: "x", label: "x" }, { value: "y", label: "y" }] }, { type: "select" }),
      field("detail"),
      field("extra", {}, { rules: { requiredWhen: eq("detail", "yes") } }),
      group("billing", "container", [field("postcode", { dataKey: "code" }, { rules: { requiredWhen: eq("contact", "post") } })]),
      field("staff_note", {}, { rules: { requiredWhen: eq("host.role", "staff") } }),
      field("both", { required: true }, { rules: { requiredWhen: eq("contact", "never") } }),
      field("income", {}, { type: "number" }),
      field("members", {}, { type: "number" }),
      field("ratio", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "divide", left: path("income"), right: path("members") } } }),
      field("per_head", {}, { rules: { requiredWhen: ratioKnown } })
    ],
    {
      id: "reach",
      pages: [
        { id: "how", components: ["contact", "phone", "gate", "secret", "echo", "branch"], routes: [{ when: neq("branch", "x"), to: "finish" }] },
        { id: "detailed", components: ["detail"] },
        { id: "finish", components: ["extra", "billing", "staff_note", "both", "income", "members", "ratio", "per_head"], routes: [{ to: "$end" }] }
      ]
    }
  );
}

/** The answers every accepted case of {@link requiredWhenForm} starts from: the ticked field filled, no rule holding. */
const REACHABLE = { contact: "email", both: "yes" };

/**
 * Form rules always hold: a two-page journey that leaves most of the form off every
 * page. `ref` is required; `secret` hides itself and is excluded; `staff_ref` and, through its
 * fieldset, `nested_ref` are shown by the host; `opt_in` is hidden on the form and opts in to
 * being required and validated; `total` is worked out from `cost`; `code` has a pattern.
 * `extra` sits on a page the path may skip.
 */
function leftOut(): FormDefinition {
  const staff = eq("host.role", "staff");
  return formOf(
    [
      field("resident", { required: true, options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "on", label: "on" }] }, { type: "select" }),
      field("extra", { required: true }),
      field("ref", { required: true }),
      field("secret", { required: true, ...EXCLUDE }, { rules: { visibleWhen: eq("resident", "never") } }),
      field("staff_ref", { required: true }, { rules: { visibleWhen: staff } }),
      { ...group("staff_box", "fieldset", [field("nested_ref", { required: true })]), rules: { visibleWhen: staff } },
      field("opt_in", { hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" }),
      field("cost", {}, { type: "number" }),
      field("total", {}, { type: "number", rules: { value: { kind: "arithmetic", operator: "multiply", left: path("cost"), right: literal(2) } } }),
      field("code", { pattern: "[A-Z]{3}" })
    ],
    {
      id: "short",
      pages: [
        { id: "start", components: ["resident"], routes: [{ when: neq("resident", "yes"), to: "$end" }] },
        { id: "more", components: ["extra"] }
      ]
    }
  );
}

/** The answers every accepted case of {@link leftOut} starts from: the fields on no page the form requires, filled. */
const LEFT_OUT_FILLED = { resident: "no", ref: "R-1", opt_in: "O-1", staff_ref: "S-1", nested_ref: "N-1" };
/** What the envelope carries for them: the calculation on no page has no answer, so no key (arithmetic over a missing operand). */
const LEFT_OUT_SENT = { ...LEFT_OUT_FILLED };

/** A plugin validator that knows nothing of the path: it flags `business_name` always, `email` on one address. */
const flagging: WasmValidator = {
  id: "flagging",
  version: "1",
  validate(context: ValidationContext): ValidationResult {
    const errors: ValidationResult["errors"] = [{ code: "plugin.flag", componentId: "business_name", stage: "plugin", source: "custom" }];
    if (context.values["contact.email"] === "blocked@example.org") {
      errors.push({ code: "plugin.flag", componentId: "email", stage: "plugin", source: "custom" });
    }
    return { errors };
  }
};

// --- The comparison ---------------------------------------------------------------------

interface Verdict {
  accepted: boolean;
  /** `componentId:code`, sorted; `-` for an error on no component. */
  errors: string[];
}

function codes(errors: ReadonlyArray<{ code: string; componentId?: string | undefined }>): string[] {
  return errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
}

/** Steps a person takes after the answers are set: rows added, answers changed. */
type Steps = (runtime: FormRuntime) => void;

function runtimeFor(form: FormDefinition, answers: Record<string, unknown>, validators: readonly WasmValidator[], steps?: Steps): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
  const runtime = new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
    wasmValidationHost: createInProcessWasmValidationHost([{ id: "plugins", version: "1", validators: [...validators] }])
  });
  for (const [key, value] of Object.entries(answers)) {
    runtime.setValue(key, value);
  }
  steps?.(runtime);
  return runtime;
}

/** The browser with no sandbox: the client pipeline alone judges, and the envelope goes to a server as it is. */
function clientOnlyFor(form: FormDefinition, answers: Record<string, unknown>, steps?: Steps): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
  const runtime = new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]) });
  for (const [key, value] of Object.entries(answers)) {
    runtime.setValue(key, value);
  }
  steps?.(runtime);
  return runtime;
}

/**
 * What the kernel reads a sent document as: the browser posts each
 * collection's entries as one list at its collection path (`items: [{ sku }]`, `[]` for a
 * section with no row), which the kernel flattens into the keys it returns (`items[0].sku`, no
 * key for an empty list). The server accepts exactly what the browser sent, read that way.
 */
function flattened(form: FormDefinition, values: Record<string, unknown>): Record<string, unknown> {
  return { ...kernelFlattenRows(values, kernelNormalizeDataGrids(form.root)).values };
}

async function compare(
  form: FormDefinition,
  answers: Record<string, unknown>,
  validators: readonly WasmValidator[] = [],
  steps?: Steps
): Promise<{ browser: Verdict; server: Verdict; values: Record<string, unknown> }> {
  const submitted = await runtimeFor(form, answers, validators, steps).submit("submit", envelope);
  const browser: Verdict = { accepted: submitted.accepted, errors: codes(submitted.errors) };

  let values: Record<string, unknown>;
  let fromEnvelope = true;
  if (submitted.accepted && submitted.canonicalSubmission) {
    values = submitted.canonicalSubmission.submission.values;
  } else {
    const unvalidated = await runtimeFor(form, answers, validators, steps).submit("send", envelope);
    if (unvalidated.canonicalSubmission) {
      values = unvalidated.canonicalSubmission.submission.values;
    } else {
      // An exit path: nothing is sent under any mode.
      values = answers;
      fromEnvelope = false;
    }
  }

  const journey = findJourney(form);
  const kernelValidators = validators.map((validator): KernelValidator => (context) => validator.validate(context));
  const outcome = runKernel({ formId: form.id, values, locale: "en", form: form.root, ...(journey ? { journey } : {}) }, kernelValidators);
  const blocked = outcome.errors.some((error) => (error.severity ?? "error") === "error");
  const server: Verdict = { accepted: !blocked && outcome.values !== undefined, errors: codes(outcome.errors) };

  expect(server).toEqual(browser);
  if (browser.accepted) {
    // The server accepts exactly what the browser sent, its rows read as the kernel's keys.
    expect(outcome.values).toEqual(flattened(form, values));
  } else {
    expect(outcome.values).toBeUndefined();
    if (fromEnvelope) {
      // Nothing to accept; what the browser would send is still a fixpoint of the server's fold.
      expect(kernelFoldSubmission(form.root, values, journey).submittable).toEqual(values);
    }
  }
  return { browser, server, values };
}

describe("journey parity: the runtime's verdict is the kernel's over the envelope", () => {
  it("a branching journey with routes and conditions", async () => {
    const employed = await compare(branching(), {
      resident: "yes",
      employed: true,
      employer: "ACME",
      business_name: "x",
      "contact.email": "a@b.co",
      notes: "a note long enough"
    });
    expect(employed.browser).toEqual({ accepted: true, errors: [] });
    // The untaken branch's answer is not sent; the note on no page is.
    expect(employed.values).toEqual({ resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co", notes: "a note long enough" });

    // The note on no page is never required, but it is submitted, so it keeps its format.
    const shortNote = await compare(branching(), { resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co", notes: "short" });
    expect(shortNote.browser).toEqual({ accepted: false, errors: ["notes:minLength"] });

    const selfEmployed = await compare(branching(), { resident: "yes", "contact.email": "not an address" });
    expect(selfEmployed.browser).toEqual({ accepted: false, errors: ["business_name:required", "email:pattern"] });
  });

  it("a keyed field, and a data-scoping container of keyed fields on a skipped page", async () => {
    const skipped = await compare(keyed(), { has_pet: false, owner_name: "Ada", "pet.name": "Rex" });
    expect(skipped.browser.accepted).toBe(true);
    expect(skipped.values).toEqual({ has_pet: false, owner_name: "Ada" });

    const taken = await compare(keyed(), { has_pet: true, owner_name: "Ada", "pet.species": "cat" });
    expect(taken.browser).toEqual({ accepted: false, errors: ["pet_name:required"] });
  });

  it("a field hidden by its own rule and excluded, whose stored answer would take a route", async () => {
    // Hidden: its answer is not submitted, so it cannot take the route — the middle page is asked.
    const hidden = await compare(hiddenRoute(), { gate: false, shortcut: "skip", last: "done" });
    expect(hidden.browser).toEqual({ accepted: false, errors: ["middle:required"] });

    const shown = await compare(hiddenRoute(), { gate: true, shortcut: "skip", last: "done" });
    expect(shown.browser.accepted).toBe(true);
    expect(shown.values).toEqual({ gate: true, shortcut: "skip", last: "done" });
  });

  it("a stale answer on a skipped page, read by a later field's visibility", async () => {
    const stale = await compare(staleBranch(), { branch: "y", detail: "yes", final: "f" });
    expect(stale.browser.accepted).toBe(true);
    expect(stale.values).toEqual({ branch: "y", final: "f" });

    const current = await compare(staleBranch(), { branch: "x", detail: "yes", final: "f" });
    expect(current.browser).toEqual({ accepted: false, errors: ["extra:required"] });
  });

  it("a skipped section holding a field also listed on a page the path takes", async () => {
    const answered = await compare(sharedField(), { kind: "short", "section.shared": "kept", "section.only_here": "stale" });
    expect(answered.browser.accepted).toBe(true);
    expect(answered.values).toEqual({ kind: "short", "section.shared": "kept" });

    const unanswered = await compare(sharedField(), { kind: "short", "section.only_here": "stale" });
    expect(unanswered.browser).toEqual({ accepted: false, errors: ["shared:required"] });
  });

  it("an exit path", async () => {
    const exit = await compare(branching(), { resident: "no", employer: "ACME", "contact.email": "a@b.co" });
    expect(exit.browser).toEqual({ accepted: false, errors: ["-:journey.exit"] });
  });

  it("a plugin validator flagging a field off the path", async () => {
    const answers = { resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co" };
    const offPath = await compare(branching(), answers, [flagging]);
    expect(offPath.browser).toEqual({ accepted: true, errors: [] });

    const onPath = await compare(branching(), { ...answers, "contact.email": "blocked@example.org" }, [flagging]);
    expect(onPath.browser).toEqual({ accepted: false, errors: ["email:plugin.flag"] });
  });

  it("no journey: a hidden answer still submitted is held to its format, on both sides", async () => {
    const long = await compare(hiddenRetained(), { by_email: false, email: "x".repeat(50), cleared: "far too long" });
    expect(long.browser).toEqual({ accepted: false, errors: ["email:maxLength"] });

    const file = await compare(hiddenRetained(), { by_email: false, upload: { storage: "inline", name: "evil.exe", type: "application/x-msdownload", size: 999999999 } });
    expect(file.browser).toEqual({ accepted: false, errors: ["upload:maxFileSize"] });

    // Hidden and empty: not required, anywhere.
    const empty = await compare(hiddenRetained(), { by_email: false });
    expect(empty.browser).toEqual({ accepted: true, errors: [] });
  });

  it("calculations: the server works them out again, and an honest submission comes back unchanged", async () => {
    const minor = await compare(calculated(), { birth_year: 2015, guardian: "Grace" });
    expect(minor.browser).toEqual({ accepted: true, errors: [] });
    expect(minor.values).toEqual({ birth_year: 2015, age: 11, minor: true, guardian: "Grace" });

    const adult = await compare(calculated(), { birth_year: 1990 });
    expect(adult.browser).toEqual({ accepted: true, errors: [] });
    expect(adult.values).toEqual({ birth_year: 1990, age: 36, minor: false });

    const unanswered = await compare(calculated(), { birth_year: 2015 });
    expect(unanswered.browser).toEqual({ accepted: false, errors: ["guardian:required"] });
  });

  it("a repeating section at its own collection path, its entries added on a branch then abandoned", async () => {
    const abandon = (at: string): Steps => (runtime) => {
      runtime.addRow(at, { sku: "abandoned" });
      runtime.setValue("kind", "short");
    };
    const explicit = await compare(collected("order_lines"), { kind: "full" }, [], abandon("order_lines"));
    expect(explicit.browser.accepted).toBe(true);
    expect(explicit.values).toEqual({ kind: "short" });

    const dotted = await compare(collected("order.items", true), { kind: "full" }, [], abandon("order.items"));
    expect(dotted.browser.accepted).toBe(true);
    expect(dotted.values).toEqual({ kind: "short" });

    const hidden = await compare(collectedHidden(), { kind: "full" }, [], abandon("order_lines"));
    expect(hidden.browser.accepted).toBe(true);
    expect(hidden.values).toEqual({ kind: "short" });

    // The branch kept: its entries are submitted.
    const kept = await compare(collected("order_lines"), { kind: "full" }, [], (runtime) => {
      runtime.addRow("order_lines", { sku: "kept" });
    });
    expect(kept.browser.accepted).toBe(true);
    expect(kept.values.order_lines).toEqual([{ sku: "kept" }]);
    expect(Object.values(flattened(collected("order_lines"), kept.values))).toContain("kept");
  });

  it("a calculation that comes to no answer steers a field, a route, a calculation and a PDF layout as the missing answer a server reads", async () => {
    // Left empty or 0, the household gives the ratio no answer: undefined in the browser, no key in the envelope.
    for (const members of [undefined, 0]) {
      const answers: Record<string, unknown> = { income: 1200, shared: "yes", ...(members !== undefined ? { members } : {}) };
      const empty = await compare(ratioForm(), answers);
      // Not "explain:required": `explain` is hidden and the route not taken, on both sides.
      expect(empty.browser, String(members)).toEqual({ accepted: true, errors: [] });
      // The ratio as JSON carries it, and the calculation that reads it read the same null.
      expect(empty.values).toStrictEqual({ income: 1200, ...(members !== undefined ? { members } : {}), per_person: 0, shared: "yes" });
    }
    const known = await compare(ratioForm(), { income: 1200, members: 3, explain: "three of us", contact: "a@b.co" });
    expect(known.browser).toEqual({ accepted: true, errors: [] });
    expect(known.values).toStrictEqual({ income: 1200, members: 3, ratio: 400, per_person: 400, explain: "three of us", contact: "a@b.co" });

    // One view on every side: the runtime's submittable view, its envelope, the kernel's verdict,
    // and the layout each of them chooses.
    for (const [answers, expected] of [
      [{ income: 1200, shared: "yes" }, "standard"],
      [{ income: 1200, members: 0, shared: "yes" }, "standard"],
      [{ income: 1200, members: 3, explain: "three of us" }, "per-person"]
    ] as const) {
      const form = ratioForm();
      const runtime = runtimeFor(form, answers, []);
      // What the runtime stores for the calculation is its own result: no answer, never NaN.
      expect(runtime.state().values.ratio).toBe(expected === "standard" ? undefined : 400);
      const submittable = runtime.submittableValues();
      const browser = selectPdfLayoutForValues(form, submittable).layout?.id;
      const submitted = await runtime.submit("submit", envelope);
      expect(submitted.accepted, JSON.stringify(submitted.errors)).toBe(true);
      const values = submitted.canonicalSubmission!.submission.values;
      // The envelope object already is what its JSON says, and what the runtime said it would submit.
      expect(values).toStrictEqual(JSON.parse(JSON.stringify(values)));
      expect({ ...submittable }).toEqual(values);
      const journey = findJourney(form)!;
      const outcome = runKernel({ formId: form.id, values, locale: "en", form: form.root, journey }, []);
      expect(outcome.values).toEqual(values);
      expect(browser).toBe(expected);
      expect(selectPdfLayoutForValues(form, outcome.values!).layout?.id).toBe(expected);
      // A host that hands the kernel the stored answers in-process, the unanswered key and all, is judged the same way.
      const inProcess = runKernel({ formId: form.id, values: { ...runtime.state().values }, locale: "en", form: form.root, journey }, []);
      expect(inProcess.errors).toEqual([]);
      expect(selectPdfLayoutForValues(form, inProcess.values!).layout?.id).toBe(expected);
      expect(selectPdfLayoutForValues(form, runtime.state().values).layout?.id).toBe(expected);
    }
  });

  it("a key no component owns steers no field and no PDF layout, whether the server strips or keeps it", async () => {
    const form = campaignForm();
    const stripped = await compare(form, { name: "Ada", campaign: "spring" });
    // `promo` is not asked for: its rule reads a key the schema does not define.
    expect(stripped.browser).toEqual({ accepted: true, errors: [] });
    expect(stripped.values).toStrictEqual({ name: "Ada" });

    const runtime = runtimeFor(form, { name: "Ada", campaign: "spring" }, []);
    const submittable = runtime.submittableValues();
    // The browser still holds the host's key for a server that keeps unknown fields…
    expect(submittable).toStrictEqual({ name: "Ada", campaign: "spring" });
    expect(runtime.effectiveState("promo")?.visible).toBe(false);
    expect(selectPdfLayoutForValues(form, submittable).layout?.id).toBe("standard");
    // …and that server keeps it, and reaches the same verdict and layout.
    const kept = runKernel({ formId: form.id, values: submittable, locale: "en", form: form.root, unknownFields: "keep" }, []);
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual({ name: "Ada", campaign: "spring" });
    expect(selectPdfLayoutForValues(form, kept.values!).layout?.id).toBe("standard");
    const strip = runKernel({ formId: form.id, values: submittable, locale: "en", form: form.root }, []);
    expect(strip.values).toEqual({ name: "Ada" });
    expect(selectPdfLayoutForValues(form, strip.values!).layout?.id).toBe("standard");
  });

  it("a required calculation that comes to no answer is unanswered on every side: the client pipeline alone, with the sandbox, and the kernel over the envelope", async () => {
    for (const members of [undefined, 0]) {
      const answers: Record<string, unknown> = { income: 1200, ...(members !== undefined ? { members } : {}) };
      const label = `members ${String(members)}`;
      // With the sandbox, and the kernel over what the same answers send: refused alike.
      const sandboxed = await compare(requiredRatioForm(), answers);
      expect(sandboxed.browser, label).toEqual({ accepted: false, errors: ["ratio:required"] });
      expect(sandboxed.values, label).toStrictEqual({ ...answers });

      // The client pipeline alone refuses too, rather than sending what a server then rejects.
      const clientOnly = clientOnlyFor(requiredRatioForm(), answers);
      expect(clientOnly.state().values.ratio, label).toBeUndefined();
      const submitted = await clientOnly.submit("submit", envelope);
      expect({ accepted: submitted.accepted, errors: codes(submitted.errors) }, label).toEqual(sandboxed.browser);
      // …and says so on the page that asks, before the end: Continue stops there.
      const page = await clientOnlyFor(requiredRatioForm(), answers).validate({ page: "money" });
      expect(codes(page), label).toEqual(["ratio:required"]);

      // What the client alone would send, judged by the kernel as a server holding only the envelope.
      const sent = await clientOnlyFor(requiredRatioForm(), answers).submit("send", envelope);
      const onEnvelope = runKernel({ formId: "parity", values: sent.canonicalSubmission!.submission.values, locale: "en", form: requiredRatioForm().root, journey: findJourney(requiredRatioForm())! }, []);
      expect(codes(onEnvelope.errors), label).toEqual(["ratio:required"]);
      // And handed the stored answers in-process, the unanswered key and all.
      const inProcess = runKernel({ formId: "parity", values: { ...clientOnly.state().values }, locale: "en", form: requiredRatioForm().root, journey: findJourney(requiredRatioForm())! }, []);
      expect(codes(inProcess.errors), label).toEqual(["ratio:required"]);
    }
    const known = await compare(requiredRatioForm(), { income: 1200, members: 3 });
    expect(known.browser).toEqual({ accepted: true, errors: [] });
    expect(known.values).toStrictEqual({ income: 1200, members: 3, ratio: 400 });
    const clientKnown = await clientOnlyFor(requiredRatioForm(), { income: 1200, members: 3 }).submit("submit", envelope);
    expect(clientKnown.accepted).toBe(true);
  });

  it("a data grid's cell steers a field, a route and a PDF layout alike on every side, and its rows survive a server that strips unknown fields", async () => {
    const rows = (...entries: Array<Record<string, unknown>>): Steps => (runtime) => {
      for (const entry of entries) {
        runtime.addRow("orders", entry);
      }
    };
    for (const [qty, expected] of [
      [10, { browser: { accepted: false, errors: ["rush:required"] }, layout: "bulk" }],
      [2, { browser: { accepted: false, errors: ["reason:required"] }, layout: "standard" }]
    ] as const) {
      const label = `qty ${qty}`;
      const steps = rows({ qty, sku: "A1" }, { qty: 1, sku: "B2" });
      // Unanswered: the big order asks for `rush` and skips `reason`; a small one the other way round.
      const blocked = await compare(gridForm(), {}, [], steps);
      expect(blocked.browser, label).toEqual(expected.browser);
      const clientBlocked = await clientOnlyFor(gridForm(), {}, steps).submit("submit", envelope);
      expect({ accepted: clientBlocked.accepted, errors: codes(clientBlocked.errors) }, label).toEqual(expected.browser);

      // Answered: accepted on every side, the rows in the envelope and in what the kernel returns.
      const answers = qty > 5 ? { rush: "today" } : { reason: "restock" };
      const accepted = await compare(gridForm(), answers, [], steps);
      expect(accepted.browser, label).toEqual({ accepted: true, errors: [] });
      // The rows travel whole, one list at the collection path; the kernel
      // reads them as the keys it returns.
      expect(accepted.values, label).toStrictEqual({ ...answers, orders: [{ qty, sku: "A1" }, { qty: 1, sku: "B2" }] });
      expect(flattened(gridForm(), accepted.values), label).toStrictEqual({ ...answers, "orders[0].qty": qty, "orders[0].sku": "A1", "orders[1].qty": 1, "orders[1].sku": "B2" });

      const runtime = clientOnlyFor(gridForm(), answers, steps);
      expect(runtime.effectiveState("rush")?.visible, label).toBe(qty > 5);
      const submittable = runtime.submittableValues();
      expect(selectPdfLayoutForValues(gridForm(), submittable).layout?.id, label).toBe(expected.layout);
      const submitted = await runtime.submit("submit", envelope);
      expect(submitted.accepted, label).toBe(true);
      const values = submitted.canonicalSubmission!.submission.values;
      expect(values, label).toStrictEqual(accepted.values);
      const form = gridForm();
      const journey = findJourney(form)!;
      for (const unknownFields of ["strip", "keep", "reject"] as const) {
        const outcome = runKernel({ formId: form.id, values, locale: "en", form: form.root, journey, unknownFields }, []);
        expect(outcome.errors, `${label}, ${unknownFields}`).toEqual([]);
        expect(outcome.values, `${label}, ${unknownFields}`).toEqual(flattened(form, values));
        expect(selectPdfLayoutForValues(form, outcome.values!).layout?.id, `${label}, ${unknownFields}`).toBe(expected.layout);
      }
    }
  });

  it("no journey: a hidden, excluded answer read by another field's visibility", async () => {
    const hidden = await compare(noJourney(), { gate: false, secret: "open" });
    expect(hidden.browser.accepted).toBe(true);
    expect(hidden.values).toEqual({ gate: false });

    const shown = await compare(noJourney(), { gate: true, secret: "open" });
    expect(shown.browser).toEqual({ accepted: false, errors: ["echo:required"] });
  });
});

describe("Required when parity: the client pipeline alone, the runtime with its sandbox, and the kernel over the envelope and the stored answers", () => {
  /** Every side's verdict for one set of answers: the sandboxed runtime against the kernel, the client alone, the kernel over the stored answers. */
  async function everySide(answers: Record<string, unknown>, expected: Verdict, label: string): Promise<Record<string, unknown>> {
    const sandboxed = await compare(requiredWhenForm(), answers);
    expect(sandboxed.browser, `${label}: runtime with sandbox`).toEqual(expected);

    const clientOnly = clientOnlyFor(requiredWhenForm(), answers);
    const submitted = await clientOnly.submit("submit", envelope);
    expect({ accepted: submitted.accepted, errors: codes(submitted.errors) }, `${label}: client alone`).toEqual(expected);

    const journey = findJourney(requiredWhenForm())!;
    const stored = runKernel({ formId: "parity", values: { ...clientOnly.state().values }, locale: "en", form: requiredWhenForm().root, journey }, []);
    expect(codes(stored.errors), `${label}: kernel over the stored answers`).toEqual(expected.errors);
    expect(stored.values !== undefined, `${label}: kernel over the stored answers`).toBe(expected.accepted);
    return sandboxed.values;
  }

  it("holds phone to its rule: refused while empty and the rule holds, accepted once filled or once the rule stops", async () => {
    const values = await everySide({ ...REACHABLE, contact: "phone" }, { accepted: false, errors: ["phone:required"] }, "rule true, empty");
    expect(values).toStrictEqual({ contact: "phone", both: "yes" });
    // The page that asks says so before the end: Continue stops there, on the page's own errors alone.
    expect(codes(await clientOnlyFor(requiredWhenForm(), { contact: "phone" }).validate({ page: "how" }))).toEqual(["phone:required"]);
    expect(codes(await clientOnlyFor(requiredWhenForm(), { ...REACHABLE, contact: "phone" }).validate({ page: "finish" }))).toEqual([]);

    const filled = await everySide({ ...REACHABLE, contact: "phone", phone: "555 0100" }, { accepted: true, errors: [] }, "rule true, filled");
    expect(filled).toStrictEqual({ contact: "phone", phone: "555 0100", both: "yes" });
    await everySide(REACHABLE, { accepted: true, errors: [] }, "rule false");
  });

  it("keeps the tick when the rule is false: Required OR Required when, on every side", async () => {
    await everySide({ contact: "email" }, { accepted: false, errors: ["both:required"] }, "ticked, rule false");
    const clientOnly = clientOnlyFor(requiredWhenForm(), { contact: "email" });
    expect(clientOnly.isRequired("both")).toBe(true);
    expect(clientOnly.isRequired("phone")).toBe(false);
  });

  it("reads a hidden, excluded answer as absent: the rule that reads it does not hold, anywhere", async () => {
    const hidden = await everySide({ ...REACHABLE, gate: false, secret: "open" }, { accepted: true, errors: [] }, "excluded answer");
    expect(hidden).toStrictEqual({ contact: "email", gate: false, both: "yes" });
    await everySide({ ...REACHABLE, gate: true, secret: "open" }, { accepted: false, errors: ["echo:required"] }, "shown answer");
  });

  it("reads an answer on a skipped page as absent: the rule that reads it does not hold, anywhere", async () => {
    const skipped = await everySide({ ...REACHABLE, branch: "y", detail: "yes" }, { accepted: true, errors: [] }, "skipped page");
    expect(skipped).toStrictEqual({ contact: "email", branch: "y", both: "yes" });
    await everySide({ ...REACHABLE, branch: "x", detail: "yes" }, { accepted: false, errors: ["extra:required"] }, "taken page");
  });

  it("holds a keyed field in a data-scoping container to its rule, by its id", async () => {
    await everySide({ ...REACHABLE, contact: "post" }, { accepted: false, errors: ["postcode:required"] }, "keyed, empty");
    const filled = await everySide({ ...REACHABLE, contact: "post", "billing.code": "K1A 0B1" }, { accepted: true, errors: [] }, "keyed, filled");
    expect(filled).toStrictEqual({ contact: "post", "billing.code": "K1A 0B1", both: "yes" });
  });

  it("reads a calculation that comes to no answer as the missing answer a server reads: the rule does not hold, anywhere", async () => {
    for (const members of [undefined, 0]) {
      const answers: Record<string, unknown> = { ...REACHABLE, income: 1200, ...(members !== undefined ? { members } : {}) };
      const values = await everySide(answers, { accepted: true, errors: [] }, `members ${String(members)}`);
      expect(values).toStrictEqual({ ...answers });
    }
    const known = await everySide({ ...REACHABLE, income: 1200, members: 3 }, { accepted: false, errors: ["per_head:required"] }, "ratio known");
    expect(known).toStrictEqual({ contact: "email", both: "yes", income: 1200, members: 3, ratio: 400 });
  });

  it("a rule reading host.: the browser with a host context refuses, the server accepts (the lenient direction)", async () => {
    const hosted = (): FormRuntime => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
      const runtime = new FormRuntime(requiredWhenForm(), {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(requiredWhenForm().root)]),
        wasmValidationHost: createInProcessWasmValidationHost([]),
        hostContext: { role: "staff" }
      });
      for (const [key, value] of Object.entries(REACHABLE)) {
        runtime.setValue(key, value);
      }
      return runtime;
    };
    const browser = hosted();
    expect(browser.isRequired("staff_note")).toBe(true);
    const refused = await browser.submit("submit", envelope);
    expect({ accepted: refused.accepted, errors: codes(refused.errors) }).toEqual({ accepted: false, errors: ["staff_note:required"] });

    // What the browser would send, judged by a server that has no host context: accepted.
    const sent = await hosted().submit("send", envelope);
    const values = sent.canonicalSubmission!.submission.values;
    const journey = findJourney(requiredWhenForm())!;
    const server = runKernel({ formId: "parity", values, locale: "en", form: requiredWhenForm().root, journey, externalData: { role: "staff" } }, []);
    expect(server.errors).toEqual([]);
    expect(server.values).toEqual(values);

    // Without a host context the browser does not hold the field to it either: the rule is false.
    expect(clientOnlyFor(requiredWhenForm(), REACHABLE).isRequired("staff_note")).toBe(false);
    await everySide(REACHABLE, { accepted: true, errors: [] }, "no host context");
  });
});

describe("Form rules always hold: a field a journey leaves off every page is judged as the whole form judges it, on every side", () => {
  /** Every side's verdict for one set of answers: the sandboxed runtime against the kernel over its envelope, the client alone, the kernel over the stored answers. */
  async function everySide(answers: Record<string, unknown>, expected: Verdict, label: string): Promise<Record<string, unknown>> {
    const sandboxed = await compare(leftOut(), answers);
    expect(sandboxed.browser, `${label}: runtime with sandbox`).toEqual(expected);

    const clientOnly = clientOnlyFor(leftOut(), answers);
    const submitted = await clientOnly.submit("submit", envelope);
    expect({ accepted: submitted.accepted, errors: codes(submitted.errors) }, `${label}: client alone`).toEqual(expected);

    const journey = findJourney(leftOut())!;
    const stored = runKernel({ formId: "parity", values: { ...clientOnly.state().values }, locale: "en", form: leftOut().root, journey }, []);
    expect(codes(stored.errors), `${label}: kernel over the stored answers`).toEqual(expected.errors);
    expect(stored.values !== undefined, `${label}: kernel over the stored answers`).toBe(expected.accepted);
    return sandboxed.values;
  }

  /** A browser the host tells it is staff (or `role`), with the in-process kernel as its sandbox or none, on the journey or the whole form. */
  function hostedFor(answers: Record<string, unknown>, sandboxed: boolean, wholeForm = false, role = "staff"): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
    const runtime = new FormRuntime(leftOut(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(leftOut().root)]),
      ...(sandboxed ? { wasmValidationHost: createInProcessWasmValidationHost([]) } : {}),
      ...(wholeForm ? { journey: "form" } : {}),
      hostContext: { role }
    });
    for (const [key, value] of Object.entries(answers)) {
      runtime.setValue(key, value);
    }
    return runtime;
  }

  it("refuses an empty required field on no page, and a hidden one that opts in, and accepts them filled", async () => {
    await everySide({ resident: "no" }, { accepted: false, errors: ["opt_in:required", "ref:required"] }, "empty");
    const values = await everySide(LEFT_OUT_FILLED, { accepted: true, errors: [] }, "filled");
    expect(values).toStrictEqual(LEFT_OUT_SENT);
    // The page's own check says nothing about them: they are on no page. The end does.
    expect(codes(await clientOnlyFor(leftOut(), { resident: "no" }).validate({ page: "start" }))).toEqual([]);
    expect(codes(await clientOnlyFor(leftOut(), { resident: "no" }).validate())).toEqual(["opt_in:required", "ref:required"]);
    // The browser marks them required, as on the whole form.
    const runtime = clientOnlyFor(leftOut(), { resident: "no" });
    expect(runtime.isRequired("ref")).toBe(true);
    expect(runtime.effectiveState("ref")).toMatchObject({ visible: true, requiredApplies: true, runValidation: true });
    expect(runtime.effectiveState("opt_in")).toMatchObject({ visible: false, requiredApplies: true, runValidation: true });
  });

  it("hides a field on no page by its own rule: not required, its answer by its own behaviour", async () => {
    const values = await everySide({ ...LEFT_OUT_FILLED, secret: "x" }, { accepted: true, errors: [] }, "self-hidden");
    expect(values).toStrictEqual(LEFT_OUT_SENT);
  });

  it("keeps the lenient fold on every side for a field on no page whose visibility reads host., its own rule's or its fieldset's: no host context makes any side ask for it", async () => {
    const bare = { resident: "no", ref: "R-1", opt_in: "O-1" };
    // The server cannot replay the host: on no page, `staff_ref` and, through its fieldset,
    // `nested_ref` keep the earlier fold on both sides — hidden, unchecked, not
    // required, their answers kept — so every side accepts them empty and filled alike.
    const empty = await everySide(bare, { accepted: true, errors: [] }, "no host context, empty");
    expect(empty).toStrictEqual({ ...bare });
    const plain = await everySide(LEFT_OUT_FILLED, { accepted: true, errors: [] }, "no host context, filled");
    expect(plain).toStrictEqual(LEFT_OUT_SENT);

    // The browser's whole form follows the host: shown and required for staff…
    for (const sandboxed of [true, false]) {
      const whole = hostedFor(bare, sandboxed, true);
      expect(whole.journeyView(), String(sandboxed)).toBeUndefined();
      expect(whole.effectiveState("staff_ref"), String(sandboxed)).toMatchObject({ visible: true, requiredApplies: true });
      expect(whole.effectiveState("nested_ref"), String(sandboxed)).toMatchObject({ visible: true, requiredApplies: true });
      const refused = await whole.submit("submit", envelope);
      expect(codes(refused.errors), String(sandboxed)).toEqual(["extra:required", "nested_ref:required", "staff_ref:required"]);
    }
    // …hidden, not required, for the public…
    const lax = hostedFor(bare, false, true, "public");
    expect(lax.effectiveState("staff_ref")).toMatchObject({ visible: false, requiredApplies: false });
    expect(codes((await lax.submit("submit", envelope)).errors)).toEqual(["extra:required"]);
    // …and not required on a server, which cannot replay the rule: the kernel
    // reads a visibility the server cannot evaluate as hidden for requiredness, so the
    // whole form on a server is as lax as the journey for the host-bound fields. `extra` has no host rule and stays required.
    expect(codes(runKernel({ formId: "parity", values: bare, locale: "en", form: leftOut().root }, []).errors)).toEqual(["extra:required"]);

    // On the journey, whatever the host says and with or without a sandbox, the browser hides
    // them and does not ask, and a server over its envelope agrees.
    for (const role of ["staff", "public"]) {
      for (const sandboxed of [true, false]) {
        const label = `${role}, ${sandboxed ? "runtime with sandbox" : "client alone"}`;
        const runtime = hostedFor(bare, sandboxed, false, role);
        expect(runtime.effectiveState("staff_ref"), label).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
        expect(runtime.effectiveState("nested_ref"), label).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
        // The tick itself stands (`isRequired` reads it before the hidden-required policy); the policy withholds it.
        expect(runtime.isRequired("staff_ref"), label).toBe(true);
        const accepted = await runtime.submit("submit", envelope);
        expect({ accepted: accepted.accepted, errors: codes(accepted.errors) }, label).toEqual({ accepted: true, errors: [] });
        expect(accepted.canonicalSubmission!.submission.values, label).toStrictEqual({ ...bare });

        const given = hostedFor(LEFT_OUT_FILLED, sandboxed, false, role);
        const sent = await given.submit("submit", envelope);
        expect({ accepted: sent.accepted, errors: codes(sent.errors) }, label).toEqual({ accepted: true, errors: [] });
        const values = sent.canonicalSubmission!.submission.values;
        expect(values, label).toStrictEqual(LEFT_OUT_SENT);
        for (const answers of [values, accepted.canonicalSubmission!.submission.values]) {
          const server = runKernel({ formId: "parity", values: answers, locale: "en", form: leftOut().root, journey: findJourney(leftOut())!, externalData: { role } }, []);
          expect(server.errors, label).toEqual([]);
          expect(server.values, label).toEqual(answers);
        }
      }
    }
  });

  it("agrees on a required field on no page beside a listed one inside a host-shown fieldset: the browser, told any host context or none, with a sandbox or without, and the server over its envelope all accept", async () => {
    // The re-check's case: `hbox` is structural (it holds `listed`, on the page) and shown by
    // the host; `sibling` beside it is required and on no page. Every side reads
    // `sibling` the lenient way, through its fieldset's rule, so they agree: a server that cannot
    // evaluate the rule would otherwise keep the box shown and refuse where the browser accepts.
    const staff = eq("host.role", "staff");
    const boxed = formOf(
      [field("name", { required: true }), { ...group("hbox", "fieldset", [field("listed"), field("sibling", { required: true })]), rules: { visibleWhen: staff } }],
      { id: "short", pages: [{ id: "start", components: ["name", "listed"] }] }
    );
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    for (const hostContext of [undefined, { role: "public" }, { role: "staff" }]) {
      for (const sandboxed of [false, true]) {
        const label = `${JSON.stringify(hostContext)}, ${sandboxed ? "runtime with sandbox" : "client alone"}`;
        const runtime = new FormRuntime(boxed, {
          submissionModes: modes,
          validationPipeline: new ValidationPipeline([createFieldConstraintsStage(boxed.root)]),
          ...(sandboxed ? { wasmValidationHost: createInProcessWasmValidationHost([]) } : {}),
          ...(hostContext ? { hostContext } : {})
        });
        runtime.setValue("name", "N");
        expect(runtime.effectiveState("hbox")?.visible, label).toBe(hostContext?.role === "staff");
        expect(runtime.effectiveState("sibling"), label).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: true });
        expect(runtime.isRequired("sibling"), label).toBe(true);
        const result = await runtime.submit("submit", envelope);
        expect({ accepted: result.accepted, errors: codes(result.errors) }, label).toEqual({ accepted: true, errors: [] });
        const values = result.canonicalSubmission!.submission.values;
        expect(values, label).toStrictEqual({ name: "N" });
        for (const externalData of [undefined, { role: "public" }, { role: "staff" }]) {
          const server = runKernel({ formId: "parity", values, locale: "en", form: boxed.root, journey: findJourney(boxed)!, ...(externalData ? { externalData } : {}) }, []);
          expect(server.errors, `${label} -> ${JSON.stringify(externalData)}`).toEqual([]);
          expect(server.values, `${label} -> ${JSON.stringify(externalData)}`).toEqual(values);
        }
      }
    }
    // The whole form, on a server: not required either.
    expect(codes(runKernel({ formId: "parity", values: { name: "N" }, locale: "en", form: boxed.root }, []).errors)).toEqual([]);
  });

  it("reads no Required-when rule reading host. on a field on no page: the browser, told it is staff, with a sandbox or without, and the server over its envelope all accept — while the same rule on a page, and on the whole form, still holds in the browser", async () => {
    const staff = eq("host.role", "staff");
    const hostRuled = (): FormDefinition =>
      formOf(
        [field("resident", { required: true, options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "on", label: "on" }] }, { type: "select" }), field("ruled", {}, { rules: { requiredWhen: staff } }), field("listed", {}, { rules: { requiredWhen: staff } })],
        { id: "short", pages: [{ id: "start", components: ["resident", "listed"] }] }
      );
    const hostedRuntime = (answers: Record<string, unknown>, sandboxed: boolean, wholeForm: boolean): FormRuntime => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
      const runtime = new FormRuntime(hostRuled(), {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(hostRuled().root)]),
        ...(sandboxed ? { wasmValidationHost: createInProcessWasmValidationHost([]) } : {}),
        ...(wholeForm ? { journey: "form" } : {}),
        hostContext: { role: "staff" }
      });
      for (const [key, value] of Object.entries(answers)) {
        runtime.setValue(key, value);
      }
      return runtime;
    };
    const journey = findJourney(hostRuled())!;
    for (const sandboxed of [true, false]) {
      const label = sandboxed ? "runtime with sandbox" : "client alone";
      // `ruled` is on no page: the rule reading host. is read by neither side, so the
      // browser does not hold the person to a field it cannot show. `listed`, on the page, keeps
      // the lenient reading applies: the browser follows the host and asks for it.
      const runtime = hostedRuntime({ resident: "no" }, sandboxed, false);
      expect(runtime.isRequired("ruled"), label).toBe(false);
      expect(runtime.isRequired("listed"), label).toBe(true);
      const refused = await runtime.submit("submit", envelope);
      expect({ accepted: refused.accepted, errors: codes(refused.errors) }, label).toEqual({ accepted: false, errors: ["listed:required"] });
      const accepted = await hostedRuntime({ resident: "no", listed: "L-1" }, sandboxed, false).submit("submit", envelope);
      expect({ accepted: accepted.accepted, errors: codes(accepted.errors) }, label).toEqual({ accepted: true, errors: [] });
      const values = accepted.canonicalSubmission!.submission.values;
      expect(values, label).toStrictEqual({ resident: "no", listed: "L-1" });
      // The server over the envelope, given the host or not: the same.
      for (const externalData of [undefined, { role: "staff" }]) {
        const server = runKernel({ formId: "parity", values, locale: "en", form: hostRuled().root, journey, ...(externalData ? { externalData } : {}) }, []);
        expect(server.errors, label).toEqual([]);
        expect(server.values, label).toEqual(values);
      }
      // The whole form: the browser holds staff to both, the server to neither.
      const whole = hostedRuntime({ resident: "no" }, sandboxed, true);
      expect(whole.isRequired("ruled"), label).toBe(true);
      expect(codes((await whole.submit("submit", envelope)).errors), label).toEqual(["listed:required", "ruled:required"]);
    }
    expect(runKernel({ formId: "parity", values: { resident: "no" }, locale: "en", form: hostRuled().root, externalData: { role: "staff" } }, []).errors).toEqual([]);
  });

  it("still works a calculation on no page out and submits it", async () => {
    const values = await everySide({ ...LEFT_OUT_FILLED, cost: 5 }, { accepted: true, errors: [] }, "calculated");
    expect(values).toStrictEqual({ ...LEFT_OUT_FILLED, cost: 5, total: 10 });
  });

  it("keeps an answer given for a field on no page and checks it, rather than dropping it", async () => {
    await everySide({ ...LEFT_OUT_FILLED, code: "abc" }, { accepted: false, errors: ["code:pattern"] }, "bad shape");
    const values = await everySide({ ...LEFT_OUT_FILLED, code: "ABC" }, { accepted: true, errors: [] }, "good shape");
    expect(values).toStrictEqual({ ...LEFT_OUT_SENT, code: "ABC" });
  });

  it("leaves a field on a skipped page as it was: withheld and not required", async () => {
    const values = await everySide({ ...LEFT_OUT_FILLED, extra: "stale" }, { accepted: true, errors: [] }, "skipped page");
    expect(values).toStrictEqual(LEFT_OUT_SENT);
    await everySide({ ...LEFT_OUT_FILLED, resident: "yes" }, { accepted: false, errors: ["extra:required"] }, "taken page");
  });

  it("gives a journey that places every field the whole form's fold: one page listing everything is the whole form", () => {
    const form = requiredWhenForm();
    const everything: Journey = { id: "all", pages: [{ id: "one", components: (form.root.children?.content ?? []).map((node) => node.id) }] };
    for (const values of [REACHABLE, { ...REACHABLE, contact: "phone" }, { ...REACHABLE, gate: true, secret: "open", branch: "x", detail: "yes", income: 1200, members: 3 }, {}]) {
      const label = JSON.stringify(values);
      const whole = kernelFoldSubmission(form.root, values, undefined);
      const one = kernelFoldSubmission(form.root, values, everything);
      expect({ ...one.effective }, label).toEqual({ ...whole.effective });
      expect({ ...one.submittable }, label).toEqual({ ...whole.submittable });
      expect({ ...one.required }, label).toEqual({ ...whole.required });
      expect(one.requiredByRule, label).toEqual(whole.requiredByRule);
      expect(Object.values({ ...one.placements }).every((placement) => placement === "on"), label).toBe(true);
    }
  });
});

/** The fixture's journey with its pages changed by id. */
function applyJourneyWith(changes: Record<string, Record<string, unknown>>): Journey {
  const journey = applyJourney();
  return { ...journey, pages: journey.pages.map((page) => ({ ...page, ...(changes[page.id] ?? {}) })) };
}

/**
 * Pairs: a journey holding a node that breaks a usability rule, and the journey
 * that says the same without it. Every side must judge the two alike — the kernel, and the
 * browser runtime, which reads the ownership's verdict rather than deciding again.
 */
function usabilityPairs(): Array<[string, Journey, Journey]> {
  const details = (...entries: JourneyPageEntry[]): Journey => applyJourneyWith({ details: { components: [workEmailAlias(), ...entries] } });
  const layout = (...children: NonNullable<PresentationNode["children"]>[string]): PresentationNode => ({ id: "box", type: "fieldset", children: { content: children } });
  const reference = (componentId: string) => ({ type: "journey-field" as const, configuration: { componentId } });
  /** The fixture's `income` page without its worked-out value: the three own fields alone. */
  const withoutWorkedOut = applyJourney().pages[1]!.components!.filter((entry) => typeof entry === "string" || entry.type !== "journey-value");
  /** Each pair: a journey holding a broken node, and the journey that says the same without it. */
  const pairs: Array<[string, Journey, Journey]> = [
    ["A: an own id that is a form component's", details({ id: "name", type: "text", configuration: { fills: "approved_amount" } }), details()],
    ["A: an own id repeated", details({ id: "work_email", type: "text", configuration: { fills: "name" } }), details()],
    ["B: a file inside an own layout", details(layout(reference("name"), { id: "upload", type: "file" })), details()],
    ["C: a data key on an own field", details({ id: "keyed", type: "text", configuration: { dataKey: "email", fills: "name" } }), details()],
    ["D: a reference to no component", details(layout(reference("ghost"), reference("name"))), details(layout(reference("name")))],
    ["E: an alias of a fieldset", details({ id: "to_money", type: "text", configuration: { fills: "money" } }), details({ id: "to_money", type: "text" })],
    ["F: a paragraph that fills", details({ id: "note", type: "html", configuration: { fills: "name" } }), details({ id: "note", type: "html" })],
    // The first worked-out value for a field takes it: `early_total`, on `details`, so the fixture's own node on `income` is the one ignored.
    ["G: a second worked-out value for the field", details({ ...incomeTotal(), id: "early_total" }), { ...details({ ...incomeTotal(), id: "early_total" }), pages: details({ ...incomeTotal(), id: "early_total" }).pages.map((page) => (page.id === "income" ? { ...page, components: withoutWorkedOut } : page)) }],
    ["G: a worked-out value whose target is also listed", applyJourneyWith({ assist: { components: ["approved_amount", "annual_income"] } }), applyJourneyWith({ assist: { components: ["approved_amount", "annual_income"] }, income: { components: withoutWorkedOut } })]
  ];
  return pairs;
}

/**
 * Presentations at the kernel: the fixture of `fixtures/presentation-form.ts`, each
 * case judged three ways that must agree — the kernel over the envelope an honest browser sends
 * (form values only), over that context once it has crossed the ABI as JSON, and over the
 * answers as the browser stores them (own answers under `@apply.…`, leftovers of pages the
 * path skips). The browser's own sides — the runtime alone, with its sandbox — join these cases
 * with the runtime for own nodes.
 */
describe("presentations parity at the kernel: a journey that asks the form through its own nodes", () => {
  const abi = new JsonWasmAbi();
  /** What the browser stores beside the form's values: the own fields' answers, never sent. */
  const OWN = { "@apply.m1": 12000, "@apply.m2": 12000, "@apply.m3": 12000 };

  function threeWays(
    form: ComponentNode,
    journey: Journey,
    envelope: Record<string, unknown>,
    stored: Record<string, unknown> = { ...envelope, ...OWN },
    validators: readonly WasmValidator[] = []
  ): KernelOutcome {
    const kernelValidators = validators.map((validator): KernelValidator => (context) => validator.validate(context));
    const label = `${journey.id}: ${JSON.stringify(envelope)}`;
    const context = { formId: "presentation", values: envelope, locale: "en", form, journey };
    const direct = runKernel(context, kernelValidators);
    // Over its JSON round trip: the context as the ABI serializes it, judged behind the boundary.
    const instance = new InProcessWasmHostAdapter().instantiate([{ id: "plugins", version: "1", validators: [...validators] }], abi);
    const crossed = abi.deserializeOutcome(instance.run(abi.serializeContext(context, WasmValidationHost.STRICT_POLICY)) as string);
    expect(crossed, label).toEqual(JSON.parse(JSON.stringify(direct)));
    // Over the answers as stored: the same verdict, the same values, the same things taken on trust.
    const raw = runKernel({ ...context, values: stored }, kernelValidators);
    expect(codes(raw.errors), label).toEqual(codes(direct.errors));
    expect(raw.values, label).toEqual(direct.values);
    expect(raw.clientDerived, label).toEqual(direct.clientDerived);
    // What comes back is a fixpoint: judged again, it is judged the same.
    if (direct.values !== undefined) {
      expect(runKernel({ ...context, values: direct.values }, kernelValidators).values, label).toEqual(direct.values);
      expect(kernelFoldSubmission(form, direct.values, journey).submittable, label).toEqual(direct.values);
    }
    return direct;
  }

  const form = presentationRoot();
  /** The fixture's journey with its pages changed by id. */
  function applyWith(changes: Record<string, Record<string, unknown>>): Journey {
    const journey = applyJourney();
    return { ...journey, pages: journey.pages.map((page) => ({ ...page, ...(changes[page.id] ?? {}) })) };
  }
  /** The fixture's form with a node changed by id. */
  function formWith(id: string, change: Partial<ComponentNode>): ComponentNode {
    const root = presentationRoot();
    Object.assign(nodeOf(root, id) as ComponentNode, change);
    return root;
  }

  it("an alias: its field empty is the form's required, on the form field; answered, it is accepted", () => {
    const empty = threeWays(form, applyJourney(), { annual_income: 36000 });
    expect(empty.errors).toEqual([{ code: "required", componentId: "email", path: "email", stage: "field-constraints", source: "wasm" }]);
    expect(empty.values).toBeUndefined();
    const answered = threeWays(form, applyJourney(), APPLY_BELOW);
    expect(answered.errors).toEqual([]);
    expect(answered.values).toEqual(APPLY_BELOW);
    // The alias's own Required is the browser's to hold: with the form field optional, the
    // server asks for nothing — it never reads an own node's configuration or rules.
    const optional = formWith("email", { configuration: { label: "Email" } });
    expect(threeWays(optional, applyJourney(), { annual_income: 36000 }).errors).toEqual([]);
  });

  it("a worked-out value: the path turns on it alike, the form's rules hold it, and it is listed as client-derived", () => {
    const below = threeWays(form, applyJourney(), APPLY_BELOW);
    expect(below.errors).toEqual([]);
    expect(below.clientDerived).toEqual(["annual_income"]);
    expect(kernelFoldSubmission(form, APPLY_BELOW, applyJourney()).trace).toEqual({
      pages: ["details", "income"],
      end: "end",
      decisions: [
        { kind: "next", pageId: "details", to: "income" },
        { kind: "route", pageId: "income", routeIndex: 1, to: "$end" }
      ]
    });
    const above = threeWays(form, applyJourney(), APPLY_ABOVE);
    expect(above.values).toEqual(APPLY_ABOVE);
    expect(above.clientDerived).toEqual(["annual_income"]);
    expect(kernelFoldSubmission(form, APPLY_ABOVE, applyJourney()).trace?.pages).toEqual(["details", "income", "assist"]);
    // Exactly on the threshold the route is taken; an answer left on `assist` below it is withheld.
    expect(kernelFoldSubmission(form, { email: "a@b.co", annual_income: 50000 }, applyJourney()).trace?.pages).toEqual(["details", "income", "assist"]);
    const stale = threeWays(form, applyJourney(), APPLY_BELOW, { ...APPLY_BELOW, ...OWN, approved_amount: 500 });
    expect(stale.values).toEqual(APPLY_BELOW);
    // Held to the form's own rule like a typed answer: the ceiling refuses it on the target.
    // The ceiling is the field's own declared `max`, which the kernel and the browser stage enforce
    // (`number.max`), with no plugin validator needed.
    const over = threeWays(form, applyJourney(), { email: "a@b.co", annual_income: 1000001 });
    expect(codes(over.errors)).toEqual(["annual_income:number.max"]);
    expect(over.clientDerived).toEqual(["annual_income"]);
    expect(threeWays(form, applyJourney(), APPLY_ABOVE).errors).toEqual([]);
  });

  it("the worked-out value's page skipped: its target is withheld and not required", () => {
    const journey = applyWith({ details: { routes: [{ when: neq("name", "ask"), to: "assist" }] } });
    // `name` is on no page, so the route reads it from the start; anything else routes past `income`.
    const skipped = threeWays(form, journey, { email: "a@b.co", name: "skip" }, { email: "a@b.co", name: "skip", annual_income: 36000, ...OWN });
    expect(skipped.errors).toEqual([]);
    expect(skipped.values).toEqual({ email: "a@b.co", name: "skip" });
    expect(skipped.clientDerived).toBeUndefined();
    const fold = kernelFoldSubmission(form, { email: "a@b.co", name: "skip", annual_income: 36000 }, journey);
    expect(fold.trace?.pages).toEqual(["details", "assist"]);
    expect(fold.placements).toMatchObject({ annual_income: "off", approved_amount: "on", email: "on" });
    expect(fold.effective.annual_income).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: false });
    // Taken, the page asks for it again.
    expect(codes(threeWays(form, journey, { email: "a@b.co", name: "ask" }).errors)).toEqual(["annual_income:required"]);
  });

  it("no page is passed over: an alias-only page whose target is hidden, a page of own fields and a layout of references to hidden fields are all on the path", () => {
    // (a) `details` holds only the alias; its target hides itself unless the name says to show it.
    const hiding = formWith("email", { rules: { visibleWhen: eq("name", "show") } });
    const hidden = threeWays(hiding, applyJourney(), { name: "hide", annual_income: 36000 });
    expect(hidden.errors).toEqual([]);
    expect(kernelFoldSubmission(hiding, { name: "hide", annual_income: 36000 }, applyJourney()).trace).toMatchObject({
      pages: ["details", "income"],
      decisions: [{ kind: "next", pageId: "details", to: "income" }, { kind: "route", pageId: "income", routeIndex: 1, to: "$end" }]
    });
    expect(codes(threeWays(hiding, applyJourney(), { name: "show", annual_income: 36000 }).errors)).toEqual(["email:required"]);

    // (b) `income` with nothing but the own fields: on the path whatever the form hides — and the
    // income nothing fills is judged as the whole form judges it.
    const ownOnly = applyWith({ income: { components: applyJourney().pages[1]!.components!.filter((entry) => typeof entry !== "string" && entry.type !== "journey-value"), routes: [] } });
    const everythingHidden = formWith("money", { rules: { visibleWhen: literal(false) } });
    const onPath = kernelFoldSubmission(everythingHidden, { email: "a@b.co" }, ownOnly);
    expect(onPath.trace?.pages).toEqual(["details", "income", "assist"]);
    expect(onPath.placements).toMatchObject({ annual_income: "unassigned", money: "unassigned" });
    expect(threeWays(everythingHidden, ownOnly, { email: "a@b.co" }).errors).toEqual([]);
    expect(codes(threeWays(form, ownOnly, { email: "a@b.co" }).errors)).toEqual(["annual_income:required"]);

    // (c) the variant's layout alone, its two references hidden: nothing shows, the page is on the path all the same.
    const never = { rules: { visibleWhen: literal(false) } };
    const bothHidden = presentationRoot();
    Object.assign(nodeOf(bothHidden, "email") as ComponentNode, never);
    Object.assign(nodeOf(bothHidden, "name") as ComponentNode, never);
    const layoutOnly: Journey = { id: "public", pages: [{ id: "all", components: [publicVariant().pages[0]!.components![0] as JourneyPageEntry] }] };
    const empty = kernelFoldSubmission(bothHidden, { annual_income: 5 }, layoutOnly);
    expect(empty.trace).toEqual({ pages: ["all"], end: "end", decisions: [{ kind: "next", pageId: "all", to: "$end" }] });
    expect(threeWays(bothHidden, layoutOnly, { annual_income: 5 }, { annual_income: 5 }).errors).toEqual([]);
    expect(kernelFoldSubmission(bothHidden, { annual_income: 5 }, publicVariant()).trace?.pages).toEqual(["all"]);
  });

  it("the target inside the section no page lists is visible and required: the section is never folded", () => {
    const fold = kernelFoldSubmission(form, { email: "a@b.co" }, applyJourney());
    expect(fold.ownership?.structural.money).toBe(true);
    expect(fold.placements?.money).toBeUndefined();
    expect(fold.effective.money).toMatchObject({ visible: true });
    expect(fold.effective.annual_income).toMatchObject({ visible: true, requiredApplies: true, runValidation: true, submitValue: true });
    expect(fold.required.annual_income).toBe(true);
    expect(codes(threeWays(form, applyJourney(), { email: "a@b.co" }).errors)).toEqual(["annual_income:required"]);
    // The section keeps its own state, as on the whole form: hidden by its own rule, its field is not asked.
    const sectionHidden = formWith("money", { rules: { visibleWhen: literal(false) } });
    expect(threeWays(sectionHidden, applyJourney(), { email: "a@b.co" }).errors).toEqual([]);
    // Through the variant the section is on no page and holds nothing placed: the whole form's fold, required alike.
    expect(codes(threeWays(form, publicVariant(), { email: "a@b.co", name: "Ada" }, { email: "a@b.co", name: "Ada" }).errors)).toEqual(["annual_income:required"]);
  });

  it("a key an own answer lives under in the browser is unknown to the kernel: stripped, rejected or kept, never read", () => {
    const forged = { ...APPLY_BELOW, ...OWN, "@public.note": "x" };
    const run = (unknownFields: "strip" | "keep" | "reject") => runKernel({ formId: "presentation", values: forged, locale: "en", form, journey: applyJourney(), unknownFields }, []);
    expect(run("strip").values).toEqual(APPLY_BELOW);
    expect(run("keep").values).toEqual(forged);
    expect(run("reject").errors).toEqual(
      ["@apply.m1", "@apply.m2", "@apply.m3", "@public.note"].map((field) => ({ code: "unknown_field", stage: "sanitization", source: "wasm", parameters: { field } }))
    );
    // An honest envelope holds none, so it passes every mode alike.
    for (const unknownFields of ["strip", "keep", "reject"] as const) {
      const outcome = runKernel({ formId: "presentation", values: APPLY_ABOVE, locale: "en", form, journey: applyJourney(), unknownFields }, []);
      expect(outcome.errors, unknownFields).toEqual([]);
      expect(outcome.values, unknownFields).toEqual(APPLY_ABOVE);
    }
    // A form calculation that reads one (the kernel half): unanswered here, so its result is kept as sent and listed.
    const reading = presentationRoot();
    reading.children!.content!.push({ id: "first_month", type: "number", configuration: {}, rules: { value: { kind: "call", name: "sum", args: [path("@apply.m1")] } } });
    const calculated = runKernel({ formId: "presentation", values: { ...APPLY_BELOW, first_month: 0 }, locale: "en", form: reading, journey: applyJourney() }, []);
    expect(calculated.values).toEqual({ ...APPLY_BELOW, first_month: 0 });
    expect(calculated.clientDerived).toEqual(["annual_income", "first_month"]);
  });

  it("a node that breaks a usability rule is ignored: the kernel judges as if it were not there", () => {
    const pairs = usabilityPairs();
    const answers: Array<Record<string, unknown>> = [{}, APPLY_BELOW, APPLY_ABOVE, { email: "a@b.co", name: "Ada", annual_income: 60000 }, { name: "Ada", approved_amount: 3 }];
    for (const [label, broken, without] of pairs) {
      expect(validateJourneyShape(broken), label).toEqual([]);
      for (const values of answers) {
        for (const page of ["details", "income", "assist"]) {
          const judged = runKernel({ formId: "presentation", values, locale: "en", form, journey: broken, page, logLevel: "debug" }, []);
          const expected = runKernel({ formId: "presentation", values, locale: "en", form, journey: without, page, logLevel: "debug" }, []);
          expect(judged, `${label}, ${page}: ${JSON.stringify(values)}`).toEqual(expected);
          // Ignored, never refused: a reference problem is not a malformed journey.
          expect(codes(judged.errors), label).not.toContain("-:journey.invalid");
        }
      }
    }
    // Where the first worked-out value wins, the field is asked on its page: `details`.
    const early = kernelFoldSubmission(form, APPLY_BELOW, pairs[7]![1]);
    expect({ ...early.ownership?.workedOutOf }).toEqual({ early_total: "annual_income" });
    expect(early.ownership?.pagesOf.annual_income).toEqual(["details"]);
    expect(early.ownership?.membersOf.income).toEqual(["m1", "m2", "m3"]);
  });

  it("an own entry of a journey whose id is outside the grammar, or whose answer would live at a key the form defines, is ignored as if it were not there; both shape checks accept it, and the browser's index holds what the ownership holds", () => {
    const stringsOnly = (journey: Journey): Journey => ({ ...journey, pages: journey.pages.map((page) => ({ ...page, components: (page.components ?? []).filter((entry) => typeof entry === "string") })) });
    // H: the fixture's journey under an id a component could not have — `apply now` and
    // `apply_now` must not share `@apply_now`.
    const spaced: Journey = { ...applyJourney(), id: "apply now" };
    // I: the form keeps a section's entries at `@apply.m1`, so the own field `m1` would be a form value.
    const keyedForm = presentationRoot();
    keyedForm.children!.content!.push({ id: "sec", type: "repeatingSection", configuration: {}, collection: { collectionPath: "@apply.m1" }, children: { content: [{ id: "row_f", type: "text", configuration: {} }] } });
    const withoutM1 = applyJourneyWith({ income: { components: applyJourney().pages[1]!.components!.filter((entry) => typeof entry === "string" || entry.id !== "m1") } });
    const cases: Array<[string, ComponentNode, Journey, Journey]> = [
      ["H", form, spaced, stringsOnly(spaced)],
      ["I", keyedForm, applyJourney(), withoutM1]
    ];
    const answers: Array<Record<string, unknown>> = [{}, APPLY_BELOW, APPLY_ABOVE, { email: "a@b.co", annual_income: 60000, "@apply.m1": "note", "@apply_now.m1": 3 }];
    for (const [rule, root, broken, without] of cases) {
      // A rule the definition breaks never makes the journey malformed.
      expect(validateJourneyShape(broken), rule).toEqual([]);
      expect(kernelIsJourney(broken), rule).toBe(true);
      for (const values of answers) {
        for (const page of ["details", "income", "assist"]) {
          for (const unknownFields of ["strip", "keep", "reject"] as const) {
            const judged = runKernel({ formId: "presentation", values, locale: "en", form: root, journey: broken, page, unknownFields, logLevel: "debug" }, []);
            const expected = runKernel({ formId: "presentation", values, locale: "en", form: root, journey: without, page, unknownFields, logLevel: "debug" }, []);
            expect(judged, `${rule}, ${page}, ${unknownFields}: ${JSON.stringify(values)}`).toEqual(expected);
          }
        }
      }
      // The browser's index replays the ownership's walk with the same id and keys: the same own nodes.
      const shapes = kernelKnownKeyShapes(root);
      const ownership = journeyOwnership(root, broken);
      const index = buildPresentationIndex(root, broken, ownership, (key) => kernelDefinesKey(shapes, key));
      expect(index?.order.filter((id) => !id.startsWith("@")).sort(), rule).toEqual(Object.keys(ownership.ownNodes ?? {}).sort());
    }
    expect(Object.keys(journeyOwnership(form, spaced).ownNodes ?? {})).toEqual([]);
    expect(Object.keys(journeyOwnership(keyedForm, applyJourney()).ownNodes ?? {}).sort()).toEqual(["income_total", "m2", "m3", "work_email"]);
  });

  it("the browser's shape check and the kernel's agree on every journey of these cases, and on their malformed twins", () => {
    const journeys = [applyJourney(), publicVariant(), applyWith({ details: { routes: [{ when: neq("name", "ask"), to: "assist" }] } })];
    for (const journey of journeys) {
      expect(validateJourneyShape(journey), journey.id).toEqual([]);
      expect(kernelIsJourney(journey), journey.id).toBe(true);
      // A page given a condition of its own: both refuse, and the server says the journey is invalid.
      journey.pages.forEach((page, pageIndex) => {
        const twin = { ...journey, pages: journey.pages.map((candidate, index) => (index === pageIndex ? { ...candidate, when: eq("name", "ask") } : candidate)) };
        expect(validateJourneyShape(twin).length, `${journey.id} ${page.id} when`).toBe(1);
        expect(kernelIsJourney(twin), `${journey.id} ${page.id} when`).toBe(false);
        expect(runKernel({ formId: "presentation", values: APPLY_BELOW, locale: "en", form, journey: twin as unknown as Journey }, []).errors[0]?.code).toBe("journey.invalid");
      });
      // Each object entry broken in turn: both refuse.
      journey.pages.forEach((page, pageIndex) => {
        (page.components ?? []).forEach((entry, entryIndex) => {
          if (typeof entry === "string") {
            return;
          }
          for (const broken of [{ ...entry, type: "" }, { ...entry, configuration: "x" }, { ...entry, id: 7, type: "text" }, { ...entry, children: [] }]) {
            const twin = { ...journey, pages: journey.pages.map((candidate, index) => (index === pageIndex ? { ...candidate, components: (candidate.components ?? []).map((held, at) => (at === entryIndex ? broken : held)) } : candidate)) };
            expect(kernelIsJourney(twin), `${journey.id} ${page.id} ${entryIndex}`).toBe(validateJourneyShape(twin).length === 0);
            expect(kernelIsJourney(twin), `${journey.id} ${page.id} ${entryIndex}`).toBe(false);
            expect(runKernel({ formId: "presentation", values: APPLY_BELOW, locale: "en", form, journey: twin as unknown as Journey }, []).errors[0]?.code).toBe("journey.invalid");
          }
        });
      });
    }
  });

  it("two aliases on branches that exclude each other fill one field", () => {
    const branches: Journey = {
      id: "branches",
      pages: [
        { id: "which", components: ["name", "annual_income"], routes: [{ when: eq("name", "home"), to: "home" }, { when: eq("name", "work"), to: "work" }, { to: "$end" }] },
        { id: "home", components: [{ id: "home_email", type: "text", configuration: { fills: "email", label: "Home email" } }], routes: [{ to: "$end" }] },
        { id: "work", components: [{ id: "office_email", type: "text", configuration: { fills: "email", label: "Work email" } }] }
      ]
    };
    expect(validateJourneyShape(branches)).toEqual([]);
    const ownership = kernelFoldSubmission(form, {}, branches).ownership;
    expect({ ...ownership?.aliasOf }).toEqual({ home_email: "email", office_email: "email" });
    expect(ownership?.pagesOf.email).toEqual(["home", "work"]);
    for (const name of ["home", "work"]) {
      const empty = threeWays(form, branches, { name, annual_income: 1 }, { name, annual_income: 1 });
      expect(codes(empty.errors), name).toEqual(["email:required"]);
      const answered = threeWays(form, branches, { name, annual_income: 1, email: "a@b.co" }, { name, annual_income: 1, email: "a@b.co" });
      expect(answered.values, name).toEqual({ name, annual_income: 1, email: "a@b.co" });
      expect(kernelFoldSubmission(form, { name, annual_income: 1 }, branches).trace?.pages, name).toEqual(["which", name]);
    }
    // Neither branch taken: the field is on pages the path skips — not required, its answer withheld.
    const neither = threeWays(form, branches, { name: "other", annual_income: 1 }, { name: "other", annual_income: 1, email: "left@example.org" });
    expect(neither.errors).toEqual([]);
    expect(neither.values).toEqual({ name: "other", annual_income: 1 });
    expect(neither.clientDerived).toBeUndefined();
  });
});

/**
 * Presentations in the browser: the same cases with the runtime for own nodes on
 * the browser's side. Each is judged by the client pipeline alone and by the runtime with the
 * in-process kernel as its sandbox, and then by the kernel over exactly what that browser
 * would send — which holds form values only. The three must agree on the verdict, on every
 * error on a form field, on the values and on the path. The one thing the browser adds is what
 * its own fields ask (an alias's own Required, an own field's): those errors name own nodes, and
 * a server, which never reads an own node, has no counterpart for them.
 */
describe("presentations parity in the browser: the runtime's verdict is the kernel's over its envelope", () => {
  const presentationEnvelope = {
    form: { id: "presentation", version: "1.0.0" },
    client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1.0.0" }
  };

  function definitionOf(journey: Journey, root: ComponentNode = presentationRoot()): FormDefinition {
    return { id: "presentation", version: "1.0.0", schemaVersion: "1.0.0", root, journey: { journeys: [journey] } };
  }
  function rootWith(id: string, change: Partial<ComponentNode>): ComponentNode {
    const root = presentationRoot();
    Object.assign(nodeOf(root, id) as ComponentNode, change);
    return root;
  }
  /** The month figures, as own answers. */
  const months = (each: number): Steps => (runtime) => {
    for (const month of ["m1", "m2", "m3"]) {
      runtime.setValue(`@apply.${month}`, each);
    }
  };
  const all = (...steps: Steps[]): Steps => (runtime) => steps.forEach((step) => step(runtime));
  const set = (path: string, value: unknown): Steps => (runtime) => runtime.setValue(path, value);
  /** An answer typed into an alias: written where the runtime says the alias's answer lives. */
  const fill = (aliasId: string, value: unknown): Steps => (runtime) => runtime.setValue(runtime.presentationValuePathOf(aliasId) as string, value);

  interface BrowserSide {
    accepted: boolean;
    /** Errors on form components and on the form, `componentId:code`. */
    errors: string[];
    /** Errors on nodes the presentation owns: the browser's alone. */
    own: string[];
    /** What is sent: the envelope's values, or — refused — what the same answers send unvalidated. */
    values: Record<string, unknown>;
    /** The path before the submit; `undefined` when no journey runs. */
    path: string[] | undefined;
    /** The page the submit left the person on, and who shows a form field's errors there. */
    pageId: string | undefined;
    hosts: Record<string, string>;
    runtime: FormRuntime;
  }

  async function browserSide(form: FormDefinition, steps: Steps, validators: readonly WasmValidator[] | undefined): Promise<BrowserSide> {
    const make = (): FormRuntime => (validators === undefined ? clientOnlyFor(form, {}, steps) : runtimeFor(form, {}, validators, steps));
    const runtime = make();
    const path = runtime.journeyView()?.path;
    const submitted = await runtime.submit("submit", presentationEnvelope);
    const kinds = runtime.presentationIndex()?.kindOf;
    const isOwn = (error: { componentId?: string | undefined }): boolean => error.componentId !== undefined && kinds !== undefined && Object.hasOwn(kinds, error.componentId);
    let values: Record<string, unknown>;
    if (submitted.accepted && submitted.canonicalSubmission) {
      values = submitted.canonicalSubmission.submission.values;
    } else {
      values = (await make().submit("send", presentationEnvelope)).canonicalSubmission?.submission.values as Record<string, unknown>;
    }
    return {
      accepted: submitted.accepted,
      errors: codes(submitted.errors.filter((error) => !isOwn(error))),
      own: codes(submitted.errors.filter(isOwn)),
      values,
      path,
      pageId: runtime.journeyView()?.pageId,
      hosts: { ...(runtime.journeyView()?.hosts ?? {}) },
      runtime
    };
  }

  /** Both browsers and the kernel over each one's envelope. Returns the sandboxed browser's side and the kernel's outcome over it. */
  async function parity(form: FormDefinition, steps: Steps, validators: readonly WasmValidator[] = []): Promise<{ alone: BrowserSide; browser: BrowserSide; outcome: KernelOutcome }> {
    const journey = findJourney(form) as Journey;
    const alone = await browserSide(form, steps, undefined);
    const browser = await browserSide(form, steps, validators);
    const kernelValidators = validators.map((validator): KernelValidator => (context) => validator.validate(context));
    let outcome: KernelOutcome | undefined;
    for (const [label, side, serverValidators] of [["client alone", alone, []], ["with its sandbox", browser, kernelValidators]] as Array<[string, BrowserSide, KernelValidator[]]>) {
      // In every case nothing a presentation owns is in what the browser sends. A form section
      // whose collection path is an `@` key travels as its list, `[]` with no row.
      const emptyList = (key: string): boolean => Array.isArray(side.values[key]) && (side.values[key] as unknown[]).length === 0;
      expect(Object.keys(side.values).filter((key) => key.startsWith("@") && !emptyList(key)), label).toEqual([]);
      const judged = runKernel({ formId: form.id, values: side.values, locale: "en", form: form.root, journey }, serverValidators);
      const blocked = judged.errors.some((error) => (error.severity ?? "error") === "error");
      const server: Verdict = { accepted: !blocked && judged.values !== undefined, errors: codes(judged.errors) };
      // Every error on a form field is the server's too.
      expect(server.errors, label).toEqual(side.errors);
      if (side.own.length === 0) {
        expect(server.accepted, label).toBe(side.accepted);
      } else {
        // Held back by a field of the presentation's own: the browser's to ask, never a server's.
        expect(side.accepted, label).toBe(false);
      }
      if (server.accepted) {
        expect(judged.values, label).toEqual(flattened(form, side.values));
      }
      // What would be sent is a fixpoint of the server's fold, and its path is the browser's.
      const fold = kernelFoldSubmission(form.root, side.values, journey);
      expect(fold.submittable, label).toEqual(side.values);
      if (side.path !== undefined) {
        expect(fold.trace?.pages, label).toEqual(side.path);
      }
      outcome = judged;
    }
    // A sandbox changes nothing the client pipeline decided, bar what only a plugin validator knows.
    if (validators.length === 0) {
      expect({ ...browser, runtime: undefined }).toEqual({ ...alone, runtime: undefined });
    }
    return { alone, browser, outcome: outcome as KernelOutcome };
  }

  it("an alias: empty, the form's required is on the form field and shown on the alias; answered, it is accepted", async () => {
    const form = definitionOf(applyJourney());
    const empty = await parity(form, months(12000));
    expect(empty.browser).toMatchObject({ accepted: false, errors: ["email:required"], own: ["work_email:required"], values: { annual_income: 36000 } });
    // The person is on the alias's page, and the alias shows the form field's error.
    expect(empty.browser).toMatchObject({ pageId: "details", hosts: { email: "work_email" } });
    expect(empty.browser.runtime.errors().find((error) => error.componentId === "email")).toMatchObject({ code: "required", stage: "field-constraints" });

    const answered = await parity(form, all(fill("work_email", "ada@example.org"), months(12000)));
    expect(answered.browser).toMatchObject({ accepted: true, errors: [], own: [], values: APPLY_BELOW, path: ["details", "income"] });
    expect(answered.outcome.values).toEqual(APPLY_BELOW);

    // The alias's own Required is the browser's alone: with the form field optional the browser
    // still asks, and a server, handed what would be sent, asks for nothing.
    const optional = definitionOf(applyJourney(), rootWith("email", { configuration: { label: "Email" } }));
    const held = await parity(optional, months(12000));
    expect(held.browser).toMatchObject({ accepted: false, errors: [], own: ["work_email:required"] });
    expect(held.outcome.errors).toEqual([]);
    expect(held.outcome.values).toEqual({ annual_income: 36000 });
  });

  it("a worked-out value: the browser writes it, the path turns on it alike, the form's rules hold it, and the server lists it as client-derived", async () => {
    const form = definitionOf(applyJourney());
    const below = await parity(form, all(fill("work_email", "ada@example.org"), months(12000)));
    expect(below.browser).toMatchObject({ accepted: true, values: APPLY_BELOW, path: ["details", "income"] });
    expect(below.outcome.clientDerived).toEqual(["annual_income"]);

    const above = await parity(form, all(fill("work_email", "ada@example.org"), months(20000), set("approved_amount", 500)));
    expect(above.browser).toMatchObject({ accepted: true, values: APPLY_ABOVE, path: ["details", "income", "assist"] });
    expect(above.outcome.clientDerived).toEqual(["annual_income"]);

    // Exactly on the threshold the route is taken; below it, an answer left on `assist` is withheld.
    const on = await parity(form, all(fill("work_email", "a@b.co"), set("@apply.m1", 50000)));
    expect(on.browser).toMatchObject({ accepted: true, path: ["details", "income", "assist"], values: { email: "a@b.co", annual_income: 50000 } });
    const stale = await parity(form, all(fill("work_email", "ada@example.org"), months(20000), set("approved_amount", 500), months(12000)));
    expect(stale.browser).toMatchObject({ accepted: true, values: APPLY_BELOW, path: ["details", "income"] });
    expect(stale.browser.runtime.state().values.approved_amount).toBe(500);

    // Held to the form's own rule like a typed answer: the field's declared ceiling refuses it on the form
    // field (`number.max`, in the browser's stage and the sandbox alike), and the page that worked it
    // out shows the error on the read-only copy.
    const over = await parity(form, all(fill("work_email", "a@b.co"), set("@apply.m1", 1000001)));
    expect(over.browser).toMatchObject({ accepted: false, errors: ["annual_income:number.max"], own: [], pageId: "income", hosts: { annual_income: "income_total" } });
    expect(over.outcome.clientDerived).toEqual(["annual_income"]);
    // The ceiling is the field's own, so the browser alone knows it too (it took a plugin's rule before).
    expect(over.alone.accepted).toBe(false);
    expect((await parity(form, all(fill("work_email", "ada@example.org"), months(20000), set("approved_amount", 500)))).browser.accepted).toBe(true);
  });

  it("the worked-out value's page skipped: its target is withheld and not required, and nothing is worked out", async () => {
    const form = definitionOf(applyJourneyWith({ details: { routes: [{ when: neq("name", "ask"), to: "assist" }] } }));
    const skipped = await parity(form, all(fill("work_email", "a@b.co"), set("name", "skip"), set("annual_income", 36000), months(12000)));
    expect(skipped.browser).toMatchObject({ accepted: true, errors: [], own: [], values: { email: "a@b.co", name: "skip" }, path: ["details", "assist"] });
    expect(skipped.outcome.clientDerived).toBeUndefined();
    expect(skipped.browser.runtime.effectiveState("annual_income")).toMatchObject({ visible: false, requiredApplies: false, runValidation: false, submitValue: false });
    expect(skipped.browser.runtime.effectiveState("income_total")).toMatchObject({ visible: false, runValidation: false });
    // The answer that was there is nobody's to clear: the page never wrote it.
    expect(skipped.browser.runtime.state().values.annual_income).toBe(36000);

    // Taken, the page asks for it again — and works it out once a month is answered.
    const asked = await parity(form, all(fill("work_email", "a@b.co"), set("name", "ask")));
    expect(asked.browser).toMatchObject({ accepted: false, errors: ["annual_income:required"], pageId: "income", hosts: { annual_income: "income_total" } });
    const worked = await parity(form, all(fill("work_email", "a@b.co"), set("name", "ask"), months(12000)));
    expect(worked.browser).toMatchObject({ accepted: true, values: { email: "a@b.co", name: "ask", annual_income: 36000 } });
    expect(worked.outcome.clientDerived).toEqual(["annual_income"]);
  });

  it("no page is passed over: a page of an alias alone whose target hides, a page of own fields and a layout of references to hidden fields all stay", async () => {
    // (a) `details` holds only the alias; its target hides itself unless the name says to show it.
    const hiding = definitionOf(applyJourney(), rootWith("email", { rules: { visibleWhen: eq("name", "show") } }));
    const hidden = await parity(hiding, all(set("name", "hide"), months(12000)));
    expect(hidden.browser).toMatchObject({ accepted: true, path: ["details", "income"], values: { name: "hide", annual_income: 36000 } });
    expect(hidden.browser.runtime.effectiveState("work_email")?.visible).toBe(false);
    const shown = await parity(hiding, all(set("name", "show"), months(12000)));
    expect(shown.browser).toMatchObject({ accepted: false, errors: ["email:required"], own: ["work_email:required"], path: ["details", "income"] });

    // (b) `income` with nothing but own fields: on the path whatever the form hides — and the
    // income nothing fills is judged as the whole form judges it, with no node to show it on.
    const ownOnly = applyJourneyWith({ income: { components: applyJourney().pages[1]!.components!.filter((entry) => typeof entry !== "string" && entry.type !== "journey-value"), routes: [] } });
    const everythingHidden = await parity(definitionOf(ownOnly, rootWith("money", { rules: { visibleWhen: literal(false) } })), fill("work_email", "a@b.co"));
    expect(everythingHidden.browser).toMatchObject({ accepted: true, path: ["details", "income", "assist"], values: { email: "a@b.co" } });
    const unfilled = await parity(definitionOf(ownOnly), all(fill("work_email", "a@b.co"), months(12000)));
    expect(unfilled.browser).toMatchObject({ accepted: false, errors: ["annual_income:required"], own: [], hosts: {} });
    expect(unfilled.browser.runtime.state().values.annual_income).toBeUndefined();

    // (c) the variant's layout alone, both references hidden: the page shows nothing and is on
    // the path all the same, in the browser and on the server.
    const never = { rules: { visibleWhen: literal(false) } };
    const bothHidden = (): ComponentNode => {
      const root = presentationRoot();
      Object.assign(nodeOf(root, "email") as ComponentNode, never);
      Object.assign(nodeOf(root, "name") as ComponentNode, never);
      return root;
    };
    const layoutOnly: Journey = { id: "public", pages: [{ id: "all", components: [publicVariant().pages[0]!.components![0] as JourneyPageEntry] }] };
    const empty = await parity(definitionOf(layoutOnly, bothHidden()), set("annual_income", 5));
    expect(empty.browser).toMatchObject({ accepted: true, path: ["all"], values: { annual_income: 5 } });
    expect(empty.browser.runtime.journeyRenderRoot()).toBeDefined();
    expect(kernelFoldSubmission(bothHidden(), { annual_income: 5 }, layoutOnly).trace?.pages).toEqual(["all"]);
    expect((await parity(definitionOf(publicVariant(), bothHidden()), set("annual_income", 5))).browser).toMatchObject({ accepted: true, path: ["all"] });
  });

  it("the target inside the section no page lists is shown and required: the section is never folded", async () => {
    const asked = await parity(definitionOf(applyJourney()), fill("work_email", "a@b.co"));
    expect(asked.browser).toMatchObject({ accepted: false, errors: ["annual_income:required"], own: [], pageId: "income", hosts: { annual_income: "income_total" } });
    expect(asked.browser.runtime.effectiveState("money")).toMatchObject({ visible: true });
    expect(asked.browser.runtime.effectiveState("annual_income")).toMatchObject({ visible: true, requiredApplies: true, runValidation: true, submitValue: true });
    expect(asked.browser.runtime.isRequired("annual_income")).toBe(true);
    // The read-only copy takes the field's state, and its marker.
    expect(asked.browser.runtime.effectiveState("income_total")).toMatchObject({ visible: true, readonly: true, requiredApplies: true });
    expect(asked.browser.runtime.isRequired("income_total")).toBe(true);

    // The section keeps its own state, as on the whole form: hidden by its own rule, its field is not asked.
    const sectionHidden = await parity(definitionOf(applyJourney(), rootWith("money", { rules: { visibleWhen: literal(false) } })), fill("work_email", "a@b.co"));
    expect(sectionHidden.browser).toMatchObject({ accepted: true, values: { email: "a@b.co" } });
    expect(sectionHidden.browser.runtime.effectiveState("income_total")).toMatchObject({ visible: false });

    // Through the variant the section is on no page and holds nothing placed: the whole form's
    // fold, required alike — with no node of the page to show it on.
    const variant = await parity(definitionOf(publicVariant()), all(set("email", "a@b.co"), set("name", "Ada")));
    expect(variant.browser).toMatchObject({ accepted: false, errors: ["annual_income:required"], own: [], path: ["all"], hosts: {} });
  });

  it("an honest browser sends no key of an own answer: the sandbox is asked about form values alone and passes strip, keep and reject alike", async () => {
    for (const unknownFields of ["strip", "keep", "reject"] as const) {
      const form = definitionOf(applyJourney());
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      const runtime = new FormRuntime(form, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
        wasmValidationHost: createInProcessWasmValidationHost([{ id: "plugins", version: "1", validators: [] }]),
        wasmUnknownFields: unknownFields
      });
      const asked: unknown[] = [];
      runtime.events().subscribe("WASM_VALIDATION_COMPLETED", (event) => asked.push((event.data as { requestValues: unknown }).requestValues));
      all(fill("work_email", "ada@example.org"), months(12000), set("@public.note", "left by another presentation"), set("@apply.stray", 1))(runtime);
      const sent = await runtime.submit("submit", presentationEnvelope);
      expect(sent.errors, unknownFields).toEqual([]);
      expect(sent.canonicalSubmission?.submission.values, unknownFields).toEqual(APPLY_BELOW);
      expect(asked, unknownFields).toEqual([APPLY_BELOW]);
      // Still the person's, in the browser.
      expect(runtime.state().values["@public.note"]).toBe("left by another presentation");
    }
  });

  it("a node that breaks a usability rule is ignored by the browser as by the kernel: the journey runs as if it were not there", async () => {
    const stepSets: Array<[string, Steps]> = [
      ["nothing answered", () => undefined],
      [
        "everything answered",
        all(
          set("email", "ada@example.org"),
          set("name", "Ada"),
          months(20000),
          set("approved_amount", 3),
          // Answers a browser could hold under the broken nodes' ids: nobody's.
          set("@apply.keyed", "x"),
          set("@apply.to_money", "x"),
          set("@apply.upload", "x")
        )
      ]
    ];
    for (const [label, broken, without] of usabilityPairs()) {
      for (const [answers, steps] of stepSets) {
        const judged = await parity(definitionOf(broken), steps);
        const expected = await parity(definitionOf(without), steps);
        const told = `${label}, ${answers}`;
        expect({ ...judged.browser, runtime: undefined }, told).toEqual({ ...expected.browser, runtime: undefined });
        expect(judged.outcome, told).toEqual(expected.outcome);
        // The same nodes in use, each of the same kind, stored at the same place.
        const index = judged.browser.runtime.presentationIndex();
        const clean = expected.browser.runtime.presentationIndex();
        expect(index?.order, told).toEqual(clean?.order);
        expect({ ...index?.kindOf }, told).toEqual({ ...clean?.kindOf });
        expect(index?.order.map((id) => judged.browser.runtime.presentationValuePathOf(id)), told).toEqual(clean?.order.map((id) => expected.browser.runtime.presentationValuePathOf(id)));
        expect(index?.workedOut.map((mapping) => mapping.nodeId), told).toEqual(clean?.workedOut.map((mapping) => mapping.nodeId));
      }
    }
    // Where the first worked-out value wins, the browser writes through it and not the second.
    const early = usabilityPairs()[7]![1];
    const runtime = clientOnlyFor(definitionOf(early), {}, months(20000));
    expect(runtime.presentationIndex()?.workedOut.map((mapping) => `${mapping.nodeId}@${mapping.pageId}`)).toEqual(["early_total@details"]);
    expect(runtime.presentationValuePathOf("income_total")).toBeUndefined();
    // Its sources are the own value fields of its own page — the alias — so the months on another page never reach it.
    expect(runtime.state().values.annual_income).toBeUndefined();
  });

  it("the browser ignores an own entry of a journey whose id is outside the grammar, or whose answer would live at a key the form defines, as the kernel does", async () => {
    // H: `staff view` owns nothing, so its Required own field asks nothing and keeps nothing.
    const staffPage = (id: string): Journey => ({ id, pages: [{ id: "p", components: ["email", "annual_income", { id: "consent", type: "text", configuration: { label: "Consent", required: true } }] }] });
    const answered = all(set("email", "a@b.co"), set("annual_income", 1));
    const spaced = await parity(definitionOf(staffPage("staff view")), answered);
    expect(spaced.browser).toMatchObject({ accepted: true, errors: [], own: [], values: { email: "a@b.co", annual_income: 1 }, path: ["p"] });
    expect(spaced.browser.runtime.presentationValuePathOf("consent")).toBeUndefined();
    expect(spaced.browser.runtime.presentationIndex()?.order).toEqual([]);
    expect(spaced.outcome.values).toEqual({ email: "a@b.co", annual_income: 1 });
    // Its twin on the grammar asks for its own field, in the browser alone, under a key of its own.
    const underscored = await parity(definitionOf(staffPage("staff_view")), answered);
    expect(underscored.browser).toMatchObject({ accepted: false, errors: [], own: ["consent:required"] });
    expect(underscored.browser.runtime.presentationValuePathOf("consent")).toBe("@staff_view.consent");
    expect(underscored.outcome.errors).toEqual([]);

    // I: the form keeps a section's entries at `@j.items`; the journey's own `items` would live
    // there and be sent as the section's answer. Ignored; the journey's other own field is kept.
    const root = presentationRoot();
    root.children!.content!.push({ id: "sec", type: "repeatingSection", configuration: {}, collection: { collectionPath: "@j.items" }, children: { content: [{ id: "row_f", type: "text", configuration: {} }] } });
    const owning: Journey = { id: "j", pages: [{ id: "p", components: ["email", "annual_income", { id: "items", type: "textarea", configuration: { label: "Private notes" } }, { id: "note", type: "text" }] }] };
    const keyed = await parity(definitionOf(owning, root), all(answered, set("@j.note", "kept here")));
    expect(keyed.browser).toMatchObject({ accepted: true, errors: [], own: [] });
    // The form's own section, with no entry, is posted as an empty list,
    // which the kernel reads as no key.
    expect(keyed.browser.values).toEqual({ email: "a@b.co", annual_income: 1, "@j.items": [] });
    expect(flattened(definitionOf(owning, root), keyed.browser.values)).toEqual({ email: "a@b.co", annual_income: 1 });
    expect(keyed.browser.runtime.presentationValuePathOf("items")).toBeUndefined();
    expect(keyed.browser.runtime.presentationIndex()?.isPresentationKey("@j.items")).toBe(false);
    expect(keyed.browser.runtime.presentationValues()).toEqual({ note: "kept here" });
    expect(keyed.outcome.values).toEqual({ email: "a@b.co", annual_income: 1 });
  });

  it("a form calculation that reads an own answer reads nothing, in the browser as in the kernel, and is listed as client-derived", async () => {
    const reading = presentationRoot();
    reading.children!.content!.push({ id: "first_month", type: "number", configuration: {}, rules: { value: { kind: "call", name: "sum", args: [path("@apply.m1")] } } });
    const form = definitionOf(applyJourney(), reading);
    const result = await parity(form, all(fill("work_email", "ada@example.org"), months(12000)));
    expect(result.browser.runtime.state().values).toMatchObject({ "@apply.m1": 12000, first_month: 0 });
    expect(result.browser).toMatchObject({ accepted: true, values: { ...APPLY_BELOW, first_month: 0 } });
    expect(result.outcome.values).toEqual({ ...APPLY_BELOW, first_month: 0 });
    expect(result.outcome.clientDerived).toEqual(["annual_income", "first_month"]);
  });

  it("two aliases on branches that exclude each other fill one field, each showing its errors on its own page", async () => {
    const branches: Journey = {
      id: "branches",
      pages: [
        { id: "which", components: ["name", "annual_income"], routes: [{ when: eq("name", "home"), to: "home" }, { when: eq("name", "work"), to: "work" }, { to: "$end" }] },
        { id: "home", components: [{ id: "home_email", type: "text", configuration: { fills: "email", label: "Home email" } }], routes: [{ to: "$end" }] },
        { id: "work", components: [{ id: "office_email", type: "text", configuration: { fills: "email", label: "Work email" } }] }
      ]
    };
    const form = definitionOf(branches);
    for (const [name, alias] of [["home", "home_email"], ["work", "office_email"]] as const) {
      const empty = await parity(form, all(set("name", name), set("annual_income", 1)));
      expect(empty.browser, name).toMatchObject({ accepted: false, errors: ["email:required"], own: [], path: ["which", name], pageId: name, hosts: { email: alias } });
      // The other branch's alias is on a page the path skips: hidden, whatever the field's state.
      const other = alias === "home_email" ? "office_email" : "home_email";
      expect(empty.browser.runtime.effectiveState(alias)?.visible, name).toBe(true);
      expect(empty.browser.runtime.effectiveState(other)?.visible, name).toBe(false);
      const answered = await parity(form, all(set("name", name), set("annual_income", 1), fill(alias, "a@b.co")));
      expect(answered.browser, name).toMatchObject({ accepted: true, values: { name, annual_income: 1, email: "a@b.co" }, path: ["which", name] });
    }
    // Neither branch taken: the field is on pages the path skips — not required, its answer withheld.
    const neither = await parity(form, all(set("name", "other"), set("annual_income", 1), set("email", "left@example.org")));
    expect(neither.browser).toMatchObject({ accepted: true, errors: [], values: { name: "other", annual_income: 1 }, path: ["which"] });
    expect(neither.outcome.clientDerived).toBeUndefined();
  });
});

/**
 * A calculation or a default on a node that holds no data: static
 * HTML, a button, a fieldset define no key, so the browser works none of them out and sends
 * nothing for them — what an unsandboxed browser sends is what a server stores, and a server in
 * `reject` mode has nothing to refuse.
 */
describe("a node that holds no data puts no key in the submission: the browser alone, with its sandbox, and the kernel agree in strip, keep and reject", () => {
  const thanks: Expression = { kind: "call", name: "concat", args: [literal("Thanks, "), path("name")] };
  const nonData = (): FormDefinition =>
    formOf([
      field("name", { required: true }),
      { id: "greeting", type: "html", configuration: { content: "<p>Thanks</p>" }, rules: { value: thanks } },
      { id: "send", type: "button", configuration: { label: "Send" }, rules: { defaultValue: literal("clicked") } },
      { ...group("box", "fieldset", [field("inside")]), rules: { defaultValue: literal("boxed") } },
      // A field beside them keeps its own calculation and default.
      { ...field("echo"), rules: { value: path("name") } },
      { ...field("start"), rules: { defaultValue: literal("now") } }
    ]);
  const answers = { name: "Ada", inside: "x" };
  const sentValues = { name: "Ada", inside: "x", echo: "Ada", start: "now" };

  it("html with a calculation, a button with a default, a fieldset with a default", async () => {
    const form = nonData();
    const alone = clientOnlyFor(form, answers);
    // Nothing is worked out for them, even to hold in the browser: nothing draws its own value.
    expect(alone.state().values).toEqual(sentValues);
    const aloneSent = await alone.submit("submit", envelope);
    expect(aloneSent.accepted).toBe(true);
    expect(aloneSent.canonicalSubmission?.submission.values).toEqual(sentValues);
    for (const unknownFields of ["strip", "keep", "reject"] as const) {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      const sandboxed = new FormRuntime(form, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
        wasmValidationHost: createInProcessWasmValidationHost([{ id: "plugins", version: "1", validators: [] }]),
        wasmUnknownFields: unknownFields
      });
      for (const [key, value] of Object.entries(answers)) {
        sandboxed.setValue(key, value);
      }
      const sent = await sandboxed.submit("submit", envelope);
      expect({ accepted: sent.accepted, errors: codes(sent.errors), values: sent.canonicalSubmission?.submission.values }, unknownFields).toEqual({ accepted: true, errors: [], values: sentValues });
      // The kernel over what either browser sends.
      const outcome = runKernel({ formId: form.id, values: aloneSent.canonicalSubmission?.submission.values ?? {}, locale: "en", form: form.root, unknownFields }, []);
      expect({ errors: codes(outcome.errors), values: outcome.values }, unknownFields).toEqual({ errors: [], values: sentValues });
    }
    // What an older browser sent — keys the kernel does not know: stripped, kept unread, refused.
    const before = { ...sentValues, greeting: "Thanks, Ada", send: "clicked", box: "boxed" };
    expect(runKernel({ formId: form.id, values: before, locale: "en", form: form.root, unknownFields: "strip" }, []).values).toEqual(sentValues);
    expect(codes(runKernel({ formId: form.id, values: before, locale: "en", form: form.root, unknownFields: "reject" }, []).errors)).toEqual(["-:unknown_field", "-:unknown_field", "-:unknown_field"]);
  });
});

/**
 * Under `keep` a key the schema does not define is stored as sent and read by nothing:
 * not by a calculation, not by a rule, not by the path. So a forged own answer's `@` key — or one
 * spelled like an own id, or like a fieldset's id — cannot work a form calculation out, and the
 * verdict is `strip`'s. The browser never sends one; it is judged here beside the kernel.
 */
describe("keep stores an unknown key unread: a forged key steers no calculation", () => {
  const atLeast = (name: string): Expression => ({ kind: "unary", operator: "not", operand: { kind: "binary", operator: "gte", left: path(name), right: literal(50) } }) as unknown as Expression;
  const reads = (source: string, total: string, proof: string): ComponentNode[] => [
    { ...field(total), type: "number", rules: { value: path(source) } },
    // Required unless the calculation reaches 50.
    field(proof, { required: true }, { rules: { visibleWhen: atLeast(total) } })
  ];
  const form = (): FormDefinition =>
    formOf(
      [field("email"), ...reads("@apply.m1", "total_at", "proof_at"), ...reads("m1", "total_id", "proof_id"), group("box", "fieldset", [field("inside")]), ...reads("box", "total_box", "proof_box")],
      { id: "apply", pages: [{ id: "p1", components: ["email", "total_at", "proof_at", "total_id", "proof_id", "box", "total_box", "proof_box", { id: "m1", type: "number" }] }] }
    );
  const forged = { "@apply.m1": 99, m1: 99, box: 99 };
  const required = ["proof_at:required", "proof_box:required", "proof_id:required"];

  it("refuses alike in strip, keep and reject: the browser alone, with its sandbox, and the kernel over what either would send or a forger sends", async () => {
    const definition = form();
    const journey = findJourney(definition) as Journey;
    for (const unknownFields of ["strip", "keep", "reject"] as const) {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
      const browser = new FormRuntime(definition, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
        wasmValidationHost: createInProcessWasmValidationHost([{ id: "plugins", version: "1", validators: [] }]),
        wasmUnknownFields: unknownFields
      });
      browser.setValue("email", "a@b.co");
      browser.setValue("@apply.m1", 99);
      const sent = await browser.submit("submit", envelope);
      expect({ accepted: sent.accepted, errors: codes(sent.errors) }, unknownFields).toEqual({ accepted: false, errors: required });
      const alone = await clientOnlyFor(definition, { email: "a@b.co", "@apply.m1": 99 }).submit("submit", envelope);
      expect(codes(alone.errors), unknownFields).toEqual(required);

      const judge = (values: Record<string, unknown>) => runKernel({ formId: definition.id, values, locale: "en", form: definition.root, journey, unknownFields }, []);
      // What an honest browser sends: none of the three.
      expect(codes(judge({ email: "a@b.co" }).errors), unknownFields).toEqual(required);
      // A forger's keys: refused in `reject`, dropped in `strip`, kept unread in `keep` — never steering a calculation.
      const verdict = judge({ email: "a@b.co", ...forged });
      expect(codes(verdict.errors), unknownFields).toEqual(unknownFields === "reject" ? [...required, "-:unknown_field", "-:unknown_field", "-:unknown_field"].sort() : required);
      expect(verdict.values, unknownFields).toBeUndefined();
    }
    // Answered, `keep` stores the forged keys as sent — and works nothing out of them.
    const answered = { email: "a@b.co", proof_at: "a", proof_id: "b", proof_box: "c" };
    const kept = runKernel({ formId: definition.id, values: { ...answered, ...forged }, locale: "en", form: definition.root, journey, unknownFields: "keep" }, []);
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual({ ...answered, ...forged });
    expect(kept.clientDerived).toBeUndefined();
    expect(runKernel({ formId: definition.id, values: { ...answered, ...forged }, locale: "en", form: definition.root, journey, unknownFields: "strip" }, []).values).toEqual(answered);
    // The keys it keeps sit where they were sent; a calculation's result still comes after them.
    const withCalc = runKernel({ formId: definition.id, values: { email: "a@b.co", "@apply.m1": 99, proof_at: "a", proof_id: "b", proof_box: "c", total_at: 7 }, locale: "en", form: definition.root, journey, unknownFields: "keep" }, []);
    expect(Object.keys(withCalc.values ?? {})).toEqual(["email", "@apply.m1", "proof_at", "proof_id", "proof_box", "total_at"]);
    // Sent while unreadable here, the calculation's answer is kept as sent and listed as the browser's.
    expect(withCalc.values?.total_at).toBe(7);
    expect(withCalc.clientDerived).toEqual(["total_at"]);
  });
});

describe("journey parity: a Check answers page", () => {
  /** `branching` with a review page before the exit, holding a declaration and, wrongly, a form field. */
  function reviewed(): FormDefinition {
    const form = branching();
    const journey = (form.journey!.journeys![0] as Journey);
    const pages = journey.pages.map((page) => (page.id === "details" ? { ...page, routes: [] } : page));
    pages.splice(5, 0, {
      id: "check",
      kind: "review",
      title: "Check your answers",
      review: { labels: { employed: "Employed" }, emptyOptional: "omit" },
      components: ["notes", { id: "declare", type: "paragraph", configuration: { text: "I confirm." } }] as JourneyPageEntry[]
    });
    return { ...form, journey: { journeys: [{ ...journey, pages }] } };
  }

  it("the browser's shape check and the kernel's accept the journey alike", () => {
    const journey = findJourney(reviewed());
    expect(journey).toBeDefined();
    expect(validateJourneyShape(journey)).toEqual([]);
    expect(kernelIsJourney(journey)).toBe(true);
  });

  it("walks the same path on both sides: the review page last, never passed over", () => {
    const form = reviewed();
    const journey = findJourney(form)!;
    const answers = { resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co" };
    const runtime = runtimeFor(form, answers, []);
    const server = kernelFoldSubmission(form.root, answers, journey).trace;
    expect(server?.pages).toEqual(["residency", "work", "employment", "details", "check"]);
    expect(server?.end).toBe("end");
    expect(runtime.journeyView()?.path).toEqual(server?.pages);
    // An exit route still stops before it, on both sides.
    expect(kernelFoldSubmission(form.root, { resident: "no" }, journey).trace).toMatchObject({ pages: ["residency", "ineligible"], end: "exit" });
    expect(runtimeFor(form, { resident: "no" }, []).journeyView()?.path).toEqual(["residency", "ineligible"]);
  });

  it("reaches one verdict over the envelope, the field listed on the review page judged as on no page", async () => {
    const accepted = await compare(reviewed(), { resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co", notes: "a note long enough" });
    expect(accepted.browser).toEqual({ accepted: true, errors: [] });
    expect(accepted.values.notes).toBe("a note long enough");
    // The final submit checks everything as before.
    const refused = await compare(reviewed(), { resident: "yes", employed: true, "contact.email": "a@b.co", notes: "short" });
    expect(refused.browser).toEqual({ accepted: false, errors: ["employer:required", "notes:minLength"] });
  });

  it("scopes no form component to the review page on either side: only its own content is there", () => {
    const form = reviewed();
    const journey = findJourney(form)!;
    const answers = { resident: "yes", employed: true, employer: "ACME", "contact.email": "a@b.co", notes: "short" };
    const scoped = runKernel({ formId: form.id, values: answers, locale: "en", form: form.root, journey, page: "check" }, []);
    expect(scoped.pageComponentIds).toEqual([]);
    const ownership = journeyOwnership(form.root, journey);
    expect(ownership.membersOf.check).toEqual(["declare"]);
    expect(ownership.pagesOf.notes).toBeUndefined();
    // The browser's page scope: the declaration alone.
    expect([...EagerJourneyEngine.pageComponents(ownership, "check")]).toEqual(["declare"]);
    // The page before it scopes its own as ever.
    expect(runKernel({ formId: form.id, values: answers, locale: "en", form: form.root, journey, page: "details" }, []).pageComponentIds).toEqual(["contact", "email", "phone"]);
  });
});
