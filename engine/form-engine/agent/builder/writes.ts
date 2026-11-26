/**
 * The builder's seven write tools:
 * `add_components`, `replace_form`, `set_properties`, `rename_component`, `move_component`,
 * `remove_components`, `duplicate_component`.
 *
 * Every write is checked in full before anything happens (the ids, the slots, the inspector's
 * blockers, the formulas, the data paths, the structure limits), then yields to the person
 * (their open prompt, their unsaved edit, a designer, Try it), then goes
 * through the controller's guarded `request*` method where one exists. Where none does
 * (`setProperties`, `renameId`) the tool reproduces the guard's visible behaviour itself: the
 * pre-checks and an `unsaved-draft` refusal, no prompt raised, nothing held (the consequential-action guard). A request that still answers `false` (the person's edit appeared in
 * between) is answered `stay` and refused: no tool ever leaves a held action behind.
 *
 * Each write is one undo step (two or more only for `remove_components { removeReferences }`,
 * one per component, as the controller records it), counted by the shared writing guard, shown
 * to the person (selection, reveal, highlight, announcement, a notice with Undo)
 * and reported with `undo`, `shown` and `session`. A refusal changes nothing: the tree, the
 * history and the revision are as they were, and an error the controller set on the strip
 * (`dropError`, `idError`) is cleared again so the person sees no stale message.
 *
 * Titles, descriptions and schemas are the documented strings byte for byte; nothing in them is built from the form.
 */
import { kernelStructureLimits, kernelStructureNameMax, kernelStructureVersionMax } from "../../core/expressions/definition-structure.js";
import type { FormulaPathRef } from "../../core/expressions/formula-types.js";
import { componentIdProblem, isValidComponentId } from "../../core/tree/component-id.js";
import { dataKeyProblemOf } from "../../core/tree/data-scope.js";
import { readFormChromePart } from "../../core/schema/form-chrome.js";
import { newlyRepeatedChromeId } from "../../builder/controller/translation-rules.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderMoveTarget, BuilderMoveToResult, InsertComponentsResult } from "../../builder/controller/builder-controller.js";
import { dependentLines, type Dependent } from "../../builder/controller/dependents.js";
import { applyBlockers } from "../../builder/property-editor/inspector-model.js";
import { canAcceptInSlot } from "../../builder/tree-editor/slot-constraints.js";
import { ToolRefusal, type AgentTool, type ToolContext } from "../tool-types.js";
import {
  blockedRefusal,
  dataPathRefusal,
  defaultSlotOf,
  findNode,
  firstFailure,
  newDataProblems,
  planComponents,
  slotIdsOf,
  slotRefusal,
  slotResolver,
  structureProblem,
  structureRefusal,
  subtreeIds,
  subtreeNodes,
  type ComponentPlan
} from "./components.js";
import { draftRefusal, type BuilderCallScope, type BuilderToolsShared } from "./context.js";
import { formulaWarning } from "./formulas.js";
import { isRootPrintPath, rootPrintControl, rootPrintValueProblem } from "./print-settings.js";
import { planFromData, usesFromData, type FromDataPlan } from "./from-data.js";
import type { BuilderToolHost } from "./host.js";
import { dataPathsOf, labelsOf } from "./outline.js";
import { badInput, isRecord, kindValue, type KindedValue, parsePropertyPath, pathKind, type ParsedPath, prototypeKeyIn, prototypeRefusal, readPath, sameValue, tooLarge, writePath } from "./properties.js";
import { builderHandleProperty } from "./reads.js";
import type {
  AddComponentsResult,
  ComponentProblem,
  IdentityChange,
  DuplicateComponentResult,
  FormulaProblem,
  MoveComponentResult,
  MoveTargetRef,
  RemoveComponentsResult,
  RenameComponentResult,
  ReplaceFormResult,
  SetPropertiesResult,
  TestAffected,
  ToolFields
} from "./types.js";

type Input = Record<string, unknown>;
type Tool = AgentTool<Input, BuilderToolHost>;
type Ctx = ToolContext<BuilderToolHost>;

/** `add_components` and `replace_form` take a whole tree: 512 KB of input. */
const SPEC_INPUT_BYTES = 524_288;
const MAX_EDITS = 200;
const MAX_EDIT_VALUE_BYTES = 65_536;
const MAX_REMOVE = 500;
const MAX_KEEP = 100;
const MOVE_TARGETS_CAP = 50;

/** `fromData` and `readAs` on `add_components` and `replace_form`. */
const FROM_DATA_DESCRIPTION =
  'Instead of components: a JSON sample of the answers this form should collect (an object, e.g. {"name": "Ada", "items": [{"sku": "A1", "qty": 2}]}) or a JSON Schema, as an object or as JSON text. A field is generated for every place, under the matching container.';
const READ_AS_DESCRIPTION = "With fromData: how to read it. auto (default) decides by the $schema, type or properties keywords.";
const FROM_DATA_NEXT = ["Review the generated labels, required flags and options with get_form, then adjust with set_properties.", "Run check_form before you say the form is done."];
const FROM_DATA_NOTHING = "The form already has a field for every place in the data; nothing was added.";
/** The form root's settings that hold a whole object (never text or a number). */
const ROOT_OBJECT_SETTINGS: ReadonlySet<string> = new Set(["chrome", "messages", "print", "print.header", "print.footer"]);

// When the plan is empty because the missing places were skipped, not because the form holds them.
const FROM_DATA_NOTHING_SKIPPED = "Nothing was added: the places the form lacks were skipped; see dataModel.skipped.";
const FROM_DATA_NOTHING_REPLACE = "The data describes no place a field can hold; the form was left as it is.";

const EXPECTED_REVISION = {
  type: "integer",
  minimum: 1,
  description: "Optional. The revision from your last result; the call is refused with code 'stale' if the form changed since, so you can re-read before writing."
};

/** The root configuration key the author owns (`readAgentToolsSetting` reads it; set_properties refuses it). */
const AGENT_TOOLS_KEY = "agentTools";

/** The three parts of a form's identity `set_properties { target: "identity" }` writes. */
const IDENTITY_FIELDS = ["id", "version", "schemaVersion"] as const;
type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** What a refusal over the author's switch tells the model to relay; `history` says the same when a step moved the key. */
export const AUTHOR_SWITCH_HINT = "Whether assistants may fill this form is the author's choice in Form settings; tell the person.";

/**
 * `protected-setting`: `by: "host"` for a
 * path the site manages or an identity the host owns, `by: "author"` for `agentTools`, the form author's
 * own switch for assistants.
 */
function protectedRefusal(propertyPath: string, by: "host" | "author"): ToolRefusal {
  if (by === "author") {
    return new ToolRefusal(
      "protected-setting",
      `${propertyPath} is the form author's switch for assistants; nothing was written.`,
      AUTHOR_SWITCH_HINT,
      { propertyPath, by }
    );
  }
  return new ToolRefusal("protected-setting", `${propertyPath} is managed by the site; nothing was written.`, "The site manages this setting; tell the person.", { propertyPath, by });
}

/**
 * The first path the site manages that `nodes`, or a component they hold, sets. A component an
 * assistant adds, rebuilds the form with or copies writes every setting it carries, so a
 * managed one is refused there as set_properties refuses it.
 * A path under `rules` reads the component's rules; any other, its configuration.
 */
function managedPathIn(managed: readonly string[], nodes: readonly ComponentNode[]): string | undefined {
  if (managed.length === 0) {
    return undefined;
  }
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    for (const path of managed) {
      const value = path === "rules" || path.startsWith("rules.") ? readPath({ rules: node.rules }, path) : readPath(node.configuration, path);
      if (value !== undefined) {
        return path;
      }
    }
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...group);
    }
  }
  return undefined;
}

/** How many parts a header or footer holds, groups counted with what they hold. */
function partCount(part: unknown): number {
  if (!isRecord(part)) {
    return 1;
  }
  return part.type === "group" && Array.isArray(part.parts) ? 1 + part.parts.reduce<number>((sum, inner) => sum + partCount(inner), 0) : 1;
}

/** The same count of what the renderer's reader keeps of one authored part. */
function keptCount(part: unknown): number {
  const kept = readFormChromePart(part);
  if (kept === undefined) {
    return 0;
  }
  return kept.type === "group" ? 1 + kept.parts.reduce<number>((sum, inner) => sum + keptCount(inner), 0) : 1;
}

/** What is wrong with a header or footer value: a part the renderer would drop without a word (an unknown type, a group in a group, no `id`), or no list at all. */
function chromeRegionProblem(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return "A header or footer is a list of parts.";
  }
  const dropped = value.findIndex((part) => partCount(part) !== keptCount(part));
  return dropped >= 0 ? `Part ${dropped} has an unknown type, no id, or a group inside a group.` : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `cancelled` when the caller's signal fired before the controller call: nothing was changed. */
function checkSignal(ctx: Ctx): void {
  if (ctx.signal.aborted) {
    throw new ToolRefusal("cancelled", "The call was cancelled before anything changed.", "The call was cancelled; call describe_builder before retrying.", {});
  }
}

function rootRefusal(scope: BuilderCallScope, verb: string): ToolRefusal {
  const rootId = scope.controller.rootId();
  return new ToolRefusal(
    "root-component",
    `The form root cannot be ${verb}.`,
    `The root is the form itself: replace_form changes its contents, set_properties { componentId: '${rootId}' } its settings.`,
    {}
  );
}

function fixedRefusal(componentId: string): ToolRefusal {
  return new ToolRefusal("fixed-component", `"${componentId}" is fixed by the host.`, "This component is fixed by the host (a PDF template field); change its properties instead.", { componentId });
}

function internalRefusal(message: string): ToolRefusal {
  return new ToolRefusal("internal", message, "Call get_form before continuing.", {});
}

/** A node the write was placing, with where it was headed: what a slot refusal names (`slot-refused`). */
interface PlacedEntry {
  node: ComponentNode;
  parentId: string;
  slotId?: string | undefined;
}

/**
 * The child and parent a controller's slot message is about. The controller words its own
 * check as `<child> cannot go in <parent>: <reason>.` (BC `subtreeSlotProblem`); the tree
 * editor's thrown sentences name no ids, so a write of one entry stands for itself and a write
 * of several cannot be told apart (the generic mapping then).
 */
function slotSubject(message: string, placed: readonly PlacedEntry[]): { parentId: string; slotId?: string | undefined; child: ComponentNode; reason: string } | undefined {
  const named = /^"?([^\s":]+)"? cannot go in "?([^\s":]+)"?: (.+)$/.exec(message);
  if (named !== null) {
    for (const entry of placed) {
      const child = subtreeNodes(entry.node).find((node) => node.id === named[1]);
      if (child !== undefined) {
        return { parentId: named[2] as string, ...(child === entry.node ? { slotId: entry.slotId } : {}), child, reason: named[3] as string };
      }
    }
  }
  const only = placed.length === 1 ? placed[0] : undefined;
  return only !== undefined ? { parentId: only.parentId, slotId: only.slotId, child: only.node, reason: message } : undefined;
}

/**
 * A controller message as the code the tools map it to (by wording): ids, the
 * journey's claim, a slot, a data place; anything else is `refused` with the text. A slot
 * message is worded as the tool's own `slot-refused` (its hint, `parentId`, `childType`) when
 * the entries the write was placing name its subject.
 */
function controllerRefusal(scope: BuilderCallScope, message: string, placed: readonly PlacedEntry[] = []): ToolRefusal {
  if (/cannot be a component id/.test(message)) {
    return new ToolRefusal("invalid-id", message, "Use a letter, then letters, digits, _ or -, at most 128 characters; or omit id to have one generated.", { id: /"([^"]*)"/.exec(message)?.[1] ?? "" });
  }
  if (/page-only field of a journey/.test(message)) {
    return new ToolRefusal("duplicate-id", message, "A journey page-only field owns this id; pick another.", { id: /"([^"]*)"/.exec(message)?.[1] ?? "", claimed: true });
  }
  if (/is already used|already exists/.test(message)) {
    return new ToolRefusal("duplicate-id", message, "Pick another id or omit it.", { id: /"([^"]*)"/.exec(message)?.[1] ?? "" });
  }
  if (/cannot go in|does not take children|is not allowed in slot|does not allow multiple|reached max/.test(message)) {
    const subject = slotSubject(message, placed);
    if (subject !== undefined) {
      return slotRefusal(scope, subject.parentId, subject.slotId, subject.child, subject.reason.replace(/\.$/, ""));
    }
    return new ToolRefusal("slot-refused", message, "Call list_component_types to see which slots take the component, or get_component for where it may go.", { reason: message, accepting: [] });
  }
  if (/would store their answers in one place|cannot be stored at/.test(message)) {
    return new ToolRefusal("data-path-conflict", message, "Change dataKey on one of the components named, or move it to another container.", {
      problems: scope.controller.dataKeyProblems().map((problem) => ({ ...problem, componentIds: [...problem.componentIds] }))
    });
  }
  return new ToolRefusal("refused", message, "Read message; it names the component and the reason. Call get_form if unsure.", { message });
}

/** `problemsOf` for each id plus the data-place problems that name one (`problems`). */
function componentProblems(scope: BuilderCallScope, ids: readonly string[]): ComponentProblem[] {
  const controller = scope.controller;
  const wanted = new Set(ids);
  const out: ComponentProblem[] = [];
  for (const id of ids) {
    for (const problem of controller.problemsOf(id)) {
      out.push({ componentId: id, target: problem.target, message: problem.message, severity: "error", source: problem.target === "dataKey" ? "data-key" : "builder" });
    }
  }
  for (const problem of controller.dataKeyProblems()) {
    for (const componentId of problem.componentIds) {
      if (wanted.has(componentId) && !out.some((known) => known.componentId === componentId && known.target === "dataKey")) {
        out.push({ componentId, target: "dataKey", message: problem.message, severity: "error", source: "data-key" });
      }
    }
  }
  return out;
}

/** The component's label as the outline words it (its id when it has none), read after the write. */
function labelOf(scope: BuilderCallScope, id: string): string {
  return labelsOf(scope).get(id) ?? id;
}

/** The `added` rows from the tree as the write left it. */
function addedRows(scope: BuilderCallScope, allIds: readonly string[]): AddComponentsResult["added"] {
  const controller = scope.controller;
  const paths = dataPathsOf(scope);
  const root = controller.snapshot();
  return allIds.map((id) => {
    const node = findNode(root, id);
    const place = controller.parentOf(id);
    const row: AddComponentsResult["added"][number] = {
      id,
      type: node?.type ?? "",
      label: labelOf(scope, id),
      parentId: place?.parentId ?? "",
      slotId: place?.slotId ?? "",
      index: place?.index ?? 0
    };
    const path = paths.get(id);
    if (path !== undefined) {
      row.path = path;
    }
    return row;
  });
}

/** The `next` sentence for tests that still name removed ids (at most one sentence). */
function testsNext(affected: readonly TestAffected[]): string[] {
  if (affected.length === 0) {
    return [];
  }
  const ids = affected.map((test) => test.id);
  return [`${ids.join(", ")} still ${ids.length === 1 ? "mentions" : "mention"} removed ids: rewrite ${ids.length === 1 ? "it" : "them"} with write_test or remove ${ids.length === 1 ? "it" : "them"} with remove_test.`];
}

/** The result fields of a planned add or replace (a dry run reports where things would land). */
function plannedFields(plan: ComponentPlan, dryRun: boolean): Omit<ToolFields<AddComponentsResult>, "undo" | "next"> {
  return {
    dryRun,
    ids: [...plan.ids],
    allIds: [...plan.allIds],
    generatedIds: { ...plan.generatedIds },
    added: plan.rows.map((row) => ({ ...row })),
    lints: plan.lints.map((lint) => ({ ...lint })),
    problems: []
  };
}

/** A component spec's schema in `add_components`. */
function addSpecSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["type"],
    properties: {
      type: {
        type: "string",
        description:
          "Component type id from list_component_types (text, number, select, checkbox, checkboxes, radio, textarea, date, file, fieldset, panel, tabs, steps, step, grid, data-grid, button-group, button, html, image, …)."
      },
      id: { type: "string", maxLength: 128, description: "Stable id: a letter, then letters, digits, _ or -; unique in the form. Leave it out to have one generated from the type." },
      label: { type: "string", description: "The label the person sees. Give one for every field." },
      description: { type: "string", description: "Help text under the label." },
      required: { type: "boolean", description: "Fields only." },
      dataKey: { type: "string", description: "Stored name when it must differ from the id. Usually leave it out." },
      placeholder: { type: "string" },
      options: {
        type: "array",
        items: { description: '"Sales" or { "value": "sales", "label": "Sales" }' },
        description: "For select, radio, checkboxes: strings or { value, label } pairs. Values derived from strings are reported in warnings."
      },
      configuration: {
        type: "object",
        description: "Any other property, by the names get_component or list_component_types (detail full) show: rows, min, max, pattern, keyboard, action, tabs, columns, data.sourceId, …"
      },
      rules: {
        type: "object",
        description: "FEEL text per rule key. Field ids are bare names; and/or/not(); = compares; strings in double quotes.",
        properties: {
          visibleWhen: { type: "string" },
          requiredWhen: { type: "string" },
          enabledWhen: { type: "string" },
          readonlyWhen: { type: "string" },
          validWhen: { type: "string", description: "Must hold for the answer to be valid." },
          value: { type: "string", description: "Calculation: the field's value is this formula." },
          defaultValue: { type: "string" },
          minRows: { type: "string", description: "data-grid only." },
          maxRows: { type: "string", description: "data-grid only." }
        }
      },
      collection: { type: "object", description: "Row binding for repeating containers: { collectionPath?, itemFields?, operations? }." },
      children: { type: "array", items: { type: "object" }, description: "For containers: entries of this same shape, placed in the container's default slot (content, or its first slot)." },
      slots: { type: "object", description: "For tabs and grid: slot id (a tab id, column_1, …) to an array of entries of this same shape." },
      parentId: { type: "string", description: "Top-level entries only: the container to add into. Leave it out for the form root." },
      slotId: { type: "string", description: "Top-level entries only: the parent's slot; leave it out for its default slot." },
      index: { type: "integer", minimum: 0, description: "Top-level entries only: position among the parent's children; leave it out to append (before an untouched Submit button at the end)." }
    }
  };
}

/** A component spec's schema in `replace_form`. */
function replaceSpecSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["type"],
    properties: {
      type: { type: "string" },
      id: { type: "string", maxLength: 128 },
      label: { type: "string" },
      description: { type: "string" },
      required: { type: "boolean" },
      dataKey: { type: "string" },
      placeholder: { type: "string" },
      options: { type: "array" },
      configuration: { type: "object" },
      rules: { type: "object" },
      collection: { type: "object" },
      children: { type: "array", items: { type: "object" } },
      slots: { type: "object" }
    }
  };
}

export function writeTools(shared: BuilderToolsShared): AgentTool<Record<string, unknown>, BuilderToolHost>[] {
  const host = shared.host;

  /** The paths the site manages, as set_properties reads them. */
  const managedPaths = (): string[] => (host.ui?.managedSettings?.() ?? []).map((path) => String(path).trim()).filter((path) => path !== "");

  /** Throws set_properties' refusal when `nodes` set a path the site manages ({@link managedPathIn}). */
  const refuseManaged = (nodes: readonly ComponentNode[]): void => {
    const path = managedPathIn(managedPaths(), nodes);
    if (path !== undefined) {
      throw protectedRefusal(path, "host");
    }
  };

  /** Runs one controller call under the writing guard; a request that answered false is refused. */
  const guarded = (scope: BuilderCallScope, run: () => boolean): number => {
    const { value: ran, steps } = shared.write(scope, run);
    shared.requestOrRefuse(scope, ran);
    return steps;
  };

  /** A write the controller refused (its onResult said no): the strip's error cleared, the mapped refusal thrown. */
  const refusedByController = (scope: BuilderCallScope, message: string | undefined, fallback: string, placed: readonly PlacedEntry[]): never => {
    scope.controller.dropError = undefined;
    throw controllerRefusal(scope, message ?? fallback, placed);
  };

  /**
   * Yields to the person before a tree write that goes through a `request*` method. The
   * controller's guard holds such a request on the *selected* component's draft, and the
   * selected component may be the root (the Form panel open on it): the tree writes'
   * check leaves the root's draft out of the tree writes' check, but the request would then raise the
   * Save / Discard / Stay prompt, which no write may do. So a selected root with a draft is
   * refused here, the same way and without the prompt. The prompt check stays
   * first among the person's-state checks: with one up, `yieldToPerson` refuses it.
   */
  const yieldForRequest = (scope: BuilderCallScope, kind: "tree" | "remove", vanishing?: ReadonlySet<string>): void => {
    const controller = scope.controller;
    const root = controller.rootId();
    if (controller.unsavedChangesPrompt() === undefined && controller.selectedComponentId() === root && controller.hasPendingChanges(root)) {
      throw draftRefusal(root);
    }
    shared.yieldToPerson(scope, kind, vanishing !== undefined ? { vanishing } : {});
  };

  // ---- fromData ---------------------------------------------------

  /** The plan's own fields plus the report; `added` stays the rows (read from the tree after a write). */
  const dataFields = (data: FromDataPlan, dryRun: boolean): Omit<ToolFields<AddComponentsResult>, "undo" | "next"> => ({
    ...plannedFields(data.plan, dryRun),
    changed: !dryRun && !data.empty,
    dataModel: structuredClone(data.report)
  });

  /** `add_components { fromData }`: the missing places, as the Data workspace's Add missing fields would add them. */
  const addFromData = async (input: Input, ctx: Ctx): Promise<Record<string, unknown>> => {
    const scope = shared.scope(ctx);
    const controller = scope.controller;
    const data = await planFromData(shared, scope, input, "add");
    checkSignal(ctx);
    const dryRun = input.dryRun === true;
    if (data.empty) {
      const result: ToolFields<AddComponentsResult> = { ...dataFields(data, dryRun), next: [], ...shared.payload(scope, 0) };
      return { ...result, note: [data.report.skipped.length > 0 ? FROM_DATA_NOTHING_SKIPPED : FROM_DATA_NOTHING], warnings: data.plan.warnings } as unknown as Record<string, unknown>;
    }
    if (dryRun) {
      const result: ToolFields<AddComponentsResult> = { ...dataFields(data, true), next: [...FROM_DATA_NEXT], ...shared.payload(scope, 0) };
      return { ...result, warnings: data.plan.warnings } as unknown as Record<string, unknown>;
    }
    yieldForRequest(scope, "tree");
    checkSignal(ctx);
    let outcome: InsertComponentsResult | undefined;
    // The importer's own thunk: planned again from the tree as it stands when the insert runs.
    const steps = guarded(scope, () =>
      controller.requestInsertComponents(data.entries, {
        select: "none",
        onResult: (result) => {
          outcome = result;
        }
      })
    );
    if (outcome === undefined || !outcome.ok) {
      refusedByController(
        scope,
        outcome?.error,
        "The components could not be added.",
        data.plan.entries.map((entry) => ({ node: entry.node, parentId: entry.parentId ?? controller.rootId(), slotId: entry.slotId }))
      );
    }
    scope.cache.clear();
    const placed = (outcome as InsertComponentsResult).ids;
    const committed = controller.snapshot();
    const allIds = placed.flatMap((id) => {
      const node = findNode(committed, id);
      return node !== undefined ? subtreeIds(node) : [id];
    });
    const shown = shared.show(scope, {
      ...(input.select !== "none" && placed[0] !== undefined ? { select: placed[0] } : {}),
      ids: allIds,
      announce: scope.words.plural("agent.did.add", allIds.length, { count: allIds.length }),
      undoSteps: steps
    });
    const result: ToolFields<AddComponentsResult> = {
      ...dataFields(data, false),
      ids: [...placed],
      allIds,
      added: addedRows(scope, allIds),
      problems: componentProblems(scope, allIds),
      next: [...FROM_DATA_NEXT],
      ...shared.payload(scope, steps, shown)
    };
    return { ...result, warnings: data.plan.warnings } as unknown as Record<string, unknown>;
  };

  // ---- add_components ---------------------------------------------------------------------

  const addComponents: Tool = {
    name: "add_components",
    title: "Add components",
    description:
      "Adds one or more components to the form in a single undo step, nesting children under containers; this is how to build a form or a section from a description. Give each a type and a label; optionally an id, required, options (strings or {value,label}), rules as FEEL text, configuration for anything else, and children. Leave parentId out to append at the end of the form (before its Submit button). Instead of components you can pass fromData, a JSON sample of the answers or a JSON Schema: a field is added for every place the form does not have yet, as the Data workspace's Import does. Set dryRun true to check everything and see what would be added without changing the form. Returns the new ids.",
    inputSchema: {
      type: "object",
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: { ...EXPECTED_REVISION },
        components: {
          type: "array",
          description: "Give this or fromData. Components to add, in order: at least one, at most 500 top-level and 2 000 counting nested ones. Nest with children (default slot) or slots (named slots).",
          items: addSpecSchema()
        },
        fromData: { description: FROM_DATA_DESCRIPTION },
        readAs: { type: "string", enum: ["auto", "sample", "schema"], description: READ_AS_DESCRIPTION },
        select: { type: "string", enum: ["first", "none"], description: "Whether the person's selection moves to the first added component (default first)." },
        dryRun: { type: "boolean", description: "Check ids, placement, data paths, formulas and limits; change nothing; return the ids that would be used." }
      }
    },
    annotations: {},
    inputBytes: SPEC_INPUT_BYTES,
    async execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      if (usesFromData(input)) {
        return addFromData(input, ctx);
      }
      const components = Array.isArray(input.components) ? input.components : [];
      if (components.length === 0) {
        throw badInput([{ key: "components", expected: "at least one component entry" }]);
      }
      const plan = planComponents(shared, scope, components, { kind: "add" });
      refuseManaged(plan.entries.map((entry) => entry.node));
      const next = ["Set more properties or rules with set_properties using these ids.", "Run check_form when you are done."];
      if (input.dryRun === true) {
        const result: ToolFields<AddComponentsResult> = { ...plannedFields(plan, true), next, ...shared.payload(scope, 0) };
        return { ...result, warnings: plan.warnings } as unknown as Record<string, unknown>;
      }
      yieldForRequest(scope, "tree");
      checkSignal(ctx);
      const select = input.select === "none" ? "none" : "first";
      let outcome: InsertComponentsResult | undefined;
      const steps = guarded(scope, () =>
        controller.requestInsertComponents(plan.entries, {
          select,
          onResult: (result) => {
            outcome = result;
          }
        })
      );
      if (outcome === undefined || !outcome.ok) {
        refusedByController(
          scope,
          outcome?.error,
          "The components could not be added.",
          plan.entries.map((entry) => ({ node: entry.node, parentId: entry.parentId ?? controller.rootId(), slotId: entry.slotId }))
        );
      }
      scope.cache.clear();
      const shown = shared.show(scope, {
        ...(select === "first" && plan.ids[0] !== undefined ? { select: plan.ids[0] } : {}),
        ids: plan.allIds,
        announce: scope.words.plural("agent.did.add", plan.allIds.length, { count: plan.allIds.length }),
        undoSteps: steps
      });
      const result: ToolFields<AddComponentsResult> = {
        ...plannedFields(plan, false),
        added: addedRows(scope, plan.allIds),
        problems: componentProblems(scope, plan.allIds),
        next,
        ...shared.payload(scope, steps, shown)
      };
      return { ...result, warnings: plan.warnings } as unknown as Record<string, unknown>;
    }
  };

  // ---- replace_form -----------------------------------------------------------------------

  const replaceForm: Tool = {
    name: "replace_form",
    title: "Replace the form's contents",
    description:
      "Replaces every component under the form root (or under one root slot) with the components you give, in one undo step; keep lists ids to leave in place (include the submit button's id to keep it). Use it to rebuild a form from a description; prefer add_components to extend an existing form. With fromData (a JSON sample of the answers or a JSON Schema) instead of components it rebuilds the form with one field per place, keeping the closing buttons. It removes every other existing component, so confirm with the person unless they asked for a rebuild. dryRun true only checks. Returns the new ids and the tests that still mention removed ids.",
    inputSchema: {
      type: "object",
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: { ...EXPECTED_REVISION },
        components: {
          type: "array",
          description: "Give this or fromData. The new contents, same shape as add_components entries (parentId, slotId and index are ignored here). An empty array empties the slot.",
          items: replaceSpecSchema()
        },
        fromData: { description: FROM_DATA_DESCRIPTION },
        readAs: { type: "string", enum: ["auto", "sample", "schema"], description: READ_AS_DESCRIPTION },
        keep: { type: "array", items: { type: "string" }, description: "Ids of existing top-level components to keep; they stay after the new ones (at most 100)." },
        slotId: { type: "string", description: "Which root slot to replace (default content)." },
        dryRun: { type: "boolean", description: "Check and report without writing." }
      }
    },
    annotations: { consequentialHint: true, untrustedContentHint: true },
    inputBytes: SPEC_INPUT_BYTES,
    async execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const fromData = usesFromData(input);
      // The kit load is the one await; the tree is read after it, so a plan and the lists below see one tree.
      const data = fromData && (stringOf(input.slotId) ?? "content") === "content" ? await planFromData(shared, scope, input, "replace") : undefined;
      if (fromData) {
        checkSignal(ctx);
      }
      const committed = controller.snapshot();
      const slotId = stringOf(input.slotId) ?? "content";
      const rootSlots = slotIdsOf(scope, committed);
      if (!rootSlots.includes(slotId)) {
        throw badInput([{ key: "slotId", expected: `a slot of the form root: ${rootSlots.join(", ") || "content"}` }]);
      }
      if (fromData && data === undefined) {
        throw badInput([{ key: "slotId", expected: "content, or left out: fromData rebuilds the form's content" }]);
      }
      const keepRaw = Array.isArray(input.keep) ? (input.keep as string[]) : [];
      const current = committed.children?.[slotId] ?? [];
      const keep = new Set<string>();
      // With fromData the list is not read (the ignored-keep warning below), so it is not checked either.
      if (data === undefined) {
        if (keepRaw.length > MAX_KEEP) {
          throw tooLarge("keep", MAX_KEEP, keepRaw.length);
        }
        for (const id of keepRaw) {
          if (!current.some((child) => child.id === id)) {
            throw shared.unknownComponent(scope, id);
          }
          keep.add(id);
        }
      }
      // With fromData the closing buttons are what stays (the importer's `keep`); a list given as well is not read.
      if (data !== undefined) {
        keep.clear();
        data.keep.forEach((id) => keep.add(id));
      }
      const components = Array.isArray(input.components) ? input.components : [];
      const plan = data !== undefined ? data.plan : planComponents(shared, scope, components, { kind: "replace", slotId, keep: [...keep] });
      if (data !== undefined && keepRaw.length > 0) {
        plan.warnings.push("ignored-keep: keep is not read with fromData; the form's closing buttons stay.");
      }
      // What stays is not written; what comes in is.
      refuseManaged([...plan.nodes, ...plan.entries.map((entry) => entry.node)]);
      const removedTop = current.filter((child) => !keep.has(child.id));
      const removedAll = removedTop.flatMap((child) => subtreeIds(child));
      const fresh = new Set(plan.allIds);
      const gone = removedAll.filter((id) => !fresh.has(id));
      const paths = dataPathsOf(scope);
      const testsAffected = shared.refs.testsMentioning(
        controller.tests(),
        gone,
        gone.map((id) => paths.get(id)).filter((path): path is string => path !== undefined)
      );
      // What outside the replaced content still reads it: the same plain filter as remove_components. A rule whose owner goes too vanishes with the content; a rule a kept component (or
      // one in another root slot) holds survives the replace and is reported, as journeys and
      // layouts are.
      const removedSet = new Set(removedAll);
      const outsideReferences: Dependent[] = [];
      for (const child of removedTop) {
        for (const dependent of controller.dependentsOf(child.id)) {
          if ((dependent.kind !== "rule" || !removedSet.has(dependent.componentId)) && !outsideReferences.some((known) => sameValue(known, dependent))) {
            outsideReferences.push(structuredClone(dependent));
          }
        }
      }
      const kept = current.filter((child) => keep.has(child.id)).map((child) => child.id);
      const extra = {
        removed: removedTop.map((child) => child.id),
        removedCount: removedAll.length,
        kept,
        testsAffected,
        outsideReferences
      };
      const next = data !== undefined ? [...FROM_DATA_NEXT] : ["Run check_form.", ...testsNext(testsAffected)].slice(0, 2);
      const withData = (fields: Omit<ToolFields<AddComponentsResult>, "undo" | "next">): Omit<ToolFields<AddComponentsResult>, "undo" | "next"> =>
        data !== undefined ? { ...fields, changed: fields.dryRun ? false : !data.empty, dataModel: structuredClone(data.report) } : fields;
      if (data !== undefined && data.empty) {
        // Data that describes no place would only empty the form: left as it is.
        const result: ToolFields<ReplaceFormResult> = {
          ...withData(plannedFields(plan, input.dryRun === true)),
          removed: [],
          removedCount: 0,
          kept: current.map((child) => child.id),
          testsAffected: [],
          outsideReferences: [],
          next: [],
          ...shared.payload(scope, 0)
        };
        return { ...result, note: [FROM_DATA_NOTHING_REPLACE], warnings: plan.warnings } as unknown as Record<string, unknown>;
      }
      if (input.dryRun === true) {
        const result: ToolFields<ReplaceFormResult> = { ...withData(plannedFields(plan, true)), ...extra, next, ...shared.payload(scope, 0) };
        return { ...result, warnings: plan.warnings } as unknown as Record<string, unknown>;
      }
      shared.yieldToPerson(scope, "replace");
      checkSignal(ctx);
      let outcome: InsertComponentsResult | undefined;
      const steps = guarded(scope, () =>
        // With fromData the importer's own thunk: planned again from the tree as it stands when the replace runs.
        controller.requestReplaceContent(data !== undefined ? data.nodes : plan.nodes, {
          slotId,
          keep: kept,
          onResult: (result) => {
            outcome = result;
          }
        })
      );
      if (outcome === undefined || !outcome.ok) {
        refusedByController(
          scope,
          outcome?.error,
          "The form's contents could not be replaced.",
          plan.nodes.map((node) => ({ node, parentId: controller.rootId(), slotId }))
        );
      }
      scope.cache.clear();
      const shown = shared.show(scope, {
        ...(plan.ids[0] !== undefined ? { select: plan.ids[0] } : {}),
        ids: plan.allIds,
        announce: scope.words.text("agent.did.replace", { count: plan.allIds.length }),
        undoSteps: steps
      });
      const result: ToolFields<ReplaceFormResult> = {
        ...withData(plannedFields(plan, false)),
        added: addedRows(scope, plan.allIds),
        problems: componentProblems(scope, plan.allIds),
        ...extra,
        next,
        ...shared.payload(scope, steps, shown)
      };
      return { ...result, warnings: plan.warnings } as unknown as Record<string, unknown>;
    }
  };

  // ---- set_properties ---------------------------------------------------------------------

  const setProperties: Tool = {
    name: "set_properties",
    title: "Change properties and rules",
    description:
      "Changes properties of existing components in one undo step: configuration such as label, required, placeholder, options, min, pattern (propertyPath from get_component), or a rule as 'rules.visibleWhen' (also requiredWhen, enabledWhen, readonlyWhen, validWhen, value, defaultValue) with FEEL text. The form root takes title, description, messages, chrome.* and print.*. Formulas are parsed first; nothing is written if any fails unless partial is true. null removes a rule or clears a property. Returns what was written. To change an id use rename_component. With target 'identity' on the root it changes the form's id, version or schemaVersion. Paths the site manages and agentTools (whether assistants may fill this form) are refused.",
    inputSchema: {
      type: "object",
      required: ["edits"],
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: { ...EXPECTED_REVISION },
        edits: {
          type: "array",
          description: "At least one, at most 200.",
          items: {
            type: "object",
            required: ["componentId", "propertyPath"],
            properties: {
              componentId: { type: "string", description: "The component (or the root id for form settings)." },
              propertyPath: {
                type: "string",
                maxLength: 512,
                description:
                  "A configuration path from get_component (label, required, options, placeholder, min, tabs.0.label, messages.required) or rules.<key> for a rule. Not id (use rename_component), not children (use add/move/remove)."
              },
              value: {
                description:
                  "The new value: string, number, boolean, array or object as the property's kind expects; FEEL text (or { formula, run }) for rules.*; null removes a rule or clears a property."
              },
              target: {
                type: "string",
                enum: ["configuration", "rules", "identity"],
                description:
                  "Optional alias: with 'rules', propertyPath is the bare rule key (the rules. prefix does the same); with 'identity' and the root id, propertyPath is id, version or schemaVersion of the form itself (not on the undo history; Undo all and end_session { undo: true } restore it)."
              }
            }
          }
        },
        partial: { type: "boolean", description: "Write the edits that pass even if some fail (a formula that does not parse and a wrong-typed value are returned in skipped). Default false: all or nothing." }
      }
    },
    annotations: {},
    execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const raw = Array.isArray(input.edits) ? (input.edits as unknown[]) : [];
      const partial = input.partial === true;
      if (raw.length === 0) {
        throw badInput([{ key: "edits", expected: "at least one edit" }]);
      }
      if (raw.length > MAX_EDITS) {
        throw tooLarge("edits", MAX_EDITS, raw.length);
      }
      // Shape first (bad-input, too-large), then the ids (unknown-component), before any other check.
      const missing = raw.flatMap((edit, index) => (isRecord(edit) && !Object.prototype.hasOwnProperty.call(edit, "value") ? [{ key: `edits[${index}].value`, expected: "a value (null removes a rule or clears a property)" }] : []));
      if (missing.length > 0) {
        throw badInput(missing);
      }
      raw.forEach((edit, index) => {
        let bytes = 0;
        try {
          bytes = new TextEncoder().encode(JSON.stringify((edit as Record<string, unknown>).value) ?? "null").length;
        } catch {
          throw badInput([{ key: `edits[${index}].value`, expected: "a JSON value" }]);
        }
        if (bytes > MAX_EDIT_VALUE_BYTES) {
          throw new ToolRefusal("too-large", `edits[${index}].value is ${bytes} bytes, over the ${MAX_EDIT_VALUE_BYTES} byte limit.`, `Send a smaller value (at most ${MAX_EDIT_VALUE_BYTES} bytes for edits[${index}].value).`, {
            what: "input",
            limit: MAX_EDIT_VALUE_BYTES,
            got: bytes,
            key: `edits[${index}].value`
          });
        }
      });
      const committed = controller.snapshot();
      const rootId = committed.id;
      // An identity edit (target "identity") is the form's own id,
      // version or schemaVersion, not a property of a component: it is read apart here and
      // applied after the configuration edits.
      const identityOf = (record: Record<string, unknown>, key: string): { field: IdentityField; value: string } => {
        const field = typeof record.propertyPath === "string" ? record.propertyPath.trim() : "";
        if (!(IDENTITY_FIELDS as readonly string[]).includes(field)) {
          throw badInput([{ key: `${key}.propertyPath`, expected: "id, version or schemaVersion (target 'identity' changes the form itself)" }]);
        }
        const limit = field === "id" ? kernelStructureNameMax() : kernelStructureVersionMax();
        const text = typeof record.value === "string" ? record.value.trim() : "";
        if (text === "" || text.length > limit) {
          throw badInput([{ key: `${key}.value`, expected: `a text of 1 to ${limit} characters (identity cannot be cleared)` }]);
        }
        return { field: field as IdentityField, value: text };
      };
      const parsed = raw.map((edit, index) => {
        const record = edit as Record<string, unknown>;
        const key = `edits[${index}]`;
        const identity = record.target === "identity" ? identityOf(record, key) : undefined;
        const path = identity === undefined ? parsePropertyPath(record.propertyPath as string, record.target, key) : undefined;
        // Path hygiene reaches into the value too: an own
        // `__proto__` key in a configuration object or a `{ formula, run }` rule is refused.
        const prototype = prototypeKeyIn(record.value, `${key}.value`);
        if (prototype !== undefined) {
          throw prototypeRefusal(prototype);
        }
        return { index, key, componentId: record.componentId as string, path, identity, value: record.value };
      });
      for (const edit of parsed) {
        if (findNode(committed, edit.componentId) === undefined) {
          throw shared.unknownComponent(scope, edit.componentId);
        }
        if (edit.identity !== undefined && edit.componentId !== rootId) {
          throw badInput([{ key: `${edit.key}.componentId`, expected: `the form root "${rootId}" (target 'identity' changes the form itself)` }]);
        }
      }

      const warnings: string[] = [];
      const lints: FormulaProblem[] = [];
      const formulaProblems: FormulaProblem[] = [];
      const skipped: SetPropertiesResult["skipped"] = [];

      // Settings the site manages and an identity the host owns: all or nothing, the first one named, unless `partial` lists them in `skipped`.
      const managed = managedPaths();
      const identityHostOwned = controller.identity() === undefined;
      const protect = (componentId: string, spelled: string, protectedPath: string, by: "host" | "author"): void => {
        if (!partial) {
          throw protectedRefusal(protectedPath, by);
        }
        skipped.push({ componentId, propertyPath: spelled, code: "protected-setting", details: { propertyPath: protectedPath, by } });
      };
      const protectedPathOf = (componentId: string, full: string, target: "configuration" | "rules", value: unknown): { path: string; by: "host" | "author" } | undefined => {
        const node = findNode(committed, componentId) as ComponentNode;
        const base = target === "rules" ? { rules: node.rules } : node.configuration;
        for (const path of managed) {
          if (full === path || full.startsWith(`${path}.`)) {
            return { path, by: "host" };
          }
          if (path.startsWith(`${full}.`)) {
            // A write to a parent replaces its protected descendant (`data` over `data.answersFree`):
            // allowed only where the written value leaves that descendant as it is.
            const written = isRecord(value) ? readPath(value, path.slice(full.length + 1)) : undefined;
            if (!sameValue(written ?? null, readPath(base, path) ?? null)) {
              return { path, by: "host" };
            }
          }
        }
        // The author's switch: after the host's check, so a host that lists
        // agentTools as managed answers by "host". Only the root's configuration reaches the key.
        if (componentId === rootId && target === "configuration" && (full === AGENT_TOOLS_KEY || full.startsWith(`${AGENT_TOOLS_KEY}.`))) {
          return { path: AGENT_TOOLS_KEY, by: "author" };
        }
        return undefined;
      };
      const identityGiven: Partial<Record<IdentityField, string>> = {};
      const open = parsed.filter((edit) => {
        if (edit.identity !== undefined) {
          if (identityHostOwned) {
            protect(edit.componentId, edit.identity.field, edit.identity.field, "host");
            return false;
          }
          identityGiven[edit.identity.field] = edit.identity.value;
          return false;
        }
        const path = edit.path as ParsedPath;
        const full = path.target === "rules" ? `rules.${path.path}` : path.path;
        const hit = protectedPathOf(edit.componentId, full, path.target, edit.value);
        if (hit !== undefined) {
          protect(edit.componentId, full, hit.path, hit.by);
          return false;
        }
        return true;
      });
      const wouldBe = new Map<string, ComponentNode>();
      const nodeOf = (id: string): ComponentNode => {
        let node = wouldBe.get(id);
        if (node === undefined) {
          node = structuredClone(findNode(committed, id) as ComponentNode);
          wouldBe.set(id, node);
        }
        return node;
      };
      // Every edit that checked out, in order. A later edit to the same component and path
      // replaces an earlier one where it stands (the agent's last word wins), so a path set and
      // then set back is no write at all.
      interface Candidate {
        slot: string;
        componentId: string;
        target: "configuration" | "rules";
        path: string;
        value: unknown;
        lints: FormulaProblem[];
      }
      const candidates: Candidate[] = [];
      const propose = (candidate: Candidate): void => {
        const earlier = candidates.findIndex((known) => known.slot === candidate.slot);
        if (earlier >= 0) {
          candidates.splice(earlier, 1);
        }
        candidates.push(candidate);
      };
      for (const edit of open) {
        const committedNode = findNode(committed, edit.componentId) as ComponentNode;
        const editPath = edit.path as ParsedPath;
        editPath.warnings.forEach((warning) => warnings.push(warning));
        if (editPath.target === "rules") {
          const ruleKey = editPath.path;
          const value = edit.value;
          if (value !== null && typeof value !== "string" && !(isRecord(value) && typeof value.formula === "string" && (value.run === undefined || ["both", "browser", "server", "server-secret"].includes(value.run as string)))) {
            throw badInput([{ key: `${edit.key}.value`, expected: 'FEEL text, { "formula": "...", "run": "both" }, or null to remove the rule' }]);
          }
          const removes = value === null || (typeof value === "string" && value.trim() === "");
          const stored = removes ? undefined : isRecord(value) ? { formula: value.formula, ...(value.run !== undefined ? { run: value.run } : {}) } : value;
          const found: FormulaProblem[] = [];
          if (stored !== undefined) {
            const check = shared.formulas.parseRule(scope, { componentId: edit.componentId, key: ruleKey, source: stored });
            if (!check.ok) {
              if (partial) {
                skipped.push({ componentId: edit.componentId, propertyPath: `rules.${ruleKey}`, problem: check.problem });
              } else {
                formulaProblems.push(check.problem);
              }
              continue;
            }
            if (!check.blank) {
              found.push(
                ...shared.formulas.unknownFields(scope, { componentId: edit.componentId, key: ruleKey, formula: check.formula, paths: check.paths as readonly FormulaPathRef[] }),
                ...(shared.formulas.lintRule(scope, { componentId: edit.componentId, key: ruleKey, formula: check.formula, parsed: check.parsed }) ?? [])
              );
            }
          }
          propose({ slot: `${edit.componentId}\u0000rules\u0000${ruleKey}`, componentId: edit.componentId, target: "rules", path: ruleKey, value: stored, lints: found });
          continue;
        }
        const path = editPath.path;
        const printSetting = edit.componentId === rootId && isRootPrintPath(path);
        const printKind = printSetting ? rootPrintControl(path) : undefined;
        const kind = printSetting ? (printKind !== undefined ? { known: true, kind: printKind } : { known: true }) : pathKind(controller, edit.componentId, committedNode.type, editPath.segments);
        if (!kind.known) {
          warnings.push(`unknown-property: ${committedNode.type} has no inspector property named ${path}; written anyway.`);
        }
        let kinded: KindedValue;
        try {
          // The root's chrome, messages and print are whole settings objects, read as such by every consumer.
          if (edit.componentId === rootId && ROOT_OBJECT_SETTINGS.has(path) && edit.value !== null && !isRecord(edit.value)) {
            throw badInput([{ key: `${edit.key}.value`, expected: `a JSON object (${path} is a settings object; null clears it)` }]);
          }
          const printProblem = printSetting ? rootPrintValueProblem(path, edit.value) : undefined;
          if (printProblem !== undefined) {
            throw badInput([{ key: `${edit.key}.value`, expected: `${printProblem} (null clears it)` }]);
          }
          if (kind.scalarHead !== undefined) {
            const head = kind.scalarPath ?? (editPath.segments[0] as string);
            throw badInput([{ key: `${edit.key}.propertyPath`, expected: `${head} takes a ${kind.scalarHead}; write it at ${head}` }]);
          }
          kinded = kindValue(edit.value, kind.kind, { componentId: edit.componentId, path, key: `${edit.key}.value` });
        } catch (error) {
          // Under `partial` a value of the wrong shape is left out and listed, like a formula that failed.
          if (partial && error instanceof ToolRefusal && error.code === "bad-input") {
            const problems = (error.details?.problems ?? []) as Array<{ key: string; expected: string }>;
            skipped.push({ componentId: edit.componentId, propertyPath: path, code: "bad-input", details: { problems } });
            continue;
          }
          throw error;
        }
        kinded.warnings.forEach((warning) => warnings.push(warning));
        propose({ slot: `${edit.componentId}\u0000configuration\u0000${path}`, componentId: edit.componentId, target: "configuration", path, value: kinded.value === null ? undefined : kinded.value, lints: [] });
      }

      // Each surviving edit judged against what the edits before it leave (a path one edit
      // set and a deeper one then changes), applied to the would-be nodes in order, as the
      // controller applies them; `previous` is the committed value.
      const written: SetPropertiesResult["written"] = [];
      const writes: Array<{ componentId: string; propertyPath: string; value: unknown; target?: "rules" }> = [];
      const keyEdits: Array<{ componentId: string; value: unknown }> = [];
      for (const candidate of candidates) {
        for (const problem of candidate.lints) {
          lints.push(problem);
          warnings.push(formulaWarning(problem));
        }
        const committedNode = findNode(committed, candidate.componentId) as ComponentNode;
        const current = wouldBe.get(candidate.componentId) ?? committedNode;
        const value = candidate.value;
        if (candidate.target === "rules") {
          const now = isRecord(current.rules) ? (current.rules as Record<string, unknown>)[candidate.path] : undefined;
          if (sameValue(now ?? null, value ?? null)) {
            continue;
          }
          const node = nodeOf(candidate.componentId);
          const rules: Record<string, unknown> = isRecord(node.rules) ? { ...(node.rules as Record<string, unknown>) } : {};
          if (value === undefined) {
            delete rules[candidate.path];
          } else {
            rules[candidate.path] = value;
          }
          if (Object.keys(rules).length > 0) {
            node.rules = rules as NonNullable<ComponentNode["rules"]>;
          } else {
            delete node.rules;
          }
          const previousRaw = isRecord(committedNode.rules) ? (committedNode.rules as Record<string, unknown>)[candidate.path] : undefined;
          written.push({
            componentId: candidate.componentId,
            propertyPath: `rules.${candidate.path}`,
            target: "rules",
            previous: previousRaw === undefined ? null : structuredClone(previousRaw),
            value: value === undefined ? null : structuredClone(value)
          });
          writes.push({ componentId: candidate.componentId, propertyPath: candidate.path, value, target: "rules" });
          continue;
        }
        if (sameValue(readPath(current.configuration, candidate.path) ?? null, value ?? null)) {
          continue;
        }
        const node = nodeOf(candidate.componentId);
        const configuration = isRecord(node.configuration) ? (node.configuration as Record<string, unknown>) : {};
        node.configuration = configuration;
        writePath(configuration, candidate.path, value === undefined ? undefined : structuredClone(value));
        if (candidate.path === "dataKey") {
          keyEdits.push({ componentId: candidate.componentId, value });
        }
        const previousRaw = controller.getProperty(candidate.componentId, candidate.path);
        written.push({
          componentId: candidate.componentId,
          propertyPath: candidate.path,
          target: "configuration",
          previous: previousRaw === undefined ? null : structuredClone(previousRaw),
          value: value === undefined ? null : structuredClone(value)
        });
        writes.push({ componentId: candidate.componentId, propertyPath: candidate.path, value });
      }

      // The would-be tree: every touched node replaced by its edited copy.
      const wouldBeRoot = structuredClone(committed);
      for (const [id, node] of wouldBe) {
        const target = findNode(wouldBeRoot, id);
        if (target !== undefined) {
          if (node.configuration === undefined) {
            delete target.configuration;
          } else {
            target.configuration = node.configuration;
          }
          if (node.rules === undefined) {
            delete target.rules;
          } else {
            target.rules = node.rules;
          }
        }
      }
      const failures: ToolRefusal[] = [];
      if (formulaProblems.length > 0) {
        failures.push(shared.formulas.refusal(formulaProblems, { partial: true }));
      }
      // A header or footer the renderer would draw short (an unknown part type is dropped without
      // a word), judged on what the write leaves, so a write to `chrome` itself cannot bypass it.
      const rootAfter = wouldBe.get(rootId);
      if (rootAfter !== undefined) {
        let regionProblem = false;
        for (const region of ["header", "footer"] as const) {
          const after = readPath(rootAfter.configuration, `chrome.${region}`);
          const problem = sameValue(after, readPath(committed.configuration, `chrome.${region}`)) ? undefined : chromeRegionProblem(after);
          if (problem !== undefined) {
            regionProblem = true;
            failures.push(blockedRefusal(rootId, `chrome.${region}`, problem));
          }
        }
        // A part id is the key of its translations: an id the header and footer already share is not made worse by a write that leaves it alone, but any repeated id the committed chrome did not have is refused, whether or not another was already shared.
        const repeated = regionProblem ? undefined : newlyRepeatedChromeId(committed.configuration, rootAfter.configuration);
        if (repeated !== undefined) {
          failures.push(blockedRefusal(rootId, "chrome", `The part id "${repeated}" is used twice; every header and footer part needs an id of its own, unique across both.`));
        }
      }
      // The inspector's Apply would refuse it (a blocker this write adds), or the key itself.
      blockers: for (const [id, node] of wouldBe) {
        const before = new Set(applyBlockers(findNode(committed, id) as ComponentNode, scope.words.options()).map((blocker) => blocker.fieldId));
        for (const blocker of applyBlockers(node, scope.words.options())) {
          if (!before.has(blocker.fieldId)) {
            failures.push(blockedRefusal(id, blocker.fieldId, blocker.message));
            break blockers;
          }
        }
      }
      for (const edit of keyEdits) {
        const problem = dataKeyProblemOf(edit.value);
        if (problem !== undefined) {
          failures.push(blockedRefusal(edit.componentId, "dataKey", problem));
          break;
        }
      }
      if (written.length > 0) {
        const dataProblems = newDataProblems(committed, wouldBeRoot);
        if (dataProblems.length > 0) {
          failures.push(dataPathRefusal(dataProblems));
        }
        const after = structureProblem(shared, wouldBeRoot);
        if (after !== undefined && after !== structureProblem(shared, committed)) {
          failures.push(structureRefusal(after));
        }
      }
      const refusal = firstFailure(failures.map((failure, order) => ({ order, refusal: failure })));
      if (refusal !== undefined) {
        throw refusal;
      }
      const next = ["Run check_form when you are done."];
      // The identity fields the call changes (a value equal to the form's own is no write).
      const identityBefore = controller.identity();
      const identityFields = IDENTITY_FIELDS.filter((field) => identityGiven[field] !== undefined && identityBefore !== undefined && identityGiven[field] !== identityBefore[field]);
      if (writes.length === 0 && identityFields.length === 0) {
        const result: ToolFields<SetPropertiesResult> = { written: [], skipped, lints, problems: [], next, ...shared.payload(scope, 0) };
        return { ...result, warnings } as unknown as Record<string, unknown>;
      }
      const touched = [...new Set(writes.map((edit) => edit.componentId))];
      if (writes.length > 0) {
        shared.yieldToPerson(scope, "properties", { ids: touched });
      }
      if (identityFields.length > 0) {
        // `setIdentity` overwrites the root's draft (BC:2054).
        shared.yieldToPerson(scope, "identity");
      }
      checkSignal(ctx);
      const { steps } = shared.write(scope, () => {
        if (writes.length > 0) {
          controller.setProperties(writes.map((edit) => ({ componentId: edit.componentId, propertyPath: edit.propertyPath, value: edit.value, ...(edit.target !== undefined ? { target: edit.target } : {}) })));
        }
        // After the configuration edits of the same call; the fingerprint moves the revision.
        if (identityFields.length > 0 && identityBefore !== undefined) {
          controller.setIdentity({ ...identityBefore, ...identityGiven });
        }
      });
      scope.cache.clear();
      const first = touched[0];
      const journaled = identityFields.length > 0;
      const shown = shared.show(scope, {
        ...(first !== undefined ? { select: first } : {}),
        ids: touched,
        // A call that changes both says both: the new id is what a site stores the form under.
        announce:
          first !== undefined
            ? identityFields.length > 0
              ? scope.words.text("agent.did.setAndIdentity", {
                  set: scope.words.plural("agent.did.set", written.length, { count: written.length, label: labelOf(scope, first) }),
                  identity: scope.words.text("agent.did.identity")
                })
              : scope.words.plural("agent.did.set", written.length, { count: written.length, label: labelOf(scope, first) })
            : scope.words.text("agent.did.identity"),
        undoSteps: steps,
        ...(journaled ? { journaled: { call: scope.call } } : {})
      });
      const payload = shared.payload(scope, steps, shown);
      const result: ToolFields<SetPropertiesResult> = { written, skipped, lints, problems: componentProblems(scope, touched), next, ...payload };
      if (journaled && identityBefore !== undefined) {
        // On no controller history: the outside journal takes it back (Undo all, Stop, the notice's Undo).
        shared.journal.record(scope, { kind: "identity", before: identityBefore });
        const change: IdentityChange = { before: { ...identityBefore }, after: { ...(controller.identity() as typeof identityBefore) } };
        result.identity = change;
        result.undo = { ...payload.undo, journaled: true };
        result.reverse = {
          tool: "set_properties",
          input: { edits: identityFields.map((field) => ({ componentId: rootId, target: "identity", propertyPath: field, value: identityBefore[field] })) }
        };
      }
      const note = journaled ? ["The identity change is not on the undo history; Undo all restores it."] : [];
      if (identityFields.includes("id")) {
        note.push("Sites store forms by id; tell the person the form now saves under the new id.");
      }
      return { ...result, ...(note.length > 0 ? { note } : {}), warnings } as unknown as Record<string, unknown>;
    }
  };

  // ---- rename_component -------------------------------------------------------------------

  const renameComponent: Tool = {
    name: "rename_component",
    title: "Rename a component id",
    description:
      "Changes a component's id. Rules that read the old id are rewritten in the same change; journey pages, PDF layouts and tests follow (tests a moment later). Ids are stable handles, so rename only when the person asks or a generated id is unreadable. Returns which rules were rewritten and any formula that could not be, in the author's words.",
    inputSchema: {
      type: "object",
      required: ["componentId", "newId"],
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: { ...EXPECTED_REVISION },
        componentId: { type: "string", description: "The component's current id (from get_form)." },
        newId: { type: "string", maxLength: 128, description: "A letter, then letters, digits, _ or -; unique in the form." }
      }
    },
    annotations: { untrustedContentHint: true },
    execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const componentId = input.componentId as string;
      const newId = (input.newId as string).trim();
      const committed = controller.snapshot();
      const node = findNode(committed, componentId);
      if (node === undefined) {
        throw shared.unknownComponent(scope, componentId);
      }
      if (componentId === committed.id) {
        throw rootRefusal(scope, "renamed");
      }
      if (controller.isFixedNode(componentId)) {
        throw fixedRefusal(componentId);
      }
      const collectionPathFollowed = node.collection?.collectionPath === componentId;
      const unchanged = (): Record<string, unknown> => {
        const result: ToolFields<RenameComponentResult> = { from: componentId, to: componentId, rulesRewritten: [], unparsed: [], collectionPathFollowed: false, testsFollow: "none", ...shared.payload(scope, 0) };
        return result as unknown as Record<string, unknown>;
      };
      if (newId === componentId) {
        return unchanged();
      }
      if (!isValidComponentId(newId)) {
        throw new ToolRefusal("invalid-id", componentIdProblem(newId)!, "Use a letter, then letters, digits, _ or -, at most 128 characters, and not a reserved word.", { id: newId });
      }
      if (findNode(committed, newId) !== undefined) {
        throw new ToolRefusal("duplicate-id", `ID "${newId}" already exists.`, "Pick another id or omit it.", { id: newId });
      }
      if (controller.claimedIds().includes(newId)) {
        throw new ToolRefusal("duplicate-id", `ID "${newId}" is already used by a page-only field of a journey.`, "A journey page-only field owns this id; pick another.", { id: newId, claimed: true });
      }
      // What follows asynchronously: the shell rewrites the tests that name the old id.
      let testsFollow: RenameComponentResult["testsFollow"] = "none";
      if (host.ui === undefined || !host.featureOn("tests")) {
        testsFollow = "unavailable";
      } else {
        const path = dataPathsOf(scope).get(componentId);
        if (shared.refs.testsMentioning(controller.tests(), [componentId], path !== undefined ? [path] : []).length > 0) {
          testsFollow = "queued";
        }
      }
      shared.yieldToPerson(scope, "rename", { ids: [componentId] });
      checkSignal(ctx);
      let renamed: { rules?: string[] } | undefined;
      const off = controller.on("change", (event) => {
        if (event.renamed !== undefined && event.renamed.from === componentId) {
          renamed = { ...(event.renamed.rules !== undefined ? { rules: [...event.renamed.rules] } : {}) };
        }
      });
      let steps = 0;
      try {
        steps = shared.write(scope, () => controller.renameId(componentId, newId)).steps;
      } finally {
        off();
      }
      const idError = controller.idError;
      if (idError !== undefined || renamed === undefined) {
        controller.idError = undefined;
        throw controllerRefusal(scope, idError ?? "The rename did not happen.");
      }
      scope.cache.clear();
      const rulesRewritten = renamed.rules ?? [];
      const shown = shared.show(scope, {
        select: newId,
        ids: [newId, ...rulesRewritten.filter((id) => id !== newId)],
        announce: scope.words.text("agent.did.rename", { from: componentId, to: newId }),
        undoSteps: steps
      });
      const result: ToolFields<RenameComponentResult> = {
        from: componentId,
        to: newId,
        rulesRewritten: [...rulesRewritten],
        unparsed: controller.renameNotes().map((note) => ({ ...note })),
        collectionPathFollowed,
        testsFollow,
        ...shared.payload(scope, steps, shown)
      };
      const warnings = testsFollow === "queued" ? ["tests-follow: test sources are rewritten a moment later; list_tests may show the old id for one tick."] : [];
      return { ...result, ...(warnings.length > 0 ? { warnings } : {}) } as unknown as Record<string, unknown>;
    }
  };

  // ---- move_component ---------------------------------------------------------------------

  const targetRef = (target: BuilderMoveTarget): MoveTargetRef => {
    const ref: MoveTargetRef = { parentId: target.parentId, slotId: target.slotId, label: target.label, depth: target.depth, siblings: target.siblings.length };
    if (target.pageId !== undefined) {
      ref.pageId = target.pageId;
    }
    if (target.slotLabel !== undefined) {
      ref.slotLabel = target.slotLabel;
    }
    if (target.current !== undefined) {
      ref.current = target.current;
    }
    return ref;
  };

  const moveRefusal = (componentId: string, container: string, reason: "inside-itself" | "slot" | "missing" | "data-path", message: string, targets: readonly BuilderMoveTarget[]): ToolRefusal => {
    const sentence = message.charAt(0).toLowerCase() + message.slice(1).replace(/\.$/, "");
    return new ToolRefusal("move-refused", `"${componentId}" cannot go in "${container}": ${sentence}.`, "Pick one of details.targets.", {
      reason,
      message,
      targets: targets.slice(0, MOVE_TARGETS_CAP).map(targetRef)
    });
  };

  /**
   * What the tree would hold once `componentId` sat at `index` in `parentId.slotId`, judged against
   * the limits the server enforces (a move that nests the subtree past the depth limit makes a form
   * that cannot be reopened or saved); a problem the form already had is not the move's.
   */
  const moveProblem = (
    scope: BuilderCallScope,
    componentId: string,
    from: { parentId: string; slotId: string; index: number },
    parentId: string,
    slotId: string,
    index: number
  ): string | undefined => {
    const committed = scope.controller.snapshot();
    const leaves = structuredClone(committed);
    const leavesFrom = findNode(leaves, from.parentId);
    const leavesTo = findNode(leaves, parentId);
    const list = leavesFrom?.children?.[from.slotId];
    if (list === undefined || leavesTo === undefined) {
      return undefined;
    }
    const [carried] = list.splice(from.index, 1);
    if (carried === undefined || carried.id !== componentId) {
      return undefined;
    }
    const children = (leavesTo.children ??= {});
    (children[slotId] ??= []).splice(index, 0, carried);
    const after = structureProblem(shared, leaves);
    return after !== undefined && after !== structureProblem(shared, committed) ? after : undefined;
  };

  const moveComponent: Tool = {
    name: "move_component",
    title: "Move a component",
    description:
      "Moves a component into another container, or to another position among its siblings. index is the final 0-based position among the other children; after names a sibling to land right after; leave both out to append. If the move is not allowed, the result lists where the component may go. One undo step.",
    inputSchema: {
      type: "object",
      required: ["componentId"],
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: { ...EXPECTED_REVISION },
        componentId: { type: "string", description: "The component to move (from get_form)." },
        parentId: { type: "string", description: "The destination container (the root id for the top level, or a journey page id). Leave it out to stay in the current container." },
        slotId: { type: "string", description: "The destination slot; leave it out for the container's first legal slot." },
        index: { type: "integer", minimum: 0, description: "Final position among the other children; leave it out to append." },
        after: { type: "string", description: "Instead of index: land right after this sibling id in the destination." }
      }
    },
    annotations: {},
    execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const componentId = input.componentId as string;
      const after = stringOf(input.after);
      const index = typeof input.index === "number" ? input.index : undefined;
      const slotId = stringOf(input.slotId);
      if (after !== undefined && index !== undefined) {
        throw badInput([{ key: "after", expected: "either index or after, not both" }]);
      }
      const committed = controller.snapshot();
      const moving = findNode(committed, componentId);
      if (moving === undefined) {
        throw shared.unknownComponent(scope, componentId);
      }
      if (componentId === committed.id) {
        throw rootRefusal(scope, "moved");
      }
      if (controller.isFixedNode(componentId)) {
        throw fixedRefusal(componentId);
      }
      const from = controller.parentOf(componentId) as { parentId: string; slotId: string; index: number };
      const parentArg = stringOf(input.parentId);
      const container = parentArg ?? from.parentId;
      const byPage = (id: string): ComponentNode | undefined => subtreeNodes(committed).find((node) => isRecord(node.configuration) && node.configuration.pageId === id);
      const containerNode = findNode(committed, container) ?? byPage(container);
      if (containerNode === undefined) {
        throw shared.unknownComponent(scope, container);
      }
      const targets = controller.moveTargets(componentId);
      const matching = targets.filter((target) => (target.parentId === containerNode.id || target.pageId === container) && (slotId === undefined || target.slotId === slotId));
      const target = slotId === undefined && containerNode.id === from.parentId ? (matching.find((entry) => entry.slotId === from.slotId) ?? matching[0]) : matching[0];
      if (target === undefined) {
        // Why not: the component itself (or something inside it), a slot the container lacks,
        // a slot that refuses it, else a data place two components would share.
        if (subtreeIds(moving).includes(containerNode.id)) {
          throw moveRefusal(componentId, container, "inside-itself", "A component cannot go inside itself", targets);
        }
        const slots = slotIdsOf(scope, containerNode);
        if (slotId !== undefined && slots.length > 0 && !slots.includes(slotId)) {
          throw moveRefusal(componentId, container, "missing", `A ${containerNode.type} component has no slot ${slotId}`, targets);
        }
        const slot = slotId ?? defaultSlotOf(scope, containerNode, moving.type);
        const acceptance = canAcceptInSlot(containerNode, moving, slot, containerNode.children?.[slot]?.length ?? 0, slotResolver(scope));
        if (!acceptance.ok) {
          throw moveRefusal(componentId, container, "slot", acceptance.reason ?? "Not allowed there", targets);
        }
        // A destination too deep for the subtree is not offered either, and is named as such.
        const nestedThere = moveProblem(scope, componentId, from, containerNode.id, slot, containerNode.children?.[slot]?.length ?? 0);
        if (nestedThere !== undefined) {
          throw structureRefusal(nestedThere);
        }
        throw moveRefusal(componentId, container, "data-path", "Two components would store their answers in one place there", targets);
      }
      const siblings = target.siblings;
      let finalIndex: number;
      if (after !== undefined) {
        const at = siblings.findIndex((sibling) => sibling.id === after);
        if (at < 0) {
          if (findNode(committed, after) === undefined) {
            throw shared.unknownComponent(scope, after);
          }
          throw badInput([{ key: "after", expected: `a component in the destination slot (${target.parentId}.${target.slotId})` }]);
        }
        finalIndex = at + 1;
      } else if (index !== undefined) {
        if (index > siblings.length) {
          throw badInput([{ key: "index", expected: `at most ${siblings.length}` }]);
        }
        finalIndex = index;
      } else {
        finalIndex = siblings.length;
      }
      if (target.current === finalIndex) {
        // Already there: nothing to do, no step.
        const result: ToolFields<MoveComponentResult> = { componentId, from: { ...from }, to: { ...from }, leftEmpty: [], ...shared.payload(scope, 0) };
        return result as unknown as Record<string, unknown>;
      }
      const nested = moveProblem(scope, componentId, from, target.parentId, target.slotId, finalIndex);
      if (nested !== undefined) {
        throw structureRefusal(nested);
      }
      yieldForRequest(scope, "tree");
      checkSignal(ctx);
      let outcome: { moved: boolean; result: BuilderMoveToResult } | undefined;
      const steps = guarded(scope, () =>
        controller.requestMoveTo(componentId, target.parentId, finalIndex, target.slotId, (moved, result) => {
          outcome = { moved, result };
        })
      );
      if (outcome === undefined || !outcome.moved) {
        const message = controller.dropError ?? "The move was refused.";
        controller.dropError = undefined;
        throw moveRefusal(componentId, container, /store/.test(message) ? "data-path" : "slot", message, controller.moveTargets(componentId));
      }
      scope.cache.clear();
      const to = controller.parentOf(componentId) ?? { parentId: target.parentId, slotId: target.slotId, index: finalIndex };
      const shown = shared.show(scope, { select: componentId, ids: [componentId], announce: scope.words.text("agent.did.move", { label: labelOf(scope, componentId) }), undoSteps: steps });
      const result: ToolFields<MoveComponentResult> = { componentId, from: { ...from }, to: { ...to }, leftEmpty: [...outcome.result.leftEmpty], ...shared.payload(scope, steps, shown) };
      return result as unknown as Record<string, unknown>;
    }
  };

  // ---- remove_components ------------------------------------------------------------------

  const removeComponents: Tool = {
    name: "remove_components",
    title: "Remove components",
    description:
      "Removes components and everything inside them in one undo step. Refused with a list when other components' rules, journey pages or PDF layouts still read them, unless removeReferences is true (then those references are cleared too, one undo step per component). Tests that mention removed ids are reported, never edited. Confirm with the person before removing more than one component or anything with dependents; a single leaf is recoverable with undo. Languages, journeys and PDF layouts are removed with remove_part.",
    inputSchema: {
      type: "object",
      required: ["componentIds"],
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: { ...EXPECTED_REVISION },
        componentIds: { type: "array", items: { type: "string" }, description: "Ids to remove: at least one, at most 500; ids inside another listed id are folded." },
        removeReferences: {
          type: "boolean",
          description: "Also clear rules in other components and journey or PDF references that read these ids (default false). One undo step per component then."
        }
      }
    },
    annotations: { consequentialHint: true, untrustedContentHint: true },
    execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const raw = Array.isArray(input.componentIds) ? (input.componentIds as string[]) : [];
      if (raw.length === 0) {
        throw badInput([{ key: "componentIds", expected: "at least one component id" }]);
      }
      if (raw.length > MAX_REMOVE) {
        throw tooLarge("componentIds", MAX_REMOVE, raw.length);
      }
      const removeReferences = input.removeReferences === true;
      const committed = controller.snapshot();
      const listed = [...new Set(raw)];
      for (const id of listed) {
        if (findNode(committed, id) === undefined) {
          throw shared.unknownComponent(scope, id);
        }
        if (id === committed.id) {
          throw rootRefusal(scope, "removed");
        }
        if (controller.isFixedNode(id)) {
          throw fixedRefusal(id);
        }
      }
      const listedSet = new Set(listed);
      const within = (id: string): boolean => {
        let parent = controller.parentOf(id)?.parentId;
        while (parent !== undefined) {
          if (listedSet.has(parent)) {
            return true;
          }
          parent = controller.parentOf(parent)?.parentId;
        }
        return false;
      };
      const tops = listed.filter((id) => !within(id));
      const skipped = listed.filter((id) => within(id)).map((id) => ({ id, reason: "nested" as const }));
      const removedAll = tops.flatMap((id) => subtreeIds(findNode(committed, id) as ComponentNode));
      const removedSet = new Set(removedAll);
      // A plain filter over dependentsOf: a rule owned by a component going too is no dependent; journeys and layouts stay.
      const dependents: Array<{ componentId: string; items: Dependent[]; lines: string[] }> = [];
      for (const id of tops) {
        const items = controller.dependentsOf(id).filter((dependent) => dependent.kind !== "rule" || !removedSet.has(dependent.componentId));
        if (items.length > 0) {
          dependents.push({ componentId: id, items: items.map((item) => structuredClone(item)), lines: dependentLines(items, scope.words.options()) });
        }
      }
      if (dependents.length > 0 && !removeReferences) {
        const count = dependents.reduce((sum, entry) => sum + entry.items.length, 0);
        const names = dependents.map((entry) => `"${entry.componentId}"`).join(", ");
        throw new ToolRefusal(
          "has-dependents",
          `${count} ${count === 1 ? "reference still reads" : "references still read"} ${names}.`,
          "Call again with removeReferences: true to clear those references too (one undo step per component), or fix them first with set_properties.",
          { dependents }
        );
      }
      const paths = dataPathsOf(scope);
      const testsAffected = shared.refs.testsMentioning(
        controller.tests(),
        removedAll,
        removedAll.map((id) => paths.get(id)).filter((path): path is string => path !== undefined)
      );
      // Where the selection goes: the previous sibling of the first removed id that stays, else its parent.
      const firstPlace = controller.parentOf(tops[0] as string);
      let select: string | undefined;
      if (firstPlace !== undefined) {
        const group = findNode(committed, firstPlace.parentId)?.children?.[firstPlace.slotId] ?? [];
        for (let at = firstPlace.index - 1; at >= 0; at -= 1) {
          const sibling = group[at];
          if (sibling !== undefined && !removedSet.has(sibling.id)) {
            select = sibling.id;
            break;
          }
        }
        select ??= firstPlace.parentId;
      }
      yieldForRequest(scope, "remove", removedSet);
      checkSignal(ctx);
      let removed: string[] = [];
      const steps = guarded(scope, () =>
        controller.requestRemoveComponents(tops, {
          removeReferences,
          onResult: (ids) => {
            removed = [...ids];
          }
        })
      );
      if (removed.length === 0) {
        throw controllerRefusal(scope, "Nothing could be removed.");
      }
      scope.cache.clear();
      const removedCount = removed.flatMap((id) => subtreeIds(findNode(committed, id) as ComponentNode)).length;
      const shown = shared.show(scope, {
        ...(select !== undefined ? { select } : {}),
        ids: [],
        announce: scope.words.plural("agent.did.remove", removedCount, { count: removedCount }),
        undoSteps: steps
      });
      const result: ToolFields<RemoveComponentsResult> = {
        removed,
        removedCount,
        skipped,
        referencesCleared: removeReferences ? dependents.flatMap((entry) => entry.items) : [],
        testsAffected,
        next: testsNext(testsAffected),
        ...shared.payload(scope, steps, shown)
      };
      return result as unknown as Record<string, unknown>;
    }
  };

  // ---- duplicate_component ----------------------------------------------------------------

  const duplicateComponent: Tool = {
    name: "duplicate_component",
    title: "Duplicate a component",
    description:
      "Copies a component, with everything inside it, right after the original; the copy gets fresh ids, no data keys, and its rules are re-pointed to the copies. Returns the new id and the id map. One undo step.",
    inputSchema: {
      type: "object",
      required: ["componentId"],
      properties: {
        builder: builderHandleProperty(),
        expectedRevision: { ...EXPECTED_REVISION },
        componentId: { type: "string", description: "The component to copy (from get_form)." }
      }
    },
    annotations: {},
    execute(input, ctx: Ctx) {
      const scope = shared.scope(ctx);
      const controller = scope.controller;
      const componentId = input.componentId as string;
      const committed = controller.snapshot();
      const original = findNode(committed, componentId);
      if (original === undefined) {
        throw shared.unknownComponent(scope, componentId);
      }
      if (componentId === committed.id) {
        throw rootRefusal(scope, "duplicated");
      }
      const fixed = subtreeIds(original).find((id) => controller.isFixedNode(id));
      if (fixed !== undefined) {
        throw fixedRefusal(fixed);
      }
      // The copy writes every setting the original carries, a managed one among them.
      refuseManaged([original]);
      const limit = kernelStructureLimits().components;
      const total = subtreeIds(committed).length + subtreeIds(original).length;
      if (total > limit) {
        const refusal = structureRefusal(`The form would hold ${total} components; at most ${limit}.`, { name: "components", max: limit });
        throw new ToolRefusal("structure-limit", `The copy would bring the form to ${total} components, over the ${limit} the server takes.`, refusal.hint, refusal.details);
      }
      yieldForRequest(scope, "tree");
      checkSignal(ctx);
      const before = new Set(subtreeIds(committed));
      const steps = guarded(scope, () => controller.requestDuplicate(componentId));
      if (steps === 0) {
        const message = controller.dropError ?? "The component could not be copied.";
        controller.dropError = undefined;
        const place = controller.parentOf(componentId);
        if (place !== undefined && /cannot go in|does not allow multiple|reached max|is not allowed in slot|does not take children/.test(message)) {
          throw slotRefusal(scope, place.parentId, place.slotId, original, message);
        }
        throw controllerRefusal(scope, message);
      }
      const after = controller.snapshot();
      const copyId = controller.selectedComponentId();
      const copy = copyId !== undefined && !before.has(copyId) ? findNode(after, copyId) : undefined;
      const originals = subtreeNodes(original);
      const copies = copy !== undefined ? subtreeNodes(copy) : [];
      if (copy === undefined || copies.length !== originals.length) {
        // The history moved but the copy cannot be told from the selection: say so, never guess.
        throw internalRefusal("The copy was made but could not be identified; the form changed.");
      }
      const ids: Record<string, string> = {};
      const dataKeysDropped: string[] = [];
      originals.forEach((node, at) => {
        const twin = copies[at] as ComponentNode;
        ids[node.id] = twin.id;
        const had = isRecord(node.configuration) && node.configuration.dataKey !== undefined;
        const has = isRecord(twin.configuration) && twin.configuration.dataKey !== undefined;
        if (had && !has) {
          dataKeysDropped.push(twin.id);
        }
      });
      scope.cache.clear();
      const shown = shared.show(scope, {
        select: copy.id,
        ids: copies.map((node) => node.id),
        announce: scope.words.text("agent.did.duplicate", { label: labelOf(scope, componentId) }),
        undoSteps: steps
      });
      const result: ToolFields<DuplicateComponentResult> = { from: componentId, id: copy.id, ids, dataKeysDropped, ...shared.payload(scope, steps, shown) };
      return result as unknown as Record<string, unknown>;
    }
  };

  return [addComponents, replaceForm, setProperties, renameComponent, moveComponent, removeComponents, duplicateComponent];
}
