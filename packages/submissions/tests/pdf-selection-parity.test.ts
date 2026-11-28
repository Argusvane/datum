import { afterAll, describe, expect, it } from "vitest";
import { sandboxProgramHost } from "./fixtures/sandbox-host.js";
import {
  FormRuntime,
  SubmissionModeRegistry,
  ValidationPipeline,
  createFieldConstraintsStage,
  renderFormPdf,
  selectPdfLayoutForValues,
  type ComponentNode,
  type FormDefinition,
  type Journey,
  type PdfGeneratedLayout,
  type PdfRenderProvider
} from "@argusvane/datum-engine";
import { DEFAULT_FONT_PACK, createInProcessPdfProvider, handlePdfRequest, loadFontPack } from "@argusvane/datum-pdf-kernel";

import {
  InMemorySubmissionStore,
  createKernelValidator,
  createProgramHostValidator,
  createProviderPdfRenderer,
  createSubmissionService,
  recordValuesOf,
  type SubmissionValidator
} from "../src/index.js";
import type { SubmissionRecord, SubmissionSettings } from "../src/types.js";

/**
 * One layout for one person's answers, in the browser and on the server: a
 * `FormRuntime` chooses layout X for its download, it submits, the server that registered the
 * very same definition receives the envelope, and the PDF it keeps is X. The browser reads the
 * runtime's submittable view (`submittableValues()`); the server reads the values its verdict
 * judged (`recordValuesOf`). Both come out of one fold, so an answer the submission
 * leaves out — on a journey branch the person left, hidden and excluded, hidden and cleared —
 * chooses nothing on either side, even where the raw state still holds it.
 */

const eq = (path: string, value: string | boolean): string => `${path} = ${JSON.stringify(value)}`;
// not(empty(path)), not the bare path: a condition holds only for true (strict truthiness), so a text answer is no yes.
const answered = (path: string): string => `not(empty(${path}))`;

function layout(id: string, when?: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    ...(when ? { when } : {}),
    root: { id: `${id}-doc`, type: "pdf-document", configuration: {}, children: { body: [{ id: `${id}-title`, type: "pdf-text", configuration: { text: id } }] } }
  };
}

function field(id: string, configuration: Record<string, unknown> = {}, extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type: "text", configuration, ...extra };
}

function definitionOf(id: string, children: ComponentNode[], layouts: PdfGeneratedLayout[], journey?: Journey): FormDefinition {
  return {
    id,
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: { id: "form", type: "form", configuration: { title: id }, children: { content: children } },
    pdf: { layouts: [layout("standard"), ...layouts], defaultLayoutId: "standard" },
    ...(journey ? { journey: { journeys: [journey] } } : {})
  };
}

/** A province in a container (its answer travels as `address.province`), and a detail asked only of Quebec, hidden otherwise by `behaviour`. */
function provinces(behaviour: "clear" | "exclude-from-submission" | "retain"): FormDefinition {
  return definitionOf(
    `provinces-${behaviour}`,
    [
      field("name", { required: true }),
      { id: "address", type: "container", configuration: {}, children: { content: [field("province", {}, { type: "select" })] } },
      field("detail", { hiddenValueBehavior: behaviour }, { rules: { visibleWhen: eq("province", "QC") } })
    ],
    [layout("detailed", eq("detail", "oui")), layout("quebec", eq("province", "QC"))]
  );
}

/** The Rules tab's "ratio / does not equal / null" row. */
const ratioKnown = "ratio != null";

/**
 * A household ratio that has no answer when the household is left empty or 0 (`undefined` in
 * the browser, no key on the wire), read by a field's visibility, a route and a layout's `when`.
 */
function household(): FormDefinition {
  return definitionOf(
    "household",
    [
      field("income", { required: true }, { type: "number" }),
      field("members", {}, { type: "number" }),
      field("ratio", {}, { type: "number", rules: { value: "income / members" } }),
      field("explain", { required: true }, { rules: { visibleWhen: ratioKnown } }),
      field("shared", { required: true }),
      field("contact")
    ],
    [layout("per-person", ratioKnown)],
    {
      id: "household",
      pages: [
        { id: "money", components: ["income", "members", "ratio", "explain"], routes: [{ when: ratioKnown, to: "reach" }] },
        { id: "sharing", components: ["shared"] },
        { id: "reach", components: ["contact"], routes: [{ to: "$end" }] }
      ]
    }
  );
}

/** A layout chosen by a key no component owns: `campaign`, set by a host. */
function campaign(): FormDefinition {
  return definitionOf("campaign", [field("name", { required: true })], [layout("campaign", eq("campaign", "spring"))]);
}

const bigOrder = "`orders[0].qty` > 5";

/**
 * A data grid whose rows the runtime keeps at `orders[i].<column>`: the first row's quantity
 * asks for `rush` and chooses the bulk layout. The rows are keys the schema defines.
 */
function orders(): FormDefinition {
  const grid: ComponentNode = {
    id: "orders_grid",
    type: "dataGrid",
    // No starting rows: the browser holds the rows the test adds.
    configuration: { initialRows: 0 },
    collection: { collectionPath: "orders" },
    children: {
      content: [
        { id: "qty", type: "number", configuration: {} },
        { id: "sku", type: "text", configuration: {} }
      ]
    }
  };
  return definitionOf("orders", [grid, field("rush", { required: true }, { rules: { visibleWhen: bigOrder } })], [layout("bulk", bigOrder)]);
}

/** A required ratio: no answer in the browser when the household is left empty, no key on the wire. */
function requiredRatio(): FormDefinition {
  return definitionOf(
    "required-ratio",
    [
      field("income", { required: true }, { type: "number" }),
      field("members", {}, { type: "number" }),
      field("ratio", { required: true }, { type: "number", rules: { value: "income / members" } })
    ],
    []
  );
}

/** The sandbox program in QuickJS, as a server sample runs it: one host for the file. */
const quickJsPromise = sandboxProgramHost();

afterAll(async () => {
  (await quickJsPromise).dispose();
});

/** Both ways a server judges: the kernel in-process and the sandbox program in QuickJS. */
async function validators(): Promise<Array<[string, SubmissionValidator]>> {
  return [
    ["kernel", createKernelValidator()],
    ["quickjs", createProgramHostValidator(await quickJsPromise)]
  ];
}

/** Eligibility: the employed path skips the page that asks for a business. */
function eligibility(): FormDefinition {
  return definitionOf(
    "eligibility",
    [
      field("resident", { required: true }, { type: "select" }),
      field("employed", {}, { type: "checkbox" }),
      field("business_name", { required: true }),
      field("employer", { required: true }),
      field("email", { required: true })
    ],
    [layout("self-employed", answered("business_name")), layout("employee", answered("employer"))],
    {
      id: "apply",
      pages: [
        { id: "residency", components: ["resident"] },
        { id: "work", components: ["employed"], routes: [{ when: eq("employed", true), to: "employment" }] },
        { id: "self", components: ["business_name"], routes: [{ to: "contact" }] },
        { id: "employment", components: ["employer"] },
        { id: "contact", components: ["email"], routes: [{ to: "$end" }] }
      ]
    }
  );
}

const fontsPromise = loadFontPack({ entries: DEFAULT_FONT_PACK.filter((entry) => entry.id.startsWith("dejavu-sans")) });

/** The browser's provider: what it renders does not matter here, only which layout the page chose. */
const bytesless: PdfRenderProvider = {
  id: "fake",
  abiVersion: "1.0.0",
  render: async () => ({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), pageCount: 1, pages: [], warnings: [], providerId: "fake" })
};

const environment = { now: () => "2026-09-27T12:00:00.000Z", newDocumentId: () => "doc-1" };

interface Sides {
  /** The raw state's choice: what a download would print were it to read `state().values`. */
  raw: string | undefined;
  browser: { layoutId: string; layoutChoice: string };
  server: { layoutId: string | undefined; layoutChoice: string | undefined };
  record: SubmissionRecord;
}

interface SideOptions {
  /** The server's settings beside the PDF's (its `unknownFields`, say). */
  settings?: Partial<SubmissionSettings>;
  /** The envelope as a server over HTTP receives it: its JSON, parsed. Else the object, in-process. */
  wire?: boolean;
  /** How the server judges. Default: the kernel in-process. */
  validator?: SubmissionValidator;
  /** What the person does after the answers are set: rows added to a grid. */
  after?: (runtime: FormRuntime) => void;
}

/** The person answers in a FormRuntime and downloads; then submits, and the server receives it. */
async function bothSides(definition: FormDefinition, steps: Array<[string, unknown]>, options: SideOptions = {}): Promise<Sides> {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
  for (const [path, value] of steps) {
    runtime.setValue(path, value);
  }
  options.after?.(runtime);
  const predicted = selectPdfLayoutForValues(definition, runtime.submittableValues());
  const downloaded = await renderFormPdf(runtime, { provider: bytesless, environment });
  // The public predictor and the download agree: one view, one evaluator.
  expect({ layoutId: downloaded.layoutId, layoutChoice: downloaded.layoutChoice }).toEqual({ layoutId: predicted.layout?.id, layoutChoice: predicted.choice });
  const raw = selectPdfLayoutForValues(definition, runtime.state().values).layout?.id;

  const submitted = await runtime.submit("submit", {
    form: { id: definition.id, version: definition.version },
    client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" }
  });
  expect(submitted.accepted, JSON.stringify(submitted.errors)).toBe(true);

  // The server registers the exact definition the runtime was built from.
  const service = createSubmissionService({
    store: new InMemorySubmissionStore(),
    validator: options.validator ?? createKernelValidator(),
    pdf: createProviderPdfRenderer({ provider: createInProcessPdfProvider(), fonts: await fontsPromise, build: handlePdfRequest }),
    ids: () => "rec-1"
  });
  await service.register(definition, { ...options.settings, pdf: { enabled: true, sign: false, attachSubmission: false } });
  const document = options.wire ? (JSON.parse(JSON.stringify(submitted.canonicalSubmission)) as typeof submitted.canonicalSubmission) : submitted.canonicalSubmission;
  const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document: document! });
  expect(record.status, JSON.stringify(record.errors)).toBe("accepted");
  expect(record.pdf, JSON.stringify(record.logs)).toBeDefined();
  // What the server printed is what its judged values choose.
  expect(selectPdfLayoutForValues(definition, recordValuesOf(record)).layout?.id).toBe(record.pdf?.layoutId);
  return {
    raw,
    browser: { layoutId: downloaded.layoutId, layoutChoice: downloaded.layoutChoice },
    server: { layoutId: record.pdf?.layoutId, layoutChoice: record.pdf?.layoutChoice },
    record
  };
}

describe("a layout chosen by the answers: the browser's download and the server's PDF agree", () => {
  it("chooses by an answer in a container, and falls back to the declared default", async () => {
    const quebec = await bothSides(provinces("retain"), [["name", "Ada"], ["address.province", "QC"]]);
    expect(quebec.browser).toEqual({ layoutId: "quebec", layoutChoice: "condition" });
    expect(quebec.server).toEqual(quebec.browser);

    const ontario = await bothSides(provinces("retain"), [["name", "Ada"], ["address.province", "ON"]]);
    expect(ontario.browser).toEqual({ layoutId: "standard", layoutChoice: "default" });
    expect(ontario.server).toEqual(ontario.browser);
  });

  it("lets no hidden answer the submission leaves out choose, excluded or cleared, while a retained one chooses on both sides", async () => {
    const leftQuebec: Array<[string, unknown]> = [["name", "Ada"], ["address.province", "QC"], ["detail", "oui"], ["address.province", "ON"]];
    for (const behaviour of ["clear", "exclude-from-submission"] as const) {
      const sides = await bothSides(provinces(behaviour), leftQuebec);
      expect(sides.browser, behaviour).toEqual({ layoutId: "standard", layoutChoice: "default" });
      expect(sides.server, behaviour).toEqual(sides.browser);
    }
    // The raw state still holds "oui" under the exclusion; reading it would have printed the detailed copy.
    expect((await bothSides(provinces("exclude-from-submission"), leftQuebec)).raw).toBe("detailed");
    // Retained, the hidden answer is submitted, so it chooses — the same way on both sides.
    const retained = await bothSides(provinces("retain"), leftQuebec);
    expect(retained.browser).toEqual({ layoutId: "detailed", layoutChoice: "condition" });
    expect(retained.server).toEqual(retained.browser);
    // Shown and answered, it chooses before the province's own layout.
    const shown = await bothSides(provinces("clear"), [["name", "Ada"], ["address.province", "QC"], ["detail", "oui"]]);
    expect(shown.browser).toEqual({ layoutId: "detailed", layoutChoice: "condition" });
    expect(shown.server).toEqual(shown.browser);
  });

  it("lets no answer on a journey branch the person left choose, where the raw state would", async () => {
    const employed = await bothSides(eligibility(), [
      ["resident", "yes"],
      ["business_name", "Left over"],
      ["employed", true],
      ["employer", "ACME"],
      ["email", "a@b.co"]
    ]);
    expect(employed.raw).toBe("self-employed");
    expect(employed.browser).toEqual({ layoutId: "employee", layoutChoice: "condition" });
    expect(employed.server).toEqual(employed.browser);

    const selfEmployed = await bothSides(eligibility(), [
      ["resident", "yes"],
      ["business_name", "Shop"],
      ["email", "a@b.co"]
    ]);
    expect(selfEmployed.browser).toEqual({ layoutId: "self-employed", layoutChoice: "condition" });
    expect(selfEmployed.server).toEqual(selfEmployed.browser);
  });

  it("reads a calculation that came to no answer as the missing answer the envelope carries, for the field, the route and the layout alike", async () => {
    // The household left empty, then 0: the ratio is undefined in the browser's state, no key on the wire.
    for (const members of [undefined, 0]) {
      const steps: Array<[string, unknown]> = [["income", 1200], ...(members !== undefined ? [["members", members] as [string, unknown]] : []), ["shared", "yes"]];
      for (const wire of [false, true]) {
        const sides = await bothSides(household(), steps, { wire });
        const label = `members ${String(members)}, ${wire ? "over the wire" : "in-process"}`;
        // Not "per-person": `ratio` reads as nothing (`ratio != null` is false), so `explain` is not asked and the route not taken on either side.
        expect(sides.browser, label).toEqual({ layoutId: "standard", layoutChoice: "default" });
        expect(sides.server, label).toEqual(sides.browser);
        expect(sides.raw, label).toBe("standard");
        expect(recordValuesOf(sides.record).ratio, label).toBeUndefined();
        expect("ratio" in recordValuesOf(sides.record), label).toBe(false);
        expect(sides.record.errors, label).toEqual([]);
        // The server had nothing to work out differently: the ratio it judged is the one sent.
        expect(sides.record.logs?.some((entry) => entry.message === "calculations recomputed") ?? false, label).toBe(false);
      }
    }
    const known = await bothSides(household(), [["income", 1200], ["members", 3], ["explain", "three of us"]]);
    expect(known.browser).toEqual({ layoutId: "per-person", layoutChoice: "condition" });
    expect(known.server).toEqual(known.browser);
  });

  it("lets a key no component owns choose nothing, whether the server strips unknown fields or keeps them", async () => {
    for (const unknownFields of ["strip", "keep"] as const) {
      const sides = await bothSides(campaign(), [["campaign", "spring"], ["name", "Ada"]], { settings: { validation: { unknownFields, logLevel: "info" } } });
      expect(sides.browser, unknownFields).toEqual({ layoutId: "standard", layoutChoice: "default" });
      expect(sides.server, unknownFields).toEqual(sides.browser);
      // The raw state holds the host's key too, and it still chooses nothing.
      expect(sides.raw, unknownFields).toBe("standard");
    }
  });

  it("reads a data grid's cell on both sides, and keeps the grid's rows whether the server strips unknown fields or keeps them, judged in-process or in QuickJS", async () => {
    for (const [qty, expected] of [
      [10, "bulk"],
      [2, "standard"]
    ] as const) {
      for (const [name, validator] of await validators()) {
        for (const unknownFields of ["strip", "keep"] as const) {
          const label = `qty ${qty}, ${name}, ${unknownFields}`;
          const sides = await bothSides(orders(), [["rush", "today"]], {
            validator,
            settings: { validation: { unknownFields, logLevel: "info" } },
            after: (runtime) => {
              runtime.addRow("orders", { qty, sku: "A1" });
              runtime.addRow("orders", { qty: 1, sku: "B2" });
            }
          });
          expect(sides.browser.layoutId, label).toBe(expected);
          expect(sides.server, label).toEqual(sides.browser);
          // The rows are what the record stands for, not only what it was delivered with. `rush`
          // is hidden below five and left out by default, so only the big order carries it.
          expect(recordValuesOf(sides.record), label).toStrictEqual({ "orders[0].qty": qty, "orders[0].sku": "A1", "orders[1].qty": 1, "orders[1].sku": "B2", ...(qty > 5 ? { rush: "today" } : {}) });
        }
      }
    }
  });
});

describe("the browser's verdict and the server's agree on a required calculation that comes to no answer", () => {
  it("refuses it as unanswered in the browser with no sandbox, and in the service judged in-process or in QuickJS", async () => {
    const definition = requiredRatio();
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
    const client = { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" };
    for (const members of [undefined, 0, 3]) {
      const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
      runtime.setValue("income", 1200);
      if (members !== undefined) {
        runtime.setValue("members", members);
      }
      const label = `members ${String(members)}`;
      const answered = members === 3;
      const browser = await runtime.submit("submit", { form: { id: definition.id, version: definition.version }, client });
      expect(browser.errors.map((error) => `${error.componentId}:${error.code}`), label).toEqual(answered ? [] : ["ratio:required"]);
      // What the same answers send with no validation: what a server would be handed.
      const sent = await runtime.submit("send", { form: { id: definition.id, version: definition.version }, client });
      for (const [name, validator] of await validators()) {
        const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator, ids: () => "rec-1" });
        await service.register(definition);
        const { record, errors } = await service.receive({ submissionKey: crypto.randomUUID(), document: JSON.parse(JSON.stringify(sent.canonicalSubmission)) as NonNullable<typeof sent.canonicalSubmission> });
        expect(errors.map((error) => `${error.componentId}:${error.code}`), `${label}, ${name}`).toEqual(answered ? [] : ["ratio:required"]);
        expect(record.status, `${label}, ${name}`).toBe(answered ? "accepted" : "rejected");
      }
    }
  });
});
