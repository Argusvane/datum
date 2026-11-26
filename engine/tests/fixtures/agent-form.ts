/**
 * The forms the renderer catalogue's tests run over: the form-tests
 * journey (`FORM_TESTS_FIXTURE`: five pages, a repeating section, a data-source choice, a
 * `requiredWhen` / `visibleWhen` pair), a steps variant, a signing-button variant, a participants
 * variant, a single-page form with every kind and a 1 000-field generator for the cap test, plus
 * the runtime and registrar recipes every test file shares.
 */

import { createAgentRegistrar, type AgentRegistrar, type AgentRegistrarOptions, type FormRegistration } from "../../form-engine/agent/registrar.js";
import { createFormAgentTools } from "../../form-engine/agent/form/tools.js";
import { runtimeAgentHost, type FormAgentHost, type RuntimeAgentHost, type RuntimeAgentHostOptions } from "../../form-engine/agent/form/host.js";
import type { DraftStore } from "../../form-engine/persistence/core/draft-store.js";
import { InMemoryDraftStore } from "../../form-engine/persistence/local-storage/in-memory-draft-store.js";
import type { PdfLayoutOption } from "../../form-engine/render/web-component/form-renderer-element.js";
import type { DownloadPdfResult } from "../../form-engine/render/web-component/pdf-download.js";
import type { AgentRefusal, AgentToolResult } from "../../form-engine/agent/tool-types.js";
import type { FormEvent } from "../../form-engine/core/events/event-bus.js";
import type { FormHooks } from "../../form-engine/core/events/hooks.js";
import type { DataSourceSet } from "../../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { defineDataSources } from "../../form-engine/data/host/data-source-set.js";
import { EagerJourneyRenderKit } from "../../form-engine/render/core/journey-render-kit-eager.js";
import { FormRuntime, type FormRuntimeDependencies } from "../../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

export { FORM_TESTS_FIXTURE };

/** The journey form: pages intro / contact / details / review / stop, `items` rows, `province` from the `provinces` source. */
export const AGENT_JOURNEY_FORM: FormDefinition = FORM_TESTS_FIXTURE;

export const PROVINCES = [
  { value: "ON", label: "Ontario" },
  { value: "QC", label: "Quebec" },
  { value: "BC", label: "British Columbia" }
];

function form(id: string, children: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id,
    version: "1.0.0",
    schemaVersion: "1.0.0",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
    root: { id: "form", type: "form", configuration: { label: `Agent ${id}` }, children: { content: children } },
    ...extra
  } as FormDefinition;
}

/** Two steps: `step1` (a required name, an email) and `step2` (a city choice, notes), plus a field outside the steps. */
export const AGENT_STEPS_FORM: FormDefinition = form("steps", [
  { id: "intro_note", type: "text", configuration: { label: "Reference" } },
  {
    id: "wizard",
    type: "steps",
    configuration: { label: "Application" },
    children: {
      content: [
        {
          id: "step1",
          type: "step",
          configuration: { label: "About you" },
          children: {
            content: [
              { id: "name", type: "text", configuration: { label: "Name", required: true } },
              { id: "email", type: "text", configuration: { label: "Email" } }
            ]
          }
        },
        {
          id: "step2",
          type: "step",
          configuration: { label: "Where" },
          children: {
            content: [
              { id: "city", type: "select", configuration: { label: "City", options: [{ value: "ott", label: "Ottawa" }, { value: "qc", label: "Quebec City" }] } },
              { id: "notes", type: "textarea", configuration: { label: "Notes" } }
            ]
          }
        }
      ]
    }
  }
]);

/** A submit button that signs with a passkey (`signature-required { because: "button" }`). */
export const AGENT_SIGNING_BUTTON_FORM: FormDefinition = form("signing-button", [
  { id: "name", type: "text", configuration: { label: "Name" } },
  { id: "send", type: "button", configuration: { label: "Submit", action: "submit", signature: "webauthn" } }
]);

/** A `signature` component declaring participants (`signature-required { because: "participants" }`). */
export const AGENT_PARTICIPANTS_FORM: FormDefinition = form("participants", [
  { id: "name", type: "text", configuration: { label: "Name" } },
  { id: "sig", type: "signature", configuration: { label: "Signatures", participants: [{ id: "applicant", role: "signer" }] } }
]);

/**
 * One page with every kind: a required text, a number with bounds, a date, a checkbox that
 * reveals `other` and requires `detail` (the fold the writes flip), a select whose two last
 * options share a label, a checkboxes group, a calculated number, a data grid with three
 * columns, a file, a tabs container holding a field, static html, a plain submit button and a
 * labelled fieldset ("Dates") around the date.
 */
export const AGENT_SINGLE_FORM: FormDefinition = form("single", [
  { id: "name", type: "text", configuration: { label: "Full name", required: true, maxLength: 120 } },
  { id: "age", type: "number", configuration: { label: "Age", min: 18, max: 120, step: 1 } },
  {
    id: "dates",
    type: "fieldset",
    configuration: { label: "Dates" },
    children: { content: [{ id: "start", type: "date", configuration: { label: "Start date", min: "2026-01-01" } }] }
  },
  { id: "has_other", type: "checkbox", configuration: { label: "Something else?" } },
  { id: "other", type: "text", configuration: { label: "What else" }, rules: { visibleWhen: "has_other = true" } },
  { id: "detail", type: "text", configuration: { label: "Detail" }, rules: { requiredWhen: "has_other = true" } },
  {
    id: "colour",
    type: "select",
    configuration: {
      label: "Colour",
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
        { value: "g1", label: "Green" },
        { value: "g2", label: "Green" }
      ]
    }
  },
  {
    id: "topics",
    type: "checkboxes",
    configuration: { label: "Topics", options: [{ value: "news", label: "News" }, { value: "offers", label: "Offers" }] }
  },
  { id: "double", type: "number", configuration: { label: "Age doubled" }, rules: { value: "age * 2" } },
  {
    id: "grid",
    type: "dataGrid",
    configuration: { label: "Expenses", minRows: 1, maxRows: 3, initialRows: 1 },
    collection: { collectionPath: "grid" },
    children: {
      content: [
        { id: "when", type: "date", configuration: { label: "Date" } },
        { id: "amount", type: "number", configuration: { label: "Amount", required: true } },
        { id: "category", type: "select", configuration: { label: "Category", options: [{ value: "meal", label: "Meal" }, { value: "taxi", label: "Taxi" }] } }
      ]
    }
  },
  { id: "receipt", type: "file", configuration: { label: "Receipt" } },
  {
    id: "tabs",
    type: "tabs",
    configuration: { label: "More" },
    children: {
      first: [{ id: "tab1", type: "tab", configuration: { label: "First" }, children: { content: [{ id: "tabbed", type: "text", configuration: { label: "In a tab" } }] } }]
    }
  },
  { id: "blurb", type: "html", configuration: { html: "<p>Read me</p>" } },
  { id: "send", type: "button", configuration: { label: "Submit", action: "submit" } }
]);

/**
 * The `travel-claim` (drafts and PDF): a required traveller, a trip date, a
 * required amount, an expenses table, a hidden case reference the host prefills, and a
 * declaration the attestation recipe guards. The element would carry
 * `draft="claim-ana"`, `draft-store="server:/api/drafts"`, `pdf="auto"` and the layouts
 * {@link TRAVEL_CLAIM_LAYOUTS}; the node host stands in for them through {@link agentSetup}'s
 * `drafts` and `pdf` options.
 */
export const TRAVEL_CLAIM_FORM: FormDefinition = form("travel-claim", [
  { id: "traveller", type: "text", configuration: { label: "Traveller", required: true } },
  { id: "trip_start", type: "date", configuration: { label: "Trip start" } },
  { id: "amount", type: "number", configuration: { label: "Amount", required: true } },
  {
    id: "items",
    type: "dataGrid",
    configuration: { label: "Expenses", minRows: 0, maxRows: 5, initialRows: 0 },
    collection: { collectionPath: "items" },
    children: {
      content: [
        { id: "sku", type: "text", configuration: { label: "Item" } },
        { id: "cost", type: "number", configuration: { label: "Cost" } }
      ]
    }
  },
  { id: "case_ref", type: "text", configuration: { label: "Case reference" }, rules: { visibleWhen: "false" } },
  { id: "declaration", type: "checkbox", configuration: { label: "I declare the claim is true" } }
]);

/** The travel claim's PDF layouts as `<datum-form>`'s `pdfLayouts()` lists them: `claim-summary` (default) and `receipt`. */
export const TRAVEL_CLAIM_LAYOUTS: PdfLayoutOption[] = [
  { id: "claim-summary", label: "Claim summary", kind: "generated", isDefault: true, conditional: false },
  { id: "receipt", label: "Receipt", kind: "generated", isDefault: false, conditional: false }
];

/** The runtime version context a draft is saved with (the runtime refuses `saveDraft` without one). */
export const AGENT_VERSION_CONTEXT = { formVersion: "1.0.0", schemaVersion: "1.0.0", rendererVersion: "agent-test" };

/**
 * A download as `<datum-form>`'s `downloadPdf()` resolves it: bytes, a fill report and a
 * signature-free detail with the kernel's warnings worded (what the tool must never return).
 */
export function pdfDownloadResult(overrides: Partial<DownloadPdfResult> = {}): DownloadPdfResult {
  return {
    bytes: new Uint8Array([37, 80, 68, 70]),
    fileName: "travel-claim-claim-summary-en-20261025.pdf",
    layoutId: "claim-summary",
    layoutChoice: "default",
    pageCount: 3,
    warnings: [],
    downloaded: true,
    cancelled: false,
    ...overrides
  };
}

/** A single page of `count` text fields, for the output cap. */
export function bigForm(count: number): FormDefinition {
  const children: ComponentNode[] = [];
  for (let index = 0; index < count; index += 1) {
    children.push({ id: `field_${index}`, type: "text", configuration: { label: `Field number ${index} with a label long enough to count`, description: "A description that adds bytes to every field row." } });
  }
  return form("big", children);
}

export interface AgentRuntimeOptions {
  dataSources?: DataSourceSet | false;
  hooks?: FormHooks;
  deps?: Partial<FormRuntimeDependencies>;
  journey?: string;
}

/** A runtime as `<datum-form>` would build it: the `embed` mode, the field constraints stage, the eager journey engine, the `provinces` source. */
export function agentRuntime(definition: FormDefinition, options: AgentRuntimeOptions = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "embed", validate: true, sign: false, serverValidation: false });
  const deps: FormRuntimeDependencies = {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    journeyEngine: EagerJourneyEngine,
    ...(options.dataSources === false ? {} : { dataSources: options.dataSources ?? defineDataSources({ provinces: PROVINCES }) }),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.journey !== undefined ? { journey: options.journey } : {}),
    ...(options.deps ?? {})
  };
  return new FormRuntime(definition, deps);
}

export interface AgentSetup {
  runtime: FormRuntime;
  host: RuntimeAgentHost;
  registrar: AgentRegistrar;
  registration: FormRegistration;
  controller: AbortController;
  /** Every event the runtime published since setup (or the last `events.length = 0`). */
  events: FormEvent[];
  execute(name: string, input?: unknown, signal?: AbortSignal): Promise<AgentToolResult>;
  /** `execute` asserting `ok: true`, returning the fields. */
  ok(name: string, input?: unknown): Promise<Record<string, unknown>>;
  /** `execute` asserting `ok: false`, returning the refusal. */
  refused(name: string, input?: unknown): Promise<AgentRefusal>;
}

export interface AgentSetupOptions extends AgentRuntimeOptions {
  host?: RuntimeAgentHostOptions;
  registrar?: AgentRegistrarOptions;
  /**
   * The form keeps a draft under `key` (default `claim-ana`) in `store`
   * (default a fresh `InMemoryDraftStore`), which the runtime saves through (with
   * {@link AGENT_VERSION_CONTEXT}) and the node host restores and deletes through.
   */
  drafts?: { key?: string; store?: DraftStore };
  /** Members laid over the node host after it is built (a `drafts()` answering another store kind, say). */
  hostOverrides?: Partial<FormAgentHost>;
  /**
   * The node host's access policy, handed to
   * `runtimeAgentHost`; absent, the host's own default `"always"` keeps every fixture live. A
   * test of the sealed form passes `"definition"` and sets the author's switch in its definition.
   */
  agentAccess?: "always" | "definition";
}

/** The catalogue registered on a fresh registrar over a node host: what every test drives. */
export function agentSetup(definition: FormDefinition, options: AgentSetupOptions = {}): AgentSetup {
  const draftStore = options.drafts !== undefined ? (options.drafts.store ?? new InMemoryDraftStore()) : undefined;
  const runtime = agentRuntime(
    definition,
    draftStore !== undefined ? { ...options, deps: { draftStore, versionContext: AGENT_VERSION_CONTEXT, ...(options.deps ?? {}) } } : options
  );
  const events: FormEvent[] = [];
  runtime.events().subscribe("*", (event) => {
    events.push(event);
  });
  // The eager journey kit, as `<datum-form>` hands the one it loaded: the runtime runs the eager journey engine.
  const host = runtimeAgentHost(runtime, {
    journeyKit: EagerJourneyRenderKit,
    ...(draftStore !== undefined ? { draftKey: options.drafts?.key ?? "claim-ana", draftStore } : {}),
    ...(options.agentAccess !== undefined ? { agentAccess: options.agentAccess } : {}),
    ...(options.host ?? {})
  });
  if (options.hostOverrides !== undefined) {
    Object.assign(host, options.hostOverrides);
  }
  const registrar = createAgentRegistrar(options.registrar);
  const controller = new AbortController();
  const registration = registrar.registerForm({ host, catalogue: createFormAgentTools, signal: controller.signal });
  const execute = (name: string, input: unknown = {}, signal?: AbortSignal): Promise<AgentToolResult> => registrar.execute(name, input, signal !== undefined ? { signal } : undefined);
  return {
    runtime,
    host,
    registrar,
    registration,
    controller,
    events,
    execute,
    async ok(name, input = {}) {
      const result = await execute(name, input);
      if (!result.ok) {
        throw new Error(`${name} refused: ${result.code}: ${result.message} (${JSON.stringify(result.details)})`);
      }
      return result as unknown as Record<string, unknown>;
    },
    async refused(name, input = {}) {
      const result = await execute(name, input);
      if (result.ok) {
        throw new Error(`${name} was not refused: ${JSON.stringify(result).slice(0, 300)}`);
      }
      return result;
    }
  };
}

/** The runtime's own `setValue` + `commitValue`, as a person's typing lands (so the last writer is `other`). */
export function personTypes(runtime: FormRuntime, values: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(values)) {
    runtime.setValue(path, value);
    runtime.commitValue(path);
  }
}

export function countEvents(events: readonly FormEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}
