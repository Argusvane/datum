/**
 * Authoring a presentation's own nodes in the Journeys designer: what the
 * palette offers besides pages, form fields and routes, and what its inspector offers.
 *
 * - **The palette.** The Journey group gains "Worked-out value" (`journey-value`); then come
 *   the page-only fields — the form's own palette, group by group ("Page-only fields",
 *   "Page-only choices", …), less what a presentation cannot hold (rule B: repeating sections,
 *   data grids, files, signatures, steps; a plain `container`, which scopes data; anything
 *   data-scoping). Each is the form's own definition, derived: no data key, no PDF options, no
 *   data source; a container's slots take the page-only fields and references to the form's
 *   fields (`journey-field`), never the designer's own nodes.
 * - **The canvas.** A step is drawn as the person sees it (the Step view, `step-view.ts`): an own
 *   field is the real field in the form's binding, tagged "Not sent" when it fills nothing
 *   (`stepTagWords`); a layout draws what it holds inside it.
 * - **The inspector.** A field that holds an answer puts "Fills form field" first: the form's
 *   value fields an alias may fill (rule E), of a kind its answer fits (the diagnostics' own
 *   test, `journeyAliasFits`), less those the presentation already places on a page. A
 *   worked-out value picks its form field the same way, less any the presentation fills. A
 *   field that fills nothing says it is kept in the browser.
 * - **"Ask differently here…"** (`askDifferently`): a reused form field replaced, in place, by
 *   a field of the presentation's own of the same type that fills it, its label, help, options
 *   and constraints copied, under a fresh id — so the author can then word it differently.
 *
 * A chunk of its own (`loadJourneyAuthoring` in `journey-designer.ts`), loaded with the
 * designer before a journey's controller is built: the types a controller edits are fixed when
 * it is built, and adding them later would take its history. It imports nothing of the
 * designer's chunk but types: what it reads of the definitions the designer lends it
 * (`JourneyAuthoringLent`, for the reason `JourneyPreviewLent` gives). Nothing here runs at import.
 */
import type { ComponentDefinition, PropertyEditorDefinition, PropertyEditorField } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { journeyAliasFits } from "../../core/journey/journey-diagnostics.js";
import { journeyMaxDepth, journeyTargetUsable } from "../../core/journey/journey-path.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { PRESENTATION_REFERENCE_TYPE, PRESENTATION_VALUE_TYPE } from "../../core/schema/journey.js";
import { holdsData, isDataScopeContainer } from "../../core/tree/data-scope.js";
import type { BuilderComponentType, BuilderControllerOptions } from "../controller/builder-controller.js";
import { composePropertyEditor } from "../property-editor/editor-composer.js";
import { buildInspectorModel, type InspectorChoice } from "../property-editor/inspector-model.js";
import { groupPaletteEntries } from "../web-component/builder-shared.js";
import type { journeyComponentDefinitions, JourneyFacesContext, JourneyFormIndex } from "./journey-components.js";
import {
  JOURNEY_FIELD_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_PAGES_SLOT,
  JOURNEY_PALETTE_GROUP,
  JOURNEY_ROOT_TYPE,
  JOURNEY_ROUTE_TYPE,
  writtenPageId
} from "./journey-mode-model.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { JOURNEY_AUTHORING_EN, builderText } from "./journey-authoring-texts-en.js";
import type { StepTagWords } from "./step-canvas-adapter.js";

/** What this chunk reads of the designer's definitions, lent by the designer (`JOURNEY_AUTHORING_LENT`); see the module comment. */
export interface JourneyAuthoringLent {
  journeyComponentDefinitions: typeof journeyComponentDefinitions;
}

/** The note an own field that fills nothing carries in its inspector, under "Fills form field". */
export const JOURNEY_KEPT_IN_BROWSER_NOTE = JOURNEY_AUTHORING_EN["journey.designer.own.keptNote"];

/** What a worked-out value is numbered under: its type starts with the prefix the designer keeps for its own nodes. */
export const JOURNEY_WORKED_OUT_ID_PREFIX = "worked-out";

/** Types a presentation cannot hold (rule B), the data-scoping `container`, the form root and the designer's own. */
const NOT_OWN = [
  "repeatingSection",
  "dataGrid",
  "file",
  "signature",
  "steps",
  "step",
  "wizard",
  "wizardStep",
  "container",
  "form",
  JOURNEY_ROOT_TYPE,
  JOURNEY_PAGE_TYPE,
  JOURNEY_ROUTE_TYPE,
  JOURNEY_FIELD_TYPE,
  PRESENTATION_VALUE_TYPE
];

/** Capabilities a presentation's own field leaves out: where its answer is stored, how it prints, where its options come from. */
const DROPPED_CAPABILITIES = ["dataKey", "pdf", "pdf-attach", "dataSource"];

/** What an alias's answer is copied with when "Ask differently here…" makes it from a form field: how it is asked and bounded, never where it is stored. */
const ASKED_WITH = ["label", "description", "tooltip", "placeholder", "options", "required", "pattern", "patternMessage", "minLength", "maxLength", "min", "max", "prefix", "suffix"];

function fillsField(text?: BuilderTextOptions): PropertyEditorField {
  return {
    id: "fills",
    type: "select",
    propertyPath: "fills",
    label: builderText("journey.designer.own.fillsField", undefined, text),
    description: builderText("journey.designer.own.fillsField.description", undefined, text)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationOf(node: ComponentNode): Record<string, unknown> {
  return isRecord(node.configuration) ? node.configuration : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The words a journey-only field's box is tagged with on the Step view's canvas (`StepCanvas.tags`). */
export function stepTagWords(text?: BuilderTextOptions): StepTagWords {
  return { notSent: builderText("journey.designer.own.notSent", undefined, text) };
}

/** Whether a node of a designer tree is one of the presentation's own (not the designer's frame, not a reference). */
export function isOwnNode(node: ComponentNode): boolean {
  return node.type !== JOURNEY_ROOT_TYPE && node.type !== JOURNEY_PAGE_TYPE && node.type !== JOURNEY_ROUTE_TYPE && node.type !== JOURNEY_FIELD_TYPE;
}

/** Every node in `node`'s slots, all the way down, in document order. */
function within(node: ComponentNode): ComponentNode[] {
  const out: ComponentNode[] = [];
  const stack = Object.values(node.children ?? {})
    .flat()
    .reverse();
  while (stack.length > 0) {
    const next = stack.pop() as ComponentNode;
    out.push(next);
    stack.push(...Object.values(next.children ?? {}).flat().reverse());
  }
  return out;
}

/** The form indexed as the usability rules read it: each node by id, and each node's parent. */
export function formRecords(root: ComponentNode): { nodeById: Record<string, ComponentNode>; parentOf: Record<string, string> } {
  const nodeById: Record<string, ComponentNode> = Object.create(null);
  const parentOf: Record<string, string> = Object.create(null);
  const stack: ComponentNode[] = [root];
  // The level of each node on the stack (the root is 1): no node below the deepest level a tree
  // may nest is read, so a tree that holds itself ends.
  const levels: number[] = [1];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    const level = levels.pop() as number;
    nodeById[node.id] = node;
    if (level >= journeyMaxDepth()) {
      continue;
    }
    for (const child of Object.values(node.children ?? {}).flat()) {
      parentOf[child.id] = node.id;
      stack.push(child);
      levels.push(level + 1);
    }
  }
  return { nodeById, parentOf };
}

/** Whether `id` or one of its ancestors is in `placed`; the climb stops at the deepest level a tree may nest, so a parent map that loops ends. */
export function listedAbove(id: string, parentOf: Record<string, string>, placed: ReadonlySet<string>): boolean {
  let cursor: string | undefined = id;
  for (let step = 0; cursor !== undefined && step < journeyMaxDepth(); step += 1) {
    if (placed.has(cursor)) {
      return true;
    }
    cursor = parentOf[cursor];
  }
  return false;
}

/** What the presentation already does with the form's fields, as its tree stands: listed (with what is in them), filled and worked out — by node. */
function placedIn(tree: ComponentNode): { listed: Set<string>; filledBy: Map<string, string>; workedOutBy: Map<string, string> } {
  const listed = new Set<string>();
  const filledBy = new Map<string, string>();
  const workedOutBy = new Map<string, string>();
  for (const page of tree.children?.[JOURNEY_PAGES_SLOT] ?? []) {
    for (const node of within(page)) {
      const configuration = configurationOf(node);
      if (node.type === JOURNEY_FIELD_TYPE) {
        listed.add(stringOf(configuration.componentId));
      } else if (node.type === PRESENTATION_VALUE_TYPE) {
        workedOutBy.set(stringOf(configuration.to), node.id);
      } else if (stringOf(configuration.fills) !== "") {
        filledBy.set(stringOf(configuration.fills), node.id);
      }
    }
  }
  return { listed, filledBy, workedOutBy };
}

export interface JourneyAuthoringOptions {
  /** The form's component definitions, as the host registers them (absent: none, so own nodes are drawn but no page-only field is offered). */
  formDefinitions?: readonly ComponentDefinition[] | undefined;
  /** The form's palette (`BuilderController.componentTypes()`), whose order and groups the page-only groups follow. */
  formTypes?: readonly BuilderComponentType[] | undefined;
  /** Which leaves carry no answer. Absent: the engine's. */
  isValueless?: ((node: ComponentNode) => boolean) | undefined;
  /** The form as committed, for what an alias or a worked-out value may target. */
  formRoot(): ComponentNode;
  /** The journey's tree as the canvas shows it. */
  tree(): ComponentNode;
  /** The tree the controller is built with (absent: `tree()` as it is now), read once for the own types it holds, which get a card whether the host defines them or not. */
  root?: ComponentNode | undefined;
  /** The entry's page-id memory: a deleted page's id, which a page-only field does not take. */
  pageIds: ReadonlyMap<string, string>;
  /** What the designer lends this chunk. */
  lent: JourneyAuthoringLent;
}

/** Which box of an own node's inspector a finding about it is said under: what it fills or works out. */
const OWN_FINDING_BOXES: Readonly<Record<string, string>> = {
  "map.unknown-target": "fills",
  "map.target-unusable": "fills",
  "map.target-conflict": "to",
  "map.shape-mismatch": "fills",
  "map.options-not-subset": "fills",
  "map.target-hidden": "fills",
  "field.goes-nowhere": "fills"
};

/** The label of a node, in the builder's locale; `undefined` when it has none. */
function labelOf(node: ComponentNode, locale: string, sources: TextSources | undefined): string | undefined {
  const written = configurationOf(node).label;
  if (typeof written !== "string") {
    return undefined;
  }
  // A page-only node is worded under its own id, as the renderer resolves it.
  const text = resolveText(written, addressOf.component(node.id, "label"), locale, sources ?? {});
  return text.trim() !== "" ? text : undefined;
}

/** "Label (id)" for a form component. */
function formChoice(form: JourneyFormIndex, id: string): InspectorChoice {
  return { value: id, label: `${form.components.get(id)?.label ?? id} (${id})` };
}

/**
 * The definition a type of the form takes in a presentation: the form's own, less what an own
 * field leaves out, with "Fills form field" first for one that holds an answer, and slots that take page-only fields and references.
 */
function ownDefinition(
  definition: ComponentDefinition,
  ownTypes: readonly string[],
  holds: (node: ComponentNode) => boolean,
  text?: BuilderTextOptions
): ComponentDefinition {
  const capabilities = definition.capabilities.filter((capability) => !DROPPED_CAPABILITIES.includes(capability.id));
  const given = definition.propertyEditor;
  const editor: PropertyEditorDefinition | undefined = given && {
    ...given,
    ...(given.fields
      ? { fields: given.fields.filter((field) => field.propertyPath !== "dataKey" && !field.propertyPath.startsWith("pdf") && field.type !== "data-source-selector") }
      : {})
  };
  const probe: ComponentNode = { ...structuredClone(definition.createDefault()), id: definition.type, type: definition.type };
  let propertyEditor = editor;
  if (!definition.children && holds(probe) && editor?.mode !== "none") {
    // "Fills form field" first: the sections the inspector would draw, with one in front. Read
    // off the inspector's own grouping, field by field, so nothing else moves.
    const composed = composePropertyEditor(capabilities, { component: probe }, editor);
    const model = buildInspectorModel(probe, capabilities, editor);
    const unused = [...(composed?.fields ?? [])];
    const idOf = (propertyPath: string): string | undefined => {
      const at = unused.findIndex((field) => field.propertyPath === propertyPath);
      return at < 0 ? undefined : unused.splice(at, 1)[0]?.id;
    };
    propertyEditor = {
      ...(editor ?? {}),
      mode: editor?.mode === "replace" ? "replace" : "extend",
      fields: [...(editor?.fields ?? []), fillsField(text)],
      sections: [
        { id: "fills", title: builderText("journey.designer.own.fillsField", undefined, text), fieldIds: ["fills"] },
        ...model.sections.map((section) => ({
          id: section.id,
          ...(section.title !== undefined ? { title: section.title } : {}),
          fieldIds: section.fields.map((field) => idOf(field.propertyPath)).filter((id): id is string => id !== undefined)
        }))
      ]
    };
  }
  const slots = definition.children?.slots;
  return {
    type: definition.type,
    version: definition.version,
    createDefault: () => {
      const node = structuredClone(definition.createDefault());
      const configuration = configurationOf(node);
      delete configuration.dataKey;
      delete configuration.pdf;
      return { ...node, type: definition.type };
    },
    capabilities,
    ...(slots
      ? {
          children: {
            slots: slots.map((slot) => {
              const taken = slot.allowedTypes && slot.allowedTypes.length > 0 ? slot.allowedTypes.filter((type) => ownTypes.includes(type)) : [];
              return { ...slot, allowedTypes: taken.length > 0 ? taken : [JOURNEY_FIELD_TYPE, ...ownTypes] };
            })
          }
        }
      : {}),
    ...(propertyEditor ? { propertyEditor } : {})
  };
}

/**
 * The designer's options for one journey's controller (`base`) with the page-only fields laid
 * over them: the palette, the definitions and the page's slot that takes them, the inspector's
 * choices, notes and problems, the ids a new node avoids. Also lends the hooks (`context`) what
 * they say of own nodes.
 */
export function withJourneyAuthoring(base: BuilderControllerOptions, context: JourneyFacesContext, options: JourneyAuthoringOptions): BuilderControllerOptions {
  const { journeyComponentDefinitions } = options.lent;
  const isValueless = options.isValueless;
  const holds = (node: ComponentNode): boolean => holdsData(node, isValueless ? { isValueless } : {});
  const definitions = new Map((options.formDefinitions ?? []).map((definition) => [definition.type, definition]));
  // What the palette offers, in the form palette's groups and order: a type the form defines,
  // that a presentation may hold and that scopes no data as it starts.
  const offered = (options.formTypes ?? []).filter((entry) => {
    const definition = definitions.get(entry.type);
    if (!definition || NOT_OWN.includes(entry.type)) {
      return false;
    }
    const probe = definition.createDefault();
    const settings = configurationOf(probe);
    return !isDataScopeContainer(probe) && probe.collection === undefined && settings.dataKey === undefined;
  });
  const componentTypes: BuilderComponentType[] = [
    { type: PRESENTATION_VALUE_TYPE, label: builderText("journey.designer.own.workedOutValue", undefined, { locale: context.locale(), catalog: context.textCatalog?.() }), icon: "∑", group: JOURNEY_PALETTE_GROUP },
    ...groupPaletteEntries([...offered]).flatMap((group) =>
      group.entries.map((entry) => ({
        type: entry.type,
        label: entry.label,
        ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
        // The form palette's own group (Fields, Choices, Layout…), worded as the Form workspace words
        // it: that these fields are never sent is said on the placed field (its "Not sent" tag).
        group: group.label
      }))
    )
  ];
  // In the palette's order, which the page's and a layout's slots list them in.
  const ownTypes = componentTypes.slice(1).map((entry) => entry.type);

  const text = (): BuilderTextOptions => ({ locale: context.locale(), catalog: context.textCatalog?.() });
  const locale = (): string => context.locale();
  const named = (node: ComponentNode): string => labelOf(node, locale(), context.sources()) ?? node.id;
  /**
   * The form field the own field `id` fills, as the runtime takes it (the shared ownership's
   * `aliasOf`, rules E and F): a `fills` naming a field that is gone, worked out or hidden from
   * it fills nothing, and the answer stays in the browser. Before the tree can be written, as set.
   */
  const filled = (id: string, node: ComponentNode): string | undefined => {
    const set = stringOf(configurationOf(node).fills);
    const ownership = context.view().check.ownership;
    return set !== "" && (!ownership || ownership.aliasOf?.[id] === set) ? set : undefined;
  };
  const formLabel = (id: string): string => context.form().components.get(id)?.label ?? id;

  // The form's own types, derived; a type the tree holds that the host defines not (a hand-
  // written `columns`, a plugin's not registered here) is drawn all the same, with a label to edit.
  const componentDefinitions: ComponentDefinition[] = [
    {
      type: PRESENTATION_VALUE_TYPE,
      version: "1.0.0",
      createDefault: () => ({ id: PRESENTATION_VALUE_TYPE, type: PRESENTATION_VALUE_TYPE, configuration: { to: "" } }),
      capabilities: [],
      propertyEditor: {
        mode: "replace",
        fields: [
          {
            id: "to",
            type: "select",
            propertyPath: "to",
            label: builderText("journey.designer.ui.form-field", undefined, text()),
            description: builderText("journey.designer.ui.the-form-field-this-value-is-worked-out-into-on-th", undefined, text())
          },
          { id: "label", type: "localized-text", propertyPath: "label", label: builderText("journey.designer.ui.label", undefined, text()), description: builderText("journey.designer.ui.blank-the-form-field-s-own-label", undefined, text()) }
        ]
      }
    },
    ...ownTypes.map((type) => ownDefinition(definitions.get(type) as ComponentDefinition, ownTypes, holds, text()))
  ];
  for (const type of ownTypesIn(options.root ?? options.tree())) {
    if (!componentDefinitions.some((definition) => definition.type === type) && type !== PRESENTATION_REFERENCE_TYPE) {
      const given = definitions.get(type);
      componentDefinitions.push(
        given
          ? ownDefinition(given, ownTypes, holds, text())
          : {
              type,
              version: "1.0.0",
              createDefault: () => ({ id: type, type, configuration: {} }),
              capabilities: [],
              propertyEditor: { mode: "replace", fields: [{ id: "label", type: "localized-text", propertyPath: "label", label: builderText("journey.designer.ui.label", undefined, text()) }] }
            }
      );
    }
  }

  /** The form fields `node` may fill (`fills`) or work out (`to`), as the tree stands. */
  const targets = (node: ComponentNode, kind: "fills" | "to"): InspectorChoice[] => {
    const root = options.formRoot();
    const { nodeById, parentOf } = formRecords(root);
    const placed = placedIn(context.view().tree);
    const form = context.form();
    const listed = (id: string): boolean => listedAbove(id, parentOf, placed.listed);
    const others = (by: Map<string, string>, id: string): boolean => by.has(id) && by.get(id) !== node.id;
    return form.order
      .filter(
        (component) =>
          journeyTargetUsable(component.id, nodeById, parentOf, root.id) &&
          !listed(component.id) &&
          !others(placed.workedOutBy, component.id) &&
          (kind === "fills" ? journeyAliasFits(node.type, node.configuration, nodeById[component.id] as ComponentNode) : !others(placed.filledBy, component.id))
      )
      .map((component) => formChoice(form, component.id));
  };

  /**
   * Why "Fills form field" offers nothing but None, when it does not: one line under the box,
   * so an empty list is not taken for a fault.
   */
  const noFillReason = (node: ComponentNode): string | undefined => {
    if (targets(node, "fills").length > 0) {
      return undefined;
    }
    const root = options.formRoot();
    const { nodeById, parentOf } = formRecords(root);
    const fits = context
      .form()
      .order.some(
        (component) =>
          journeyTargetUsable(component.id, nodeById, parentOf, root.id) && journeyAliasFits(node.type, node.configuration, nodeById[component.id] as ComponentNode)
      );
    return fits ? builderText("journey.designer.own.allPlaced", undefined, text()) : builderText("journey.designer.own.noneToFill", undefined, text());
  };

  const form = (): JourneyFormIndex => context.form();
  const label = (node: ComponentNode): string | undefined =>
    node.type === PRESENTATION_VALUE_TYPE
      ? builderText("journey.designer.own.workedOutLabel", { field: labelOf(node, locale(), context.sources()) ?? (stringOf(configurationOf(node).to) !== "" ? formLabel(stringOf(configurationOf(node).to)) : builderText("journey.designer.own.noField", undefined, text())) }, text())
      : named(node);
  context.ownLabel = (node) => (isOwnNode(node) ? label(node) : undefined);
  context.ownIdRow = (node) =>
    isOwnNode(node)
      ? {
          mode: "edit",
          help: builderText("journey.designer.ui.the-page-only-field-s-id-what-this-journey-s-own-r", undefined, text())
        }
      : undefined;
  const designer = journeyComponentDefinitions(context, [PRESENTATION_VALUE_TYPE, ...ownTypes]);
  return {
    ...base,
    componentTypes: [...(base.componentTypes ?? []), ...componentTypes],
    componentDefinitions: [...designer, ...componentDefinitions],
    // A slot of an own layout its type does not declare (a grid's columns, a type the host does
    // not define) takes what a declared one does: never a page, a route or a worked-out value.
    otherSlots: (type) => (isOwnNode({ type } as ComponentNode) ? { multiple: true, allowedTypes: [JOURNEY_FIELD_TYPE, ...ownTypes] } : undefined),
    // A worked-out value is numbered apart from the prefix the designer keeps for its own nodes.
    idPrefix: (type) => (type === PRESENTATION_VALUE_TYPE ? JOURNEY_WORKED_OUT_ID_PREFIX : undefined),
    fieldChoices: (node, field) => {
      if (field.propertyPath === "fills" && isOwnNode(node) && node.type !== PRESENTATION_VALUE_TYPE) {
        return [{ value: "", label: builderText("journey.designer.own.noneKept", undefined, text()) }, ...targets(node, "fills")];
      }
      if (field.propertyPath === "to" && node.type === PRESENTATION_VALUE_TYPE) {
        return [{ value: "", label: builderText("journey.designer.ui.choose", undefined, text()) }, ...targets(node, "to")];
      }
      return base.fieldChoices?.(node, field);
    },
    // An own node's findings under what it fills or works out, the rest above the sections; and
    // for a field that fills nothing, where its answer is kept. When the box offers nothing but
    // None, why comes first, straight under it.
    notes: (edited, tree, componentId) =>
      !isOwnNode(edited)
        ? (base.notes?.(edited, tree, componentId) ?? [])
        : [
            ...(edited.type !== PRESENTATION_VALUE_TYPE && !edited.children && holds(edited)
              ? [noFillReason(edited)].filter((message): message is string => message !== undefined).map((message) => ({ target: "fills", message }))
              : []),
            // The node the inspector edits is the first holding its id: the findings about it.
            ...(context.view().check.findings.byNode.get(componentId) ?? []).filter((finding) => !finding.repeat).map((finding) => {
              const box = OWN_FINDING_BOXES[finding.code];
              return {
                ...(box !== undefined ? { target: edited.type === PRESENTATION_VALUE_TYPE && box === "fills" ? "to" : box } : {}),
                message: finding.message,
                severity: finding.severity
              };
            }),
            ...(edited.type !== PRESENTATION_VALUE_TYPE && !edited.children && holds(edited) && filled(componentId, edited) === undefined
              ? [{ target: "fills", message: JOURNEY_KEPT_IN_BROWSER_NOTE }]
              : [])
          ],
    problems: (edited, tree, componentId) => {
      const found = base.problems?.(edited, tree, componentId) ?? [];
      if (!isOwnNode(edited)) {
        return found;
      }
      const id = edited.id.trim();
      const why =
        id === form().rootId || form().components.has(id)
          ? `“${id}” is the id of a component of the form; a page-only field needs one of its own.`
          : (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).map(writtenPageId).includes(id)
            ? `“${id}” is the id of a page of this journey; give the field another.`
            : id === "journey" || id.startsWith("journey-")
              ? builderText("journey.designer.own.reservedId", undefined, text())
              : undefined;
      return why !== undefined ? [...found, { target: "id", message: why }] : found;
    },
    // A page-only field dropped in takes no form component's id and no page's.
    reservedIds: () => [
      ...(base.reservedIds?.() ?? []),
      form().rootId,
      ...form().components.keys(),
      ...options.pageIds.values(),
      ...(options.tree().children?.[JOURNEY_PAGES_SLOT] ?? []).map(writtenPageId)
    ]
  };
}

/**
 * "Ask differently here…": what takes the place of the question `nodeId` — a form
 * field reused on a page, at its top or inside a layout of the journey's own — a field of the
 * journey's own of the same type that fills it, its label, help, options and constraints
 * (required, pattern, lengths, bounds) copied from the form field, under an id nothing has (the
 * form's ids, every id in the tree, the page ids and what the designer keeps back, `keep`). What
 * the mode puts in the question's place as one undo step; `undefined` when `nodeId` is no
 * question of a form component.
 */
export function askDifferently(
  tree: ComponentNode,
  nodeId: string,
  formRoot: ComponentNode,
  keep: { pageIds?: ReadonlyMap<string, string> | undefined; references?: ReadonlyMap<string, unknown> | undefined }
): { node: ComponentNode; id: string } | undefined {
  const { nodeById } = formRecords(formRoot);
  const ids = new Set([
    ...Object.keys(nodeById),
    ...(keep.pageIds?.keys() ?? []),
    ...(keep.pageIds?.values() ?? []),
    ...(keep.references?.keys() ?? []),
    ...(tree.children?.[JOURNEY_PAGES_SLOT] ?? []).map(writtenPageId)
  ]);
  const all = within(tree);
  for (const node of [tree, ...all]) {
    ids.add(node.id);
  }
  const question = all.find((node) => node.id === nodeId && node.type === JOURNEY_FIELD_TYPE);
  const componentId = question ? stringOf(configurationOf(question).componentId) : "";
  const target = nodeById[componentId];
  if (!target || componentId === formRoot.id) {
    return undefined;
  }
  let n = 1;
  while (ids.has(`${target.type}_${n}`)) {
    n += 1;
  }
  const from = configurationOf(target);
  const configuration: Record<string, unknown> = {};
  for (const key of ASKED_WITH) {
    if (from[key] !== undefined) {
      configuration[key] = structuredClone(from[key]);
    }
  }
  configuration.fills = componentId;
  const id = `${target.type}_${n}`;
  return { node: { id, type: target.type, configuration }, id };
}

/**
 * Whether "Ask differently here…" is offered on the question `nodeId`: {@link askDifferently}
 * can make its replacement, the replacement's type is one the journey's palette offers as a
 * page-only field (`offeredTypes`), and the form field is one a page-only field may fill (a
 * value field, not worked out, not hidden from the journey). What the cards offered it on.
 */
export function askDifferentlyOffered(
  tree: ComponentNode,
  nodeId: string,
  formRoot: ComponentNode,
  keep: { pageIds?: ReadonlyMap<string, string> | undefined; references?: ReadonlyMap<string, unknown> | undefined },
  offeredTypes: readonly string[]
): boolean {
  const plan = askDifferently(tree, nodeId, formRoot, keep);
  const fills = plan ? stringOf(configurationOf(plan.node).fills) : "";
  if (!plan || !offeredTypes.includes(plan.node.type) || fills === "") {
    return false;
  }
  const { nodeById, parentOf } = formRecords(formRoot);
  return journeyTargetUsable(fills, nodeById, parentOf, formRoot.id);
}

/**
 * The journey's own fields a rule of the node `nodeId` may read, "Label (page-only
 * type)": for a worked-out value, those of its page (`alone`: nothing else); for any other
 * node of the journey's own, every one on any page but itself, beside the form's fields.
 * `undefined` for a node the journey does not own.
 */
export function ownRuleFields(
  tree: ComponentNode,
  nodeId: string,
  locale: string,
  sources: TextSources | undefined,
  isValueless?: ((node: ComponentNode) => boolean) | undefined
): { choices: InspectorChoice[]; alone: boolean } | undefined {
  const pages = tree.children?.[JOURNEY_PAGES_SLOT] ?? [];
  const page = pages.find((candidate) => within(candidate).some((held) => held.id === nodeId));
  const node = page ? within(page).find((held) => held.id === nodeId) : undefined;
  if (!node || !isOwnNode(node)) {
    return undefined;
  }
  const alone = node.type === PRESENTATION_VALUE_TYPE;
  const choices = (alone ? [page as ComponentNode] : pages)
    .flatMap(within)
    .filter(
      (held) =>
        held.id !== nodeId && isOwnNode(held) && held.type !== PRESENTATION_VALUE_TYPE && !held.children && holdsData(held, isValueless ? { isValueless } : {})
    )
    .map((held) => ({ value: held.id, label: `${labelOf(held, locale, sources) ?? held.id} (page-only ${held.type})` }));
  return { choices, alone };
}

/** The own types a journey's tree holds, for the faces of types the host does not define. */
export function ownTypesIn(tree: ComponentNode): Set<string> {
  return new Set(within(tree).filter((node) => isOwnNode(node) && node.type !== PRESENTATION_REFERENCE_TYPE).map((node) => node.type));
}
