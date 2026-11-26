import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PORTABLE_KERNEL_FUNCTIONS,
  kernelDefinitionPaths,
  kernelDocumentDigest,
  kernelFlattenRows,
  kernelKnownValuePaths,
  kernelNormalizeDataGrids,
  kernelRowListPaths,
  kernelSha256Hex,
  kernelUtf8Binary,
  kernelValueIndex,
  runInspect,
  runKernel
} from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION, WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { sha256 } from "../form-engine/core/crypto/sha256.js";
import { serializeCanonicalSubmission, type CanonicalSubmission } from "../form-engine/core/submission/canonical-submission.js";
import { buildDataPaths, holdsData } from "../form-engine/core/tree/data-scope.js";
import { readCollectionRows } from "../form-engine/render/pdf/pdf-values.js";
import { resolveValidationMessage } from "../form-engine/core/localization/validation-messages.js";
import { formulaFunctionSignatures, FORMULA_FUNCTION_NAMES } from "../form-engine/core/expressions/function-table.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";

/**
 * What a run says beside the verdict (the delivered document's canonical
 * text and digest, the flat value index) and what `inspect` says of a definition (every value
 * path the kernel reads). Kernel-shaped, so the in-process adapter and the QuickJS sandbox
 * answer the same bytes (`packages/quickjs-wasm-host/tests/quickjs-kernel-parity.test.ts`).
 */

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nodeSha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Recursive code-unit key sort, written apart from the kernel's, for the cross-check. */
function codeUnitSorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(codeUnitSorted);
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((key) => [key, codeUnitSorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

const envelope: CanonicalSubmission = {
  versionContext: {
    form: { id: "contact", version: "1.0.0" },
    client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" }
  },
  submission: {
    locale: "fr",
    // Keys where code-unit order and ICU collation part: case, punctuation, astral plane.
    values: { fullName: "Zoë Ångström", B: 1, a: 2, a_b: "x", ab: "y", "\u{1F600}": "emoji", "items[0].sku": "A-1", "10": 10, "2": 2, ratio: 0.1, big: 1e21 }
  }
};

const wrapper = {
  format: { scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" },
  payload: envelope,
  signatures: [{ provider: "demo", value: "c2lnbmF0dXJl", participantId: "p", signedAt: "2026-10-07T00:00:00Z" }]
};

describe("kernel SHA-256", () => {
  it("matches the engine's sha256 and Node's crypto for every length 0..200 and the padding boundaries", () => {
    const lengths = new Set<number>();
    for (let length = 0; length <= 200; length += 1) {
      lengths.add(length);
    }
    for (const length of [55, 56, 63, 64, 119, 120, 1000, 4096]) {
      lengths.add(length);
    }
    for (const length of lengths) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 31 + length * 7 + 13) & 0xff;
      }
      const expected = nodeSha(bytes);
      expect(kernelSha256Hex(Buffer.from(bytes).toString("latin1")), `length ${length}`).toBe(expected);
      expect(hex(sha256(bytes)), `engine sha256 at ${length}`).toBe(expected);
    }
  });

  it("hashes the known vectors", () => {
    expect(kernelSha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(kernelSha256Hex(kernelUtf8Binary("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(kernelSha256Hex(kernelUtf8Binary("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
  });

  it("encodes UTF-8 as TextEncoder does, one character per byte, a lone surrogate as U+FFFD", () => {
    const encoder = new TextEncoder();
    for (const text of ["", "plain", "café", "你好", "\u{1F600}", "a\u{10FFFF}z", "\u007f\u0080߿ࠀ￿", "\ud800", "x\udc00y", "\ud83d", "\ud83d😀"]) {
      const binary = kernelUtf8Binary(text);
      expect(Array.from(binary, (char) => char.charCodeAt(0)), JSON.stringify(text)).toEqual(Array.from(encoder.encode(text)));
    }
  });
});

describe("the delivered document's canonical text and digest", () => {
  it("equals the engine's canonical serializer and Node's sha256 over the code-unit sorted JSON", () => {
    const named = kernelDocumentDigest(envelope);
    const sorted = JSON.stringify(codeUnitSorted(envelope));
    expect(named.canonical).toBe(sorted);
    expect(named.canonical).toBe(serializeCanonicalSubmission(envelope));
    expect(named.digest).toBe(nodeSha(Buffer.from(sorted, "utf8")));
    // What `submissionDigest` (@argusvane/datum-submissions) computes: the engine's sha256 over those bytes.
    expect(named.digest).toBe(hex(sha256(new TextEncoder().encode(serializeCanonicalSubmission(envelope)))));
    expect(named.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("comes back from a run beside the verdict, through the serialized context, for an envelope and a wrapper", () => {
    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const form: ComponentNode = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "fullName", type: "text", configuration: {} }] } };
    for (const document of [envelope, wrapper]) {
      const payload = abi.serializeContext({ formId: "contact", locale: "fr", values: { fullName: "Zoë" }, form, document }, WasmValidationHost.STRICT_POLICY);
      const outcome = abi.deserializeOutcome(instance.run(payload) as string);
      expect(outcome.canonical).toBe(JSON.stringify(codeUnitSorted(document)));
      expect(outcome.digest).toBe(nodeSha(Buffer.from(JSON.stringify(codeUnitSorted(document)), "utf8")));
      // The document as sent round-trips: its canonical text parses back to the same document.
      expect(JSON.parse(outcome.canonical as string)).toEqual(JSON.parse(JSON.stringify(document)));
    }
    // A wrapper's digest covers the signatures around the envelope.
    expect(kernelDocumentDigest(wrapper).digest).not.toBe(kernelDocumentDigest(envelope).digest);
  });

  it("names the document as sent, before any validator: one that rewrites it, or throws, changes nothing", () => {
    const form: ComponentNode = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: {} }] } };
    const document = { submission: { values: { name: "Ada" } } };
    const sent = kernelDocumentDigest(JSON.parse(JSON.stringify(document)));
    const seen: unknown[] = [];
    const mutating = runKernel({ formId: "f", locale: "en", form, values: { name: "Ada" }, document }, [
      (context) => {
        seen.push((context as unknown as { document?: unknown }).document);
        const reach = (context as unknown as { document?: { submission: { values: { name: string } } } }).document;
        if (reach !== undefined) {
          reach.submission.values.name = "Mallory";
        }
        return { errors: [] };
      }
    ]);
    expect(seen).toEqual([undefined]);
    expect(document.submission.values.name).toBe("Ada");
    expect(mutating.canonical).toBe(sent.canonical);
    expect(mutating.digest).toBe(sent.digest);
    const throwing = runKernel({ formId: "f", locale: "en", form, values: { name: "Ada" }, document, logLevel: "error" }, [
      () => {
        throw new Error("boom");
      }
    ]);
    expect(throwing.errors).toEqual([{ code: "validator.failed", stage: "validation", source: "wasm", parameters: { validator: 1 } }]);
    // The engine has words for it, so the person never reads the bare code.
    expect(resolveValidationMessage(throwing.errors[0]!, undefined, "en")).toBe("This answer could not be checked. Try again later.");
    expect(throwing.logs?.some((entry) => entry.level === "error" && entry.message === "validator 1 threw: boom")).toBe(true);
    expect(throwing.canonical).toBe(sent.canonical);
    expect(throwing.digest).toBe(sent.digest);
  });

  it("is there whatever the verdict, describes the document as sent, and is absent when none was sent", () => {
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "fullName", type: "text", configuration: { required: true } }] }
    };
    const blocked = runKernel({ formId: "contact", locale: "en", values: { stray: 1 }, form, document: envelope }, []);
    expect(blocked.errors.map((error) => error.code)).toEqual(["required"]);
    expect(blocked.values).toBeUndefined();
    expect(blocked.index).toBeUndefined();
    expect(blocked.canonical).toBe(serializeCanonicalSubmission(envelope));
    expect(blocked.digest).toBe(kernelDocumentDigest(envelope).digest);
    const none = runKernel({ formId: "contact", locale: "en", values: { fullName: "Ada" }, form }, []);
    expect("canonical" in none).toBe(false);
    expect("digest" in none).toBe(false);
  });
});

describe("the flat value index", () => {
  it("writes the ValueIndexer's rows: a scalar, a list of scalars, an entry field, an object, an empty list", () => {
    expect(
      kernelValueIndex({
        fullName: "Ada",
        tags: ["a", null, 3, true],
        "items[0].sku": "A-1",
        "items[1].sku": "B-2",
        "lines[2].parts[0]": ["x", "y"],
        colours: { red: true, blue: false },
        rows: [{ qty: 1 }],
        none: [],
        cleared: undefined,
        nothing: null
      })
    ).toEqual([
      { path: "colours", delta: "", value: { red: true, blue: false } },
      { path: "fullName", delta: "", value: "Ada" },
      { path: "items.sku", delta: "0", value: "A-1" },
      { path: "items.sku", delta: "1", value: "B-2" },
      { path: "lines.parts", delta: "2.0.0", value: "x" },
      { path: "lines.parts", delta: "2.0.1", value: "y" },
      { path: "nothing", delta: "", value: null },
      { path: "rows", delta: "", value: [{ qty: 1 }] },
      { path: "tags", delta: "0", value: "a" },
      { path: "tags", delta: "1", value: null },
      { path: "tags", delta: "2", value: 3 },
      { path: "tags", delta: "3", value: true }
    ]);
  });

  it("follows the serialized values' key order, integer-like keys first", () => {
    expect(kernelValueIndex({ b: 1, "10": 2, a: 3, "2": 4 }).map((row) => row.path)).toEqual(["2", "10", "a", "b"]);
  });

  it("is built from the sanitized values: a stripped unknown key and a withheld hidden answer are not indexed", () => {
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "fullName", type: "text", configuration: {} },
          { id: "colours", type: "checkboxes", configuration: { options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] } },
          { id: "tags", type: "tags", configuration: {} },
          { id: "contact", type: "container", configuration: {}, children: { content: [{ id: "email", type: "email", configuration: {} }] } },
          {
            id: "items",
            type: "repeatingSection",
            configuration: {},
            collection: { collectionPath: "items" },
            children: { content: [{ id: "sku", type: "text", configuration: {} }] }
          },
          { id: "secret", type: "text", configuration: { hidden: true, hiddenValueBehavior: "exclude-from-submission" } }
        ]
      }
    };
    const outcome = runKernel(
      {
        formId: "contact",
        locale: "en",
        form,
        values: {
          fullName: "Ada",
          colours: { red: true, blue: false },
          tags: ["x", "y"],
          "contact.email": "ada@example.org",
          "items[0].sku": "A-1",
          "items[1].sku": "B-2",
          forged: "nope",
          secret: "s"
        }
      },
      []
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toBeDefined();
    expect(outcome.index).toEqual(kernelValueIndex(outcome.values as Record<string, unknown>));
    const rows = (outcome.index ?? []).map((row) => `${row.path}|${row.delta}|${JSON.stringify(row.value)}`);
    expect(rows).toContain('fullName||"Ada"');
    expect(rows).toContain('colours||{"red":true,"blue":false}');
    expect(rows).toContain('tags|0|"x"');
    expect(rows).toContain('tags|1|"y"');
    expect(rows).toContain('contact.email||"ada@example.org"');
    expect(rows).toContain('items.sku|0|"A-1"');
    expect(rows).toContain('items.sku|1|"B-2"');
    expect(rows.some((row) => row.startsWith("forged|"))).toBe(false);
    // A hidden answer the fold withholds is neither a value nor a row.
    expect(Object.prototype.hasOwnProperty.call(outcome.values, "secret")).toBe(false);
    expect(rows.some((row) => row.startsWith("secret|"))).toBe(false);
  });
});

describe("the paths of a definition, from inspect", () => {
  // A column in the earlier shape; the kernel reads the grid normalized, each column's component a field of a row.
  const column = (id: string): ComponentNode => ({ id, type: "text", configuration: { label: id } });
  const root: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "fullName", type: "text", configuration: {} },
        {
          id: "contact",
          type: "container",
          configuration: { dataKey: "person" },
          children: {
            content: [
              { id: "contact_email", type: "email", configuration: { dataKey: "email" } },
              { id: "box", type: "fieldset", configuration: {}, children: { content: [{ id: "phone", type: "text", configuration: {} }] } }
            ]
          }
        },
        {
          id: "items",
          type: "repeatingSection",
          configuration: {},
          collection: { collectionPath: "lines" },
          children: {
            content: [
              { id: "sku", type: "text", configuration: {} },
              { id: "addr", type: "container", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: {} }] } }
            ]
          }
        },
        { id: "orders_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [column("qty"), column("price")] } },
        { id: "go", type: "button", configuration: {} },
        { id: "intro", type: "html", configuration: {} },
        { id: "bad_section", type: "repeatingSection", configuration: {}, collection: { collectionPath: "x[0]" }, children: { content: [{ id: "lost", type: "text", configuration: {} }] } }
      ]
    }
  };

  it("lists every component's path in document order with its type, holdsData and collection, a data grid as a section", () => {
    expect(kernelDefinitionPaths(root)).toEqual([
      { path: "fullName", componentId: "fullName", type: "text", holdsData: true },
      { path: "person", componentId: "contact", type: "container", holdsData: true },
      { path: "person.email", componentId: "contact_email", type: "email", holdsData: true },
      { path: "person.box", componentId: "box", type: "fieldset", holdsData: false },
      { path: "person.phone", componentId: "phone", type: "text", holdsData: true },
      { path: "lines", componentId: "items", type: "repeatingSection", holdsData: true, collection: { collectionPath: "lines" } },
      { path: "lines.sku", componentId: "sku", type: "text", holdsData: true, collection: { collectionPath: "lines" } },
      { path: "lines.addr", componentId: "addr", type: "container", holdsData: true, collection: { collectionPath: "lines" } },
      { path: "lines.addr.city", componentId: "city", type: "text", holdsData: true, collection: { collectionPath: "lines" } },
      { path: "orders", componentId: "orders_grid", type: "dataGrid", holdsData: true, collection: { collectionPath: "orders" } },
      { path: "orders.qty", componentId: "qty", type: "text", holdsData: true, collection: { collectionPath: "orders" } },
      { path: "orders.price", componentId: "price", type: "text", holdsData: true, collection: { collectionPath: "orders" } },
      { path: "go", componentId: "go", type: "button", holdsData: false },
      { path: "intro", componentId: "intro", type: "html", holdsData: false }
    ]);
  });

  it("agrees with the engine's buildDataPaths and holdsData for every component it lists", () => {
    // Over the tree as both sides read it: grids normalized.
    const read = kernelNormalizeDataGrids(root);
    const engine = buildDataPaths(read);
    const byId = new Map<string, ComponentNode>();
    const walk = (node: ComponentNode): void => {
      byId.set(node.id, node);
      for (const group of Object.values(node.children ?? {})) {
        group.forEach(walk);
      }
    };
    walk(read);
    for (const entry of kernelDefinitionPaths(root)) {
      expect(entry.path, entry.componentId).toBe((engine.get(entry.componentId) ?? "").replace(/\[\]/g, ""));
      expect(entry.holdsData, entry.componentId).toBe(holdsData(byId.get(entry.componentId) as ComponentNode));
    }
  });

  it("lists, as holding data, exactly the paths the allowlist knows: odd ids, a null collection, bracketed paths", () => {
    const odd: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "items", type: "repeatingSection", configuration: {}, collection: { collectionPath: "bad[0]" }, children: { content: [{ id: "sku", type: "select", configuration: {} }] } },
          {
            id: "c",
            type: "container",
            configuration: {},
            children: { content: [{ id: 7, type: "text" } as unknown as ComponentNode, { id: "p", type: "select", configuration: {} }] }
          },
          { id: "g", type: "dataGrid", configuration: {}, collection: { collectionPath: "rows[1]" } },
          { id: "n", type: "select", collection: null, configuration: {} } as unknown as ComponentNode
        ]
      }
    };
    for (const tree of [root, odd]) {
      const listed = kernelDefinitionPaths(tree).filter((entry) => entry.holdsData).map((entry) => entry.path);
      expect([...new Set(listed)].sort()).toEqual(Object.keys(kernelKnownValuePaths(kernelNormalizeDataGrids(tree))).sort());
    }
    // A grid whose rows would live at a bracketed path is a section with such a path: left out with its subtree.
    expect(kernelDefinitionPaths(odd).map((entry) => `${entry.path}:${entry.componentId}`)).toEqual(["c:c", "c.7:7", "c.p:p", "n:n"]);
  });

  it("joins the run's index: every indexed path of a run over the form is a listed path that holds data", () => {
    const outcome = runKernel(
      {
        formId: "f",
        locale: "en",
        form: root,
        values: { fullName: "Ada", "person.email": "a@b.co", "person.phone": "1", "lines[0].sku": "A", "lines[0].addr.city": "Ottawa", "orders[0].qty": "2", go: "x" }
      },
      []
    );
    const listed = new Set(kernelDefinitionPaths(root).filter((entry) => entry.holdsData).map((entry) => entry.path));
    expect((outcome.index ?? []).map((row) => row.path).sort()).toEqual(["fullName", "lines.addr.city", "lines.sku", "orders.qty", "person.email", "person.phone"]);
    for (const row of outcome.index ?? []) {
      expect(listed.has(row.path), row.path).toBe(true);
    }
  });

  it("is in the inspect op's answer, through the host, and pure over the definition", async () => {
    const definition: FormDefinition = { id: "f", version: "1", schemaVersion: "1", root };
    const before = JSON.stringify(definition);
    const answer = runInspect({ abi: WASM_ABI_VERSION, op: "inspect", definition }, formulaFunctionSignatures(), [...FORMULA_FUNCTION_NAMES]);
    if (!answer.ok || answer.op !== "inspect") {
      throw new Error("not an inspect answer");
    }
    expect(answer.paths).toEqual(kernelDefinitionPaths(root));
    const host = createInProcessWasmValidationHost([]);
    const through = await host.inspect({ op: "inspect", definition });
    expect(through).toMatchObject({ ok: true, op: "inspect", paths: kernelDefinitionPaths(root) });
    expect(JSON.stringify(definition)).toBe(before);
    // The other ops say nothing of paths.
    expect("paths" in runInspect({ abi: WASM_ABI_VERSION, op: "check", definition })).toBe(false);
  });

  it("skips a node that is not a record and a slot that is not a list, and reads a tree 3,000 deep", () => {
    const odd: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [7 as unknown as ComponentNode, { id: "a", type: "text", configuration: {} }], other: "x" as unknown as ComponentNode[] }
    };
    expect(kernelDefinitionPaths(odd).map((entry) => entry.path)).toEqual(["a"]);
    let leaf: ComponentNode = { id: "leaf", type: "text", configuration: {} };
    for (let depth = 0; depth < 3000; depth += 1) {
      leaf = { id: `c${depth}`, type: "container", configuration: { scopeData: false }, children: { content: [leaf] } };
    }
    const paths = kernelDefinitionPaths({ id: "form", type: "form", configuration: {}, children: { content: [leaf] } });
    expect(paths).toHaveLength(3001);
    expect(paths[3000]).toEqual({ path: "leaf", componentId: "leaf", type: "text", holdsData: true });
  });
});

describe("kernel shape", () => {
  it("splices the new functions into the program, with no clock, locale or randomness", () => {
    const forbidden = /\bDate\b|\bIntl\b|Math\.random|localeCompare|TextEncoder/;
    for (const fn of [kernelUtf8Binary, kernelSha256Hex, kernelDocumentDigest, kernelValueIndex, kernelDefinitionPaths, kernelFlattenRows, kernelRowListPaths]) {
      expect(PORTABLE_KERNEL_FUNCTIONS, fn.name).toContain(fn);
      expect(fn.toString().trimStart().startsWith("function "), fn.name).toBe(true);
      expect(fn.toString(), fn.name).not.toMatch(forbidden);
    }
    expect(WASM_ABI_VERSION).toBe("4.1.0");
  });
});

describe("choice answers held to the host's option snapshot in a run", () => {
  const form: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "province",
          type: "select",
          configuration: { hidden: true, hiddenValueBehavior: "retain", data: { sourceId: "provinces" } }
        }
      ]
    }
  };
  const snapshot = { provinces: [{ value: "ON", label: "Ontario" }, { value: "QC" }] };

  it("refuses an answer outside the snapshot on a hidden component the form retains, and stores none", () => {
    const outcome = runKernel({ formId: "f", locale: "en", form, values: { province: "XX" }, optionSnapshot: snapshot }, []);
    expect(outcome.errors).toEqual([
      { code: "option.notAllowed", componentId: "province", path: "province", stage: "options", source: "wasm", parameters: { keys: ["province"] } }
    ]);
    expect(outcome.values).toBeUndefined();
    expect(outcome.index).toBeUndefined();
  });

  it("accepts an answer in the snapshot, and refuses one to a source the snapshot leaves out", () => {
    const allowed = runKernel({ formId: "f", locale: "en", form, values: { province: "QC" }, optionSnapshot: snapshot }, []);
    expect(allowed.errors).toEqual([]);
    expect(allowed.index).toEqual([{ path: "province", delta: "", value: "QC" }]);
    // 2.9 passed both of these unchecked; the refusal names the source.
    for (const optionSnapshot of [{ other: [] }, undefined]) {
      const refused = runKernel({ formId: "f", locale: "en", form, values: { province: "XX" }, ...(optionSnapshot !== undefined ? { optionSnapshot } : {}) }, []);
      expect(refused.errors).toEqual([
        { code: "option.sourceUnavailable", componentId: "province", path: "province", stage: "options", source: "wasm", parameters: { keys: ["province"], sourceId: "provinces" } }
      ]);
      expect(refused.values).toBeUndefined();
    }
  });

  it("crosses the ABI inside the serialized context", () => {
    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const payload = abi.serializeContext({ formId: "f", locale: "en", form, values: { province: "XX" }, optionSnapshot: snapshot }, WasmValidationHost.STRICT_POLICY);
    expect(abi.deserializeOutcome(instance.run(payload) as string).errors.map((error) => error.code)).toEqual(["option.notAllowed"]);
  });
});

describe("rows posted whole are read as flat keys", () => {
  const select = (id: string, values: string[]): ComponentNode => ({ id, type: "select", configuration: { options: values.map((value) => ({ value, label: value })) } });
  const form: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "items",
          type: "repeatingSection",
          configuration: {},
          collection: { collectionPath: "items" },
          children: { content: [select("sku", ["A1", "B2"]), { id: "addr", type: "container", configuration: {}, children: { content: [select("prov", ["ON"])] } }] }
        },
        { id: "orders_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "orders" }, children: { content: [{ id: "qty", type: "number", configuration: { label: "Qty" } }] } },
        { id: "name", type: "text", configuration: {} }
      ]
    }
  };
  const run = (values: Record<string, unknown>, unknownFields?: "strip" | "keep" | "reject") =>
    runKernel({ formId: "f", locale: "en", form, values, logLevel: "info", ...(unknownFields ? { unknownFields } : {}) }, []);

  it("splits a list of row objects into the runtime's keys, a container in the entry included, grids too", () => {
    // The run flattens over the normalized tree; so does this direct call.
    const flat = kernelFlattenRows({ name: "x", items: [{ sku: "A1", addr: { prov: "ON" } }, { sku: "B2", "addr.prov": "ON" }], orders: [{ qty: 2 }] }, kernelNormalizeDataGrids(form));
    expect({ ...flat.values }).toEqual({ name: "x", "items[0].sku": "A1", "items[0].addr.prov": "ON", "items[1].sku": "B2", "items[1].addr.prov": "ON", "orders[0].qty": 2 });
    expect(flat.malformed).toEqual([]);
    expect(flat.superseded).toEqual([]);
  });

  it("reaches the fold and the index as the flat keys would, and the PDF reads the same rows", () => {
    const outcome = run({ items: [{ sku: "A1" }, { sku: "B2" }], orders: [{ qty: 2 }] });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ "items[0].sku": "A1", "items[1].sku": "B2", "orders[0].qty": 2 });
    expect(outcome.index).toEqual([
      { path: "items.sku", delta: "0", value: "A1" },
      { path: "items.sku", delta: "1", value: "B2" },
      { path: "orders.qty", delta: "0", value: 2 }
    ]);
    expect(readCollectionRows(outcome.values as Record<string, unknown>, "items")).toEqual([{ sku: "A1" }, { sku: "B2" }]);
    expect(readCollectionRows(outcome.values as Record<string, unknown>, "orders")).toEqual([{ qty: 2 }]);
  });

  it("holds a flattened answer to its options", () => {
    const outcome = run({ items: [{ sku: "ZZ", addr: { prov: "QC" } }] });
    expect(outcome.errors.map((error) => `${error.componentId}:${error.code}:${JSON.stringify(error.parameters?.keys)}`)).toEqual([
      'sku:option.notAllowed:["items[0].sku"]',
      'prov:option.notAllowed:["items[0].addr.prov"]'
    ]);
  });

  it("lets flat keys win over a list sent beside them, and says so", () => {
    const outcome = run({ items: [{ sku: "ZZ" }], "items[0].sku": "A1" });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ "items[0].sku": "A1" });
    expect(outcome.logs?.find((entry) => entry.message === "rows posted whole dropped: their entries were sent as keys")?.data).toEqual({ fields: ["items"] });
  });

  it("treats a value there that is not a list of row objects as an unknown answer: strip drops it, keep keeps it, reject refuses it", () => {
    for (const bad of [[{ sku: "A1" }, 5], "A1", { "0": { sku: "A1" } }, [["A1"]], null]) {
      expect(run({ items: bad, name: "x" }).values, JSON.stringify(bad)).toEqual({ name: "x" });
      expect(run({ items: bad, name: "x" }, "keep").values?.items, JSON.stringify(bad)).toEqual(bad);
      expect(run({ items: bad, name: "x" }, "reject").errors, JSON.stringify(bad)).toEqual([
        { code: "unknown_field", stage: "sanitization", source: "wasm", parameters: { field: "items" } }
      ]);
    }
    // A key a row spells that the schema does not define is any unknown key.
    expect(run({ items: [{ sku: "A1", forged: 1 }] }).values).toEqual({ "items[0].sku": "A1" });
    expect(run({ items: [{ sku: "A1", forged: 1 }] }, "reject").errors.map((error) => error.parameters?.field)).toEqual(["items[0].forged"]);
    // An empty list is no rows.
    expect(run({ items: [], name: "x" }).values).toEqual({ name: "x" });
  });

  it("flattens in keep mode too, so every reader sees one shape", () => {
    expect(run({ items: [{ sku: "A1" }], extra: 1 }, "keep").values).toEqual({ "items[0].sku": "A1", extra: 1 });
  });
});
