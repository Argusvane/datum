import { describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { journeyPageFormIds, type Journey } from "../form-engine/core/schema/journey.js";
import type { JourneyView } from "../form-engine/core/journey/journey-types.js";
import { FormStateStore, type FormState } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildRenderOutput, type RenderOrchestratorRequest } from "../form-engine/render/core/render-orchestrator.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import type { RenderMode } from "../form-engine/render/core/render-contracts.js";
import { NoopJourneyRenderKit } from "../form-engine/render/core/journey-render-kit.js";
import {
  foldPresentation,
  presentationNodes,
  type PresentationFoldOptions,
  type PresentationGrid,
  type PresentationGroup,
  type PresentationNode,
  type PresentationSteps
} from "../form-engine/render/core/presentation-tree.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

async function fold(
  root: ComponentNode,
  options: Partial<PresentationFoldOptions> = {},
  request: Partial<RenderOrchestratorRequest> = {},
  state: FormState = new FormStateStore(options.locale ?? "en").snapshot()
) {
  const output = await buildRenderOutput({ mode: "interactive", root, state, resolver, componentTree: new ComponentTree(root), ...request });
  return foldPresentation(output, { locale: state.locale, ...options });
}

function form(children: ComponentNode[], slots?: Record<string, ComponentNode[]>): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: slots ?? { content: children } };
}

/** The tree's shape: kinds and ids, nested. */
function shape(nodes: readonly PresentationNode[]): unknown[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "field":
        return node.id;
      case "group":
      case "page":
        return { [`${node.kind}:${node.id}`]: shape(node.children) };
      case "tabs":
        return { [`tabs:${node.id}`]: node.tabs.map((tab) => ({ [tab.slotId]: shape(tab.children) })) };
      case "steps":
        return { [`steps:${node.id}`]: node.steps.map((step) => ({ [step.id]: shape(step.children) })) };
      case "grid":
        return { [`grid:${node.id}`]: node.rows.map((row) => row.cells.map((cell) => shape(cell.children))) };
    }
  });
}

const find = <K extends PresentationNode["kind"]>(nodes: readonly PresentationNode[], kind: K, id: string) =>
  presentationNodes(nodes).find((node) => node.kind === kind && node.id === id) as Extract<PresentationNode, { kind: K }>;

describe("presentation fold: groups and fields", () => {
  it("folds every container as a node, never flattening one, in slot order", async () => {
    const tree = await fold(
      form([
        { id: "intro", type: "html", configuration: { content: "<p>Hi</p>" } },
        {
          id: "you",
          type: "fieldset",
          configuration: { label: "You", description: "About you", hideLabel: true, legendMark: "required" },
          children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
        },
        {
          id: "plain",
          type: "container",
          configuration: {},
          children: { content: [{ id: "email", type: "text", configuration: { label: "Email" } }] }
        },
        {
          id: "where",
          type: "grid",
          configuration: { columns: 2 },
          // Authored out of order: the columns are drawn in declared order.
          children: {
            column_2: [{ id: "postcode", type: "text", configuration: { label: "Postcode" } }],
            column_1: [{ id: "city", type: "text", configuration: { label: "City" } }]
          }
        }
      ])
    );
    expect(shape(tree.nodes)).toEqual([
      "intro",
      { "group:you": ["name"] },
      { "group:plain": ["email"] },
      { "group:where": ["city", "postcode"] }
    ]);
    const you = find(tree.nodes, "group", "you");
    expect(you).toMatchObject({ legend: "You", hint: "About you", hideLegend: true, legendMark: "required", level: 1, base: "fieldset" });
    // A container its author gave no label is unnamed: `model.label` falls back to the id, the legend does not.
    const plain = find(tree.nodes, "group", "plain");
    expect(plain.legend).toBeUndefined();
    expect(plain.hint).toBeUndefined();
    const where = find(tree.nodes, "group", "where");
    expect(where.slots.map((slot) => slot.slotId)).toEqual(["column_1", "column_2"]);
    expect(where.layout).toEqual({ kind: "grid", columns: 2 });
    expect(tree.fields.map((field) => field.id)).toEqual(["intro", "name", "email", "city", "postcode"]);
    expect(tree.unknownContainers).toEqual([]);
  });

  it("drops a hidden component with its subtree and a container left empty, unless asked to keep hidden ones", async () => {
    const root = form([
      { id: "shown", type: "text", configuration: { label: "Shown" } },
      { id: "gone", type: "text", configuration: { label: "Gone", hidden: true } },
      {
        id: "box",
        type: "fieldset",
        configuration: { label: "Box", hidden: true },
        children: { content: [{ id: "inner", type: "text", configuration: { label: "Inner" } }] }
      },
      { id: "empty", type: "fieldset", configuration: { label: "Empty" }, children: { content: [] } }
    ]);
    expect(shape((await fold(root)).nodes)).toEqual(["shown"]);
    const kept = await fold(root, { includeHidden: true });
    expect(shape(kept.nodes)).toEqual(["shown", "gone", { "group:box": ["inner"] }]);
    expect(find(kept.nodes, "group", "box").visible).toBe(false);
  });

  it("nests levels and reads a design system's own types as their base through the definition's kinds map", async () => {
    const tree = await fold(
      form([
        {
          id: "outer",
          type: "fieldset",
          configuration: { label: "Outer" },
          children: {
            content: [
              {
                id: "inner",
                type: "fieldset",
                configuration: { label: "Inner" },
                children: { content: [{ id: "born", type: "gcds-date", configuration: { label: "Born" } }] }
              }
            ]
          }
        }
      ]),
      { kinds: { "gcds-date": "date" } }
    );
    expect(find(tree.nodes, "group", "outer")).toMatchObject({ type: "fieldset", base: "fieldset", level: 1 });
    expect(find(tree.nodes, "group", "inner").level).toBe(2);
    expect(tree.fields[0]).toMatchObject({ id: "born", type: "gcds-date", base: "date" });
    expect(tree.unknownContainers).toEqual([]);
  });

  it("counts the levels from the host's headingLevel, the form's place in the page's outline", async () => {
    const nested = form([
      { id: "outer", type: "fieldset", configuration: { label: "Outer" }, children: { content: [{ id: "inner", type: "panel", configuration: { label: "Inner" }, children: { content: [] } }] } }
    ]);
    const tree = await fold(nested, { headingLevel: 3, keepEmpty: true });
    expect(find(tree.nodes, "group", "outer").level).toBe(3);
    expect(find(tree.nodes, "group", "inner").level).toBe(4);
    // Left out (or not a level), the form heads at 1.
    expect(find((await fold(nested, { keepEmpty: true })).nodes, "group", "outer").level).toBe(1);
    expect(find((await fold(nested, { headingLevel: Number.NaN, keepEmpty: true })).nodes, "group", "outer").level).toBe(1);
  });

  it("reads a container type mapped to a plain container base as that base; one mapped to any other container stays unknown", async () => {
    const outer = (type: string): ComponentNode => ({
      id: "outer",
      type,
      configuration: { label: "Outer" },
      children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] }
    });
    const tree = await fold(form([outer("gcds-fieldset")]), { kinds: { "gcds-fieldset": "fieldset" } });
    expect(find(tree.nodes, "group", "outer")).toMatchObject({ type: "gcds-fieldset", base: "fieldset", legend: "Outer" });
    expect(find(tree.nodes, "group", "outer").unknown).toBeUndefined();
    expect(tree.unknownContainers).toEqual([]);
    // A data-scoping container is no drawing-only base: the map names nothing usable.
    const scoped = await fold(form([outer("x-box")]), { kinds: { "x-box": "container" } });
    expect(find(scoped.nodes, "group", "outer")).toMatchObject({ type: "x-box", base: "x-box", unknown: true });
    expect(scoped.unknownContainers).toEqual([{ componentId: "outer", type: "x-box" }]);
  });

  it("reports a container nothing knows, once, and keeps its children inside it as a group", async () => {
    const root = form([
      {
        id: "mystery",
        type: "fancy-box",
        configuration: {},
        children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] }
      },
      { id: "lonely", type: "fancy-box", configuration: {}, children: { content: [] } }
    ]);
    const tree = await fold(root);
    expect(shape(tree.nodes)).toEqual([{ "group:mystery": ["a"] }, { "group:lonely": [] }]);
    expect(find(tree.nodes, "group", "mystery").unknown).toBe(true);
    expect(tree.unknownContainers).toEqual([
      { componentId: "mystery", type: "fancy-box" },
      { componentId: "lonely", type: "fancy-box" }
    ]);
    // A container the caller can draw (a plugin's) is not reported.
    const known = await fold(root, { isKnownContainer: (type) => type === "fancy-box" });
    expect(known.unknownContainers).toEqual([]);
    // ... and it keeps its wrapper empty, as the markup does (a notice's title, an empty details).
    expect(shape(known.nodes)).toEqual([{ "group:mystery": ["a"] }, { "group:lonely": [] }]);
    // An engine container with nothing in it draws nothing.
    expect(shape((await fold(form([{ id: "bare", type: "fieldset", configuration: { label: "Bare" }, children: { content: [] } }]), { isKnownContainer: () => true })).nodes)).toEqual([]);
  });
});

describe("presentation fold: tabs", () => {
  const tabs = (configuration: Record<string, unknown>): ComponentNode =>
    form([
      {
        id: "t",
        type: "tabs",
        configuration,
        children: {
          personal: [{ id: "name", type: "text", configuration: { label: "Name" } }],
          stray: [{ id: "note", type: "text", configuration: { label: "Note" } }]
        }
      }
    ]);

  it("lists the declared tabs, then any slot a child occupies, each named in the form's language, else by its place", async () => {
    const translations: FormTranslations = {
      fr: { components: { t: { tabs: { personal: { label: { text: "Vous", source: sourceHash("You") } } } } } }
    };
    const root = tabs({ tabs: [{ id: "personal", label: "You" }, { id: "work" }] });
    const english = await fold(root);
    const node = find(english.nodes, "tabs", "t");
    expect(node.tabs.map((tab) => [tab.slotId, tab.label])).toEqual([
      ["personal", "You"],
      ["work", "Tab 2"],
      ["stray", "Tab 3"]
    ]);
    expect(shape(english.nodes)).toEqual([{ "tabs:t": [{ personal: ["name"] }, { work: [] }, { stray: ["note"] }] }]);
    // Every field records the tab it sits behind.
    expect(english.fields.map((field) => field.reveal)).toEqual([
      [{ kind: "tab", tabsId: "t", slotId: "personal" }],
      [{ kind: "tab", tabsId: "t", slotId: "stray" }]
    ]);
    const french = await fold(root, { locale: "fr", translations }, { translations });
    expect(find(french.nodes, "tabs", "t").tabs[0]?.label).toBe("Vous");
  });

  it("counts each tab's blocking errors, never a warning", async () => {
    const errors: FormError[] = [
      { id: "e1", code: "required", componentId: "name", stage: "field", source: "client" },
      { id: "e2", code: "soft", componentId: "note", stage: "field", source: "client", severity: "warning" }
    ];
    const tree = await fold(tabs({ tabs: [{ id: "personal", label: "You" }] }), {}, { errors });
    expect(find(tree.nodes, "tabs", "t").tabs.map((tab) => tab.errorCount)).toEqual([1, 0]);
  });

  it("words a fallback from the host's texts over the binding's pack over the engine's English", async () => {
    const root = tabs({ tabs: [{ id: "personal" }] });
    const binding = await fold(root, { bindingTexts: { tabFallback: "Section {{ n }}" } });
    expect(find(binding.nodes, "tabs", "t").tabs[0]?.label).toBe("Section 1");
    const host = await fold(root, { texts: { tabFallback: "Part {{n}}" }, bindingTexts: { tabFallback: "Section {{n}}" } });
    expect(find(host.nodes, "tabs", "t").tabs[0]?.label).toBe("Part 1");
  });
});

describe("presentation fold: steps", () => {
  const steps = (): ComponentNode =>
    form([
      {
        id: "wizard",
        type: "steps",
        configuration: {},
        children: {
          content: [
            { id: "one", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
            { id: "two", type: "step", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } },
            { id: "three", type: "step", configuration: { label: "Done" }, children: { content: [{ id: "ok", type: "checkbox", configuration: { label: "OK" } }] } }
          ]
        }
      }
    ]);

  it("names each step, marks its status and words the progress line, Back and Continue", async () => {
    const store = new FormStateStore("en");
    const state = store.snapshot();
    state.navigation.currentStepId = "two";
    state.navigation.visitedSteps.add("one");
    state.navigation.completedSteps.add("one");
    const tree = await fold(steps(), {}, {}, state);
    const node = find(tree.nodes, "steps", "wizard") as PresentationSteps;
    expect(node.steps.map((step) => [step.id, step.label, step.status, step.statusText, step.tag, step.shown])).toEqual([
      ["one", "About you", "completed", "completed", "Step 1 of 3", false],
      ["two", "Step 2", "active", "", "Step 2 of 3", true],
      ["three", "Done", "upcoming", "not completed", "Step 3 of 3", false]
    ]);
    expect(node).toMatchObject({ activeStepId: "two", progress: "Step 2 of 3", back: { stepId: "one", label: "Back" }, next: { stepId: "three", label: "Continue" } });
    expect(shape(tree.nodes)).toEqual([{ "steps:wizard": [{ one: ["name"] }, { two: ["city"] }, { three: ["ok"] }] }]);
    expect(tree.fields.find((field) => field.id === "city")?.reveal).toEqual([{ kind: "step", stepsId: "wizard", stepId: "two" }]);
  });

  it("shows every step and offers no Back or Continue in a review", async () => {
    const root = steps();
    const state = new FormStateStore("en").snapshot();
    const output = await buildRenderOutput({ mode: "readonly", root, state, resolver, componentTree: new ComponentTree(root) });
    const node = find(foldPresentation(output, { locale: "en" }).nodes, "steps", "wizard");
    expect(node.steps.every((step) => step.shown)).toBe(true);
    expect(node.back).toBeUndefined();
    expect(node.next).toBeUndefined();
  });

  it("heads a step outside a steps container with its label, else its id, as the markup does", async () => {
    const tree = await fold(form([{ id: "lone", type: "step", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] } }]));
    expect(find(tree.nodes, "group", "lone") as PresentationGroup).toMatchObject({ base: "step", legend: "lone" });
  });
});

describe("presentation fold: data grids", () => {
  const grid = (configuration: Record<string, unknown> = {}): ComponentNode => ({
    id: "kids",
    type: "dataGrid",
    configuration: { label: "Children", ...configuration },
    collection: { collectionPath: "kids" },
    children: {
      content: [
        { id: "given", type: "text", configuration: { label: "Given name", required: true } },
        { id: "age", type: "number", configuration: {} }
      ]
    }
  });

  function runtimeOf(node: ComponentNode, translations?: FormTranslations): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    const definition: FormDefinition = {
      ...(translations ? { translations } : {}),
      id: "f1",
      version: "1",
      schemaVersion: "1",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
      root: { id: "root", type: "form", configuration: {}, children: { content: [node] } }
    };
    return new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(definition.root))])
    });
  }

  async function foldRuntime(rt: FormRuntime, mode: RenderMode = "interactive", options: Partial<PresentationFoldOptions> = {}) {
    const output = await buildRuntimeRenderOutput(rt, mode);
    return foldPresentation(output, { locale: rt.state().locale, translations: rt.translations(), ...options });
  }

  it("fills the row label everywhere, spaces inside the braces included, and hands each row's fields its label", async () => {
    const rt = runtimeOf(grid({ rowLabel: "Child {{ n }}" }));
    rt.setValues({ "kids[0].given": "Ada", "kids[1].given": "Bo" });
    const tree = await foldRuntime(rt);
    const node = find(tree.nodes, "grid", "kids") as PresentationGrid;
    expect(node.rows.map((row) => [row.key, row.label])).toEqual([
      ["kids#row-1", "Child 1"],
      ["kids#row-2", "Child 2"]
    ]);
    const rowFields = tree.fields.filter((field) => field.model.row !== undefined);
    expect(rowFields.map((field) => [field.model.valuePath, field.rowLabel])).toEqual([
      ["kids[0].given", "Child 1"],
      ["kids[0].age", "Child 1"],
      ["kids[1].given", "Child 2"],
      ["kids[1].age", "Child 2"]
    ]);
    // Each row's copy is its own instance.
    expect(new Set(rowFields.map((field) => field.key)).size).toBe(4);
    expect(node.columns.map((column) => [column.id, column.label, column.required])).toEqual([
      ["given", "Given name", true],
      // A column whose component has no label of its own heads with nothing, never its id.
      ["age", "", false]
    ]);
  });

  it("words the row label and the captions in the form's language, else the form texts", async () => {
    const translations: FormTranslations = {
      fr: {
        components: {
          kids: {
            rowLabel: { text: "Enfant {{n}}", source: sourceHash("Child {{n}}") },
            addLabel: { text: "Ajouter un enfant", source: sourceHash("Add a child") }
          }
        }
      }
    };
    const rt = runtimeOf(grid({ rowLabel: "Child {{n}}", addLabel: "Add a child" }), translations);
    rt.setValues({ "kids[0].given": "Ada" });
    const english = find((await foldRuntime(rt)).nodes, "grid", "kids");
    expect(english.rows[0]?.label).toBe("Child 1");
    expect(english.captions).toMatchObject({ add: "Add a child", remove: "Remove", moveUp: "Move up", moveDown: "Move down" });
    rt.setLocale("fr");
    const french = find((await foldRuntime(rt)).nodes, "grid", "kids");
    expect(french.rows[0]?.label).toBe("Enfant 1");
    expect(french.captions.add).toBe("Ajouter un enfant");
    // No rowLabel: the form text's.
    const plain = runtimeOf(grid());
    plain.setValues({ "kids[0].given": "Ada" });
    expect(find((await foldRuntime(plain)).nodes, "grid", "kids").rows[0]?.label).toBe("Row 1");
  });

  it("says which row buttons can be pressed, by the bounds, and none in a review or while locked", async () => {
    const rt = runtimeOf(grid({ canReorder: true, minRows: 1, maxRows: 2 }));
    rt.setValues({ "kids[0].given": "Ada", "kids[1].given": "Bo" });
    const node = find((await foldRuntime(rt)).nodes, "grid", "kids");
    expect(node.actions).toEqual({ add: true, remove: true, reorder: true });
    expect(node.canAdd).toBe(false);
    expect(node.rows.map((row) => [row.canRemove, row.canMoveUp, row.canMoveDown])).toEqual([
      [true, false, true],
      [true, true, false]
    ]);
    expect(node).toMatchObject({ layout: "auto", showHeader: true, showRowNumbers: true, minRows: 1, maxRows: 2 });
    const review = find((await foldRuntime(rt, "readonly")).nodes, "grid", "kids");
    expect(review.actions).toEqual({ add: false, remove: false, reorder: false });
    expect(review.rows.every((row) => !row.canRemove && !row.canMoveUp && !row.canMoveDown)).toBe(true);
    // The runtime's bounds win over the configuration's.
    const widened = find((await foldRuntime(rt, "interactive", { dataGridRowBounds: { kids: { minRows: 0, maxRows: 5 } } })).nodes, "grid", "kids");
    expect(widened.canAdd).toBe(true);
  });

  it("keys rows and their cells by the entry's stable key, so a removal leaves each key with its row", async () => {
    const rt = runtimeOf(grid());
    rt.setValues({ "kids[0].given": "Ann", "kids[1].given": "Bob" });
    const keysOf = async () => {
      const node = find((await foldRuntime(rt)).nodes, "grid", "kids");
      return node.rows.map((row) => ({
        row: row.key,
        cell: row.cells[0]?.children[0]?.key,
        value: (row.cells[0]?.children[0] as { model: { value: unknown } }).model.value
      }));
    };
    const before = await keysOf();
    expect(new Set(before.flatMap((entry) => [entry.row, entry.cell])).size).toBe(4);
    expect(before.every((entry) => !/\[\d+\]/.test(`${entry.row}${entry.cell}`))).toBe(true);
    rt.removeRow("kids", 0);
    const after = await keysOf();
    expect(after).toEqual([{ ...before[1] }]);
    expect(after[0]?.value).toBe("Bob");
  });

  it("puts a cell error no drawn row owns under the grid, worded", async () => {
    const rt = runtimeOf(grid());
    rt.setValues({ "kids[0].given": "Ada" });
    const output = await buildRuntimeRenderOutput(rt, "interactive");
    // An index-free path on a template field: the grid's, not a row's.
    const errors: FormError[] = [{ id: "e1", code: "required", componentId: "given", path: parseComponentPath("kids.given"), stage: "field", source: "client" }];
    const root = rt.formRoot();
    const withError = await buildRenderOutput({ mode: "interactive", root, state: rt.state(), resolver, errors, componentTree: new ComponentTree(root) });
    expect(find(foldPresentation(output, { locale: "en" }).nodes, "grid", "kids").errorMessages).toEqual([]);
    expect(find(foldPresentation(withError, { locale: "en" }).nodes, "grid", "kids").errorMessages).toEqual(["This field is required"]);
  });

  it("folds a repeating section as a stacked grid", async () => {
    const rt = runtimeOf({
      id: "people",
      type: "container",
      configuration: { label: "People" },
      collection: { collectionPath: "people" },
      children: { content: [{ id: "who", type: "text", configuration: { label: "Who" } }] }
    });
    rt.setValues({ "people[0].who": "Ada" });
    const node = find((await foldRuntime(rt)).nodes, "grid", "people");
    expect(node).toMatchObject({ base: "container", layout: "stacked", legend: "People" });
    expect(node.rows.map((row) => row.label)).toEqual(["Row 1"]);
  });
});

describe("presentation fold: journeys", () => {
  const root = (): ComponentNode =>
    form([
      { id: "intro", type: "html", configuration: { content: "<p>Welcome</p>" } },
      {
        id: "you",
        type: "fieldset",
        configuration: { label: "You" },
        children: {
          content: [
            { id: "name", type: "text", configuration: { label: "Your name" } },
            { id: "email", type: "text", configuration: { label: "Email" } }
          ]
        }
      },
      {
        id: "where",
        type: "grid",
        configuration: { columns: 2 },
        children: {
          column_1: [{ id: "city", type: "text", configuration: { label: "City" } }],
          column_2: [{ id: "postcode", type: "text", configuration: { label: "Postcode" } }]
        }
      },
      { id: "send", type: "button", configuration: { label: "Send", action: "submit" } }
    ]);

  const JOURNEY: Journey = {
    id: "apply",
    progress: "count",
    texts: { continue: "Next", back: "Previous" },
    pages: [
      { id: "who", components: ["email", "name"] },
      { id: "place", title: "Where you live", description: "Your home address", components: ["where"], texts: { continue: "Save and continue" } },
      { id: "done", title: "Finish", components: ["send"] }
    ]
  };

  function view(pageId: string): JourneyView {
    const index = JOURNEY.pages.findIndex((page) => page.id === pageId);
    const page = JOURNEY.pages[index]!;
    const path = JOURNEY.pages.map((entry) => entry.id);
    return {
      journeyId: JOURNEY.id,
      journey: JOURNEY,
      pageId,
      page,
      kind: page.kind ?? "questions",
      path,
      index,
      total: path.length,
      number: index + 1,
      completed: path.slice(0, index),
      frontierPageId: pageId,
      ...(index > 0 ? { backPageId: path[index - 1]! } : {}),
      final: index === path.length - 1,
      end: "end",
      members: journeyPageFormIds(page),
      pageOf: {},
      validation: { continue: "page", server: false, onUnavailable: "block" }
    };
  }

  it("folds a journey page into one page node: its words from the journey's and the page's texts, its components alone", async () => {
    const tree = await fold(root(), {}, { journey: view("place") });
    expect(tree.page).toBe(tree.nodes[0]);
    expect(tree.page).toMatchObject({
      kind: "page",
      id: "place",
      title: "Where you live",
      description: "Your home address",
      progress: "Step 2 of 3",
      heading: "shown",
      back: { pageId: "who", label: "Previous" },
      action: { kind: "continue", label: "Save and continue" }
    });
    expect(shape(tree.nodes)).toEqual([{ "page:place": [{ "group:where": ["city", "postcode"] }] }]);
    // The page's texts word everything on it, a tab or a row heading included.
    expect(tree.text("continue")).toBe("Save and continue");
  });

  it("draws the members in the page's order, lifted out of the section holding them", async () => {
    const tree = await fold(root(), {}, { journey: view("who") });
    expect(shape(tree.nodes)).toEqual([{ "page:who": ["email", "name"] }]);
    expect(tree.page?.back).toBeUndefined();
    expect(tree.page?.action).toEqual({ kind: "continue", label: "Next" });
  });

  it("offers no Submit on a last page holding its own submit button", async () => {
    const tree = await fold(root(), {}, { journey: view("done") });
    expect(tree.page?.journey?.final).toBe(true);
    expect(tree.page?.action).toBeUndefined();
    expect(shape(tree.nodes)).toEqual([{ "page:done": ["send"] }]);
  });

  it("draws the form whole under the Noop kit", async () => {
    const output = await buildRenderOutput({ mode: "interactive", root: root(), state: new FormStateStore("en").snapshot(), resolver, journeyKit: NoopJourneyRenderKit, journey: view("who") });
    const tree = foldPresentation(output, { locale: "en", journeyKit: NoopJourneyRenderKit });
    expect(tree.page).toBeUndefined();
    expect(tree.nodes.map((node) => node.id)).toEqual(["intro", "you", "where", "send"]);
  });

  it("folds a printed journey's path into one page per entry, each component once, members nested anywhere included", async () => {
    const output = await buildRenderOutput({ mode: "readonly", root: root(), state: new FormStateStore("en").snapshot(), resolver });
    const tree = foldPresentation(output, {
      locale: "en",
      pages: [
        { pageId: "who", title: "You", members: ["name", "email"] },
        { pageId: "place", title: "Where you live", members: ["where", "name"] }
      ]
    });
    expect(shape(tree.nodes)).toEqual([{ "page:who": ["name", "email"] }, { "page:place": [{ "group:where": ["city", "postcode"] }] }]);
    expect(find(tree.nodes, "group", "where").level).toBe(2);
  });
});

