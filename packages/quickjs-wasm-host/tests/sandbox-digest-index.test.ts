import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  WASM_ABI_VERSION,
  WasmValidationHost,
  serializeCanonicalSubmission,
  stableStringify,
  type ComponentNode,
  type WasmSubmissionOutcome,
  type WasmValidatorInstance
} from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, toSourcePlugin } from "../src/index.js";

/**
 * The real sandbox against the in-process adapter: a run's
 * `canonical`, `digest` and `index`, its choice-answer check over `optionSnapshot`, and the
 * `inspect` op's `paths` answer byte-identical JSON, and the digest is Node's SHA-256 over the
 * canonical text.
 */

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "fullName", type: "text", configuration: { required: true } },
      { id: "colours", type: "checkboxes", configuration: { options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] } },
      { id: "tags", type: "tags", configuration: {} },
      { id: "contact", type: "container", configuration: {}, children: { content: [{ id: "email", type: "email", configuration: {} }] } },
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { collectionPath: "items" },
        children: { content: [{ id: "sku", type: "text", configuration: {} }, { id: "qty", type: "number", configuration: {} }] }
      },
      // A grid: its field a number keyed `qty` in each row.
      { id: "orders_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [{ id: "order_qty", type: "number", configuration: { label: "Qty", dataKey: "qty" } }] } },
      { id: "go", type: "button", configuration: {} },
      { id: "box", type: "fieldset", configuration: {}, children: { content: [{ id: "note", type: "textarea", configuration: {} }] } }
    ]
  }
};

const values = {
  fullName: "Zoë Ångström",
  colours: { red: true, blue: false },
  tags: ["x", "y"],
  "contact.email": "zoe@example.org",
  "items[0].sku": "A-1",
  "items[0].qty": 3,
  "items[1].sku": "B-2",
  "orders[0].qty": 2,
  note: "\u{1F600} ok",
  forged: "dropped"
};

const envelope = {
  versionContext: { form: { id: "contact", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
  submission: { locale: "fr", values: { ...values, B: 1, a: 2, a_b: 3, ab: 4, "\u{1F600}": 5, "10": 6, "2": 7 } }
};

const wrapper = {
  format: { scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" },
  payload: envelope,
  signatures: [{ provider: "demo", value: "c2ln", participantId: "p", signedAt: "2026-10-07T00:00:00Z" }]
};

describe("sandbox: QuickJS and the in-process kernel agree on the digest, the index and the paths", () => {
  const abi = new JsonWasmAbi();
  let inProcess: WasmValidatorInstance;
  let quickJs: WasmValidatorInstance;

  beforeAll(async () => {
    inProcess = new InProcessWasmHostAdapter().instantiate([], abi);
    quickJs = await new QuickJsWasmHostAdapter().instantiate([], abi);
  });

  afterAll(() => {
    quickJs.dispose?.();
  });

  async function run(context: Record<string, unknown>): Promise<WasmSubmissionOutcome> {
    const payload = abi.serializeContext({ formId: "contact", locale: "fr", form: root, values, ...context } as never, WasmValidationHost.STRICT_POLICY);
    const fromKernel = await inProcess.run(payload);
    const fromSandbox = await quickJs.run(payload);
    expect(fromSandbox).toBe(fromKernel);
    return abi.deserializeOutcome(fromKernel);
  }

  it("returns the canonical text and digest of an envelope and of a wrapper, as Node hashes them", async () => {
    for (const document of [envelope, wrapper]) {
      const outcome = await run({ document });
      expect(outcome.canonical).toBe(stableStringify(document));
      expect(outcome.digest).toBe(createHash("sha256").update(Buffer.from(outcome.canonical as string, "utf8")).digest("hex"));
    }
    expect((await run({ document: envelope })).canonical).toBe(serializeCanonicalSubmission(envelope as never));
  });

  it("hashes a large document the same (about 200 KB), given a budget to match", async () => {
    // The sandbox hashes about 1 MB a second, inside the run's budget; the default budget grows by
    // 2 ms per kilobyte of the request, so a host need not raise `maxEvalMs` for a document. This
    // one is set, to hold the hash to the in-process one however slow the machine.
    const roomy = await new QuickJsWasmHostAdapter({ maxEvalMs: 10_000 }).instantiate([], abi);
    const big = { ...envelope, submission: { locale: "fr", values: Object.fromEntries(Array.from({ length: 4000 }, (_, index) => [`k${index}`, `value ${index} café \u{1F600}`])) } };
    const payload = abi.serializeContext({ formId: "contact", locale: "fr", form: root, values, document: big } as never, WasmValidationHost.STRICT_POLICY);
    const fromSandbox = await roomy.run(payload);
    expect(fromSandbox).toBe(await inProcess.run(payload));
    expect(abi.deserializeOutcome(fromSandbox).digest).toBe(createHash("sha256").update(Buffer.from(stableStringify(big), "utf8")).digest("hex"));
    roomy.dispose?.();
  });

  it("returns the index of the sanitized values, the forged key left out", async () => {
    const outcome = await run({});
    expect(outcome.errors).toEqual([]);
    expect(outcome.canonical).toBeUndefined();
    expect(outcome.index).toEqual([
      { path: "colours", delta: "", value: { blue: false, red: true } },
      { path: "contact.email", delta: "", value: "zoe@example.org" },
      { path: "fullName", delta: "", value: "Zoë Ångström" },
      { path: "items.qty", delta: "0", value: 3 },
      { path: "items.sku", delta: "0", value: "A-1" },
      { path: "items.sku", delta: "1", value: "B-2" },
      { path: "note", delta: "", value: "\u{1F600} ok" },
      { path: "orders.qty", delta: "0", value: 2 },
      { path: "tags", delta: "0", value: "x" },
      { path: "tags", delta: "1", value: "y" }
    ]);
    const blocked = await run({ values: {}, document: envelope });
    expect(blocked.index).toBeUndefined();
    expect(blocked.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("holds choice answers to the option snapshot alike, a hidden retained answer included", async () => {
    const choices: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "province", type: "select", configuration: { hidden: true, hiddenValueBehavior: "retain", data: { sourceId: "provinces" } } },
          { id: "colours", type: "checkboxes", configuration: { options: [{ value: "red", label: "Red" }] } }
        ]
      }
    };
    const optionSnapshot = { provinces: [{ value: "ON", label: "Ontario" }] };
    const refused = await run({ form: choices, values: { province: "XX", colours: { red: true, green: true } }, optionSnapshot });
    expect(refused.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["province:option.notAllowed", "colours:option.notAllowed"]);
    // A source the snapshot lacks fails closed, alike in QuickJS and in process.
    const unavailable = await run({ form: choices, values: { province: "XX", colours: { red: true, green: false } }, optionSnapshot: {} });
    expect(unavailable.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["province:option.sourceUnavailable"]);
    // An answer that picks nothing needs no source; the inline options of `colours` are checked as ever.
    expect((await run({ form: choices, values: { colours: { red: true } }, optionSnapshot: {} })).errors).toEqual([]);
  });

  it("reads rows posted whole as flat keys alike, flat keys winning over a list beside them", async () => {
    const outcome = await run({ values: { fullName: "Ada", items: [{ sku: "A-1", qty: 2 }], orders: [{ qty: 1 }], extra: 1 } });
    expect(outcome.values).toEqual({ fullName: "Ada", "items[0].sku": "A-1", "items[0].qty": 2, "orders[0].qty": 1 });
    const both = await run({ values: { fullName: "Ada", items: [{ sku: "ZZ" }], "items[0].sku": "A-1" }, logLevel: "info" });
    expect(both.values).toEqual({ fullName: "Ada", "items[0].sku": "A-1" });
    const malformed = await run({ values: { fullName: "Ada", items: "A-1" }, unknownFields: "reject" });
    expect(malformed.errors.map((error) => error.parameters?.field)).toEqual(["items"]);
  });

  it("names the document as sent alike when a validator rewrites it or throws", async () => {
    const plugin = {
      id: "p",
      version: "1.0.0",
      validators: [
        {
          id: "rewrite",
          version: "1.0.0",
          validate(context: { document?: { submission?: { locale?: string } } }) {
            if (context.document && context.document.submission) {
              context.document.submission.locale = "xx";
            }
            return { errors: [] };
          }
        },
        {
          id: "throw",
          version: "1.0.0",
          validate() {
            throw new Error("boom");
          }
        }
      ]
    };
    const inProcessPlugged = new InProcessWasmHostAdapter().instantiate([plugin as never], abi);
    const quickJsPlugged = await new QuickJsWasmHostAdapter().instantiate([toSourcePlugin(plugin as never)], abi);
    const payload = abi.serializeContext({ formId: "contact", locale: "fr", form: root, values, document: envelope } as never, WasmValidationHost.STRICT_POLICY);
    const fromSandbox = await quickJsPlugged.run(payload);
    expect(fromSandbox).toBe(await inProcessPlugged.run(payload));
    const outcome = abi.deserializeOutcome(fromSandbox);
    expect(outcome.errors).toEqual([{ code: "validator.failed", stage: "validation", source: "wasm", parameters: { validator: 2 } }]);
    expect(outcome.canonical).toBe(stableStringify(envelope));
    quickJsPlugged.dispose?.();
  });

  it("answers inspect's paths alike", async () => {
    const request = stableStringify({ abi: WASM_ABI_VERSION, op: "inspect", definition: { id: "contact", version: "1", schemaVersion: "1", root } });
    const fromKernel = await inProcess.inspect!(request);
    const fromSandbox = await quickJs.inspect!(request);
    expect(fromSandbox).toBe(fromKernel);
    const answer = JSON.parse(fromKernel) as { paths: Array<{ path: string; holdsData: boolean }> };
    expect(answer.paths.map((entry) => `${entry.path}:${entry.holdsData}`)).toEqual([
      "fullName:true",
      "colours:true",
      "tags:true",
      "contact:true",
      "contact.email:true",
      "items:true",
      "items.sku:true",
      "items.qty:true",
      "orders:true",
      "orders.qty:true",
      "go:false",
      "box:false",
      "note:true"
    ]);
  });
});
