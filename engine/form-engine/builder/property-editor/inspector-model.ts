import type {
  CapabilityDefinition,
  PropertyEditorDefinition,
  PropertyEditorField,
  PropertyEditorFieldType
} from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import { parseInlineOptions, type InlineOption } from "../../core/schema/inline-options.js";
import { readSourceId } from "../../core/schema/data-source-capability.js";
import { readFormChromeParts, type FormChromePart, type FormChromeRegion } from "../../core/schema/form-chrome.js";
import { frameOptions as builtinFrameOptions, type FrameOption } from "../../render/live/datum/frames.js";
import {
  ENGINE_VALIDATION_CODES,
  type ValidationCodeDescription
} from "../../core/localization/validation-messages.js";
import { validationCodesRaisedBy } from "../../validation/core/field-constraints.js";
import type { LocalizedText, PropertyEditorAssetChoice } from "../../core/schema/contracts.js";
import { composePropertyEditor } from "./editor-composer.js";
import { DATA_KEY_PROPERTY } from "../../core/tree/data-scope.js";
import { HIDDEN_VALUE_FIELD } from "../../registry/capabilities/field-capabilities.js";
import { defaultHiddenValueBehaviorFor } from "../../core/state/effective-state.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import { isValidPattern } from "../../core/schema/pattern-validity.js";
import { builderText, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";
import { EMAIL_PRESET_MESSAGE, EMAIL_PRESET_PATTERN, readControlHints } from "../../core/schema/control-hints.js";
import { ruleText } from "./rule-source.js";
import type { DrawingCapabilityId, DrawingSupport } from "../../registry/capabilities/drawing-capabilities.js";
import { drawnBaseOf, kindOf } from "../../registry/kinds.js";
import { keepTogetherApplies, paperOnlyApplies } from "../../render/core/print-options.js";

export type InspectorControl =
  | "text"
  | "number"
  | "checkbox"
  | "select"
  | "localized-text"
  | "expression"
  /** Inline options: a summary row whose button opens the options editor. */
  | "options"
  /** Validation messages per code: a summary row whose button opens the same table editor. */
  | "messages"
  /** A chrome region's parts (the form root's header or footer): a summary row whose button opens the parts editor. */
  | "chrome"
  /** A file kept in the configuration: a summary of what is set, a picker, and a way to remove it. */
  | "file"
  /** A formula in the Rules tab's editor, drawn inside the Field tab's row (the value is a rule's stored shape). */
  | "formula"
  /** A table of values and what each is translated to (the PDF designer's value map): a select per row and a button that pairs them by order. */
  | "value-map"
  | "custom";

/** One authored validation message as the editor lists it. */
export interface ValidationMessageEntry {
  code: string;
  /** The message in the form's default language; its translations live in the map. */
  text: string;
}

/**
 * A validation code the host knows about beyond the engine's own — one its server or its
 * sandboxed rules return, or one its page's catalog words — as a bare code or with a label.
 * `message` is the page's own wording for the code (its catalog entry): what a
 * form that authors nothing shows, so the messages editor can show it as the fallback and
 * offer it as a starting point.
 */
export type HostValidationCode = string | { code: string; label?: string | undefined; message?: LocalizedText | undefined };

export interface InspectorChoice {
  value: string;
  label: string;
  /** On a `select`: the entry cannot be chosen (drawn disabled); the field's description says why. */
  disabled?: boolean;
  /**
   * On a `custom` control's list (a read-only list the tree's owner supplies through `fieldChoices`,
   * a Check answers step's "Answers listed"): the heading the entry is listed under. Entries with
   * no `value` are lines of their own (a count, a note); a `select` ignores it.
   */
  group?: string;
}

/** A `file` control's ready-made value: the envelope the pick writes, under a resolved label and group. */
export interface InspectorAssetChoice {
  id: string;
  label: string;
  group: string | undefined;
  source: PropertyEditorAssetChoice["source"];
}

export interface InspectorField {
  propertyPath: string;
  label: string;
  description: string | undefined;
  control: InspectorControl;
  value: unknown;
  /** Resolved choices for a `select` control; empty for every other control. */
  choices: InspectorChoice[];
  /** Bounds and increment of a `number` control, when the field declares them. */
  min?: number;
  max?: number;
  step?: number;
  /** What a `file` control's picker offers, as `<input type="file" accept>` takes it. */
  accept?: string;
  /**
   * Ghost text for an empty text box: what an unset property stands for. The Data key shows
   * the component's id there, since that is the key used until one is set.
   */
  placeholder?: string;
  /** On a `file` control: ready-made values offered beside uploading, labels resolved, grouped as declared. */
  assetChoices?: InspectorAssetChoice[];
  /** On a `path` field's text box: the values offered beside free typing (a datalist); empty when none were supplied. */
  suggestions?: InspectorChoice[];
  /**
   * On an `options` control only: the inline options as authored (default-language strings:
   * their translations are the Languages workspace's) and the data source the component
   * names (if any) — shown because a named source takes precedence over the inline list.
   */
  optionsEditor?: { options: InlineOption[]; sourceId: string | undefined };
  /**
   * On a `value-map` control only: one row per value to translate with what it is translated to
   * now (`target`, empty for "the same value"), the values a row may be translated to, and the
   * map that pairs row i with target i.
   */
  valueMap?: {
    rows: Array<{ value: string; label: string; target: string }>;
    targets: InspectorChoice[];
    byOrder: Record<string, string>;
    sameLabel: string;
    byOrderLabel: string;
    byOrderHint: string | undefined;
    /** The keys of the stored entries that match nothing now; the "remove stale" button is drawn when any. */
    stale: string[];
    removeStaleLabel: string;
    removeStaleHint: string | undefined;
  };
  /**
   * On a `messages` control only: the validation messages as authored and the codes worth
   * offering — in three tiers, so an author sees which ones matter here before the rest. Any
   * other code may still be typed.
   */
  messagesEditor?: {
    entries: ValidationMessageEntry[];
    /** Whether these are the form's defaults (the root) or one component's own messages. */
    scope: "form" | "component";
    /** The codes the component's own constraints can raise — for the root, the whole form's. */
    usedCodes: ValidationCodeDescription[];
    /** The engine's other codes, which this component's constraints do not raise today. */
    engineCodes: ValidationCodeDescription[];
    /** Codes the host named (its server's, its page's catalog's), beyond the engine's. */
    hostCodes: ValidationCodeDescription[];
    /** The page's own wording by code — what applies when the form authors nothing for it. */
    defaults: Record<string, LocalizedText>;
  };
  /**
   * On a `chrome` control only (the form root's header or footer): the region's
   * parts as authored, normalised. Their texts are strings in the default language.
   */
  chromeEditor?: { region: FormChromeRegion; parts: FormChromePart[] };
}

export interface InspectorSection {
  id: string;
  title: string | undefined;
  fields: InspectorField[];
  /**
   * The section starts folded until the author opens it (`InspectorModelOptions.foldedSections`):
   * what is visited only now and then, such as a journey's Wording. Absent: open.
   */
  folded?: boolean;
}

export interface InspectorModel {
  mode: "default" | "extend" | "replace" | "none";
  nodeId: string;
  nodeType: string;
  sections: InspectorSection[];
  /**
   * The node's type has no definition in the builder's registry: the canvas
   * shows a note in its place and the running form will too. The panel says so above the
   * sections, which still edit what every component carries.
   */
  unknownType?: boolean;
  /**
   * The properties whose value decides which other fields are drawn (a field's `visibleWhen`):
   * a change to one of them is painted rather than written live, so the fields that appear
   * or go are drawn at once.
   */
  shapeDependsOn?: string[];
  /**
   * Non-blocking advice about the component as edited: a missing or placeholder
   * label. Each names the field it sits under. Absent when there is none. See
   * {@link inspectorWarnings}.
   */
  warnings?: InspectorNotice[];
  /**
   * Read-only notes about the component: that a rule calculates its answer. Drawn once,
   * above the sections, not under a box. Absent when there is none. See {@link inspectorHints}.
   */
  hints?: InspectorNotice[];
  /**
   * How the surface the form is drawn on treats this component's settings
   * ({@link InspectorModelOptions.drawing}); absent when it was given no answers, or none apply
   * to the component's type.
   */
  drawing?: InspectorDrawingReport;
}

/** Where the adapter that drew a component came from (`LiveForm.adapterOf`): the binding's own, the binding's for its base type, Datum's behind it, or the renderer's note. */
export type InspectorDrawnSource = "binding" | "binding-base" | "datum" | "datum-base" | "renderer";

/** Which adapter drew a component: its source, the type it is registered under, and its name. */
export interface InspectorDrawnBy {
  from: InspectorDrawnSource;
  via: string;
  name?: string | undefined;
}

/**
 * What the builder reads of the form drawn on the canvas, for the inspector: the canvas lends
 * it (`BuilderController.setDrawingSource`), since only it holds the mounted form. Read when
 * the inspector is built, never kept.
 */
export interface BuilderDrawingSource {
  /** Which adapter drew the component with this id, once the canvas has drawn it. */
  adapterOf(componentId: string): InspectorDrawnBy | undefined;
  /** What the surface answers for a type's drawing capabilities (`LiveForm.capabilitiesOf`); `undefined` for a type nothing draws. */
  capabilitiesOf(type: string): { readonly answers: Readonly<Partial<Record<DrawingCapabilityId, DrawingSupport>>> } | undefined;
  /** The name the form is drawn under: the binding's label. */
  bindingLabel(): string;
}

/**
 * What the drawing surface answered for the settings the inspector offers: a box for a setting
 * it does not draw is not drawn by the panel (`hidden`, unless the component already holds a
 * value there, which stays visible and is `kept`; see {@link drawnInspectorModel}), and a box for a setting it draws in a reduced
 * form stays with a note (`degraded`).
 */
export interface InspectorDrawingReport {
  /** The boxes the panel leaves out, by property path, with the capability that was not drawn. The model's sections still hold them. */
  hidden: Array<{ propertyPath: string; capability: DrawingCapabilityId }>;
  /** The boxes shown although the surface does not draw them, because the component holds a value there. */
  kept: Array<{ propertyPath: string; capability: DrawingCapabilityId }>;
  /** The boxes whose setting the surface draws in a reduced form. */
  degraded: Array<{ propertyPath: string; capability: DrawingCapabilityId }>;
}

/** One sentence the inspector draws under the box `fieldId` names (a property path), or, for a hint, above the sections. */
export interface InspectorNotice {
  fieldId: string;
  message: string;
}

const CONTROL_BY_FIELD_TYPE: Record<PropertyEditorFieldType, InspectorControl> = {
  text: "text",
  number: "number",
  boolean: "checkbox",
  select: "select",
  expression: "expression",
  "component-selector": "select",
  "data-source-selector": "select",
  color: "text",
  "localized-text": "localized-text",
  "options-editor": "options",
  "messages-editor": "messages",
  "chrome-editor": "chrome",
  file: "file",
  path: "text",
  formula: "formula",
  "value-map": "value-map",
  custom: "custom"
};

/** The picker's empty choice: the component takes its options from its inline list, if any. */
const NO_DATA_SOURCE_CHOICE: InspectorChoice = { value: "", label: "— none —" };

/**
 * The Frame picker's first choice: the form names no frame, and the host's frame applies, or
 * seamless when the host sets none (`resolveFrame`). Choosing it removes `chrome.frame` from
 * the definition rather than writing "" (see the controller's setDraftProperty).
 */
const FRAME_NOT_SET_CHOICE: InspectorChoice = { value: "", label: "Not set (the host's frame)" };

function readConfigValue(node: ComponentNode, path: string): unknown {
  if (!node.configuration || typeof node.configuration !== "object" || Array.isArray(node.configuration)) {
    return undefined;
  }
  let cursor: unknown = node.configuration;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * The codes the messages editor offers for `node`, in tiers: what the node's own constraints
 * raise (the whole form's on the root), the engine's other codes, then what the host named —
 * each code once, the earlier tier keeping it.
 */
function suggestedValidationCodes(
  node: ComponentNode,
  hostCodes: readonly HostValidationCode[]
): Pick<NonNullable<InspectorField["messagesEditor"]>, "scope" | "usedCodes" | "engineCodes" | "hostCodes" | "defaults"> {
  const used = new Set(validationCodesRaisedBy(node));
  const usedCodes = ENGINE_VALIDATION_CODES.filter((entry) => used.has(entry.code));
  const engineCodes = ENGINE_VALIDATION_CODES.filter((entry) => !used.has(entry.code));
  const seen = new Set(ENGINE_VALIDATION_CODES.map((entry) => entry.code));
  const host: ValidationCodeDescription[] = [];
  const defaults: Record<string, LocalizedText> = {};
  for (const entry of hostCodes) {
    const code = (typeof entry === "string" ? entry : entry.code).trim();
    if (code.length === 0) {
      continue;
    }
    // The page's wording counts for every code it words, the engine's own included.
    if (typeof entry !== "string" && entry.message !== undefined) {
      defaults[code] = entry.message;
    }
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    const label = typeof entry === "string" ? undefined : entry.label?.trim();
    host.push({ code, label: label && label.length > 0 ? label : "Named by the page", parameters: [] });
  }
  return {
    scope: node.type === FORM_ROOT_COMPONENT_TYPE ? "form" : "component",
    usedCodes,
    engineCodes,
    hostCodes: host,
    defaults
  };
}

/** Whether a field is drawn: a `visibleWhen` of `{ propertyPath, equals }` waits for that property of the same component. */
function fieldShown(node: ComponentNode, field: PropertyEditorField): boolean {
  const when = field.visibleWhen;
  if (!when || typeof when !== "object" || Array.isArray(when)) {
    return true;
  }
  const { propertyPath, equals } = when as { propertyPath?: unknown; equals?: unknown };
  if (typeof propertyPath !== "string") {
    return true;
  }
  const stored = readConfigValue(node, propertyPath);
  return (stored === undefined ? "" : stored) === equals;
}

/** A component's authored `messages` map as the editor lists it: only the entries whose text is a string. */
function storedMessages(value: unknown): Record<string, string> {
  const messages: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [code, text] of Object.entries(value)) {
      if (code.trim().length > 0 && typeof text === "string") {
        // Defined, not assigned: a code named `__proto__` is an entry, not a prototype.
        Object.defineProperty(messages, code, { value: text, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return messages;
}

function toInspectorField(
  node: ComponentNode,
  field: PropertyEditorField,
  locale: string,
  dataSourceIds: readonly string[],
  hostValidationCodes: readonly HostValidationCode[],
  frameChoices: readonly FrameOption[] = [],
  fieldChoices?: InspectorModelOptions["fieldChoices"],
  placeholderOf?: InspectorModelOptions["placeholder"]
): InspectorField {
  const declared = CONTROL_BY_FIELD_TYPE[field.type];
  const stored = readConfigValue(node, field.propertyPath);
  // Unset shows the field's declared default (a switch that is on unless turned off), so the
  // panel says what the form will do rather than showing a blank that means the same thing.
  // What a hidden answer does is read off the component itself: one that asks to be required or
  // validated while hidden keeps and sends it (`defaultHiddenValueBehaviorFor`).
  const fallback = field.propertyPath === HIDDEN_VALUE_FIELD.propertyPath ? defaultHiddenValueBehaviorFor(node.configuration) : field.defaultValue;
  const rawValue = stored === undefined ? fallback : stored;
  // A `localized-text` field is a translatable string: a plain box for the default
  // language, nothing more. Its translations are the Languages workspace's.
  let control: InspectorControl = declared;
  let choices = (field.choices ?? []).map((choice) => ({
    value: choice.value,
    label: resolveLocalizedText(choice.label, locale) ?? choice.value
  }));
  // The root's Frame picker offers what the active binding draws, after Not set: no
  // frame in the definition, so the application showing the form decides. Declared choices, if
  // a host restated the field with its own, still win.
  if (field.propertyPath === "chrome.frame" && choices.length === 0) {
    choices = [FRAME_NOT_SET_CHOICE, ...frameChoices.map((option) => ({ value: option.id, label: option.label }))];
  }
  // The Data source picker offers what the host wired into the builder. A host that wired
  // nothing gets a text box for the id: a picker with a single "(unknown)" entry would say
  // the source is wrong when it is merely one the builder was not told about.
  if (field.type === "data-source-selector" && choices.length === 0) {
    if (dataSourceIds.length > 0) {
      choices = [NO_DATA_SOURCE_CHOICE, ...dataSourceIds.map((id) => ({ value: id, label: id }))];
    } else {
      control = "text";
    }
  }
  // A picker whose choices depend on more than the node — the form's components for a journey
  // question, the pages after a route's own — is filled the same way, by whoever
  // knows them; declared choices still win.
  // A `custom` field's list is the tree owner's too: read-only entries, drawn as a list.
  if ((control === "select" || control === "custom") && choices.length === 0 && fieldChoices) {
    const supplied = fieldChoices(field);
    if (supplied) {
      choices = supplied.map((choice) => ({ ...choice }));
    }
  }
  const suggestions = field.type === "path" ? (fieldChoices?.(field) ?? []).map((choice) => ({ ...choice })) : undefined;
  const optionsEditor =
    control === "options"
      ? {
          options: parseInlineOptions(rawValue),
          sourceId: readSourceId(node.configuration)
        }
      : undefined;
  const messagesEditor =
    control === "messages"
      ? {
          entries: Object.entries(storedMessages(rawValue)).map(([code, text]) => ({ code, text })),
          ...suggestedValidationCodes(node, hostValidationCodes)
        }
      : undefined;
  const valueMap =
    control === "value-map" && field.valueMap
      ? {
          rows: field.valueMap.rows.map((row) => ({
            value: row.value,
            label: resolveLocalizedText(row.label, locale) ?? row.value,
            target: storedValueMapEntry(rawValue, row.value)
          })),
          targets: field.valueMap.targets.map((choice) => ({ value: choice.value, label: resolveLocalizedText(choice.label, locale) ?? choice.value })),
          byOrder: { ...field.valueMap.byOrder },
          sameLabel: resolveLocalizedText(field.valueMap.sameLabel, locale) ?? "",
          byOrderLabel: resolveLocalizedText(field.valueMap.byOrderLabel, locale) ?? "",
          byOrderHint: resolveLocalizedText(field.valueMap.byOrderHint, locale),
          stale: [...(field.valueMap.stale ?? [])],
          removeStaleLabel: resolveLocalizedText(field.valueMap.removeStaleLabel, locale) ?? "",
          removeStaleHint: resolveLocalizedText(field.valueMap.removeStaleHint, locale)
        }
      : undefined;
  const chromeEditor =
    control === "chrome"
      ? {
          region: (field.propertyPath.endsWith("footer") ? "footer" : "header") as FormChromeRegion,
          parts: readFormChromeParts(rawValue)
        }
      : undefined;
  // What an empty box stands for: the tree owner's word first (a journey page's id), else the
  // Data key's component id.
  const placeholder = placeholderOf?.(field) ?? (field.propertyPath === DATA_KEY_PROPERTY ? node.id : undefined);
  return {
    propertyPath: field.propertyPath,
    label: resolveLocalizedText(field.label, locale) ?? field.propertyPath,
    description: resolveLocalizedText(field.description, locale),
    control,
    value: rawValue,
    choices,
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.step !== undefined ? { step: field.step } : {}),
    ...(field.accept !== undefined ? { accept: field.accept } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
    ...(field.assetChoices
      ? {
          assetChoices: field.assetChoices.map((choice) => ({
            id: choice.id,
            label: resolveLocalizedText(choice.label, locale) ?? choice.id,
            group: resolveLocalizedText(choice.group, locale),
            source: choice.source
          }))
        }
      : {}),
    ...(optionsEditor ? { optionsEditor } : {}),
    ...(messagesEditor ? { messagesEditor } : {}),
    ...(valueMap ? { valueMap } : {}),
    ...(chromeEditor ? { chromeEditor } : {})
  };
}

/**
 * A value map with one row changed: `target` set for `key`, or the entry removed for
 * "Same value" (an empty target). Entries that are not text are dropped; `undefined` when
 * nothing is left, so a layout never carries `values: {}`.
 */
export function valueMapWith(current: unknown, key: string, target: string): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [entryKey, entry] of Object.entries(current)) {
      if (typeof entry === "string" && entryKey !== key) {
        next[entryKey] = entry;
      }
    }
  }
  if (target !== "") {
    next[key] = target;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * A value map without the entries named by `keys`: the other entries
 * stay as they are, in order; `undefined` when nothing is left, so a layout never carries
 * `values: {}`. Entries that are not text are dropped as in {@link valueMapWith}.
 */
export function valueMapWithout(current: unknown, keys: readonly string[]): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [entryKey, entry] of Object.entries(current)) {
      if (typeof entry === "string" && !keys.includes(entryKey)) {
        next[entryKey] = entry;
      }
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** What a stored value map says for `key`: its own entry, else empty ("the same value"). */
function storedValueMapEntry(stored: unknown, key: string): string {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return "";
  }
  const entry = Object.prototype.hasOwnProperty.call(stored, key) ? (stored as Record<string, unknown>)[key] : undefined;
  return typeof entry === "string" ? entry : "";
}

/** Component type of the canonical form root; its inspector shows form-level settings. */
export const FORM_ROOT_COMPONENT_TYPE = "form";

const DEFAULT_FIELDS: PropertyEditorField[] = [
  { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
  { id: "description", type: "localized-text", propertyPath: "description", label: "Description" },
  { id: "required", type: "boolean", propertyPath: "required", label: "Required" },
  { id: DATA_KEY_PROPERTY, type: "text", propertyPath: DATA_KEY_PROPERTY, label: "Data key" },
  HIDDEN_VALUE_FIELD
];

/**
 * Form-level defaults used for the form root. The root is not a field, so it has no
 * `label` / `required` — only form-wide settings.
 */
const FORM_ROOT_FIELDS: PropertyEditorField[] = [
  { id: "title", type: "localized-text", propertyPath: "title", label: "Form title" },
  { id: "description", type: "localized-text", propertyPath: "description", label: "Description" },
  // The form's own validation text per code (`configuration.messages`): what every
  // field shows for a code unless it, or a container around it, words that code itself.
  {
    id: "messages",
    type: "messages-editor",
    propertyPath: "messages",
    label: "Validation messages",
    description: "Text shown for each validation code, for the whole form unless a field says otherwise."
  },
  // The frame around the form (`configuration.chrome.frame`): a preset the engine or
  // the binding draws; the choices are filled in from the active binding (`frameOptions`).
  {
    id: "chrome.frame",
    type: "select",
    propertyPath: "chrome.frame",
    label: "Frame",
    description:
      "How the form sits on the page: seamless, outlined, as paper, or a look the form's binding defines. Not set leaves it to the application showing the form, which may set a frame of its own; without one the form is seamless. The application may also fix a frame that wins over the form's.",
    defaultValue: ""
  },
  // The form's own header and footer (`configuration.chrome`): a logo, the title,
  // instructions, the language switcher's place — composed in the parts editor.
  {
    id: "chrome.header",
    type: "chrome-editor",
    propertyPath: "chrome.header",
    label: "Header",
    description: "What the form shows above its fields: a logo, its title, instructions, where the language switcher goes."
  },
  {
    id: "chrome.footer",
    type: "chrome-editor",
    propertyPath: "chrome.footer",
    label: "Footer",
    description: "What the form shows below its fields."
  }
];

/**
 * The natural sections a flat (section-less) editor's fields are gathered into, in display
 * order. An editor that declares its own sections is left alone — this is only the default
 * shape for the common case of capabilities each contributing a field or two, which would
 * otherwise pile up as one long undifferentiated list.
 *
 * `settings` catches everything not recognised below: a component's own fields (a button's
 * action, a grid's columns) are what make the component itself, so they sit right under the
 * text an author edits most.
 */
const GROUPED_SECTIONS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "content", title: "Content" },
  // Where a field's choices come from — a data source, or options typed inline — right under
  // its text: for a select or radio, the options are as much its content as its label.
  { id: "data", title: "Data" },
  { id: "settings", title: "Settings" },
  // A data grid's own row settings: how rows are laid out, which operations the
  // form offers, the bounds on their number and the captions.
  { id: "rows", title: "Rows" },
  { id: "validation", title: "Validation" },
  { id: "behavior", title: "Behavior" },
  { id: "presentation", title: "Presentation" },
  // The form root's own header and footer, then how a component prints, after
  // everything about it on screen. The form's own print settings are the Print workspace's.
  // Presentation and PDF are the Style tab's; "On paper" is the last group of the Field tab.
  { id: "chrome", title: "Header & footer" },
  { id: "print", title: "On paper" },
  // How a component appears in a generated PDF, likewise last.
  { id: "pdf", title: "PDF" }
];

/**
 * Where each well-known property lands. Keyed by `propertyPath` rather than field id because
 * the path is the semantic identity — a `replace`-mode editor restating `label` under another
 * id still means the label.
 */
const SECTION_BY_PROPERTY: Record<string, string> = {
  // The free-answer switch belongs with the source picker it qualifies.
  "data.answersFree": "data",
  label: "content",
  title: "content",
  description: "content",
  placeholder: "content",
  // With the other properties of the box itself (how much room the answer needs), not with
  // how the control behaves.
  rows: "content",
  // What flanks the box is part of what the field shows, beside its placeholder.
  prefix: "content",
  suffix: "content",
  tooltip: "content",
  // Where the answer is stored, beside where a choice's options come from.
  dataKey: "data",
  // What the submitted data holds for the answer while it is hidden, beside where it is stored.
  hiddenValueBehavior: "data",
  required: "validation",
  minLength: "validation",
  maxLength: "validation",
  // The count is the maximum shown while typing: beside the limit it counts to.
  characterCount: "validation",
  pattern: "validation",
  patternMessage: "validation",
  // A file field's limits are constraints like a length or a pattern; its storage kind and
  // multiplicity are what the control is, and fall to `settings` with the other own fields.
  accept: "validation",
  maxFileSizeMb: "validation",
  // What the constraints say when they fail belongs with the constraints — on the form root
  // too, where it is the default wording for every field.
  messages: "validation",
  disabled: "behavior",
  hideLabel: "presentation",
  cssClass: "presentation",
  // Hints to the browser about the control: how it behaves under the keyboard, not what it says.
  autocomplete: "behavior",
  inputmode: "behavior",
  spellcheck: "behavior",
  "chrome.frame": "chrome",
  "chrome.header": "chrome",
  "chrome.footer": "chrome",
  "pdf.rendition": "pdf",
  "pdf.exclude": "pdf",
  // How it prints from the live form: with the form's own print choices.
  "print.on": "print",
  "print.breakBefore": "print",
  "print.keepTogether": "print",
  "print.show": "print",
  "print.note": "print",
  "pdf.attach": "pdf"
};

/**
 * Builds a render-agnostic inspector model for a component from its capabilities and
 * optional component-level property editor, driven by {@link composePropertyEditor}.
 * When nothing contributes fields, a type-appropriate default is used: form-level settings
 * for the form root, otherwise label / required.
 */
export interface InspectorModelOptions {
  /**
   * Data source ids the host wired into the builder, which a `data-source-selector` field
   * offers. Empty (the default) renders that field as a text box for the id instead.
   */
  dataSourceIds?: readonly string[];
  /**
   * Validation codes the host knows about beyond the engine's own — its server's, its
   * sandboxed rules', the keys of its page's message catalog — which the messages editor
   * offers after the engine's. Empty (the default) offers the engine's alone.
   */
  validationCodes?: readonly HostValidationCode[];
  /**
   * The frames the form root's Frame picker offers: the engine's built-ins and the
   * active binding's own, labelled for the locale (`frameOptions` in `render/live/datum/frames.ts`).
   * Empty (the default) offers the built-ins alone.
   */
  frameOptions?: readonly FrameOption[];
  /**
   * The choices of a `select` field that declares none, from whoever knows them (a builder
   * mode, through `BuilderControllerOptions.fieldChoices`). `undefined` leaves the
   * field as declared. A stored value the list does not hold still shows, marked unknown.
   */
  fieldChoices?: ((field: PropertyEditorField) => InspectorChoice[] | undefined) | undefined;
  /**
   * Section ids that start folded (`InspectorSection.folded`), from whoever lays the tree's
   * inspector out (a builder mode, through `BuilderControllerOptions.foldedSections`).
   */
  foldedSections?: readonly string[] | undefined;
  /**
   * Ghost text for a text box the node leaves empty, from whoever knows what an unset property
   * stands for (`BuilderControllerOptions.fieldPlaceholder`): the id a journey page
   * is written under while its page id is blank. `undefined` keeps the builder's own.
   */
  placeholder?: ((field: PropertyEditorField) => string | undefined) | undefined;
  /**
   * The builder's words for the warnings and hints the model carries (`BuilderWords.options()`),
   * so a host's catalog words them in the builder's language. Absent: English.
   */
  words?: BuilderTextOptions | undefined;
  /**
   * What the surface the form is drawn on answers for this component's type, per drawing
   * capability (`LiveForm.capabilitiesOf(type).answers`: the kind registry and the binding's
   * adapter, Datum's behind it), reported in {@link InspectorModel.drawing}: a setting whose
   * capability is `none` is `hidden` (`kept` when the component already holds a value there),
   * `degraded` is noted beside its box. The sections stay complete; the panel draws them through
   * {@link drawnInspectorModel}, which leaves the hidden boxes out. Absent: nothing is reported.
   */
  drawing?: { readonly answers: Readonly<Partial<Record<DrawingCapabilityId, DrawingSupport>>> } | undefined;
  /**
   * The definition's type-to-base map (`BuilderController` reads it off the registry and the
   * bindings): what lets the "On paper" group tell a container from a field, and whether
   * "On paper only" would take effect. Absent: engine types alone.
   */
  kinds?: Readonly<Record<string, string>> | undefined;
}

/**
 * The authored setting each drawing capability is the other half of (`field-capabilities.ts`
 * names the property, `drawing-capabilities.ts` the capability); `notice` and `pending` are
 * something a form shows, not a setting an author makes.
 */
const CAPABILITY_PROPERTIES: Readonly<Partial<Record<DrawingCapabilityId, readonly string[]>>> = {
  tooltip: ["tooltip"],
  prefix: ["prefix"],
  suffix: ["suffix"],
  characterCount: ["characterCount"],
  hideLabel: ["hideLabel"],
  placeholder: ["placeholder"],
  rowNumbers: ["showRowNumbers"]
};

/** The capability a setting's box is the other half of, when it has one. */
export function drawingCapabilityOfProperty(propertyPath: string): DrawingCapabilityId | undefined {
  for (const [capability, paths] of Object.entries(CAPABILITY_PROPERTIES)) {
    if (paths?.includes(propertyPath)) {
      return capability as DrawingCapabilityId;
    }
  }
  return undefined;
}

/** Whether a setting holds something: a value the author typed or switched on. */
function holdsValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null && value !== false;
}

/**
 * What the surface answers for each box in `sections` that is the other half of a drawing
 * capability: a box for a setting it does not draw is `hidden` (unless the component already
 * holds a value there: `kept`), and one it draws reduced is `degraded`. Nothing is removed
 * here: the model stays the complete list of the component's settings, which the agent and the
 * panel's own checks read; {@link drawnInspectorModel} is the view the panel draws.
 */
function drawingReport(
  sections: readonly InspectorSection[],
  node: ComponentNode,
  answers: Readonly<Partial<Record<DrawingCapabilityId, DrawingSupport>>>
): InspectorDrawingReport {
  const report: InspectorDrawingReport = { hidden: [], kept: [], degraded: [] };
  for (const field of sections.flatMap((section) => section.fields)) {
    const capability = drawingCapabilityOfProperty(field.propertyPath);
    const support = capability === undefined ? undefined : answers[capability];
    if (capability === undefined || support === undefined || support === "drawn") {
      continue;
    }
    const entry = { propertyPath: field.propertyPath, capability };
    if (support === "degraded") {
      report.degraded.push(entry);
    } else if (holdsValue(readConfigValue(node, field.propertyPath))) {
      report.kept.push(entry);
    } else {
      report.hidden.push(entry);
    }
  }
  return report;
}

/**
 * The sections the properties panel draws: `model`'s, without the boxes its drawing report
 * says the surface does not draw (`hidden`). A section left empty by it is dropped; one that
 * was empty before stays. The model itself is unchanged: it is still every setting the
 * component has, which is what an agent writing a property and the panel's checks read.
 */
export function drawnInspectorModel(model: InspectorModel): InspectorModel {
  const hidden = new Set(model.drawing?.hidden.map((entry) => entry.propertyPath) ?? []);
  if (hidden.size === 0) {
    return model;
  }
  const sections: InspectorSection[] = [];
  for (const section of model.sections) {
    const fields = section.fields.filter((field) => !hidden.has(field.propertyPath));
    if (fields.length === section.fields.length) {
      sections.push(section);
    } else if (fields.length > 0) {
      sections.push({ ...section, fields });
    }
  }
  return { ...model, sections };
}

/**
 * A data grid's row settings, gathered under their own heading. The names are common
 * ones (`layout`, `emptyText`, `maxRows` are a PDF repeat's too), so the section is chosen by the
 * component's type, never by the property name alone: on any other component these fall to
 * `settings`.
 */
const DATA_GRID_ROWS_PROPERTIES: ReadonlySet<string> = new Set([
  "layout",
  "showHeader",
  "showRowNumbers",
  "rowLabel",
  "canAdd",
  "addLabel",
  "canRemove",
  "removeLabel",
  "canReorder",
  "minRows",
  "maxRows",
  "initialRows",
  "emptyText"
]);

/** Where a field lands when the editor declares no sections of its own. */
function naturalSectionFor(field: PropertyEditorField, nodeType?: string): string {
  if (nodeType === DATA_GRID_COMPONENT_TYPE && DATA_GRID_ROWS_PROPERTIES.has(field.propertyPath)) {
    return "rows";
  }
  if (field.type === "data-source-selector" || field.type === "options-editor") {
    return "data";
  }
  // The number's own bounds (below) are constraints; a path of `max` alone is not, for a rating's
  // star count shares it, so they are told apart by identity rather than by SECTION_BY_PROPERTY.
  if (field === NUMBER_MIN_FIELD || field === NUMBER_MAX_FIELD) {
    return "validation";
  }
  return SECTION_BY_PROPERTY[field.propertyPath] ?? "settings";
}

/*
 * What the model says beyond the fields. Three pure
 * functions over the component as edited (`BuilderController.editedNode`, drafts applied), each
 * taking the builder's text options (`BuilderWords.options()`) for its sentences:
 *
 *  - `applyBlockers(node, words?)` -> [{ fieldId, message }]: what stops Apply, a pattern that
 *    is no regular expression or a minimum above its maximum (length or number). The only place
 *    a value holds Apply back; everything else stays `problemsOf`, which Save asks.
 *    `fieldId` is the box the message sits under (the pattern, the maximum).
 *  - `inspectorWarnings(node, words?)` -> [{ fieldId: "label", message }]: advice that never
 *    blocks, an input with no label or still the default "Untitled field". Also on the model as
 *    `warnings` (omitted when empty).
 *  - `inspectorHints(node, words?)` -> [{ fieldId, message }]: a rule calculates the answer.
 *    Also on the model as `hints` (omitted when empty).
 *
 * The Number component's Minimum and Maximum are fields of the model itself (stored at `min` and
 * `max`, the keys the validator reads, `kernelAnswerBounds`); an emptied box removes the key.
 */

/** The label a new field starts with until its author names it (the controller and the standard catalogue write the same text). */
export const UNTITLED_FIELD_LABEL = "Untitled field";

/** The Number component's bounds, as the validator reads them (`configuration.min` / `max`). */
const NUMBER_MIN_FIELD: PropertyEditorField = {
  id: "min",
  type: "number",
  propertyPath: "min",
  label: "Minimum",
  description: "Smallest number accepted. Leave empty for no minimum."
};
const NUMBER_MAX_FIELD: PropertyEditorField = {
  id: "max",
  type: "number",
  propertyPath: "max",
  label: "Maximum",
  description: "Largest number accepted. Leave empty for no maximum."
};

/**
 * The types a person fills in, which need a label to be told what to enter. A heading, a button,
 * a container or static text carries its own words, so a blank label there is not an omission.
 * A type a plugin brings is not guessed at.
 */
const LABELLED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "textarea",
  "number",
  "email",
  "tel",
  "url",
  "password",
  "search",
  "select",
  "radio",
  "checkbox",
  "checkboxes",
  "date",
  "time",
  "file",
  "signature"
]);

function configurationOf(node: ComponentNode): Record<string, unknown> {
  return node.configuration && typeof node.configuration === "object" && !Array.isArray(node.configuration)
    ? (node.configuration as Record<string, unknown>)
    : {};
}

/** A bound as the validator reads one: a finite number, or a plain numeral as text. Anything else is no bound. */
function numericBound(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * What keeps Apply from taking `node`: a pattern the runtime cannot compile (the check the
 * markup uses before it writes the `pattern` attribute), a minimum length above the maximum, a
 * Number's minimum above its maximum. Equal bounds are allowed. An empty list means Apply is
 * free; a message is worded for the box it names.
 */
export function applyBlockers(node: ComponentNode, words?: BuilderTextOptions): InspectorNotice[] {
  const configuration = configurationOf(node);
  const blockers: InspectorNotice[] = [];
  const pattern = configuration.pattern;
  if (typeof pattern === "string" && pattern !== "" && !isValidPattern(pattern)) {
    blockers.push({ fieldId: "pattern", message: builderText("inspector.block.pattern", undefined, words) });
  }
  const minLength = numericBound(configuration.minLength);
  const maxLength = numericBound(configuration.maxLength);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    blockers.push({ fieldId: "maxLength", message: builderText("inspector.block.lengthRange", undefined, words) });
  }
  if (node.type === "number") {
    const min = numericBound(configuration.min);
    const max = numericBound(configuration.max);
    if (min !== undefined && max !== undefined && min > max) {
      blockers.push({ fieldId: "max", message: builderText("inspector.block.range", undefined, words) });
    }
  }
  return blockers;
}

/** Whether a label says nothing: it is not text, or only blanks (the label is a string). */
function labelIsEmpty(raw: unknown): boolean {
  return typeof raw !== "string" || raw.trim() === "";
}

/**
 * Advice that never holds anything back: an input with no label, and any component
 * whose label is still the default "Untitled field". Both sit under the Label box.
 */
export function inspectorWarnings(node: ComponentNode, words?: BuilderTextOptions): InspectorNotice[] {
  const label = configurationOf(node).label;
  if (LABELLED_INPUT_TYPES.has(node.type) && labelIsEmpty(label)) {
    return [{ fieldId: "label", message: builderText("inspector.warn.noLabel", undefined, words) }];
  }
  if (typeof label === "string" && label.trim() === UNTITLED_FIELD_LABEL) {
    return [{ fieldId: "label", message: builderText("inspector.warn.untitled", undefined, words) }];
  }
  return [];
}

/**
 * Notes for the author about the component: a rule that calculates its answer makes the box
 * read-only to the filler, and an Email keyboard with no pattern suggests the Email
 * preset ({@link suggestedPatternPreset}). A suggestion is advice, never a warning, and
 * names the Format box (`fieldId` {@link PATTERN_PRESET_PATH}) the panel offers it for.
 */
export function inspectorHints(node: ComponentNode, words?: BuilderTextOptions): InspectorNotice[] {
  const calculation = (node.rules as Record<string, unknown> | undefined)?.value;
  const text = ruleText(calculation);
  const calculated = text === undefined ? calculation !== null && typeof calculation === "object" : text.trim() !== "";
  const hints: InspectorNotice[] = calculated ? [{ fieldId: "value", message: builderText("inspector.hint.calculated", undefined, words) }] : [];
  const suggested = suggestedPatternPreset(node);
  if (suggested) {
    hints.push({ fieldId: PATTERN_PRESET_PATH, message: builderText(suggested.suggestKey, undefined, words) });
  }
  return hints;
}

/*
 * Validation presets. The Email keyboard (`inputmode: "email"`)
 * is a device hint and validates nothing: a pattern derived from it inside the browser only would
 * never reach the sandbox kernel or a server. A preset is the explicit form of that idea. Choosing one writes a plain `pattern` and a default `patternMessage` into the stored
 * definition (the draft, so Apply lands both as one undo step), and from then on the browser
 * and the server validate the same definition. Nothing applies a preset by itself; the Email
 * keyboard only makes the inspector suggest it.
 *
 * The Format box is not a property of the component: its `propertyPath` is a virtual one, its
 * value is read back from the stored pattern, and the panel turns a choice into the two writes
 * {@link patternPresetWrites} lists. A later preset (a postal code, a phone number) is one more
 * row of {@link PATTERN_PRESETS} and its text keys.
 */

/** The virtual property path of the inspector's Format box, and the `fieldId` of its suggestion. */
export const PATTERN_PRESET_PATH = "patternPreset";

/** The Format box's value for a pattern no preset wrote. */
export const PATTERN_PRESET_CUSTOM = "custom";

export interface PatternPreset {
  /** The value the Format box holds while this preset's pattern is the stored one. */
  id: string;
  pattern: string;
  /** The `patternMessage` written with the pattern when the component has none of its own (a default-language string). */
  message: string;
  /** The choice's name in the Format box. */
  labelKey: BuilderTextKey;
  /** The suggestion shown when something else hints this preset is wanted. */
  suggestKey: BuilderTextKey;
}

export const PATTERN_PRESETS: readonly PatternPreset[] = [
  {
    id: "email",
    pattern: EMAIL_PRESET_PATTERN,
    message: EMAIL_PRESET_MESSAGE,
    labelKey: "inspector.preset.email",
    suggestKey: "inspector.hint.presetEmail"
  }
];

function storedPattern(node: ComponentNode): string {
  const pattern = configurationOf(node).pattern;
  return typeof pattern === "string" ? pattern : "";
}

/** What the Format box holds for `node`: "" with no pattern, a preset's id while its pattern is the stored one, else "custom". */
export function patternPresetOf(node: ComponentNode): string {
  const pattern = storedPattern(node);
  if (pattern === "") {
    return "";
  }
  return PATTERN_PRESETS.find((preset) => preset.pattern === pattern)?.id ?? PATTERN_PRESET_CUSTOM;
}

/**
 * The preset worth suggesting for `node`, or none: a `text` component whose keyboard is Email and
 * which has no pattern of its own (a blank pattern is none, as the constraints stage reads it).
 */
export function suggestedPatternPreset(node: ComponentNode): PatternPreset | undefined {
  if (node.type !== "text" || storedPattern(node) !== "") {
    return undefined;
  }
  return readControlHints(configurationOf(node)).inputMode === "email" ? PATTERN_PRESETS.find((preset) => preset.id === "email") : undefined;
}

/** The property writes that choosing `choice` in the Format box asks for, in the order they are made; none for "custom" or an unknown value. */
export function patternPresetWrites(node: ComponentNode, choice: string): Array<{ path: string; value: unknown }> {
  const configuration = configurationOf(node);
  const preset = PATTERN_PRESETS.find((entry) => entry.id === choice);
  if (preset) {
    // A message the author wrote stays; the preset only supplies one where there is none.
    const hasMessage = configuration.patternMessage !== undefined && configuration.patternMessage !== "";
    return [
      { path: "pattern", value: preset.pattern },
      ...(hasMessage ? [] : [{ path: "patternMessage", value: preset.message as unknown }])
    ];
  }
  if (choice !== "") {
    return [];
  }
  // Any text: the pattern goes, and the message with it only while it is a preset's own wording.
  const own = PATTERN_PRESETS.some((entry) => JSON.stringify(entry.message) === JSON.stringify(configuration.patternMessage));
  return [{ path: "pattern", value: undefined }, ...(own ? [{ path: "patternMessage", value: undefined }] : [])];
}

/** The Format box for `node`, worded by `words`. Choices: Any text, each preset, and "Custom pattern" while the stored pattern is none of theirs. */
export function patternPresetField(node: ComponentNode, words?: BuilderTextOptions): InspectorField {
  const value = patternPresetOf(node);
  return {
    propertyPath: PATTERN_PRESET_PATH,
    label: builderText("inspector.preset.label", undefined, words),
    description: builderText("inspector.preset.help", undefined, words),
    control: "select",
    value,
    choices: [
      { value: "", label: builderText("inspector.preset.none", undefined, words) },
      ...PATTERN_PRESETS.map((preset) => ({ value: preset.id, label: builderText(preset.labelKey, undefined, words) })),
      ...(value === PATTERN_PRESET_CUSTOM ? [{ value: PATTERN_PRESET_CUSTOM, label: builderText("inspector.preset.custom", undefined, words) }] : [])
    ]
  };
}

/** `sections` with the Format box placed right before the Pattern box, wherever that sits; unchanged when no section holds Pattern. */
function withPatternPresetField(sections: InspectorSection[], field: InspectorField): InspectorSection[] {
  return sections.map((section) => {
    const at = section.fields.findIndex((entry) => entry.propertyPath === "pattern");
    return at < 0 ? section : { ...section, fields: [...section.fields.slice(0, at), field, ...section.fields.slice(at)] };
  });
}

/** `model` with its Format box (when it has one) drawn afresh in `words`: the builder's language reaches it though the model was built without. */
export function rewordPatternPreset(model: InspectorModel, node: ComponentNode, words?: BuilderTextOptions): InspectorModel {
  const fresh = patternPresetField(node, words);
  return {
    ...model,
    sections: model.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (field.propertyPath === PATTERN_PRESET_PATH ? fresh : field))
    }))
  };
}

export function buildInspectorModel(
  node: ComponentNode,
  capabilities: CapabilityDefinition[] = [],
  componentEditor?: PropertyEditorDefinition,
  locale = "en",
  options: InspectorModelOptions = {}
): InspectorModel {
  const dataSourceIds = options.dataSourceIds ?? [];
  const validationCodes = options.validationCodes ?? [];
  const frameChoices = options.frameOptions ?? builtinFrameOptions(undefined, locale);
  const composed = composePropertyEditor(capabilities, { component: node }, componentEditor);

  if (!composed) {
    return { mode: "none", nodeId: node.id, nodeType: node.type, sections: [] };
  }

  const fallback = node.type === FORM_ROOT_COMPONENT_TYPE ? FORM_ROOT_FIELDS : DEFAULT_FIELDS;
  const declaredFields = composed.fields.length > 0 ? composed.fields : fallback;
  // A Number offers its bounds under Validation, after Required, unless an editor restated
  // them; an editor that declares sections of its own places its fields itself.
  const fields =
    node.type === "number" &&
    composed.sections.length === 0 &&
    !declaredFields.some((field) => field.propertyPath === NUMBER_MIN_FIELD.propertyPath || field.propertyPath === NUMBER_MAX_FIELD.propertyPath)
      ? insertAfterRequired(declaredFields, [NUMBER_MIN_FIELD, NUMBER_MAX_FIELD])
      : declaredFields;
  const fieldById = new Map(fields.map((field) => [field.id, field]));

  let sections: InspectorSection[];
  if (composed.sections.length > 0) {
    sections = composed.sections.map((section) => ({
      id: section.id,
      title: resolveLocalizedText(section.title, locale),
      fields: section.fieldIds
        .map((id) => fieldById.get(id))
        .filter((field): field is PropertyEditorField => field !== undefined && fieldShown(node, field))
        .map((field) => toInspectorField(node, field, locale, dataSourceIds, validationCodes, frameChoices, options.fieldChoices, options.placeholder))
    }))
    // A section that opts in (`hideWhenEmpty`) is not drawn as an empty heading when
    // every field it lists is absent for this node. No other section changes.
    .filter((section, index) => section.fields.length > 0 || composed.sections[index]!.hideWhenEmpty !== true);
  } else {
    // No declared sections: gather the flat field list into the natural groups, keeping
    // authored order within each, and leaving out a field whose `visibleWhen` does not hold.
    // Groups nothing landed in are not rendered at all.
    const grouped = new Map<string, PropertyEditorField[]>(
      GROUPED_SECTIONS.map((section) => [section.id, []])
    );
    for (const field of fields) {
      if (fieldShown(node, field)) {
        grouped.get(naturalSectionFor(field, node.type))?.push(field);
      }
    }
    sections = GROUPED_SECTIONS.filter((section) => (grouped.get(section.id) ?? []).length > 0).map(
      (section) => ({
        id: section.id,
        // The root's text properties are form-wide settings, and the panel says so.
        title:
          section.id === "content" && node.type === FORM_ROOT_COMPONENT_TYPE
            ? "Form settings"
            : section.title,
        fields: (grouped.get(section.id) ?? []).map((field) =>
          toInspectorField(node, field, locale, dataSourceIds, validationCodes, frameChoices, options.fieldChoices, options.placeholder)
        )
      })
    );
  }

  // A component with a Pattern box offers the Format presets before it, unless an editor
  // placed its own sections: it did not ask for this field, so it is not added behind its back.
  if (composed.sections.length === 0) {
    sections = withPatternPresetField(sections, patternPresetField(node, options.words));
  }

  sections = shapePrintFields(sections, node, options);

  // What the surface draws of each box: the panel leaves out the ones it does not draw
  // (drawnInspectorModel) and notes the ones it draws reduced. The sections stay complete.
  const drawing = options.drawing === undefined ? undefined : drawingReport(sections, node, options.drawing.answers);

  // Sections the tree's owner folds (a journey's Wording) start folded; the panel remembers
  // the author's own toggles over this.
  const folded = new Set(options.foldedSections ?? []);
  if (folded.size > 0) {
    sections = sections.map((section) => (folded.has(section.id) ? { ...section, folded: true } : section));
  }

  // The data source decides what the options row shows (the inline editor, or "from the data
  // source" with no editor), so where both fields sit the picker repaints the panel on a change
  // like a `visibleWhen` property does; a live write would leave the row saying the old thing.
  const optionsRowFollowsSource = fields.some((field) => field.type === "options-editor");
  // The Email keyboard decides whether the Email preset is suggested, so choosing a keyboard
  // paints the panel too, where a Pattern box and a Keyboard box sit together.
  const suggestsPreset = fields.some((field) => field.propertyPath === "pattern") && fields.some((field) => field.propertyPath === "inputmode");
  const shapeDependsOn = [
    ...new Set([
      ...fields.flatMap((field) => {
        const when = field.visibleWhen;
        const path = when && typeof when === "object" && !Array.isArray(when) ? (when as { propertyPath?: unknown }).propertyPath : undefined;
        const own = optionsRowFollowsSource && field.type === "data-source-selector" ? [field.propertyPath] : [];
        return typeof path === "string" ? [path, ...own] : own;
      }),
      ...(suggestsPreset ? ["inputmode"] : [])
    ])
  ];
  const warnings = inspectorWarnings(node, options.words);
  const hints = inspectorHints(node, options.words);
  return {
    mode: composed.mode,
    nodeId: node.id,
    nodeType: node.type,
    sections,
    ...(shapeDependsOn.length > 0 ? { shapeDependsOn } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(hints.length > 0 ? { hints } : {}),
    ...(drawing !== undefined && (drawing.hidden.length > 0 || drawing.kept.length > 0 || drawing.degraded.length > 0) ? { drawing } : {})
  };
}

/**
 * The "On paper" group as this component can use it. "Keep together" belongs to a container that
 * print keeps whole ({@link keepTogetherApplies}: a group, panel, fieldset, step, repeating section
 * or data grid; never a tabs or steps container, whose tabs and steps are sections of their own), so a
 * field has no such box. "On paper only" takes effect only where {@link paperOnlyApplies}; where
 * it would not, the choice is drawn disabled and the Shown box's description says why, so an
 * author is not offered a setting the form would ignore.
 */
function shapePrintFields(sections: InspectorSection[], node: ComponentNode, options: InspectorModelOptions): InspectorSection[] {
  if (node.type === FORM_ROOT_COMPONENT_TYPE || !sections.some((section) => section.fields.some((field) => field.propertyPath.startsWith("print.")))) {
    return sections;
  }
  const container = keepTogetherApplies(node, options.kinds);
  const paperOnly = paperOnlyApplies(node, options.kinds);
  return sections.map((section) => ({
    ...section,
    fields: section.fields
      .filter((field) => field.propertyPath !== "print.keepTogether" || container)
      .map((field) =>
        field.propertyPath === "print.on" && !paperOnly
          ? {
              ...field,
              description: [field.description, builderText("inspector.print.paperOnlyBlocked", undefined, options.words)].filter(Boolean).join(" "),
              choices: field.choices.map((choice) => (choice.value === "paper" ? { ...choice, disabled: true } : choice))
            }
          : field
      )
  }));
}

/** `extra` placed right after the Required field, else at the end: the order within Validation. */
function insertAfterRequired(fields: PropertyEditorField[], extra: PropertyEditorField[]): PropertyEditorField[] {
  const at = fields.findIndex((field) => field.propertyPath === "required");
  return at < 0 ? [...fields, ...extra] : [...fields.slice(0, at + 1), ...extra, ...fields.slice(at + 1)];
}
