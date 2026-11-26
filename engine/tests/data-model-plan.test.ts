import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BuilderController, type InsertComponentEntry } from "../form-engine/builder/controller/builder-controller.js";
import { DataModelImporter, formDataModel as importFormDataModel } from "../form-engine/builder/data/data-model-import.js";
import {
  dataModelClassifier,
  dataModelExample,
  dataModelGenerateOptions,
  dataModelToJsonSchema,
  formDataModel,
  planDataModelAdd,
  planDataModelReplace,
  readDataModelInput,
  type DataModel
} from "../form-engine/builder/data/data-model-plan.js";
import { loadDataModelPlan } from "../form-engine/builder/data/data-model-plan-loader.js";
import { classifyComponentForDataModel, dataModelFromForm, type DataModelClassification } from "../form-engine/builder/data-model/from-form.js";
import { BuilderWords } from "../form-engine/builder/logic/builder-texts.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The data-model planner without the DOM: the pieces the Data
 * workspace's import kept to itself moved to `data-model-plan.ts`, which the import imports back
 * and the browser-assistant tools load through `data-model-plan-loader.ts`. What the planner
 * plans is what the import builds, field for field.
 */

const leaf = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: { label: `${type} field` } }),
  capabilities: standardFieldCapabilities(),
  ...extra
});
const box = (type: string): ComponentDefinition => ({
  type,
  version: "1.0.0",
  createDefault: () => ({ id: type, type, configuration: { label: type }, children: { content: [] } }),
  capabilities: [],
  children: { slots: [{ id: "content", multiple: true }] }
});
const DEFINITIONS: ComponentDefinition[] = [
  box("form"),
  ...["text", "textarea", "number", "checkbox", "select", "radio", "checkboxes", "date", "email"].map((type) => leaf(type)),
  box("container"),
  box("panel"),
  leaf("button", { capabilities: standardFieldCapabilities({ required: false }) }),
  // A host's own types the engine does not know: one holds a value (its inspector offers a Data
  // key), one holds nothing, one groups others.
  leaf("host-rating"),
  leaf("host-badge", { capabilities: [] }),
  box("host-group")
];

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "age", type: "text", configuration: { label: "Age" } },
        { id: "stars", type: "host-rating", configuration: { label: "Stars" } },
        { id: "flair", type: "host-badge", configuration: { label: "Flair" } },
        { id: "extras", type: "host-group", configuration: { label: "Extras" }, children: { content: [{ id: "note", type: "textarea", configuration: { label: "Note" } }] } },
        { id: "send", type: "button", configuration: { label: "Send" } }
      ]
    }
  };
}

const controller = (): BuilderController => new BuilderController({ initialRoot: form(), componentDefinitions: DEFINITIONS });

const SAMPLE = {
  name: "Ada",
  age: 36,
  email: "ada@example.org",
  visits: 3,
  subscribed: true,
  address: { street: "1 Main St", city: "London" },
  items: [{ sku: "A-1", qty: 2 }],
  tags: ["a", "b"]
};

const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["title"],
  properties: {
    title: { type: "string", enum: ["Dr", "Mr", "Ms"] },
    guests: { type: "integer", minimum: 0 },
    when: { type: "string", format: "date" },
    contact: { type: "object", properties: { phone: { type: "string" } } }
  }
};

function read(value: unknown): DataModel {
  const result = readDataModelInput(JSON.stringify(value), "auto");
  if (!result.ok) {
    throw new Error("unreadable fixture");
  }
  return result.model;
}

/** The import, driven as its buttons drive it, with what its build hands the controller captured. */
interface Captured {
  entries?: readonly InsertComponentEntry[] | undefined;
  nodes?: readonly ComponentNode[] | undefined;
  keep?: readonly string[] | undefined;
}

function importerRun(target: BuilderController, value: unknown, action: "add" | "replace"): Captured {
  const captured: Captured = {};
  const insert = target.requestInsertComponents.bind(target);
  target.requestInsertComponents = (entries, options) =>
    insert(() => {
      const planned = typeof entries === "function" ? entries() : entries;
      captured.entries = structuredClone(planned);
      return planned;
    }, options);
  const replace = target.requestReplaceContent.bind(target);
  target.requestReplaceContent = (nodes, options) =>
    replace(() => {
      const planned = typeof nodes === "function" ? nodes() : nodes;
      captured.nodes = structuredClone(planned);
      captured.keep = options?.keep ? [...options.keep] : undefined;
      return planned;
    }, options);
  const importer = new DataModelImporter({
    controller: () => target,
    canBuild: () => true,
    selectsRows: () => false,
    scope: () => undefined,
    paint: () => undefined,
    announce: () => undefined,
    built: () => undefined
  });
  importer.setText(JSON.stringify(value));
  const button = (name: string): HTMLElement => ({ dataset: { [name]: "" } }) as unknown as HTMLElement;
  if (action === "add") {
    importer.click(button("modelAdd"));
  } else {
    importer.click(button("modelReplace"));
    importer.click(button("modelReplaceConfirm"));
  }
  return captured;
}

describe("planDataModelAdd and planDataModelReplace plan what the import builds", () => {
  for (const [name, value] of [
    ["a sample", SAMPLE],
    ["a schema", SCHEMA]
  ] as const) {
    it(`adds the same components at the same places for ${name}, and reports what the form already holds`, () => {
      const planned = controller();
      const plan = planDataModelAdd(planned, read(value));
      const imported = controller();
      const captured = importerRun(imported, value, "add");
      expect(plan.entries.length).toBeGreaterThan(0);
      expect(plan.entries).toEqual(captured.entries);
      // The plan placed through the controller leaves the tree the import left.
      expect(planned.requestInsertComponents(() => planDataModelAdd(planned, read(value)).entries, { select: "none" })).toBe(true);
      expect(planned.snapshot()).toEqual(imported.snapshot());
      expect(plan.added.map((entry) => entry.componentId)).toEqual(plan.entries.map((entry) => entry.node.id));
      expect(plan.comparison.counts.new).toBeGreaterThan(0);
    });

    it(`replaces with the same components and keeps the same closing buttons for ${name}`, () => {
      const plan = planDataModelReplace(controller(), read(value));
      const imported = controller();
      const captured = importerRun(imported, value, "replace");
      expect(plan.nodes).toEqual(captured.nodes);
      expect(plan.keep).toEqual(captured.keep);
      expect(plan.keep).toEqual(["send"]);
    });
  }

  it("reports a place the form holds as something else, and what it already has", () => {
    const plan = planDataModelAdd(controller(), read({ name: "Ada", age: { years: 3 }, phone: "x" }));
    expect(plan.comparison.byPath.get("name")?.status).toBe("present");
    expect(plan.comparison.byPath.get("age")?.status).toBe("kind-differs");
    expect(plan.entries.map((entry) => entry.node.id)).toEqual(["phone"]);
  });

  it("plans over the committed tree: a draft not applied is not built around", () => {
    const target = controller();
    target.select("name");
    target.setDraftProperty("name", "dataKey", "fullName");
    // The committed `name` holds the place: nothing new for it.
    expect(planDataModelAdd(target, read({ name: "Ada" })).entries).toEqual([]);
  });

  it("words a skipped place in the builder's words, English when none are given", () => {
    // `tags` is a checkboxes group (an object of flags): a new key under it is no place for a field.
    const target = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "tags", type: "checkboxes", configuration: { label: "Tags", options: [{ value: "a", label: "A" }] } }] }
      },
      componentDefinitions: DEFINITIONS
    });
    const sample = { tags: { a: true, b: "x" } };
    const english = planDataModelAdd(target, read(sample));
    expect(english.entries).toEqual([]);
    expect(english.skipped).toEqual([{ path: "tags.b", reason: "The form holds tags as something other than an object." }]);
    const french = new BuilderWords();
    french.locale = "fr";
    french.catalog = { fr: { "dataModel.gen.notObject": "Le formulaire ne tient pas {path} comme un objet." } };
    expect(planDataModelAdd(target, read(sample), french).skipped).toEqual([{ path: "tags.b", reason: "Le formulaire ne tient pas tags comme un objet." }]);
  });
});

describe("formDataModel, the classifier and the generate options moved without a change", () => {
  /** The import's own functions as they stood before the move (data-model-import.ts:223-248 at fcbb066). */
  function classifierBefore(target: BuilderController): (node: ComponentNode) => DataModelClassification | undefined {
    return (node) => {
      if (classifyComponentForDataModel(node) !== undefined) {
        return undefined;
      }
      if (node.children && Object.keys(node.children).length > 0) {
        return { role: "group" };
      }
      return target.offersDataKey(node.type) ? { role: "value", kind: "unknown" } : { role: "none" };
    };
  }
  const formDataModelBefore = (target: BuilderController): DataModel =>
    dataModelFromForm(target.previewSnapshot(), { locale: target.currentLocale(), classify: classifierBefore(target) });

  it("reads the form's model as the import did, a host's unknown types and an open draft included", () => {
    const target = controller();
    target.select("age");
    target.setDraftProperty("age", "label", "Your age");
    const model = formDataModel(target);
    expect(model).toEqual(formDataModelBefore(target));
    // The draft shows, as the Data surface shows it.
    expect(JSON.stringify(model)).toContain("Your age");
    // An unknown type that holds a value is a place; one that holds nothing is not; a group's child is.
    const paths = JSON.stringify(dataModelToJsonSchema(model));
    expect(paths).toContain('"stars"');
    expect(paths).not.toContain('"flair"');
    expect(paths).toContain('"note"');
    expect(Object.keys(dataModelExample(model))).toEqual(expect.arrayContaining(["name", "age", "stars"]));
  });

  it("classifies each node as before", () => {
    const target = controller();
    const now = dataModelClassifier(target);
    const before = classifierBefore(target);
    const nodes: ComponentNode[] = [
      { id: "a", type: "text", configuration: {} },
      { id: "b", type: "host-rating", configuration: {} },
      { id: "c", type: "host-badge", configuration: {} },
      { id: "d", type: "host-group", configuration: {}, children: { content: [] } },
      { id: "e", type: "nobody-knows", configuration: {} }
    ];
    expect(nodes.map(now)).toEqual(nodes.map(before));
    expect(nodes.map(now)).toEqual([undefined, { role: "value", kind: "unknown" }, { role: "none" }, { role: "group" }, { role: "none" }]);
  });

  it("hands the generator the ids the form claims, its types and templates, and the words", () => {
    const target = controller();
    target.setOptions({ claimedIds: () => ["held"] }, { silent: true });
    const words = new BuilderWords();
    words.locale = "fr";
    const options = dataModelGenerateOptions(target, words);
    expect([...(options.takenIds ?? [])]).toEqual(["held"]);
    expect(options.hasType("email")).toBe(true);
    expect(options.hasType("nope")).toBe(false);
    expect(options.template?.("email")).toEqual(target.componentTemplate("email"));
    expect(options.text).toEqual({ locale: "fr" });
  });

  it("is the one function the import exports and the Data workspace reads", () => {
    expect(importFormDataModel).toBe(formDataModel);
  });
});

describe("the module's place", () => {
  const dir = join(import.meta.dirname, "..", "form-engine", "builder", "data");

  it("never imports the import's DOM module, nor anything of the web components or the agent", () => {
    const source = readFileSync(join(dir, "data-model-plan.ts"), "utf8");
    expect(source).not.toContain("data-model-import");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
    expect(imports.filter((path) => path.includes("web-component") || path.includes("/agent/"))).toEqual([]);
  });

  it("is imported back by the import, which defines none of the three itself", () => {
    const source = readFileSync(join(dir, "data-model-import.ts"), "utf8");
    expect(source).toMatch(/import \{ dataModelClassifier, dataModelGenerateOptions, formDataModel \} from "\.\/data-model-plan\.js";/);
    expect(source).not.toMatch(/function (classifier|generateOptions|formDataModel|dataModelClassifier|dataModelGenerateOptions)\b/);
  });

  it("loads through its loader as the same module, once", async () => {
    const loaded = await loadDataModelPlan();
    expect(loaded.planDataModelAdd).toBe(planDataModelAdd);
    expect(loaded.formDataModel).toBe(formDataModel);
    expect(await loadDataModelPlan()).toBe(loaded);
    const loader = readFileSync(join(dir, "data-model-plan-loader.ts"), "utf8");
    expect(loader).toContain('import("./data-model-plan.js")');
    // No static value import: the planner stays out of the builder's entry.
    expect(loader).not.toMatch(/^import\s+(?!type)[^;]*from\s+"\.\/data-model-plan\.js"/m);
  });
});
