import { describe, expect, it } from "vitest";

import {
  kernelClaimsData,
  kernelClientDerived,
  kernelCollectionOwners,
  kernelCompilePattern,
  kernelComponentIdsByPath,
  kernelFileAttachments,
  kernelErrorPassesFold,
  kernelFoldSubmission,
  kernelPartitionValues,
  kernelFrozenCopy,
  kernelKeyShape,
  kernelKnownKeyShapes,
  kernelKnownValuePaths,
  kernelNormalizeDataGrids,
  kernelNormalizePath,
  kernelPageComponentIds,
  kernelRecomputeCalculations,
  kernelResolveSemanticState,
  kernelRuleRequired,
  kernelRunFieldConstraints,
  kernelSanitizeValues,
  kernelStableStringify,
  kernelTreeIndex,
  kernelValuePaths,
  runKernel,
  PORTABLE_KERNEL_FUNCTIONS,
  type KernelValidator
} from "../form-engine/validation/wasm/portable-kernel.js";
import { kernelIsEmptyValue } from "../form-engine/core/schema/answer-kinds.js";
import { journeyOwnership } from "../form-engine/core/journey/journey-path.js";
import { kernelJsonAnswers } from "../form-engine/core/state/submittable-fold.js";
import { JsonWasmAbi, WasmValidationHost } from "../form-engine/validation/wasm/wasm-validation-host.js";
import { InProcessWasmHostAdapter } from "../form-engine/validation/wasm/in-process-host.js";
import {
  buildComponentIdsByPath,
  buildValuePaths,
  holdsData,
  valuesByComponentId
} from "../form-engine/core/tree/data-scope.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { RulesSemanticStateResolver } from "../form-engine/runtime/browser/runtime-orchestrator.js";
import { FormRuntime, NonScalarAnswerError } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import {
  createFieldConstraintsStage,
  isEmptyValue
} from "../form-engine/validation/core/field-constraints.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { kernelCompileDefinition } from "../form-engine/core/expressions/compile.js";
import { dataGridSettingsOf, resolveDataGridRowBounds } from "../form-engine/core/schema/data-grid.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";

/** A representative tree: flat fields, a data-scoping container, a visual container, and a
 * collection with row fields. */
const tree: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "email", type: "text", configuration: { required: true, pattern: "[^@]+@[^@]+" } },
      { id: "notes", type: "textarea", configuration: { minLength: 3, maxLength: 6, pattern: "[a-z ]+" } },
      {
        id: "applicant",
        type: "container",
        configuration: {},
        children: {
          content: [
            { id: "firstName", type: "text", configuration: { required: true } },
            { id: "consent", type: "checkbox", configuration: { required: true } }
          ]
        }
      },
      {
        id: "visualGroup",
        type: "container",
        configuration: { scopeData: false },
        children: { content: [{ id: "city", type: "text", configuration: {} }] }
      },
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["name"] },
        children: { content: [{ id: "name", type: "text", configuration: {} }] }
      },
      { id: "doc", type: "file", configuration: { maxFileSizeMb: 1, accept: ".pdf, image/*" } },
      { id: "photos", type: "file", configuration: { multiple: true, accept: "image/*" } }
    ]
  }
};

const attachment = (name: string, type: string, size: number) => ({ storage: "base64", name, type, size, data: "" });
const okDoc = attachment("scan.pdf", "application/pdf", 10);

describe("portable kernel: known value paths", () => {
  it("matches buildValuePaths for every non-root node that holds data (data-scope semantics)", () => {
    const engine = buildValuePaths(tree);
    const kernel = kernelKnownValuePaths(tree);
    const index = kernelTreeIndex(tree);
    for (const [componentId, path] of engine) {
      if (componentId === tree.id) {
        continue; // the root holds no value and is not an allowlisted key
      }
      // A collection node prefixes its descendants in the kernel (rows submit as
      // items[0].name); every buildValuePaths path must still be known.
      if (componentId === "name") {
        expect(kernel["items.name"]).toBe(true);
        continue;
      }
      // A node that holds no data — here the container that scopes none — defines no key.
      expect(kernel[path] === true, componentId).toBe(holdsData(index.nodeById[componentId]!));
    }
    expect(kernel.visualGroup).toBeUndefined();
    expect(kernel.city).toBe(true);
    expect(kernel[tree.id]).toBeUndefined();
  });
});

/** Every kind of node the data-scope readings tell apart: groups with and without a children
 * map, valueless leaves, a data grid, keyed and unkeyed containers, a visual container. */
const shapes: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "given", type: "text", configuration: {} },
      { id: "keyed", type: "text", configuration: { dataKey: "family" } },
      { id: "go", type: "button", configuration: {} },
      { id: "banner", type: "html", configuration: {} },
      { id: "logo", type: "image", configuration: {} },
      { id: "sign", type: "signature", configuration: {} },
      { id: "bare_panel", type: "panel", configuration: {} },
      { id: "bare_steps", type: "steps", configuration: {} },
      { id: "table_grid", type: "dataGrid", configuration: {}, collection: { collectionPath: "rows" }, children: { content: [] } },
      {
        id: "billing_address",
        type: "container",
        configuration: { dataKey: "billing" },
        children: {
          content: [
            { id: "street", type: "text", configuration: {} },
            {
              id: "fieldset_in",
              type: "fieldset",
              configuration: {},
              children: { content: [{ id: "city", type: "text", configuration: {} }] }
            }
          ]
        }
      },
      {
        id: "visual",
        type: "container",
        configuration: { scopeData: false },
        children: { content: [{ id: "loose", type: "text", configuration: {} }] }
      },
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["name"] },
        children: { content: [{ id: "item_name", type: "text", configuration: { dataKey: "name" } }] }
      },
      { id: "odd", type: "custom-widget", configuration: {}, children: { content: [{ id: "inner", type: "number", configuration: {} }] } }
    ]
  }
};

describe("portable kernel: data-scope readings the fold keys by", () => {
  it("matches holdsData and buildComponentIdsByPath", () => {
    const index = kernelTreeIndex(shapes);
    for (const id of index.order) {
      const node = index.nodeById[id]!;
      expect(kernelClaimsData(node), id).toBe(holdsData(node));
    }
    const engine = buildComponentIdsByPath(shapes);
    const kernel = kernelComponentIdsByPath(shapes);
    expect(Object.keys(kernel)).toEqual([...engine.keys()]);
    for (const [path, ids] of engine) {
      expect(kernel[path], path).toEqual(ids);
    }
    // The same for the representative tree above.
    expect(Object.fromEntries(Object.entries(kernelComponentIdsByPath(tree)))).toEqual(Object.fromEntries(buildComponentIdsByPath(tree)));
    // No prototype: a submitted key named like an Object member finds nothing.
    expect(kernel["constructor"]).toBeUndefined();
  });

  it("indexes the tree root first in document order, as the orchestrator walks it", () => {
    const index = kernelTreeIndex(shapes);
    const componentTree = new ComponentTree(shapes);
    const walked: string[] = [];
    const walk = (node: ComponentNode): void => {
      walked.push(node.id);
      for (const group of Object.values(node.children ?? {})) {
        group.forEach(walk);
      }
    };
    walk(shapes);
    expect(index.order).toEqual(walked);
    for (const id of index.order.slice(1)) {
      expect(index.parentOf[id], id).toBe(componentTree.ancestorsOf(id)[0]?.id);
    }
    expect(index.parentOf[shapes.id]).toBeUndefined();
  });
});

describe("portable kernel: semantic state parity with RulesSemanticStateResolver", () => {
  const read = (name: string): Expression => ({ kind: "path", path: name });
  const is = (name: string, value: string | number | boolean): Expression => ({
    kind: "binary",
    operator: "eq",
    left: read(name),
    right: { kind: "literal", value }
  });
  const ruled: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "mode", type: "select", configuration: { options: [{ value: "post", label: "post" }, { value: "email", label: "email" }] } },
        { id: "flag", type: "checkbox", configuration: { hidden: true, hiddenValueBehavior: "clear", hiddenRequiredBehavior: "required" } },
        {
          id: "billing_address",
          type: "container",
          configuration: { dataKey: "billing" },
          rules: { visibleWhen: is("mode", "post"), readonlyWhen: is("flag", true) },
          children: {
            content: [
              {
                id: "street",
                type: "text",
                configuration: { readOnly: true, hiddenValidationBehavior: "validate" },
                rules: {
                  visibleWhen: { kind: "call", name: "len", args: [read("component")] },
                  enabledWhen: { kind: "binary", operator: "neq", left: read("ancestor.billing_address"), right: { kind: "literal", value: null } }
                }
              },
              { id: "postcode", type: "text", configuration: { dataKey: "code" }, rules: { enabledWhen: is("street", "Main") } }
            ]
          }
        }
      ]
    }
  };

  it("resolves the same state for every node over the same answers", () => {
    const resolver = new RulesSemanticStateResolver();
    const componentTree = new ComponentTree(ruled);
    const engineIdsByPath = buildComponentIdsByPath(ruled);
    const enginePaths = buildValuePaths(ruled);
    const index = kernelTreeIndex(ruled);
    const pathOf = kernelValuePaths(ruled);
    const cases: Array<Record<string, unknown>> = [
      {},
      { mode: "post", "billing.street": "Main", "billing.code": "K1A" },
      { mode: "post", flag: true, "billing.street": "", billing: { street: "x" } },
      { mode: "email", "billing.street": "Elm" }
    ];
    for (const values of cases) {
      const idValues = valuesByComponentId(values, engineIdsByPath);
      const context = {
        values: idValues,
        locale: "en",
        hostContext: {},
        valueOf: (componentId: string) => values[enginePaths.get(componentId) ?? componentId],
        ancestorValuesFor: (componentId: string) => {
          const record: Record<string, unknown> = {};
          for (const ancestor of componentTree.ancestorsOf(componentId)) {
            record[ancestor.id] = values[enginePaths.get(ancestor.id) ?? ancestor.id];
          }
          return record;
        }
      };
      for (const id of index.order) {
        const node = index.nodeById[id]!;
        expect(kernelResolveSemanticState(node, idValues, values, pathOf, index.parentOf), `${id} over ${JSON.stringify(values)}`).toEqual(
          resolver.resolve(node, context)
        );
      }
    }
  });
});

describe("portable kernel: sanitization", () => {
  it("strips unknown keys and keeps schema-defined ones, including scoped and collection paths", () => {
    const values = {
      email: "a@b.co",
      "applicant.firstName": "Ada",
      city: "Ottawa",
      "items[0].name": "first",
      "items[2].name": "third",
      unknownTopLevel: "dropped",
      "applicant.unknownNested": "dropped",
      "items[0].unknownRowField": "dropped"
    };
    expect(kernelSanitizeValues(values, tree)).toEqual({
      email: "a@b.co",
      "applicant.firstName": "Ada",
      city: "Ottawa",
      "items[0].name": "first",
      "items[2].name": "third"
    });
  });

  it("normalizes collection indexes", () => {
    expect(kernelNormalizePath("items[12].name")).toBe("items.name");
    expect(kernelNormalizePath("items[0]")).toBe("items");
    expect(kernelNormalizePath("plain.path")).toBe("plain.path");
  });
});

describe("portable kernel: entry indexes only where a repeating section puts them", () => {
  /** A plain field, a section with a field, a data-scoping container and a nested section in
   * its entries, and a section filed under a dotted collection path. */
  const indexed: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        // QC too: under keep a forged `province[0]` is held to province's options.
        { id: "province", type: "select", configuration: { options: [{ value: "ON", label: "ON" }, { value: "QC", label: "QC" }] } },
        {
          id: "items",
          type: "repeatingSection",
          configuration: {},
          collection: {},
          children: {
            content: [
              { id: "sku", type: "text", configuration: {} },
              { id: "size", type: "container", configuration: {}, children: { content: [{ id: "width", type: "number", configuration: {} }] } },
              { id: "lines", type: "repeatingSection", configuration: {}, collection: {}, children: { content: [{ id: "qty", type: "number", configuration: {} }] } }
            ]
          }
        },
        {
          id: "order",
          type: "container",
          configuration: {},
          children: {
            content: [
              {
                id: "order_lines",
                type: "repeatingSection",
                configuration: {},
                collection: { collectionPath: "order.lines" },
                children: { content: [{ id: "code", type: "text", configuration: {} }] }
              }
            ]
          }
        }
      ]
    }
  };

  /** Every shape the runtime writes: an index straight after each collection path, once. */
  const legitimate: Record<string, unknown> = {
    province: "ON",
    items: [{ sku: "A1" }],
    "items[0].sku": "A1",
    "items[12].sku": "B2",
    "items[0].size.width": 3,
    "lines[0].qty": 2,
    "order.lines[1].code": "X"
  };
  /** What the kernel keeps of `legitimate`: the list at `items` is dropped, since flat keys of its own were sent beside it. */
  const { items: _rowsPostedWhole, ...judged } = legitimate;

  /** Keys that name a known path only once their indexes are taken out, or not even then. */
  const forged: Record<string, unknown> = {
    "province[0]": "QC",
    "province[3]": "QC",
    "province.x": "QC",
    "items.sku": "C3",
    "items[0][1].sku": "C3",
    "items[0].sku[2]": "C3",
    "items[01].sku": "C3",
    "items[-1].sku": "C3",
    "items[].sku": "C3",
    "items[0]": { sku: "C3" },
    "items[0].size[1].width": 4,
    "items[0].lines[0].qty": 5,
    "lines.qty": 5,
    "order[0].lines[1].code": "Y",
    "order.lines.code": "Y"
  };

  it("knows each key shape with [] where the entry index goes, and the index-free paths as before", () => {
    expect(kernelKnownKeyShapes(indexed)).toEqual({
      province: true,
      items: true,
      "items[].sku": true,
      "items[].size": true,
      "items[].size.width": true,
      lines: true,
      "lines[].qty": true,
      order: true,
      "order.lines": true,
      "order.lines[].code": true
    });
    expect(kernelKnownValuePaths(indexed)).toEqual({
      province: true,
      items: true,
      "items.sku": true,
      "items.size": true,
      "items.size.width": true,
      lines: true,
      "lines.qty": true,
      order: true,
      "order.lines": true,
      "order.lines.code": true
    });
  });

  it("reads a key's shape: canonical indexes as [], any other bracket as no shape", () => {
    expect(kernelKeyShape("items[0].sku")).toBe("items[].sku");
    expect(kernelKeyShape("items[12].sku")).toBe("items[].sku");
    expect(kernelKeyShape("order.lines[1].code")).toBe("order.lines[].code");
    expect(kernelKeyShape("province")).toBe("province");
    expect(kernelKeyShape("province[0]")).toBe("province[]");
    expect(kernelKeyShape("items[0][1].sku")).toBe("items[][].sku");
    expect(kernelKeyShape("items[0].sku[2]")).toBe("items[].sku[]");
    for (const key of ["items[01].sku", "items[-1].sku", "items[].sku", "items[x].sku", "items[0]]", "items[[0]]", "items]0[", "items[1.5]"]) {
      expect(kernelKeyShape(key), key).toBeUndefined();
    }
  });

  it("strips keys whose indexes stand anywhere else, keeping items[0].sku and items[12].sku", () => {
    const values = { ...legitimate, ...forged };
    expect(kernelSanitizeValues(values, indexed)).toEqual(judged);
    const stripped = runKernel({ formId: "f", values, locale: "en", form: indexed }, []);
    expect(stripped.errors).toEqual([]);
    expect(stripped.values).toEqual(judged);
    expect(Object.keys(stripped.values ?? {})).toEqual(Object.keys(judged));
  });

  it("passes them through in keep mode, as any unknown key", () => {
    const values = { ...legitimate, ...forged };
    const kept = runKernel({ formId: "f", values, locale: "en", form: indexed, unknownFields: "keep" }, []);
    expect(kept.errors).toEqual([]);
    const { items: _list, ...flatValues } = values;
    expect(kept.values).toEqual(flatValues);
  });

  it("rejects each of them as an unknown field in reject mode, and nothing else", () => {
    const rejected = runKernel({ formId: "f", values: { ...legitimate, ...forged }, locale: "en", form: indexed, unknownFields: "reject" }, []);
    expect(rejected.values).toBeUndefined();
    expect(rejected.errors).toEqual(
      Object.keys(forged).map((field) => ({ code: "unknown_field", stage: "sanitization", source: "wasm", parameters: { field } }))
    );
    const clean = runKernel({ formId: "f", values: legitimate, locale: "en", form: indexed, unknownFields: "reject" }, []);
    expect(clean.errors).toEqual([]);
    expect(clean.values).toEqual(judged);
  });

  it("knows every key the browser runtime writes for the sections' entries", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const definition: FormDefinition = { id: "f", version: "1", schemaVersion: "1", root: indexed, localization: { defaultLocale: "en" } };
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    runtime.setValue("province", "ON");
    runtime.addRow("items", {});
    runtime.setValue("items[0].sku", "A1");
    runtime.setValue("items[0].size.width", 3);
    runtime.addRow("items", { sku: "B2" });
    runtime.addRow("lines", {});
    runtime.setValue("lines[0].qty", 2);
    runtime.addRow("order.lines", {});
    runtime.setValue("order.lines[0].code", "X");
    const values = runtime.state().values;
    expect(Object.keys(values)).toEqual(
      expect.arrayContaining(["province", "items[0].sku", "items[0].size.width", "items[1].sku", "lines[0].qty", "order.lines[0].code"])
    );
    expect(kernelSanitizeValues(values, indexed)).toEqual(values);
    const outcome = runKernel({ formId: "f", values, locale: "en", form: indexed, unknownFields: "reject" }, []);
    expect(outcome.errors).toEqual([]);
  });
});

describe("portable kernel: a data grid's rows are keys the schema defines", () => {
  const column = (id: string, type = "text"): ComponentNode => ({ id, type, configuration: {} });
  const grid = (id: string, content: ComponentNode[], collectionPath?: string): ComponentNode => ({
    id,
    type: "dataGrid",
    configuration: {},
    ...(collectionPath !== undefined ? { collection: { collectionPath } } : {}),
    children: { content }
  });
  // The run binds an unbound grid at its id; the readers below are asked about the normalized
  // tree and the run about the tree as written.
  const gridShape: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        grid("orders_grid", [column("qty", "number"), column("sku")], "orders"),
        {
          id: "shipping",
          type: "container",
          configuration: {},
          // A collection path is where the rows live as written, whatever container sits above the grid.
          children: { content: [grid("parcels_grid", [column("weight", "number")], "shipping.parcels")] }
        },
        grid("bracketed", [column("x")], "odd[0]"),
        grid("odd_columns", [column("a[1]"), column("ok")], "extras"),
        grid("no_path", [column("y")])
      ]
    }
  };
  const gridded = kernelNormalizeDataGrids(gridShape);

  it("knows the collection path as one list and each field of a row, as a section's", () => {
    expect(kernelKnownKeyShapes(gridded)).toEqual({
      orders: true,
      "orders[].qty": true,
      "orders[].sku": true,
      shipping: true,
      "shipping.parcels": true,
      "shipping.parcels[].weight": true,
      extras: true,
      // A field id the grammar refuses is known as any such id is (`check` refuses it).
      "extras[].a[1]": true,
      "extras[].ok": true,
      // A grid with no binding keeps its rows at its id.
      no_path: true,
      "no_path[].y": true
    });
    // The grid's own value path is no key: a grid is a list, not an answer (a bracketed path, nothing).
    expect(kernelKnownKeyShapes(gridded).orders_grid).toBeUndefined();
  });

  it("keeps every cell the runtime writes in strip mode and rejects none in reject mode, while forged shapes stay unknown", () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const definition: FormDefinition = { id: "f", version: "1", schemaVersion: "1", root: gridShape, localization: { defaultLocale: "en" } };
    // No opening rows (a grid seeds `initialRows`, one by default): only the rows added below.
    const opening = (node: ComponentNode): ComponentNode =>
      node.type === "dataGrid"
        ? { ...node, configuration: { ...(node.configuration as Record<string, unknown>), initialRows: 0 } }
        : node.children
          ? { ...node, children: { content: (node.children.content ?? []).map(opening) } }
          : node;
    definition.root = opening(gridShape);
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    runtime.addRow("orders", { qty: 10, sku: "A1" });
    runtime.addRow("orders", { qty: 2, sku: "B2" });
    runtime.addRow("shipping.parcels", { weight: 3 });
    const values = runtime.state().values;
    expect(values).toMatchObject({ "orders[0].qty": 10, "orders[1].sku": "B2", "shipping.parcels[0].weight": 3 });
    expect(kernelSanitizeValues(values, gridded)).toEqual(values);
    expect(runKernel({ formId: "f", values, locale: "en", form: gridShape }, []).values).toEqual(values);
    expect(runKernel({ formId: "f", values, locale: "en", form: gridShape, unknownFields: "reject" }, []).errors).toEqual([]);

    const forged = { "orders.qty": 1, "orders[0].qty[1]": 1, "orders[0].price": 1, "orders[01].qty": 1, "extras[0].a[1]": 1, "odd[0][0].x": 1 };
    expect(kernelSanitizeValues({ ...values, ...forged }, gridded)).toEqual(values);
  });
});

describe("portable kernel: field constraints parity", () => {
  const cases: Array<Record<string, unknown>> = [
    {},
    { email: "not-an-email", "applicant.firstName": "Ada", "applicant.consent": true },
    { email: "a@b.co", "applicant.firstName": "  ", "applicant.consent": false },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true },
    // Length limits: too short, too long (in code points — seven emoji), right length but
    // failing the pattern, and fine.
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, notes: "hi" },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, notes: "🙂🙂🙂🙂🙂🙂🙂" },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, notes: "ABCD" },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, notes: "fine" },
    // File limits: fine, too large (size before type), wrong type, a multi-file list with one
    // offender in the middle, a stale non-attachment value, and a required file left empty.
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, doc: okDoc },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, doc: attachment("big.txt", "text/plain", 1048577) },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, doc: attachment("notes.txt", "text/plain", 10) },
    {
      email: "a@b.co",
      "applicant.firstName": "Ada",
      "applicant.consent": true,
      doc: okDoc,
      photos: [attachment("a.png", "image/png", 1), attachment("b.pdf", "application/pdf", 1), attachment("c.txt", "text/plain", 1)]
    },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, doc: "C:\\fakepath\\x.exe" },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, doc: [] },
    // A non-string text, a list on a single-file field, a list of junk,
    // and the fields of a section's entries at their own keys.
    { email: ["a@b.co"], "applicant.firstName": { first: "Ada" }, "applicant.consent": true, notes: 12 },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, doc: [okDoc, okDoc] },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, photos: [okDoc, "junk"] },
    { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, "items[0].name": "Ada", "items[1].name": 7, "items[2].name": [] }
  ];

  it("emits the same code/componentId/path/parameters as createFieldConstraintsStage", async () => {
    const stage = createFieldConstraintsStage(tree);
    for (const values of cases) {
      const engineResult = await stage.validate({ formId: "f", values, locale: "en" });
      const kernelErrors = kernelRunFieldConstraints(tree, values, "en");
      const strip = (errors: Array<Record<string, unknown>>) =>
        errors.map(({ code, componentId, path, parameters }) => ({
          code,
          componentId,
          path,
          parameters
        }));
      expect(strip(kernelErrors as never)).toEqual(strip(engineResult.errors as never));
      // The kernel reports as the sandbox's own stage.
      for (const error of kernelErrors) {
        expect(error.source).toBe("wasm");
        expect(error.stage).toBe("field-constraints");
      }
    }
  });

  it("agrees with the engine on emptiness semantics", () => {
    const samples: Array<[unknown, string]> = [
      [undefined, "text"],
      [null, "text"],
      ["  ", "text"],
      [[], "select"],
      [false, "checkbox"],
      [false, "text"],
      [{ a: false, b: false }, "checkboxes"],
      [{ a: true }, "checkboxes"],
      [0, "number"],
      [-0, "number"],
      [Number.NaN, "number"],
      [Number.POSITIVE_INFINITY, "number"],
      [Number.NEGATIVE_INFINITY, "text"],
      [okDoc, "file"],
      [[okDoc], "file"],
      [[], "file"]
    ];
    for (const [value, type] of samples) {
      expect(kernelIsEmptyValue(value, type)).toBe(isEmptyValue(value, type));
    }
  });
});

describe("portable kernel: runKernel", () => {
  it("returns sanitized values only when nothing blocks", () => {
    const ok = runKernel(
      {
        formId: "f",
        values: {
          email: "a@b.co",
          "applicant.firstName": "Ada",
          "applicant.consent": true,
          rogue: "x"
        },
        locale: "en",
        form: tree
      },
      []
    );
    expect(ok.errors).toEqual([]);
    expect(ok.values).toEqual({
      email: "a@b.co",
      "applicant.firstName": "Ada",
      "applicant.consent": true
    });

    const blocked = runKernel({ formId: "f", values: {}, locale: "en", form: tree }, []);
    expect(blocked.values).toBeUndefined();
    expect(blocked.errors.map((error) => error.code)).toContain("required");
  });

  it("honors the unknownFields mode: keep passes unknown keys through, reject blocks on them", () => {
    const values = {
      email: "a@b.co",
      "applicant.firstName": "Ada",
      "applicant.consent": true,
      rogue: "x"
    };

    const kept = runKernel(
      { formId: "f", values, locale: "en", form: tree, unknownFields: "keep" },
      []
    );
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual(values);

    const rejected = runKernel(
      { formId: "f", values, locale: "en", form: tree, unknownFields: "reject" },
      []
    );
    expect(rejected.values).toBeUndefined();
    expect(rejected.errors).toEqual([
      {
        code: "unknown_field",
        stage: "sanitization",
        source: "wasm",
        parameters: { field: "rogue" }
      }
    ]);

    // An unrecognized mode value falls back to the default strip behavior.
    const fallback = runKernel(
      { formId: "f", values, locale: "en", form: tree, unknownFields: "bogus" as never },
      []
    );
    expect(fallback.values).toEqual({
      email: "a@b.co",
      "applicant.firstName": "Ada",
      "applicant.consent": true
    });
  });

  it("runs custom validators against sanitized values and passes their errors through", () => {
    const outcome = runKernel(
      {
        formId: "f",
        values: {
          email: "a@b.co",
          "applicant.firstName": "Ada",
          "applicant.consent": true,
          rogue: "x"
        },
        locale: "en",
        form: tree
      },
      [
        (context) => ({
          errors:
            "rogue" in context.values
              ? [{ code: "saw.rogue", stage: "plugin", source: "custom" as const }]
              : []
        })
      ]
    );
    // The validator never saw the stripped key.
    expect(outcome.errors).toEqual([]);
  });
});

describe("portable kernel: ids and keys named after Object.prototype members", () => {
  // A submission's keys and a form's ids are data: `constructor`, `toString` and `__proto__`
  // must behave like any other key, never as a record's inherited member.
  const named: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "constructor", type: "text", configuration: { required: true } },
        { id: "toString", type: "text", configuration: { minLength: 3 } },
        { id: "valueOf", type: "text", configuration: { dataKey: "__proto__", required: true } }
      ]
    }
  };

  it("keeps unknown keys such as constructor, toString and __proto__ in keep mode, for validators and the outcome", () => {
    const values = JSON.parse('{"email": "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, "constructor": "c", "toString": "t", "__proto__": "p"}') as Record<string, unknown>;
    const seen: string[] = [];
    const kept = runKernel({ formId: "f", values, locale: "en", form: tree, unknownFields: "keep" }, [
      (context) => {
        seen.push(...Object.keys(context.values));
        return { errors: [] };
      }
    ]);
    expect(kept.errors).toEqual([]);
    expect(Object.keys(kept.values ?? {})).toEqual(["email", "applicant.firstName", "applicant.consent", "constructor", "toString", "__proto__"]);
    expect(kept.values?.constructor).toBe("c");
    expect(Object.getPrototypeOf(kept.values)).toBe(Object.prototype);
    expect(seen).toEqual(["email", "applicant.firstName", "applicant.consent", "constructor", "toString", "__proto__"]);
    expect(kernelStableStringify(kept.values)).toContain('"__proto__":"p"');

    const stripped = runKernel({ formId: "f", values, locale: "en", form: tree }, []);
    expect(Object.keys(stripped.values ?? {})).toEqual(["email", "applicant.firstName", "applicant.consent"]);
    const rejected = runKernel({ formId: "f", values, locale: "en", form: tree, unknownFields: "reject" }, []);
    expect(rejected.errors.map((error) => error.parameters?.field)).toEqual(["constructor", "toString", "__proto__"]);
  });

  it("judges components called constructor and toString, and a data key of __proto__, like any other", () => {
    const blank = runKernel({ formId: "f", values: {}, locale: "en", form: named }, []);
    expect(blank.errors.map((error) => `${error.componentId}:${error.code}:${error.path}`)).toEqual([
      "constructor:required:constructor",
      "valueOf:required:__proto__"
    ]);
    expect(kernelValuePaths(named).valueOf).toBe("__proto__");
    expect(kernelKnownValuePaths(named).__proto__).toBe(true);
    expect(kernelComponentIdsByPath(named).__proto__).toEqual(["valueOf"]);

    const answered = JSON.parse('{"constructor": "c", "toString": "to", "__proto__": "p"}') as Record<string, unknown>;
    const outcome = runKernel({ formId: "f", values: answered, locale: "en", form: named }, []);
    expect(outcome.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["toString:minLength"]);
    // Handed an ordinary object, as a caller may: `constructor` and `__proto__` are unanswered.
    expect(kernelRunFieldConstraints(named, { toString: "long enough" }, "en")).toEqual([
      { code: "required", componentId: "constructor", path: "constructor", stage: "field-constraints", source: "wasm" },
      { code: "required", componentId: "valueOf", path: "__proto__", stage: "field-constraints", source: "wasm" }
    ]);
  });

  it("writes one warn log line per condition.notBoolean warning, whatever the policy, and refuses nothing", () => {
    const form = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "n", type: "number", configuration: {} },
            { id: "t", type: "text", configuration: {}, rules: { visibleWhen: "n + 1", requiredWhen: "n > 1" } }
          ]
        }
      }
    };
    for (const formulaErrors of ["fail", "warn"] as const) {
      const outcome = runKernel({ formId: "f", values: { n: 1, t: "x" }, locale: "en", form: form.root, formulaErrors } as never, []);
      const warns = (outcome.logs ?? []).filter((entry) => entry.message.startsWith("formula warning: "));
      expect(warns.map((entry) => entry.level)).toEqual(["warn"]);
      expect(warns[0]?.message).toContain("rules:t:visibleWhen");
    }
  });

  it("falls back to the default log threshold for a level named after an inherited member", () => {
    const outcome = runKernel({ formId: "f", values: {}, locale: "en", form: named, logLevel: "constructor" as never }, []);
    expect(outcome.logs).toBeUndefined();
  });
});

describe("portable kernel: run log", () => {
  const values = { email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true, rogue: "x" };

  it("records nothing by default, and at debug the kernel's steps in order with what the rules wrote", () => {
    const quiet = runKernel({ formId: "f", values, locale: "en", form: tree }, [
      (context) => {
        context.log.debug("rule ran");
        return { errors: [] };
      }
    ]);
    expect(quiet.logs).toBeUndefined();

    const chatty = runKernel({ formId: "f", values, locale: "en", form: tree, logLevel: "debug" }, [
      (context) => {
        context.log.debug("checking", { fields: Object.keys(context.values) });
        context.log.info("all good");
        return { errors: [] };
      }
    ]);
    expect(chatty.values).toEqual({ email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true });
    expect(chatty.logs?.map((entry) => `${entry.level}: ${entry.message}`)).toEqual([
      "debug: run: schema form, unknown fields strip",
      "info: unknown fields stripped",
      "debug: field constraints: 0 error(s)",
      "debug: checking",
      "info: all good",
      "debug: validator 1: 0 error(s)",
      "info: accepted: 0 error(s), 3 value(s)"
    ]);
    expect(chatty.logs?.[0]?.data).toEqual({ formId: "f", locale: "en", fields: 4 });
    expect(chatty.logs?.[1]?.data).toEqual({ fields: ["rogue"] });
    // The rule saw the sanitized values, and its data went through as it was.
    expect(chatty.logs?.[3]?.data).toEqual({ fields: ["email", "applicant.firstName", "applicant.consent"] });
    expect("data" in chatty.logs![4]!).toBe(false);
  });

  it("keeps entries at or above the threshold, and names the errors it found", () => {
    const outcome = runKernel({ formId: "f", values: { email: "nope" }, locale: "en", form: tree, logLevel: "info" }, [
      (context) => {
        context.log.debug("dropped");
        context.log.warn("kept");
        return { errors: [{ code: "custom.x", componentId: "email", stage: "p", source: "custom" }] };
      }
    ]);
    expect(outcome.values).toBeUndefined();
    expect(outcome.logs?.map((entry) => [entry.level, entry.message])).toEqual([
      ["warn", "kept"],
      ["info", "blocked: 4 error(s)"]
    ]);
    // A validator that returns nothing usable is not ignored with a warn line:
    // the run fails, as a validator that cannot run does. See the describe on the
    // fail-closed gate below.
    expect(() => runKernel({ formId: "f", values: { email: "nope" }, locale: "en", form: tree, logLevel: "info" }, [(() => undefined) as never])).toThrow(
      "validator 1 returned undefined"
    );

    const named = runKernel({ formId: "f", values: { email: "nope" }, locale: "en", form: tree, logLevel: "debug" }, []);
    expect(named.logs?.find((entry) => entry.message.startsWith("field constraints"))).toEqual({
      level: "debug",
      message: "field constraints: 3 error(s)",
      data: {
        errors: [
          { code: "pattern", componentId: "email" },
          { code: "required", componentId: "firstName" },
          { code: "required", componentId: "consent" }
        ]
      }
    });
    expect(runKernel({ formId: "f", values, locale: "en", form: tree, logLevel: "off" }, []).logs).toBeUndefined();
  });

  it("caps the log at 200 entries and says how many it dropped", () => {
    const outcome = runKernel({ formId: "f", values, locale: "en", form: tree, logLevel: "debug" }, [
      (context) => {
        for (let step = 0; step < 250; step += 1) {
          context.log.debug("step " + step);
        }
        return { errors: [] };
      }
    ]);
    expect(outcome.logs).toHaveLength(201);
    expect(outcome.logs?.[3]?.message).toBe("step 0");
    expect(outcome.logs?.[200]).toEqual({ level: "warn", message: "run log truncated", data: { kept: 200, dropped: 55 } });
    // The verdict is unaffected by how much was said.
    expect(outcome.values).toEqual({ email: "a@b.co", "applicant.firstName": "Ada", "applicant.consent": true });
  });
});

describe("portable kernel: composition constraints", () => {
  it("keeps every kernel function in the composition list as a named declaration", () => {
    expect(PORTABLE_KERNEL_FUNCTIONS.length).toBeGreaterThanOrEqual(12);
    expect(PORTABLE_KERNEL_FUNCTIONS.map((fn) => fn.name)).toEqual(expect.arrayContaining(["kernelCreateLog", "kernelFinishLog", "runKernel"]));
    for (const fn of PORTABLE_KERNEL_FUNCTIONS) {
      expect(typeof fn).toBe("function");
      expect(fn.name.length).toBeGreaterThan(0);
      expect(fn.toString()).not.toContain("[native code]");
      expect(fn.toString().trimStart().startsWith("function ")).toBe(true);
    }
  });

  it("orders keys by code unit, never locale collation", () => {
    expect(kernelStableStringify({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    expect(kernelStableStringify({ b: [{ z: 1, A: 2 }] })).toBe('{"b":[{"A":2,"z":1}]}');
  });
});

describe("portable kernel — a collection path written with brackets", () => {
  it("knows no key of such a section, so no forged index shape is accepted", () => {
    const root = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "w",
            type: "panel",
            collection: { collectionPath: "w[]" },
            configuration: {},
            children: { content: [{ id: "z", type: "text", configuration: {} }] }
          },
          { id: "name", type: "text", configuration: {} }
        ]
      }
    } as unknown as ComponentNode;
    const shapes = Object.keys(kernelKnownKeyShapes(root));
    expect(shapes).toEqual(["name"]);
  });
});

describe("portable kernel: requiredness parity with the browser runtime", () => {
  const read = (name: string): Expression => ({ kind: "path", path: name });
  const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
  const is = (name: string, value: string | number | boolean | null): Expression => ({ kind: "binary", operator: "eq", left: read(name), right: literal(value) });
  /** Rules reading an id, the component's own value, an ancestor and a keyed field; a tick; two nodes the fold never reads. */
  const root: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "mode", type: "select", configuration: { options: [{ value: "post", label: "post" }, { value: "email", label: "email" }] } },
        { id: "phone", type: "text", configuration: {}, rules: { requiredWhen: is("mode", "post") } },
        {
          id: "billing_address",
          type: "container",
          configuration: { dataKey: "billing" },
          children: {
            content: [
              { id: "street", type: "text", configuration: {}, rules: { requiredWhen: { kind: "binary", operator: "gt", left: { kind: "call", name: "len", args: [read("component")] }, right: literal(0) } } },
              { id: "postcode", type: "text", configuration: { dataKey: "code" }, rules: { requiredWhen: is("street", "Main") } },
              { id: "country", type: "text", configuration: {}, rules: { requiredWhen: is("ancestor.billing_address", "corporate") } }
            ]
          }
        },
        { id: "ticked", type: "text", configuration: { required: true }, rules: { requiredWhen: is("mode", "never") } },
        { id: "note", type: "html", configuration: {}, rules: { requiredWhen: is("mode", "post") } },
        { id: "extra", type: "fieldset", configuration: {}, rules: { requiredWhen: is("mode", "post") } }
      ]
    }
  };
  const definition: FormDefinition = { id: "f", version: "1", schemaVersion: "1", root };
  const cases: Array<Record<string, unknown>> = [
    {},
    { mode: "post" },
    { mode: "post", "billing.street": "Main" },
    { mode: "email", "billing.street": "Elm", "billing.code": "K1A" },
    { billing: "corporate", "billing.street": "" }
  ];
  const runtimeOver = (values: Record<string, unknown>, hostContext?: Record<string, unknown>): FormRuntime => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]), ...(hostContext ? { hostContext } : {}) });
    for (const [key, value] of Object.entries(values)) {
      runtime.setValue(key, value);
    }
    return runtime;
  };

  it("matches FormRuntime.requiredMap for reads through an id, the component's own value, an ancestor and a keyed field", () => {
    for (const values of cases) {
      const label = JSON.stringify(values);
      const runtime = runtimeOver(values);
      const fold = kernelFoldSubmission(root, values, undefined);
      expect({ ...fold.required }, label).toEqual(Object.fromEntries(runtime.requiredMap()));
      for (const id of Object.keys(fold.required)) {
        expect(fold.required[id], `${id} over ${label}`).toBe(runtime.isRequired(id));
      }
    }
    // The cases exercise each reading at least once.
    expect(kernelFoldSubmission(root, cases[2]!, undefined).requiredByRule).toEqual(["phone", "street", "postcode"]);
    expect(kernelFoldSubmission(root, cases[4]!, undefined).requiredByRule).toEqual(["country"]);
    expect(kernelFoldSubmission(root, {}, undefined).requiredByRule).toEqual([]);
  });

  it("reads a host. rule as false, where the browser with a host context reads it", () => {
    const hosted: ComponentNode = { id: "staff_note", type: "text", configuration: {}, rules: { requiredWhen: is("host.role", "staff") } };
    expect(kernelRuleRequired(hosted, {}, {}, {}, {})).toBe(false);
    const browser = new FormRuntime(
      { id: "h", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content: [hosted] } } },
      { submissionModes: new SubmissionModeRegistry(), validationPipeline: new ValidationPipeline([]), hostContext: { role: "staff" } }
    );
    expect(browser.isRequired("staff_note")).toBe(true);
  });

  it("holds the stage and the walker to the same verdict given the fold's requiredness", async () => {
    const stage = createFieldConstraintsStage(root);
    const strip = (errors: ReadonlyArray<{ code: string; componentId?: string | undefined; path?: string | undefined }>) =>
      errors.map(({ code, componentId, path }) => ({ code, componentId, path }));
    for (const values of [...cases, { mode: "post", "billing.street": "Main", "billing.code": "K1A", phone: "555", ticked: "t" }]) {
      const fold = kernelFoldSubmission(root, values, undefined);
      const engine = await stage.validate({ formId: "f", values, locale: "en", requiredComponents: { ...fold.required } });
      const kernel = kernelRunFieldConstraints(root, values, "en", fold.effective, fold.required);
      expect(strip(kernel), JSON.stringify(values)).toEqual(strip(engine.errors));
    }
    // Neither side holds anything to the rule without the record: the tick alone.
    const bare = await stage.validate({ formId: "f", values: { mode: "post" }, locale: "en" });
    expect(strip(bare.errors)).toEqual(strip(kernelRunFieldConstraints(root, { mode: "post" }, "en")));
    expect(bare.errors.map((error) => error.componentId)).toEqual(["ticked"]);
    // Nor to a record that only inherits `true`: both read the record's own keys, so a
    // prototype-carried entry (a host's map built over a template) counts for nothing.
    const inherited = Object.create({ phone: true, street: true, ticked: true }) as Record<string, boolean>;
    const fold = kernelFoldSubmission(root, { mode: "post" }, undefined);
    const engineInherited = await stage.validate({ formId: "f", values: { mode: "post" }, locale: "en", requiredComponents: inherited });
    expect(engineInherited.errors.map((error) => error.componentId)).toEqual(["ticked"]);
    expect(kernelRunFieldConstraints(root, { mode: "post" }, "en", fold.effective, inherited).map((error) => error.componentId)).toEqual(["ticked"]);
  });

  it("holds a component called __proto__ or constructor to its rule in the browser as the kernel does", async () => {
    // The orchestrator's fold indexes are prototype-free like the kernel's: a `__proto__` id
    // set the index's prototype before, so the browser skipped the rule the sandbox enforced.
    const tricky: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "mode", type: "select", configuration: { options: [{ value: "post", label: "post" }, { value: "email", label: "email" }] } },
          { id: "__proto__", type: "text", configuration: {}, rules: { requiredWhen: is("mode", "post") } },
          { id: "constructor", type: "text", configuration: {}, rules: { requiredWhen: is("mode", "post") } }
        ]
      }
    };
    const values = JSON.parse('{"mode": "post"}') as Record<string, unknown>;
    const fold = kernelFoldSubmission(tricky, values, undefined);
    expect(fold.requiredByRule).toEqual(["__proto__", "constructor"]);
    const runtime = new FormRuntime(
      { id: "p", version: "1", schemaVersion: "1", root: tricky },
      { submissionModes: new SubmissionModeRegistry(), validationPipeline: new ValidationPipeline([createFieldConstraintsStage(tricky)]) }
    );
    runtime.setValue("mode", "post");
    expect(Object.fromEntries(runtime.requiredMap())).toEqual(Object.fromEntries(Object.entries(fold.required)));
    expect(runtime.isRequired("__proto__")).toBe(true);
    const browser = (await runtime.validate()).map((error) => `${error.componentId}:${error.code}`);
    const kernel = runKernel({ formId: "p", values, locale: "en", form: tricky }, []).errors.map((error) => `${error.componentId}:${error.code}`);
    expect(browser).toEqual(["__proto__:required", "constructor:required"]);
    expect(kernel).toEqual(browser);
  });

  it("reads a null rules block or a null requiredWhen as no rule, on every side, as the 2.5 program did", () => {
    const nullRules = { id: "a", type: "text", configuration: {}, rules: null } as unknown as ComponentNode;
    const nullRule = { id: "b", type: "text", configuration: {}, rules: { requiredWhen: null } } as unknown as ComponentNode;
    const lenient: ComponentNode = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "ticked", type: "text", configuration: { required: true } }, nullRules, nullRule] } };
    expect(kernelRuleRequired(nullRules, {}, {}, {}, {})).toBe(false);
    expect(kernelRuleRequired(nullRule, {}, {}, {}, {})).toBe(false);
    const outcome = runKernel({ formId: "f", values: { ticked: "x" }, locale: "en", form: lenient }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ ticked: "x" });
    // The browser: the runtime constructs (its constructor folds), renders nothing required but the tick, and validates.
    const runtime = new FormRuntime(
      { id: "n", version: "1", schemaVersion: "1", root: lenient },
      { submissionModes: new SubmissionModeRegistry(), validationPipeline: new ValidationPipeline([createFieldConstraintsStage(lenient)]) }
    );
    expect(Object.fromEntries(runtime.requiredMap())).toEqual({ ticked: true, a: false, b: false });
    runtime.setValue("ticked", "x");
    return expect(runtime.validate()).resolves.toEqual([]);
  });
});

describe("portable kernel: runKernel enforces requiredWhen", () => {
  const read = (name: string): Expression => ({ kind: "path", path: name });
  const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
  const is = (name: string, value: string | number | boolean | null): Expression => ({ kind: "binary", operator: "eq", left: read(name), right: literal(value) });
  const byPhone = is("contact", "phone");
  const contact: ComponentNode = { id: "contact", type: "radio", configuration: { options: [{ value: "phone", label: "phone" }, { value: "email", label: "email" }, { value: "post", label: "post" }, { value: "on", label: "on" }] } };
  const formOf = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });
  const codesOf = (outcome: { errors: ReadonlyArray<{ code: string; componentId?: string | undefined }> }): string[] =>
    outcome.errors.map((error) => `${error.componentId ?? "-"}:${error.code}`);
  const constraintLog = (outcome: { logs?: Array<{ message: string; data?: unknown }> }): unknown =>
    outcome.logs?.find((entry) => entry.message.startsWith("field constraints"))?.data;

  it("refuses an empty answer while the rule holds, as the sandbox's own stage, and says which rule did it", () => {
    const root = formOf(contact, { id: "phone", type: "text", configuration: {}, rules: { requiredWhen: byPhone } });
    const blocked = runKernel({ formId: "f", values: { contact: "phone" }, locale: "en", form: root, logLevel: "debug" }, []);
    expect(blocked.errors).toEqual([{ code: "required", componentId: "phone", path: "phone", stage: "field-constraints", source: "wasm" }]);
    expect(blocked.values).toBeUndefined();
    expect(constraintLog(blocked)).toMatchObject({ requiredByRule: ["phone"] });

    const filled = runKernel({ formId: "f", values: { contact: "phone", phone: "555" }, locale: "en", form: root }, []);
    expect(filled.errors).toEqual([]);
    expect(filled.values).toEqual({ contact: "phone", phone: "555" });

    const off = runKernel({ formId: "f", values: { contact: "email" }, locale: "en", form: root, logLevel: "debug" }, []);
    expect(off.errors).toEqual([]);
    expect(off.values).toEqual({ contact: "email" });
    // Nothing the flag did not already say: the entry is left out.
    expect(constraintLog(off)).toBeUndefined();
  });

  it("follows the hidden-required policy: a hidden field is not held to its rule unless its policy says so", () => {
    const hidden = formOf(contact, { id: "phone", type: "text", configuration: {}, rules: { requiredWhen: byPhone, visibleWhen: is("contact", "never") } });
    expect(codesOf(runKernel({ formId: "f", values: { contact: "phone" }, locale: "en", form: hidden }, []))).toEqual([]);
    const still = formOf(contact, {
      id: "phone",
      type: "text",
      configuration: { hiddenValidationBehavior: "validate", hiddenRequiredBehavior: "required" },
      rules: { requiredWhen: byPhone, visibleWhen: is("contact", "never") }
    });
    expect(codesOf(runKernel({ formId: "f", values: { contact: "phone" }, locale: "en", form: still }, []))).toEqual(["phone:required"]);
    expect(codesOf(runKernel({ formId: "f", values: { contact: "email" }, locale: "en", form: still }, []))).toEqual([]);
  });

  it("reads a host. rule as false: the server is never stricter than the browser", () => {
    const hosted = formOf({ id: "staff_note", type: "text", configuration: {}, rules: { requiredWhen: is("host.role", "staff") } });
    const outcome = runKernel({ formId: "f", values: {}, locale: "en", form: hosted, externalData: { role: "staff" }, logLevel: "debug" }, []);
    expect(outcome.errors).toEqual([]);
    expect(constraintLog(outcome)).toBeUndefined();
  });

  it("keeps the tick when the rule is false: Required OR Required when", () => {
    const both = formOf(contact, { id: "both", type: "text", configuration: { required: true }, rules: { requiredWhen: is("contact", "never") } });
    const outcome = runKernel({ formId: "f", values: { contact: "email" }, locale: "en", form: both, logLevel: "debug" }, []);
    expect(codesOf(outcome)).toEqual(["both:required"]);
    // The flag did it, not the rule.
    expect(constraintLog(outcome)).not.toHaveProperty("requiredByRule");
  });

  it("reads a calculation the kernel worked out again, not the one submitted", () => {
    const calc = formOf(
      { id: "birth_year", type: "number", configuration: {} },
      { id: "age", type: "number", configuration: {}, rules: { value: { kind: "arithmetic", operator: "subtract", left: literal(2026), right: read("birth_year") } } },
      { id: "guardian", type: "text", configuration: {}, rules: { requiredWhen: { kind: "binary", operator: "lt", left: read("age"), right: literal(18) } } }
    );
    // A forged adult age beside a child's birth year: the server's own age asks for the guardian.
    expect(codesOf(runKernel({ formId: "f", values: { birth_year: 2015, age: 40 }, locale: "en", form: calc }, []))).toEqual(["guardian:required"]);
    const adult = runKernel({ formId: "f", values: { birth_year: 1990 }, locale: "en", form: calc }, []);
    expect(adult.errors).toEqual([]);
    expect(adult.values).toEqual({ birth_year: 1990, age: 36 });
  });

  it("never reads the rule on a data grid, a childless fieldset or a row field, whose own value is always empty", () => {
    const gated = formOf(
      contact,
      { id: "orders", type: "dataGrid", configuration: {}, children: { content: [{ id: "qty", type: "number", configuration: {} }] }, rules: { requiredWhen: byPhone } },
      { id: "extra", type: "fieldset", configuration: {}, rules: { requiredWhen: byPhone } },
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["sku"], collectionPath: "items" },
        children: { content: [{ id: "sku", type: "text", configuration: {}, rules: { requiredWhen: byPhone } }] }
      }
    );
    const outcome = runKernel({ formId: "f", values: { contact: "phone", "items[0].sku": "" }, locale: "en", form: gated, logLevel: "debug" }, []);
    expect(outcome.errors).toEqual([]);
    expect(constraintLog(outcome)).toBeUndefined();
  });
});

describe("portable kernel: runKernel judges a field a journey places on no page as the whole form judges it", () => {
  const read = (name: string): Expression => ({ kind: "path", path: name });
  const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
  const is = (name: string, value: string | number | boolean | null): Expression => ({ kind: "binary", operator: "eq", left: read(name), right: literal(value) });
  const staff = is("host.role", "staff");
  const codesOf = (outcome: { errors: ReadonlyArray<{ code: string; componentId?: string | undefined }> }): string[] =>
    outcome.errors.map((error) => `${error.componentId ?? "-"}:${error.code}`).sort();
  /**
   * A two-page journey leaves most of the form off every page: `ref` is required; `secret`
   * hides itself and is excluded; `staff_ref` and, through its fieldset, `nested_ref` are shown
   * by the host; `opt_in` is hidden on the form and opts in to being required and validated;
   * `total` is worked out from `cost`; `code` has a pattern. `extra` sits on a page the path
   * may skip.
   */
  const root: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "resident", type: "select", configuration: { required: true, options: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "on", label: "on" }] } },
        { id: "extra", type: "text", configuration: { required: true } },
        { id: "ref", type: "text", configuration: { required: true } },
        { id: "secret", type: "text", configuration: { required: true, hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: is("resident", "never") } },
        { id: "staff_ref", type: "text", configuration: { required: true }, rules: { visibleWhen: staff } },
        { id: "staff_box", type: "fieldset", configuration: {}, rules: { visibleWhen: staff }, children: { content: [{ id: "nested_ref", type: "text", configuration: { required: true } }] } },
        { id: "opt_in", type: "text", configuration: { hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" } },
        { id: "cost", type: "number", configuration: {} },
        { id: "total", type: "number", configuration: {}, rules: { value: { kind: "arithmetic", operator: "multiply", left: read("cost"), right: literal(2) } } },
        { id: "code", type: "text", configuration: { pattern: "[A-Z]{3}" } }
      ]
    }
  };
  const journey: Journey = {
    id: "short",
    pages: [
      { id: "start", components: ["resident"], routes: [{ when: { kind: "unary", operator: "not", operand: is("resident", "yes") }, to: "$end" }] },
      { id: "more", components: ["extra"] }
    ]
  };
  const run = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runKernel({ formId: "f", values, locale: "en", form: root, journey, ...extra }, []);
  const FILLED = { resident: "no", ref: "R-1", opt_in: "O-1", staff_ref: "S-1", nested_ref: "N-1" };

  it("refuses an empty required field on no page, and a hidden one that opts in, as the whole form does", () => {
    const empty = run({ resident: "no" }, { logLevel: "debug" });
    expect(codesOf(empty)).toEqual(["opt_in:required", "ref:required"]);
    expect(empty.values).toBeUndefined();
    // Not `secret` (hidden by its own rule), not `extra` (skipped page), and not the host-bound
    // ones, which keep the lenient fold on no page (below).
    expect(empty.logs?.find((entry) => entry.message.startsWith("field constraints"))?.data).toMatchObject({
      notValidated: ["extra", "secret", "staff_ref", "staff_box", "nested_ref"]
    });
    const filled = run(FILLED);
    expect(filled.errors).toEqual([]);
    expect(filled.values).toEqual(FILLED);
    // The whole form asks the same, plus the field on the page the journey skips. The host-bound
    // ones are not asked for (the rule is unevaluated on a server,
    // which reads such a visibility as hidden for requiredness).
    expect(codesOf(runKernel({ formId: "f", values: { resident: "no" }, locale: "en", form: root }, []))).toEqual([
      "extra:required",
      "opt_in:required",
      "ref:required"
    ]);
  });

  it("hides a field on no page by its own rule, its answer by its own behaviour", () => {
    const outcome = run({ ...FILLED, secret: "x" });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual(FILLED);
  });

  it("keeps the lenient fold for a field on no page whose visibility reads host. — its own rule's or its fieldset's: hidden, unchecked, not required, its answer kept", () => {
    // The server cannot replay the host, so on no page both sides keep the earlier fold for such
    // a field: a journey may leave it out unfilled, whatever `externalData` says
    // (no rule reads it); the whole form's server verdict does not require it either.
    const bare = { resident: "no", ref: "R-1", opt_in: "O-1" };
    for (const extra of [{}, { externalData: { role: "staff" } }, { externalData: { role: "public" } }]) {
      const empty = run(bare, extra);
      expect(empty.errors, JSON.stringify(extra)).toEqual([]);
      expect(empty.values, JSON.stringify(extra)).toEqual(bare);
      const given = run(FILLED, extra);
      expect(given.errors, JSON.stringify(extra)).toEqual([]);
      expect(given.values, JSON.stringify(extra)).toEqual(FILLED);
    }
    expect(codesOf(runKernel({ formId: "f", values: bare, locale: "en", form: root }, []))).toEqual(["extra:required"]);
    // Every other field on no page has exactly the state the whole form gives it on the server;
    // the host-bound ones are hidden and skipped, their answers retained.
    const fold = kernelFoldSubmission(root, FILLED, journey);
    const whole = kernelFoldSubmission(root, FILLED, undefined);
    for (const id of ["ref", "secret", "opt_in", "cost", "total", "code"]) {
      expect(fold.placements?.[id], id).toBe("unassigned");
      expect(fold.semantic[id], id).toEqual(whole.semantic[id]);
      expect(fold.effective[id], id).toEqual(whole.effective[id]);
    }
    for (const id of ["staff_ref", "staff_box", "nested_ref"]) {
      expect(fold.placements?.[id], id).toBe("unassigned");
      expect(fold.semantic[id], id).toEqual({
        visible: false,
        disabled: false,
        readonly: false,
        hiddenValueBehavior: "retain",
        hiddenValidationBehavior: "skip",
        hiddenRequiredBehavior: "not-required"
      });
      expect(fold.effective[id], id).toMatchObject({ visible: false, runValidation: false, requiredApplies: false, submitValue: true });
      expect(whole.effective[id], id).toMatchObject({ visible: true, runValidation: true, requiredApplies: true });
    }
  });

  it("keeps the lenient fold for a field on no page beside a listed one inside a host-shown fieldset, so the server agrees with a browser told any host context", () => {
    // `hbox` is structural: it holds `listed`, which is on the page. `sibling` beside it is on
    // no page; it must not follow the box (required on a server that cannot evaluate the
    // rule, not required in a browser told the person is not staff).
    const boxed: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { required: true } },
          {
            id: "hbox",
            type: "fieldset",
            configuration: {},
            rules: { visibleWhen: staff },
            children: { content: [{ id: "listed", type: "text", configuration: {} }, { id: "sibling", type: "text", configuration: { required: true } }] }
          }
        ]
      }
    };
    const short: Journey = { id: "short", pages: [{ id: "start", components: ["name", "listed"] }] };
    for (const extra of [{}, { externalData: { role: "staff" } }, { externalData: { role: "public" } }]) {
      const outcome = runKernel({ formId: "f", values: { name: "N" }, locale: "en", form: boxed, journey: short, ...extra }, []);
      expect(outcome.errors, JSON.stringify(extra)).toEqual([]);
      expect(outcome.values, JSON.stringify(extra)).toEqual({ name: "N" });
      // An answer sent for it is kept, as the earlier fold kept it.
      expect(runKernel({ formId: "f", values: { name: "N", sibling: "s" }, locale: "en", form: boxed, journey: short, ...extra }, []).values, JSON.stringify(extra)).toEqual({ name: "N", sibling: "s" });
    }
    const fold = kernelFoldSubmission(boxed, { name: "N" }, short);
    expect(fold.placements).toMatchObject({ name: "on", listed: "on", sibling: "unassigned" });
    expect(fold.placements?.hbox).toBeUndefined();
    expect(fold.effective.hbox?.visible).toBe(true);
    expect(fold.effective.listed).toMatchObject({ visible: true, requiredApplies: true });
    expect(fold.effective.sibling).toMatchObject({ visible: false, runValidation: false, requiredApplies: false, submitValue: true });
    // The whole form does not require it on a server: every side alike.
    expect(codesOf(runKernel({ formId: "f", values: { name: "N" }, locale: "en", form: boxed }, []))).toEqual([]);
  });

  it("still works a calculation on no page out and submits it", () => {
    const outcome = run({ ...FILLED, cost: 5 });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ ...FILLED, cost: 5, total: 10 });
    // A forged result is worked out again, as on the whole form.
    expect(run({ ...FILLED, cost: 5, total: 999 }).values).toEqual({ ...FILLED, cost: 5, total: 10 });
  });

  it("keeps an answer given for a field on no page and checks it, rather than dropping it", () => {
    expect(codesOf(run({ ...FILLED, code: "abc" }))).toEqual(["code:pattern"]);
    const kept = run({ ...FILLED, code: "ABC" });
    expect(kept.errors).toEqual([]);
    expect(kept.values).toEqual({ ...FILLED, code: "ABC" });
  });

  it("leaves a field on a skipped page as it was: withheld and not required", () => {
    const skipped = run({ ...FILLED, extra: "stale" });
    expect(skipped.errors).toEqual([]);
    expect(skipped.values).toEqual(FILLED);
    expect(codesOf(run({ ...FILLED, resident: "yes" }))).toEqual(["extra:required"]);
  });
});

// --- Components on no page -----------------------------------------------------

const path27 = (name: string): Expression => ({ kind: "path", path: name });
const literal27 = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const is27 = (name: string, value: string | number | boolean | null): Expression => ({ kind: "binary", operator: "eq", left: path27(name), right: literal27(value) });
const plus27 = (left: Expression, right: Expression): Expression => ({ kind: "arithmetic", operator: "add", left, right });
const formOf27 = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });
const codes27 = (outcome: { errors: ReadonlyArray<{ code: string; componentId?: string | undefined; parameters?: Record<string, unknown> | undefined }> }): string[] =>
  outcome.errors.map((error) => `${error.componentId ?? error.parameters?.field ?? "-"}:${error.code}`);

describe("portable kernel: a node that holds no data defines no key", () => {
  /** The keys a 2.6 program also knew for the `shapes` tree: each spelled like the value path of a node with no place in the data. */
  const NO_LONGER_KNOWN = ["go", "banner", "logo", "sign", "bare_panel", "bare_steps", "billing.fieldset_in", "visual", "odd"];

  it("lists a field, a data-scoping container, a data grid and a section's entries — no button, text, image, signature or plain group", () => {
    expect(kernelKnownKeyShapes(shapes)).toEqual({
      given: true,
      family: true,
      rows: true,
      billing: true,
      "billing.street": true,
      "billing.city": true,
      loose: true,
      items: true,
      "items[].name": true,
      inner: true
    });
    // Exactly the nodes the fold keys data by: one predicate for both.
    const index = kernelTreeIndex(shapes);
    const known = kernelKnownValuePaths(shapes);
    const paths = kernelValuePaths(shapes);
    // A data grid, like a section, is known at its collection path, not its value path.
    for (const id of ["given", "keyed", "go", "banner", "logo", "sign", "bare_panel", "bare_steps", "billing_address", "street", "fieldset_in", "city", "visual", "loose", "odd", "inner"]) {
      expect(known[paths[id]!] === true, id).toBe(kernelClaimsData(index.nodeById[id]!));
    }
    for (const key of NO_LONGER_KNOWN) {
      expect(known[key], key).toBeUndefined();
    }
  });

  const honest = { given: "g", family: "f", "billing.street": "Main", "billing.city": "Ottawa", loose: "l", "items[0].name": "first", inner: 3, "rows[0].x": 1 };
  const spelled = Object.fromEntries(NO_LONGER_KNOWN.map((key, index) => [key, `sent ${index}`]));

  it("strips a key spelled like such a node's value path, and says so", () => {
    const outcome = runKernel({ formId: "f", values: { ...honest, ...spelled }, locale: "en", form: shapes, logLevel: "info" }, []);
    expect(outcome.errors).toEqual([]);
    // `rows[0].x` names no column of the grid: unknown as before, stripped as before.
    const { "rows[0].x": _row, ...kept } = honest;
    expect(outcome.values).toEqual(kept);
    expect(outcome.logs?.find((entry) => entry.message === "unknown fields stripped")?.data).toEqual({ fields: ["rows[0].x", ...NO_LONGER_KNOWN] });
    expect(kernelSanitizeValues(spelled, shapes)).toEqual({});
  });

  it("keeps it in keep mode, as any key the schema does not define", () => {
    const outcome = runKernel({ formId: "f", values: { ...honest, ...spelled }, locale: "en", form: shapes, unknownFields: "keep" }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ ...honest, ...spelled });
  });

  it("refuses it in reject mode with unknown_field — a verdict a 2.6 program did not give", () => {
    const outcome = runKernel({ formId: "f", values: { ...honest, ...spelled }, locale: "en", form: shapes, unknownFields: "reject" }, []);
    expect(outcome.values).toBeUndefined();
    expect(outcome.errors).toEqual(
      ["rows[0].x", ...NO_LONGER_KNOWN].map((field) => ({ code: "unknown_field", stage: "sanitization", source: "wasm", parameters: { field } }))
    );
    const { "rows[0].x": _row, ...defined } = honest;
    const clean = runKernel({ formId: "f", values: defined, locale: "en", form: shapes, unknownFields: "reject" }, []);
    expect(clean.errors).toEqual([]);
    expect(clean.values).toEqual(defined);
  });

  it("lets no rule read such a key, whatever the mode keeps", () => {
    const gated = formOf27(
      { id: "go", type: "button", configuration: {} },
      { id: "box", type: "fieldset", configuration: {}, children: { content: [{ id: "after", type: "text", configuration: { required: true }, rules: { visibleWhen: is27("go", "clicked") } }] } },
      { id: "boxed", type: "text", configuration: { required: true }, rules: { visibleWhen: is27("box", "open") } }
    );
    for (const unknownFields of ["strip", "keep"] as const) {
      // A 2.6 program read `go` and `box` as answers, showed both fields and asked for them.
      const outcome = runKernel({ formId: "f", values: { go: "clicked", box: "open" }, locale: "en", form: gated, unknownFields }, []);
      expect(outcome.errors, unknownFields).toEqual([]);
      expect(outcome.values, unknownFields).toEqual(unknownFields === "keep" ? { go: "clicked", box: "open" } : {});
    }
    expect(codes27(runKernel({ formId: "f", values: { go: "clicked", box: "open" }, locale: "en", form: gated, unknownFields: "reject" }, []))).toEqual([
      "go:unknown_field",
      "box:unknown_field"
    ]);
  });

  it("works no calculation out for such a node: there is nowhere in the values for its result", () => {
    const calculated = formOf27(
      { id: "count", type: "number", configuration: {} },
      { id: "banner", type: "html", configuration: {}, rules: { value: plus27(path27("count"), literal27(1)) } },
      { id: "group", type: "fieldset", configuration: {}, rules: { value: literal27("g") }, children: { content: [] } },
      { id: "double", type: "number", configuration: {}, rules: { value: plus27(path27("count"), path27("count")) } }
    );
    const stripped = runKernel({ formId: "f", values: { count: 2, banner: 99 }, locale: "en", form: calculated }, []);
    expect(stripped.values).toEqual({ count: 2, double: 4 });
    // Kept, it stays as sent: no result of the kernel's own lands under a key the schema does not define.
    const kept = runKernel({ formId: "f", values: { count: 2, banner: 99 }, locale: "en", form: calculated, unknownFields: "keep" }, []);
    expect(kept.values).toEqual({ count: 2, banner: 99, double: 4 });
    expect(kept.clientDerived).toBeUndefined();
  });
});

describe("portable kernel: a data grid's rows follow their grid", () => {
  const column = (id: string, type = "text"): ComponentNode => ({ id, type, configuration: {} });
  const grid = (id: string, collectionPath: string, extra: Partial<ComponentNode> = {}, configuration: Record<string, unknown> = {}): ComponentNode => ({
    id,
    type: "dataGrid",
    configuration: { ...configuration },
    collection: { collectionPath },
    children: { content: [column("qty", "number"), column("sku")] },
    ...extra
  });
  const EXCLUDED = { hiddenValueBehavior: "exclude-from-submission" };
  const RETAINED = { hiddenValueBehavior: "retain" };
  const bigOrder: Expression = { kind: "binary", operator: "gt", left: path27("orders[0].qty"), right: literal27(5) };
  const rows = { "orders[0].qty": 10, "orders[0].sku": "A1", "orders[1].qty": 1, "orders[1].sku": "B2" };
  const whenFull = { rules: { visibleWhen: is27("kind", "full") } };
  const kind: ComponentNode = { id: "kind", type: "select", configuration: { options: [{ value: "short", label: "short" }, { value: "full", label: "full" }, { value: "skip", label: "skip" }, { value: "next", label: "next" }, { value: "route", label: "route" }, { value: "summary", label: "summary" }, { value: "questions", label: "questions" }] } };
  const rush: ComponentNode = { id: "rush", type: "text", configuration: { required: true }, rules: { visibleWhen: bigOrder } };

  it("registers the collection path as a collection owner, first in document order, as a section's is", () => {
    // The run reads the grids normalized: an unbound grid's rows are at its id.
    const tree = kernelNormalizeDataGrids(formOf27(
      grid("orders_grid", "orders"),
      { id: "lines", type: "repeatingSection", configuration: {}, collection: { collectionPath: "order_lines" }, children: { content: [] } },
      grid("late", "order_lines"),
      grid("same", "same"),
      { id: "bare", type: "dataGrid", configuration: {} },
      { id: "not_a_grid", type: "text", configuration: {} }
    ));
    const index = kernelTreeIndex(tree);
    // A grid with no binding keeps its rows at its id.
    expect({ ...kernelCollectionOwners(index) }).toStrictEqual({ orders: "orders_grid", order_lines: "lines", same: "same", bare: "bare" });
    // The journey's ownership reads the same paths, for the path engine's prefix view.
    expect({ ...journeyOwnership(tree, { id: "j", pages: [] }).collectionOwners }).toStrictEqual({ orders: "orders_grid", order_lines: "lines", same: "same", bare: "bare" });
  });

  it("no longer submits the rows of a hidden-and-excluded grid whose id is not its collection path, and they steer no rule", () => {
    const form = formOf27(kind, grid("orders_grid", "orders", whenFull, EXCLUDED), rush);
    const hidden = runKernel({ formId: "f", values: { kind: "short", ...rows, orders: [{ qty: 10 }] }, locale: "en", form, logLevel: "info" }, []);
    // A 2.6 program judged the rows by their leading segment `orders`, which names no component:
    // they were submitted whatever the grid's state, and `orders[0].qty` showed `rush` and required it.
    expect(hidden.errors).toEqual([]);
    expect(hidden.values).toEqual({ kind: "short" });
    // The list at `orders` beside the rows' own keys is dropped before the fold.
    expect(hidden.logs?.find((entry) => entry.message === "hidden values withheld")?.data).toEqual({ fields: [...Object.keys(rows)] });

    const shown = runKernel({ formId: "f", values: { kind: "full", ...rows }, locale: "en", form }, []);
    expect(codes27(shown)).toEqual(["rush:required"]);
    const answered = runKernel({ formId: "f", values: { kind: "full", ...rows, rush: "today" }, locale: "en", form }, []);
    expect(answered.values).toEqual({ kind: "full", ...rows, rush: "today" });
  });

  it("keeps the rows of a hidden grid that retains its value, as before", () => {
    const form = formOf27(kind, grid("orders_grid", "orders", whenFull, RETAINED), rush);
    const outcome = runKernel({ formId: "f", values: { kind: "short", ...rows }, locale: "en", form }, []);
    expect(codes27(outcome)).toEqual(["rush:required"]);
    expect(runKernel({ formId: "f", values: { kind: "short", ...rows, rush: "today" }, locale: "en", form }, []).values).toEqual({ kind: "short", ...rows, rush: "today" });
  });

  it("no longer submits the rows of a grid on a page the path skips, and they steer no route", () => {
    const form = formOf27(kind, grid("orders_grid", "orders"), { id: "reason", type: "text", configuration: { required: true } }, { id: "contact", type: "text", configuration: {} });
    const journey: Journey = {
      id: "ordering",
      pages: [
        { id: "start", components: ["kind"], routes: [{ when: bigOrder, to: "reach" }, { when: { kind: "unary", operator: "not", operand: is27("kind", "full") }, to: "why" }] },
        { id: "order", components: ["orders_grid"] },
        { id: "why", components: ["reason"] },
        { id: "reach", components: ["contact"] }
      ]
    };
    // Off the path: the rows are withheld, and the route that reads one is not taken — `reason` is asked.
    const skipped = runKernel({ formId: "f", values: { kind: "short", ...rows }, locale: "en", form, journey }, []);
    expect(codes27(skipped)).toEqual(["reason:required"]);
    const answered = runKernel({ formId: "f", values: { kind: "short", ...rows, reason: "restock" }, locale: "en", form, journey }, []);
    expect(answered.errors).toEqual([]);
    expect(answered.values).toEqual({ kind: "short", reason: "restock" });
    const fold = kernelFoldSubmission(form, { kind: "short", ...rows }, journey);
    expect(fold.trace?.pages).toEqual(["start", "why", "reach"]);
    // On the path: submitted, and read once the grid's page is on it — not by the first page's route.
    const taken = runKernel({ formId: "f", values: { kind: "full", ...rows, reason: "restock" }, locale: "en", form, journey }, []);
    expect(taken.values).toEqual({ kind: "full", ...rows, reason: "restock" });
    expect(kernelFoldSubmission(form, { kind: "full", ...rows }, journey).trace?.pages).toEqual(["start", "order", "why", "reach"]);
  });

  it("judges a grid whose id is its collection path", () => {
    const form = formOf27(kind, { ...grid("orders", "orders", whenFull, EXCLUDED) }, rush);
    expect(runKernel({ formId: "f", values: { kind: "short", ...rows }, locale: "en", form }, []).values).toEqual({ kind: "short" });
    expect(codes27(runKernel({ formId: "f", values: { kind: "full", ...rows }, locale: "en", form }, []))).toEqual(["rush:required"]);
  });
});

describe("portable kernel: answers worked out in the browser and kept as sent (clientDerived)", () => {
  const number = (id: string, value?: Expression, configuration: Record<string, unknown> = {}): ComponentNode => ({
    id,
    type: "number",
    configuration,
    ...(value !== undefined ? { rules: { value } } : {})
  });
  const run = (form: ComponentNode, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runKernel({ formId: "f", values, locale: "en", form, ...extra }, [], undefined, formulaFunctionSignatures());

  it("lists a calculation it kept unrecomputed while a value was there: one reading host., one with an unanswered read the browser may have withheld", () => {
    const form = formOf27(
      number("seeded", path27("host.limit")),
      // only an input that can be hidden and left out of the submission
      // makes its absence untrustworthy; an optional input never hidden is the person's own empty answer.
      { id: "nickname", type: "text", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: literal27(true) } },
      { id: "greeting", type: "text", configuration: {}, rules: { value: { kind: "call", name: "concat", args: [literal27("Hi "), path27("nickname")] } } },
      number("cost"),
      number("total", plus27(path27("cost"), literal27(1)))
    );
    const outcome = run(form, { seeded: 5, greeting: "Hi ", cost: 2, total: 3 });
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ seeded: 5, greeting: "Hi ", cost: 2, total: 3 });
    expect(outcome.clientDerived).toEqual(["seeded", "greeting"]);
    // With its input answered the kernel works `greeting` out itself: nothing taken on trust.
    expect(run(form, { nickname: "Ada", greeting: "forged", cost: 2 }).clientDerived).toBeUndefined();
    expect(run(form, { nickname: "Ada", greeting: "forged", cost: 2 }).values).toEqual({ nickname: "Ada", greeting: "Hi Ada", cost: 2, total: 3 });
    // Nothing sent for them: nothing kept, nothing listed. Present only when there is one.
    expect("clientDerived" in run(form, { cost: 2 })).toBe(false);
  });

  it("does not call a kept null a value: JSON's spelling of a NaN is an unanswered calculation", () => {
    const form = formOf27(
      number("income"),
      number("members"),
      number("ratio", { kind: "arithmetic", operator: "divide", left: path27("income"), right: path27("members") }),
      number("per_person", { kind: "call", name: "coalesce", args: [path27("ratio"), literal27(0)] })
    );
    // `members` is an optional input never hidden, so its absence is the person's:
    // `ratio` is worked out over it to no answer, and the `null` is dropped.
    const outcome = run(form, { income: 1200, ratio: null, per_person: 0 });
    expect(outcome.values).toEqual({ income: 1200, per_person: 0 });
    expect(outcome.clientDerived).toBeUndefined();
    // So a number forged for it with the input missing is replaced, not taken on trust.
    const forged = run(form, { income: 1200, ratio: 7, per_person: 7 });
    expect(forged.values).toEqual({ income: 1200, per_person: 0 });
    expect(forged.clientDerived).toBeUndefined();
    // An input the browser may have hidden and left out is a read the server cannot tell from an empty
    // one: a number sent for the calculation with that input missing is taken on trust, and so is what reads it.
    const withheld = formOf27(
      number("income"),
      { id: "members", type: "number", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: literal27(true) } },
      number("ratio", { kind: "arithmetic", operator: "divide", left: path27("income"), right: path27("members") }),
      number("per_person", { kind: "call", name: "coalesce", args: [path27("ratio"), literal27(0)] })
    );
    const trusted = run(withheld, { income: 1200, ratio: 7, per_person: 7 });
    expect(trusted.values).toEqual({ income: 1200, ratio: 7, per_person: 7 });
    expect(trusted.clientDerived).toEqual(["ratio", "per_person"]);
  });

  it("works a calculation over a missing or zero operand out to no answer: no key, no NaN, nothing taken on trust", () => {
    const form = formOf27(
      number("income"),
      number("members"),
      number("ratio", { kind: "arithmetic", operator: "divide", left: path27("income"), right: path27("members") }),
      number("fee", { kind: "arithmetic", operator: "multiply", left: path27("members"), right: literal27(2) })
    );
    // Division by zero, reproduced here: no answer, and no `ratio` key in the values.
    const zero = run(form, { income: 1200, members: 0 });
    expect(zero.errors).toEqual([]);
    expect(zero.values).toEqual({ income: 1200, members: 0, fee: 0 });
    expect("ratio" in (zero.values ?? {})).toBe(false);
    expect(zero.clientDerived).toBeUndefined();
    // A forged ratio over a zero household is worked out again: no answer.
    expect(run(form, { income: 1200, members: 0, ratio: 7 }).values).toEqual({ income: 1200, members: 0, fee: 0 });
    // The operand missing: what a browser sends (no `ratio`, no `fee`) comes back as sent, and nothing is listed as client-derived.
    const missing = run(form, { income: 1200 });
    expect(missing.errors).toEqual([]);
    expect(missing.values).toEqual({ income: 1200 });
    expect(missing.clientDerived).toBeUndefined();
    // Answered, both sides agree on the number.
    expect(run(form, { income: 1200, members: 3 }).values).toEqual({ income: 1200, members: 3, ratio: 400, fee: 6 });
    // Required, a calculation with no answer is unanswered.
    const required = formOf27(number("members"), { id: "fee", type: "number", configuration: { required: true }, rules: { value: { kind: "arithmetic", operator: "multiply", left: path27("members"), right: literal27(2) } } });
    expect(codes27(run(required, {}))).toEqual(["fee:required"]);
    expect(codes27(run(required, { members: 0 }))).toEqual([]);
  });

  it("reproduces a calculation that reads another's no answer: this side knows that answer is none, so nothing is taken on trust", () => {
    const form = formOf27(
      number("income"),
      number("members"),
      number("ratio", { kind: "arithmetic", operator: "divide", left: path27("income"), right: path27("members") }),
      number("per_person", { kind: "call", name: "coalesce", args: [path27("ratio"), literal27(0)] })
    );
    // The ratio over a missing or zero household is no answer (no key sent); per_person reads it
    // and goes on to 0, worked out again here rather than kept as sent.
    for (const sent of [
      { income: 1200, per_person: 0 },
      { income: 1200, members: 0, per_person: 0 }
    ]) {
      const honest = run(form, sent);
      expect(honest.errors, JSON.stringify(sent)).toEqual([]);
      expect(honest.values, JSON.stringify(sent)).toEqual(sent);
      expect(honest.clientDerived, JSON.stringify(sent)).toBeUndefined();
      // A forged per_person over that ratio is worked out again to 0, not taken on trust.
      const forged = run(form, { ...sent, per_person: 7 });
      expect(forged.values, JSON.stringify(sent)).toEqual(sent);
      expect(forged.clientDerived, JSON.stringify(sent)).toBeUndefined();
    }
    // A read of a plain field with no answer is the person's empty answer: worked out over, not taken on trust.
    const plain = formOf27(number("members"), number("fee", { kind: "call", name: "coalesce", args: [path27("members"), literal27(0)] }));
    const worked = run(plain, { fee: 9 });
    expect(worked.values).toEqual({ fee: 0 });
    expect(worked.clientDerived).toBeUndefined();
    // …unless the field can be hidden and left out of the submission: then it is not reproducible, kept as sent, listed.
    const hideable = formOf27(
      { id: "members", type: "number", configuration: { hiddenValueBehavior: "clear" }, rules: { visibleWhen: literal27(true) } },
      number("fee", { kind: "call", name: "coalesce", args: [path27("members"), literal27(0)] })
    );
    const kept = run(hideable, { fee: 9 });
    expect(kept.values).toEqual({ fee: 9 });
    expect(kept.clientDerived).toEqual(["fee"]);
  });

  it("lists every calculation that reads one of them, through any number of others, in document order", () => {
    const form = formOf27(
      number("last", plus27(path27("middle"), literal27(1))),
      number("base", path27("host.start")),
      number("middle", plus27(path27("base"), literal27(1))),
      number("cost"),
      number("apart", plus27(path27("cost"), literal27(1))),
      { id: "box", type: "container", configuration: {}, children: { content: [number("nested", plus27(path27("last"), path27("cost")), { dataKey: "deep" })] } }
    );
    const outcome = run(form, { base: 10, cost: 1 });
    expect(outcome.values).toEqual({ base: 10, cost: 1, middle: 11, last: 12, apart: 2, "box.deep": 13 });
    // As value paths, in the form's order — not the order they were found in.
    expect(outcome.clientDerived).toEqual(["last", "base", "middle", "box.deep"]);
    const fold = kernelFoldSubmission(form, { base: 10, cost: 1 }, undefined);
    expect(fold.clientDerived).toEqual(["last", "base", "middle", "box.deep"]);
  });

  it("lists only what is submitted, but follows a withheld answer into what read it", () => {
    const hiddenAway = { hiddenValueBehavior: "exclude-from-submission", hidden: true };
    const form = formOf27(number("base", path27("host.start"), hiddenAway), number("reads", plus27(path27("base"), literal27(1))), number("cleared", path27("host.other"), { hidden: true, hiddenValueBehavior: "clear" }));
    const outcome = run(form, { base: 10, cleared: 3 });
    // `base` is withheld and `cleared` cleared: neither is a judged value. `reads` was worked out from `base`.
    expect(outcome.values).toEqual({ reads: 11 });
    expect(outcome.clientDerived).toEqual(["reads"]);
  });

  it("reports them on a run that blocked too: they describe the answers judged", () => {
    const form = formOf27(number("seeded", path27("host.limit")), { id: "name", type: "text", configuration: { required: true } });
    const outcome = run(form, { seeded: 5 });
    expect(codes27(outcome)).toEqual(["name:required"]);
    expect(outcome.values).toBeUndefined();
    expect(outcome.clientDerived).toEqual(["seeded"]);
  });

  it("works out a calculation inside a repeating section entry by entry, and lists an entry taken on trust by its key", () => {
    const form = formOf27({
      id: "lines",
      type: "repeatingSection",
      configuration: {},
      collection: { itemFields: ["qty", "double"] },
      children: { content: [number("qty"), number("double", { kind: "arithmetic", operator: "multiply", left: path27("row.qty"), right: literal27(2) })] }
    });
    // A forged entry result is replaced , and nothing is taken on trust.
    const outcome = run(form, { "lines[0].qty": 2, "lines[0].double": 5 });
    expect(outcome.values).toEqual({ "lines[0].qty": 2, "lines[0].double": 4 });
    expect(outcome.clientDerived).toBeUndefined();
    // An entry the person sent no input of cannot be worked out: kept as sent, listed by the entry's key.
    const lacking = run(form, { "lines[0].qty": 2, "lines[0].double": 4, "lines[1].double": 9 });
    expect(lacking.values).toEqual({ "lines[0].qty": 2, "lines[0].double": 4, "lines[1].double": 9 });
    expect(lacking.clientDerived).toEqual(["lines[1].double"]);
  });

  it("reports what the recompute kept: the value paths, in document order, a null and an absent one left out", () => {
    const form = formOf27(
      number("b", path27("missing")),
      number("a", path27("host.x")),
      number("nothing", path27("host.y")),
      number("empty", path27("host.z")),
      number("fine", plus27(path27("n"), literal27(1))),
      number("n")
    );
    const index = kernelTreeIndex(form);
    const result = kernelRecomputeCalculations(form, kernelJsonAnswers({ b: 1, a: 2, empty: null, n: 1, fine: 0 }), index, kernelValuePaths(form), kernelComponentIdsByPath(form));
    expect(result.unreproduced).toEqual(["b", "a"]);
    expect(result.recalculated).toEqual(["fine"]);
    expect(result.converged).toBe(true);
    // Nothing calculated at all: the values as given, and nothing to report.
    const plain = formOf27(number("n"));
    const values = kernelJsonAnswers({ n: 1 });
    expect(kernelRecomputeCalculations(plain, values, kernelTreeIndex(plain), kernelValuePaths(plain), kernelComponentIdsByPath(plain))).toEqual({ values, recalculated: [], unreproduced: [], converged: true });
  });

  it("lists the target of a presentation's worked-out value on the path, and never an alias's", () => {
    const form = formOf27(
      { id: "email", type: "text", configuration: { required: true } },
      number("income", undefined, { required: true }),
      number("tax", { kind: "arithmetic", operator: "multiply", left: path27("income"), right: literal27(2) }),
      { id: "skip", type: "checkbox", configuration: {} }
    );
    const journey: Journey = {
      id: "apply",
      pages: [
        { id: "you", components: ["skip", { id: "work_email", type: "text", configuration: { fills: "email" } }], routes: [{ when: path27("skip"), to: "$end" }] },
        {
          id: "money",
          components: [{ id: "m1", type: "number" }, { id: "sum", type: "journey-value", configuration: { to: "income", value: path27("m1") } }]
        }
      ]
    };
    const on = run(form, { email: "a@b.co", income: 100 }, { journey });
    expect(on.errors).toEqual([]);
    expect(on.values).toEqual({ email: "a@b.co", income: 100, tax: 200 });
    // The field worked out in the browser, and the form's own calculation over it; not the alias's answer.
    expect(on.clientDerived).toEqual(["income", "tax"]);
    // Its page skipped, the target is off the path: withheld, not required, not listed — and the
    // form's calculation over it reads the settled view, where the figure is absent:
    // not worked out from an answer the path left out.
    const off = run(form, { email: "a@b.co", skip: true, income: 100 }, { journey });
    expect(off.errors).toEqual([]);
    expect(off.values).toEqual({ email: "a@b.co", skip: true });
    expect(off.clientDerived).toBeUndefined();
    // …as it is over the envelope a browser sends, which leaves the withheld figure out.
    const sent = run(form, { email: "a@b.co", skip: true }, { journey });
    expect(sent.values).toEqual(off.values);
    // Kept off the path by the journey's offPathValues, the target is a judged value: listed.
    const retained = run(form, { email: "a@b.co", skip: true, income: 100 }, { journey: { ...journey, offPathValues: "retain" } });
    expect(retained.values).toEqual({ email: "a@b.co", skip: true, income: 100, tax: 200 });
    expect(retained.clientDerived).toEqual(["income", "tax"]);
    // Judged as the whole form, nothing is worked out by a presentation: the answer is the person's.
    expect(run(form, { email: "a@b.co", income: 100 }).clientDerived).toBeUndefined();
    // The list is worked out from the ownership alone: no own node's rule, no expression is read.
    const index = kernelTreeIndex(form);
    const fold = kernelFoldSubmission(form, { email: "a@b.co", income: 100 }, journey);
    expect(kernelClientDerived(journeyOwnership(form, journey), fold, [], index, kernelValuePaths(form), kernelComponentIdsByPath(form))).toEqual(["income", "tax"]);
    expect(kernelClientDerived(undefined, fold, [], index, kernelValuePaths(form), kernelComponentIdsByPath(form))).toEqual([]);
  });

  it("crosses the ABI as part of the outcome, and an outcome without one is what it always was", () => {
    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const form = formOf27(number("seeded", path27("host.limit")), number("plain"));
    const through = (values: Record<string, unknown>) => abi.deserializeOutcome(instance.run(abi.serializeContext({ formId: "f", values, locale: "en", form }, WasmValidationHost.STRICT_POLICY)) as string);
    expect(through({ seeded: 5, plain: 1 })).toEqual({
      errors: [],
      values: { seeded: 5, plain: 1 },
      index: [
        { path: "plain", delta: "", value: 1 },
        { path: "seeded", delta: "", value: 5 }
      ],
      clientDerived: ["seeded"]
    });
    expect(through({ plain: 1 })).toEqual({ errors: [], values: { plain: 1 }, index: [{ path: "plain", delta: "", value: 1 }] });
  });
});

describe("portable kernel: the components in scope for a journey page (context.page)", () => {
  const form = formOf27(
    { id: "email", type: "text", configuration: { required: true } },
    { id: "name", type: "text", configuration: {} },
    { id: "money", type: "fieldset", configuration: {}, children: { content: [{ id: "income", type: "number", configuration: { required: true } }, { id: "savings", type: "number", configuration: {} }] } },
    { id: "address", type: "container", configuration: {}, children: { content: [{ id: "street", type: "text", configuration: {} }, { id: "city", type: "text", configuration: {} }] } },
    { id: "left_out", type: "text", configuration: {} }
  );
  const journey: Journey = {
    id: "apply",
    pages: [
      { id: "you", components: ["name", { id: "work_email", type: "text", configuration: { fills: "email" } }, { id: "where", type: "grid", children: { content: [{ type: "journey-field", configuration: { componentId: "address" } }] } }] },
      {
        id: "money-page",
        components: [{ id: "m1", type: "number" }, { id: "sum", type: "journey-value", configuration: { to: "income", value: path27("m1") } }, "savings"],
        routes: [{ when: { kind: "unary", operator: "not", operand: is27("name", "stop") }, to: "$end" }]
      },
      { id: "bye", kind: "exit" }
    ]
  };
  const values = { email: "a@b.co", income: 5 };
  const run = (extra: Record<string, unknown>) => runKernel({ formId: "f", values, locale: "en", form, ...extra }, []);

  it("lists the form components the page places — listed, referenced, filled or worked out — in document order, never an own node", () => {
    expect(run({ journey, page: "you" }).pageComponentIds).toEqual(["email", "name", "address", "street", "city"]);
    expect(run({ journey, page: "money-page" }).pageComponentIds).toEqual(["income", "savings"]);
    const ownership = journeyOwnership(form, journey);
    expect(kernelPageComponentIds(ownership, "you")).toEqual(["email", "name", "address", "street", "city"]);
    expect(kernelPageComponentIds(JSON.parse(JSON.stringify(ownership)) as typeof ownership, "money-page")).toEqual(["income", "savings"]);
  });

  it("answers with an empty list for a page that places nothing, and for one the journey does not have", () => {
    expect(run({ journey, page: "bye" }).pageComponentIds).toEqual([]);
    expect(run({ journey, page: "nowhere" }).pageComponentIds).toEqual([]);
    expect(run({ journey, page: "constructor" }).pageComponentIds).toEqual([]);
  });

  it("leaves the verdict the whole submission's, and says nothing without a page or without a usable journey", () => {
    const scoped = run({ journey, page: "you" });
    const whole = run({ journey });
    expect("pageComponentIds" in whole).toBe(false);
    expect(whole.errors).toEqual([]);
    expect(scoped.errors).toEqual(whole.errors);
    expect(scoped.values).toEqual(whole.values);
    expect("pageComponentIds" in run({ page: "you" })).toBe(false);
    expect("pageComponentIds" in run({ journey, page: 3 })).toBe(false);
    const invalid = run({ journey: { id: "apply" }, page: "you" });
    expect(invalid.errors[0]?.code).toBe("journey.invalid");
    expect("pageComponentIds" in invalid).toBe(false);
    // A run that blocks still says which components the page holds: the host keeps those errors.
    const blocked = runKernel({ formId: "f", values: {}, locale: "en", form, journey, page: "money-page" }, []);
    expect(codes27(blocked)).toEqual(["email:required", "income:required"]);
    expect(blocked.pageComponentIds).toEqual(["income", "savings"]);
  });

  it("crosses the ABI: context.page in, pageComponentIds out", () => {
    const abi = new JsonWasmAbi();
    const instance = new InProcessWasmHostAdapter().instantiate([], abi);
    const payload = abi.serializeContext({ formId: "f", values, locale: "en", form, journey, page: "you" }, WasmValidationHost.STRICT_POLICY);
    expect(JSON.parse(payload)).toMatchObject({ page: "you" });
    const outcome = abi.deserializeOutcome(instance.run(payload) as string);
    expect(outcome.pageComponentIds).toEqual(["email", "name", "address", "street", "city"]);
    expect(outcome.clientDerived).toEqual(["income"]);
  });
});

describe("portable kernel: the presentation functions are spliced", () => {
  it("lists them with the path engine's", () => {
    expect(PORTABLE_KERNEL_FUNCTIONS.map((fn) => fn.name)).toEqual(
      expect.arrayContaining([
        "kernelClientDerived",
        "kernelPageComponentIds",
        "kernelIsPresentationNode",
        "journeyHoldsOwnAnswer",
        "journeyOwnNodeRule",
        "journeyOwnNodeUsable",
        "journeyFormKeys",
        "journeyTargetUsable"
      ])
    );
  });
});

/**
 * Formulas, run scopes and the clock in the kernel: the context's
 * definition is compiled into a copy and never changed; every rule reader skips what the
 * server does not apply; the day comes from the context; the outcome names what turned on the
 * clock and which server-only rules ran.
 */
describe("portable kernel: formulas, run scopes and the clock", () => {
  const signatures = formulaFunctionSignatures();
  const TODAY = "2026-10-07";

  function formulaForm(): ComponentNode {
    return {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: {} },
          { id: "dob", type: "date", configuration: {} },
          { id: "age", type: "number", configuration: {}, rules: { value: "age(dob)" } },
          { id: "band", type: "text", configuration: {}, rules: { value: 'if age >= 18 then "adult" else "minor"' } },
          { id: "guardian", type: "text", configuration: {}, rules: { visibleWhen: "not(empty(name)) and age < 18", requiredWhen: "age < 18" } },
          { id: "consent", type: "checkbox", configuration: {}, rules: { requiredWhen: { formula: "not(empty(name))", run: "server-secret" } } },
          { id: "browser_note", type: "text", configuration: {}, rules: { value: { formula: 'concat(name, "!")', run: "browser" }, visibleWhen: { formula: "false", run: "browser" } } },
          { id: "server_only", type: "text", configuration: { required: true, hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: { formula: "false", run: "server" } } },
          { id: "stale", type: "text", configuration: {}, rules: { value: 'if name = "one" then "one"' } }
        ]
      }
    };
  }

  const judge = (values: Record<string, unknown>, extra: Record<string, unknown> = {}, form: ComponentNode = formulaForm(), validators: readonly KernelValidator[] = []) =>
    runKernel({ formId: "f", values, locale: "en", form, ...extra }, validators, undefined, signatures);

  it("reads string rules exactly as the browser resolver reads their trees, over the same day", () => {
    const root = formulaForm();
    const compiled = kernelCompileDefinition(root, undefined, undefined, kernelParseFormula, signatures);
    expect(compiled.problems).toEqual([]);
    const tree = compiled.definition.root;
    const index = kernelTreeIndex(tree);
    const pathOf = kernelValuePaths(tree);
    const resolver = new RulesSemanticStateResolver();
    const byId = (node: ComponentNode) => node.children?.content?.find((child) => child.id === "guardian") ?? node;
    for (const values of [
      { name: "Ada", age: 12 },
      { name: "Ada", age: 40 },
      { name: "", age: 12 },
      { age: 12 }
    ] as Array<Record<string, unknown>>) {
      const node = byId(tree);
      const kernel = kernelResolveSemanticState(node, values, values, pathOf, index.parentOf, { today: TODAY });
      const browser = resolver.resolve(node, {
        values,
        locale: "en",
        hostContext: {},
        today: TODAY,
        valueOf: (id) => values[id],
        ancestorValuesFor: () => ({})
      });
      expect(kernel, JSON.stringify(values)).toEqual(browser);
    }
  });

  it("never changes the context's definition: the author's object is byte-identical after a run", () => {
    const form = formulaForm();
    const before = JSON.stringify(form);
    const outcome = judge({ name: "Ada", dob: "2010-05-10", age: 1, band: "x", guardian: "G", consent: true, server_only: "s" }, { today: TODAY }, form);
    expect(JSON.stringify(form)).toBe(before);
    // The rule on age was worked out again from dob and the day; band from age.
    expect(outcome.values).toMatchObject({ age: 16, band: "minor", guardian: "G" });
  });

  it("applies a calculation and a required rule by the context's day, and lists the components that turned on it", () => {
    const grown = judge({ name: "Ada", dob: "2000-05-10", consent: true, server_only: "s" }, { today: TODAY });
    expect(grown.errors).toEqual([]);
    expect(grown.values).toMatchObject({ age: 26, band: "adult" });
    expect(grown.values).not.toHaveProperty("guardian");
    // age reads the clock; band, guardian read age, not the clock.
    expect(grown.clockDependent).toEqual(["age"]);
    const young = judge({ name: "Ada", dob: "2015-05-10", consent: true, server_only: "s" }, { today: TODAY });
    expect(young.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["guardian:required"]);
  });

  it("skips a clock-reading calculation when no day was given, keeping its answer as sent and listing it in clientDerived", () => {
    const outcome = judge({ name: "Ada", dob: "2000-05-10", age: 99, consent: true, server_only: "s" });
    expect(outcome.errors).toEqual([]);
    // age kept as sent (unreproduced), band worked out from the kept age.
    expect(outcome.values).toMatchObject({ age: 99, band: "adult" });
    expect(outcome.clientDerived).toEqual(["age", "band"]);
    expect(outcome.clockDependent).toEqual(["age"]);
  });

  it("warns about a day that is not a calendar date and treats it as absent", () => {
    const outcome = judge({ name: "Ada", dob: "2000-05-10", age: 99, consent: true, server_only: "s" }, { today: "2026-02-30" });
    expect(outcome.logs?.map((entry) => `${entry.level}: ${entry.message}`)).toEqual([
      "warn: context.today is not a YYYY-MM-DD calendar date; treated as absent"
    ]);
    expect(outcome.values).toMatchObject({ age: 99 });
  });

  it("skips a browser rule as a host. read, enforces a server or server-secret rule, and lists the components whose server rules ran", () => {
    const outcome = judge({ name: "Ada", dob: "2000-05-10", browser_note: "sent", consent: true, server_only: "s" }, { today: TODAY });
    expect(outcome.errors).toEqual([]);
    // browser_note: its visibility rule is the browser's (the kernel keeps it configured:
    // visible), its calculation kept as sent and taken on trust. server_only: hidden by a
    // server rule, so its required flag does not apply and its answer is dropped.
    expect(outcome.values).toMatchObject({ browser_note: "sent" });
    expect(outcome.values).not.toHaveProperty("server_only");
    expect(outcome.clientDerived).toEqual(["browser_note"]);
    expect(outcome.serverRules).toEqual(["consent", "server_only"]);
    // consent: required by a secret rule the browser never had.
    const missing = judge({ name: "Ada", dob: "2000-05-10", server_only: "s" }, { today: TODAY });
    expect(missing.errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(["consent:required"]);
    expect(missing.serverRules).toEqual(["consent", "server_only"]);
  });

  it("drops the submitted answer of a calculation whose if has no case holding and no else", () => {
    const outcome = judge({ name: "two", dob: "2000-05-10", stale: "leftover", consent: true, server_only: "s" }, { today: TODAY, logLevel: "info" });
    expect(outcome.values).not.toHaveProperty("stale");
    expect(outcome.logs?.find((entry) => entry.message === "calculations recomputed")?.data).toEqual({ fields: ["age", "band", "stale"] });
    expect(judge({ name: "one", dob: "2000-05-10", consent: true, server_only: "s" }, { today: TODAY }).values).toMatchObject({ stale: "one" });
  });

  it("judges a formula that does not parse by the policy: fail (the default) refuses the run, warn logs and drops it, a word that is neither is no word", () => {
    const broken: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "a", type: "text", configuration: { required: true } },
          { id: "b", type: "text", configuration: {}, rules: { visibleWhen: "a = ", requiredWhen: { formula: "not(empty(a))", run: "server" } } }
        ]
      }
    };
    const validator: KernelValidator = () => ({ errors: [{ code: "custom", stage: "validation", source: "custom" }] });
    // Nothing said by the host or the form: the run is refused.
    expect(judge({ a: "x" }, {}, broken, [validator]).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    const warned = judge({ a: "x" }, { formulaErrors: "warn" }, broken, [validator]);
    expect(warned.logs?.map((entry) => `${entry.level}: ${entry.message}`)).toEqual([
      expect.stringMatching(/^warn: formula invalid: rules:b:visibleWhen: /)
    ]);
    // The broken rule is absent; the other rule still runs, and so does the validator.
    expect(warned.errors.map((error) => `${error.componentId ?? "-"}:${error.code}`)).toEqual(["b:required", "-:custom"]);

    // A word that is neither is no word: the default refuses.
    expect(judge({ a: "x" }, { formulaErrors: "ignore" as never }, broken, [validator]).errors.map((error) => error.code)).toEqual(["formula.invalid"]);

    const refused = judge({ a: "" }, { formulaErrors: "fail" }, broken, [validator]);
    expect(refused.errors).toEqual([
      { code: "formula.invalid", stage: "definition", source: "wasm", parameters: { where: "rules:b:visibleWhen", message: expect.any(String) } }
    ]);
    expect(refused.values).toBeUndefined();
    expect(refused.logs?.map((entry) => entry.level)).toEqual(["error", "error"]);

    // The form's own setting applies when the context says nothing; the context's word wins.
    const strict: ComponentNode = { ...broken, configuration: { formulaErrors: "fail" } };
    expect(judge({ a: "x" }, {}, strict).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    expect(judge({ a: "x" }, { formulaErrors: "warn" }, strict).errors.map((error) => error.code)).toEqual(["required"]);
  });

  it("reports a server scope on a default as a problem and runs the default on neither side", () => {
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "a", type: "text", configuration: {}, rules: { defaultValue: { formula: '"x"', run: "server" } } }] }
    };
    // Default fail refuses; the warn opt-in logs and runs the default on neither side.
    expect(judge({}, {}, form).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    const outcome = judge({}, { formulaErrors: "warn" }, form);
    expect(outcome.logs?.map((entry) => entry.message)).toEqual([expect.stringMatching(/^formula invalid: rules:a:defaultValue: /)]);
    expect(outcome.values).toEqual({});
  });

  it("knows only the built-ins without signatures, so a plugin's call is reported, and reads a plugin function from the registry it is given", () => {
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "a", type: "text", configuration: {} }, { id: "b", type: "text", configuration: {}, rules: { value: "shout(a)" } }] }
    };
    const unknown = runKernel({ formId: "f", values: { a: "hi" }, locale: "en", form }, []);
    // A calculation the server runs that calls a function it does not have is refused by name
    //, under `warn` too; it used to be dropped with a warn line.
    expect(unknown.logs?.map((entry) => entry.message)).toEqual([
      expect.stringMatching(/^formula invalid: rules:b:value: /),
      "the definition is refused: 1 formula problem(s); nothing else is judged"
    ]);
    expect(unknown.errors).toEqual([
      { code: "formula.invalid", stage: "definition", source: "wasm", parameters: { where: "rules:b:value", message: expect.any(String), function: "shout" } }
    ]);
    const shout = (args: unknown[]): unknown => String(args[0]).toUpperCase();
    const known = runKernel({ formId: "f", values: { a: "hi" }, locale: "en", form }, [], { shout }, [...signatures, { name: "shout", min: 1, max: 1 }]);
    expect(known.logs).toBeUndefined();
    expect(known.values).toEqual({ a: "hi", b: "HI" });
  });

  it("carries today and formulaErrors across the ABI, and clockDependent and serverRules back", () => {
    const abi = new JsonWasmAbi();
    const context = { formId: "f", values: { name: "Ada", dob: "2000-05-10", consent: true, server_only: "s" }, locale: "en", form: formulaForm(), today: TODAY, formulaErrors: "warn" as const };
    const payload = abi.serializeContext(context, WasmValidationHost.STRICT_POLICY);
    expect(JSON.parse(payload)).toMatchObject({ today: TODAY, formulaErrors: "warn" });
    const outcome = runKernel(abi.deserializeContext(payload), [], undefined, signatures);
    const back = abi.deserializeOutcome(abi.serializeOutcome(outcome));
    expect(back.clockDependent).toEqual(["age"]);
    expect(back.serverRules).toEqual(["consent", "server_only"]);
    expect(abi.serializeOutcome(back)).toBe(abi.serializeOutcome(outcome));
  });

  it("lists neither key for a form without formulas, so a run says what it always said", () => {
    const outcome = runKernel({ formId: "f", values: { email: "a@b.co" }, locale: "en", form: tree }, [], undefined, signatures);
    expect(outcome).not.toHaveProperty("clockDependent");
    expect(outcome).not.toHaveProperty("serverRules");
    expect(outcome.logs).toBeUndefined();
  });
});

describe("portable kernel: attachment sizes and uncompilable patterns", () => {
  const fileForm = (configuration: Record<string, unknown>): ComponentNode => ({
    id: "form",
    type: "form",
    configuration: {},
    children: { content: [{ id: "doc", type: "file", configuration: { accept: ".png,image/png", maxFileSizeMb: 1, ...configuration } }] }
  });
  const single = fileForm({});
  const multi = fileForm({ multiple: true });
  const att = (size: number) => ({ storage: "inline", name: "a.png", type: "image/png", size });
  const codesOf = (outcome: { errors: Array<{ componentId?: string; code: string }> }) => outcome.errors.map((error) => `${error.componentId}:${error.code}`);
  const judge = (form: ComponentNode, values: Record<string, unknown>) => runKernel({ formId: "f", values, locale: "en", form }, []);

  it("refuses an attachment whose declared size is negative or fractional (fileSize), before the limits read it", () => {
    expect(codesOf(judge(single, { doc: att(10) }))).toEqual([]);
    const negative = judge(single, { doc: att(-1) });
    expect(codesOf(negative)).toEqual(["doc:fileSize"]);
    expect(negative.errors[0]).toEqual({
      code: "fileSize",
      componentId: "doc",
      path: "doc",
      stage: "field-constraints",
      source: "wasm",
      parameters: { file: "a.png", size: -1 }
    });
    expect(negative.values).toBeUndefined();
    expect(codesOf(judge(single, { doc: att(0.5) }))).toEqual(["doc:fileSize"]);
    // An empty file is a size a file can have; the limit still reads over the integer.
    expect(codesOf(judge(single, { doc: att(0) }))).toEqual([]);
    expect(codesOf(judge(single, { doc: att(2 * 1048576) }))).toEqual(["doc:maxFileSize"]);
    // In a list, the first offender only, as the limits report theirs.
    expect(codesOf(judge(multi, { doc: [att(1), att(-5), att(2 * 1048576)] }))).toEqual(["doc:fileSize"]);
    // The envelope guard is unchanged: such an entry is still an attachment, so the
    // refusal comes from the check, never from the answer yielding nothing.
    expect(kernelFileAttachments([att(-1), att(0.5)])).toHaveLength(2);
  });

  const INVALID_PATTERNS = ["(", "[", "*", "\\d+\\-\\d+", "(?<n>a)(?<n>b)", "a{2,1}", "\\p{Nope}", ")(a+)+("];
  const patternForm = (pattern: string, rootConfiguration: Record<string, unknown> = {}): ComponentNode => ({
    id: "form",
    type: "form",
    configuration: rootConfiguration,
    children: { content: [{ id: "code", type: "text", configuration: { pattern, patternMessage: "bad shape" } }] }
  });

  it.each(INVALID_PATTERNS)("%s does not compile as an anchored unicode pattern", (pattern) => {
    expect(kernelCompilePattern(pattern)).toBeNull();
  });

  it("logs an uncompilable pattern at warn and skips the check under the warn opt-in, as the browser's stage skips it", () => {
    for (const pattern of INVALID_PATTERNS) {
      // The default is fail: a non-empty answer fails the check closed.
      expect(runKernel({ formId: "f", values: { code: "anything" }, locale: "en", form: patternForm(pattern) }, []).errors.map((error) => error.code), pattern).toEqual(["pattern"]);
      const outcome = runKernel({ formId: "f", values: { code: "anything" }, locale: "en", form: patternForm(pattern), formulaErrors: "warn" }, []);
      expect(outcome.errors, pattern).toEqual([]);
      expect(outcome.values, pattern).toEqual({ code: "anything" });
      expect(outcome.logs, pattern).toEqual([{ level: "warn", message: "pattern does not compile: code", data: { componentId: "code", pattern } }]);
    }
    // Logged where the component is checked, whether or not an answer reaches the pattern.
    expect(runKernel({ formId: "f", values: {}, locale: "en", form: patternForm("("), formulaErrors: "warn" }, []).logs?.map((entry) => entry.message)).toEqual([
      "pattern does not compile: code"
    ]);
  });

  it("under fail, and under a word that is neither, a non-empty answer fails the check closed", () => {
    const form = patternForm("(");
    const unknownWord = runKernel({ formId: "f", values: { code: "x" }, locale: "en", form, formulaErrors: "ignore" as never }, []);
    expect(unknownWord.errors.map((error) => error.code)).toEqual(["pattern"]);

    const failed = runKernel({ formId: "f", values: { code: "x" }, locale: "en", form, formulaErrors: "fail" }, []);
    expect(failed.errors).toEqual([
      {
        code: "pattern",
        componentId: "code",
        path: "code",
        stage: "field-constraints",
        source: "wasm",
        parameters: { pattern: "(", invalid: true, message: "bad shape" }
      }
    ]);
    expect(failed.values).toBeUndefined();
    expect(failed.logs?.map((entry) => `${entry.level}: ${entry.message}`)).toEqual(["warn: pattern does not compile: code"]);
    // An empty answer has nothing to match: the check does not apply, as with a valid pattern.
    expect(runKernel({ formId: "f", values: {}, locale: "en", form, formulaErrors: "fail" }, []).errors).toEqual([]);
    // The form's own policy word is read when the context names none.
    expect(runKernel({ formId: "f", values: { code: "x" }, locale: "en", form: patternForm("(", { formulaErrors: "fail" }) }, []).errors.map((error) => error.code)).toEqual(["pattern"]);
    // A pattern that compiles is untouched by the policy, and logs nothing.
    const valid = patternForm("[a-z]+");
    expect(runKernel({ formId: "f", values: { code: "ok" }, locale: "en", form: valid, formulaErrors: "fail" }, []).errors).toEqual([]);
    const refused = runKernel({ formId: "f", values: { code: "NO" }, locale: "en", form: valid, formulaErrors: "fail" }, []);
    expect(refused.errors.map((error) => error.code)).toEqual(["pattern"]);
    expect(refused.errors[0]?.parameters).toEqual({ pattern: "[a-z]+", message: "bad shape" });
    expect(runKernel({ formId: "f", values: { code: "ok" }, locale: "en", form: valid, logLevel: "debug" }, []).logs?.some((entry) => entry.message.startsWith("pattern does not compile"))).toBe(false);
  });

  // A pattern of a catastrophic shape is a definition problem like an uncompilable one.
  it("treats a risky pattern as a definition problem: logged and skipped, failed closed under fail, run only when allowed", () => {
    const risky = patternForm("(a+)+$");
    const hostile = { code: "a".repeat(40) + "!" };
    const warned = runKernel({ formId: "f", values: hostile, locale: "en", form: risky, formulaErrors: "warn" }, []);
    expect(warned.errors).toEqual([]);
    expect(warned.logs).toEqual([{ level: "warn", message: "pattern is risky: code", data: { componentId: "code", pattern: "(a+)+$" } }]);

    const failed = runKernel({ formId: "f", values: hostile, locale: "en", form: risky, formulaErrors: "fail" }, []);
    expect(failed.errors).toEqual([
      {
        code: "pattern",
        componentId: "code",
        path: "code",
        stage: "field-constraints",
        source: "wasm",
        parameters: { pattern: "(a+)+$", invalid: true, risky: true, message: "bad shape" }
      }
    ]);
    expect(failed.values).toBeUndefined();
    // Allowed, it runs as the author wrote it (a short answer, so the test stays fast).
    const allowed = runKernel({ formId: "f", values: { code: "aaa" }, locale: "en", form: risky, formulaErrors: "fail", riskyPatterns: "allow" }, []);
    expect(allowed.errors).toEqual([]);
    expect((allowed.logs ?? []).some((entry) => entry.message.startsWith("pattern is risky"))).toBe(false);
    expect(runKernel({ formId: "f", values: { code: "bbb" }, locale: "en", form: risky, formulaErrors: "fail", riskyPatterns: "allow" }, []).errors.map((error) => error.code)).toEqual(["pattern"]);
    // Without options the kernel reads as the browser's stage: skipped, nothing logged.
    expect(kernelRunFieldConstraints(risky, hostile, "en")).toEqual([]);
    expect(kernelRunFieldConstraints(risky, { code: "aaa" }, "en", undefined, undefined, { riskyPatterns: "allow" })).toEqual([]);
  });

  it("refuses a literal risky matches pattern at compile (formula.invalid under fail, a dropped rule under warn) unless allowed", () => {
    const formula = 'matches(code, "(a+)+$")';
    const form: ComponentNode = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "code", type: "text", configuration: {} }, { id: "note", type: "text", configuration: {}, rules: { visibleWhen: formula } }] }
    };
    const hostile = { code: "a".repeat(40) + "!" };
    const failed = runKernel({ formId: "f", values: hostile, locale: "en", form }, [], undefined, formulaFunctionSignatures());
    expect(failed.errors).toMatchObject([{ code: "formula.invalid", stage: "definition", parameters: { where: "rules:note:visibleWhen" } }]);
    expect(failed.errors[0]?.parameters?.message).toContain("(a+)+$");
    const warned = runKernel({ formId: "f", values: hostile, locale: "en", form, formulaErrors: "warn" }, [], undefined, formulaFunctionSignatures());
    expect(warned.errors).toEqual([]);
    const allowed = runKernel({ formId: "f", values: { code: "aaa" }, locale: "en", form, riskyPatterns: "allow" }, [], undefined, formulaFunctionSignatures());
    expect(allowed.errors).toEqual([]);
  });

  it("kernelRunFieldConstraints without options reads as the browser's stage: the pattern is skipped and nothing is logged", () => {
    expect(kernelRunFieldConstraints(patternForm("("), { code: "x" }, "en")).toEqual([]);
    expect(kernelRunFieldConstraints(patternForm("("), { code: "x" }, "en", undefined, undefined, { formulaErrors: "fail" }).map((error) => error.code)).toEqual(["pattern"]);
  });
});

describe("portable kernel: the gate gaps", () => {
  const formOfNodes = (...content: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } });
  const judge = (form: ComponentNode, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runKernel({ formId: "f", values, locale: "en", form, ...extra }, [], undefined, formulaFunctionSignatures());
  const codesOf = (outcome: { errors: Array<{ componentId?: string; code: string; path?: string }> }) =>
    outcome.errors.map((error) => `${error.componentId}:${error.code}`);
  /** The browser's stage over the same answers, as `component:code`, to hold the two sides together. */
  const stageCodes = async (form: ComponentNode, values: Record<string, unknown>) => {
    const result = await createFieldConstraintsStage(form).validate({ formId: "f", values, locale: "en" });
    return result.errors.map((error) => `${error.componentId}:${error.code}`);
  };
  const bothSides = async (form: ComponentNode, values: Record<string, unknown>) => {
    const kernel = kernelRunFieldConstraints(form, values, "en").map((error) => `${error.componentId}:${error.code}`);
    expect(await stageCodes(form, values), JSON.stringify(values).slice(0, 80)).toEqual(kernel);
    return kernel;
  };

  describe("a text or textarea answer is a string", () => {
    const form = formOfNodes(
      { id: "code", type: "text", configuration: { maxLength: 3, pattern: "[A-Z]+" } },
      { id: "note", type: "textarea", configuration: { maxLength: 3 } },
      { id: "must", type: "text", configuration: { required: true } }
    );
    it.each([
      ["a number", 1234567],
      ["an object", { x: "abcdefgh" }],
      ["a nested list", [["abcdefgh"]]],
      ["a list of text", ["ABC"]],
      ["a boolean", true],
      ["false", false],
      ["an empty list", []],
      ["an empty object", {}]
    ])("refuses %s as text where the length limits and the pattern would be skipped, and stores nothing", async (_label, answer) => {
      const outcome = judge(form, { code: answer, must: "x" });
      expect(codesOf(outcome)).toEqual(["code:text"]);
      expect(outcome.values).toBeUndefined();
      expect(await bothSides(form, { code: answer, must: "x" })).toEqual(["code:text"]);
      expect(codesOf(judge(form, { note: answer, must: "x" }))).toEqual(["note:text"]);
    });
    it("lets required be satisfied only by a string, never by an object, a zero or a list", async () => {
      for (const answer of [{}, 0, { a: 1 }, [""]]) {
        expect(codesOf(judge(form, { must: answer })), JSON.stringify(answer)).toEqual(["must:text"]);
      }
      expect(codesOf(judge(form, {}))).toEqual(["must:required"]);
      expect(codesOf(judge(form, { must: "   " }))).toEqual(["must:required"]);
    });
    it("leaves null and an absent answer to required, and a string to the limits as before", async () => {
      expect(codesOf(judge(form, { must: "x", code: null, note: null }))).toEqual([]);
      expect(codesOf(judge(form, { must: "x", code: "ABCD" }))).toEqual(["code:maxLength"]);
      expect(codesOf(judge(form, { must: "x", code: "abc" }))).toEqual(["code:pattern"]);
      expect(await bothSides(form, { must: "x", code: "abc", note: "ABCD" })).toEqual(["code:pattern", "note:maxLength"]);
    });
    it("holds a hidden answer that is still submitted to its shape too", () => {
      const hidden = formOfNodes({ id: "t", type: "text", configuration: { hidden: true, hiddenValueBehavior: "retain" } });
      expect(codesOf(judge(hidden, { t: { a: 1 } }))).toEqual(["t:text"]);
    });
    it("does not read a plugin's type, whose answer the schema says nothing of", () => {
      const plugin = formOfNodes({ id: "r", type: "star-rating", configuration: {} });
      expect(codesOf(judge(plugin, { r: 4 }))).toEqual([]);
    });
  });

  describe("a number or a date is held to its declared bounds, inclusive", () => {
    const form = formOfNodes(
      { id: "n", type: "number", configuration: { min: 18, max: 120 } },
      { id: "d", type: "date", configuration: { min: "2024-01-01", max: "2024-12-31" } }
    );
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ n: 17 }, ["n:number.min"]],
      [{ n: 17.999 }, ["n:number.min"]],
      [{ n: 18 }, []],
      [{ n: 120 }, []],
      [{ n: 120.001 }, ["n:number.max"]],
      [{ n: 1000 }, ["n:number.max"]],
      [{ n: -5 }, ["n:number.min"]],
      [{ n: "17" }, ["n:number.min"]],
      [{ n: " 120.5 " }, ["n:number.max"]],
      [{ n: "1e3" }, ["n:number.max"]],
      [{ n: "1e999" }, ["n:number.max"]],
      [{ n: "-1e999" }, ["n:number.min"]],
      [{ n: "abc" }, ["n:number"]],
      [{ d: "2023-12-31" }, ["d:date.min"]],
      [{ d: "2024-01-01" }, []],
      [{ d: "2024-12-31" }, []],
      [{ d: "2025-01-01" }, ["d:date.max"]],
      [{ d: "2024-02-30" }, ["d:date"]],
      [{ n: 5, d: "2030-01-01" }, ["n:number.min", "d:date.max"]]
    ];
    it.each(cases)("%j: %j on both sides", async (values, expected) => {
      expect(await bothSides(form, values)).toEqual(expected);
      expect(codesOf(judge(form, values))).toEqual(expected);
      expect(judge(form, values).values === undefined).toBe(expected.length > 0);
    });
    it("names the bound it broke, and the answer's own path", () => {
      expect(judge(form, { n: 17 }).errors).toEqual([
        { code: "number.min", componentId: "n", path: "n", stage: "field-constraints", source: "wasm", parameters: { min: 18 } }
      ]);
      expect(judge(form, { d: "2025-01-01" }).errors[0]?.parameters).toEqual({ max: "2024-12-31" });
    });
    it("reads a bound as the control does: a plain numeral counts, anything else is no bound, an inverted pair neither", async () => {
      const loose = formOfNodes(
        { id: "a", type: "number", configuration: { min: "10", max: "banana" } },
        { id: "b", type: "number", configuration: { min: 50, max: 10 } },
        { id: "c", type: "date", configuration: { min: "tomorrow", max: 20240101 } },
        { id: "e", type: "text", configuration: { min: 5 } }
      );
      expect(await bothSides(loose, { a: 9, b: 1000, c: "1999-01-01", e: "x" })).toEqual(["a:number.min"]);
      expect(await bothSides(loose, { a: 1e9 })).toEqual([]);
    });
    it("holds a hidden answer still submitted to its kind only, never its bounds, and leaves an empty answer to required", async () => {
      // The browser's hidden policy drops a bound (no `number.max` among its shape codes), so the
      // server does too: a server is never stricter than the browser.
      const hidden = formOfNodes({ id: "n", type: "number", configuration: { hidden: true, hiddenValueBehavior: "retain", max: 5 } });
      expect(codesOf(judge(hidden, { n: 6 }))).toEqual([]);
      expect(codesOf(judge(hidden, { n: "abc" }))).toEqual(["n:number"]);
      const required = formOfNodes({ id: "n", type: "number", configuration: { required: true, min: 1 } });
      expect(await bothSides(required, {})).toEqual(["n:required"]);
      expect(await bothSides(required, { n: "" })).toEqual(["n:required"]);
      expect(await bothSides(required, { n: 0 })).toEqual(["n:number.min"]);
    });
  });

  describe("a file answer is attachments, and no more than the field takes", () => {
    const fileForm = (configuration: Record<string, unknown>) => formOfNodes({ id: "doc", type: "file", configuration: { accept: ".png", maxFileSizeMb: 1, ...configuration } });
    const att = (name: string, size = 1, extra: Record<string, unknown> = {}) => ({ storage: "inline", name, type: "image/png", size, ...extra });
    const images = fileForm({});
    it.each([
      ["no storage", { name: "a.exe", type: "application/x-msdownload", size: 5 * 1048576 }],
      ["empty storage", { storage: "", name: "a.exe", type: "x", size: 1 }],
      ["a size as text", { storage: "inline", name: "a.exe", type: "x", size: "99999999999" }],
      ["no size", { storage: "inline", name: "a.exe", type: "x" }],
      ["no name", { storage: "inline", type: "x", size: 1 }],
      ["no type", { storage: "inline", name: "a.png", size: 1 }],
      ["a bare string", "a.exe"],
      ["a number", 12345],
      ["a boolean", true],
      ["a nested list", [[att("a.png")]]],
      ["a list of strings", ["a.png"]]
    ])("refuses %s as `file`, where the limits were skipped and the junk stored", async (_label, answer) => {
      const outcome = judge(images, { doc: answer });
      expect(codesOf(outcome)).toEqual(["doc:file"]);
      expect(outcome.values).toBeUndefined();
      expect(await bothSides(images, { doc: answer })).toEqual(["doc:file"]);
    });
    it("refuses a list with one junk item among good ones, on a multiple field", async () => {
      const multi = fileForm({ multiple: true });
      const answer = [att("a.png"), { name: "evil.exe", type: "application/x-msdownload", size: 1 }];
      expect(codesOf(judge(multi, { doc: answer }))).toEqual(["doc:file"]);
      expect(await bothSides(multi, { doc: answer })).toEqual(["doc:file"]);
    });
    it("still reads the size and the type of a well-formed attachment first-offender-only, and an empty list as empty", async () => {
      expect(await bothSides(images, { doc: att("a.png", 2 * 1048576) })).toEqual(["doc:maxFileSize"]);
      expect(await bothSides(images, { doc: att("a.exe", 1) })).toEqual(["doc:fileType"]);
      expect(await bothSides(images, { doc: att("a.png", 1) })).toEqual([]);
      expect(await bothSides(images, { doc: [] })).toEqual([]);
      expect(await bothSides(formOfNodes({ id: "doc", type: "file", configuration: { required: true } }), { doc: [] })).toEqual(["doc:required"]);
    });
    it("takes one attachment on a field that is not multiple, even as a list of one", async () => {
      const three = [att("a.png"), att("b.png"), att("c.png")];
      const outcome = judge(images, { doc: three });
      expect(outcome.errors).toEqual([
        { code: "fileCount", componentId: "doc", path: "doc", stage: "field-constraints", source: "wasm", parameters: { count: 3, maxFiles: 1 } }
      ]);
      expect(outcome.values).toBeUndefined();
      expect(await bothSides(images, { doc: three })).toEqual(["doc:fileCount"]);
      expect(await bothSides(images, { doc: [att("a.png")] })).toEqual([]);
    });
    it("takes up to maxFiles on a multiple field, else 100", async () => {
      const capped = fileForm({ multiple: true, maxFiles: 2 });
      expect(await bothSides(capped, { doc: [att("a.png"), att("b.png")] })).toEqual([]);
      const over = judge(capped, { doc: [att("a.png"), att("b.png"), att("c.png")] });
      expect(over.errors[0]?.parameters).toEqual({ count: 3, maxFiles: 2 });
      expect(await bothSides(capped, { doc: [att("a.png"), att("b.png"), att("c.png")] })).toEqual(["doc:fileCount"]);
      const open = fileForm({ multiple: true });
      const many = (count: number) => Array.from({ length: count }, (_, index) => att(`f${index}.png`));
      expect(await bothSides(open, { doc: many(100) })).toEqual([]);
      expect(await bothSides(open, { doc: many(101) })).toEqual(["doc:fileCount"]);
      expect(codesOf(judge(open, { doc: many(5000) }))).toEqual(["doc:fileCount"]);
      // maxFiles is read as a whole number of 1 or more; a single-file field ignores it.
      expect(await bothSides(fileForm({ multiple: true, maxFiles: 0 }), { doc: many(100) })).toEqual([]);
      expect(await bothSides(fileForm({ multiple: true, maxFiles: 2.9 }), { doc: many(3) })).toEqual(["doc:fileCount"]);
      expect(await bothSides(fileForm({ maxFiles: 9 }), { doc: many(2) })).toEqual(["doc:fileCount"]);
    });
    it("counts the shape before the count, and the count before the limits", async () => {
      const multi = fileForm({ multiple: true, maxFiles: 1 });
      expect(await bothSides(multi, { doc: [att("a.exe"), "junk"] })).toEqual(["doc:file"]);
      expect(await bothSides(multi, { doc: [att("a.exe", 2 * 1048576), att("b.png")] })).toEqual(["doc:fileCount"]);
    });
  });

  describe("a hidden answer still submitted is held to its format, never to more than the browser holds it to", () => {
    // Hiding relaxes required, not the format of an answer that is still submitted
    // (its kind, length, pattern, file size and type, as the browser's hidden policy and
    // `kernelErrorPassesFold` keep them). A bound, a file count and the field's `rule` are not
    // format: the browser drops them for a hidden component, and a server is never stricter.
    const retained = (node: ComponentNode): ComponentNode =>
      formOfNodes({ ...node, configuration: { ...(node.configuration as Record<string, unknown>), hidden: true, hiddenValueBehavior: "retain" } });
    const att = (name: string, size = 1) => ({ storage: "inline", name, type: "image/png", size });
    const number = retained({ id: "n", type: "number", configuration: { min: 18, max: 100 } });
    const capped = retained({ id: "b", type: "number", configuration: { max: 10 } });
    const date = retained({ id: "d", type: "date", configuration: { min: "2024-01-01", max: "2024-12-31" } });
    const text = retained({ id: "t", type: "text", configuration: { minLength: 2, maxLength: 3, pattern: "[A-Z]+" } });
    const file = retained({ id: "doc", type: "file", configuration: { accept: ".png", maxFileSizeMb: 1 } });

    it("accepts a hidden retained number above its maximum, and submits it", () => {
      const outcome = judge(capped, { b: 50 });
      expect(outcome.errors).toEqual([]);
      expect(outcome.values).toEqual({ b: 50 });
    });
    it("still refuses a hidden retained number that is not one, with `number`", () => {
      const outcome = judge(capped, { b: "abc" });
      expect(codesOf(outcome)).toEqual(["b:number"]);
      expect(outcome.values).toBeUndefined();
    });
    const cases: Array<[string, ComponentNode, Record<string, unknown>, string[]]> = [
      ["a number below its minimum", number, { n: 5 }, []],
      ["a numeral above its maximum", number, { n: "1e3" }, []],
      ["a date before its minimum", date, { d: "2023-12-31" }, []],
      ["a date after its maximum", date, { d: "2025-01-01" }, []],
      ["a day the month lacks", date, { d: "2024-02-30" }, ["d:date"]],
      ["a number sent for text", text, { t: 42 }, ["t:text"]],
      ["text too short", text, { t: "A" }, ["t:minLength"]],
      ["text too long", text, { t: "ABCD" }, ["t:maxLength"]],
      ["text off its pattern", text, { t: "ab" }, ["t:pattern"]],
      ["junk for a file", file, { doc: "a.exe" }, ["doc:file"]],
      ["too many files", file, { doc: [att("a.png"), att("b.png")] }, []],
      ["too many files, one too large", file, { doc: [att("a.png"), att("b.png", 2 * 1048576)] }, ["doc:maxFileSize"]],
      ["a file of the wrong type", file, { doc: att("a.exe") }, ["doc:fileType"]]
    ];
    it.each(cases)("%s", (_label, form, values, expected) => {
      const outcome = judge(form, values);
      expect(codesOf(outcome)).toEqual(expected);
      expect(outcome.values === undefined).toBe(expected.length > 0);
      // Every code it raises is one the browser's hidden policy keeps, or a kind code.
      const kept = ["minLength", "maxLength", "pattern", "maxFileSize", "fileType", "number", "date", "text", "file", "fileSize", "file.sizeMismatch"];
      for (const error of outcome.errors) {
        expect(kept).toContain(error.code);
      }
    });
    it("kernelErrorPassesFold keeps exactly the format codes of a hidden, retained answer", () => {
      const state = (patch: Record<string, unknown>) => ({
        c: { visible: false, disabled: false, readonly: false, runValidation: false, requiredApplies: false, submitValue: true, clearValue: false, ...patch }
      });
      const passes = (code: string, patch: Record<string, unknown> = {}, stage = "field-constraints") =>
        kernelErrorPassesFold({ code, componentId: "c", stage, source: "wasm" } as never, state(patch) as never);
      // The browser's `ANSWER_SHAPE_CODES`: the same list, so the two sides refuse alike.
      for (const code of ["minLength", "maxLength", "pattern", "maxFileSize", "fileType", "number", "date", "text", "file", "fileSize", "file.sizeMismatch"]) {
        expect(passes(code), code).toBe(true);
        // Not when the answer is not submitted, or was cleared, or the check is not a field constraint.
        expect(passes(code, { submitValue: false }), `${code} unsubmitted`).toBe(false);
        expect(passes(code, { clearValue: true }), `${code} cleared`).toBe(false);
        expect(passes(code, {}, "plugin"), `${code} plugin`).toBe(false);
      }
      for (const code of ["required", "number.min", "number.max", "date.min", "date.max", "fileCount", "rule", "rows.max"]) {
        expect(passes(code), code).toBe(false);
      }
    });
    it("holds the same answers shown to every check, as before", () => {
      const shown = (form: ComponentNode): ComponentNode => {
        const node = form.children!.content![0]!;
        return formOfNodes({ ...node, configuration: { ...(node.configuration as Record<string, unknown>), hidden: false } });
      };
      expect(codesOf(judge(shown(capped), { b: 50 }))).toEqual(["b:number.max"]);
      expect(codesOf(judge(shown(date), { d: "2025-01-01" }))).toEqual(["d:date.max"]);
      expect(codesOf(judge(shown(file), { doc: [att("a.png"), att("b.png")] }))).toEqual(["doc:fileCount"]);
    });
    it("checks nothing of a hidden answer that is not submitted", () => {
      const excluded = formOfNodes({ id: "b", type: "number", configuration: { hidden: true, hiddenValueBehavior: "exclude-from-submission", max: 10 } });
      expect(codesOf(judge(excluded, { b: "abc" }))).toEqual([]);
    });
  });

  describe("the fields of a repeating section are held entry by entry", () => {
    const section = (children: ComponentNode[], extra: Partial<ComponentNode> = {}): ComponentNode =>
      formOfNodes({ id: "rows", type: "repeatingSection", configuration: {}, collection: { itemFields: ["name"] }, children: { content: children }, ...extra });
    const named = section([{ id: "name", type: "text", configuration: { required: true, maxLength: 5 } }]);

    it("accepts every entry named within the limit, as the required tick used to refuse every submission", async () => {
      const values = { "rows[0].name": "ab", "rows[1].name": "cd" };
      expect(judge(named, values).errors).toEqual([]);
      expect(judge(named, values).values).toEqual(values);
      expect(await bothSides(named, values)).toEqual([]);
    });
    it("refuses an entry over the limit at its own key, and only that entry", async () => {
      const values = { "rows[0].name": "ab", "rows[1].name": "waytoolong", "rows[2].name": "ok" };
      const outcome = judge(named, values);
      expect(outcome.errors).toEqual([
        {
          code: "maxLength",
          componentId: "name",
          path: "rows[1].name",
          stage: "field-constraints",
          source: "wasm",
          parameters: { maxLength: 5, length: 10 }
        }
      ]);
      expect(outcome.values).toBeUndefined();
      expect(await bothSides(named, values)).toEqual(["name:maxLength"]);
    });
    it("reports required for the entries missing the field, each at its key, and nothing for a section with no entry", async () => {
      const two = section([
        { id: "name", type: "text", configuration: { required: true } },
        { id: "qty", type: "number", configuration: {} }
      ]);
      const values = { "rows[0].name": "a", "rows[1].qty": 3, "rows[2].name": "  ", "rows[2].qty": 1 };
      expect(judge(two, values).errors.map((error) => `${error.code}@${error.path}`)).toEqual(["required@rows[1].name", "required@rows[2].name"]);
      expect(await bothSides(two, values)).toEqual(["name:required", "name:required"]);
      expect(judge(two, {}).errors).toEqual([]);
      expect(await bothSides(two, {})).toEqual([]);
      // Entries are the indexes some key names: rows may skip, and hold their order.
      expect(judge(two, { "rows[5].qty": 1, "rows[2].qty": 1 }).errors.map((error) => error.path)).toEqual(["rows[2].name", "rows[5].name"]);
    });
    it("checks each kind at the entry: numbers, dates, files, text", async () => {
      const kinds = section([
        { id: "qty", type: "number", configuration: { max: 10 } },
        { id: "on", type: "date", configuration: {} },
        { id: "memo", type: "text", configuration: {} },
        { id: "doc", type: "file", configuration: { maxFileSizeMb: 1 } }
      ]);
      const values = {
        "rows[0].qty": "abc",
        "rows[1].qty": 11,
        "rows[1].on": "2024-13-01",
        "rows[2].memo": { x: 1 },
        "rows[2].doc": "junk"
      };
      expect(judge(kinds, values).errors.map((error) => `${error.code}@${error.path}`)).toEqual([
        "number@rows[0].qty",
        "number.max@rows[1].qty",
        "date@rows[1].on",
        "text@rows[2].memo",
        "file@rows[2].doc"
      ]);
      expect(await bothSides(kinds, values)).toEqual(["qty:number", "qty:number.max", "on:date", "memo:text", "doc:file"]);
    });
    it("reads a field under a data-scoping container in the entry, and by its data key", async () => {
      const scoped = section([
        { id: "addr", type: "container", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: { maxLength: 2, dataKey: "town" } }] } }
      ]);
      expect(judge(scoped, { "rows[0].addr.town": "Ottawa" }).errors.map((error) => error.path)).toEqual(["rows[0].addr.town"]);
      expect(await bothSides(scoped, { "rows[0].addr.town": "Ottawa" })).toEqual(["city:maxLength"]);
      // The id is not the key: this is an unknown key, stripped, and nothing is left to judge.
      expect(judge(scoped, { "rows[0].addr.city": "Ottawa" }).errors).toEqual([]);
    });
    it("keeps a nested section at its own collection path", () => {
      const nested = section([
        {
          id: "inner",
          type: "repeatingSection",
          configuration: {},
          collection: { itemFields: ["leaf"], collectionPath: "inner" },
          children: { content: [{ id: "leaf", type: "text", configuration: { maxLength: 1 } }] }
        }
      ]);
      expect(judge(nested, { "inner[0].leaf": "ab", "inner[1].leaf": "c" }).errors.map((error) => error.path)).toEqual(["inner[0].leaf"]);
    });
    it("reads rows posted whole as the entries they stand for", () => {
      const outcome = judge(named, { rows: [{ name: "ab" }, { name: "waytoolong" }] });
      expect(outcome.errors.map((error) => error.path)).toEqual(["rows[1].name"]);
    });
    it("leaves the bare key alone: it is not the entry's, and the browser's stage no longer reads it", async () => {
      expect(judge(named, { name: "x".repeat(50) }).errors).toEqual([]);
      expect(await stageCodes(named, { name: "x".repeat(50) })).toEqual([]);
    });
    it("shares the field's state across entries, as the fold does not fold entry by entry", () => {
      const hiddenRows = section([{ id: "name", type: "text", configuration: { required: true, hidden: true } }]);
      expect(judge(hiddenRows, { "rows[0].qty": 1 }).errors).toEqual([]);
    });
  });

  describe("a calculation on a field of a repeating section is worked out per entry", () => {
    const rowsForm = formOfNodes(
      {
        id: "rows",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["qty", "price", "total"] },
        children: {
          content: [
            { id: "qty", type: "number", configuration: {} },
            { id: "price", type: "number", configuration: {} },
            { id: "total", type: "number", configuration: {}, rules: { value: "row.qty * row.price" } }
          ]
        }
      },
      { id: "rate", type: "number", configuration: {} }
    );
    it("replaces a forged entry result and says so", () => {
      const outcome = judge(rowsForm, { "rows[0].qty": 2, "rows[0].price": 3, "rows[0].total": 999 }, { logLevel: "info" });
      expect(outcome.errors).toEqual([]);
      expect(outcome.values).toEqual({ "rows[0].qty": 2, "rows[0].price": 3, "rows[0].total": 6 });
      expect(outcome.logs?.find((entry) => entry.message === "calculations recomputed")?.data).toEqual({ fields: ["rows[0].total"] });
      expect(outcome.clientDerived).toBeUndefined();
    });
    it("fills an entry's missing result, entry by entry", () => {
      const outcome = judge(rowsForm, { "rows[0].qty": 2, "rows[0].price": 3, "rows[1].qty": 4, "rows[1].price": 5, "rows[1].total": 1 });
      expect(outcome.values).toMatchObject({ "rows[0].total": 6, "rows[1].total": 20 });
    });
    it("takes an entry on trust that lacks an input, lists it by its key, and holds it to the field's checks", () => {
      const outcome = judge(rowsForm, { "rows[0].qty": 2, "rows[0].price": 3, "rows[1].qty": 4, "rows[1].total": 7 });
      expect(outcome.values).toMatchObject({ "rows[0].total": 6, "rows[1].total": 7 });
      expect(outcome.clientDerived).toEqual(["rows[1].total"]);
      expect(codesOf(judge(rowsForm, { "rows[0].qty": 2, "rows[0].total": "abc" }))).toEqual(["total:number"]);
    });
    it("reads rowIndex() and rowCount() as the entry's 1-based place among the entries sent", () => {
      const counted = formOfNodes({
        id: "rows",
        type: "repeatingSection",
        configuration: {},
        collection: { itemFields: ["qty", "place"] },
        children: {
          content: [
            { id: "qty", type: "number", configuration: {} },
            { id: "place", type: "text", configuration: {}, rules: { value: 'concat(rowIndex(), " of ", rowCount())' } }
          ]
        }
      });
      const outcome = judge(counted, { "rows[0].qty": 1, "rows[3].qty": 1 });
      expect(outcome.values).toMatchObject({ "rows[0].place": "1 of 2", "rows[3].place": "2 of 2" });
    });
    it("reads the form's own answers from inside an entry", () => {
      const scaled = formOfNodes(
        { id: "rate", type: "number", configuration: {} },
        {
          id: "rows",
          type: "repeatingSection",
          configuration: {},
          collection: { itemFields: ["qty", "scaled"] },
          children: {
            content: [
              { id: "qty", type: "number", configuration: {} },
              { id: "scaled", type: "number", configuration: {}, rules: { value: "row.qty * rate" } }
            ]
          }
        }
      );
      expect(judge(scaled, { rate: 3, "rows[0].qty": 2, "rows[0].scaled": 1 }).values).toEqual({ rate: 3, "rows[0].qty": 2, "rows[0].scaled": 6 });
    });
    it("leaves an aggregate over the whole section as sent, as before", () => {
      const summed = formOfNodes(rowsForm.children!.content![0]!, { id: "sum", type: "number", configuration: {}, rules: { value: "sum(rows.total)" } });
      const outcome = judge(summed, { "rows[0].qty": 2, "rows[0].price": 3, sum: 99 });
      expect(outcome.values).toMatchObject({ "rows[0].total": 6, sum: 99 });
      expect(outcome.clientDerived).toEqual(["sum"]);
    });
    it("lists the entry paths a recompute changed, in document order, through kernelRecomputeCalculations", () => {
      // The trees a compiled definition holds: this entry point reads no formula string.
      const product: Expression = { kind: "arithmetic", operator: "multiply", left: { kind: "path", path: "row.qty" }, right: { kind: "path", path: "row.price" } };
      const compiled = JSON.parse(JSON.stringify(rowsForm)) as ComponentNode;
      compiled.children!.content![0]!.children!.content![2]!.rules = { value: product };
      const index = kernelTreeIndex(compiled);
      const result = kernelRecomputeCalculations(
        compiled,
        kernelJsonAnswers({ "rows[0].qty": 2, "rows[0].price": 3, "rows[0].total": 1, "rows[1].qty": 1, "rows[1].price": 1 }),
        index,
        kernelValuePaths(compiled),
        kernelComponentIdsByPath(compiled)
      );
      expect(result.recalculated).toEqual(["rows[0].total", "rows[1].total"]);
      expect(result.unreproduced).toEqual([]);
      expect(result.converged).toBe(true);
    });
  });

  describe("choice answers to a source the snapshot lacks fail closed", () => {
    const cities = formOfNodes({ id: "city", type: "select", configuration: { data: { sourceId: "cities" } } });
    it.each([
      ["no snapshot", undefined],
      ["an empty snapshot", {}],
      ["a snapshot lacking the source", { other: [{ value: "x" }] }],
      ["a snapshot that is a list", [] as unknown],
      ["a snapshot that is text", "cities" as unknown],
      ["a snapshot that is null", null as unknown],
      ["an entry that is null", { cities: null }],
      ["an entry that is an object", { cities: {} }],
      ["an entry that is text", { cities: "ott" }]
    ])("refuses a forged answer with %s, naming the source, and says so in the log", (_label, optionSnapshot) => {
      const outcome = judge(cities, { city: "Atlantis" }, { optionSnapshot });
      expect(outcome.errors).toEqual([
        { code: "option.sourceUnavailable", componentId: "city", path: "city", stage: "options", source: "wasm", parameters: { keys: ["city"], sourceId: "cities" } }
      ]);
      expect(outcome.values).toBeUndefined();
      expect(outcome.logs?.some((entry) => entry.level === "warn" && entry.message.startsWith("choice answers refused"))).toBe(true);
    });
    it("holds an empty source's list to nothing allowed, and a real snapshot as before", () => {
      expect(codesOf(judge(cities, { city: "ott" }, { optionSnapshot: { cities: [] } }))).toEqual(["city:option.notAllowed"]);
      expect(codesOf(judge(cities, { city: "ott" }, { optionSnapshot: { cities: [{ value: "ott" }] } }))).toEqual([]);
      expect(codesOf(judge(cities, { city: "bad" }, { optionSnapshot: { cities: [{ value: "ott" }] } }))).toEqual(["city:option.notAllowed"]);
    });
    it("needs no snapshot for an unanswered question, for an answer that picks nothing, or for inline options", () => {
      expect(judge(cities, {}).errors).toEqual([]);
      expect(judge(cities, { city: "" }).errors).toEqual([]);
      const inline = formOfNodes({ id: "size", type: "select", configuration: { options: [{ value: "s", label: "S" }] } });
      expect(codesOf(judge(inline, { size: "s" }))).toEqual([]);
    });
  });
});

describe("portable kernel: fail closed on the gate", () => {
  const formOfNodes = (...content: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content } });
  const text = (id: string, configuration: Record<string, unknown> = {}, rules?: Record<string, unknown>): ComponentNode => ({
    id,
    type: "text",
    configuration,
    ...(rules !== undefined ? { rules: rules as never } : {})
  });
  const signatures = [...formulaFunctionSignatures(), { name: "boom", min: 0, max: Number.POSITIVE_INFINITY }, { name: "regionOk", min: 1, max: 1 }];
  const boom = (): unknown => {
    throw new Error("boom");
  };
  const run = (form: ComponentNode, values: Record<string, unknown>, extra: Record<string, unknown> = {}, validators: KernelValidator[] = [], functions: Record<string, (args: unknown[]) => unknown> = { boom }) =>
    runKernel({ formId: "f", values, locale: "en", form, ...extra }, validators, functions, signatures);
  const codesOf = (outcome: { errors: Array<{ componentId?: string; code: string }> }) => outcome.errors.map((error) => `${error.componentId ?? ""}:${error.code}`);

  describe("a rule that throws at evaluation refuses under formulaErrors fail", () => {
    const rulesOf = (role: "visibleWhen" | "requiredWhen" | "value") =>
      formOfNodes(
        text("a"),
        role === "value"
          ? { id: "b", type: "number", configuration: {}, rules: { value: "boom()" } }
          : text("b", role === "visibleWhen" ? { required: true } : {}, { [role]: "boom()" })
      );

    it.each(["visibleWhen", "requiredWhen", "value"] as const)("refuses a throwing %s, naming the rule and the function, and stores nothing", (role) => {
      const sent = role === "value" ? { a: "x", b: 999 } : { a: "x", b: "" };
      const outcome = run(rulesOf(role), sent, { formulaErrors: "fail" });
      expect(outcome.errors).toEqual([
        {
          code: "formula.invalid",
          stage: "definition",
          source: "wasm",
          parameters: { where: `rules:b:${role}`, message: 'function "boom" threw: boom', function: "boom" }
        }
      ]);
      expect(outcome.values).toBeUndefined();
    });

    it("judges by the form's own word when the host says nothing, and the host's word wins", () => {
      const form = rulesOf("requiredWhen");
      (form.configuration as Record<string, unknown>).formulaErrors = "fail";
      expect(codesOf(run(form, { a: "x", b: "" }))).toEqual([":formula.invalid"]);
      expect(codesOf(run(form, { a: "x", b: "" }, { formulaErrors: "warn" }))).toEqual([]);
    });

    it("runs no validator for a refused run, and names every rule that threw once", () => {
      let called = 0;
      const outcome = run(
        formOfNodes(text("a"), text("b", {}, { visibleWhen: "boom()", requiredWhen: "boom()" })),
        { a: "x" },
        { formulaErrors: "fail" },
        [() => (called += 1, { errors: [] })]
      );
      expect(called).toBe(0);
      expect(outcome.errors.map((error) => (error.parameters as { where: string }).where)).toEqual(["rules:b:visibleWhen", "rules:b:requiredWhen"]);
    });

    it("refuses by default (fail), and says so under the warn opt-in without changing the verdict", () => {
      const form = rulesOf("visibleWhen");
      expect(codesOf(run(form, { a: "x", b: "" }))).toEqual([":formula.invalid"]);
      const warned = run(form, { a: "x", b: "" }, { logLevel: "warn", formulaErrors: "warn" });
      expect(warned.errors).toEqual([]);
      expect(warned.logs?.map((entry) => [entry.level, entry.message])).toEqual([["warn", 'formula function threw: rules:b:visibleWhen: function "boom" threw: boom']]);
    });

    it("refuses nothing for a function that does not throw", () => {
      const outcome = run(rulesOf("visibleWhen"), { a: "x", b: "y" }, { formulaErrors: "fail" }, [], { boom: () => true });
      expect(outcome.errors).toEqual([]);
    });
  });

  describe("a plugin validator that cannot answer is no pass", () => {
    const form = formOfNodes(text("a"));
    it.each([
      ["undefined", () => undefined, "returned undefined"],
      ["null", () => null, "returned null"],
      ["a number", () => 7, "returned number"],
      ["a string", () => "ok", "returned string"],
      ["an object with no errors", () => ({}), "returned no { errors } list"],
      ["errors that is not a list", () => ({ errors: "bad" }), "returned no { errors } list"],
      ["a promise", async () => ({ errors: [] }), "returned a promise"],
      ["a thenable", () => ({ then: () => undefined, errors: [] }), "returned a promise"],
      ["a null entry", () => ({ errors: [null] }), "without a string code (entry 0)"],
      ["a code-less entry", () => ({ errors: [{ severity: "error" }] }), "without a string code (entry 0)"],
      ["a code that is not text", () => ({ errors: [{ code: 4 }] }), "without a string code (entry 0)"]
    ])("fails the run for a validator returning %s", (_label, validate, message) => {
      expect(() => run(form, { a: "x" }, {}, [validate as never])).toThrow(message);
    });

    it("names the validator by position, and still lets a usable answer through (warnings and none)", () => {
      expect(() => run(form, { a: "x" }, {}, [() => ({ errors: [] }), (() => undefined) as never])).toThrow("validator 2 returned undefined");
      const quiet = run(form, { a: "x" }, {}, [() => ({ errors: [] }), () => ({ errors: [{ code: "note", stage: "validation", source: "wasm", severity: "warning" }] })]);
      expect(quiet.values).toEqual({ a: "x" });
      expect(codesOf(quiet)).toEqual([":note"]);
    });

    it("keeps a validator that throws a blocking validator.failed, as before", () => {
      const outcome = run(form, { a: "x" }, {}, [
        () => {
          throw new Error("no");
        }
      ]);
      expect(codesOf(outcome)).toEqual([":validator.failed"]);
    });
  });

  describe("what a validator sees and what survives of its errors", () => {
    const hiding = formOfNodes(text("a"), text("b"), text("gone", { hiddenValueBehavior: "exclude-from-submission" }, { visibleWhen: 'a = "show"' }));
    it("keeps an error on another field, drops one on a hidden field, and runs a second validator after the first throws", () => {
      const outcome = run(hiding, { a: "x" }, {}, [
        () => {
          throw new Error("no");
        },
        () => ({ errors: [{ code: "other", stage: "validation", source: "wasm", componentId: "b" }, { code: "hidden", stage: "validation", source: "wasm", componentId: "gone" }] })
      ]);
      const codes = outcome.errors.map((error) => error.code);
      expect(codes).toContain("validator.failed");
      expect(codes).toContain("other");
      expect(codes).not.toContain("hidden");
    });

    it("never hands a validator the delivered document", () => {
      let seen: unknown = "unset";
      run(hiding, { a: "x" }, { document: { secret: 1 } }, [
        (context) => {
          seen = (context as { document?: unknown }).document;
          return { errors: [] };
        }
      ]);
      expect(seen).toBeUndefined();
    });
  });

  describe("a severity outside the documented set blocks like an error", () => {
    it.each(["Error", "fatal", "critical", "", 1, null, true])("treats severity %j as an error", (severity) => {
      const outcome = run(formOfNodes(text("a")), { a: "x" }, {}, [() => ({ errors: [{ code: "x.bad", stage: "validation", source: "wasm", severity } as never] })]);
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]?.severity).toBe("error");
      expect(outcome.values).toBeUndefined();
    });

    it("leaves error, warning, info and none as they are", () => {
      const outcome = run(formOfNodes(text("a")), { a: "x" }, {}, [
        () => ({
          errors: [
            { code: "w", stage: "validation", source: "wasm", severity: "warning" },
            { code: "i", stage: "validation", source: "wasm", severity: "info" }
          ]
        })
      ]);
      expect(outcome.errors.map((error) => error.severity)).toEqual(["warning", "info"]);
      expect(outcome.values).toEqual({ a: "x" });
      const none = run(formOfNodes(text("a")), { a: "x" }, {}, [() => ({ errors: [{ code: "n", stage: "validation", source: "wasm" }] })]);
      expect(none.errors[0]?.severity).toBeUndefined();
      expect(none.values).toBeUndefined();
    });
  });

  describe("a validator is handed a deep-frozen copy of the values", () => {
    const form = formOfNodes(text("a"), { id: "tags", type: "checkboxes", configuration: { options: [{ value: "x", label: "X" }] } } as ComponentNode);
    it("ignores a write from sloppy code and fails closed on one from strict code, storing what the fold kept either way", () => {
      const sloppy = new Function("context", "context.values.a = 'HACKED'; context.values.injected = 1; delete context.values.tags; return { errors: [] };") as KernelValidator;
      const quiet = run(form, { a: "x", tags: { x: true } }, {}, [sloppy]);
      expect(quiet.errors).toEqual([]);
      expect(quiet.values).toEqual({ a: "x", tags: { x: true } });
      const strict = run(form, { a: "x", tags: { x: true } }, {}, [
        (context) => {
          (context.values as Record<string, unknown>).a = "HACKED";
          return { errors: [] };
        }
      ]);
      expect(codesOf(strict)).toEqual([":validator.failed"]);
      expect(strict.values).toBeUndefined();
    });

    it("hands every validator the same frozen shape, nested lists included, own __proto__ key kept", () => {
      const seen: unknown[] = [];
      run(form, { a: "x", tags: { x: true } }, {}, [
        (context) => {
          seen.push(Object.isFrozen(context.values), Object.isFrozen((context.values as { tags: object }).tags), JSON.stringify(context.values));
          return { errors: [] };
        }
      ]);
      expect(seen).toEqual([true, true, '{"a":"x","tags":{"x":true}}']);
      const copy = kernelFrozenCopy(JSON.parse('{"__proto__":{"x":1},"n":[{"k":[1,2]}]}')) as Record<string, unknown>;
      expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
      expect(Object.keys(copy)).toEqual(["__proto__", "n"]);
      expect(Object.isFrozen(((copy.n as unknown[])[0] as { k: unknown[] }).k)).toBe(true);
      expect(kernelFrozenCopy("text")).toBe("text");
      expect(kernelFrozenCopy(null)).toBeNull();
    });
  });

  describe("a rule the server runs that calls a function it lacks refuses under every policy word", () => {
    const bare = (key: string, source: unknown) => formOfNodes(text("a"), key === "value" ? ({ id: "b", type: "text", configuration: {}, rules: { value: source } } as ComponentNode) : text("b", {}, { [key]: source }));
    const lacking = (form: ComponentNode, extra: Record<string, unknown> = {}, values: Record<string, unknown> = { a: "bc" }) =>
      runKernel({ formId: "f", values, locale: "en", form, ...extra }, [], undefined, formulaFunctionSignatures());

    it.each([
      ["visibleWhen", "regionOk(a)"],
      ["requiredWhen", "regionOk(a)"],
      ["enabledWhen", "regionOk(a)"],
      ["readonlyWhen", "regionOk(a)"],
      ["value", "regionOk(a)"],
      ["requiredWhen", { formula: "regionOk(a)", run: "server" }],
      ["requiredWhen", { formula: "regionOk(a)", run: "both" }]
    ])("refuses %s %j under the default policy, naming the rule and the function", (key, source) => {
      const outcome = lacking(bare(key, source));
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]).toMatchObject({ code: "formula.invalid", stage: "definition", parameters: { where: `rules:b:${key}`, function: "regionOk" } });
      expect(outcome.values).toBeUndefined();
    });

    it("refuses a server-secret rule naming the rule and nothing of its text", () => {
      const outcome = lacking(bare("requiredWhen", { formula: "regionOk(a)", run: "server-secret" }), { logLevel: "debug" });
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]).toMatchObject({ code: "formula.invalid", stage: "definition", parameters: { where: "rules:b:requiredWhen", message: "The details of this problem are withheld." } });
      expect(JSON.stringify(outcome)).not.toContain("regionOk");
      expect(outcome.values).toBeUndefined();
    });

    it("keeps the policy for a browser-only rule: warn drops it with a log line, fail still refuses", () => {
      const form = bare("requiredWhen", { formula: "regionOk(a)", run: "browser" });
      // The default is fail; warn is the explicit opt-in.
      expect(codesOf(lacking(form))).toEqual([":formula.invalid"]);
      const warned = lacking(form, { logLevel: "warn", formulaErrors: "warn" });
      expect(warned.errors).toEqual([]);
      expect(warned.logs?.some((entry) => entry.level === "warn" && entry.message.startsWith("formula invalid: rules:b:requiredWhen"))).toBe(true);
      expect(codesOf(lacking(form, { formulaErrors: "fail" }))).toEqual([":formula.invalid"]);
      const defaultValue = bare("defaultValue", "regionOk(a)");
      expect(lacking(defaultValue, { formulaErrors: "warn" }).errors).toEqual([]);
    });

    it("refuses under warn too, and leaves a parse failure to the policy", () => {
      expect(codesOf(lacking(bare("requiredWhen", "regionOk(a)"), { formulaErrors: "warn" }))).toEqual([":formula.invalid"]);
      expect(lacking(bare("requiredWhen", 'a = "'), { logLevel: "warn", formulaErrors: "warn" }).errors).toEqual([]);
      expect(codesOf(lacking(bare("requiredWhen", 'a = "')))).toEqual([":formula.invalid"]);
    });

    it("enforces the rule once the function is wired", () => {
      const form = bare("requiredWhen", "regionOk(a)");
      const wired = runKernel({ formId: "f", values: { a: "bc" }, locale: "en", form }, [], { regionOk: (args: unknown[]) => args[0] === "bc" }, signatures);
      expect(codesOf(wired)).toEqual(["b:required"]);
    });
  });

  describe("a visibility the server cannot replay is hidden for requiredness", () => {
    const required = (rules: Record<string, unknown>, configuration: Record<string, unknown> = {}) =>
      formOfNodes(text("a"), text("b", { required: true, ...configuration }, rules));

    it("does not ask for a required field a host. visibility may have hidden, keeps its answer, and lists the skip", () => {
      const form = required({ visibleWhen: 'host.role = "admin"' });
      const empty = run(form, { a: "x" });
      expect(empty.errors).toEqual([]);
      expect(empty.values).toEqual({ a: "x" });
      expect(empty.visibilitySkipped).toEqual(["b"]);
      expect(run(form, { a: "x", b: "typed" }).values).toEqual({ a: "x", b: "typed" });
    });

    it("does the same for a clock visibility with no day, and replays it once the day is given", () => {
      const form = required({ visibleWhen: "year(today()) < 2000" });
      const noDay = run(form, { a: "x" });
      expect(noDay.errors).toEqual([]);
      expect(noDay.visibilitySkipped).toEqual(["b"]);
      const withDay = run(form, { a: "x" }, { today: "2026-10-08" });
      expect(withDay.errors).toEqual([]);
      expect(withDay.visibilitySkipped).toBeUndefined();
      expect(codesOf(run(required({ visibleWhen: "year(today()) > 2000" }), { a: "x" }, { today: "2026-10-08" }))).toEqual(["b:required"]);
    });

    it("does the same for a visibility the author scoped to the browser", () => {
      const outcome = run(required({ visibleWhen: { formula: 'a = "show"', run: "browser" } }), {});
      expect(outcome.errors).toEqual([]);
      expect(outcome.visibilitySkipped).toEqual(["b"]);
    });

    it("sets aside a requiredWhen too, and lists a group once for everything under it", () => {
      const grouped = formOfNodes(text("a"), {
        id: "box",
        type: "fieldset",
        configuration: {},
        rules: { visibleWhen: 'host.role = "staff"' },
        children: { content: [text("inner", { required: true }), text("other", {}, { requiredWhen: 'a = "x"' })] }
      } as ComponentNode);
      const outcome = run(grouped, { a: "x" });
      expect(outcome.errors).toEqual([]);
      expect(outcome.visibilitySkipped).toEqual(["box"]);
      expect(codesOf(run(grouped, { a: "x" }, { today: "2026-10-08" }))).toEqual([]);
    });

    it("keeps a field that says hidden fields stay required, and every other check", () => {
      expect(codesOf(run(required({ visibleWhen: 'host.role = "admin"' }, { hiddenRequiredBehavior: "required" }), { a: "x" }))).toEqual(["b:required"]);
      expect(codesOf(run(required({ visibleWhen: 'host.role = "admin"' }, { maxLength: 2 }), { a: "x", b: "toolong" }))).toEqual(["b:maxLength"]);
    });

    it("still keeps a forged answer for a field hidden to some viewers (hidden-value policy untouched), and still skips a host. requiredWhen", () => {
      const hidesForAdmins = formOfNodes(text("a"), text("b", { hiddenValueBehavior: "exclude-from-submission" }, { visibleWhen: 'host.role != "admin"' }));
      expect(run(hidesForAdmins, { a: "x", b: "secret" }).values).toEqual({ a: "x", b: "secret" });
      const staffOnly = formOfNodes(text("a"), text("b", {}, { requiredWhen: 'host.role = "staff"' }));
      const outcome = run(staffOnly, { a: "x" });
      expect(outcome.errors).toEqual([]);
      expect(outcome.visibilitySkipped).toBeUndefined();
    });

    it("leaves a visibility it can replay alone", () => {
      const form = required({ visibleWhen: 'a = "show"' });
      expect(codesOf(run(form, { a: "show" }))).toEqual(["b:required"]);
      expect(run(form, { a: "x" }).errors).toEqual([]);
      expect(run(form, { a: "show", b: "y" }).visibilitySkipped).toBeUndefined();
    });
  });

  describe("an optional input's absence is the person's, a withheld one's is not", () => {
    const calc = (input: ComponentNode, ...more: ComponentNode[]) =>
      formOfNodes(
        { id: "a", type: "number", configuration: {} },
        input,
        { id: "total", type: "number", configuration: {}, rules: { value: "a * b" } } as ComponentNode,
        ...more
      );
    const plainB: ComponentNode = { id: "b", type: "number", configuration: {} };

    it("replaces a forged calculation when an optional, never-hidden input is omitted, and what reads it", () => {
      const form = calc(plainB, { id: "fee", type: "number", configuration: {}, rules: { value: "total * 100" } } as ComponentNode);
      const outcome = run(form, { a: 10, total: 999, fee: 700 });
      expect(outcome.errors).toEqual([]);
      expect(outcome.values).toEqual({ a: 10 });
      expect(outcome.clientDerived).toBeUndefined();
    });

    it("keeps trusting an input that is hidden and excluded, cleared, or behind a hidden ancestor", () => {
      const rule = { visibleWhen: 'a > 5' };
      for (const behavior of ["exclude-from-submission", "clear"]) {
        const outcome = run(calc({ id: "b", type: "number", configuration: { hiddenValueBehavior: behavior }, rules: rule } as ComponentNode), { a: 10, total: 999 });
        expect(outcome.values, behavior).toEqual({ a: 10, total: 999 });
        expect(outcome.clientDerived, behavior).toEqual(["total"]);
      }
      const hiddenFlag = run(calc({ id: "b", type: "number", configuration: { hidden: true, hiddenValueBehavior: "exclude-from-submission" } } as ComponentNode), { a: 10, total: 999 });
      expect(hiddenFlag.clientDerived).toEqual(["total"]);
      const behind = formOfNodes(
        { id: "a", type: "number", configuration: {} },
        { id: "box", type: "fieldset", configuration: {}, rules: rule, children: { content: [{ id: "b", type: "number", configuration: { hiddenValueBehavior: "exclude-from-submission" } }] } } as ComponentNode,
        { id: "total", type: "number", configuration: {}, rules: { value: "a * b" } } as ComponentNode
      );
      expect(run(behind, { a: 10, total: 999 }).clientDerived).toEqual(["total"]);
    });

    it("retaining hidden inputs are the person's own: a hideable input whose hidden answer is retained is recomputed", () => {
      const outcome = run(calc({ id: "b", type: "number", configuration: { hiddenValueBehavior: "retain" }, rules: { visibleWhen: "a > 5" } } as ComponentNode), { a: 10, total: 999 });
      expect(outcome.values).toEqual({ a: 10 });
      expect(outcome.clientDerived).toBeUndefined();
    });

    it("a hideable input that sets nothing leaves its hidden answer out, so a calculation reading it is trusted as sent", () => {
      const outcome = run(calc({ id: "b", type: "number", configuration: {}, rules: { visibleWhen: "a > 5" } } as ComponentNode), { a: 10, total: 999 });
      expect(outcome.values).toEqual({ a: 10, total: 999 });
      expect(outcome.clientDerived).toEqual(["total"]);
    });

    it("a journey recomputes over an optional input that is on the path and omitted, and trusts a read it cannot place", () => {
      const journey: Journey = { id: "j", pages: [{ id: "p1", components: ["a", "b", "total"] }] };
      const outcome = run(calc(plainB), { a: 10, total: 999 }, { journey });
      expect(outcome.values).toEqual({ a: 10 });
      expect(outcome.clientDerived).toBeUndefined();
      // A hideable input that is excluded when hidden stays a maybe, journey or not.
      const hideable = calc({ id: "b", type: "number", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: "a > 5" } } as ComponentNode);
      const kept = run(hideable, { a: 10, total: 999 }, { journey });
      expect(kept.values).toMatchObject({ total: 999 });
      expect(kept.clientDerived).toEqual(["total"]);
    });

    it("keeps trusting a read that names no component of the form", () => {
      const form = formOfNodes({ id: "a", type: "number", configuration: {} }, { id: "total", type: "number", configuration: {}, rules: { value: "a * nothing_here" } } as ComponentNode);
      const outcome = run(form, { a: 10, total: 999 });
      expect(outcome.values).toEqual({ a: 10, total: 999 });
      expect(outcome.clientDerived).toEqual(["total"]);
    });
  });
});

describe("a calculation that does not parse is taken on trust", () => {
  const form: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "a", type: "text", configuration: { label: "A" } },
        { id: "b", type: "number", configuration: { label: "B" }, rules: { value: 'a = "' } }
      ]
    }
  };

  it("keeps the sent value under warn and lists the component in clientDerived", () => {
    // The default is fail: the run is refused. The warn opt-in keeps the value.
    expect(runKernel({ formId: "a17", values: { a: "x", b: 999 }, locale: "en", form }, []).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    const outcome = runKernel({ formId: "a17", values: { a: "x", b: 999 }, locale: "en", form, formulaErrors: "warn" }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.values).toEqual({ a: "x", b: 999 });
    expect(outcome.clientDerived).toEqual(["b"]);
  });

  it("lists nothing when no value was sent for it", () => {
    const outcome = runKernel({ formId: "a17", values: { a: "x" }, locale: "en", form, formulaErrors: "warn" }, []);
    expect(outcome.clientDerived).toBeUndefined();
  });
});

describe("portable kernel: calculations that never settle, plugin results and caps", () => {
  const calc = (id: string, formula: string): ComponentNode => ({ id, type: "number", configuration: { label: id }, rules: { value: formula } });
  const formWith = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });

  it("refuses a calculation that feeds itself, naming it, under fail and under warn", () => {
    for (const formulaErrors of [undefined, "warn"] as const) {
      const outcome = runKernel({ formId: "f", values: { a: 0 }, locale: "en", form: formWith(calc("a", "a + 1")), ...(formulaErrors ? { formulaErrors } : {}) }, []);
      const error = outcome.errors.find((entry) => entry.code === "formula.invalid");
      expect(error, String(formulaErrors)).toBeDefined();
      expect(error?.parameters).toEqual({ where: "rules:a:value", message: "the calculations do not settle: a -> a" });
      expect(outcome.logs?.some((entry) => entry.level === "error" && entry.message.includes("a -> a"))).toBe(true);
      expect(outcome.logs?.some((entry) => entry.message.includes("did not settle"))).toBe(false);
    }
  });

  it("names a cycle of two, in document order", () => {
    const outcome = runKernel({ formId: "f", values: { p: 0, q: 0 }, locale: "en", form: formWith(calc("p", "q + 1"), calc("q", "p + 1")) }, []);
    const error = outcome.errors.find((entry) => entry.code === "formula.invalid");
    expect(error?.parameters).toEqual({ where: "rules:p:value", message: "the calculations do not settle: p -> q -> p" });
  });

  it("skips the validators for a refused calculation set", () => {
    let ran = false;
    const outcome = runKernel({ formId: "f", values: { a: 0 }, locale: "en", form: formWith(calc("a", "a + 1")) }, [
      () => {
        ran = true;
        return { valid: true, errors: [] };
      }
    ]);
    expect(ran).toBe(false);
    expect(outcome.errors.map((entry) => entry.code)).toEqual(["formula.invalid"]);
  });

  it("settles a chain declared sources last, and a form without calculations, and says nothing", () => {
    const chain = formWith(calc("c", "b + 1"), calc("b", "a + 1"), { id: "a", type: "number", configuration: {} });
    const outcome = runKernel({ formId: "f", values: { a: 1, b: 2, c: 3 }, locale: "en", form: chain }, []);
    expect(outcome.errors).toEqual([]);
    expect(outcome.logs?.filter((entry) => entry.level === "warn" || entry.level === "error") ?? []).toEqual([]);
  });

  it("reads a plugin result that is not plain data as no answer, with one warn line naming the function", () => {
    const plain = formWith(
      { id: "n", type: "number", configuration: {} },
      calc("doubled", "twice(n)"),
      { id: "shown", type: "text", configuration: {}, rules: { visibleWhen: "later()" } }
    );
    const signatures = [
      { name: "twice", min: 1, max: 1 },
      { name: "later", min: 0, max: 0 }
    ];
    const outcome = runKernel(
      { formId: "f", values: { n: 3, doubled: 6, shown: "x" }, locale: "en", form: plain },
      [],
      { twice: (args) => Number(args[0]) * Number.NaN, later: () => Promise.resolve(true) },
      signatures
    );
    const warns = (outcome.logs ?? []).filter((entry) => entry.level === "warn").map((entry) => entry.message);
    expect(warns.filter((message) => message.includes('"twice"'))).toHaveLength(1);
    expect(warns.filter((message) => message.includes('"later"'))).toHaveLength(1);
    expect(warns.find((message) => message.includes('"twice"'))).toContain("a number that is not finite");
    expect(warns.find((message) => message.includes('"later"'))).toContain("a promise");
    // The calculation came to no answer, so the sent value is replaced by none.
    expect(outcome.values?.doubled).toBeUndefined();
  });

  it("says a size cap that tripped in a rule, once", () => {
    const outcome = runKernel(
      {
        formId: "f",
        values: { t: "a" },
        locale: "en",
        form: formWith({ id: "t", type: "text", configuration: {} }, { id: "p", type: "text", configuration: {}, rules: { value: 'padStart(t, 20000, "b")' } })
      },
      [],
      undefined,
      formulaFunctionSignatures()
    );
    const warns = (outcome.logs ?? []).filter((entry) => entry.level === "warn").map((entry) => entry.message);
    expect(warns).toEqual(["formula function: padStart: the length is clamped to the 10,000 character cap (text.truncated)"]);
  });

  it("works calculations out sources first, as the browser does: a chain declared sources-last settles in two passes", () => {
    // k0 = k1 + 1 ... k(n-1) = tick(x) + 1: document order is the worst order. The count of
    // passes is the count of times the last link, which reads `tick`, is worked out.
    for (const n of [50, 200, 400]) {
      let passes = 0;
      const links: ComponentNode[] = [{ id: "x", type: "number", configuration: {} }];
      for (let i = 0; i < n; i += 1) {
        links.push(calc(`k${i}`, i === n - 1 ? "tick(x) + 1" : `k${i + 1} + 1`));
      }
      const outcome = runKernel(
        { formId: "f", values: { x: 1 }, locale: "en", form: formWith(...links) },
        [],
        { tick: (args: unknown[]) => { passes += 1; return args[0]; } },
        [...formulaFunctionSignatures(), { name: "tick", min: 1, max: 1 }]
      );
      expect(outcome.errors, String(n)).toEqual([]);
      expect(outcome.values?.k0).toBe(n + 1);
      expect(passes, String(n)).toBeLessThanOrEqual(2);
    }
  });

  it("settles a calculation that returns a fresh list each pass", () => {
    const outcome = runKernel(
      { formId: "f", values: { t: "a,b" }, locale: "en", form: formWith({ id: "t", type: "text", configuration: {} }, { id: "parts", type: "text", configuration: {}, rules: { value: 'split(t, ",")' } }) },
      [],
      undefined,
      formulaFunctionSignatures()
    );
    // The text field refuses a list (a field-constraints error); what matters is that the calculation settles.
    expect(outcome.errors.map((error) => error.code)).not.toContain("formula.invalid");
  });

  it("evaluates a 20,000-term and-chain in a rule", () => {
    const names = Array.from({ length: 20000 }, (_, i) => `a${i}`);
    const values: Record<string, unknown> = {};
    for (const name of names) values[name] = 1;
    const form = formWith(
      ...names.slice(0, 3).map((id): ComponentNode => ({ id, type: "number", configuration: {} })),
      { id: "gate", type: "text", configuration: {}, rules: { visibleWhen: names.map((n) => `${n} = 1`).join(" and ") } }
    );
    const outcome = runKernel({ formId: "f", values: { a0: 1, a1: 1, a2: 1, gate: "x" }, locale: "en", form }, []);
    expect(outcome.errors).toEqual([]);
  });
});

// A rule verdict holds only for the boolean true, in the browser and the kernel alike.
describe("portable kernel: strict truthiness of rule verdicts", () => {
  const answers: Array<[string, unknown]> = [
    ["true", true],
    ["false", false],
    ["the text yes", "yes"],
    ["the text false", "false"],
    ["the number 1", 1],
    ["zero", 0],
    ["null", null],
    ["a list", ["a"]],
    ["an empty list", []],
    ["a group with a tick", { a: true }],
    ["a group with nothing ticked", { a: false }],
    ["nothing", undefined]
  ];
  const verdictForm = (rule: string): ComponentNode => ({
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "v", type: "text", configuration: {} },
        { id: "x", type: "text", configuration: {}, rules: { [rule]: { kind: "path", path: "v" } } }
      ]
    }
  });

  it.each(answers)("reads %s as a verdict: only true holds, kernel and browser alike", (_label, answer) => {
    for (const rule of ["visibleWhen", "enabledWhen", "readonlyWhen"]) {
      const root = verdictForm(rule);
      const values: Record<string, unknown> = answer === undefined ? {} : { v: answer };
      const componentTree = new ComponentTree(root);
      const enginePaths = buildValuePaths(root);
      const index = kernelTreeIndex(root);
      const pathOf = kernelValuePaths(root);
      const idValues = valuesByComponentId(values, buildComponentIdsByPath(root));
      const browser = new RulesSemanticStateResolver().resolve(index.nodeById.x!, {
        values: idValues,
        locale: "en",
        hostContext: {},
        valueOf: (componentId: string) => values[enginePaths.get(componentId) ?? componentId],
        ancestorValuesFor: (componentId: string) => Object.fromEntries(componentTree.ancestorsOf(componentId).map((a) => [a.id, values[enginePaths.get(a.id) ?? a.id]]))
      });
      const kernel = kernelResolveSemanticState(index.nodeById.x!, idValues, values, pathOf, index.parentOf);
      expect(kernel, rule).toEqual(browser);
      const holds = answer === true;
      expect(rule === "visibleWhen" ? kernel.visible : rule === "enabledWhen" ? !kernel.disabled : kernel.readonly, rule).toBe(holds);
    }
  });

  it.each(answers)("reads %s as requiredWhen: only true requires, kernel and browser alike", (_label, answer) => {
    // A list or a group is held by a plugin's type, which stores either as written (a checkbox
    // group stores a list as its record), so the browser and the kernel judge the very same
    // answer; a text field would refuse it (below).
    const holdsMany = answer !== null && typeof answer === "object";
    const root = verdictForm("requiredWhen");
    if (holdsMany) {
      (root.children!.content as ComponentNode[])[0] = { id: "v", type: "x-tags", configuration: {} } as ComponentNode;
    }
    const definition: FormDefinition = { id: "f", version: "1", schemaVersion: "1", root };
    const values: Record<string, unknown> = answer === undefined ? {} : { v: answer };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    for (const [key, value] of Object.entries(values)) {
      runtime.setValue(key, value);
    }
    if (answer !== undefined) {
      expect(runtime.formValues().v).toEqual(answer);
    }
    expect(runtime.isRequired("x")).toBe(answer === true);
    expect(kernelFoldSubmission(root, values, undefined).required.x).toBe(answer === true);
  });

  it.each(answers.filter(([, answer]) => answer !== null && typeof answer === "object"))("refuses %s written to a text field: a text box holds one value", (_label, answer) => {
    const definition: FormDefinition = { id: "f", version: "1", schemaVersion: "1", root: verdictForm("requiredWhen") };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    expect(() => runtime.setValue("v", answer)).toThrow(NonScalarAnswerError);
    expect(runtime.formValues().v).toBeUndefined();
    expect(runtime.isRequired("x")).toBe(false);
  });

  it("reads a formula that is no yes-or-no as not holding in a run, and the yes-or-no form as before", () => {
    const form = (formula: string): ComponentNode => ({
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "name", type: "text", configuration: {} }, { id: "gate", type: "text", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: formula } }] }
    });
    const run = (formula: string): Record<string, unknown> | undefined =>
      runKernel({ formId: "f", values: { name: "Ada", gate: "kept" }, locale: "en", form: form(formula) }, [], undefined, formulaFunctionSignatures()).values;
    expect(run('name = "Ada"')).toEqual({ name: "Ada", gate: "kept" });
    expect(run("len(name)")).toEqual({ name: "Ada" });
    expect(run("name")).toEqual({ name: "Ada" });
    expect(run('if name = "Ada" then "yes"')).toEqual({ name: "Ada" });
    expect(run('if name = "Ada" then true')).toEqual({ name: "Ada", gate: "kept" });
  });
});

describe("kernelStableStringify as one writer", () => {
  // The reference implementation, kept here: the digest depends on its bytes.
  const oldSort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(oldSort);
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, oldSort(value)])
      );
    }
    return input;
  };
  const oldStringify = (input: unknown): string => JSON.stringify(oldSort(input));

  let seed = 12345;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
  const keyPool = ["b", "a", "B", "A", "z", "aa", "a1", "\u00e9", "\u4e2d", "\ud83d\ude00", "__proto__", "constructor", "", "k\"q", "line\nbreak", "10", "9", "x.y", "items[0]"];
  const leaf = (): unknown =>
    pick<unknown>([null, true, false, 0, -0, 1.5, -2.25e-7, 1e21, 123456789012, "plain", "uni\u00e9\u4e2d\ud83d\ude00", 'q"uote\\', "\u2028\u0000", undefined, "", Number.NaN, Infinity]);
  const make = (depth: number): unknown => {
    const roll = random();
    if (depth <= 0 || roll < 0.3) {
      return leaf();
    }
    if (roll < 0.6) {
      return Array.from({ length: Math.floor(random() * 5) }, () => make(depth - 1));
    }
    const out: Record<string, unknown> = {};
    const count = Math.floor(random() * 6);
    for (let i = 0; i < count; i += 1) {
      Object.defineProperty(out, pick(keyPool), { value: make(depth - 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };

  it("writes the same bytes as JSON.stringify of the sorted copy for 500 random values", () => {
    for (let run = 0; run < 500; run += 1) {
      const value = make(5);
      expect(kernelStableStringify(value), `run ${run}`).toBe(oldStringify(value));
    }
  });

  it("matches on the odd cases", () => {
    const cases: unknown[] = [undefined, null, 0, -0, "s", [], {}, [undefined, () => 1], { a: undefined, b: () => 1, c: Symbol("s") }, new Date(0), { d: new Date(0) }, { b: [{ z: 1, a: 2 }], a: null }];
    for (const value of cases) {
      expect(kernelStableStringify(value)).toBe(oldStringify(value));
    }
  });
});

describe("reportFold: the fold's results in the outcome", () => {
  const field = (id: string, configuration: Record<string, unknown> = {}, rules?: Record<string, unknown>): ComponentNode =>
    ({ id, type: "text", configuration, ...(rules ? { rules } : {}) }) as ComponentNode;
  const shown: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "literal", value: "show" } };
  const root: ComponentNode = {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        field("a"),
        field("hid", { required: true, hiddenValueBehavior: "exclude-from-submission" }, { visibleWhen: shown }),
        field("wiped", { hiddenValueBehavior: "clear" }, { visibleWhen: shown }),
        field("must", { required: true })
      ]
    }
  };
  const values = { a: "hide", hid: "s", wiped: "w", stray: 1, empty: undefined, must: "" };

  // The service's former computation, kept here as the reference.
  const former = (unknownFields: "strip" | "keep", input: Record<string, unknown>) => {
    const known = unknownFields === "keep" ? { ...input } : kernelPartitionValues(input, root).known;
    const fold = kernelFoldSubmission(root, known, undefined, {});
    const judged = Object.fromEntries(Object.entries(fold.submittable).filter(([, value]) => value !== undefined));
    const defined = unknownFields === "keep" ? input : kernelPartitionValues(input, root).known;
    return {
      withheld: Object.keys(defined).filter((key) => defined[key] !== undefined && !Object.hasOwn(judged, key)),
      effective: fold.effective,
      submittable: fold.submittable
    };
  };

  it("adds nothing unless asked, so an outcome is what it was", () => {
    const plain = runKernel({ formId: "f", values, locale: "en", form: root }, []);
    for (const key of ["withheld", "effectiveState", "submittable", "trace"]) {
      expect(plain, key).not.toHaveProperty(key);
    }
  });

  it.each(["strip", "keep"] as const)("reports withheld, effectiveState and submittable equal to the former computation (%s)", (unknownFields) => {
    const outcome = runKernel({ formId: "f", values, locale: "en", form: root, unknownFields, reportFold: true }, []);
    const expected = former(unknownFields, values);
    expect(outcome.withheld).toEqual(expected.withheld);
    expect(outcome.withheld).toContain("hid");
    expect(outcome.withheld).toContain("wiped");
    // A blocked run (must is empty) carries no values, and so its judged ones.
    expect(outcome.values).toBeUndefined();
    expect(outcome.submittable).toEqual({ ...expected.submittable });
    // Each listed component filters errors as the full fold does; a component not listed passes all.
    const state = outcome.effectiveState ?? {};
    for (const id of Object.keys(expected.effective)) {
      const full = expected.effective[id] as { runValidation: boolean; requiredApplies: boolean };
      expect(id in state, id).toBe(!full.runValidation || !full.requiredApplies);
      for (const code of ["required", "hook.x"]) {
        const error = { code, componentId: id, stage: "field-constraints" };
        expect(kernelErrorPassesFold(error as never, state as never), `${id} ${code}`).toBe(kernelErrorPassesFold(error as never, expected.effective));
      }
    }
  });

  it("reports an empty withheld when nothing is withheld, and no submittable for an accepted run", () => {
    const outcome = runKernel({ formId: "f", values: { a: "show", hid: "s", must: "x" }, locale: "en", form: root, reportFold: true }, []);
    expect(outcome.withheld).toEqual([]);
    expect(outcome.submittable).toBeUndefined();
    expect(outcome.values).toEqual({ a: "show", hid: "s", must: "x" });
  });
});

/**
 * A data grid's row count: `rows.min` / `rows.max` against the grid at its
 * collection path, the count read as the browser posts rows — every drawn row, an empty one as
 * `{}` — and as the browser's field-constraints stage reads them.
 */
describe("portable kernel: a data grid's row count", () => {
  const sku: ComponentNode = { id: "sku", type: "text", configuration: {} };
  const gridOf = (configuration: Record<string, unknown>, extra: Partial<ComponentNode> = {}): ComponentNode => ({
    id: "items_grid",
    type: "dataGrid",
    configuration,
    collection: { collectionPath: "items" },
    children: { content: [sku] },
    ...extra
  });
  const formWith = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });
  const run = (form: ComponentNode, values: Record<string, unknown>) => runKernel({ formId: "f", values, locale: "en", form }, []);
  const rowErrors = <E extends { code: string }>(outcome: { errors: ReadonlyArray<E> }): E[] => outcome.errors.filter((error) => error.code.startsWith("rows."));
  const stageRowErrors = (form: ComponentNode, values: Record<string, unknown>) =>
    ((createFieldConstraintsStage(form).validate({ formId: "f", locale: "en", values }) as { errors: Array<{ code: string; componentId?: string; path?: string; parameters?: unknown }> }).errors).filter((error) =>
      error.code.startsWith("rows.")
    );

  it("counts every posted row, an empty one included: two rows sent as {} against a minimum of three", () => {
    const form = formWith(gridOf({ minRows: 3 }));
    expect(rowErrors(run(form, { items: [{}, {}] }))).toEqual([
      { code: "rows.min", componentId: "items_grid", path: "items", stage: "field-constraints", source: "wasm", parameters: { min: 3, count: 2 } }
    ]);
    // A row is there as soon as one of its keys is: one flat key, one row.
    expect(rowErrors(run(form, { "items[0].sku": "A1" }))).toEqual([
      { code: "rows.min", componentId: "items_grid", path: "items", stage: "field-constraints", source: "wasm", parameters: { min: 3, count: 1 } }
    ]);
    expect(rowErrors(run(form, {}))[0]?.parameters).toEqual({ min: 3, count: 0 });
    expect(rowErrors(run(form, { items: [{}, { sku: "a" }, {}] }))).toEqual([]);
  });

  it("refuses more rows than the maximum, and accepts a count within the bounds", () => {
    const form = formWith(gridOf({ minRows: 1, maxRows: 2 }));
    expect(rowErrors(run(form, { items: [{ sku: "a" }, {}, { sku: "c" }] }))).toEqual([
      { code: "rows.max", componentId: "items_grid", path: "items", stage: "field-constraints", source: "wasm", parameters: { max: 2, count: 3 } }
    ]);
    expect(run(form, { items: [{ sku: "a" }, { sku: "b" }] }).errors).toEqual([]);
    // No bound, no count: a grid with neither is never refused for its rows.
    expect(rowErrors(run(formWith(gridOf({})), { items: Array.from({ length: 40 }, () => ({})) }))).toEqual([]);
  });

  it("reads the bounds as dataGridSettingsOf does: a maximum below the minimum is the minimum, past 500 is 500", () => {
    expect(rowErrors(run(formWith(gridOf({ minRows: 2, maxRows: 1 })), { items: [{}, {}, {}] }))[0]?.parameters).toEqual({ max: 2, count: 3 });
    expect(rowErrors(run(formWith(gridOf({ minRows: 9000 })), { items: [{}] }))[0]?.parameters).toEqual({ min: 500, count: 1 });
    expect(rowErrors(run(formWith(gridOf({ minRows: "3" })), {}))).toEqual([]);
  });

  it("counts nothing for a grid a rule hides: its rows are not checked and it is not refused for having none", () => {
    const show: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "kind" }, right: { kind: "literal", value: "full" } };
    const form = formWith({ id: "kind", type: "text", configuration: {} }, gridOf({ minRows: 2 }, { rules: { visibleWhen: show } }));
    expect(rowErrors(run(form, { kind: "short" }))).toEqual([]);
    expect(rowErrors(run(form, { kind: "full" }))[0]?.parameters).toEqual({ min: 2, count: 0 });
    // Hidden but held to validation by its own policy: counted, as the browser keeps the error.
    const validated = formWith({ id: "kind", type: "text", configuration: {} }, gridOf({ minRows: 2, hiddenValidationBehavior: "validate" }, { rules: { visibleWhen: show } }));
    expect(rowErrors(run(validated, { kind: "short" }))[0]?.parameters).toEqual({ min: 2, count: 0 });
  });

  it("passes over a grid whose rows live at a path written with brackets: it defines no key to count", () => {
    expect(rowErrors(run(formWith(gridOf({ minRows: 2 }, { collection: { collectionPath: "rows[0]" } })), {}))).toEqual([]);
  });

  it("counts in the browser's stage as the kernel counts: flat keys, else the rows posted whole", () => {
    const form = formWith(gridOf({ minRows: 3, maxRows: 4 }));
    const cases: Array<Record<string, unknown>> = [
      {},
      { items: [{}, {}] },
      { "items[0].sku": "A1" },
      { "items[0].sku": "A1", "items[2].sku": "C3" },
      { items: [{}, { sku: "b" }, {}, {}, {}] },
      { items: [] },
      // Flat keys win over a list sent beside them, on both sides.
      { items: [{}, {}, {}, {}, {}], "items[0].sku": "A1" }
    ];
    for (const values of cases) {
      const kernel = rowErrors(run(form, values)).map((error) => [error.code, (error as { parameters?: unknown }).parameters]);
      const browser = stageRowErrors(form, values).map((error) => [error.code, error.parameters]);
      expect(browser, JSON.stringify(values)).toEqual(kernel);
    }
    expect(stageRowErrors(form, { items: [{}, {}] })[0]).toMatchObject({ componentId: "items_grid", path: "items", parameters: { min: 3, count: 2 } });
  });

  // A posted row none of whose keys is stored is a row all the same, so the
  // kernel counts the list the person sent, as the browser's stage counts it.
  it("counts a row whose every key is stripped, or that holds only empty objects, as the stage does", () => {
    const address: ComponentNode = { id: "address", type: "container", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: {} }] } };
    const form = formWith(gridOf({ minRows: 3, maxRows: 4 }, { children: { content: [sku, address] } }));
    const cases: Array<Record<string, unknown>> = [
      { items: [{ junk: 1 }, {}] },
      { items: [{ junk: 1, more: "x" }, { sku: "b" }] },
      { items: [{ address: {} }] },
      { items: [{ address: {} }, { address: { city: "Ottawa" } }, { junk: true }] },
      { items: [{ address: { zone: 3 } }, {}, {}, {}, { junk: 1 }] },
      { items: [{ sku: "a", junk: 1 }, { junk: 2 }, { address: {} }, {}] }
    ];
    for (const values of cases) {
      const posted = (values.items as unknown[]).length;
      for (const unknownFields of ["strip", "keep", "reject"] as const) {
        const outcome = runKernel({ formId: "f", values, locale: "en", form, unknownFields }, []);
        const kernel = rowErrors(outcome).map((error) => [error.code, (error as { parameters?: unknown }).parameters]);
        const expected = posted < 3 ? [["rows.min", { min: 3, count: posted }]] : posted > 4 ? [["rows.max", { max: 4, count: posted }]] : [];
        expect(kernel, `${JSON.stringify(values)} ${unknownFields}`).toEqual(expected);
      }
      const browser = stageRowErrors(form, values).map((error) => [error.code, error.parameters]);
      const strip = rowErrors(run(form, values)).map((error) => [error.code, (error as { parameters?: unknown }).parameters]);
      expect(browser, JSON.stringify(values)).toEqual(strip);
    }
  });

  it("holds such a row's required cells, as for a row posted as {}", () => {
    const form = formWith(gridOf({}, { children: { content: [{ id: "sku", type: "text", configuration: { required: true } }] } }));
    const required = (values: Record<string, unknown>) =>
      run(form, values)
        .errors.filter((error) => error.code === "required")
        .map((error) => error.path);
    expect(required({ items: [{ junk: 1 }, { sku: "b" }, {}] })).toEqual(["items[0].sku", "items[2].sku"]);
    expect(required({ items: [{ sku: "a" }] })).toEqual([]);
  });
});

/**
 * A data grid's bound formulas: `rules.minRows` / `rules.maxRows`, evaluated
 * form-scoped over the fold's settled view; a finite whole number from 0 wins over the fixed
 * bound, anything else leaves it in force, and run scopes apply as to every rule.
 */
describe("portable kernel: a data grid's bound formulas", () => {
  const sku: ComponentNode = { id: "sku", type: "text", configuration: {} };
  const people: ComponentNode = { id: "people", type: "number", configuration: {} };
  const gridOf = (configuration: Record<string, unknown>, rules: Record<string, unknown>, extra: Partial<ComponentNode> = {}): ComponentNode => ({
    id: "items_grid",
    type: "dataGrid",
    configuration,
    rules: rules as NonNullable<ComponentNode["rules"]>,
    collection: { collectionPath: "items" },
    children: { content: [sku] },
    ...extra
  });
  const formWith = (...children: ComponentNode[]): ComponentNode => ({ id: "form", type: "form", configuration: {}, children: { content: children } });
  const run = (form: ComponentNode, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runKernel({ formId: "f", values, locale: "en", form, ...extra } as Parameters<typeof runKernel>[0], []);
  const rowErrors = (outcome: { errors: ReadonlyArray<{ code: string; parameters?: unknown }> }) =>
    outcome.errors.filter((error) => error.code.startsWith("rows.")).map((error) => [error.code, error.parameters]);
  const rows = (count: number) => Array.from({ length: count }, () => ({}));

  it("lets a formula over another answer set the minimum, the fixed bound standing while it comes to no number", () => {
    const form = formWith(people, gridOf({ minRows: 1 }, { minRows: "people" }));
    expect(rowErrors(run(form, { people: 3, items: rows(2) }))).toEqual([["rows.min", { min: 3, count: 2 }]]);
    expect(rowErrors(run(form, { people: 2, items: rows(2) }))).toEqual([]);
    expect(rowErrors(run(form, { people: 0, items: [] }))).toEqual([]);
    // No answer, a fraction, a negative: the fixed minimum of one stands.
    for (const value of [undefined, 2.5, -4]) {
      expect(rowErrors(run(form, { ...(value === undefined ? {} : { people: value }), items: [] })), String(value)).toEqual([["rows.min", { min: 1, count: 0 }]]);
    }
    // Past the cap reads as the cap.
    expect(rowErrors(run(form, { people: 9000, items: rows(2) }))).toEqual([["rows.min", { min: 500, count: 2 }]]);
  });

  it("lets a formula set the maximum, one below the resolved minimum read as the minimum", () => {
    const form = formWith(people, gridOf({ maxRows: 10 }, { maxRows: "people * 2" }));
    expect(rowErrors(run(form, { people: 1, items: rows(3) }))).toEqual([["rows.max", { max: 2, count: 3 }]]);
    expect(rowErrors(run(form, { items: rows(11) }))).toEqual([["rows.max", { max: 10, count: 11 }]]);
    const both = formWith(people, gridOf({}, { minRows: "people", maxRows: "1" }));
    expect(rowErrors(run(both, { people: 3, items: rows(4) }))).toEqual([["rows.max", { max: 3, count: 4 }]]);
    expect(rowErrors(run(both, { people: 3, items: rows(3) }))).toEqual([]);
  });

  it("never evaluates a bound that reads row.: the fixed bound stands", () => {
    const form = formWith(gridOf({ minRows: 1 }, { minRows: 'if row.sku = null then 4 else 4' }));
    expect(rowErrors(run(form, { items: [] }))).toEqual([["rows.min", { min: 1, count: 0 }]]);
  });

  // rowIndex(), rowCount() and ancestor. have a value only inside a row, as row. does.
  it("never evaluates a bound that reads rowIndex(), rowCount() or ancestor., nor counts it as a server rule", () => {
    for (const formula of ["if rowIndex() = null then 4 else 4", "if rowCount() = null then 4 else 4", "rowCount() + 4", "if ancestor.kind = null then 4 else 4"]) {
      for (const run_ of ["both", "server"]) {
        const form = formWith(gridOf({ minRows: 1 }, { minRows: { formula, run: run_ } }));
        const outcome = runKernel({ formId: "f", values: { items: [] }, locale: "en", form }, [], undefined, formulaFunctionSignatures());
        expect(outcome.errors.map((error) => [error.code, error.parameters]), `${formula} ${run_}`).toEqual([["rows.min", { min: 1, count: 0 }]]);
        expect((outcome as { serverRules?: string[] }).serverRules ?? [], `${formula} ${run_}`).toEqual([]);
      }
    }
  });

  it("applies run scopes as for every rule: a browser bound is not read here, a server bound is and is listed", () => {
    const browser = formWith(gridOf({ minRows: 1 }, { minRows: { formula: "3", run: "browser" } }));
    expect(rowErrors(run(browser, { items: rows(1) }))).toEqual([]);
    const server = formWith(gridOf({ minRows: 1 }, { minRows: { formula: "3", run: "server" } }));
    const outcome = run(server, { items: rows(1) });
    expect(rowErrors(outcome)).toEqual([["rows.min", { min: 3, count: 1 }]]);
    expect((outcome as { serverRules?: string[] }).serverRules).toEqual(["items_grid"]);
    // A host. read is skipped on the server, as every rule reading the host is.
    const host = formWith(gridOf({ minRows: 1 }, { minRows: "host.seats" }));
    expect(rowErrors(run(host, { items: rows(1) }))).toEqual([]);
  });

  it("judges a bound formula that does not parse by the policy: fail refuses the run, warn leaves the fixed bound", () => {
    const form = formWith(gridOf({ minRows: 2 }, { minRows: "3 +" }));
    expect(run(form, { items: [] }).errors.map((error) => error.code)).toEqual(["formula.invalid"]);
    expect(rowErrors(run(form, { items: [] }, { formulaErrors: "warn" }))).toEqual([["rows.min", { min: 2, count: 0 }]]);
  });

  it("reads nothing for a bound on a component that is not a grid, and counts nothing for a hidden grid", () => {
    const section: ComponentNode = { id: "sec", type: "container", configuration: {}, collection: { collectionPath: "items" }, rules: { minRows: "5" } as NonNullable<ComponentNode["rules"]>, children: { content: [sku] } };
    expect(rowErrors(run(formWith(section), { items: [] }))).toEqual([]);
    const hidden = formWith(people, gridOf({}, { minRows: "people", visibleWhen: "people > 5" }));
    expect(rowErrors(run(hidden, { people: 3, items: [] }))).toEqual([]);
    expect(rowErrors(run(hidden, { people: 7, items: [] }))).toEqual([["rows.min", { min: 7, count: 0 }]]);
  });

  it("agrees with the browser's stage handed the resolved bounds, and the stage keeps the fixed bounds without them", () => {
    const grid = gridOf({ minRows: 1, maxRows: 6 }, { minRows: "people", maxRows: "people + 1" });
    const form = formWith(people, grid);
    const stage = createFieldConstraintsStage(form);
    for (const [answer, count] of [[2, 1], [2, 4], [3, 3], [undefined, 0], [1.5, 7], [4, 6]] as Array<[number | undefined, number]>) {
      const values: Record<string, unknown> = { ...(answer === undefined ? {} : { people: answer }), items: rows(count) };
      const resolved = resolveDataGridRowBounds(dataGridSettingsOf(grid), { min: answer, max: answer === undefined ? undefined : answer + 1 });
      const browser = (stage.validate({ formId: "f", locale: "en", values, dataGridRowBounds: { items_grid: resolved } } as Parameters<typeof stage.validate>[0]) as {
        errors: Array<{ code: string; parameters?: unknown }>;
      }).errors
        .filter((error) => error.code.startsWith("rows."))
        .map((error) => [error.code, error.parameters]);
      expect(browser, JSON.stringify(values)).toEqual(rowErrors(run(form, values)));
    }
    const fixedOnly = (stage.validate({ formId: "f", locale: "en", values: { people: 5, items: [] } }) as { errors: Array<{ code: string; parameters?: unknown }> }).errors;
    expect(fixedOnly.map((error) => [error.code, error.parameters])).toEqual([["rows.min", { min: 1, count: 0 }]]);
  });
});
