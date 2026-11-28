import { ownValue, type FormState } from "../../core/state/form-state.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import {
  buildAccessibilitySemantics,
  type AccessibilityOptions,
  type AccessibilitySemantics
} from "../../core/accessibility/accessibility-semantics.js";
import { workedOutTextOwner } from "../../core/journey/worked-out-text.js";
import { addressOf, resolveText, type FormTranslations } from "../../core/localization/translations.js";
import {
  BUTTON_COMPONENT_TYPE,
  readButtonAction,
  readButtonSignature,
  readButtonSize,
  readButtonVariant,
  type ButtonSignature,
  type ButtonSize,
  type ButtonVariant
} from "../../core/schema/button.js";
import { HTML_COMPONENT_TYPE, sanitizeStaticHtml } from "../../core/schema/static-html.js";
import { IMAGE_COMPONENT_TYPE, readImageConfiguration } from "../../core/schema/image.js";
import {
  FILE_COMPONENT_TYPE,
  readFileAttachments,
  readFileUploadConfiguration,
  type FileAttachment,
  type FileUploadConfiguration
} from "../../core/schema/file-upload.js";
import { readGridColumnCount } from "../../core/schema/grid.js";
import { readLengthLimits } from "../../core/schema/length-limits.js";
import { readControlHints, type InputMode } from "../../core/schema/control-hints.js";
import { readComponentClassNames } from "../../core/schema/component-classes.js";
import type { ComponentOptionState } from "./component-options.js";
import { buildRowKeys, collectionPathOf, createValuePathResolver } from "../../core/tree/data-scope.js";
import { parseComponentPath, stringifyComponentPath } from "../../core/tree/component-path.js";
import { DATA_GRID_ROWS_CAP } from "../../core/schema/data-grid.js";
import { resolveFieldLocking } from "./render-policy.js";
import { isBlockingError, wordComponentErrors, type ErrorWordingSources } from "./error-wording.js";

import { LAYOUT_CONTAINER_TYPES } from "../../registry/engine-component-types.js";

export interface LayoutSpec {
  /** `stack` = one item per row (default). `grid` = several per row. */
  kind: "stack" | "grid";
  /** Column count for `grid` (from `configuration.columns`, default 2). */
  columns?: number;
}

export interface RenderComponentModel {
  id: string;
  type: string;
  /**
   * Where this component's value lives in form state: its own segment (its data key, else its
   * id), prefixed by the segment of every data-scoping `container` above it — see
   * `core/tree/data-scope.ts`. State is a flat map keyed by this path. Rules, errors and
   * selection all still address the component by `id`; only the datum moves.
   */
  valuePath: string;
  /**
   * For a component inside a repeating section: its key within one entry of the section
   * (`sku`, or `address.city` under a data-scoping container in the entry), which is how an
   * entry's row object and a PDF's `{{row.…}}` name it. Absent outside a section.
   */
  rowKey?: string;
  /**
   * The source node. Carried by reference so a component-supplied renderer can read its own
   * `configuration` — everything else here is the engine's resolved view of it, which cannot
   * anticipate what a custom component type needs.
   */
  node: ComponentNode;
  label: string;
  description: string | undefined;
  /** Ghost text for an empty control (`configuration.placeholder`), resolved for the locale. */
  placeholder: string | undefined;
  /**
   * What flanks a single-line box (`configuration.prefix` / `suffix`), resolved for
   * the locale: a currency sign, a unit. Decorative in the markup (`aria-hidden`), so the
   * label or description carries the unit for assistive technology. Optional keys, so a
   * hand-built model for a renderer test needs neither.
   */
  prefix?: string | undefined;
  suffix?: string | undefined;
  /** Short help (`configuration.tooltip`), resolved for the locale. */
  tooltip: string | undefined;
  /**
   * `configuration.pattern` — the regular expression the value must match, source text only.
   * Present here so the markup can hint it to the browser; the authoritative check is the
   * `field-constraints` validation stage, which runs on every runtime.
   */
  pattern: string | undefined;
  /**
   * `configuration.minLength` / `maxLength`, read by the same rules the `field-constraints`
   * stage enforces them under (`core/schema/length-limits.ts`) — so the `minlength` hint the
   * markup emits never promises something the check will not keep. The markup writes no
   * `maxlength`: the browser would count it in code units, the check counts code points.
   */
  minLength: number | undefined;
  maxLength: number | undefined;
  /**
   * Draw the character count under a text or textarea control (`configuration.characterCount`
   * beside a `maxLength`), in code points as the `field-constraints` stage counts,
   * so the person can see how far over the limit a pasted answer runs; the stage still refuses
   * it. Optional, so a hand-built model for a renderer test needs none.
   */
  characterCount?: boolean;
  /**
   * The browser hints a text control carries (`configuration.autocomplete` / `inputmode` /
   * `spellcheck`, see `core/schema/control-hints.ts`), each absent when not authored or
   * malformed. Optional keys, so a hand-built model for a renderer test needs none of them.
   */
  autocomplete?: string | undefined;
  inputMode?: InputMode | undefined;
  spellcheck?: boolean | undefined;
  /** Author-supplied classes (`configuration.cssClass`), reduced to valid tokens. */
  classNames: string[];
  /**
   * Render the label visually hidden. It stays the control's accessible name, so this is a
   * presentation choice rather than a way to drop the label.
   */
  hideLabel: boolean;
  value: unknown;
  /**
   * An async validation stage that declares this field's value path is running
   * (`FormState.validation.pending`): the answer is being checked. Absent otherwise, and on a
   * hand-built model.
   */
  pending?: true;
  visible: boolean;
  /** Switched off: by the field's own configuration, a rule or an ancestor (see `FieldLocking`). */
  disabled: boolean;
  /**
   * Shows an answer it will not take: by configuration, a rule, an ancestor, a worked-out value,
   * or the render mode (see {@link lockedByMode}). Independent of {@link disabled}.
   */
  readOnly: boolean;
  /** The render mode (readonly, pdf) is what makes the field read-only; `false` while interactive. Optional, so a hand-built model needs none. */
  lockedByMode?: boolean;
  /** Every error and warning raised on the field, as the runtime reported them. */
  errors: FormError[];
  /** The errors that block the form (severity `error`): what makes the field invalid and what the summary lists. */
  blockingErrors: FormError[];
  /**
   * The blocking errors worded for the form's language, one per entry of {@link blockingErrors}
   * in the same order: the field's catalog over its containers', the page's, then the engine's. Optional, so a hand-built model for a renderer test needs none.
   */
  errorMessages?: string[];
  /** The warnings and info messages on the field, worded; never blocking and never in the summary. */
  notices?: RenderNotice[];
  accessibility: AccessibilitySemantics;
  optionState: ComponentOptionState;
  /** Parent component id (undefined for the form root). */
  parentId: string | undefined;
  /**
   * The parent slot this node occupies (undefined for the form root). Carried so a renderer
   * can address a drop target as `{ parentId, slotId }` without re-walking the source tree.
   */
  slotId: string | undefined;
  /** Depth from the root (root = 0). */
  depth: number;
  /**
   * Ancestor layout-container ids, outermost first, that this node renders inside.
   * Non-layout containers are not included, so their children still stack.
   */
  containerPath: string[];
  /** The layout this node imposes on its own children (`stack` unless it is a layout container). */
  layout: LayoutSpec;
  /** `layout.kind !== "stack"`. */
  isLayoutContainer: boolean;
  /**
   * For a `button` component, its configured action (see `core/schema/button.ts`);
   * `undefined` for every other type, and for a button with no action configured yet.
   */
  buttonAction: string | undefined;
  /** For a `button`, its emphasis and size. `undefined` means the theme's default. */
  buttonVariant: ButtonVariant | undefined;
  buttonSize: ButtonSize | undefined;
  /** For a `button`, how its submit is signed; `undefined` for an unsigned submit and every other type. */
  buttonSignature: ButtonSignature | undefined;
  /**
   * For an `html` component, its authored content — localized and already run through
   * {@link sanitizeStaticHtml}. Sanitizing here rather than in the markup means every render
   * surface gets the same safe string, and no caller can forget to ask for it.
   */
  staticHtml: string | undefined;
  /**
   * For an `image` component, the picture to show: the URL already checked by
   * `readImageConfiguration` (unsafe reads as none), the alternative text resolved for the
   * locale, and any fixed size. `undefined` for every other type.
   */
  image: RenderImageModel | undefined;
  /**
   * For a `file` component, its configuration as `readFileUploadConfiguration` reads it and
   * the attachments its value holds — resolved here so the markup lists names and sizes
   * without re-deriving the value's shape. `undefined` for every other type.
   */
  file: RenderFileModel | undefined;
  /**
   * The read-only copy of a form field that a running presentation works out from the person's
   * answers (a `journey-value`): drawn read-only whatever its state says, with a line
   * saying where the value comes from (the `workedOut` form text, described to the control as
   * {@link workedOutNoteId}). Optional, so a hand-built model needs none.
   */
  workedOut?: boolean;
  /**
   * For a model drawn inside one row of a collection-bound container (a data grid, a repeating
   * section): which row. Its `valuePath` is then the entry's (`items[1].sku`) and its
   * accessibility ids carry the path, so every row's controls are distinct elements. Absent on
   * every other model, the template children included.
   */
  row?: RenderRowScope | undefined;
  /**
   * For a collection-bound container: its rows, each the models of its children as
   * drawn at that entry. The container's children in the flat model list stay the row's
   * template (their own ids, their bare paths), which the builder's canvas draws; the live form
   * draws these. Absent on every other model, and on a collection-bound container inside
   * another's template, which is drawn as a plain group of the outer row.
   */
  rows?: RenderCollectionRows | undefined;
}

/** A non-blocking message on a field (a warning or info), worded for the form's language. */
export interface RenderNotice {
  code: string;
  severity: "warning" | "info";
  message: string;
}

/** Where a row-drawn model sits: the collection, the entry, and the container that owns them. */
export interface RenderRowScope {
  /** Where the entries live (`collection.collectionPath`, else the container's id). */
  collectionPath: string;
  /** The entry's position, 0-based. */
  index: number;
  /** The collection-bound container's component id. */
  ownerId: string;
  /**
   * The entry's stable identity (`FormRuntime.entryKeys`): it stays with the entry when rows
   * are added, removed or moved, where `index` changes. Absent when the model was built
   * without a runtime's keys (a hand-built request).
   */
  rowKey?: string | undefined;
}

/** A collection-bound container's rows as drawn. */
export interface RenderCollectionRows {
  collectionPath: string;
  /**
   * Each row's models, in document order: `entries[i]` holds every descendant of the
   * container drawn at entry `i`, its first-level children parented on the container itself.
   */
  entries: RenderComponentModel[][];
}

/**
 * How many entries a collection holds in the answers: one past the highest entry index any key
 * `collectionPath[n].…` carries. The runtime keeps a key for every field of every row it draws,
 * an empty one included, so a row with nothing typed in yet is still counted.
 */
export function collectionEntryCount(values: Readonly<Record<string, unknown>>, collectionPath: string): number {
  const prefix = `${collectionPath}[`;
  let count = 0;
  for (const key of Object.keys(values)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const close = key.indexOf("]", prefix.length);
    if (close <= prefix.length || key.charAt(close + 1) !== ".") {
      continue;
    }
    const digits = key.slice(prefix.length, close);
    if (!/^(?:0|[1-9][0-9]*)$/.test(digits)) {
      continue;
    }
    const index = Number(digits);
    if (index + 1 > count) {
      count = index + 1;
    }
  }
  // A key naming an entry far past the rest is drawn no further than a grid may hold.
  return count > DATA_GRID_ROWS_CAP ? DATA_GRID_ROWS_CAP : count;
}

/** The id of the line under a worked-out value's copy, which describes its control. */
export function workedOutNoteId(fieldId: string): string {
  return `${fieldId}__worked-out`;
}

export interface RenderImageModel {
  src: string | undefined;
  alt: string;
  width: number | undefined;
  height: number | undefined;
}

export interface RenderFileModel extends FileUploadConfiguration {
  attachments: FileAttachment[];
}

function readNumberConfiguration(configuration: unknown, key: string): number | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const value = (configuration as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function layoutForNode(node: ComponentNode): LayoutSpec {
  if (!LAYOUT_CONTAINER_TYPES.has(node.type)) {
    return { kind: "stack" };
  }
  // The same reading the grid's column slots come from, so a grid's cells and its tracks
  // never disagree about how many columns there are.
  return { kind: "grid", columns: readGridColumnCount(node.configuration) };
}

export interface ContainerDescriptor {
  type: string;
  layout: LayoutSpec;
  /**
   * The node's declared slot ids, in authored order — including slots that hold no children.
   * A renderer that draws per-slot affordances (the builder's drop zones) needs the empty
   * ones too, and they are invisible in the flat model list.
   */
  slotIds: string[];
}

/** Layout descriptor for every container node (has children), keyed by component id. */
export function buildContainerLayouts(root: ComponentNode): Record<string, ContainerDescriptor> {
  const out: Record<string, ContainerDescriptor> = {};
  const walk = (node: ComponentNode): void => {
    if (!node.children) {
      return;
    }
    out[node.id] = {
      type: node.type,
      layout: layoutForNode(node),
      slotIds: Object.keys(node.children)
    };
    for (const group of Object.values(node.children)) {
      for (const child of group) {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Per-render inputs beyond the raw tree + state: effective semantic state, requiredness,
 * grouped errors, and accessibility options. All optional so lower layers / tests can
 * still build models from configuration alone.
 */
export interface RenderModelContext {
  readOnlyByMode: boolean;
  effectiveStates?: ReadonlyMap<string, EffectiveNodeState> | undefined;
  /**
   * Per-component requiredness from the runtime (`requiredMap`): `required` OR `requiredWhen`. The marker shows when this says so or the static tick is set.
   */
  requiredByComponent?: ReadonlyMap<string, boolean> | undefined;
  errorsByComponent?: ReadonlyMap<string, FormError[]> | undefined;
  accessibilityOptions?: AccessibilityOptions | undefined;
  /** The page's message catalog and form texts the errors are worded from; the definition's own wording applies without it. */
  wording?: ErrorWordingSources | undefined;
  /** The language the form's texts are shown in. Defaults to `"en"`. */
  locale?: string | undefined;
  /** The definition's own translations (`FormDefinition.translations`), if any. */
  translations?: FormTranslations | undefined;
  /** Host-supplied translations (`FormRuntimeDependencies.translationCatalog`), if any; an entry there wins over the map's. */
  translationCatalog?: TranslationCatalog | undefined;
  /**
   * Where the answers of some components live when the tree's own path builder would say
   * otherwise: a running presentation's nodes, as the runtime answers for them
   * (`FormRuntime.presentationValuePathOf`) — an alias at the value path of the form field it
   * fills, a worked-out value's copy at the one it shows, any other own field at its `@` key.
   * The model reads and writes there. Absent, every path is the tree's.
   */
  valuePathOverrides?: ReadonlyMap<string, string> | undefined;
  /**
   * The components drawn as a worked-out value's read-only copy: the nodes of a
   * running presentation's `journey-value` entries. Their models are read-only whatever their
   * state says, and carry {@link RenderComponentModel.workedOut}.
   */
  workedOutComponents?: ReadonlySet<string> | undefined;
  /** The stable key of each collection's entries by collection path (`FormRuntime.entryKeysByCollection`); a row model carries its entry's as `row.rowKey`. */
  entryKeys?: ReadonlyMap<string, readonly string[]> | undefined;
}

export function flattenComponentTree(root: ComponentNode): ComponentNode[] {
  const nodes: ComponentNode[] = [];

  const walk = (node: ComponentNode): void => {
    nodes.push(node);
    if (!node.children) {
      return;
    }
    for (const group of Object.values(node.children)) {
      for (const child of group) {
        walk(child);
      }
    }
  };

  walk(root);
  return nodes;
}

/** A plain (non-localized) string configuration value; `undefined` when absent or empty. */
function readStringConfiguration(configuration: unknown, key: string): string | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const value = (configuration as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBooleanConfiguration(configuration: unknown, key: string): boolean {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return false;
  }
  return (configuration as Record<string, unknown>)[key] === true;
}

/** Reads a text a component authors: a non-empty string in the form's default language. */
function readTextConfiguration(configuration: unknown, key: string): string | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const value = (configuration as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildComponentModels(
  root: ComponentNode,
  state: FormState,
  optionStates: Record<string, ComponentOptionState>,
  context: RenderModelContext
): RenderComponentModel[] {
  const models: RenderComponentModel[] = [];
  const valuePathFor = createValuePathResolver(root);
  const rowKeys = buildRowKeys(root);

  /**
   * Where a model drawn in a row keeps its answer and its ids: the entry's value
   * path, the instance path its accessibility ids are suffixed with, and the row.
   */
  interface RowInstance {
    valuePath: string;
    idPath: string;
    row: RenderRowScope;
  }

  const buildOne = (
    node: ComponentNode,
    parentId: string | undefined,
    slotId: string | undefined,
    depth: number,
    containerPath: string[],
    instance?: RowInstance
  ): RenderComponentModel => {
    const effective = context.effectiveStates?.get(node.id);
    const configReadOnly = readBooleanConfiguration(node.configuration, "readOnly");
    const configDisabled = readBooleanConfiguration(node.configuration, "disabled");
    const configHidden = readBooleanConfiguration(node.configuration, "hidden");

    const visible = effective ? effective.visible : !configHidden;
    // A worked-out value's copy takes the form field's state, but is never a control
    // the person can change: the browser works its value out.
    const workedOut = context.workedOutComponents?.has(node.id) === true;
    const { readOnly, disabled, lockedByMode } = resolveFieldLocking({
      readOnlyByMode: context.readOnlyByMode,
      workedOut,
      effective,
      configured: { readOnly: configReadOnly, disabled: configDisabled }
    });
    // Required OR Required when: the runtime's map already ORs the tick in, and a
    // map that leaves a component out (a test's, a host's) still shows its tick.
    const required =
      context.requiredByComponent?.get(node.id) === true ||
      readBooleanConfiguration(node.configuration, "required");
    // In a row, only the errors raised at that entry's key are the control's.
    const errors = (context.errorsByComponent?.get(node.id) ?? []).filter(
      (error) => instance === undefined || (error.path !== undefined && stringifyComponentPath(error.path) === instance.valuePath)
    );
    const locale = context.locale ?? "en";
    // A component's texts are strings in the form's default language; the map and the host's
    // catalog word them for the locale at `components › <id> › <property>`.
    const sources = { translations: context.translations, catalog: context.translationCatalog };
    const text = (property: string): string | undefined => {
      const authored = readTextConfiguration(node.configuration, property);
      return authored === undefined ? undefined : resolveText(authored, addressOf.component(workedOutTextOwner(node, property), property), locale, sources);
    };
    const description = text("description");
    const layout = layoutForNode(node);

    const tooltip = text("tooltip");

    const lengths = readLengthLimits(node.configuration);
    // A counted field describes its limit to the control beside its description.
    const characterCount = lengths.characterCount === true && (node.type === "text" || node.type === "textarea");

    const accessibility = buildAccessibilitySemantics({
      componentId: node.id,
      // A row's control carries its entry's path in its ids, so they are unique per row and
      // the same on every repaint.
      ...(instance !== undefined ? { path: parseComponentPath(instance.idPath) } : {}),
      required,
      readonly: readOnly,
      disabled,
      errors,
      hasDescription: description !== undefined,
      hasCount: characterCount,
      ...(context.accessibilityOptions ? { options: context.accessibilityOptions } : {})
    });
    if (workedOut) {
      // The line saying the value is worked out describes the control, after its own help.
      accessibility.ariaDescribedBy.splice(accessibility.descriptionId !== undefined ? 1 : 0, 0, workedOutNoteId(accessibility.fieldId));
    }

    const valuePath = instance?.valuePath ?? context.valuePathOverrides?.get(node.id) ?? valuePathFor(node.id);
    const rowKey = rowKeys.get(node.id);

    return {
      id: node.id,
      type: node.type,
      valuePath,
      ...(rowKey !== undefined ? { rowKey } : {}),
      node,
      label: text("label") ?? node.id,
      description,
      placeholder: text("placeholder"),
      tooltip,
      prefix: text("prefix"),
      suffix: text("suffix"),
      pattern: readStringConfiguration(node.configuration, "pattern"),
      minLength: lengths.minLength,
      maxLength: lengths.maxLength,
      characterCount,
      ...readControlHints(node.configuration),
      classNames: readComponentClassNames(node.configuration),
      hideLabel: readBooleanConfiguration(node.configuration, "hideLabel"),
      value: ownValue(state.values, valuePath),
      // `?.` on `validation` too: a state a test or a designer builds by hand may leave it out.
      ...(state.validation?.pending?.has(valuePath) === true ? { pending: true as const } : {}),
      visible,
      disabled,
      readOnly,
      lockedByMode,
      errors,
      blockingErrors: errors.filter(isBlockingError),
      // Worded once the whole list is built (`wordComponentErrors`): a catalog layers down the parent chain.
      errorMessages: [],
      notices: [],
      accessibility,
      optionState: optionStates[node.id] ?? {
        componentId: node.id,
        status: "not-applicable",
        items: []
      },
      parentId,
      slotId,
      depth,
      containerPath: [...containerPath],
      layout,
      isLayoutContainer: layout.kind !== "stack",
      buttonAction:
        node.type === BUTTON_COMPONENT_TYPE ? readButtonAction(node.configuration) : undefined,
      buttonVariant:
        node.type === BUTTON_COMPONENT_TYPE ? readButtonVariant(node.configuration) : undefined,
      buttonSize:
        node.type === BUTTON_COMPONENT_TYPE ? readButtonSize(node.configuration) : undefined,
      buttonSignature:
        node.type === BUTTON_COMPONENT_TYPE ? readButtonSignature(node.configuration) : undefined,
      staticHtml:
        node.type === HTML_COMPONENT_TYPE
          ? sanitizeStaticHtml(text("content") ?? "")
          : undefined,
      image:
        node.type === IMAGE_COMPONENT_TYPE
          ? {
              ...readImageConfiguration(node.configuration),
              alt: text("alt") ?? ""
            }
          : undefined,
      file:
        node.type === FILE_COMPONENT_TYPE
          ? {
              ...readFileUploadConfiguration(node.configuration),
              attachments: readFileAttachments(ownValue(state.values, valuePath))
            }
          : undefined,
      ...(workedOut ? { workedOut: true } : {}),
      ...(instance !== undefined ? { row: instance.row } : {})
    };
  };

  /**
   * A collection-bound container's rows: its children drawn once per entry the
   * answers hold, each at `collectionPath[i].<row key>`, its ids suffixed by that entry path.
   */
  const buildRows = (
    owner: ComponentNode,
    collectionPath: string,
    depth: number,
    containerPath: string[]
  ): RenderCollectionRows => {
    const count = collectionEntryCount(state.values, collectionPath);
    const entries: RenderComponentModel[][] = [];
    for (let index = 0; index < count; index += 1) {
      const entryKey = context.entryKeys?.get(collectionPath)?.[index];
      const row: RenderRowScope = { collectionPath, index, ownerId: owner.id, ...(entryKey !== undefined ? { rowKey: entryKey } : {}) };
      const out: RenderComponentModel[] = [];
      const entryPath = `${collectionPath}[${index}]`;
      const walkRow = (node: ComponentNode, parentId: string, slotId: string, nodeDepth: number, path: string[]): void => {
        const rowKey = rowKeys.get(node.id);
        const valuePath = rowKey !== undefined ? `${entryPath}.${rowKey}` : (context.valuePathOverrides?.get(node.id) ?? valuePathFor(node.id));
        const model = buildOne(node, parentId, slotId, nodeDepth, path, {
          valuePath,
          idPath: rowKey !== undefined ? valuePath : `${entryPath}.${node.id}`,
          row
        });
        out.push(model);
        if (!node.children) {
          return;
        }
        // A collection-bound container inside a row is drawn as a plain group of that row, its
        // binding ignored: its entries would otherwise be one list shared
        // by every row of the outer one. Nested repeating structures are not supported; the
        // builder's grid slot refuses them.
        const childPath = LAYOUT_CONTAINER_TYPES.has(node.type) ? [...path, node.id] : path;
        for (const [childSlotId, group] of Object.entries(node.children)) {
          for (const child of group) {
            walkRow(child, node.id, childSlotId, nodeDepth + 1, childPath);
          }
        }
      };
      for (const [childSlotId, group] of Object.entries(owner.children ?? {})) {
        for (const child of group) {
          walkRow(child, owner.id, childSlotId, depth + 1, containerPath);
        }
      }
      entries.push(out);
    }
    return { collectionPath, entries };
  };

  const walk = (
    node: ComponentNode,
    parentId: string | undefined,
    slotId: string | undefined,
    depth: number,
    containerPath: string[],
    inCollection: boolean
  ): void => {
    const model = buildOne(node, parentId, slotId, depth, containerPath);
    models.push(model);
    if (!node.children) {
      return;
    }
    const childContainerPath = LAYOUT_CONTAINER_TYPES.has(node.type)
      ? [...containerPath, node.id]
      : containerPath;
    // A collection-bound container below the root: its rows beside its template. One
    // inside another's template is a plain group of the outer row, so it has none.
    const collectionPath = parentId !== undefined && !inCollection ? collectionPathOf(node) : undefined;
    if (collectionPath !== undefined) {
      model.rows = buildRows(node, collectionPath, depth, childContainerPath);
    }
    for (const [childSlotId, group] of Object.entries(node.children)) {
      for (const child of group) {
        walk(child, node.id, childSlotId, depth + 1, childContainerPath, inCollection || collectionPath !== undefined);
      }
    }
  };

  walk(root, undefined, undefined, 0, [], false);
  wordComponentErrors(models, {
    ...context.wording,
    locale: context.locale ?? "en",
    translations: context.translations,
    translationCatalog: context.translationCatalog
  });
  return models;
}
