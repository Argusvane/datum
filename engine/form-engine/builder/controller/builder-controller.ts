import { defaultHiddenValueBehaviorFor } from "../../core/state/effective-state.js";
import type {
  CapabilityDefinition,
  ComponentDefinition,
  ComponentPaletteEntry,
  PropertyEditorDefinition,
  PropertyEditorField
} from "../../core/schema/contracts.js";
import { enginePluralAddresses, engineTexts, isEngineTextAddress } from "../languages/engine-texts.js";
import type {
  ComponentNode,
  ComponentRules,
  LocalizationConfiguration,
  SlotDefinition
} from "../../core/schema/types.js";
import type { FormTestConfiguration } from "../../core/form-tests/form-test-types.js";
import type { AdapterEntry, LiveAssets, LiveBinding } from "../../render/live/contract.js";
import { bindingById, registeredBindings } from "../../render/live/binding-registry.js";
import { basesOf, definitionKindsFor, drawnBaseOf, offeredKinds } from "../../registry/kinds.js";
import { frameOptions } from "../../render/live/datum/frames.js";
import { componentDrawingOf, isEmptyDrawing, type ComponentAdapterContext, type ComponentDrawing } from "../../plugins/component-adapters.js";
import { validationCodesRaisedBy } from "../../validation/core/field-constraints.js";
import { ENGINE_VALIDATION_CODES } from "../../core/localization/validation-messages.js";
import type { DataSourceResolver } from "../../render/core/component-options.js";
import { paperOnlyApplies, readComponentPrintSettings } from "../../render/core/print-options.js";
import type { DataSourceResult, DataSourceSet } from "../../core/schema/contracts.js";
import type { FormChromeConfiguration } from "../../core/schema/form-chrome.js";
import { assertValidComponentId, componentIdProblem, isValidComponentId } from "../../core/tree/component-id.js";
import { ComponentTree } from "../../core/tree/component-tree.js";
import { kernelStructureLimits, kernelStructureLimitsInverted, kernelStructureMessage, kernelStructureNameMax, kernelStructureVersionMax } from "../../core/expressions/definition-structure.js";
import { NESTING_MAX, nestsPast } from "../../core/tree/nesting.js";
import { assertSafePropertyPath, isPrototypeName } from "../../core/tree/prototype-names.js";
import { DATA_GRID_COMPONENT_TYPE, DATA_GRID_ROWS_CAP, normalizeDataGrids } from "../../core/schema/data-grid.js";
import {
  DATA_KEY_PROPERTY,
  buildDataPaths,
  buildRowCollections,
  dataKeyProblemOf,
  findDataKeyProblems,
  holdsData,
  isDataScopeContainer,
  type DataKeyProblem
} from "../../core/tree/data-scope.js";
import { TABS_COMPONENT_TYPE, readTabDescriptors } from "../../render/core/tab-slots.js";
import { isInlineOption } from "../../core/schema/inline-options.js";
import { normalizeLocaleTag, resolveLocalizedText } from "../../core/localization/localized-text.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import {
  declaredDefaultLocale,
  normalizeSupportedLocale,
  supportedLocaleCodes,
  supportedLocaleEntries,
  supportedLocaleOptions,
  type LocaleOption
} from "../../core/localization/supported-locales.js";
import {
  addressOf,
  addressOfPropertyPath,
  copyTranslations,
  isSafeSegment,
  isStale,
  listTranslations,
  makeDefaultLocale as swapDefaultTranslations,
  moveTranslations,
  pruneTranslations,
  reconcileTranslation,
  removeLocale as removeLocaleTranslations,
  renameLocale as renameLocaleTranslations,
  readFormTranslations,
  readFormTranslationsReport,
  readTranslation,
  resolveText,
  writeTranslation,
  writeTranslationEntry,
  writeTranslations,
  type DroppedTranslations,
  type FormTranslations,
  type TranslationEdit,
  type TextAddress,
  type TranslationPrefix
} from "../../core/localization/translations.js";
import { carryChange, carryLocalization, sameData, type OutsideDefaultEdit, type OutsideDocument } from "../../core/localization/locale-documents.js";
import {
  defaultAfterRemoval,
  effectiveDefaultLocale,
  languageCodeProblem,
  languageRenameProblem,
  withDefaultLanguage,
  withLanguageAdded,
  withLanguageLabel,
  withLanguageRemoved,
  withLanguageRenamed
} from "./language-edits.js";
import {
  addressKey,
  chromeTextRows,
  newlyRepeatedChromeId,
  sweepConfigurationTexts,
  tabLabelAddress,
  writeTextInConfiguration,
  type RenamedTextId
} from "./translation-rules.js";
import { ComponentRegistry } from "../../registry/components/component-registry.js";
import {
  applyDropIntent,
  readDragPayload,
  toDropIntent,
  type BuilderDragPayload,
  type BuilderDropIntent,
  type DataTransferLike
} from "../drag-drop/html5-drag-drop.js";
import { moveRefusal } from "../drag-drop/move-legality.js";
import {
  GRID_COMPONENT_TYPE,
  foldGridChildrenIntoColumns,
  gridColumnSlotIds
} from "../../core/schema/grid.js";
import {
  AddComponentCommand,
  CompositeCommand,
  EditComponentCommand,
  RegistryBackedTreeEditor,
  RemoveComponentCommand,
  ReplaceChildrenCommand,
  SetPropertyCommand,
  SetRulesCommand,
  TreeEditor,
  type BuilderMutationEvent
} from "../tree-editor/tree-editor.js";
import type { BuilderCommand } from "../history/command-history.js";
import { RenameStep } from "../history/rename-step.js";
import { renameIdInRuleSource, renameRowKeysInRuleSource, rowKeyMoveOf, unparsedFormulaNaming, type ValuePathMove } from "../formula/rename.js";
import { canAcceptInSlot, type ParentConstraintsResolver } from "../tree-editor/slot-constraints.js";
import { buildNestedTreeView, type NestedTreeNodeLabeler, type NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
import type { JourneyView } from "../../core/journey/journey-types.js";
import {
  buildInspectorModel,
  FORM_ROOT_COMPONENT_TYPE,
  type HostValidationCode,
  type BuilderDrawingSource,
  type InspectorChoice,
  type InspectorDrawnBy,
  type InspectorModel,
  type InspectorModelOptions
} from "../property-editor/inspector-model.js";
import { createComponentEditorContext } from "../property-editor/component-editor-context.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { ruleText } from "../property-editor/rule-source.js";
import { BuilderWords, formulaErrorText, type BuilderTextCatalog } from "../logic/builder-texts.js";
import { composePropertyEditor } from "../property-editor/editor-composer.js";
import { normalizeTrySubmission, type TrySubmissionSettings, type TrySubmissionUpdate } from "./try-submission.js";
import { dependentsOf, removalOf, rowKeysOf, rulesWithout, withoutDependents, type Dependent, type DependentsSource } from "./dependents.js";

// What leans on a component: the delete confirmation lists it, and Remove can clear it in one step.
export { dependentLines, dependentsHeading, dependentsOf, withoutDependents } from "./dependents.js";
export type { Dependent, DependentsSource, JourneyDependent, PdfDependent, RuleDependent, WithoutDependents } from "./dependents.js";
import { bindingClassChoices, bindingClassVocabulary, clearCssClassGroup, toggleCssClass, validateComponentCssClasses, type CssClassChoice } from "../property-editor/css-classes.js";
import { PANEL_LOOK_CLASSES } from "../../render/live/look-classes.js";

/**
 * One translatable text of the form as {@link BuilderController.translatableTexts} lists it: a string in the form's default language and the address its translations live at.
 * The builder still names the text by its `propertyPath` (`label`, `options.2.label`,
 * `messages.required`, `chrome.header.0.text`) to read and write the default; `address`
 * is the same text as the map keys it, by ids and values, never an index.
 */
export interface TranslatableText {
  componentId: string;
  /** The component's own label (the form's title on the root), resolved in the builder's locale. */
  componentLabel: string;
  propertyPath: string;
  /** The inspector's name for the property ("Label", "Pattern message"). */
  label: string;
  /** The inspector section the property sits in, when it has one. */
  section?: string;
  /** The text in the form's default language: what every language without a translation shows. */
  default: string;
  address: TextAddress;
}

/**
 * The language list's actions ({@link BuilderController.localizationActions}): each changes
 * `localization` and the translations map together as one undo step.
 */
export interface LocalizationActions {
  /** Adds a language; with no languages declared yet, `sourceLocale` declares the language the strings are written in first. */
  addLocale(code: string, label?: string, options?: { sourceLocale?: string }): boolean;
  /** Removes a language and its translations; the default language can go when another is left (it is made the default first). */
  removeLocale(code: string): boolean;
  /** Renames a language code: its translations, its place as the default and the canvas's language follow. */
  renameLocale(from: string, to: string): boolean;
  /** Makes a language the one the strings are written in: its wording becomes the strings, the old strings its translations. */
  makeDefaultLocale(code: string): boolean;
  /** Names a language (blank: its own name stands in). */
  relabelLocale(code: string, label: string): boolean;
}

/** What {@link BuilderController.makeDefaultLocale} computed before it runs, see `defaultSwapPlan`. */
interface DefaultSwapPlan {
  translations: FormTranslations;
  commands: BuilderCommand[];
  drafts: Array<{ componentId: string; edits: Array<{ propertyPath: string; value: string }> }>;
}

export interface BuilderComponentType {
  type: string;
  label: string;
  /**
   * Overrides the palette glyph for this type. One or two characters (an emoji, a symbol) —
   * it is escaped, so it cannot carry markup. Omit and the palette picks a built-in icon for
   * the type name, falling back to a generic one.
   */
  icon?: string;
  /**
   * The palette group this type is listed under. Omit and the palette infers a natural one
   * from the type name (Fields / Choices / Layout / Content / Actions, else Other); name one
   * to gather a host's custom components under their own heading, which is what keeps a
   * palette of dozens findable.
   */
  group?: string;
  /**
   * The id of the design-system binding this type belongs to (`ComponentPaletteEntry.binding`):
   * the palette and the add command offer it only while that binding draws the canvas
   * ({@link BuilderController.offeredTypes}); a form that already holds one keeps it, labelled.
   */
  binding?: string;
  /**
   * Not listed in the palette or offered by the add command, yet still a type the builder takes
   * (a drop, a paste, a panel's own add): the Journeys Step view hides its Page, Form field and
   * Route entries while its Form fields panel still places a form field there.
   */
  hidden?: boolean;
  /**
   * What the inspector's first tab calls a node of this type, where it is not a field: `"step"`
   * (a journey's step) reads Step, in the builder's own words (`inspector.tab.step`). Absent:
   * Field, and Settings on the root.
   */
  inspectorTab?: "step";
}

/**
 * One component type as the builder knows it ({@link BuilderController.typeInfo}): what a new
 * one starts as, the slots it offers children, how the palette lists it and the inspector
 * model a new one would be edited with. What the builder agent tools read to list
 * the insertable types and to check a slot before an insert; nothing in the builder's own UI
 * needs it.
 */
export interface BuilderTypeInfo {
  type: string;
  /** What a new node of the type starts as: the registered default, else the generic shape with the type as its id. */
  template: ComponentNode;
  /** The type's child slots, as its definition declares them; absent for a leaf or without a registry. */
  slots: SlotDefinition[] | undefined;
  /** The palette entry: the one the builder lists now, else the definition's own; absent when neither has one. */
  palette: ComponentPaletteEntry | undefined;
  /**
   * Always `false`: fixed is a fact about a node a PDF template listed
   * ({@link BuilderController.isFixedNode}), never about a type the agent could insert.
   */
  fixed: boolean;
  /** The inspector model a new node of the type is edited with, composed as {@link BuilderController.inspectorModel} composes it. */
  model: InspectorModel | undefined;
}

/**
 * The palette entries a list of component definitions declares (`ComponentDefinition.palette`):
 * one {@link BuilderComponentType} per definition that carries one, in the definitions'
 * order. A definition without one is not the palette's to offer — the form root, a type the
 * host lists itself through `componentTypes` — so it is skipped rather than given a made-up
 * label. What a plugin's components (`FormPlugin.components`) contribute to the palette.
 */
export function paletteEntriesOf(definitions: readonly ComponentDefinition[]): BuilderComponentType[] {
  const entries: BuilderComponentType[] = [];
  for (const definition of definitions) {
    const palette = definition.palette;
    if (!palette) {
      continue;
    }
    entries.push({
      type: definition.type,
      label: palette.label,
      ...(palette.icon !== undefined ? { icon: palette.icon } : {}),
      ...(palette.group !== undefined ? { group: palette.group } : {}),
      ...(palette.binding !== undefined ? { binding: palette.binding } : {})
    });
  }
  return entries;
}

/**
 * One entry of the canvas's locale switcher. The same shape the rendered switcher offers
 * (`LocaleOption`): both are derived from the form's own `localization`.
 */
export type BuilderLocaleOption = LocaleOption;

/**
 * One design-system binding the canvas can preview the form in (the binding picker's entry).
 *
 * The canvas previews through the real renderer, so the design system is part of what is being
 * authored: "does this label still fit in the department's design system" is a question about the
 * form, asked while designing it. `binding` is the object to draw with; left out, the id is looked
 * up in the page's binding registry (`registerBinding`), and `"datum"` is Datum's own.
 */
export interface BuilderBindingOption {
  id: string;
  label: string;
  binding?: LiveBinding | undefined;
  /**
   * The design system's files the canvas draws this entry with. Left out, the entry draws with
   * none, unless it is the host's own binding, which draws with the host's `assets`: one design
   * system's files never style another's form.
   */
  assets?: LiveAssets | undefined;
}

/** One entry of the binding picker ({@link BuilderController.bindingChoices}). */
export interface BuilderBindingChoice {
  /** The offered binding choosing this entry picks. */
  id: string;
  /** The name of the binding the canvas draws for it under the builder's scheme. */
  label: string;
  /** Whether the canvas draws with it now. */
  selected: boolean;
}

/**
 * The definition's own name and versions — `FormDefinition.id`, `version` and
 * `schemaVersion` — the fields that name a form in a submission envelope, a draft's
 * compatibility check and a host's storage. Definition-level like `localization`: the Form
 * panel edits them, and the host reads them back to persist beside the tree.
 */
export interface FormIdentity {
  id: string;
  version: string;
  schemaVersion: string;
}

export interface BuilderControllerOptions {
  componentTypes?: BuilderComponentType[];
  initialRoot?: ComponentNode;
  /**
   * When supplied, the controller uses a registry-backed editor (slot constraints + composed inspector).
   * Left out of a later {@link BuilderController.setOptions}, the definitions stay, a new `initialRoot`
   * included; an empty list takes them away.
   */
  componentDefinitions?: ComponentDefinition[];
  /** The language the canvas and the inspector show the form in (a label resolves through the translations). Defaults to `"en"`. */
  locale?: string;
  /**
   * The `FormDefinition.localization` of the form being edited. Like `initialRoot`, this is
   * the *initial* value: the form-level properties panel edits it (supported locales and
   * their labels, default locale), and the host reads the authored result back via
   * {@link BuilderController.localization} to persist on the definition beside the tree.
   * The canvas's locale switcher and the inspector's per-locale editors are derived from it;
   * with no localization configured, neither is offered.
   */
  localization?: LocalizationConfiguration | undefined;
  /**
   * The `FormDefinition.translations` of the form being edited: the *initial* value,
   * like {@link localization}. Read through the tolerant reader, so a hand-edited file with an
   * unsafe segment or a malformed leaf loads without them. The builder's rules (delete prunes,
   * duplicate copies, renames move) and the Languages workspace edit it from here on, and the
   * host reads the result back via {@link BuilderController.translations} to persist beside
   * the tree.
   */
  translations?: FormTranslations | undefined;
  /**
   * The definition's identity (`id`, `version`, `schemaVersion`), edited like
   * {@link localization}: this is the *initial* value, the form-level properties panel's
   * Identity section edits it, and the host reads the authored result back via
   * {@link BuilderController.identity} to persist on the definition. Absent, the builder
   * offers no Identity section — the host owns the identity outright.
   */
  identity?: FormIdentity | undefined;
  /**
   * The design-system binding the canvas draws the form with, as the host's form element is
   * given it: a binding, the id of one registered on the page (or offered in
   * {@link availableBindings}), or nothing for Datum's own. A pick in the binding picker wins
   * over it until the host sets another. Choosing a binding changes nothing in the form or its
   * PDF layouts.
   */
  binding?: LiveBinding | string | undefined;
  /** The design system's files, as the host serves them to its form element (`assets`). */
  assets?: LiveAssets | undefined;
  /** The design-system bindings the canvas offers in its binding picker ({@link BuilderController.availableBindings}). */
  availableBindings?: BuilderBindingOption[];
  /**
   * Adapters by component type laid over the binding the canvas draws with
   * (`extendBinding(binding, { components })`): how a designer's own tree draws on the canvas
   * (the PDF designer's bands, the journey designer's pages and routes).
   */
  canvasComponents?: Readonly<Record<string, AdapterEntry>> | undefined;
  /**
   * When supplied, the sheet's width is the tree's to decide, not the author's. The canvas
   * calls this with the tree it is about to preview (drafts laid over, so an unsaved edit
   * shows) and lays the form out exactly that many CSS pixels wide, its own sheet padding
   * around it; the Preview width picker and the sheet's drag grips are put away, and
   * {@link BuilderController.previewWidth} is set aside until the option is cleared. The PDF
   * designer sizes the sheet from the document's page setup this way, so a page previews at
   * its paper width and turns with its orientation. `undefined` from the function means
   * "no opinion": the sheet falls back to the author's width for that repaint.
   */
  sheetWidth?: ((root: ComponentNode) => number | undefined) | undefined;
  /**
   * Whether the sheet's width is the author's to pick (default true). False puts the Preview
   * width picker and the sheet's drag grips away without fixing a width: the journey designer's
   * sheet is fluid but shows no devices.
   */
  previewWidths?: boolean | undefined;
  /**
   * Resolves `select` options in the canvas preview. Without one a data-source-backed select
   * previews with just its placeholder; with it, the author sees the real options.
   */
  dataSourceResolver?: DataSourceResolver | undefined;
  /**
   * Data sources the host defined at wiring time (`defineDataSources`) — the same set it hands
   * the renderer. The canvas previews them ahead of {@link dataSourceResolver}, and the
   * inspector's Data source picker lists their ids.
   */
  dataSources?: DataSourceSet | undefined;
  /**
   * Further data source ids the picker should offer: sources registered on the runtime rather
   * than defined at wiring time, which the builder cannot see on its own.
   */
  dataSourceIds?: string[];
  /**
   * Validation codes the host knows about beyond the engine's own — the keys of its page's
   * message catalog, the codes its server or sandboxed rules return — which the messages
   * editor offers after the engine's. A bare code, or `{ code, label, message }`
   * — `message` being the page's own wording for the code, which the editor shows as the
   * fallback a blank row keeps and offers to copy in.
   */
  validationCodes?: HostValidationCode[];
  /*
   * The hooks below let a builder mode whose tree is not a form (a journey, whose
   * nodes carry internal ids and name themselves by a title or a form component) say what
   * the form's conventions cannot. Each is optional; without them the controller is what it
   * was for the form and the PDF layouts.
   */
  /**
   * What the outline and the tree view call a node (see `NestedTreeNodeLabeler`), drafts
   * applied. `undefined` or blank: its `label`, else its id.
   */
  nodeLabel?: NestedTreeNodeLabeler | undefined;
  /**
   * How the inspector draws a node's ID row: editable (the default below the root), read-only
   * with the given text, or not at all — for a tree whose ids are the builder's own bookkeeping.
   * `help` replaces the row's "?" text. Called with the edited node; `undefined` keeps the default.
   */
  idRow?: ((node: ComponentNode, place: { isRoot: boolean }) => BuilderIdRow | undefined) | undefined;
  /**
   * What else holds a node's Save back, for the tree's own rules — a journey page id
   * that another page, or a form component, already has. Called with the edited node (drafts
   * applied), the committed tree and the node's committed id. A problem counts only while the
   * draft changes the property its `target` names (`"id"` for the id): a clash the tree
   * already had is the mode's to report elsewhere, and never holds up an unrelated edit.
   * Listed by {@link BuilderController.problemsOf} and refused by
   * {@link BuilderController.commitDraft}, the unsaved-changes prompt's Save included.
   */
  problems?: ((edited: ComponentNode, tree: ComponentNode, componentId: string) => readonly BuilderProblem[]) | undefined;
  /**
   * The choices of a `select` property that declares none (see `InspectorModelOptions.fieldChoices`):
   * the form's components for a journey question, the pages a route may go to. Called with the
   * edited node and the field; `undefined` leaves the field as declared.
   */
  fieldChoices?: ((node: ComponentNode, field: PropertyEditorField) => InspectorChoice[] | undefined) | undefined;
  /**
   * What the tree's owner has to say about a node that holds nothing back (the advisory
   * side): a journey page no path reaches, a question whose component the form no
   * longer has. Each note is drawn under the box its `target` names, or above the sections when
   * it names none the panel draws; a Save never waits on one. Called with the edited node
   * (drafts applied), the committed tree and the node's committed id, like {@link problems}.
   */
  notes?: ((edited: ComponentNode, tree: ComponentNode, componentId: string) => readonly BuilderNote[]) | undefined;
  /**
   * What a Save writes for a node, from what its draft holds: the tree's owner keeping a value
   * inside what it can mean — a PDF template area's rectangle kept on its page. Called with the
   * edited node (drafts applied) on {@link BuilderController.commitDraft}; the configuration it
   * returns is what lands, in the same undo entry. `undefined` lands the draft as it is.
   */
  normalizeCommit?: ((edited: ComponentNode, tree: ComponentNode) => Record<string, unknown> | undefined) | undefined;
  /**
   * The inspector sections of a node that start folded, by section id — what an author opens
   * only now and then (a journey's Wording). The author's own fold wins once they toggle one.
   * `undefined` or empty: every section starts open, as on the form.
   */
  foldedSections?: ((node: ComponentNode) => readonly string[] | undefined) | undefined;
  /**
   * Ghost text for a text box the node leaves empty: what an unset property stands for — the
   * id a journey page is written under while its page id is blank. `undefined` keeps the
   * builder's own (the Data key's component id).
   */
  fieldPlaceholder?: ((node: ComponentNode, field: PropertyEditorField) => string | undefined) | undefined;
  /**
   * Boxes a node's inspector draws beyond what its definition declares, each in the section
   * `section` names (by id): what changes with the canvas rather than with the type — the
   * Journeys Step view's Wording box for the row of a Check answers step the author pressed.
   * Read each time the inspector is composed; the box's id must be unique among the node's.
   * Only the inspector's drawing and the draft's reading of it follow: the definition (what the
   * Languages workspace lists, what a draft is checked against) is not changed.
   */
  inspectorFields?: ((node: ComponentNode) => ReadonlyArray<{ section: string; field: PropertyEditorField }> | undefined) | undefined;
  /**
   * Ids a new node never takes although no node has them now: a journey's deleted pages, which
   * a route may still name, so a page added later is not the one it goes to. Read
   * each time an id is made (the palette's add, a drop from it).
   */
  reservedIds?: (() => Iterable<string>) | undefined;
  /**
   * Whether {@link BuilderController.renameId} rewrites the tree's rules that read the old id
   * (one undo step beside the rename; see there). Absent: it does. `false` for a tree whose
   * owner follows a rename into its rules itself (a journey designer's own nodes,
   * whose mode writes the follow-up as one step with its worked-out values).
   */
  renameFollowsRules?: boolean | undefined;
  /**
   * Configuration property paths whose value is a formula the tree's owner reads as a rule
   * (a PDF layout root's `when`, written through {@link BuilderController.setDraftProperty}
   * rather than `rules`). A draft that changes one to text the parser refuses is a
   * `rules:<path>` problem and held back at Save, as for `rules[key]`.
   */
  ruleTargets?: readonly string[] | undefined;
  /**
   * Ids something beside the tree already owns: the nodes a presentation holds of its own, which the Journeys mode claims for the form. A new node never takes one, and a
   * rename to one is refused with an {@link BuilderController.idError}. Read each time.
   */
  claimedIds?: (() => Iterable<string>) | undefined;
  /**
   * What a new node of `type` is numbered under (`<prefix>_<n>`), when not its type: a
   * journey's worked-out value (`journey-value`), whose type starts with the prefix
   * the designer keeps for its own nodes. `undefined` keeps the type. Read each time an id is
   * made (the palette's add, a drop from it).
   */
  idPrefix?: ((type: string) => string | undefined) | undefined;
  /**
   * What the canvas draws of the tree (drafts laid over), when not the tree itself: a journey's
   * copy whose nodes of its own carry no `rules`, so a rule the canvas would evaluate
   * against blank answers never hides a card. Everything else — the inspector, the outline, the
   * owner's own reads of {@link BuilderController.previewSnapshot} — sees the tree as it is.
   */
  canvasRoot?: ((root: ComponentNode) => ComponentNode) | undefined;
  /**
   * The canvas's own tree view, when the canvas draws a tree that is not the controller's (one
   * journey step, its root the page node and its nodes not the journey tree's). Set, the canvas
   * walks, marks drop zones from and names the selection by {@link BuilderController.canvasTreeView}:
   * the view the controller builds over {@link BuilderController.canvasSnapshot} with its own
   * resolver, locale, labeler and label sources, handed through this hook, which may prune it
   * (a placed form container's slots are the form's, not the step's) or name a node as the node
   * it stands for (`tools.viewOf`). `undefined` (every canvas but the step's): the canvas reads
   * {@link BuilderController.treeView} and {@link BuilderController.rootId}, as it always has.
   */
  canvasView?: ((view: NestedTreeNodeView, tools: CanvasViewTools) => NestedTreeNodeView) | undefined;
  /**
   * The journey page the canvas draws its tree as (one journey step in edit mode): handed to the
   * preview with the tree (`BuilderPreviewRuntime.setFormRoot`), so the renderer draws the page's
   * own heading, counter, Back and Continue. Called with {@link BuilderController.previewSnapshot}.
   * `undefined`, or a hook answering `undefined`: the tree is drawn as the whole form. Never saved.
   */
  canvasJourneyView?: ((root: ComponentNode) => JourneyView | undefined) | undefined;
  /**
   * A word on a drawn component's box, by drawn id, in the caller's words (one journey step's
   * journey-only field: "Not sent"). Called with {@link BuilderController.previewSnapshot} each
   * time the canvas builds its hooks. `undefined`: no tags (every canvas but the step's).
   */
  canvasTags?: ((root: ComponentNode) => ReadonlyMap<string, string>) | undefined;
  /**
   * What the page's own chrome on the canvas selects (one journey step's heading, counter, Back
   * and Continue: the page node), and the name its boxes carry. Called with
   * {@link BuilderController.previewSnapshot}. `undefined`, or a hook answering `undefined`: the
   * chrome is drawn unwrapped and selects nothing.
   */
  canvasRegionOwner?: ((root: ComponentNode) => CanvasRegionOwner | undefined) | undefined;
  /**
   * The drawn ids a click selects another for, and what it selects (a field inside a placed form
   * container -> the placement): drawn as part of that box, with no box of its own.
   * Called with {@link BuilderController.previewSnapshot}. `undefined`: every drawn id is its own.
   */
  canvasSelectTarget?: ((root: ComponentNode) => ReadonlyMap<string, string>) | undefined;
  /**
   * The step picker on the canvas bar (the Previous and Next buttons and the "Step 2 of 4 · name"
   * line) for a canvas that walks something the tree does not hold as a steps container: one
   * journey step at a time. Called each time the bar is drawn. `undefined`, or a hook answering
   * `undefined`: the bar's picker walks the steps container of the tree drawn, as it always has.
   */
  canvasStepper?: (() => CanvasStepper | undefined) | undefined;
  /**
   * The colour scheme the canvas draws in, for a controller drawing another's form (a journey's
   * Step view draws the form's sheet with the form's binding): read at each draw in place of
   * {@link BuilderController.canvasColorScheme}'s own answer, which follows the shell's scheme
   * only on the controller the shell gives it. `undefined`, or a hook answering `undefined`: the
   * controller's own.
   */
  canvasScheme?: (() => "light" | "dark" | undefined) | undefined;
  /**
   * What a slot a node's type does not declare takes, by the node's type (`ParentConstraints.
   * otherSlots`): a journey's own layouts — a grid's columns, a type the host does not define —
   * take only what a page-only layout may hold. `undefined`: anything.
   */
  otherSlots?: ((type: string) => Omit<SlotDefinition, "id"> | undefined) | undefined;
}

/**
 * Something the tree's owner says about a component that never holds its Save back (see
 * {@link BuilderControllerOptions.notes}): `target` is the property path of the box it is about
 * (`rules:<key>` for a rule on the Rules tab); absent, or naming no box the panel draws, the
 * note sits above the sections.
 */
export interface BuilderNote {
  target?: string | undefined;
  message: string;
  /** How much it matters; a note is advisory either way. Default `"warning"`. */
  severity?: "error" | "warning" | undefined;
  /**
   * The definition check's code when the note says what that check says (`component.limits.inverted`),
   * so a reader that lists the check's findings as well can list it once.
   */
  code?: string | undefined;
}

/** How the inspector draws a node's ID row; see {@link BuilderControllerOptions.idRow}. */
export interface BuilderIdRow {
  /** `edit`: the id box (the root is always read-only, having no parent to be re-seated in); `static`: text; `hidden`: no row. */
  mode: "edit" | "static" | "hidden";
  /** What a `static` row shows. Default: the node's id. */
  text?: string | undefined;
  /** What the row's "?" says. Default: the builder's own words about ids. */
  help?: string | undefined;
}

/**
 * A definition-level setting that something beside the tree owns — a builder mode's catalog
 * (the Journeys mode's "Opens as") — edited on the form root's draft like the form's
 * identity: {@link BuilderController.setDraftRootSetting} drafts a value, Save commits it
 * through `set`, Cancel forgets it, and the unsaved-changes prompt counts it. The owner's `set`
 * decides how the change enters the undo history.
 */
export interface BuilderRootSetting {
  /** Unique among the settings drafted on one controller. */
  id: string;
  /** The committed value, read live. */
  get(): string;
  /** Commits a value a Save found changed. */
  set(value: string): void;
}

/**
 * `"preview"` marks a change that restyled or repopulated the canvas without touching the
 * tree (a binding / dataSourceResolver swap via {@link BuilderController.setOptions}): the
 * canvas repaints on it like any other change, but a host must not treat it as an edit — its
 * `root` is the same tree, and rebuilding a runtime from it would wipe live form state.
 */
export type BuilderChangeReason = "init" | "add" | "move" | "remove" | "edit" | "select" | "preview";

/** What {@link BuilderController.add} seeds a new component with, beyond its type's default. */
export interface AddComponentInit {
  /** The id to create it under, when free and valid; otherwise the controller numbers it. */
  id?: string | undefined;
  /** Configuration laid over the type's default. */
  configuration?: Record<string, unknown> | undefined;
}

/**
 * One whole subtree for {@link BuilderController.insertComponents} to place: under `parentId`
 * (default: the root) in `slotId` (default: where a palette click would put it), at `index`
 * (default: the end of the slot as the entries before it left it).
 */
export interface InsertComponentEntry {
  node: ComponentNode;
  parentId?: string | undefined;
  slotId?: string | undefined;
  index?: number | undefined;
  /**
   * What a paste carries from another form: that form's translations for the
   * components of `node`'s subtree, as a map fragment keyed by their ids as they stand in `node`.
   * Only the languages this form declares and the texts the inserted subtree words are taken;
   * an entry that was stale in the clipboard stays stale.
   */
  translations?: FormTranslations | undefined;
}

export interface InsertComponentsOptions {
  /** Whether the first inserted component takes the selection (the default) or it stays put. */
  select?: "first" | "none";
  /**
   * New component id → the id whose translations it carries, for a copy made within this form
   * (a duplicate): the original keeps its own entries and the copy gets the same under its id,
   * in the same undo entry.
   */
  copiedFrom?: Readonly<Record<string, string>> | undefined;
}

/**
 * Something that holds a component's Save back, and where it is: `"id"` for its id, else the
 * property path of the box that holds the unusable value (`cssClass`, `dataKey`). A panel
 * draws the message under that box and leads the author there when Save is pressed.
 */
export interface BuilderProblem {
  target: "id" | (string & {});
  message: string;
}

/** What the page's own chrome on the canvas selects ({@link BuilderControllerOptions.canvasRegionOwner}). */
export interface CanvasRegionOwner {
  /** The node selected (a journey step's page node). */
  id: string;
  /** The accessible name of the chrome's boxes, worded by the caller ("Step 2 · How to reach you"). */
  label: string;
  /**
   * Called as a press on the chrome is about to select `id`: `"buttons"` for a region holding the
   * page's Continue, Submit or Back (marked `data-journey-continue` / `data-journey-back`, whatever
   * the binding drew), `"heading"` for the rest. The Journeys Step view opens the step's Wording
   * section for the first. `element` is the id of the drawn element inside the chrome the press
   * landed on, when it landed on one that has an id (a row of a Check answers step's list).
   */
  onPress?(part: "buttons" | "heading", element?: string): void;
}

/** The step the canvas bar's picker shows and walks ({@link BuilderControllerOptions.canvasStepper}). */
export interface CanvasStepper {
  /** Which step is shown, from 0. */
  index: number;
  /** How many steps there are. */
  total: number;
  /** The shown step's name, worded by the caller. */
  label: string;
  /** Shows the previous (-1) or the next (1) step. */
  go(delta: -1 | 1): void;
}

/** What {@link BuilderControllerOptions.canvasView} is handed beside the view. */
export interface CanvasViewTools {
  /** The tree the canvas root was made from: {@link BuilderController.previewSnapshot}, taken once for this view. */
  root: ComponentNode;
  /** `node`'s view as the controller builds its own ({@link BuilderController.treeView}): its slots' definitions, its label in the locale. */
  viewOf(node: ComponentNode): NestedTreeNodeView;
}

/** What an insert or a replace did: the ids it placed, or why it placed nothing. */
export interface InsertComponentsResult {
  ok: boolean;
  /** The top-level ids placed, in order; empty on a refusal. */
  ids: string[];
  /** Why nothing was placed. */
  error?: string;
}

/**
 * A slot a component may move to, from {@link BuilderController.moveTargets}: by the
 * rules a drop meets (`drag-drop/move-legality.ts`) plus a fixed node and a data-place clash.
 */
export interface BuilderMoveTarget {
  parentId: string;
  slotId: string;
  /** A journey page's own id when the parent is one; its node id stays internal. */
  pageId?: string;
  /** The outline's name for the parent (a journey page by its title). */
  label: string;
  /** The slot's name, when the parent has more than one slot that takes the component (a tab's label, a column). */
  slotLabel?: string;
  /** How deep the parent sits: 0 for the tree's root. */
  depth: number;
  /** What the slot holds already, the moving component left out, in order. */
  siblings: Array<{ id: string; label: string }>;
  /** The component's own position, when this is the slot it sits in. */
  current?: number;
}

/** What {@link BuilderController.moveToResult} did: whether it moved, and what it left empty. */
export interface BuilderMoveToResult {
  moved: boolean;
  /**
   * The container the component came out of when the move left it empty: a journey page by its
   * `pageId`, any other container by its component id. Empty otherwise, and on a refusal.
   */
  leftEmpty: string[];
}

/**
 * What the author was doing when the selection's unsaved edits held it back — see
 * {@link BuilderController.unsavedChangesPrompt}. The panel's wording follows it. `leave` is
 * the host's: switching away from the builder page, closing it (see {@link BuilderController.requestLeave}).
 */
export type HeldActionKind = "select" | "add" | "drop" | "leave" | "replace" | "remove" | "panel";

/**
 * A held action. `follow` gives the id a component has when the action runs for the id it had
 * when the action was held: the prompt's Save may rename the component the draft is of, and an
 * action aimed at it (a drop into it, a move of it) must land on it under its new id.
 */
type HeldRun = (follow: (id: string) => string) => void;

/**
 * A selection-changing action the controller is holding until the author says what to do
 * with the selected component's unsaved edits.
 */
export interface UnsavedChangesPrompt {
  /** The component whose draft is in the way — the current selection — or, for a leave guard's edits, what the guard names. */
  componentId: string;
  action: HeldActionKind;
  /** Set when the edits are a {@link LeaveGuard}'s rather than a draft's: the guard's owner puts up the prompt, not the panels. */
  external?: LeaveGuardSubject;
}

/** The answer to an {@link UnsavedChangesPrompt}. */
export type UnsavedChangesDecision = "save" | "discard" | "stay";

/** How a leave guard's unsaved edits are named to the author. */
export interface LeaveGuardSubject {
  /** An id-like tag for them — a layout's id. */
  id: string;
  label: string;
  /** Save is refused (an unusable id, say): the prompt offers Keep editing and Discard only. */
  blocked: boolean;
}

/**
 * Unsaved edits kept outside the tree — a mode's own editor, such as the PDF designer's
 * template mapping — that leaving the builder must not walk past either. Once the tree's own
 * draft is clean, {@link BuilderController.requestLeave} asks the guard, holds the departure
 * while it has edits pending, and settles them through `save` or `discard` when the prompt is
 * answered. The prompt names no component, so the panels leave drawing it to the guard's owner.
 */
export interface LeaveGuard {
  pending(): boolean;
  subject(): LeaveGuardSubject;
  /** Saves the edits; `false` refuses, the edits stay, and the refusal shows where the owner shows it. */
  save(): boolean;
  discard(): void;
}

/**
 * Uncommitted properties-panel edits for one component. The panel writes here on every
 * keystroke and the canvas previews from it, but nothing reaches the tree — or the undo
 * history — until {@link BuilderController.commitDraft}. That is what makes Save / Cancel mean
 * something: Cancel throws the draft away and the tree was never touched.
 *
 * Drafts are held per component rather than one-at-a-time, so selecting another field to check
 * its id and coming back does not silently discard what was typed.
 */
interface ComponentDraft {
  /** Pending id. Applied by {@link BuilderController.commitDraft} through `renameId`. */
  id: string;
  configuration: unknown;
  rules: ComponentRules | undefined;
  /** Only on the form root's draft: the pending {@link FormIdentity}. */
  identity?: FormIdentity | undefined;
  /** Only on the form root's draft: the pending {@link BuilderRootSetting} values, by setting id. */
  settings?: Map<string, { setting: BuilderRootSetting; value: string }>;
}

/**
 * Trims a {@link FormIdentity}'s fields. A field left blank is not a new value: it takes the
 * `fallback`'s (the committed identity, on Save), because a form with no id or version is
 * not something a host can store or submit against. `keepWhitespace` is the draft path's —
 * the panel repaints its boxes from the draft per keystroke, and trimming there would erase
 * the space just typed; Save trims. `undefined` in means `undefined` out: no identity at all.
 */
export function normalizeFormIdentity(
  value: FormIdentity | undefined,
  options: { fallback?: FormIdentity | undefined; keepWhitespace?: boolean } = {}
): FormIdentity | undefined {
  if (!value) {
    return undefined;
  }
  const field = (key: keyof FormIdentity): string => {
    const raw = typeof value[key] === "string" ? value[key] : "";
    const clean = options.keepWhitespace ? raw : raw.trim();
    return clean.trim().length > 0 ? clean : (options.fallback?.[key] ?? "");
  };
  return { id: field("id"), version: field("version"), schemaVersion: field("schemaVersion") };
}

/**
 * Collapses a `tests` block to its meaningful content: entries that are not an object
 * with a non-empty string `id` and a string `source` are dropped, a repeated id keeps its first
 * entry, and a block with nothing left is `undefined`, so a form with no scenarios carries no
 * `tests` key at all. The source text is kept exactly: it is what the author typed.
 */
export function normalizeTestsConfiguration(value: FormTestConfiguration | undefined): FormTestConfiguration | undefined {
  const entries = (value as { scenarios?: unknown } | undefined)?.scenarios;
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const seen = new Set<string>();
  const scenarios: FormTestConfiguration["scenarios"] = [];
  for (const entry of entries as unknown[]) {
    const candidate = entry as { id?: unknown; source?: unknown } | null;
    if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || candidate.id.length === 0 || typeof candidate.source !== "string" || seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    scenarios.push({ id: candidate.id, source: candidate.source });
  }
  return scenarios.length > 0 ? { scenarios } : undefined;
}

/**
 * Collapses a {@link LocalizationConfiguration} to its meaningful content: blank codes and
 * strings are dropped, and a configuration with nothing left collapses to `undefined` — the
 * same philosophy as `fromLocalizedTextParts`, so a single-language form carries no
 * localization block at all.
 *
 * Labels are trimmed.
 */
export function normalizeLocalizationConfiguration(
  value: LocalizationConfiguration | undefined
): LocalizationConfiguration | undefined {
  if (!value) {
    return undefined;
  }
  const out: LocalizationConfiguration = {};
  // An entry that names no language is dropped, and a repeated code keeps its first entry.
  const seen = new Set<string>();
  const supported = (value.supportedLocales ?? [])
    .map(normalizeSupportedLocale)
    .map((entry) =>
      entry.label !== undefined ? { code: entry.code, label: entry.label.trim() } : entry
    )
    .filter((entry) => {
      if (entry.code.length === 0 || seen.has(entry.code)) {
        return false;
      }
      seen.add(entry.code);
      return true;
    });
  if (supported.length > 0) {
    out.supportedLocales = supported;
  }
  // A block from outside can hold anything: a default that is not text is absent.
  const defaultLocale = declaredDefaultLocale(value);
  if (defaultLocale) {
    // Tags compare case-insensitively, so a default that names a listed language in
    // another spelling takes the list's: every reader then finds one spelling for one language.
    // An entry spelled exactly as the default wins, so a list that holds two spellings keeps the
    // language the definition named as the default.
    const key = normalizeLocaleTag(defaultLocale);
    out.defaultLocale =
      supported.find((entry) => entry.code === defaultLocale)?.code ??
      supported.find((entry) => normalizeLocaleTag(entry.code) === key)?.code ??
      defaultLocale;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The PDF layouts' block with every layout's own document language (`accessibility.lang`) that was
 * `from` now `to`: it is a code the form declares written as plain text, outside any translation,
 * so a language renamed in the form must reach it. The block itself when no layout names `from`.
 */
function renameLayoutLanguage(block: unknown, from: string, to: string): unknown {
  if (!isPlainObject(block) || !Array.isArray(block.layouts)) {
    return block;
  }
  let touched = false;
  const layouts = block.layouts.map((layout: unknown) => {
    if (!isPlainObject(layout) || !isPlainObject(layout.accessibility) || layout.accessibility.lang !== from) {
      return layout;
    }
    touched = true;
    return { ...layout, accessibility: { ...layout.accessibility, lang: to } };
  });
  return touched ? { ...block, layouts } : block;
}

/** Every id in a subtree, so removing a component takes its descendants' drafts with it. */
function collectIds(node: ComponentNode): string[] {
  const ids = [node.id];
  for (const group of Object.values(node.children ?? {})) {
    for (const child of group) {
      ids.push(...collectIds(child));
    }
  }
  return ids;
}

/**
 * What is wrong with an identity's id and version against the kernel's limits, in words, by field
 * (the Identity section and {@link BuilderController.setIdentity} read the same limits).
 */
function identityLimitProblems(identity: FormIdentity | undefined): { id?: string; version?: string } {
  const problems: { id?: string; version?: string } = {};
  if (identity && identity.id.trim().length > kernelStructureNameMax()) {
    problems.id = `The id can be at most ${kernelStructureNameMax()} characters.`;
  }
  if (identity && identity.version.trim().length > kernelStructureVersionMax()) {
    problems.version = `The version can be at most ${kernelStructureVersionMax()} characters.`;
  }
  return problems;
}

/**
 * Whether `root` nests past what the server reads: a component with children at the limit's
 * level or deeper, counted from 1 at the root as the validator counts. An explicit stack, so a
 * tree nested however deep is measured without exhausting the call stack.
 */
function nestsTooDeep(root: ComponentNode): boolean {
  const limit = kernelStructureLimits().depth;
  const stack: Array<{ node: ComponentNode; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: ComponentNode; depth: number };
    if (!node.children) {
      continue;
    }
    if (depth >= limit) {
      return true;
    }
    for (const group of Object.values(node.children)) {
      for (const child of group) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return false;
}

/** Every node in a subtree, in document order. */
function collectNodes(node: ComponentNode): ComponentNode[] {
  return [node, ...Object.values(node.children ?? {}).flat().flatMap(collectNodes)];
}

/**
 * `rules` with every form-scoped path whose leading segment (up to the first `.` or `[`) is a
 * key of `renames` led by its new id instead; paths read from elsewhere (`row.`, `ancestor.`,
 * `host.`, `component`) and every other path are left as written.
 */
function repointRulePaths(rules: ComponentRules, renames: ReadonlyMap<string, string>): ComponentRules {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (!isPlainObject(value)) {
      return value;
    }
    if (value.kind === "path" && typeof value.path === "string") {
      const path = value.path;
      const end = path.search(/[.[]/);
      const lead = end < 0 ? path : path.slice(0, end);
      const scoped = lead === "component" || lead === "row" || lead === "ancestor" || lead === "host";
      const to = scoped ? undefined : renames.get(lead);
      return to === undefined ? value : { ...value, path: `${to}${path.slice(lead.length)}` };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
  };
  return visit(rules) as ComponentRules;
}

/**
 * `rules` with every rule that reads `from` rewritten to read `to` (`renameIdInRuleSource`: a
 * formula string over the parser's spans, a tree through its path nodes, the object form through
 * both), the same object when none does; and, per rule, a formula that spells `from` but does
 * not parse, left as written. Every key of the object is a rule, so every key is read. A read of
 * a row's key (`row.sku`) is not the id's: it follows the keys the rename moved instead.
 */
function renameRules(rules: ComponentRules, from: string, to: string): { rules: ComponentRules; unparsed: Array<{ rule: string; formula: string }> } {
  const unparsed: Array<{ rule: string; formula: string }> = [];
  let next: Record<string, unknown> | undefined;
  for (const [key, rule] of Object.entries(rules)) {
    const formula = unparsedFormulaNaming(rule, from);
    if (formula !== undefined) {
      unparsed.push({ rule: key, formula });
    }
    const renamed = renameIdInRuleSource(rule, from, to);
    if (renamed !== rule) {
      next ??= { ...rules };
      next[key] = renamed;
    }
  }
  return { rules: next === undefined ? rules : (next as ComponentRules), unparsed };
}

/**
 * A value as JSON with every object's keys sorted and `undefined` members left out, so two
 * values that mean the same configuration compare equal whatever order their keys were written in.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry: unknown) =>
    isPlainObject(entry) ? Object.fromEntries(Object.keys(entry).sort().filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])) : entry
  );
}

/**
 * `draft` with every path that differs between `before` and `after` set to `after`'s value
 * (removed where `after` has none), its other paths left as they are: a step through the
 * history re-set into an open draft. Objects are followed key by key; anything else (an
 * array, a text) is one value. `undefined` when nothing is left where `after` has nothing.
 */
function restoreTouchedPaths(draft: unknown, before: unknown, after: unknown): unknown {
  if (canonicalJson(before) === canonicalJson(after)) {
    return draft;
  }
  const from = before ?? {};
  const to = after ?? {};
  if (isPlainObject(from) && isPlainObject(to) && isPlainObject(draft)) {
    const out: Record<string, unknown> = { ...draft };
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      const value = restoreTouchedPaths(draft[key], from[key], to[key]);
      if (value === undefined) {
        delete out[key];
      } else {
        out[key] = value;
      }
    }
    return after === undefined && Object.keys(out).length === 0 ? undefined : out;
  }
  return after === undefined ? undefined : structuredClone(after);
}

/** A tree's ids, types and slots in order, nothing of their configuration: what a structural step changes. */
function treeShape(node: ComponentNode): string {
  const slots = Object.keys(node.children ?? {})
    .sort()
    .filter((slotId) => (node.children?.[slotId]?.length ?? 0) > 0)
    .map((slotId) => `${slotId}[${(node.children?.[slotId] ?? []).map(treeShape).join(",")}]`);
  return `${node.id}:${node.type}(${slots.join(";")})`;
}

/**
 * The Submit button File > New seeds (and Try it's "Add a Submit button" adds), as it was
 * placed: nothing about it changed since. An add that names no position goes before it when
 * it closes its slot (see {@link BuilderController.add}).
 */
function isSeededSubmit(node: ComponentNode): boolean {
  const { id, type, configuration, children, ...rest } = node;
  return (
    id === "submit" &&
    type === "button" &&
    canonicalJson(configuration) === canonicalJson({ label: "Submit", action: "submit" }) &&
    Object.values(children ?? {}).every((group) => group.length === 0) &&
    Object.values(rest).every((value) => value === undefined)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path segment that indexes a list: `0` in `chrome.header.0.text`. */
function listIndexOf(container: unknown, segment: string): number | undefined {
  return Array.isArray(container) && /^\d+$/.test(segment) ? Number(segment) : undefined;
}

/**
 * Writes `value` at `path`, creating objects on the way. A numeric segment steps into an
 * existing list (the header and footer parts are written at `chrome.header.0.text`); a list is never
 * created from a path, so a segment that finds no list still makes an object.
 */
/** Sets one rule of a rules object, or removes it when `value` is `undefined` ({@link BuilderController.setProperties}'s `target: "rules"`). */
function writeRule(rules: Record<string, unknown>, key: string, value: unknown): void {
  if (isPrototypeName(key)) {
    throw new Error(`Invalid rule name "${key}": it is a reserved name.`);
  }
  if (value === undefined) {
    delete rules[key];
  } else {
    rules[key] = value;
  }
}

/**
 * Properties whose empty choice means "not set" rather than an empty value: the form root's
 * Frame picker's first choice, which leaves the frame to the host. Drafting "" for
 * one removes its key (see {@link removeNestedValue}) rather than writing "".
 */
const UNSET_WHEN_EMPTY: ReadonlySet<string> = new Set(["chrome.frame", "agentTools"]);

/**
 * Properties whose default is a named choice, not a blank, each with how its default is read off
 * the component's configuration: drafting the default removes the key, so a definition only ever
 * carries the choice an author made. What a hidden answer does (`hiddenValueBehavior`) leaves it
 * out of the submission unless the component says otherwise (`defaultHiddenValueBehaviorFor`).
 */
const UNSET_WHEN_DEFAULT: Readonly<Record<string, (configuration: unknown) => unknown>> = { hiddenValueBehavior: defaultHiddenValueBehaviorFor };

/**
 * Removes the key at `path`, then every object on the way that it leaves with nothing in it
 * (no keys, or only `undefined` ones), so a cleared setting leaves no empty block behind: Not
 * set on the Frame of a form with no header or footer takes `chrome` with it.
 */
function removeNestedValue(target: Record<string, unknown>, path: string): void {
  assertSafePropertyPath(path);
  const parts = path.split(".").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === undefined) {
    return;
  }
  const chain: Array<Record<string, unknown>> = [target];
  for (const part of parts.slice(0, -1)) {
    const next = chain[chain.length - 1]![part];
    if (!isPlainObject(next)) {
      return;
    }
    chain.push(next);
  }
  delete chain[chain.length - 1]![last];
  for (let depth = chain.length - 1; depth > 0; depth -= 1) {
    if (Object.values(chain[depth]!).some((entry) => entry !== undefined)) {
      return;
    }
    delete chain[depth - 1]![parts[depth - 1]!];
  }
}

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  assertSafePropertyPath(path);
  const parts = path.split(".").filter(Boolean);
  const last = parts.pop();
  if (last === undefined) {
    return;
  }
  let cursor: Record<string, unknown> | unknown[] = target;
  for (const part of parts) {
    const index = listIndexOf(cursor, part);
    const current = index !== undefined ? (cursor as unknown[])[index] : (cursor as Record<string, unknown>)[part];
    if (!isPlainObject(current) && !Array.isArray(current)) {
      if (index !== undefined) {
        (cursor as unknown[])[index] = {};
      } else {
        (cursor as Record<string, unknown>)[part] = {};
      }
    }
    cursor = (index !== undefined ? (cursor as unknown[])[index] : (cursor as Record<string, unknown>)[part]) as
      | Record<string, unknown>
      | unknown[];
  }
  const index = listIndexOf(cursor, last);
  if (index !== undefined) {
    (cursor as unknown[])[index] = value;
  } else {
    (cursor as Record<string, unknown>)[last] = value;
  }
}

function getNestedValue(target: unknown, path: string): unknown {
  let cursor: unknown = target;
  for (const part of path.split(".").filter(Boolean)) {
    const index = listIndexOf(cursor, part);
    if (index !== undefined) {
      cursor = (cursor as unknown[])[index];
      continue;
    }
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    // Own keys only: `constructor` and `__proto__` are inherited, not part of the configuration.
    cursor = Object.hasOwn(cursor, part) ? cursor[part] : undefined;
  }
  return cursor;
}

/** A rename as {@link BuilderChangeEvent.renamed} carries it, with the rules that followed and the formulas that could not. */
export interface BuilderRename {
  from: string;
  to: string;
  /**
   * The ids of the components whose rules were rewritten to read the new id (the renamed one among
   * them when its own rules read it), or, inside a grid's row, the row key the rename moved.
   */
  rules?: string[];
  /** Formulas that spell the old id but do not parse, left as written: the Logic diagnostics show them (see {@link BuilderController.renameNotes}). */
  unparsed?: BuilderRenameNote[];
  /**
   * Where the renamed component's data went when that is more than its id changing (`applicant.email` to
   * `applicant.mail`, `items[].sku` to `items[].code`), for a reference that reads answers by path (a PDF
   * template source) to follow by the move, not by the id. Absent when the data path is the id itself, which
   * `from` and `to` already say, and when the data stayed where it was (a component with a data key of its own).
   */
  dataPath?: ValuePathMove;
}

/** A rename an Undo or a Redo moved: the component now answers to `to` again ({@link BuilderChangeEvent.renameStepped}). */
export interface BuilderRenameStepped {
  from: string;
  to: string;
  by: "undo" | "redo";
}

/** One formula a rename could not follow: a rule of `componentId` the parser rejects while it spells the old id. */
export interface BuilderRenameNote {
  componentId: string;
  /** The rule's key: `visibleWhen`, `value` and the rest. */
  rule: string;
  from: string;
  to: string;
  /** The formula as it stands, unchanged. */
  formula: string;
}

/**
 * The net change to the form's languages since a baseline — the form as loaded, or as the host
 * last saved it: what a host keeping per-locale data of its own (a translation
 * catalog) must do to it when it saves the form. A rename chain is one move from the baseline
 * code to the code the form has now; an Undo takes its part back; a language removed and
 * brought back is no change at all.
 */
export interface LocaleChanges {
  /** Baseline codes the form no longer has under any code: drop everything held under them. */
  removed: string[];
  /**
   * Baseline codes the form now has under another code: move what is held under `from` to `to`.
   * Apply the removals first, then the moves as one simultaneous mapping (two codes may swap); a
   * moved entry replaces whatever the host held under `to`. A code both removed and a rename's
   * target means its old wording is dropped and the moved wording takes its place.
   */
  renamed: Array<{ from: string; to: string }>;
}

export interface BuilderChangeEvent {
  root: ComponentNode;
  selectedComponentId: string | undefined;
  reason: BuilderChangeReason;
  /**
   * Present only on the change that re-seated a component under a new id ({@link
   * BuilderController.renameId}, a Save of a drafted id among them). The tree's own rules that
   * read the old id are rewritten with it ({@link BuilderRename.rules}); whoever keeps
   * references of its own (a journey's pages and conditions; a PDF layout's
   * condition) follows them from here.
   */
  renamed?: BuilderRename;
  /**
   * Present only on the change an Undo or a Redo of a rename's history entry made: the component
   * is back under `to` (its id before the rename, after an Undo). The entry held the rename and
   * what followed it in the form's own documents (its rules, translations and scenarios, a PDF
   * layout's conditions and sources), which the step has already put back; whoever keeps
   * references of its own outside the form's history (a journey's pages) follows from here.
   */
  renameStepped?: BuilderRenameStepped;
  /**
   * Present on every change an Undo or a Redo made. A follow-up whose rewrite is a part of the
   * step's entry (a mode's, the scenarios') is already taken back or made again with it and
   * must not run again; only one that was dropped while the step was undone
   * ({@link BuilderController.followRename} answered false) runs on the Redo.
   */
  historyStep?: "undo" | "redo";
  /**
   * Present only on the change of an edit that moved where answers are stored (a data key, a
   * container's key or `scopeData`): each data-holding component's value path before
   * and after, `[]` for a collection's entries. The rules inside a grid row that read a moved row
   * key (`row.<key>`) are rewritten with it, in the same step of the history; whoever reads answers
   * by value path (the scenarios, a PDF layout's sources) follows from here, all moves as one map
   * (a path moves once, so two keys swapped stay swapped), and joins the step with
   * {@link BuilderController.followRename} given the first move. On the change of a rename saved
   * with a new data key, beside {@link renamed}: the moves the new id alone does not explain, each
   * from where the answer was before the Save. On the change an Undo of such a step made (with
   * {@link historyStep}), each move the other way round, as {@link renameStepped} names a rename's
   * ids; on the change a Redo of it made, the same moves again.
   */
  dataMoved?: ValuePathMove[];
  /**
   * Present only on the change that moved translations to a new id (translations are addressed by
   * id): a host keeping a catalog under the same addresses renames its entries with it. Every
   * kind of id is announced with its kind: a component id (`components`), a header or footer part
   * (`chrome`), a journey (`journeys`), a PDF layout (`pdf`), and the keys inside an owner (an
   * option's value, a journey page's id, a layout node's id) with their `owner` and `within`
   * ({@link RenamedTextId}).
   */
  renamedIds?: RenamedTextId[];
  /**
   * Present on an `edit` made under a control still being typed into (a formula box, see
   * {@link BuilderController.setDraftRules}'s `live`): the draft changed, but the author has not
   * left the box. A surface that mirrors the draft refreshes what it shows in place; the canvas
   * and anything else that rebuilds from the tree wait for the plain `edit` that follows when
   * the author leaves the box or saves.
   */
  live?: true;
}

interface BuilderControllerEventMap {
  change: BuilderChangeEvent;
  selection: { selectedComponentId: string | undefined };
  mutation: BuilderMutationEvent;
  /** How the selection is drawn moved (its adapter, or what the surface answers for its type): see {@link BuilderController.drawingChanged}. */
  drawing: Record<string, never>;
}

type Listener<T> = (event: T) => void;

function defaultRoot(): ComponentNode {
  return { id: "root", type: "form", configuration: { label: "Form" }, children: { content: [] } };
}

/** The words for a write that would nest the form past {@link NESTING_MAX}. */
/**
 * How many of the latest renames and moves of data a late follow-up may name. A follow-up lands
 * a moment after its step (a chunk's load), so a few dozen steps back is far more than enough.
 */
const RECENT_STEPS_KEPT = 32;

const FORM_TOO_DEEP = `The form would nest more than ${NESTING_MAX} levels deep (rules, settings and components together).`;

/** Throws, in words, for a form nested past {@link NESTING_MAX}: one the builder cannot open. */
function assertOpenable(root: ComponentNode | undefined): void {
  if (nestsPast(root)) {
    throw new Error(`The form nests more than ${NESTING_MAX} levels deep (rules, settings and components together), so it cannot be opened.`);
  }
}

/**
 * A definition entering the controller, copied. A data grid with no collection binding is given
 * one at its id, so everything the builder walks after this finds a grid's rows where the
 * runtime keeps them (`normalizeDataGrids`); a tree with no grid comes back untouched.
 */
function normalizeRoot(root: ComponentNode | undefined): ComponentNode {
  // Refused before the copy, whose recursion a tree nested thousands of levels would exhaust
  // (a rule tree, or components in components); the validator refuses the same form.
  assertOpenable(root);
  return structuredClone(normalizeDataGrids(root ?? defaultRoot()));
}

/**
 * A node that follows its id when the id changes: the collection path that equals the old id
 * becomes the new one, so a repeating section or data grid whose path was seeded from its id
 * keeps reading "path else id" after a rename (for a node without a path nothing
 * changes). A path that names another place is the author's own and stays.
 */
function followCollectionPath(node: ComponentNode, from: string, to: string): void {
  if (node.collection?.collectionPath === from) {
    node.collection.collectionPath = to;
  }
}

/**
 * The page id `after` (a configuration) gives its node that a map cannot key, when `before` did
 * not already have it. A journey page's texts are translated under its page id
 * (`translations.journeys.<journey>.pages.<page>`), and a map cannot hold a name every object has, so no write gives a page one; a page that already has one keeps it until renamed.
 */
function newReservedPageId(before: unknown, after: unknown): string | undefined {
  const next = isPlainObject(after) ? after.pageId : undefined;
  if (typeof next !== "string" || !isPrototypeName(next.trim())) {
    return undefined;
  }
  const previous = isPlainObject(before) ? before.pageId : undefined;
  return previous === next ? undefined : next.trim();
}

/** The sentence the definition's structure check gives the same page id. */
function reservedPageIdMessage(pageId: string): string {
  return kernelStructureMessage("journey.page.id.reserved", undefined, pageId);
}

/**
 * A component re-seated from `from` to `to` in place, as a command of the history: its
 * collection path follows when it was the old id ({@link followCollectionPath}), and a repeating
 * section that lists it among its row fields lists the new id. Undo puts each back as it was.
 */
function renameNodeCommand(tree: ComponentTree, from: string, to: string): BuilderCommand {
  let pathFollowed = false;
  let holders: string[] = [];
  const holdersOf = (id: string): ComponentNode[] => {
    const root = tree.find(tree.rootId());
    return [...(root ? [root] : []), ...tree.descendantsOf(tree.rootId())].filter((node) => node.collection?.itemFields?.includes(id));
  };
  return {
    id: "RENAME_NODE",
    execute: () => {
      const node = tree.find(from);
      if (!node) {
        throw new Error(`Component not found: ${from}`);
      }
      node.id = to;
      pathFollowed = node.collection?.collectionPath === from;
      followCollectionPath(node, from, to);
      holders = [];
      for (const holder of holdersOf(from)) {
        holder.collection!.itemFields = holder.collection!.itemFields!.map((id) => (id === from ? to : id));
        holders.push(holder.id);
      }
    },
    undo: () => {
      for (const id of holders) {
        const holder = tree.find(id);
        if (holder?.collection?.itemFields) {
          holder.collection.itemFields = holder.collection.itemFields.map((field) => (field === to ? from : field));
        }
      }
      const node = tree.find(to);
      if (!node) {
        throw new Error(`Component not found: ${to}`);
      }
      node.id = from;
      if (pathFollowed && node.collection) {
        node.collection.collectionPath = from;
      }
    }
  };
}

/** Each data-holding component's value path (`buildDataPaths`), by id: what a move of data is measured on. */
function dataPlacesOf(tree: ComponentTree): Map<string, string> {
  const paths = buildDataPaths(tree.getRoot());
  const places = new Map<string, string>();
  for (const node of tree.descendantsOf(tree.rootId())) {
    const path = paths.get(node.id);
    if (path !== undefined && holdsData(node)) {
      places.set(node.id, path);
    }
  }
  return places;
}

/**
 * A note under the maximum when a field's limits contradict each other (`minLength` above
 * `maxLength`, a number's or a date's `min` above its `max`), as the definition's check reads
 * them and in its sentence: the run ignores such a pair, so it is a warning, never a problem
 * that holds a Save back.
 */
function invertedLimitNotes(node: ComponentNode): BuilderNote[] {
  if (!isPlainObject(node.configuration)) {
    return [];
  }
  const configuration = node.configuration;
  const code = "component.limits.inverted";
  const message = kernelStructureMessage(code, undefined);
  const notes: BuilderNote[] = [];
  if (kernelStructureLimitsInverted(node.type, { minLength: configuration.minLength, maxLength: configuration.maxLength })) {
    notes.push({ target: "maxLength", message, severity: "warning", code });
  }
  if (kernelStructureLimitsInverted(node.type, { min: configuration.min, max: configuration.max })) {
    notes.push({ target: "max", message, severity: "warning", code });
  }
  return notes;
}

/** Whether a configuration change may move where answers are stored. */
function movesData(before: unknown, after: unknown): boolean {
  const read = (value: unknown, key: string): unknown => (isPlainObject(value) ? value[key] : undefined);
  return ["dataKey", "scopeData"].some((key) => !sameData(read(before, key) ?? null, read(after, key) ?? null));
}

/** A row bound as the grid reads one: a finite number, else nothing. */
function rowBoundOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The distinct types of `definitions`, in their order (a type registered at two versions once). */
function typesOf(definitions: readonly ComponentDefinition[]): string[] {
  return [...new Set(definitions.map((definition) => definition.type))];
}

/**
 * Where the text a component's editor declares at `propertyPath` is translated: the module's own
 * addresses first (`print.note` and a tab's caption are among them), else — for any other
 * nested property of a component it does not name — the property's path under the component's id,
 * which is where the renderer resolves it. Never for the form root, whose texts are the module's
 * to name.
 */
function addressOfText(node: ComponentNode, propertyPath: string, formRoot: boolean): TextAddress | undefined {
  const known = addressOfPropertyPath(node, propertyPath, formRoot);
  if (known !== undefined || formRoot) {
    return known;
  }
  const segments = propertyPath.split(".");
  const [head] = segments;
  if (segments.length < 2 || head === "options" || head === "messages" || head === "chrome" || head === "tabs" || !isSafeSegment(node.id) || !segments.every(isSafeSegment)) {
    return undefined;
  }
  return { kind: "components", owner: node.id, path: segments };
}

/** The texts every field has when its editor declares none of its own (the inspector's defaults), and the form root's. */
const FIELD_TEXT_FIELDS: PropertyEditorField[] = [
  { id: "label", type: "localized-text", propertyPath: "label", label: "Label" },
  { id: "description", type: "localized-text", propertyPath: "description", label: "Description" }
];
const ROOT_TEXT_FIELDS: PropertyEditorField[] = [
  { id: "title", type: "localized-text", propertyPath: "title", label: "Form title" },
  { id: "description", type: "localized-text", propertyPath: "description", label: "Description" }
];

const DEFAULT_TYPES: BuilderComponentType[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "checkbox", label: "Checkbox" }
];

/** Datum's own binding, when the builder holds no object for it: the classes `createDatumBinding()` declares by default. */
const DATUM_OWN_CLASSES: Pick<LiveBinding, "cssClasses"> = { cssClasses: PANEL_LOOK_CLASSES };

/**
 * Framework-neutral state + operations shared by the builder panels
 * (`<datum-builder-toolbar>`, `<datum-builder-canvas>`, `<datum-builder-properties>`).
 * A host can create one controller and hand it to any subset of panels, or lay them out
 * however it likes. The wrapper `<datum-builder>` element also uses this internally.
 */
export class BuilderController {
  private editor: TreeEditor = new TreeEditor(defaultRoot());
  private resolver: ParentConstraintsResolver | undefined;
  private componentRegistry: ComponentRegistry | undefined;
  /** The registered definitions' types in registration order: the registry resolves a type but cannot list them ({@link typeInfo}). */
  private registeredTypes: readonly string[] = [];
  private mutationOff: (() => void) | undefined;

  private types: BuilderComponentType[] = DEFAULT_TYPES;
  private selectedId: string | undefined;
  private counter = 1;
  private locale = "en";
  /** Committed `FormDefinition.localization` — what the Languages workspace's actions and {@link setLocalization} have written. */
  private localizationValue: LocalizationConfiguration | undefined;
  /**
   * Committed `FormDefinition.tests`: the form's scenarios, one source block each. Held
   * beside the localization, not in the tree: Save has nothing to write for it, an edit is its own
   * history step, and the Tests panel reads and writes it through {@link tests} and {@link setTests}.
   */
  private testsValue: FormTestConfiguration | undefined;
  /**
   * Committed `FormDefinition.translations`: every text of the form in a language other
   * than its default. Held beside the localization, not in the tree, and written only through the
   * commands that go by way of {@link rewriteTranslations}, so each rule is one undo step with the
   * edit that caused it.
   */
  private translationsValue: FormTranslations | undefined;
  /** The component renames {@link renameId} just made, carried on the change event ({@link BuilderChangeEvent.renamedIds}). */
  private renamedIdsToAnnounce: RenamedTextId[] | undefined;
  /** How deep {@link joinSteps} runs are nested, and the entry the steps recorded in them join. */
  private joinDepth = 0;
  private joinedStep: BuilderCommand | undefined;
  /** Committed {@link FormIdentity} — the same way; `undefined` when the host handed over none. */
  private identityValue: FormIdentity | undefined;
  /** The builder's own colour scheme, as the shell reports it ({@link setPreviewScheme}). */
  private previewSchemeValue: "light" | "dark" = "light";
  private bindingOptions: BuilderBindingOption[] = [];
  /** What {@link offeredTypes} last answered, and what it was made from. */
  private offeredMemo: { types: BuilderComponentType[]; active: string; list: BuilderComponentType[] } | undefined;
  /** The picker's choice; `undefined` until the author picks (the host's {@link hostBinding} draws). */
  private bindingIdValue: string | undefined;
  /** The host's binding (`binding`). */
  private hostBinding: LiveBinding | string | undefined;
  private assetsValue: LiveAssets | undefined;
  private canvasComponentsValue: Readonly<Record<string, AdapterEntry>> | undefined;
  /** The canvas's account of how the form is drawn, for the inspector ({@link setDrawingSource}). */
  private drawingSource: BuilderDrawingSource | undefined;
  private previewDataSources: DataSourceResolver | undefined;
  private previewDataSourceSet: DataSourceSet | undefined;
  /** Lists the author tries the form with in place of a data source's (the Settings panel): the session's, never the definition's. */
  private simulatedSources = new Map<string, DataSourceResult["items"]>();
  /** What Submit does in Try it (the Settings panel): the session's, never the definition's. */
  private trySubmissionValue: TrySubmissionSettings = normalizeTrySubmission(undefined);
  /** The host values Try it previews with (see {@link tryHostContext}). */
  private tryHostContextValue: Record<string, unknown> | undefined;
  /** The set {@link dataSources} hands out, kept while neither layer changes: the canvas reloads its options when the set changes. */
  private layeredSources: { host: DataSourceSet | undefined; set: DataSourceSet } | undefined;
  /** The host chrome the canvas previews the form under (the View panel). */
  private previewChromeValue: FormChromeConfiguration | undefined;
  private hostDataSourceIds: string[] = [];
  /** Codes the host named for the messages editor, beyond the engine's own. */
  private hostValidationCodes: HostValidationCode[] = [];
  /** Uncommitted properties-panel edits, keyed by the component they belong to. */
  private drafts = new Map<string, ComponentDraft>();
  /**
   * An action held back by the selection's unsaved edits until the author answers the
   * prompt (see {@link requestSelect}); `run` performs it once the draft is dealt with.
   */
  private heldAction: { prompt: UnsavedChangesPrompt; run: HeldRun } | undefined;
  /** Unsaved edits outside the tree that leaving is held for too (see {@link LeaveGuard}). */
  private leaveGuard: LeaveGuard | undefined;
  /**
   * Guards stacked over {@link leaveGuard} with {@link pushLeaveGuard}, newest last. The slot is
   * the surfaces' (Logic, Languages, a designer's mapping) and they set and clear it whole; an
   * editor that can be open beside them (the Tests panel) stacks instead, so neither
   * throws the other's edits away.
   */
  private stackedLeaveGuards: LeaveGuard[] = [];
  /** The languages as of the baseline (a load, or the host's last Save): what {@link localeChangesSinceSave} measures from. */
  private localeBaseline: string[] = [];
  /** Each language the form has now that descends from a baseline one, by the baseline code it started as. */
  private localeLineage = new Map<string, string>();
  /** The rename {@link renameId} just made, carried on its change event (see {@link BuilderChangeEvent.renamed}). */
  private renamedToAnnounce: BuilderRename | undefined;
  /** The rename an Undo or a Redo just moved, carried on its change event (see {@link BuilderChangeEvent.renameStepped}). */
  private renameSteppedToAnnounce: BuilderRenameStepped | undefined;
  /** The last rename's history entry while it is still the last thing done ({@link followRename}). */
  private openRename: RenameStep | undefined;
  /** The latest renames and moves of data, newest last, so a late follow-up of one an Undo took back is known as such ({@link followRename}). */
  private recentSteps: RenameStep[] = [];
  /** The rename or move of data a Redo just made again: open to follow-ups once the Redo is through. */
  private redoneStep: RenameStep | undefined;
  /** Which way the history just stepped, carried on its change event (see {@link BuilderChangeEvent.historyStep}). */
  private historyStepToAnnounce: "undo" | "redo" | undefined;
  /** Where the data the last edit moved went, carried on its change event (see {@link BuilderChangeEvent.dataMoved}). */
  private dataMovedToAnnounce: ValuePathMove[] | undefined;
  /** What the last load of the translations map left out ({@link translationsDropped}). */
  private translationsDroppedValue: DroppedTranslations = { count: 0, first: [] };
  /** The formulas the last rename left as written (see {@link renameNotes}); replaced by the next rename that re-seats a component. */
  private renameNotesValue: readonly BuilderRenameNote[] = [];
  /** {@link BuilderControllerOptions.nodeLabel}. */
  private nodeLabeler: NestedTreeNodeLabeler | undefined;
  /** {@link BuilderControllerOptions.idRow}. */
  private idRowResolver: BuilderControllerOptions["idRow"];
  /** {@link BuilderControllerOptions.problems}. */
  private problemsHook: BuilderControllerOptions["problems"];
  /** {@link BuilderControllerOptions.fieldChoices}. */
  private fieldChoicesHook: BuilderControllerOptions["fieldChoices"];
  /** The host's translation catalog, when the builder was lent one: frame labels resolve through it as the form does. */
  private translationCatalogValue: TranslationCatalog | (() => TranslationCatalog | undefined) | undefined;
  /** {@link BuilderControllerOptions.notes}. */
  private notesHook: BuilderControllerOptions["notes"];
  /** {@link BuilderControllerOptions.normalizeCommit}. */
  private normalizeCommitHook: BuilderControllerOptions["normalizeCommit"];
  /** {@link BuilderControllerOptions.foldedSections}. */
  private foldedSectionsHook: BuilderControllerOptions["foldedSections"];
  /** {@link BuilderControllerOptions.fieldPlaceholder}. */
  private fieldPlaceholderHook: BuilderControllerOptions["fieldPlaceholder"];
  /** {@link BuilderControllerOptions.inspectorFields}. */
  private inspectorFieldsHook: BuilderControllerOptions["inspectorFields"];
  /** {@link BuilderControllerOptions.reservedIds}. */
  private reservedIdsHook: BuilderControllerOptions["reservedIds"];
  /** {@link BuilderControllerOptions.renameFollowsRules}; absent: true. */
  private renameFollowsRulesOption: boolean | undefined;
  /** {@link BuilderControllerOptions.ruleTargets}. */
  private ruleTargetsOption: readonly string[] = [];
  /** {@link BuilderControllerOptions.claimedIds}. */
  private claimedIdsHook: BuilderControllerOptions["claimedIds"];
  /** {@link BuilderControllerOptions.idPrefix}. */
  private idPrefixHook: BuilderControllerOptions["idPrefix"];
  /** {@link BuilderControllerOptions.canvasRoot}. */
  private canvasRootHook: BuilderControllerOptions["canvasRoot"];
  /** {@link BuilderControllerOptions.canvasView}. */
  private canvasViewHook: BuilderControllerOptions["canvasView"];
  /** {@link BuilderControllerOptions.canvasJourneyView}. */
  private canvasJourneyViewHook: BuilderControllerOptions["canvasJourneyView"];
  /** {@link BuilderControllerOptions.canvasTags}. */
  private canvasTagsHook: BuilderControllerOptions["canvasTags"];
  /** {@link BuilderControllerOptions.canvasRegionOwner}. */
  private canvasRegionOwnerHook: BuilderControllerOptions["canvasRegionOwner"];
  /** {@link BuilderControllerOptions.canvasSelectTarget}. */
  private canvasSelectTargetHook: BuilderControllerOptions["canvasSelectTarget"];
  /** {@link BuilderControllerOptions.canvasStepper}. */
  private canvasStepperHook: BuilderControllerOptions["canvasStepper"];
  /** {@link BuilderControllerOptions.canvasScheme}. */
  private canvasSchemeHook: BuilderControllerOptions["canvasScheme"];
  /** Bumped when what the canvas draws the tree as is swapped; see {@link canvasRevision}. */
  private canvasRevisionValue = 0;
  /** {@link BuilderControllerOptions.otherSlots}, read by {@link resolver} each time. */
  private otherSlotsHook: BuilderControllerOptions["otherSlots"];
  private showHidden = true;
  private previewWidthValue: number | undefined;
  /** The modes' blocks that carry default texts outside the tree (see {@link setOutsideDocuments}). */
  private outsideDocuments: (() => readonly OutsideDocument[]) | undefined;
  /** {@link BuilderControllerOptions.sheetWidth}: the tree's say over the sheet, when a host gives it one. */
  private sheetWidthResolver: ((root: ComponentNode) => number | undefined) | undefined;
  /** {@link BuilderControllerOptions.previewWidths}. */
  private previewWidthsValue = true;

  /**
   * Last slot-constraint rejection message, if any — or what an Undo or Redo could not do.
   * Cleared by the next successful op.
   */
  public dropError: string | undefined;
  /** While Undo or Redo steps: listeners are {@link emit}'s `guarded`. */
  private stepping = false;
  /**
   * Last id-rename validation message, if any — the selection's, as the fields below are too.
   * A panel asks {@link problemsOf} for the component it shows instead.
   */
  public idError: string | undefined;
  /**
   * Why the selection's `cssClass` value is unusable: a malformed token the renderer would
   * silently drop (see `css-classes.ts`). Follows the selection the way {@link idError}
   * does, and blocks {@link commitDraft} the same way.
   */
  public cssClassError: string | undefined;
  /**
   * Why the selection's data key cannot be saved: a key that is not usable, or one
   * that puts its answer where another component's already is. Checked only for a key the
   * draft changes, so an edit to anything else is never held up by the form as it was.
   * Follows the selection the way {@link idError} does, and blocks {@link commitDraft} the same way.
   */
  public dataKeyError: string | undefined;
  /** Per type: whether its inspector offers a Data key; see {@link offersDataKey}. */
  private readonly dataKeyOffers = new Map<string, boolean>();
  /** Bumped by every change, so what is derived from the drafts can be kept until the next one. */
  private revision = 0;
  /** {@link problemsOf} per component, as of {@link revision}. */
  private problemCache: { revision: number; byId: Map<string, BuilderProblem[]>; twins?: Map<string, number> } = { revision: -1, byId: new Map() };
  /**
   * Advisory note that the selection's `cssClass` names classes the chosen binding does not
   * declare. Shown, never blocking: the class may mean nothing under this binding, but another
   * binding — or the host page — may give it meaning, so Save proceeds.
   */
  public cssClassWarning: string | undefined;
  /** The class vocabulary of the chosen binding ({@link cssClassNames}), keyed by the binding it came from. */
  private classNamesCache: { binding: LiveBinding | undefined; classes: string[] } | undefined;
  /** The drawing the component definitions bring ({@link componentDrawing}), keyed by the registry it was read from. */
  private drawingCache: { registry: ComponentRegistry | undefined; drawing: ComponentDrawing | undefined } | undefined;

  private readonly listeners: {
    [K in keyof BuilderControllerEventMap]: Set<Listener<BuilderControllerEventMap[K]>>;
  } = { change: new Set(), selection: new Set(), mutation: new Set(), drawing: new Set() };

  constructor(options: BuilderControllerOptions = {}) {
    this.setOptions(options, { silent: true });
  }

  // --- events ----------------------------------------------------------------

  public on<K extends keyof BuilderControllerEventMap>(
    type: K,
    listener: Listener<BuilderControllerEventMap[K]>
  ): () => void {
    this.listeners[type].add(listener);
    return () => this.listeners[type].delete(listener);
  }

  /**
   * `guarded` while Undo or Redo steps (see {@link stepThroughHistory}): a listener that throws
   * then never makes the bar's Undo or Redo throw, nor keeps the others from hearing; its error
   * is reported as a DOM event listener's is (`reportError`, else the console).
   */
  private emit<K extends keyof BuilderControllerEventMap>(
    type: K,
    event: BuilderControllerEventMap[K],
    guarded = this.stepping
  ): void {
    for (const listener of this.listeners[type]) {
      try {
        listener(event);
      } catch (error) {
        if (!guarded) {
          throw error;
        }
        ((globalThis as { reportError?: (error: unknown) => void }).reportError ?? console.error)(error);
      }
    }
  }

  /**
   * A step of the history made, undone or redone. A follow-up a rename takes into its own entry
   * is no step, nor is a part a {@link joinSteps} entry takes in after its first (nor a write
   * with no entry made while that entry tops the history): none is announced, so a count of the
   * steps stays the history's. The joined entry's first part is announced as it is made, since
   * it is the entry. Any step ends the window in which a late follow-up may join the last
   * rename.
   */
  private mutated(mutation: BuilderMutationEvent): void {
    if (this.openRename?.isJoining()) {
      return;
    }
    if (mutation.action === "execute" && this.joinDepth > 0 && this.joinedStep !== undefined && this.editor.undoMark() === this.joinedStep) {
      return;
    }
    // A rename (or a move of data) sets its entry open again right after its own run.
    this.openRename = undefined;
    this.emit("mutation", mutation);
  }

  private emitChange(reason: BuilderChangeReason, meta: { live?: boolean } = {}): void {
    this.revision += 1;
    const renamed = this.renamedToAnnounce;
    this.renamedToAnnounce = undefined;
    const renamedIds = this.renamedIdsToAnnounce;
    this.renamedIdsToAnnounce = undefined;
    const renameStepped = this.renameSteppedToAnnounce;
    this.renameSteppedToAnnounce = undefined;
    const dataMoved = this.dataMovedToAnnounce;
    this.dataMovedToAnnounce = undefined;
    const historyStep = this.historyStepToAnnounce;
    this.historyStepToAnnounce = undefined;
    this.emit("change", {
      root: this.editor.snapshot(),
      selectedComponentId: this.selectedId,
      reason,
      ...(meta.live ? { live: true as const } : {}),
      ...(renamed ? { renamed } : {}),
      ...(renameStepped ? { renameStepped } : {}),
      ...(historyStep ? { historyStep } : {}),
      ...(dataMoved ? { dataMoved } : {}),
      ...(renamedIds ? { renamedIds } : {})
    });
  }

  // --- configuration -------------------------------------------------------

  public setOptions(options: BuilderControllerOptions, meta: { silent?: boolean } = {}): void {
    // A file the builder cannot open is refused before any of it is taken: its identity,
    // languages or translations laid over the form still showing would mix two files at Save.
    if (options.initialRoot) {
      assertOpenable(options.initialRoot);
    }
    // A silent rebuild announces nothing, but what was derived from the old tree is stale all the same.
    this.revision += 1;
    if (options.componentTypes) {
      this.types = options.componentTypes;
    }

    // The picker lists the bindings offered and the canvas may draw one: a list that differs from
    // the one before (a binding registered after the first paint) repaints both.
    const offeredChanged =
      options.availableBindings !== undefined &&
      (options.availableBindings.length !== this.bindingOptions.length ||
        options.availableBindings.some(
          (option, index) => option.id !== this.bindingOptions[index]?.id || option.binding !== this.bindingOptions[index]?.binding || option.assets !== this.bindingOptions[index]?.assets
        ));
    if (options.availableBindings) {
      this.bindingOptions = options.availableBindings;
      // A pick the host no longer offers is no pick.
      if (this.bindingIdValue !== undefined && !this.bindingOptions.some((option) => option.id === this.bindingIdValue)) {
        this.bindingIdValue = undefined;
      }
      this.refreshCssClassChecks();
    }

    let localizationChanged = false;
    if ("localization" in options) {
      const next = normalizeLocalizationConfiguration(options.localization);
      if (JSON.stringify(next ?? null) !== JSON.stringify(this.localizationValue ?? null)) {
        const before = supportedLocaleCodes(this.localizationValue);
        this.localizationValue = next;
        localizationChanged = true;
        // A host handing the form its languages is loading it: the baseline is what it handed.
        this.markLocalesSaved();
        if (options.locale === undefined) {
          this.leaveLocaleIfGone(before);
        }
      }
    }
    if ("translations" in options) {
      // Read against the languages the form declares (applied above): a key spelled another way
      // is filed under the declared spelling, once, as part of the load.
      const next = this.loadTranslations(options.translations);
      if (!sameData(next, this.translationsValue)) {
        // A host handing the form its translations is loading it, like its languages: no history.
        this.translationsValue = next;
        localizationChanged = true;
      }
    }
    if ("identity" in options) {
      const next = normalizeFormIdentity(options.identity);
      if (JSON.stringify(next ?? null) !== JSON.stringify(this.identityValue ?? null)) {
        this.identityValue = next;
        // Reported as a localization-style change below: definition-level state the host
        // reconciles its own copy from.
        localizationChanged = true;
      }
    }

    // Preview wiring: assigning either re-renders the canvas even when the tree is untouched,
    // since both change what the preview looks like.
    let previewChanged = offeredChanged;
    if ("binding" in options && options.binding !== this.hostBinding) {
      this.hostBinding = options.binding;
      // The host setting the binding itself (its own control, a restored session) moves the
      // picker with it: its choice is what draws.
      this.bindingIdValue = undefined;
      // The binding is the cssClass vocabulary, so swapping it can invalidate (or forgive)
      // whatever class names the selection carries.
      this.refreshCssClassChecks();
      previewChanged = true;
    }
    if ("assets" in options && options.assets !== this.assetsValue) {
      this.assetsValue = options.assets;
      previewChanged = true;
    }
    if ("canvasComponents" in options && options.canvasComponents !== this.canvasComponentsValue) {
      this.canvasComponentsValue = options.canvasComponents;
      previewChanged = true;
    }
    if ("dataSourceResolver" in options && options.dataSourceResolver !== this.previewDataSources) {
      this.previewDataSources = options.dataSourceResolver;
      previewChanged = true;
    }
    if ("dataSources" in options && options.dataSources !== this.previewDataSourceSet) {
      this.previewDataSourceSet = options.dataSources;
      previewChanged = true;
    }
    if ("previewWidths" in options && (options.previewWidths !== false) !== this.previewWidthsValue) {
      this.previewWidthsValue = options.previewWidths !== false;
      previewChanged = true;
    }
    if ("sheetWidth" in options && options.sheetWidth !== this.sheetWidthResolver) {
      this.sheetWidthResolver = options.sheetWidth;
      previewChanged = true;
    }
    if (options.dataSourceIds && options.dataSourceIds.join("\n") !== this.hostDataSourceIds.join("\n")) {
      this.hostDataSourceIds = [...options.dataSourceIds];
      // The picker's choices come from here; a repaint is what shows the new list.
      previewChanged = true;
    }
    if (
      options.validationCodes &&
      JSON.stringify(options.validationCodes) !== JSON.stringify(this.hostValidationCodes)
    ) {
      this.hostValidationCodes = [...options.validationCodes];
      previewChanged = true;
    }
    // A mode's hooks: each changes what the panels draw, never the tree.
    if ("nodeLabel" in options && options.nodeLabel !== this.nodeLabeler) {
      this.nodeLabeler = options.nodeLabel;
      previewChanged = true;
    }
    if ("idRow" in options && options.idRow !== this.idRowResolver) {
      this.idRowResolver = options.idRow;
      previewChanged = true;
    }
    if ("problems" in options && options.problems !== this.problemsHook) {
      this.problemsHook = options.problems;
      previewChanged = true;
    }
    if ("fieldChoices" in options && options.fieldChoices !== this.fieldChoicesHook) {
      this.fieldChoicesHook = options.fieldChoices;
      previewChanged = true;
    }
    if ("notes" in options && options.notes !== this.notesHook) {
      this.notesHook = options.notes;
      previewChanged = true;
    }
    if ("normalizeCommit" in options) {
      this.normalizeCommitHook = options.normalizeCommit;
    }
    if ("foldedSections" in options && options.foldedSections !== this.foldedSectionsHook) {
      this.foldedSectionsHook = options.foldedSections;
      previewChanged = true;
    }
    if ("fieldPlaceholder" in options && options.fieldPlaceholder !== this.fieldPlaceholderHook) {
      this.fieldPlaceholderHook = options.fieldPlaceholder;
      previewChanged = true;
    }
    if ("inspectorFields" in options && options.inspectorFields !== this.inspectorFieldsHook) {
      this.inspectorFieldsHook = options.inspectorFields;
      previewChanged = true;
    }
    // Only what a new id is made from: nothing to repaint.
    if ("reservedIds" in options) {
      this.reservedIdsHook = options.reservedIds;
    }
    if ("renameFollowsRules" in options) {
      this.renameFollowsRulesOption = options.renameFollowsRules;
    }
    if ("ruleTargets" in options) {
      this.ruleTargetsOption = options.ruleTargets ?? [];
    }
    if ("claimedIds" in options) {
      this.claimedIdsHook = options.claimedIds;
    }
    if ("idPrefix" in options) {
      this.idPrefixHook = options.idPrefix;
    }
    if ("otherSlots" in options) {
      this.otherSlotsHook = options.otherSlots;
    }
    // What the canvas draws the tree as: a swap of any of the three is a sheet of another kind,
    // drawn once, whole (the canvas takes its renderer off the runtime for it; see canvasRevision).
    if ("canvasRoot" in options && options.canvasRoot !== this.canvasRootHook) {
      this.canvasRootHook = options.canvasRoot;
      this.canvasRevisionValue += 1;
      previewChanged = true;
    }
    if ("canvasView" in options && options.canvasView !== this.canvasViewHook) {
      this.canvasViewHook = options.canvasView;
      this.canvasRevisionValue += 1;
      previewChanged = true;
    }
    if ("canvasJourneyView" in options && options.canvasJourneyView !== this.canvasJourneyViewHook) {
      this.canvasJourneyViewHook = options.canvasJourneyView;
      this.canvasRevisionValue += 1;
      previewChanged = true;
    }
    // How the canvas decorates what it draws: drawn again, on the same mount (no revision).
    if ("canvasTags" in options && options.canvasTags !== this.canvasTagsHook) {
      this.canvasTagsHook = options.canvasTags;
      previewChanged = true;
    }
    if ("canvasRegionOwner" in options && options.canvasRegionOwner !== this.canvasRegionOwnerHook) {
      this.canvasRegionOwnerHook = options.canvasRegionOwner;
      previewChanged = true;
    }
    if ("canvasSelectTarget" in options && options.canvasSelectTarget !== this.canvasSelectTargetHook) {
      this.canvasSelectTargetHook = options.canvasSelectTarget;
      previewChanged = true;
    }
    if ("canvasStepper" in options && options.canvasStepper !== this.canvasStepperHook) {
      this.canvasStepperHook = options.canvasStepper;
      previewChanged = true;
    }
    if ("canvasScheme" in options && options.canvasScheme !== this.canvasSchemeHook) {
      this.canvasSchemeHook = options.canvasScheme;
      previewChanged = true;
    }

    const localeChanged = options.locale !== undefined && options.locale !== this.locale;
    if (localeChanged) {
      this.locale = options.locale as string;
    }

    const rootRebuilt = Boolean(options.initialRoot || options.componentDefinitions);
    if (options.initialRoot) {
      this.markLocalesSaved();
    }
    if (options.componentDefinitions) {
      this.dataKeyOffers.clear();
    }
    if (rootRebuilt) {
      const root = normalizeRoot(options.initialRoot ?? this.editor.snapshot());
      this.mutationOff?.();
      if (options.componentDefinitions && options.componentDefinitions.length > 0) {
        const registry = this.registryOf(options.componentDefinitions);
        const editor = new RegistryBackedTreeEditor(root, registry);
        this.editor = editor;
        this.useRegistry(editor, registry, typesOf(options.componentDefinitions));
      } else if (options.componentDefinitions === undefined && this.componentRegistry) {
        // Another form alone keeps the definitions, as every option left out keeps its value;
        // only an empty list takes them away.
        const editor = new RegistryBackedTreeEditor(root, this.componentRegistry);
        this.editor = editor;
        this.useRegistry(editor, this.componentRegistry, this.registeredTypes);
      } else {
        this.editor = new TreeEditor(root);
        this.resolver = undefined;
        this.componentRegistry = undefined;
        this.registeredTypes = [];
      }
      this.selectedId = undefined;
      this.counter = 1;
      this.drafts.clear();
      this.heldAction = undefined;
      // What the last form refused or flagged belongs to that form, not this one.
      this.dropError = undefined;
      this.idError = undefined;
      this.cssClassError = undefined;
      this.cssClassWarning = undefined;
      this.dataKeyError = undefined;
      this.renameNotesValue = [];
      this.openRename = undefined;
      this.recentSteps = [];
      this.mutationOff = this.editor.events().subscribe((mutation) => this.mutated(mutation));

      if (!meta.silent) {
        this.emitChange("init");
      }
    } else if ((localeChanged || previewChanged || localizationChanged) && !meta.silent) {
      // A locale-only change re-resolves LocalizedText labels (canvas, inspector) and a
      // preview-only change restyles or repopulates the canvas — neither touches the tree.
      // Panels only repaint on "change" / "selection", so emit one here. A pure preview
      // change says so via its reason, so a host doesn't mistake it for an edit; a locale
      // or localization change stays "edit" because hosts reconcile their own state from it.
      this.emitChange(localeChanged || localizationChanged ? "edit" : "preview");
    }
  }

  private registryOf(definitions: readonly ComponentDefinition[]): ComponentRegistry {
    const registry = new ComponentRegistry();
    for (const definition of definitions) {
      registry.register(definition);
    }
    return registry;
  }

  /** `registry`, which `editor` now reads, and its constraints, the slots the other-slots hook adds laid over them. */
  private useRegistry(editor: RegistryBackedTreeEditor, registry: ComponentRegistry, types: readonly string[]): void {
    const declared = editor.constraintsResolver();
    this.resolver = (type) => {
      const otherSlots = this.otherSlotsHook?.(type);
      return otherSlots ? { ...declared(type), otherSlots } : declared(type);
    };
    this.componentRegistry = registry;
    this.registeredTypes = types;
  }

  /**
   * Swaps the component definitions under the tree as it stands — a PDF template layout's
   * pickers following the form's components — without the rebuild {@link setOptions} makes of
   * `componentDefinitions`: the tree, its undo history, open drafts and the selection all stay.
   * A controller with no registry yet (or none left) takes the full rebuild instead.
   */
  public setComponentDefinitions(definitions: readonly ComponentDefinition[], componentTypes?: BuilderControllerOptions["componentTypes"]): void {
    const editor = this.editor;
    if (!(editor instanceof RegistryBackedTreeEditor) || definitions.length === 0) {
      this.setOptions({ componentDefinitions: [...definitions], ...(componentTypes ? { componentTypes: [...componentTypes] } : {}) });
      return;
    }
    this.revision += 1;
    if (componentTypes) {
      this.types = [...componentTypes];
    }
    const registry = this.registryOf(definitions);
    editor.useRegistry(registry);
    this.useRegistry(editor, registry, typesOf(definitions));
    this.dataKeyOffers.clear();
    // The panels redraw with the new choices; the tree did not move, so this is no edit.
    this.emitChange("preview");
  }

  // --- reads -------------------------------------------------------------

  public componentTypes(): BuilderComponentType[] {
    return this.types;
  }

  /**
   * The types the palette and the add command offer now: every type, less those that belong to a
   * design-system binding (`binding`) other than the one drawing the canvas. The same list
   * (`componentTypes()` itself) when no type names a binding.
   */
  public offeredTypes(): BuilderComponentType[] {
    if (!this.types.some((entry) => entry.binding !== undefined || entry.hidden === true)) {
      return this.types;
    }
    const chosen = this.chosenBinding();
    const active = chosen === undefined ? "datum" : typeof chosen === "string" ? chosen : chosen.id;
    // The same list while neither the types nor the binding moved: a panel tells a new list by identity.
    const memo = this.offeredMemo;
    if (memo && memo.types === this.types && memo.active === active) {
      return memo.list;
    }
    const list = this.types.filter((entry) => entry.hidden !== true && (entry.binding === undefined || entry.binding === active));
    this.offeredMemo = { types: this.types, active, list };
    return list;
  }

  /** Locale used to resolve `LocalizedText` in the canvas tree view and inspector model. */
  public currentLocale(): string {
    return this.locale;
  }

  /**
   * Whether the canvas paints components a rule is currently hiding: an X-ray of every component
   * the form *has*, the way to reach a field gated behind a `visibleWhen` without first
   * satisfying the rule. On by default (an author edits what the form has, and Try it
   * shows what a person sees); the View panel turns it off.
   */
  public showHiddenComponents(): boolean {
    return this.showHidden;
  }

  public setShowHiddenComponents(value: boolean): void {
    if (this.showHidden === value) {
      return;
    }
    this.showHidden = value;
    this.emitChange("edit");
  }

  /**
   * Width the canvas constrains the previewed form to, in CSS pixels — `undefined` for the
   * canvas's full width. A form is authored on a wide screen and filled in on whatever the
   * filler has, so being able to see it at 414px without leaving the builder is the difference
   * between finding a layout problem now and hearing about it later.
   */
  /**
   * Repaints the canvas over the same tree: for a host whose previews changed behind the
   * component definitions (the PDF designer's field previews, rebuilt over other sample
   * answers) without anything in the tree changing.
   */
  public repaintPreview(): void {
    this.emitChange("preview");
  }

  public previewWidth(): number | undefined {
    return this.previewWidthValue;
  }

  public setPreviewWidth(value: number | undefined): void {
    const next = value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
    if (next === this.previewWidthValue) {
      return;
    }
    this.previewWidthValue = next;
    this.emitChange("edit");
  }

  /** Whether the author may pick the sheet's width ({@link BuilderControllerOptions.previewWidths}). */
  public previewWidths(): boolean {
    return this.previewWidthsValue;
  }

  /**
   * The width the tree fixes the sheet at, in CSS pixels, when the host gave the controller a
   * {@link BuilderControllerOptions.sheetWidth}; `undefined` otherwise, and the sheet is the
   * author's ({@link previewWidth}). Read over the tree the canvas previews — `root` lets the
   * canvas pass the snapshot it already took rather than clone the tree twice per repaint.
   */
  public sheetWidth(root: ComponentNode = this.previewSnapshot()): number | undefined {
    const resolve = this.sheetWidthResolver;
    if (!resolve) {
      return undefined;
    }
    const width = resolve(root);
    return width !== undefined && Number.isFinite(width) && width > 0 ? width : undefined;
  }

  /**
   * Locale options the canvas renders its switcher from: the form's own `supportedLocales`
   * as committed (the Languages workspace's actions and {@link setLocalization} write them
   * straight to it), each under its authored label — the same list, from the same helper,
   * the rendered form's switcher offers. Empty when the form declares no localization, and
   * the switcher hides.
   */
  public localeOptions(): BuilderLocaleOption[] {
    return supportedLocaleOptions(this.localizationValue);
  }

  /**
   * The committed `FormDefinition.localization` for the form being edited — what Save has
   * written, and what a host should persist on the definition beside {@link snapshot}.
   * `undefined` means the form declares no localization configuration (single-language).
   */
  public localization(): LocalizationConfiguration | undefined {
    return this.localizationValue ? structuredClone(this.localizationValue) : undefined;
  }

  /**
   * The committed `FormDefinition.tests` for the form being edited: what a host should
   * persist on the definition beside {@link snapshot} and {@link localization}. `undefined` means
   * the form has no scenarios.
   */
  public tests(): FormTestConfiguration | undefined {
    return this.testsValue ? structuredClone(this.testsValue) : undefined;
  }

  /** The translations written in `codes` that a removal takes away: the entries of those languages in the map. */
  public localeTranslationCount(codes: readonly string[]): number {
    return codes.reduce((sum, code) => sum + listTranslations(this.translationsValue, code).length, 0);
  }

  /**
   * Lends the controller the modes' blocks of the definition that carry default texts outside
   * the tree (a journey catalog, a PDF layout catalog). Their translations are in the one map
   * like the tree's; what the blocks still own is the default strings. The controller reads
   * them to know every text's default (a translation's `source`, Make default's list) and
   * writes new defaults back in the same history entry as the tree and the map (Make default,
   * a layout language rename), so one Undo takes all of it back. `undefined` clears it: the
   * tree alone is then what the controller knows.
   */
  public setOutsideDocuments(provider: (() => readonly OutsideDocument[]) | undefined): void {
    this.outsideDocuments = provider;
  }

  /**
   * One history command rewriting the outside documents `rewrite` changes, or `undefined` when
   * it changes none. Its first run writes the rewritten block; an Undo or Redo carries just that
   * change onto the block as it stands then ({@link carryChange}), so what the author did to a
   * journey or a layout in its own tab since is not thrown away with it.
   */
  private outsideCommand(rewrite: (document: OutsideDocument, value: unknown) => unknown): BuilderCommand | undefined {
    const changes: Array<{ document: OutsideDocument; before: unknown; after: unknown }> = [];
    for (const document of this.outsideDocuments?.() ?? []) {
      const before = document.read();
      const after = rewrite(document, before);
      if (after !== before && !sameData(after, before)) {
        changes.push({ document, before, after });
      }
    }
    if (changes.length === 0) {
      return undefined;
    }
    let first = true;
    return {
      id: "OUTSIDE_TEXTS",
      execute: () => {
        for (const { document, before, after } of changes) {
          document.write(first ? after : carryChange(document.read(), before, after));
        }
        first = false;
      },
      undo: () => {
        for (const { document, before, after } of [...changes].reverse()) {
          document.write(carryChange(document.read(), after, before));
        }
      }
    };
  }

  /**
   * The localization as a history command: Undo and Redo put the languages (and the default)
   * back with the texts that went with them. `renamed` moves the canvas's language along.
   * The first run writes `after`; an Undo or Redo carries just this entry's change onto the
   * localization as it stands then ({@link carryLocalization}), so a language added since —
   * which is no step of the history — is not lost with it.
   */
  private localizationCommand(
    before: LocalizationConfiguration | undefined,
    after: LocalizationConfiguration | undefined,
    renamed?: { from: string; to: string }
  ): BuilderCommand {
    const put = (value: LocalizationConfiguration | undefined, move?: { from: string; to: string }): void => {
      const codes = supportedLocaleCodes(this.localizationValue);
      this.localizationValue = value ? structuredClone(value) : undefined;
      if (move && this.locale === move.from) {
        this.locale = move.to;
      }
      this.followLocales(move);
      this.leaveLocaleIfGone(codes);
    };
    let first = true;
    return {
      id: "LOCALIZATION",
      execute: () => {
        put(first ? after : normalizeLocalizationConfiguration(carryLocalization(this.localizationValue, before, after)), renamed);
        first = false;
      },
      undo: () => put(normalizeLocalizationConfiguration(carryLocalization(this.localizationValue, after, before)), renamed && { from: renamed.to, to: renamed.from })
    };
  }

  /**
   * The `tests` block as a history command: Undo and Redo swap the whole block, so the panel's
   * Apply, Accept new behaviour and a rename's rewrite are each one step.
   * The block is replaced rather than carried (as {@link localizationCommand} carries): nothing
   * else edits it between a step and its undo, because every writer goes through {@link setTests}.
   */
  private testsCommand(before: FormTestConfiguration | undefined, after: FormTestConfiguration | undefined): BuilderCommand {
    const put = (value: FormTestConfiguration | undefined): void => {
      this.testsValue = value ? structuredClone(value) : undefined;
    };
    return {
      id: "TESTS",
      execute: () => put(after),
      undo: () => put(before)
    };
  }

  /**
   * Brings the lineage of the languages in step with the committed localization, after it moved
   * (`move`: by a rename of `move.from` to `move.to`): a rename carries the baseline origin along,
   * a language gone loses it, and a baseline language that has come back (an Undo of its removal)
   * takes its own origin again unless a rename already holds it.
   */
  private followLocales(move?: { from: string; to: string }): void {
    const codes = supportedLocaleCodes(this.localizationValue);
    if (move) {
      const origin = this.localeLineage.get(move.from);
      this.localeLineage.delete(move.from);
      if (origin !== undefined && codes.includes(move.to)) {
        this.localeLineage.set(move.to, origin);
      }
    }
    for (const code of [...this.localeLineage.keys()]) {
      if (!codes.includes(code)) {
        this.localeLineage.delete(code);
      }
    }
    const owned = new Set(this.localeLineage.values());
    for (const code of codes) {
      if (!this.localeLineage.has(code) && this.localeBaseline.includes(code) && !owned.has(code)) {
        this.localeLineage.set(code, code);
        owned.add(code);
      }
    }
  }

  /**
   * The net change to the form's languages since the baseline: the form as loaded, or as the host
   * last saved it ({@link markLocalesSaved}). A host keeping per-locale data of its own (a
   * translation catalog) applies it when it saves the form, so an Undo before that loses
   * nothing. Empty (both lists) when the languages are as they were.
   */
  public localeChangesSinceSave(): LocaleChanges {
    const renamed: Array<{ from: string; to: string }> = [];
    for (const [code, origin] of this.localeLineage) {
      if (code !== origin) {
        renamed.push({ from: origin, to: code });
      }
    }
    const kept = new Set(this.localeLineage.values());
    return { removed: this.localeBaseline.filter((code) => !kept.has(code)), renamed };
  }

  /** The languages as they stand are the baseline now: the host has saved the form, or has just loaded it. */
  public markLocalesSaved(): void {
    this.localeBaseline = supportedLocaleCodes(this.localizationValue);
    this.localeLineage = new Map(this.localeBaseline.map((code) => [code, code]));
  }

  /**
   * {@link markLocalesSaved} for a save still pending: the languages as they stand, which the save
   * was handed, are the baseline from now, so a language renamed or removed before the save
   * settles is the next save's to report. Returns what to call should the save fail: the baseline
   * goes back where it was, with what moved meanwhile counted on top of it. A baseline set again in
   * between (a load, a host's own {@link markLocalesSaved}) is left as it is.
   */
  public markLocalesSaving(): () => void {
    const baseline = this.localeBaseline;
    const lineage = this.localeLineage;
    this.markLocalesSaved();
    const handed = this.localeBaseline;
    return () => {
      if (this.localeBaseline !== handed) {
        return;
      }
      // Each language now descends from one the save was handed, which descends from one of the old baseline.
      const since = this.localeLineage;
      this.localeBaseline = baseline;
      this.localeLineage = new Map();
      for (const [code, origin] of since) {
        const first = lineage.get(origin);
        if (first !== undefined) {
          this.localeLineage.set(code, first);
        }
      }
      this.followLocales();
    };
  }

  // --- translations ----------------------------------------------------------

  /**
   * The committed `FormDefinition.translations` of the form being edited — what a host persists
   * on the definition beside {@link snapshot} and {@link localization}. The committed object
   * itself, not a copy: every writer goes through the history, which swaps in a new object,
   * so a caller treats it as frozen and never mutates it. `undefined` when the form has none.
   */
  public translations(): FormTranslations | undefined {
    return this.translationsValue;
  }

  /**
   * What the last load of the map (the `translations` option, {@link replaceTranslations}) left
   * out: how many values and the addresses of the first few (locale, kind, owner, then property
   * segments; `[]` is the map itself). A key that differs from a declared language only in case
   * or `_` against `-` is not left out: it is filed under the declared spelling. For a host to
   * say what a file it opened lost; the form loads, and a Save writes what was kept.
   */
  public translationsDropped(): DroppedTranslations {
    return this.translationsDroppedValue;
  }

  /** `value` through the tolerant reader against the declared languages, its report kept. */
  private loadTranslations(value: unknown): FormTranslations | undefined {
    const { translations, dropped } = readFormTranslationsReport(value, supportedLocaleCodes(this.localizationValue));
    this.translationsDroppedValue = dropped;
    return translations;
  }

  /**
   * Replaces the whole map (read through the tolerant reader, against the declared languages, see
   * {@link translationsDropped}). A host loading or mirroring it
   * passes `silent`: stored, announced to no one, no history (a mode's own controller keeps such
   * a mirror of the form's map). Without `silent` it is an edit of the form like any other: one
   * undo step, announced as one `change`.
   */
  public replaceTranslations(value: FormTranslations | undefined, meta: { silent?: boolean } = {}): void {
    const next = this.loadTranslations(value);
    if (sameData(next, this.translationsValue)) {
      return;
    }
    if (meta.silent) {
      this.translationsValue = next;
      return;
    }
    const command = this.translationsCommand(this.translationsValue, next);
    if (command) {
      this.editor.execute(command);
      this.emitChange("edit");
    }
  }

  /**
   * The map as a history command: Undo and Redo put the entries back with the edit that moved
   * them, or alone. The first run writes `after`; an Undo or Redo carries just this entry's change
   * onto the map as it stands then ({@link carryChange}), so a translation typed since is not
   * lost with it.
   * `undefined` when `after` is the map as it was.
   */
  private translationsCommand(before: FormTranslations | undefined, after: FormTranslations | undefined): BuilderCommand | undefined {
    if (sameData(before ?? {}, after ?? {})) {
      return undefined;
    }
    const record = { before: structuredClone(before ?? {}), after: structuredClone(after ?? {}) };
    const put = (value: FormTranslations): void => {
      this.translationsValue = Object.keys(value).length > 0 ? structuredClone(value) : undefined;
    };
    const carry = (from: FormTranslations, to: FormTranslations): FormTranslations =>
      (carryChange(this.translationsValue ?? {}, from, to) ?? {}) as FormTranslations;
    let first = true;
    return {
      id: "TRANSLATIONS",
      execute: () => {
        put(first ? record.after : carry(record.before, record.after));
        first = false;
      },
      undo: () => put(carry(record.after, record.before))
    };
  }

  /**
   * One undo step that runs `update` over the map (pure functions of `translations.ts`: a prune,
   * a move, a copy, a write). For a mode whose own rule touches its texts (a journey page deleted,
   * a layout removed) when the step is not one of the controller's own. `false` and no step when
   * `update` changes nothing.
   *
   * `alongside` is a command (or several) the mode's own change of the definition made: it is
   * composed with the map's command into one history entry, so "journey removed + its entries
   * pruned" is one Undo that brings both back. The mode has already applied its change when it
   * calls, so an `alongside` command's first `execute()` must leave things as they are (the
   * entry's first run is the call itself); its `undo()` and later `execute()` do the work. It is
   * recorded only when the map changes: a mode whose change is a step of the form's history
   * either way (a journey or layout removed) records it alone through {@link recordStep} on
   * `false`. `renamed` lists the ids the update re-keyed, for the change event's `renamedIds`
   * ({@link BuilderChangeEvent.renamedIds}).
   */
  public rewriteTranslations(
    update: (map: FormTranslations) => FormTranslations,
    alongside?: BuilderCommand | readonly BuilderCommand[],
    renamed?: readonly RenamedTextId[]
  ): boolean {
    const before = this.translationsValue ?? {};
    const command = this.translationsCommand(before, update(before));
    if (!command) {
      return false;
    }
    const extra: readonly BuilderCommand[] = alongside === undefined ? [] : Array.isArray(alongside) ? alongside : [alongside as BuilderCommand];
    this.executeJoining(extra.length === 0 ? command : new CompositeCommand(command.id, [command, ...extra]));
    this.announceRenames(renamed);
    this.emitChange("edit");
    return true;
  }

  /**
   * A change a mode has already made to a block of the definition it owns (a PDF layout's
   * condition and sources following a rename), recorded as a step of the form's history so Undo
   * and Redo take it with the form. `command`'s first `execute()` must leave things as they are,
   * as `alongside`'s does in {@link rewriteTranslations}. Made while a rename is heard (or
   * {@link followRename} runs), it joins the rename's own entry instead of making one. A step
   * of its own is a change of the form's, announced once as `rewriteTranslations`' is ("edit"),
   * so the bar's Undo and a host following the changes see it; one the rename takes is the
   * rename's change.
   */
  public recordStep(command: BuilderCommand): void {
    const top = this.undoMark();
    this.executeJoining(command);
    if (this.undoMark() !== top) {
      this.emitChange("edit");
    }
  }

  /**
   * Runs `run` as one action of a mode's (a catalog action, with whatever a host's handler of its
   * change does meanwhile): the first step {@link recordStep} or {@link rewriteTranslations}
   * records while it runs is an entry that takes in every later step as one of its parts, a
   * plain edit of the form's included, so the action is one Undo however many writes it took. A
   * step made before that first one (a host's edit while the mode reports its change, ahead of
   * the action's own rewrite) is an entry of its own, under the action's. A part taken in is no
   * step: it publishes no mutation ({@link mutated}), and one {@link recordStep} records says no
   * change of its own either, the entry's first change event having told the form's change.
   */
  public joinSteps(run: () => void): void {
    this.joinDepth += 1;
    try {
      run();
    } finally {
      this.joinDepth -= 1;
      if (this.joinDepth === 0) {
        this.joinedStep = undefined;
      }
    }
  }

  /** Executes `command` as {@link joinSteps} joins it, or as an entry of its own outside a join. */
  private executeJoining(command: BuilderCommand): void {
    if (this.joinDepth === 0) {
      this.editor.execute(command);
      return;
    }
    const parts = [command];
    const step: BuilderCommand = Object.assign(new CompositeCommand(command.id, parts), {
      absorb: (next: BuilderCommand) => this.joinDepth > 0 && this.joinedStep === step && parts.push(next) > 0
    });
    this.editor.execute(step);
    if (this.editor.undoMark() === step) {
      this.joinedStep = step;
    }
  }

  /** Adds the ids a step re-keyed to what the next change event carries ({@link BuilderChangeEvent.renamedIds}). */
  private announceRenames(renamed: readonly RenamedTextId[] | undefined): void {
    if (renamed && renamed.length > 0) {
      this.renamedIdsToAnnounce = [...(this.renamedIdsToAnnounce ?? []), ...renamed];
    }
  }

  /**
   * Writes the translations typed in the Languages workspace, an import or an agent as **one**
   * undo step. Each edit names its language, the text's address and the wording;
   * an empty `text` deletes the entry. The entry's `source` is the fingerprint of the text's
   * current default, so it is current when written, unless the edit carries a `source` of its
   * own (an import row whose file was made against other wording): then the entry is written
   * with exactly that fingerprint (`writeTranslationEntry`) and so comes in flagged stale
   * when it is not the current default's. An edit is passed over when the
   * address names no text of the form (the tree's, the journeys' or the layouts'), when the
   * language is not one the form declares, or when it is the default language (the default is
   * the string itself, edited as a property). Returns how many entries were written or deleted.
   *
   * `addLocales` declares languages first, in the same history entry (an import that brings new
   * languages is one Undo, not one per language and one for the entries): the edits are checked
   * against the languages as they stand after the additions. A code the form already has, or a
   * malformed one, is passed over like in {@link localizationActions}`.addLocale`. The entry is
   * made when a language was added even if no entry was written.
   */
  public setTranslations(
    edits: ReadonlyArray<{ locale: string; address: TextAddress; text: string; source?: string }>,
    options: { addLocales?: ReadonlyArray<{ code: string; label?: string; sourceLocale?: string }> } = {}
  ): number {
    const added = options.addLocales ?? [];
    if (edits.length === 0 && added.length === 0) {
      return 0;
    }
    const localizationBefore = this.localizationValue;
    let localization = localizationBefore;
    for (const locale of added) {
      const grown = this.localizationWithAdded(localization, locale.code, locale.label ?? "", locale.sourceLocale);
      if (grown !== undefined) {
        localization = grown;
      }
    }
    localization = normalizeLocalizationConfiguration(localization);
    const defaults = this.defaultsByAddress();
    const declared = new Set(supportedLocaleCodes(localization));
    const defaultLocale = effectiveDefaultLocale(localization);
    const before = this.translationsValue ?? {};
    const accepted: TranslationEdit[] = [];
    for (const edit of edits) {
      const known = defaults.get(addressKey(edit.address));
      // An engine word's source is its English, not the default language's string, so the
      // default language takes a translation of it like any other.
      if (known === undefined || (edit.locale === defaultLocale && !isEngineTextAddress(edit.address)) || !declared.has(edit.locale)) {
        continue;
      }
      accepted.push({
        locale: edit.locale,
        address: edit.address,
        text: edit.text,
        defaultText: known,
        ...(edit.source !== undefined ? { source: edit.source } : {})
      });
    }
    // One pass over the map: an import brings thousands of edits, and a copy of the locale per
    // edit would go quadratic.
    const { translations: next, changed } = writeTranslations(before, accepted);
    const languagesChanged = localization !== localizationBefore && !sameData(localization, localizationBefore);
    if (!languagesChanged) {
      return changed === 0 || !this.rewriteTranslations(() => next) ? 0 : changed;
    }
    // The languages lead, so a host hearing a mode's change mid-step reads a definition that
    // already declares them; the entries follow in the same entry.
    const commands: BuilderCommand[] = [this.localizationCommand(localizationBefore, localization)];
    const map = this.translationsCommand(before, next);
    if (map) {
      commands.push(map);
    }
    this.editor.execute(commands.length === 1 ? commands[0]! : new CompositeCommand("SET_TRANSLATIONS", commands));
    this.emitChange("edit");
    return changed;
  }

  /**
   * Confirms stale translations against the text's current default without changing what they
   * say ("this still reads right"), as **one** undo step. Returns how many entries
   * were confirmed; an address with no entry, or an entry already current, is passed over.
   */
  public reconcileTranslations(items: ReadonlyArray<{ locale: string; address: TextAddress }>): number {
    if (items.length === 0) {
      return 0;
    }
    const defaults = this.defaultsByAddress();
    let next = this.translationsValue ?? {};
    let confirmed = 0;
    for (const item of items) {
      const known = defaults.get(addressKey(item.address));
      const entry = known === undefined ? undefined : readTranslation(next, item.locale, item.address);
      if (known === undefined || !entry || !isStale(entry, known)) {
        continue;
      }
      next = reconcileTranslation(next, item.locale, item.address, known);
      confirmed += 1;
    }
    if (confirmed === 0 || !this.rewriteTranslations(() => next)) {
      return 0;
    }
    return confirmed;
  }

  /**
   * The default of every text the form words — the tree's and the outside documents' — and of
   * the engine's own words (their English), by {@link addressKey}.
   */
  private defaultsByAddress(): Map<string, string> {
    const defaults = new Map(this.allTexts().map((text) => [addressKey(text.address), text.default]));
    for (const text of [...engineTexts(), ...enginePluralAddresses()]) {
      defaults.set(addressKey(text.address), text.default);
    }
    return defaults;
  }

  /**
   * Every text of the form with its default: the tree's ({@link translatableTexts}) and the
   * journeys' and layouts' (`OutsideDocument.texts`). The list Make default swaps and a
   * translation's `source` is read against.
   */
  private allTexts(): Array<{ address: TextAddress; default: string; tree?: TranslatableText }> {
    const texts: Array<{ address: TextAddress; default: string; tree?: TranslatableText }> = this.translatableTexts().map((text) => ({ address: text.address, default: text.default, tree: text }));
    const seen = new Set(texts.map((text) => addressKey(text.address)));
    for (const document of this.outsideDocuments?.() ?? []) {
      for (const text of document.texts()) {
        if (!seen.has(addressKey(text.address))) {
          seen.add(addressKey(text.address));
          texts.push({ address: text.address, default: text.default });
        }
      }
    }
    return texts;
  }

  // --- the languages (one undo step each) ----------------------------------

  /**
   * The language list's actions: each changes `localization` and the map together as **one**
   * undoable step, so a language and its translations cannot drift apart. They return `false`
   * and change nothing for a code the form does not have (or already has), a blank or malformed
   * code, or — for the two that rewrite the form's texts, rename and make-default — while the
   * form's own settings have changes not applied.
   */
  public readonly localizationActions: LocalizationActions = {
    addLocale: (code, label, options) => this.addLocale(code, label ?? "", options?.sourceLocale),
    removeLocale: (code) => this.removeLocale(code),
    renameLocale: (from, to) => this.renameLocale(from, to),
    makeDefaultLocale: (code) => this.makeDefaultLocale(code),
    relabelLocale: (code, label) => this.relabelLocale(code, label)
  };

  /**
   * Adds a language (one undo step). A form that declares none is given `sourceLocale` first
   * when it names one other than `code`: the language its strings are written in, which stays
   * the default.
   */
  private addLocale(code: string, label: string, sourceLocale?: string): boolean {
    const next = this.localizationWithAdded(this.localizationValue, code, label, sourceLocale);
    if (next === undefined) {
      return false;
    }
    this.setLocalization(next);
    return true;
  }

  /**
   * `current` with the language added (and `sourceLocale` first, for a form that declares none),
   * or `undefined` when the code is malformed or taken. Shared by {@link addLocale} and the
   * additions {@link setTranslations} makes in its one step.
   */
  private localizationWithAdded(current: LocalizationConfiguration | undefined, code: string, label: string, sourceLocale?: string): LocalizationConfiguration | undefined {
    if (languageCodeProblem(code, current) !== undefined) {
      return undefined;
    }
    let base = current;
    const source = sourceLocale?.trim();
    if (supportedLocaleEntries(current).length === 0 && source && source.toLowerCase() !== code.trim().toLowerCase()) {
      if (languageCodeProblem(source, undefined) !== undefined) {
        return undefined;
      }
      base = withLanguageAdded(undefined, source, "");
    }
    return withLanguageAdded(base, code, label);
  }

  /** Names a language (one undo step); `false` for a code the form does not have or a label it already has. */
  private relabelLocale(code: string, label: string): boolean {
    const current = this.localizationValue;
    const next = normalizeLocalizationConfiguration(withLanguageLabel(current, code, label));
    if (!supportedLocaleEntries(current).some((entry) => entry.code === code) || sameData(next, current)) {
      return false;
    }
    this.setLocalization(next);
    return true;
  }

  /**
   * Removes a language and its translations (one undo step). The default language can go when
   * another is left: that one is made the default first, so its wording becomes the strings
   * (Make default), and the old default's wording goes with the language.
   */
  private removeLocale(code: string): boolean {
    const current = this.localizationValue;
    const entries = supportedLocaleEntries(current);
    if (!entries.some((entry) => entry.code === code)) {
      return false;
    }
    const successor = defaultAfterRemoval(current, code);
    if (successor !== undefined && this.hasPendingChanges(this.rootId())) {
      return false;
    }
    const swap = successor !== undefined ? this.defaultSwapPlan(code, successor) : undefined;
    const after = normalizeLocalizationConfiguration(withLanguageRemoved(successor !== undefined ? withDefaultLanguage(current, successor) : current, code));
    const translations = removeLocaleTranslations(swap?.translations ?? this.translationsValue, code);
    return this.runLanguageStep("REMOVE_LOCALE", current, after, translations, swap);
  }

  /**
   * Makes `code` the language the strings are written in (one undo step): every text that has a
   * wording in `code` takes it as its string and keeps the old string as the translation in the
   * old default (`makeDefaultLocale` in `translations.ts`); a text with no wording in `code`
   * keeps its string. The configuration, the journeys' and layouts' strings and the map change
   * together.
   */
  private makeDefaultLocale(requested: string): boolean {
    const current = this.localizationValue;
    const from = effectiveDefaultLocale(current);
    // Codes are read as the form reads them (case-insensitive, `_` as `-`); the language is
    // written as the list declares it.
    const declared = supportedLocaleEntries(current).find((entry) => normalizeLocaleTag(entry.code) === normalizeLocaleTag(requested));
    if (declared === undefined || normalizeLocaleTag(declared.code) === normalizeLocaleTag(from) || this.hasPendingChanges(this.rootId())) {
      return false;
    }
    const code = declared.code;
    // The strings are in `from` whether or not the list declares it (an unwritten default is "en"):
    // they move to the new default's wording and stay as `from`'s translations, as for a declared one.
    const swap = this.defaultSwapPlan(from, code);
    return this.runLanguageStep("MAKE_DEFAULT_LOCALE", current, normalizeLocalizationConfiguration(withDefaultLanguage(current, code)), swap?.translations ?? this.translationsValue, swap);
  }

  /**
   * What making `to` the default does to the form's texts: the map after
   * `makeDefaultLocale` over every text, and the commands that write the new default strings
   * into the tree's configurations and the outside documents. `drafts` are the configuration
   * edits an open draft of the same component needs so its later Save does not write the old
   * string straight back.
   */
  private defaultSwapPlan(from: string, to: string): DefaultSwapPlan {
    const texts = this.allTexts();
    const swapped = swapDefaultTranslations(this.translationsValue, texts.map((text) => ({ address: text.address, default: text.default })), from, to);
    const byComponent = new Map<string, Array<{ propertyPath: string; value: string }>>();
    const outside: OutsideDefaultEdit[] = [];
    texts.forEach((text, index) => {
      const next = swapped.defaults[index]!.default;
      if (next === text.default) {
        return;
      }
      if (text.tree) {
        const list = byComponent.get(text.tree.componentId) ?? [];
        list.push({ propertyPath: text.tree.propertyPath, value: next });
        byComponent.set(text.tree.componentId, list);
      } else {
        outside.push({ address: text.address, default: next });
      }
    });
    const tree = this.editor.componentTree();
    const commands: BuilderCommand[] = [];
    for (const [componentId, edits] of byComponent) {
      const node = tree.find(componentId);
      if (!node) {
        continue;
      }
      const configuration = structuredClone(isPlainObject(node.configuration) ? node.configuration : {});
      for (const edit of edits) {
        writeTextInConfiguration(configuration, edit.propertyPath, edit.value);
      }
      commands.push(new EditComponentCommand(tree, componentId, configuration, node.rules));
    }
    if (outside.length > 0) {
      const command = this.outsideCommand((document, value) => document.setDefaults(value, outside));
      if (command) {
        commands.push(command);
      }
    }
    return { translations: swapped.translations, commands, drafts: [...byComponent].map(([componentId, edits]) => ({ componentId, edits })) };
  }

  /**
   * Runs one language-list change as a single history entry: the languages lead (so a host
   * hearing a mode's change mid-step reads a definition that already declares them), then the
   * map, then whatever rewrites the strings. A change that moves nothing but the list is the
   * list's own entry.
   */
  private runLanguageStep(
    id: string,
    before: LocalizationConfiguration | undefined,
    after: LocalizationConfiguration | undefined,
    translations: FormTranslations | undefined,
    swap?: DefaultSwapPlan,
    renamed?: { from: string; to: string },
    extra: readonly BuilderCommand[] = []
  ): boolean {
    const commands: BuilderCommand[] = [this.localizationCommand(before, after, renamed)];
    const map = this.translationsCommand(this.translationsValue, translations);
    if (map) {
      commands.push(map);
    }
    commands.push(...(swap?.commands ?? []), ...extra);
    this.editor.execute(commands.length === 1 ? commands[0]! : new CompositeCommand(id, commands));
    for (const { componentId, edits } of swap?.drafts ?? []) {
      const draft = this.drafts.get(componentId);
      if (draft && isPlainObject(draft.configuration)) {
        for (const edit of edits) {
          writeTextInConfiguration(draft.configuration, edit.propertyPath, edit.value);
        }
      }
    }
    this.emitChange("edit");
    return true;
  }

  /**
   * Renames the language `from` to `to` as **one** undoable step: its translations
   * move to the new code in the map — the journeys' and layouts' with the form's — the language
   * keeps its label and, if it was, its place as the default; the canvas's language follows. A
   * layout's own document language (`accessibility.lang`) is the code as plain text outside
   * any translation, so it follows too. A host keeping a catalog of its own reads the move at
   * its Save ({@link localeChangesSinceSave}).
   * Refused (`false`, nothing changed) for a code the form does not have, a new code already
   * taken (any case), blank or not a language code (`languageRenameProblem`), or while the form's own settings have changes not applied.
   */
  public renameLocale(from: string, to: string): boolean {
    const target = to.trim();
    const current = this.localizationValue;
    const entries = supportedLocaleEntries(current);
    // The one rule the Languages workspace and the agent check first: a code of the right shape,
    // not taken by another language in any case. A host calling the controller directly gets the
    // same refusal, so a malformed code (`__proto__`, one with a space) never reaches the list.
    if (target === from || !entries.some((entry) => entry.code === from) || languageRenameProblem(from, target, current) !== undefined || this.hasPendingChanges(this.rootId())) {
      return false;
    }
    const after = normalizeLocalizationConfiguration(withLanguageRenamed(current, from, target));
    const layoutLanguage = this.outsideCommand((document, value) => (document.id === "pdf" ? renameLayoutLanguage(value, from, target) : value));
    return this.runLanguageStep("RENAME_LOCALE", current, after, renameLocaleTranslations(this.translationsValue, from, target), undefined, { from, to: target }, layoutLanguage ? [layoutLanguage] : []);
  }

  /**
   * The canvas and inspector locale, when the form supported it (`before`) and no longer does:
   * the form's default locale, else the first left. A form left with no languages keeps it.
   */
  private leaveLocaleIfGone(before: readonly string[]): void {
    const left = supportedLocaleCodes(this.localizationValue);
    if (left.length === 0 || !before.includes(this.locale) || left.includes(this.locale)) {
      return;
    }
    const preferred = this.localizationValue?.defaultLocale;
    this.locale = preferred !== undefined && left.includes(preferred) ? preferred : left[0]!;
  }

  /**
   * Writes the localization configuration straight to the committed value — the direct path
   * for a host driving the builder programmatically, and with the Languages workspace's
   * {@link localizationActions} one of the two writers of the languages. `silent` skips
   * the change event, for a caller whose tree did not change and who repaints itself (a mode
   * declaring the form's locales on its own controller).
   */
  public setLocalization(value: LocalizationConfiguration | undefined, meta: { silent?: boolean } = {}): void {
    const next = normalizeLocalizationConfiguration(value);
    if (!meta.silent && !sameData(next, this.localizationValue)) {
      // A host changing the languages is an edit of the form like any other: its own history
      // entry, so an Undo takes it back (and Redo puts it again), and the languages' baseline stays
      // where the last Save left it, so `localeChangesSinceSave` still reports the net change.
      // Only the silent call below is the mirror a mode's own controller keeps of the form's
      // languages, which is a state to follow and no step to undo.
      this.editor.execute(this.localizationCommand(this.localizationValue, next));
      this.emitChange("edit");
      return;
    }
    this.localizationValue = next ? structuredClone(next) : undefined;
    this.markLocalesSaved();
    if (!meta.silent) {
      this.emitChange("edit");
    }
  }

  /**
   * Replaces the form's `tests` block. The value is normalised ({@link
   * normalizeTestsConfiguration}) and compared with the block held; a different one is an edit
   * of the form with its own history step, announced as one `change` with reason `"edit"` (the
   * Tests panel re-runs on it, a host persists on it). `silent` is the shell's initial feed from
   * a host's `tests` property: it stores the value and announces nothing, adds no history entry,
   * and leaves the undo stack as it was, as {@link setLocalization} does for a mode's mirror.
   */
  public setTests(value: FormTestConfiguration | undefined, meta: { silent?: boolean } = {}): void {
    const next = normalizeTestsConfiguration(value);
    if (sameData(next, this.testsValue)) {
      return;
    }
    if (meta.silent) {
      this.testsValue = next ? structuredClone(next) : undefined;
      return;
    }
    this.editor.execute(this.testsCommand(this.testsValue, next));
    this.emitChange("edit");
  }

  /**
   * The committed {@link FormIdentity} of the form being edited — what Save has written, and
   * what a host persists as the definition's `id`, `version` and `schemaVersion` beside
   * {@link snapshot}. `undefined` when the host handed the builder no identity to edit.
   */
  public identity(): FormIdentity | undefined {
    return this.identityValue ? { ...this.identityValue } : undefined;
  }

  /**
   * The identity as the author currently sees it: the form root's uncommitted draft when one
   * is open, else the committed value. The Form panel's Identity section renders from this.
   */
  public draftIdentity(): FormIdentity | undefined {
    const draft = this.drafts.get(this.rootId());
    if (draft && "identity" in draft) {
      return draft.identity ? { ...draft.identity } : undefined;
    }
    return this.identity();
  }

  /**
   * What is wrong with the identity as the author currently sees it, by field, in words: an id
   * or version longer than the kernel stores. Save refuses while there is one, so a form is never
   * written that Open would refuse. Empty when the identity is fine or there is none.
   */
  public identityProblems(): { id?: string; version?: string } {
    return identityLimitProblems(this.draftIdentity());
  }

  /**
   * Buffers an edit to the form's identity through the root's draft, so Save / Cancel govern
   * it like every other form-root property. Whitespace is kept while drafting (the panel
   * repaints its boxes from here per keystroke); Save trims, and a field left blank keeps
   * its committed value. Ignored while the builder has no identity to edit.
   */
  public setDraftIdentity(value: FormIdentity): void {
    if (!this.identityValue) {
      return;
    }
    const draft = this.ensureDraft(this.rootId());
    if (!draft) {
      return;
    }
    draft.identity = normalizeFormIdentity(value, { keepWhitespace: true });
    this.emitChange("edit");
  }

  /**
   * Writes the identity straight to the committed value — the direct path for a host driving
   * the builder programmatically ({@link setDraftIdentity} is the panel's). An open root
   * draft is kept in step so the panel does not fall behind. `undefined` takes the Identity
   * section away again.
   */
  public setIdentity(value: FormIdentity | undefined, meta: { silent?: boolean } = {}): void {
    const next = normalizeFormIdentity(value, { fallback: this.identityValue });
    // The same limits the Identity section holds a draft to: a write that Open would refuse
    // never lands, so a host cannot save a file the builder itself cannot read back. Only a
    // field this call changes is held to them: a form loaded with a long id (reported, not
    // refused) still takes a new version, as a caller writing the whole identity back sends it.
    const overLimit = identityLimitProblems(next);
    const refused =
      (overLimit.id !== undefined && next?.id !== this.identityValue?.id ? overLimit.id : undefined) ??
      (overLimit.version !== undefined && next?.version !== this.identityValue?.version ? overLimit.version : undefined);
    if (refused) {
      throw new Error(refused);
    }
    this.identityValue = next ? { ...next } : undefined;
    const draft = this.drafts.get(this.rootId());
    if (draft) {
      draft.identity = next ? { ...next } : undefined;
    }
    if (!meta.silent) {
      this.emitChange("edit");
    }
  }

  /** The design-system bindings the host offers the canvas; empty when it offers none. */
  public availableBindings(): BuilderBindingOption[] {
    return this.bindingOptions;
  }

  /**
   * Id of the binding the canvas draws with: the picker's choice, else the host's binding when it
   * is one the picker offers (by id, or the very object an entry carries). `undefined` while
   * the canvas draws with a binding the picker does not list, or with Datum's own and the
   * picker offers no `"datum"` entry.
   */
  public bindingId(): string | undefined {
    if (this.bindingIdValue !== undefined) {
      return this.bindingIdValue;
    }
    const host = this.hostBinding;
    const id = host === undefined ? "datum" : typeof host === "string" ? host : host.id;
    const offered = this.bindingOptions.find((option) => (typeof host === "object" && option.binding !== undefined ? option.binding === host : option.id === id));
    return offered?.id;
  }

  /**
   * Draws the canvas with one of the offered bindings (`undefined`: the host's own, else
   * Datum's). A `"preview"` change: the tree is untouched, and nothing is written into the form
   * or its PDF layouts. An id nobody offered is ignored.
   */
  public setBindingId(id: string | undefined): void {
    const option = this.bindingOptions.find((entry) => entry.id === id);
    if (id !== undefined && !option) {
      return;
    }
    this.bindingIdValue = option?.id;
    this.refreshCssClassChecks();
    this.emitChange("preview");
  }

  /** The binding chosen, before the builder's scheme: the picker's entry, else the host's. */
  private chosenBinding(): LiveBinding | string | undefined {
    if (this.bindingIdValue !== undefined) {
      const option = this.bindingOptions.find((entry) => entry.id === this.bindingIdValue);
      if (option) {
        return option.binding ?? (option.id === "datum" ? undefined : option.id);
      }
    }
    const host = this.hostBinding;
    if (typeof host === "string") {
      // An id the picker offers draws with the object its entry carries.
      return host === "datum" ? undefined : (this.bindingOptions.find((option) => option.id === host)?.binding ?? host);
    }
    return host;
  }

  /** A binding as the picker or the registry knows it, for its `darkVariant` and label. */
  private bindingObject(value: LiveBinding | string | undefined): LiveBinding | undefined {
    if (value === undefined || typeof value === "object") {
      return value;
    }
    return this.bindingOptions.find((option) => option.id === value)?.binding ?? bindingById(value);
  }

  /**
   * A binding as the builder's scheme draws it: while the builder is dark, the binding named as
   * its `darkVariant` (an offered entry, else one registered on the page); else itself. Datum's
   * own dark look is no other binding: it is the dark colour scheme ({@link canvasColorScheme}).
   */
  private underScheme(value: LiveBinding | string | undefined): { binding: LiveBinding | string | undefined; varied: boolean } {
    if (this.previewSchemeValue !== "dark" || value === undefined) {
      return { binding: value, varied: false };
    }
    const variantId = this.bindingObject(value)?.darkVariant;
    const ownId = typeof value === "string" ? value : value.id;
    if (typeof variantId !== "string" || variantId === "" || variantId === ownId) {
      return { binding: value, varied: false };
    }
    const offered = this.bindingOptions.find((option) => option.id === variantId);
    // A registered variant by its id, as the form element resolves one: a later registration under it draws.
    const variant = offered ? (offered.binding ?? offered.id) : bindingById(variantId) !== undefined ? variantId : undefined;
    return variant === undefined ? { binding: value, varied: false } : { binding: variant, varied: true };
  }

  /**
   * What the canvas's form element draws with ({@link chosenBinding} under the builder's scheme):
   * a binding, a registered id, or `undefined` for Datum's. The canvas lays
   * {@link canvasComponents} over it. Never written into the form.
   */
  public canvasBinding(): LiveBinding | string | undefined {
    return this.underScheme(this.chosenBinding()).binding;
  }

  /**
   * The colour scheme the canvas draws in: dark while the builder is dark and the canvas draws
   * with Datum's binding (whose dark look is its dark scheme) or with a binding's dark variant;
   * light for a binding that has no dark look, which shows as itself.
   */
  public canvasColorScheme(): "light" | "dark" {
    const given = this.canvasSchemeHook?.();
    if (given !== undefined) {
      return given;
    }
    if (this.previewSchemeValue !== "dark") {
      return "light";
    }
    const chosen = this.chosenBinding();
    return chosen === undefined || this.underScheme(chosen).varied ? "dark" : "light";
  }

  /**
   * The design system's files the canvas draws with: the offered entry's own `assets` for the
   * binding drawn (or the entry picked, when the builder's scheme draws its dark variant), else
   * the host's `assets` while the canvas draws the host's own binding, else none. A pick of
   * Datum's or another design system's binding never draws with the host's files.
   */
  public canvasAssets(): LiveAssets | undefined {
    const idOf = (value: LiveBinding | string | undefined): string => (value === undefined ? "datum" : typeof value === "string" ? value : value.id);
    const drawn = this.bindingOptions.find((option) => option.id === idOf(this.canvasBinding()));
    if (drawn?.assets) {
      return drawn.assets;
    }
    const chosen = idOf(this.chosenBinding());
    const picked = this.bindingOptions.find((option) => option.id === chosen);
    if (picked?.assets) {
      return picked.assets;
    }
    return chosen === idOf(this.hostBinding) ? this.assetsValue : undefined;
  }

  /** Adapters laid over the canvas's binding for this tree's own types (a designer's); `undefined` for none. */
  public canvasComponents(): Readonly<Record<string, AdapterEntry>> | undefined {
    return this.canvasComponentsValue;
  }

  /**
   * The canvas lends the controller its account of how the form is drawn (the mounted form's
   * adapters and the binding's capability answers) so the inspector can say which adapter draws
   * the selection and leave out the settings the binding does not draw. Silent: the canvas
   * calls {@link drawingChanged} once a draw has landed and moved what the inspector reads.
   */
  public setDrawingSource(source: BuilderDrawingSource | undefined): void {
    this.drawingSource = source;
  }

  /** Tells whoever listens to `drawing` that how the selection is drawn moved, so the inspector reads it again. */
  public drawingChanged(): void {
    this.emit("drawing", {});
  }

  /**
   * How the form is drawn for `componentId`, as the inspector reads it: the adapter that drew it
   * and what the surface answers for its type. `undefined` without a source from the canvas.
   */
  public drawingOf(componentId: string | undefined): { adapter: InspectorDrawnBy | undefined; answers: ReturnType<BuilderDrawingSource["capabilitiesOf"]>; binding: string } | undefined {
    const source = this.drawingSource;
    if (source === undefined || componentId === undefined) {
      return undefined;
    }
    const node = this.editor.componentTree().find(componentId);
    return {
      adapter: source.adapterOf(componentId),
      answers: node === undefined ? undefined : source.capabilitiesOf(node.type),
      binding: source.bindingLabel()
    };
  }

  /**
   * The line the inspector shows above the sections: which adapter draws the component and
   * whose it is. Empty before the canvas has drawn it, for the root (no adapter of its own) and
   * without a source.
   */
  public drawnByLine(componentId: string | undefined): string | undefined {
    if (componentId === undefined || componentId === this.rootId()) {
      return undefined;
    }
    const drawn = this.drawingOf(componentId);
    const adapter = drawn?.adapter;
    if (drawn === undefined || adapter === undefined) {
      return undefined;
    }
    return this.builderWords().text(`inspector.drawn.${adapter.from}`, { name: adapter.name ?? adapter.via, via: adapter.via, binding: drawn.binding });
  }

  /**
   * The notes beside the settings the binding does not draw in full: a reduced one says how, and
   * a setting the binding does not draw that the component still holds says the value is kept.
   * Read off the inspector model, so the boxes and the notes cannot disagree.
   */
  private drawingNotes(model: InspectorModel, componentId: string): BuilderNote[] {
    const report = model.drawing;
    const drawn = report === undefined ? undefined : this.drawingOf(componentId);
    if (report === undefined || drawn === undefined) {
      return [];
    }
    const words = this.builderWords();
    const notes: BuilderNote[] = [];
    for (const entry of report.degraded) {
      notes.push({ target: entry.propertyPath, message: words.text(`inspector.drawing.degraded.${entry.capability}`, { binding: drawn.binding }) });
    }
    for (const entry of report.kept) {
      notes.push({ target: entry.propertyPath, message: words.text("inspector.drawing.kept", { binding: drawn.binding }) });
    }
    return notes;
  }

  /**
   * The binding picker's entries: the offered bindings, each named as the canvas draws it under
   * the builder's scheme, and the one the canvas draws with marked. While the builder is dark, a
   * binding with a dark variant reads under the variant's name (the offered entry's label, else
   * the binding's own) and the variant's own entry is left out: the two would draw the same form.
   * Choosing an entry picks its `id`, so a pick made in a dark builder is the light binding, and
   * the form follows the builder back to light.
   */
  public bindingChoices(): BuilderBindingChoice[] {
    const offered = this.bindingOptions;
    const idOf = (value: LiveBinding | string | undefined): string => (value === undefined ? "datum" : typeof value === "string" ? value : value.id);
    const drawn = offered.map((option) => idOf(this.underScheme(option.binding ?? (option.id === "datum" ? undefined : option.id)).binding));
    const choices: BuilderBindingChoice[] = [];
    offered.forEach((option, index) => {
      // A variant another entry stands for while dark.
      if (drawn.some((other, at) => at !== index && other === option.id && offered[at]!.id !== option.id)) {
        return;
      }
      const shown = drawn[index]!;
      const label = shown === option.id ? option.label : (offered.find((entry) => entry.id === shown)?.label ?? this.bindingObject(shown)?.label ?? option.label);
      choices.push({ id: option.id, label, selected: false });
    });
    const picked = this.bindingId();
    const canvas = idOf(this.canvasBinding());
    const selected =
      choices.find((choice) => choice.id === picked) ??
      // The pick has no entry of its own (a dark variant, in a dark builder): the entry that draws the same form stands for it.
      choices.find((choice) => drawn[offered.findIndex((option) => option.id === choice.id)] === canvas);
    if (selected) {
      selected.selected = true;
    }
    return choices;
  }

  /**
   * The builder's own colour scheme, from the shell. A `"preview"` change when it moves what the
   * canvas draws ({@link canvasBinding}, {@link canvasColorScheme}); silent for a binding with no
   * dark look.
   */
  public setPreviewScheme(scheme: "light" | "dark"): void {
    if (scheme === this.previewSchemeValue) {
      return;
    }
    const before = [this.canvasBinding(), this.canvasColorScheme()];
    this.previewSchemeValue = scheme;
    if (this.canvasBinding() !== before[0] || this.canvasColorScheme() !== before[1]) {
      this.emitChange("preview");
    }
  }

  /** The builder's own colour scheme, as the shell last reported it. */
  public previewScheme(): "light" | "dark" {
    return this.previewSchemeValue;
  }

  /**
   * The classes the chosen binding declares (`LiveBinding.cssClasses`) that apply to a component,
   * for the inspector's Style tab: a toggle each, or one choice among the classes of a group.
   * Only the classes that name no type are offered without a component. Datum's own binding, when
   * no object stands for it, declares the shared panel looks, as `createDatumBinding()` does.
   */
  public styleOptions(componentId?: string): CssClassChoice[] {
    const node = componentId === undefined ? undefined : this.editor.componentTree().find(componentId);
    return bindingClassChoices(this.declaringBinding(), node === undefined ? undefined : { type: node.type, base: drawnBaseOf(node, this.kindsOffered()) });
  }

  /**
   * Ticks or clears one of the Style tab's classes in the component's draft in a single write:
   * ticking a class of a group takes the others of that group away with it, so undoing the edit
   * (after Save) brings the component back as it was in one step. `live` marks a write whose
   * panel keeps its own markup (see {@link setDraftProperty}).
   */
  public setStyleClass(componentId: string, name: string, on: boolean, meta: { live?: boolean } = {}): void {
    const value = toggleCssClass(this.draftProperty(componentId, "cssClass"), name, on, this.styleOptions(componentId));
    this.setDraftProperty(componentId, "cssClass", value, meta);
  }

  /** Takes every class of `group` off the component's draft: the way back to the binding's default look. */
  public clearStyleGroup(componentId: string, group: string, meta: { live?: boolean } = {}): void {
    const value = clearCssClassGroup(this.draftProperty(componentId, "cssClass"), group, this.styleOptions(componentId));
    this.setDraftProperty(componentId, "cssClass", value, meta);
  }

  /**
   * The vocabulary a component's `cssClass` is checked against: the class names the chosen binding
   * declares plus the shared panel looks, which every binding accepts. Empty, so no vocabulary,
   * when the binding declares no class beyond those looks: the GC Design System's and Datum's own
   * (an object, or the default with none) all draw the looks and name nothing else, so a class a
   * page's CSS gives a meaning to is not a mistake there ({@link bindingClassVocabulary}).
   */
  public cssClassNames(): string[] {
    const binding = this.chosenBindingObject();
    if (!this.classNamesCache || this.classNamesCache.binding !== binding) {
      this.classNamesCache = { binding, classes: bindingClassVocabulary(binding) };
    }
    return this.classNamesCache.classes;
  }

  /** What declares the classes: the chosen binding, else Datum's own, whose declaration is the shared panel looks. */
  private declaringBinding(): Pick<LiveBinding, "cssClasses"> {
    return this.chosenBindingObject() ?? DATUM_OWN_CLASSES;
  }

  /** The chosen binding as an object (an id resolved through the picker's entries, else the page's registry); `undefined` for Datum's own. */
  private chosenBindingObject(): LiveBinding | undefined {
    return this.bindingObject(this.chosenBinding());
  }

  /**
   * How the component definitions' own types are drawn (`ComponentDefinition.adapter`): their adapters and stylesheets, which the canvas lays
   * over the binding it draws with under any designer's own ({@link canvasComponents}). `context` is what an adapter factory is
   * called with (the canvas's lit namespace and Datum binding); without it a factory draws
   * nothing. `undefined` when no definition brings one. The same object until the definitions
   * change.
   */
  public componentDrawing(context?: ComponentAdapterContext): ComponentDrawing | undefined {
    const registry = this.componentRegistry;
    if (!this.drawingCache || this.drawingCache.registry !== registry) {
      const drawing = registry ? componentDrawingOf(registry.latest(), context) : undefined;
      this.drawingCache = { registry, drawing: drawing && !isEmptyDrawing(drawing) ? drawing : undefined };
    }
    return this.drawingCache.drawing;
  }

  /** Checks the edited (draft-or-committed) `cssClass` of one component. */
  private checkCssClassesFor(componentId: string) {
    return validateComponentCssClasses(
      this.draftProperty(componentId, "cssClass"),
      this.cssClassNames(),
      this.builderWords()
    );
  }

  /** Re-runs the cssClass checks for the selection — after an edit, or a binding swap. */
  private refreshCssClassChecks(): void {
    const check = this.selectedId
      ? this.checkCssClassesFor(this.selectedId)
      : { error: undefined, warning: undefined };
    this.cssClassError = check.error;
    this.cssClassWarning = check.warning;
  }


  /** Resolver backing `select` options in the canvas preview, if the host supplied one. */
  public dataSourceResolver(): DataSourceResolver | undefined {
    return this.previewDataSources;
  }

  /**
   * The data sources the canvas previews with: the host's wiring-time set, with the author's
   * simulated lists laid over it (a simulated id wins over the host's own).
   */
  public dataSources(): DataSourceSet | undefined {
    const host = this.previewDataSourceSet;
    if (this.simulatedSources.size === 0) {
      return host;
    }
    const layered = this.layeredSources;
    if (layered && layered.host === host) {
      return layered.set;
    }
    const simulated = this.simulatedSources;
    const set: DataSourceSet = {
      has: (id) => simulated.has(id) || (host?.has(id) ?? false),
      ids: () => [...new Set([...(host?.ids() ?? []), ...simulated.keys()])],
      load: (id, query, context) => {
        const items = simulated.get(id);
        if (items) {
          // Copied on every load, as defineDataSources does: a caller's edit never reaches the list.
          return Promise.resolve({ items: items.map((item) => ({ ...item })) });
        }
        return host ? host.load(id, query, context) : Promise.reject(new Error(`No data source "${id}"`));
      }
    };
    this.layeredSources = { host, set };
    return set;
  }

  /** Every data source id the inspector's picker offers: the wired set's, the host's extra ids, then the simulated ones. */
  public dataSourceIds(): string[] {
    return [...new Set([...(this.previewDataSourceSet?.ids() ?? []), ...this.hostDataSourceIds, ...this.simulatedSources.keys()])];
  }

  /** The host's own data source ids, without the simulated ones: what the Settings panel says the host provides. */
  public hostDataSourceIdList(): string[] {
    return [...new Set([...(this.previewDataSourceSet?.ids() ?? []), ...this.hostDataSourceIds])];
  }

  /** The author's simulated lists, by data source id. */
  public simulatedDataSources(): ReadonlyMap<string, DataSourceResult["items"]> {
    return this.simulatedSources;
  }

  /**
   * Tries the form with `items` in place of data source `id` (the Settings panel's simulator), or
   * stops with `undefined`. The canvas previews it at once; the definition never holds it.
   */
  public setSimulatedDataSource(id: string, items: DataSourceResult["items"] | undefined): void {
    if (items === undefined) {
      if (!this.simulatedSources.delete(id)) {
        return;
      }
    } else {
      this.simulatedSources.set(id, items.map((item) => ({ ...item })));
    }
    // A new set, so the canvas loads the lists again.
    this.layeredSources = undefined;
    this.emitChange("preview");
  }

  /** What Submit does while the author tries the form: a stand-in for the page's server. */
  public trySubmission(): TrySubmissionSettings {
    return this.trySubmissionValue;
  }

  /**
   * Changes some of what Submit does in Try it, the rest kept; each value is kept to what it may
   * be (the delay to 0 to 10000 ms, a placement to the top, the bottom or both). Session state,
   * as the simulated data sources are: the definition never holds it.
   */
  public setTrySubmission(update: TrySubmissionUpdate): void {
    const next = normalizeTrySubmission(update, this.trySubmissionValue);
    if (JSON.stringify(next) === JSON.stringify(this.trySubmissionValue)) {
      return;
    }
    this.trySubmissionValue = next;
    this.emitChange("preview");
  }

  /**
   * The host values the author gave Try it's Settings: what the form's rules read under `host.`
   * while it is previewed (plain JSON data, as `plainHostContext` keeps it); `undefined` when none.
   */
  public tryHostContext(): Record<string, unknown> | undefined {
    return this.tryHostContextValue;
  }

  /**
   * Gives the preview these host values, or none with `undefined`. Session state, as the
   * simulated data sources and the stand-in server are: the definition never holds it, the change
   * is a `"preview"` one (never an edit, so nothing to undo), and the canvas computes the rules
   * again over the answers typed. A record equal to the one held changes nothing.
   */
  public setTryHostContext(context: Record<string, unknown> | undefined): void {
    const next = context === undefined ? undefined : (JSON.parse(JSON.stringify(context)) as Record<string, unknown>);
    if (JSON.stringify(next ?? null) === JSON.stringify(this.tryHostContextValue ?? null)) {
      return;
    }
    this.tryHostContextValue = next;
    this.emitChange("preview");
  }

  /** The frames the form can sit in under the chosen binding, labelled for the locale. */
  public frameChoices(): Array<{ id: string; label: string }> {
    return frameOptions(this.chosenFrames(), this.locale);
  }

  /** The frame presets the chosen binding adds to the built-ins (`LiveBinding.frames`): a Datum binding's `frame` option. */
  private chosenFrames(): LiveBinding["frames"] {
    return this.chosenBindingObject()?.frames;
  }

  /** Lends the controller the host's translation catalog (undefined: none), so labels it keys resolve as the form resolves them. */
  public setTranslationCatalog(catalog: TranslationCatalog | (() => TranslationCatalog | undefined) | undefined): void {
    this.translationCatalogValue = catalog;
  }

  /**
   * Lends the controller the builder's own words (the host's `textCatalog` and the builder's
   * text locale) for the messages it makes itself: the class-name checks that reach the
   * Inspector and Save, the labels the catalog lists. Absent: English, in the form's locale.
   */
  public setTextWords(words: { locale?: string | undefined; catalog?: BuilderTextCatalog | (() => BuilderTextCatalog | undefined) | undefined }): void {
    this.textLocaleValue = words.locale;
    this.textCatalogValue = words.catalog;
    // The problems kept for the panels (problemsOf) are worded in these words: kept no longer.
    this.revision += 1;
    if (this.selectedId) {
      this.refreshCssClassChecks();
    }
  }

  private textLocaleValue: string | undefined;
  private textCatalogValue: BuilderTextCatalog | (() => BuilderTextCatalog | undefined) | undefined;

  /** The builder's words for what this controller words itself. */
  private builderWords(): BuilderWords {
    const words = new BuilderWords();
    words.locale = this.textLocaleValue ?? this.locale;
    const lent = this.textCatalogValue;
    words.catalog = typeof lent === "function" ? lent() : lent;
    return words;
  }

  /** What a text resolves through here: the form's own translations, then the host's catalog. */
  private labelSources(): { translations: FormTranslations | undefined; catalog: TranslationCatalog | undefined } {
    return { translations: this.translationsValue, catalog: this.translationCatalog() };
  }

  /** The catalog lent now (a lent function is asked each time, so the host's latest shows). */
  public translationCatalog(): TranslationCatalog | undefined {
    const lent = this.translationCatalogValue;
    return typeof lent === "function" ? lent() : lent;
  }

  /** The host chrome the canvas previews under: a frame, the form's own parts kept or left out, its language switcher. */
  public previewChrome(): FormChromeConfiguration | undefined {
    return this.previewChromeValue;
  }

  public setPreviewChrome(value: FormChromeConfiguration | undefined): void {
    if (JSON.stringify(value ?? null) === JSON.stringify(this.previewChromeValue ?? null)) {
      return;
    }
    this.previewChromeValue = value ? { ...value } : undefined;
    this.emitChange("preview");
  }

  /** The validation codes the host named for the messages editor, as given. */
  public validationCodes(): HostValidationCode[] {
    return [...this.hostValidationCodes];
  }

  /**
   * The committed tree — what Save has written, and what a host should persist. Its nodes are
   * fresh copies, but their `configuration` and `rules` objects are the tree's own (a deep copy
   * on every change would cost a keystroke several times over): a host must never write into a
   * snapshot, and copies one it keeps as it is (`structuredClone`), since an edit made in place
   * later (`setProperty`) shows in it.
   */
  public snapshot(): ComponentNode {
    return this.editor.snapshot();
  }

  /**
   * The `kinds` map of the definition the host has open (the entries its own file carries), read
   * each time it is wanted: a host that opens or seeds definitions sets it once (`() => opened.kinds`).
   * Try it passes it to {@link definitionKinds} as `current`, so it checks a type the page's
   * catalogue does not offer as the saved file, the runtime and a server do. Unset: no file's map.
   */
  public openedKinds: (() => Readonly<Record<string, string>> | undefined) | undefined;

  /**
   * The `kinds` map the form saves with: an entry for every type the committed tree
   * uses that the engine does not know, naming the engine type it reads as. The base comes from
   * the component definitions' own `base` (a plugin's types), then the binding the canvas draws
   * with, then every other binding the picker offers or the page registered (a tier-2 type such
   * as `gcds-date`), else the entry `current` (the map the form was loaded with) gives it.
   * Entries for types the form no longer uses go. What the host's save writes, so validation, the
   * sandbox and the PDF read the type as its base without the plugin's or binding's code.
   * `current` itself when nothing changes; `undefined` when the form needs no entry.
   */
  public definitionKinds(current?: Readonly<Record<string, string>>): Record<string, string> | undefined {
    return definitionKindsFor(this.snapshot(), this.kindsOffered(), current);
  }

  /** The type-to-base map the component definitions, the chosen binding, the picker's bindings and the page's registered ones offer. */
  private kindsOffered(): Readonly<Record<string, string>> {
    const chosen = this.bindingObject(this.chosenBinding());
    return offeredKinds(
      basesOf(this.componentRegistry?.latest()),
      chosen?.kinds,
      ...this.bindingOptions.map((option) => option.binding?.kinds),
      ...registeredBindings().map((binding) => binding.kinds)
    );
  }

  /**
   * The tree as the author currently sees it: committed, with every uncommitted draft laid
   * over it. The canvas previews from this so typing a label is visible immediately, while the
   * snapshot a host reads stays exactly what Save has written.
   *
   * A pending id rename is deliberately *not* applied — selection, drop targets and any rule
   * referencing the field all address it by its committed id until the rename actually lands.
   */
  public previewSnapshot(): ComponentNode {
    if (this.drafts.size === 0) {
      return this.editor.snapshot();
    }
    const apply = (node: ComponentNode): ComponentNode => {
      const draft = this.drafts.get(node.id);
      const next: ComponentNode = draft
        ? { ...node, configuration: structuredClone(draft.configuration) }
        : { ...node };
      if (draft) {
        if (draft.rules) {
          next.rules = structuredClone(draft.rules);
        } else {
          delete next.rules;
        }
      }
      if (node.children) {
        next.children = Object.fromEntries(
          Object.entries(node.children).map(([slotId, group]) => [slotId, group.map(apply)])
        );
      }
      return next;
    };
    return apply(this.editor.snapshot());
  }

  /**
   * What the canvas draws: {@link previewSnapshot}, through the tree owner's
   * {@link BuilderControllerOptions.canvasRoot} when it has one.
   */
  public canvasSnapshot(): ComponentNode {
    const root = this.previewSnapshot();
    return this.canvasRootHook ? this.canvasRootHook(root) : root;
  }

  /**
   * The tree view the canvas walks, marks drop zones from and names the selection by: with a
   * {@link BuilderControllerOptions.canvasView} hook, the view of {@link canvasSnapshot} built as
   * {@link treeView} builds its own (resolver, locale, labeler, label sources) and handed through
   * the hook; without one, {@link treeView} itself.
   */
  public canvasTreeView(): NestedTreeNodeView {
    const hook = this.canvasViewHook;
    if (!hook) {
      return this.treeView();
    }
    const root = this.previewSnapshot();
    const drawn = this.canvasRootHook ? this.canvasRootHook(root) : root;
    const viewOf = (node: ComponentNode): NestedTreeNodeView => buildNestedTreeView(node, this.resolver, this.locale, this.nodeLabeler, this.labelSources());
    return hook(viewOf(drawn), { root, viewOf });
  }

  /** The id of the root the canvas draws: {@link canvasSnapshot}'s with a {@link BuilderControllerOptions.canvasView} hook, else {@link rootId}. */
  public canvasRootId(): string {
    return this.canvasViewHook ? this.canvasSnapshot().id : this.rootId();
  }

  /** The journey page the canvas draws its tree as ({@link BuilderControllerOptions.canvasJourneyView}); `undefined`: the whole form. */
  public canvasJourneyView(): JourneyView | undefined {
    const hook = this.canvasJourneyViewHook;
    return hook ? hook(this.previewSnapshot()) : undefined;
  }

  /** The words on drawn components' boxes ({@link BuilderControllerOptions.canvasTags}); `undefined`: none. */
  public canvasTags(): ReadonlyMap<string, string> | undefined {
    const hook = this.canvasTagsHook;
    return hook ? hook(this.previewSnapshot()) : undefined;
  }

  /** What the page's own chrome on the canvas selects ({@link BuilderControllerOptions.canvasRegionOwner}); `undefined`: nothing. */
  public canvasRegionOwner(): CanvasRegionOwner | undefined {
    const hook = this.canvasRegionOwnerHook;
    return hook ? hook(this.previewSnapshot()) : undefined;
  }

  /** The step picker the canvas bar shows ({@link BuilderControllerOptions.canvasStepper}); `undefined`: the tree's own steps container. */
  public canvasStepper(): CanvasStepper | undefined {
    return this.canvasStepperHook?.();
  }

  /** The drawn ids a click selects another for ({@link BuilderControllerOptions.canvasSelectTarget}); `undefined`: every id is its own. */
  public canvasSelectTargets(): ReadonlyMap<string, string> | undefined {
    const hook = this.canvasSelectTargetHook;
    return hook ? hook(this.previewSnapshot()) : undefined;
  }

  /**
   * Bumped each time {@link BuilderControllerOptions.canvasRoot}, `canvasView` or
   * `canvasJourneyView` is swapped for another: the canvas draws a sheet of another kind over the
   * same controller, and takes its renderer off the runtime so it is drawn once, whole. Never
   * bumped by an edit, a selection or any other option.
   */
  public canvasRevision(): number {
    return this.canvasRevisionValue;
  }

  /**
   * Bumped by every change this controller announces (an edit, a draft, a selection, a repaint,
   * new options), so what is worked out from its tree can be kept until the next one. Only ever
   * grows; compare for equality.
   */
  public changeRevision(): number {
    return this.revision;
  }

  /** Id of the form root node — pass to {@link select} to edit form-level properties. */
  public rootId(): string {
    return this.editor.componentTree().rootId();
  }

  public isRootSelected(): boolean {
    return this.selectedId === this.rootId();
  }

  public selectedComponentId(): string | undefined {
    return this.selectedId;
  }

  public selectedNode(): ComponentNode | undefined {
    return this.selectedId ? this.editor.componentTree().find(this.selectedId) : undefined;
  }

  /**
   * The component with its uncommitted draft applied — what a properties panel edits and what
   * Save would write. {@link selectedNode} stays the committed selection.
   *
   * The subject is explicit. The panels each name their own: the inspector asks for
   * the selection and draws nothing without one, the Form panel asks for {@link rootId}. The
   * root is a *place* an author goes, not what the inspector falls back to while nothing is
   * selected, so there is no longer one "inspected component" the controller can name — both
   * panels may hold a draft at once, and {@link drafts} has always allowed that.
   */
  public editedNode(componentId: string | undefined = this.selectedId): ComponentNode | undefined {
    const node = componentId ? this.editor.componentTree().find(componentId) : undefined;
    if (!node) {
      return undefined;
    }
    const draft = this.drafts.get(node.id);
    if (!draft) {
      return node;
    }
    const edited: ComponentNode = {
      ...node,
      id: draft.id,
      configuration: structuredClone(draft.configuration)
    };
    if (draft.rules) {
      edited.rules = structuredClone(draft.rules);
    } else {
      delete edited.rules;
    }
    return edited;
  }

  public treeView(): NestedTreeNodeView {
    return buildNestedTreeView(this.previewSnapshot(), this.resolver, this.locale, this.nodeLabeler, this.labelSources());
  }

  /**
   * How the inspector draws `componentId`'s ID row, when the tree's owner says (see
   * {@link BuilderControllerOptions.idRow}); `undefined` for the builder's default.
   */
  public idRow(componentId: string | undefined): BuilderIdRow | undefined {
    const resolve = this.idRowResolver;
    const node = resolve ? this.editedNode(componentId) : undefined;
    if (!resolve || !node) {
      return undefined;
    }
    const row = resolve(node, { isRoot: componentId === this.rootId() });
    return row ? { ...row } : undefined;
  }

  /**
   * Capabilities the registered definition declares for a type. These are what
   * `composePropertyEditor` composes the inspector from; a type declaring none falls back to
   * the engine's default label / description / required trio.
   */
  private capabilitiesFor(type: string): CapabilityDefinition[] {
    if (!this.componentRegistry) {
      return [];
    }
    try {
      return this.componentRegistry.resolve(type).capabilities ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Whether a component of `type` offers Required: its registered definition
   * declares the `required` capability, or declares none — the inspector then falls back to the
   * engine's label / description / required trio. What the Rules tab reads before offering
   * "Required when": a plugin's display component (a link, a notice, a heading) declares other
   * capabilities and no `required`, holds no answer, and a rule on it would refuse every
   * submission while it held — which the kernel, having no registry, cannot know. Without a
   * registry every type offers it.
   */
  public typeOffersRequired(type: string): boolean {
    // A data grid holds rows, not an answer: its row count has bounds of its own.
    if (type === DATA_GRID_COMPONENT_TYPE) {
      return false;
    }
    const capabilities = this.capabilitiesFor(type);
    return capabilities.length === 0 || capabilities.some((capability) => capability.id === "required");
  }

  /** The inspector model for `componentId` (default: the selection); see {@link editedNode}. */
  public inspectorModel(componentId: string | undefined = this.selectedId): InspectorModel | undefined {
    const node = this.editedNode(componentId);
    if (!node) {
      return undefined;
    }
    return this.composeInspectorModel(node);
  }

  /**
   * The inspector model for `node`: what {@link inspectorModel} answers for a node in the tree,
   * and {@link typeInfo} for a type's template under an unused id.
   */
  private composeInspectorModel(node: ComponentNode): InspectorModel {
    const model = buildInspectorModel(node, this.capabilitiesFor(node.type), this.withInspectorFields(node, this.componentEditorFor(node.type)), this.locale, {
      dataSourceIds: this.dataSourceIds(),
      validationCodes: this.hostValidationCodes,
      // The root's Frame picker offers the built-ins and the chosen binding's own.
      frameOptions: frameOptions(this.chosenFrames(), this.locale),
      kinds: this.kindsOffered(),
      ...this.fieldChoicesFor(node),
      ...this.presentationFor(node),
      ...this.drawingFor(node)
    });
    // A type the registry does not know: the panel says so above the sections.
    return this.knowsType(node.type) ? model : { ...model, unknownType: true };
  }

  /** `editor` with the boxes the tree's owner adds for `node` ({@link BuilderControllerOptions.inspectorFields}), each in its section. */
  private withInspectorFields(node: ComponentNode, editor: PropertyEditorDefinition | undefined): PropertyEditorDefinition | undefined {
    const extra = this.inspectorFieldsHook?.(node);
    if (!editor || !extra || extra.length === 0) {
      return editor;
    }
    return {
      ...editor,
      fields: [...(editor.fields ?? []), ...extra.map((entry) => entry.field)],
      sections: (editor.sections ?? []).map((section) => {
        const added = extra.filter((entry) => entry.section === section.id).map((entry) => entry.field.id);
        return added.length > 0 ? { ...section, fieldIds: [...added, ...section.fieldIds] } : section;
      })
    };
  }

  /** The inspector model's `drawing` for `node`: what the canvas's binding answers for its type, once the canvas lends it. */
  private drawingFor(node: ComponentNode): Pick<InspectorModelOptions, "drawing"> {
    const answers = this.drawingSource?.capabilitiesOf(node.type);
    return answers === undefined ? {} : { drawing: answers };
  }

  /** The inspector model's `fieldChoices` for `node`, when the tree's owner supplies them. */
  private fieldChoicesFor(node: ComponentNode): { fieldChoices?: (field: PropertyEditorField) => InspectorChoice[] | undefined } {
    const hook = this.fieldChoicesHook;
    return hook ? { fieldChoices: (field) => hook(node, field) } : {};
  }

  /** The inspector model's folded sections and placeholders for `node`, when the tree's owner says. */
  private presentationFor(node: ComponentNode): Pick<InspectorModelOptions, "foldedSections" | "placeholder"> {
    const folded = this.foldedSectionsHook?.(node);
    const placeholder = this.fieldPlaceholderHook;
    return {
      ...(folded && folded.length > 0 ? { foldedSections: folded } : {}),
      ...(placeholder ? { placeholder: (field: PropertyEditorField) => placeholder(node, field) } : {})
    };
  }

  /** Whether the registry has a definition for the type; without a registry, every type is the tree editor's to keep. */
  private knowsType(type: string): boolean {
    if (!this.componentRegistry) {
      return true;
    }
    try {
      this.componentRegistry.resolve(type);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every translatable text of the committed form, component by component in tree order, as the
   * inspector would edit it — the label, description, placeholder, tooltip or pattern message
   * each component *declares*, whether or not the author has written it yet — and the texts
   * beside the declared fields: the validation messages a component (or the form) words, a tabs
   * container's captions, an inline option's label and description, and the form's header and
   * footer parts. Each carries its string in the default language and the address its
   * translations live at. What the Languages workspace lists, so it agrees with the
   * builder's own inspector rather than with a walk over the configuration, which cannot see a
   * text nobody typed. Committed, not drafted: translations are made against the form the
   * renderer shows. The journeys' and layouts' texts are their modes' to list.
   */
  public translatableTexts(): TranslatableText[] {
    return this.textsOf(this.editor.snapshot(), true, {});
  }

  /**
   * The translatable texts of `root` and every component under it, as {@link translatableTexts}
   * lists the form's — each type's declared texts, read through this controller's registry —
   * for a tree that is not this one: a presentation's own nodes, whose types are the form's. `group` is the catalog group every row is listed under (its `componentId`, which
   * must name no form component) and `groupLabel` what the group is called. The addresses are
   * those of a component with the node's id; whoever owns the tree overrides them with its own.
   */
  public translatableTextsOf(
    root: ComponentNode,
    options: { group?: string | undefined; groupLabel?: string | undefined } = {}
  ): TranslatableText[] {
    return this.textsOf(root, false, options);
  }

  private textsOf(root: ComponentNode, isForm: boolean, options: { group?: string | undefined; groupLabel?: string | undefined }): TranslatableText[] {
    const words = this.builderWords();
    const sources = this.labelSources();
    const texts: TranslatableText[] = [];
    const visit = (node: ComponentNode): void => {
      const config = isPlainObject(node.configuration) ? node.configuration : {};
      const formRoot = isForm && node.id === root.id;
      const ownDefault = config[formRoot ? "title" : "label"];
      const own = typeof ownDefault === "string" && ownDefault.length > 0 ? resolveText(ownDefault, formRoot ? addressOf.form("title") : addressOf.component(node.id, "label"), this.locale, sources) : "";
      const componentLabel = options.groupLabel ?? (own.length > 0 ? own : formRoot ? words.text("controller.formLabel") : node.id);
      const componentId = options.group ?? node.id;
      const listed = new Set<string>();
      const add = (propertyPath: string, label: string, address: TextAddress | undefined, def: string, section?: string, owner = componentId, ownerLabel = componentLabel): void => {
        if (!address || listed.has(`${owner}\u0000${propertyPath}`)) {
          return;
        }
        listed.add(`${owner}\u0000${propertyPath}`);
        texts.push({ componentId: owner, componentLabel: ownerLabel, propertyPath, label, default: def, address, ...(section !== undefined ? { section } : {}) });
      };
      // The texts the component's editor declares as translatable strings (`localized-text`),
      // whether or not the author has typed them yet: the composed editor's own fields, else the
      // ones every field (or the form root) has. Listed whether or not a condition shows them now.
      const composed = composePropertyEditor(this.capabilitiesFor(node.type), { component: node }, this.componentEditorFor(node.type));
      if (composed) {
        const sectionOf = new Map<string, string | undefined>();
        for (const section of composed.sections) {
          const title = resolveLocalizedText(section.title, this.locale);
          for (const id of section.fieldIds) {
            sectionOf.set(id, title);
          }
        }
        const declared = composed.fields.length > 0 ? composed.fields : node.type === FORM_ROOT_COMPONENT_TYPE ? ROOT_TEXT_FIELDS : FIELD_TEXT_FIELDS;
        for (const field of declared) {
          if (field.type !== "localized-text") {
            continue;
          }
          const stored = getNestedValue(config, field.propertyPath);
          add(field.propertyPath, resolveLocalizedText(field.label, this.locale) ?? field.propertyPath, addressOfText(node, field.propertyPath, formRoot), typeof stored === "string" ? stored : "", sectionOf.get(field.id));
        }
      }
      // A tabs container's captions are named by the tab's own id (never its place), and past the
      // ones its editor declares are still resolved by the renderer (the live renderer's container features).
      if (node.type === TABS_COMPONENT_TYPE) {
        const tabs = Array.isArray(config.tabs) ? config.tabs : [];
        tabs.forEach((tab: unknown, index) => {
          const id = isPlainObject(tab) ? tab.id : undefined;
          if (typeof id !== "string" || id.length === 0) {
            return;
          }
          const caption = (tab as { label?: unknown }).label;
          add(`tabs.${index}.label`, words.text("controller.tabLabel", { n: index + 1 }), tabLabelAddress(node.id, id), typeof caption === "string" ? caption : "");
        });
      }
      // The validation messages the form or the component words, by their code.
      if (isPlainObject(config.messages)) {
        for (const [code, value] of Object.entries(config.messages)) {
          if (code.trim().length === 0 || typeof value !== "string") {
            continue;
          }
          const propertyPath = `messages.${code}`;
          add(propertyPath, words.text("controller.messageLabel", { code }), addressOfPropertyPath(node, propertyPath, formRoot), value);
        }
      }
      // Inline options (a label always, a description when the option has one), by their value.
      if (!formRoot && Array.isArray(config.options)) {
        config.options.forEach((option: unknown, index) => {
          if (!isInlineOption(option)) {
            return;
          }
          const quoted = `“${option.value}”`;
          add(`options.${index}.label`, quoted, addressOfPropertyPath(node, `options.${index}.label`, false), option.label ?? "");
          if (option.description !== undefined) {
            add(`options.${index}.description`, `${quoted} · description`, addressOfPropertyPath(node, `options.${index}.description`, false), option.description);
          }
        });
      }
      // The printed form's running header and footer slots: the ones the author wrote, each a
      // template whose translation keeps its placeholders. A slot left to its default has no
      // words of the author's to translate.
      if (formRoot && isPlainObject(config.print)) {
        for (const band of ["header", "footer"] as const) {
          const slots = (config.print as Record<string, unknown>)[band];
          for (const slot of ["start", "end"] as const) {
            const text = isPlainObject(slots) ? (slots as Record<string, unknown>)[slot] : undefined;
            if (typeof text === "string" && text.length > 0) {
              const key = `controller.print${band === "header" ? "Header" : "Footer"}${slot === "start" ? "Start" : "End"}` as const;
              add(`print.${band}.${slot}`, words.text(key), addressOf.printSlot(band, slot), text);
            }
          }
        }
      }
      // The form's header and footer parts, by their id; listed under the form.
      if (formRoot) {
        for (const row of chromeTextRows(config)) {
          add(row.propertyPath, `“${row.partId}” · ${row.property}`, addressOf.chrome(row.partId, row.property), row.text);
        }
      }
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group) {
          visit(child);
        }
      }
    };
    visit(root);
    return texts;
  }

  /** Reads a component's committed configuration value at `propertyPath` (dot notation). */
  public getProperty(componentId: string, propertyPath: string): unknown {
    return createComponentEditorContext(this.editor, componentId).get(propertyPath);
  }

  // --- draft editing -------------------------------------------------------

  /** Creates the draft for `componentId` from its committed state, if there isn't one yet. */
  private ensureDraft(componentId: string): ComponentDraft | undefined {
    const existing = this.drafts.get(componentId);
    if (existing) {
      return existing;
    }
    const node = this.editor.componentTree().find(componentId);
    if (!node) {
      return undefined;
    }
    const draft: ComponentDraft = {
      id: node.id,
      configuration: structuredClone(node.configuration ?? {}),
      rules: node.rules ? structuredClone(node.rules) : undefined
    };
    if (componentId === this.rootId()) {
      // The root's draft also carries the definition's identity, so the Form panel's Save /
      // Cancel covers it alongside the root's own properties.
      draft.identity = this.identityValue ? { ...this.identityValue } : undefined;
    }
    this.drafts.set(componentId, draft);
    return draft;
  }

  /**
   * Whether `componentId` has edits waiting to be saved — or, with no id, whether *any*
   * component has. The panels each ask about their own subject; a host asking
   * "is anything unsaved here" means the whole builder, which is both panels and any draft
   * left open on a component neither is showing.
   */
  public hasPendingChanges(componentId?: string): boolean {
    if (componentId === undefined) {
      for (const id of this.drafts.keys()) {
        if (this.hasPendingChanges(id)) {
          return true;
        }
      }
      return false;
    }
    const draft = this.drafts.get(componentId);
    const node = this.editor.componentTree().find(componentId);
    if (!draft || !node) {
      return false;
    }
    return (
      draft.id !== node.id ||
      canonicalJson(draft.configuration ?? {}) !== canonicalJson(node.configuration ?? {}) ||
      canonicalJson(draft.rules ?? null) !== canonicalJson(node.rules ?? null) ||
      (componentId === this.rootId() &&
        JSON.stringify(draft.identity ?? null) !== JSON.stringify(this.identityValue ?? null)) ||
      (componentId === this.rootId() && this.changedRootSettings(draft).length > 0)
    );
  }

  /** The drafted {@link BuilderRootSetting} values that differ from what their owners hold now. */
  private changedRootSettings(draft: ComponentDraft): Array<{ setting: BuilderRootSetting; value: string }> {
    return [...(draft.settings?.values() ?? [])].filter((entry) => entry.value !== entry.setting.get());
  }

  /**
   * A {@link BuilderRootSetting} as the author currently sees it: the root draft's pending
   * value when one is drafted, else what its owner holds.
   */
  public draftRootSetting(setting: BuilderRootSetting): string {
    const pending = this.drafts.get(this.rootId())?.settings?.get(setting.id);
    return pending ? pending.value : setting.get();
  }

  /**
   * Buffers a value for a {@link BuilderRootSetting} on the form root's draft, so the Form
   * panel's Save and Cancel govern it with the root's own properties.
   */
  public setDraftRootSetting(setting: BuilderRootSetting, value: string): void {
    const draft = this.ensureDraft(this.rootId());
    if (!draft) {
      return;
    }
    draft.settings ??= new Map();
    draft.settings.set(setting.id, { setting, value });
    this.emitChange("edit");
  }

  /** Reads a draft configuration value, falling back to the committed one. */
  public draftProperty(componentId: string, propertyPath: string): unknown {
    const draft = this.drafts.get(componentId);
    return draft
      ? getNestedValue(draft.configuration, propertyPath)
      : this.getProperty(componentId, propertyPath);
  }

  /**
   * Buffers a configuration edit. Nothing reaches the tree until {@link commitDraft}. `live`
   * marks a write made under a control still being typed into (see {@link setDraftRules}).
   */
  public setDraftProperty(componentId: string, propertyPath: string, value: unknown, meta: { live?: boolean } = {}): void {
    assertSafePropertyPath(propertyPath);
    this.assertFitsAt(componentId, propertyPath.split(".").length, value, `The value for "${propertyPath}"`);
    const draft = this.ensureDraft(componentId);
    if (!draft) {
      return;
    }
    if (!isPlainObject(draft.configuration)) {
      draft.configuration = {};
    }
    // Back to what the form holds — the saved value, or, where the form sets nothing, what the
    // panel shows for that (the field's declared default, a blank box, an unticked switch) — is
    // no edit at all: ticking a box and unticking it again leaves nothing to apply.
    const committedNode = this.editor.componentTree().find(componentId);
    const committed = getNestedValue(committedNode?.configuration, propertyPath);
    const unchanged = committed !== undefined ? canonicalJson(value) === canonicalJson(committed) : committedNode !== undefined && this.showsAsUnset(committedNode, propertyPath, value);
    if (unchanged && committed !== undefined) {
      setNestedValue(draft.configuration as Record<string, unknown>, propertyPath, structuredClone(committed));
    } else if (
      unchanged ||
      (value === "" && UNSET_WHEN_EMPTY.has(propertyPath)) ||
      (Object.prototype.hasOwnProperty.call(UNSET_WHEN_DEFAULT, propertyPath) && value === UNSET_WHEN_DEFAULT[propertyPath]!(draft.configuration))
    ) {
      removeNestedValue(draft.configuration as Record<string, unknown>, propertyPath);
    } else {
      // A copy: the caller editing its object later never changes what Save commits.
      setNestedValue(draft.configuration as Record<string, unknown>, propertyPath, structuredClone(value));
    }
    if (propertyPath === "cssClass") {
      // Checked while typing, like a pending id — the author sees a malformed token or an
      // undeclared class the moment it is typed rather than discovering it later.
      const check = validateComponentCssClasses(value, this.cssClassNames(), this.builderWords());
      this.cssClassError = check.error;
      this.cssClassWarning = check.warning;
    }
    if (propertyPath === DATA_KEY_PROPERTY) {
      // Checked while typing too: the author learns the key clashes before Save refuses it.
      this.dataKeyError = this.checkDataKeyFor(componentId);
    }
    this.emitChange("edit", meta);
  }

  /**
   * Whether `value` is what the panel shows for `propertyPath` while the node sets nothing there:
   * its field's declared default when it has one, else a blank — nothing, an empty box, an
   * unticked switch.
   */
  private showsAsUnset(node: ComponentNode, propertyPath: string, value: unknown): boolean {
    const blank = value === undefined || value === null || value === "" || value === false;
    const field = buildInspectorModel(node, this.capabilitiesFor(node.type), this.componentEditorFor(node.type), this.locale, {})
      .sections.flatMap((section) => section.fields)
      .find((entry) => entry.propertyPath === propertyPath);
    const shown = field?.value;
    return shown === undefined || shown === null || shown === "" ? blank : canonicalJson(value) === canonicalJson(shown);
  }

  /** The rules the Rules tab is editing — draft first, then committed. */
  public draftRules(componentId: string): ComponentRules | undefined {
    const draft = this.drafts.get(componentId);
    if (draft) {
      return draft.rules ? structuredClone(draft.rules) : undefined;
    }
    const node = this.editor.componentTree().find(componentId);
    return node?.rules ? structuredClone(node.rules) : undefined;
  }

  /**
   * Buffers a whole-rules replacement. See {@link draftRules}. `live` marks a write made under
   * a formula box the author is still typing into: the change event carries `live`, so the
   * panel that made it refreshes in place and the canvas waits for the plain `edit` the panel
   * sends when the author leaves the box (the draft always holds what the box holds,
   * parseable or not; {@link problemsOf} says when it does not parse).
   */
  public setDraftRules(componentId: string, rules: ComponentRules | undefined, meta: { live?: boolean } = {}): void {
    this.assertFitsAt(componentId, 0, rules, "The rules");
    const draft = this.ensureDraft(componentId);
    if (!draft) {
      return;
    }
    draft.rules = rules && Object.keys(rules).length > 0 ? structuredClone(rules) : undefined;
    this.emitChange("edit", meta);
  }

  /** The pending id for `componentId`, which is its committed id until one is typed. */
  public draftId(componentId: string): string {
    return this.drafts.get(componentId)?.id ?? componentId;
  }

  /**
   * Buffers an id rename, validating eagerly so the author sees a clash or a malformed id
   * while typing rather than being refused at Save.
   */
  public setDraftId(componentId: string, nextIdRaw: string): void {
    const draft = this.ensureDraft(componentId);
    if (!draft) {
      return;
    }
    draft.id = nextIdRaw;
    this.idError = this.validateId(componentId, nextIdRaw);
    this.emitChange("edit");
  }

  private validateId(currentId: string, nextIdRaw: string): string | undefined {
    const nextId = nextIdRaw.trim();
    if (nextId === currentId) {
      return undefined;
    }
    if (nextId.length === 0) {
      return "ID is required.";
    }
    if (this.editor.componentTree().find(nextId)) {
      return `ID "${nextId}" already exists.`;
    }
    const claimed = this.claimedIdError(nextId);
    if (claimed) {
      return claimed;
    }
    try {
      assertValidComponentId(nextId);
    } catch (error) {
      return error instanceof Error ? error.message : this.builderWords().text("controller.idInvalid");
    }
    return this.renameDataProblem(currentId, nextId);
  }

  /**
   * Whether re-seating `currentId` under `nextId` would put its answer where another component's
   * is: a component with no data key of its own is stored under its id, so a new id moves its
   * answer. The Save's check ({@link validateId}) and {@link renameId}'s.
   */
  private renameDataProblem(currentId: string, nextId: string): string | undefined {
    return this.dataPathProblemAfter((tree) => {
      const node = tree.find(currentId);
      if (node) {
        node.id = nextId;
        followCollectionPath(node, currentId, nextId);
      }
    });
  }

  /**
   * Everything holding back a Save of `componentId`'s draft, in the order a panel lists them:
   * a pending id that cannot be used, a CSS class the renderer would drop, a data key that is
   * unusable or clashes, then what the tree's owner checks of the properties the
   * draft changes (`BuilderControllerOptions.problems`). Kept per component — the Form panel asks about the root
   * and the inspector about the selection, and neither is held back by the other's problem.
   * Empty for a component with nothing wrong, or none at all.
   */
  public problemsOf(componentId: string | undefined): BuilderProblem[] {
    if (componentId === undefined || !this.editor.componentTree().find(componentId)) {
      return [];
    }
    if (this.problemCache.revision !== this.revision) {
      this.problemCache = { revision: this.revision, byId: new Map() };
    }
    const cached = this.problemCache.byId.get(componentId);
    if (cached) {
      return cached.map((problem) => ({ ...problem }));
    }
    const problems: BuilderProblem[] = [];
    const draft = this.drafts.get(componentId);
    const idProblem = draft ? this.validateId(componentId, draft.id) : undefined;
    if (idProblem) {
      problems.push({ target: "id", message: idProblem });
    } else {
      const twins = this.twinCount(componentId);
      // A form written elsewhere can carry one id twice; it opens (Save is never refused for a
      // problem), but every edit by that id reaches the first only, so the id box
      // says so until a draft gives the twin an id of its own.
      if (twins > 1 && (draft === undefined || draft.id.trim() === componentId)) {
        problems.push({ target: "id", message: `${twins} components have the id "${componentId}"; give each an id of its own (edits by this id reach the first one only).` });
      }
    }
    const cssProblem = this.checkCssClassesFor(componentId).error;
    if (cssProblem) {
      problems.push({ target: "cssClass", message: cssProblem });
    }
    const keyProblem = this.checkDataKeyFor(componentId);
    if (keyProblem) {
      problems.push({ target: DATA_KEY_PROPERTY, message: keyProblem });
    }
    problems.push(...this.identityProblemsFor(componentId));
    problems.push(...this.rowBoundProblemsFor(componentId));
    problems.push(...this.chromeIdProblemsFor(componentId));
    problems.push(...this.pageIdProblemsFor(componentId));
    problems.push(...this.nestingProblemsFor(componentId));
    problems.push(...this.paperOnlyProblemsFor(componentId));
    for (const problem of [...this.ruleProblemsFor(componentId), ...this.hookProblemsFor(componentId)]) {
      if (!problems.some((known) => known.target === problem.target)) {
        problems.push(problem);
      }
    }
    this.problemCache.byId.set(componentId, problems);
    return problems.map((problem) => ({ ...problem }));
  }

  /** How many components of the committed tree carry `componentId` (counted once per revision). */
  private twinCount(componentId: string): number {
    let twins = this.problemCache.twins;
    if (twins === undefined) {
      twins = new Map([[this.rootId(), 1]]);
      for (const node of this.editor.componentTree().descendantsOf(this.rootId())) {
        twins.set(node.id, (twins.get(node.id) ?? 0) + 1);
      }
      this.problemCache.twins = twins;
    }
    return twins.get(componentId) ?? 0;
  }

  /**
   * {@link identityProblems} as `identity.id` / `identity.version` problems of the form root, so
   * the Save that {@link commitDraft} would refuse leads to them like every other held-back Save
   * instead of doing nothing.
   */
  private identityProblemsFor(componentId: string): BuilderProblem[] {
    if (componentId !== this.rootId()) {
      return [];
    }
    const found = this.identityProblems();
    const problems: BuilderProblem[] = [];
    if (found.id) {
      problems.push({ target: "identity.id", message: found.id });
    }
    if (found.version) {
      problems.push({ target: "identity.version", message: found.version });
    }
    return problems;
  }

  /**
   * The settings and rules of `componentId`'s draft that would nest the form past
   * {@link NESTING_MAX} where the component now sits. Each was measured where it was typed, but a
   * move since may have put the component deeper; what the draft holds unchanged moved with the
   * committed tree, which never nests past the limit, so only a changed value can be at fault.
   */
  private nestingProblemsFor(componentId: string): BuilderProblem[] {
    const draft = this.drafts.get(componentId);
    if (!draft) {
      return [];
    }
    // The component's record (three levels per ancestor, the root's at 1), then `configuration`
    // or `rules`, then the setting or rule itself.
    const holder = 3 * this.editor.componentTree().ancestorsOf(componentId).length + 2;
    const words = (what: string) => `The value for "${what}" nests more than ${NESTING_MAX} levels deep, counted from the form's root (rules, settings and components together).`;
    const problems: BuilderProblem[] = [];
    for (const [key, value] of Object.entries(isPlainObject(draft.configuration) ? draft.configuration : {})) {
      if (nestsPast(value, NESTING_MAX - holder)) {
        problems.push({ target: key, message: words(key) });
      }
    }
    for (const [key, rule] of Object.entries((draft.rules ?? {}) as Record<string, unknown>)) {
      if (nestsPast(rule, NESTING_MAX - holder)) {
        problems.push({ target: `rules:${key}`, message: words(key) });
      }
    }
    return problems;
  }

  /**
   * The words for a header or footer part id the other region (or a sibling) already uses (ids are
   * unique across both regions, since a part's translations are keyed by it).
   */
  private repeatedChromeIdMessage(id: string): string {
    return `The part id "${id}" is used twice; every header and footer part needs an id of its own, unique across both.`;
  }

  /**
   * The root's chrome as its draft holds it, when it repeats a part id the committed chrome did
   * not (the agent's writes refuse the same, `repeatedChromeIds`): a problem under the
   * chrome, so the Form panel's Save leads to it and nothing is written. An id the two regions
   * already shared is not made worse by a draft that leaves it alone.
   */
  private chromeIdProblemsFor(componentId: string): BuilderProblem[] {
    if (componentId !== this.rootId()) {
      return [];
    }
    const draft = this.drafts.get(componentId);
    const node = this.editor.componentTree().find(componentId);
    if (!draft || !node) {
      return [];
    }
    const repeated = newlyRepeatedChromeId(node.configuration, draft.configuration);
    return repeated === undefined ? [] : [{ target: "chrome", message: this.repeatedChromeIdMessage(repeated) }];
  }

  /**
   * A component set to print on paper only (`print.on: "paper"`) that holds an answer, or holds
   * a component that does: the form still shows it on screen (`paperOnlyApplies`), so the box
   * says so. Read from the draft when there is one, so choosing another value clears it at once.
   * The inspector never offers the choice here; this is for a definition written elsewhere, or
   * a component moved into a place that holds answers.
   */
  private paperOnlyProblemsFor(componentId: string): BuilderProblem[] {
    const node = this.editor.componentTree().find(componentId);
    if (!node || componentId === this.rootId()) {
      return [];
    }
    const configuration = this.drafts.get(componentId)?.configuration ?? node.configuration;
    if (readComponentPrintSettings(configuration).on !== "paper" || paperOnlyApplies(node, this.kindsOffered())) {
      return [];
    }
    return [{ target: "print.on", message: this.builderWords().text("inspector.problem.paperOnly") }];
  }

  /** A journey page id `componentId`'s draft gives that no translation could be keyed by ({@link newReservedPageId}). */
  private pageIdProblemsFor(componentId: string): BuilderProblem[] {
    const draft = this.drafts.get(componentId);
    const node = this.editor.componentTree().find(componentId);
    const reserved = draft && node ? newReservedPageId(node.configuration, draft.configuration) : undefined;
    return reserved === undefined ? [] : [{ target: "pageId", message: reservedPageIdMessage(reserved) }];
  }

  /** Throws, before any step is made, when a write would give a node a page id no translation could be keyed by. */
  private refuseReservedPageId(before: unknown, after: unknown): void {
    const reserved = newReservedPageId(before, after);
    if (reserved !== undefined) {
      throw new Error(reservedPageIdMessage(reserved));
    }
  }

  /** Throws, before any step is made, when a write to the root would repeat a part id the committed chrome did not ({@link chromeIdProblemsFor}). */
  private refuseRepeatedChromeId(componentId: string, before: unknown, after: unknown): void {
    if (componentId !== this.rootId()) {
      return;
    }
    const repeated = newlyRepeatedChromeId(before, after);
    if (repeated !== undefined) {
      throw new Error(this.repeatedChromeIdMessage(repeated));
    }
  }

  /**
   * A data grid's row bounds as its draft holds them: a bound past the cap
   * is said under its own box, and a maximum below the minimum under the maximum's. The form
   * still works with either (the grid reads a bound past the cap as the cap and a maximum below
   * the minimum as the minimum, `dataGridSettingsOf`), so this only tells the author that what
   * they typed is not what will be used. Kept to bounds the draft changes, like the tree owner's
   * own problems: a grid stored with a bad bound is not held up by it until someone edits one.
   */
  private rowBoundProblemsFor(componentId: string): BuilderProblem[] {
    const node = this.editor.componentTree().find(componentId);
    if (!node || node.type !== DATA_GRID_COMPONENT_TYPE || !this.drafts.has(componentId)) {
      return [];
    }
    const draft = this.drafts.get(componentId)!.configuration as Record<string, unknown>;
    const stored = (isPlainObject(node.configuration) ? node.configuration : {}) as Record<string, unknown>;
    const changed = (key: string): boolean => JSON.stringify(draft[key] ?? null) !== JSON.stringify(stored[key] ?? null);
    const words = this.builderWords();
    const problems: BuilderProblem[] = [];
    const past: string[] = [];
    for (const key of ["minRows", "maxRows", "initialRows"]) {
      const bound = rowBoundOf(draft[key]);
      if (bound !== undefined && bound > DATA_GRID_ROWS_CAP) {
        past.push(key);
        if (changed(key)) {
          problems.push({ target: key, message: words.text("inspector.problem.rowsCap", { max: DATA_GRID_ROWS_CAP }) });
        }
      }
    }
    const min = rowBoundOf(draft.minRows);
    const max = rowBoundOf(draft.maxRows);
    if (
      min !== undefined &&
      max !== undefined &&
      max < min &&
      !past.includes("maxRows") &&
      (changed("minRows") || changed("maxRows"))
    ) {
      problems.push({ target: "maxRows", message: words.text("inspector.problem.rowsMaxBelowMin") });
    }
    return problems;
  }

  /**
   * The rules of `componentId`'s draft whose formula does not parse, as `rules:<key>` problems:
   * the Logic tab writes every keystroke to the draft as typed, so the draft always
   * equals the box, and this is what holds its Save back. Kept to the rules the draft changes:
   * a rule stored unparseable by someone else is said under its box, never a Save problem here.
   * The parser is given the built-in functions only; a call the controller does not know is
   * left to the panel, which knows the functions the host wired, and to the compile step.
   */
  private ruleProblemsFor(componentId: string): BuilderProblem[] {
    const draft = this.drafts.get(componentId);
    const node = this.editor.componentTree().find(componentId);
    if (!draft || !node) {
      return [];
    }
    const committed = (node.rules ?? {}) as Record<string, unknown>;
    const problems: BuilderProblem[] = [];
    // A tree owner's own rule properties (see ruleTargets): the draft's value against the stored one.
    for (const path of this.ruleTargetsOption) {
      const rule = getNestedValue(draft.configuration, path);
      if (canonicalJson(rule ?? null) === canonicalJson(getNestedValue(node.configuration, path) ?? null)) {
        continue;
      }
      const text = ruleText(rule);
      if (text === undefined || text.trim() === "") {
        continue;
      }
      const parsed = kernelParseFormula(text, formulaFunctionSignatures());
      if (!parsed.ok && parsed.code !== "unknownFunction") {
        problems.push({ target: `rules:${path}`, message: formulaErrorText(parsed.code, parsed.params, this.builderWords().options()) });
      }
    }
    for (const [key, rule] of Object.entries((draft.rules ?? {}) as Record<string, unknown>)) {
      if (canonicalJson(rule ?? null) === canonicalJson(committed[key] ?? null)) {
        continue;
      }
      const text = ruleText(rule);
      if (text === undefined || text.trim() === "") {
        continue;
      }
      const parsed = kernelParseFormula(text, formulaFunctionSignatures());
      if (!parsed.ok && parsed.code !== "unknownFunction") {
        problems.push({ target: `rules:${key}`, message: formulaErrorText(parsed.code, parsed.params, this.builderWords().options()) });
      }
    }
    return problems;
  }

  /**
   * The tree owner's own problems with `componentId`'s draft (see
   * {@link BuilderControllerOptions.problems}), kept to those whose property the draft changes.
   */
  private hookProblemsFor(componentId: string): BuilderProblem[] {
    const hook = this.problemsHook;
    const draft = this.drafts.get(componentId);
    const node = this.editor.componentTree().find(componentId);
    const edited = draft ? this.editedNode(componentId) : undefined;
    if (!hook || !draft || !node || !edited) {
      return [];
    }
    const changes = (target: string): boolean =>
      target === "id"
        ? draft.id.trim() !== node.id
        : JSON.stringify(getNestedValue(draft.configuration, target) ?? null) !== JSON.stringify(getNestedValue(node.configuration, target) ?? null);
    return hook(edited, this.editor.snapshot(), componentId)
      .filter((problem) => changes(problem.target))
      .map((problem) => ({ target: problem.target, message: problem.message }));
  }

  /**
   * What the tree's owner notes about `componentId` as it is being edited (see
   * {@link BuilderControllerOptions.notes}), then what the chosen binding asks to be noted
   * (its `unwordedErrors`): advisory, so neither {@link problemsOf} nor
   * {@link commitDraft} counts it. Empty without either, or without the component.
   */
  public notesOf(componentId: string | undefined): BuilderNote[] {
    const hook = this.notesHook;
    if (componentId === undefined) {
      return [];
    }
    const edited = this.editedNode(componentId);
    if (!edited) {
      return [];
    }
    const tree = this.editor.snapshot();
    const own = hook
      ? hook(edited, tree, componentId)
          .filter((note) => note.message.trim() !== "")
          .map((note) => ({
            ...(note.target !== undefined ? { target: note.target } : {}),
            message: note.message,
            ...(note.severity !== undefined ? { severity: note.severity } : {})
          }))
      : [];
    return [
      ...own,
      ...this.unwordedErrorNotes(edited, tree, componentId),
      ...this.tabLabelNotes(edited),
      ...invertedLimitNotes(edited),
      ...(this.drawingSource !== undefined ? this.drawingNotes(this.composeInspectorModel(edited), componentId) : [])
    ];
  }

  /**
   * A tabs container's tabs with no label at all: the form shows them by place, never by id, so
   * the author is told to word them. Advisory.
   */
  private tabLabelNotes(edited: ComponentNode): BuilderNote[] {
    if (edited.type !== TABS_COMPONENT_TYPE) {
      return [];
    }
    const descriptors = readTabDescriptors(edited);
    const notes: BuilderNote[] = [];
    Object.keys(edited.children ?? {}).forEach((slotId, index) => {
      const caption = descriptors.find((tab) => tab.id === slotId)?.label;
      if (typeof caption !== "string" || caption.trim() === "") {
        notes.push({ message: this.builderWords().text("i18n.tab.noLabel", { n: index + 1 }), severity: "warning" });
      }
    });
    return notes;
  }

  /**
   * The note a binding whose `unwordedErrors` is `"noted"` asks for (GOV.UK: each error written
   * for its question): which errors the component's own checks raise that no message words —
   * its own `messages`, a pattern's own message, or a container's or the form's messages above
   * it, which apply to it too. Under the messages box; the engine's wording stands in on the
   * form meanwhile.
   */
  private unwordedErrorNotes(edited: ComponentNode, tree: ComponentNode, componentId: string): BuilderNote[] {
    if (this.chosenBindingObject()?.unwordedErrors !== "noted" || edited.type === FORM_ROOT_COMPONENT_TYPE) {
      return [];
    }
    const { children: _children, ...alone } = edited;
    const raised = validationCodesRaisedBy(alone as ComponentNode);
    if (raised.length === 0) {
      return [];
    }
    const worded = (value: unknown): boolean =>
      typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null && typeof value === "object";
    const configurationOf = (node: ComponentNode): Record<string, unknown> => (node.configuration ?? {}) as Record<string, unknown>;
    const catalogs = [edited, ...ancestorsOf(tree, componentId)].map((node) => configurationOf(node).messages);
    const authored = (code: string): boolean =>
      catalogs.some((catalog) => catalog !== null && typeof catalog === "object" && worded((catalog as Record<string, unknown>)[code])) ||
      (code === "pattern" && worded(configurationOf(edited).patternMessage));
    const unworded = raised.filter((code) => !authored(code));
    if (unworded.length === 0) {
      return [];
    }
    const names = unworded.map((code) => ENGINE_VALIDATION_CODES.find((entry) => entry.code === code)?.label ?? code);
    return [
      {
        target: "messages",
        message: `This design system asks for every error to be written for its question. This field has no message of its own for: ${names.join("; ")}. The engine's neutral wording stands in until you write one.`
      }
    ];
  }

  /** The advisory note for `componentId`'s CSS classes (a class the binding does not declare); never blocks a Save. */
  public cssClassWarningOf(componentId: string | undefined): string | undefined {
    return componentId === undefined ? undefined : this.checkCssClassesFor(componentId).warning;
  }

  /**
   * Why `componentId`'s edited data key cannot be saved — not usable, or its answer would land
   * where another component's is — or `undefined`, including while the draft leaves the key as
   * committed (see {@link dataKeyError}).
   */
  private checkDataKeyFor(componentId: string): string | undefined {
    if (!this.drafts.has(componentId)) {
      return undefined;
    }
    const edited = this.draftProperty(componentId, DATA_KEY_PROPERTY);
    const committed = this.getProperty(componentId, DATA_KEY_PROPERTY);
    const blank = (value: unknown): boolean => value === undefined || value === null || value === "";
    if (edited === committed || (blank(edited) && blank(committed))) {
      return undefined;
    }
    const problem = dataKeyProblemOf(edited);
    if (problem) {
      return problem;
    }
    return this.dataPathProblemAfter((tree) => {
      const node = tree.find(componentId);
      if (node) {
        const configuration = isPlainObject(node.configuration) ? (node.configuration as Record<string, unknown>) : {};
        node.configuration = { ...configuration, [DATA_KEY_PROPERTY]: blank(edited) ? undefined : edited };
      }
    });
  }

  /**
   * Throws, in words, when `value` would nest the form past {@link NESTING_MAX} once written
   * under `componentId`. The limit is the form's, counted from its root as Open counts it, so a
   * value is measured where it lands, not on its own: the same rule tree fits on a field near the
   * top and not on one deep in containers. `levels` is how many records stand between the
   * component's own record and the value: a setting's path segments (`configuration` and the
   * records its dots make), one for a single rule, none for the whole `rules` or `children`.
   */
  private assertFitsAt(componentId: string, levels: number, value: unknown, what: string): void {
    // A component's record sits three levels under its parent's: `children`, the slot's list, itself.
    const holder = 3 * this.editor.componentTree().ancestorsOf(componentId).length + 1 + levels;
    if (holder > NESTING_MAX || nestsPast(value, NESTING_MAX - holder)) {
      throw new Error(`${what} nests more than ${NESTING_MAX} levels deep, counted from the form's root (rules, settings and components together).`);
    }
  }

  /**
   * Whether an edit to the committed tree would give two components one place in the data, or
   * file a place under one that cannot hold it: `mutate` makes the edit on a scratch
   * copy, and the first problem it adds is returned in words. Problems the form already had are
   * not the edit's, so they never hold it up; the Data workspace lists those. A tree the edit
   * would nest past the server's depth is a problem too, unless it already was.
   */
  private dataPathProblemAfter(mutate: (tree: ComponentTree) => void): string | undefined {
    const committed = this.editor.snapshot();
    const deepBefore = nestsTooDeep(committed);
    const keyOf = (problem: DataKeyProblem): string => `${problem.code}:${problem.path}`;
    const before = new Set(findDataKeyProblems(committed).map(keyOf));
    const scratch = new ComponentTree(committed);
    try {
      mutate(scratch);
    } catch {
      // The edit itself is refused, and the real attempt reports why.
      return undefined;
    }
    const after = scratch.getRoot();
    // Past the depth the server reads: such a form would save and download, then be refused on Open.
    if (!deepBefore && nestsTooDeep(after)) {
      const limit = kernelStructureLimits().depth;
      return `Components nest more than ${limit} levels deep: the validator reads at most ${limit}.`;
    }
    // The same for what the components hold (a rule tree, settings): hosts read at most NESTING_MAX levels.
    if (nestsPast(after) && !nestsPast(committed)) {
      return FORM_TOO_DEEP;
    }
    return findDataKeyProblems(after).find(
      (problem) => problem.code !== "invalid-key" && !before.has(keyOf(problem))
    )?.message;
  }

  /**
   * The re-filing a grid needs once `nextConfiguration` is its configuration: children in a
   * column it will no longer declare move into its last column (see
   * `foldGridChildrenIntoColumns`), so reducing the count never loses a field. `undefined`
   * for any other component, or when every child already sits in a declared column.
   */
  private gridColumnFoldFor(
    componentId: string,
    nextConfiguration: unknown
  ): ReplaceChildrenCommand | undefined {
    const tree = this.editor.componentTree();
    const node = tree.find(componentId);
    if (node?.type !== GRID_COMPONENT_TYPE) {
      return undefined;
    }
    const folded = foldGridChildrenIntoColumns(
      node.children,
      gridColumnSlotIds(nextConfiguration)
    );
    return folded ? new ReplaceChildrenCommand(tree, componentId, folded) : undefined;
  }

  /**
   * Writes the draft to the tree as a single undoable edit, then clears it. Refuses — leaving
   * the draft intact so nothing is lost — when the pending id is not usable.
   */
  public commitDraft(componentId: string | undefined = this.selectedId): boolean {
    if (!componentId) {
      return false;
    }
    const draft = this.drafts.get(componentId);
    if (!draft) {
      return true;
    }
    if (!this.hasPendingChanges(componentId)) {
      // Nothing actually differs — opening a draft must not cost an undo entry.
      this.drafts.delete(componentId);
      this.idError = undefined;
      return true;
    }
    const nextId = draft.id.trim();
    const idError = this.validateId(componentId, nextId);
    if (idError) {
      this.idError = idError;
      this.emitChange("edit");
      return false;
    }
    // Only a malformed token refuses the save (same shape as a bad id — the draft stays, so
    // nothing typed is lost). An undeclared class is a warning: it commits, and the note
    // stays visible so the author knows this binding may give it no meaning.
    const cssClassCheck = this.checkCssClassesFor(componentId);
    this.cssClassError = cssClassCheck.error;
    this.cssClassWarning = cssClassCheck.warning;
    if (cssClassCheck.error) {
      this.emitChange("edit");
      return false;
    }
    const dataKeyError = this.checkDataKeyFor(componentId);
    this.dataKeyError = dataKeyError;
    if (dataKeyError) {
      this.emitChange("edit");
      return false;
    }
    // An identity the kernel would refuse on the way back in: the draft stays, the panel says which box.
    if (componentId === this.rootId() && Object.keys(this.identityProblems()).length > 0) {
      this.emitChange("edit");
      return false;
    }
    // The tree owner's own checks, on what this draft changes — this is also the
    // path of the unsaved-changes prompt's Save, which no panel stands in front of.
    if (this.hookProblemsFor(componentId).length > 0) {
      this.emitChange("edit");
      return false;
    }
    // A data grid's row bounds the form would not use as typed: refused like any
    // problem under a box, so the panel's Save and the unsaved-changes prompt's agree.
    if (this.rowBoundProblemsFor(componentId).length > 0) {
      this.emitChange("edit");
      return false;
    }
    // A rule whose formula does not parse: the draft holds the box's text as typed,
    // so saving it would store a rule the engine cannot read. The panel leads to the box.
    if (this.ruleProblemsFor(componentId).length > 0) {
      this.emitChange("edit");
      return false;
    }
    // A header or footer part id the other region already uses: a part's translations are
    // keyed by its id, so two parts could not be worded apart.
    if (this.chromeIdProblemsFor(componentId).length > 0) {
      this.emitChange("edit");
      return false;
    }
    // A page id no translation could be keyed by.
    if (this.pageIdProblemsFor(componentId).length > 0) {
      this.emitChange("edit");
      return false;
    }
    // A setting or rule that fit where it was typed, but not where a move has since put the
    // component: saved, the form could not be opened again.
    if (this.nestingProblemsFor(componentId).length > 0) {
      this.emitChange("edit");
      return false;
    }

    // The languages are not the draft's: the Languages workspace's actions and
    // `setLocalization` write them straight to the committed value, each a step of its own,
    // so a Save has none to commit and none to take translations away with.
    const isRoot = componentId === this.rootId();
    const nextConfiguration = (() => {
      const edited = this.normalizeCommitHook ? this.editedNode(componentId) : undefined;
      return (edited && this.normalizeCommitHook?.({ ...edited, configuration: draft.configuration }, this.editor.snapshot())) ?? draft.configuration;
    })();

    // An identity-only save must not spend an undo entry on an identical tree edit; the
    // command runs only when the node itself actually changed.
    const node = this.editor.componentTree().find(componentId);
    const treeChanged =
      JSON.stringify(nextConfiguration ?? {}) !== JSON.stringify(node?.configuration ?? {}) ||
      JSON.stringify(draft.rules ?? null) !== JSON.stringify(node?.rules ?? null);
    // What the edit takes from the map: the options, messages, tabs and header/footer parts it
    // deletes (the entries of a retyped option move with it).
    let translations = this.translationsValue ?? {};
    const renamedTexts: RenamedTextId[] = [];
    if (treeChanged) {
      translations = sweepConfigurationTexts(translations, componentId, isRoot, node?.configuration, nextConfiguration, renamedTexts);
    }
    const translationsStep = this.translationsCommand(this.translationsValue, translations);
    let edit: BuilderCommand | undefined;
    let moved: RenameStep | undefined;
    if (treeChanged || translationsStep) {
      const commands: BuilderCommand[] = [];
      if (treeChanged) {
        commands.push(
          new EditComponentCommand(
            this.editor.componentTree(),
            componentId,
            nextConfiguration,
            draft.rules
          )
        );
        // A grid whose column count shrank takes the orphaned columns' children with it, in
        // the same undo entry — to the author that is one edit.
        const fold = this.gridColumnFoldFor(componentId, nextConfiguration);
        if (fold) {
          commands.push(fold);
        }
      }
      // The translations the edit takes away ride the same entry: one Save, one undo, every
      // translation back.
      if (translationsStep) {
        commands.push(translationsStep);
      }
      const [first] = commands;
      edit = commands.length === 1 && first ? first : new CompositeCommand(first?.id ?? "EDIT_COMPONENT", commands);
      // Saved with a new id, the edit is the first part of the rename's entry: one Save, one Undo.
      if (nextId === componentId) {
        moved = treeChanged && movesData(node?.configuration, nextConfiguration) ? this.executeMovingData(edit) : (this.editor.execute(edit), undefined);
      }
      this.announceRenames(renamedTexts);
    }
    if (componentId === this.rootId()) {
      // The identity: a box left blank keeps what was committed, so a Save can never strip
      // the form of its id or a version.
      if (this.identityValue) {
        this.identityValue = normalizeFormIdentity(draft.identity ?? this.identityValue, {
          fallback: this.identityValue
        });
      }
    }
    // A setting something beside the tree owns goes to its owner, which reports it its own way.
    const settings = this.changedRootSettings(draft);
    this.drafts.delete(componentId);
    for (const { setting, value } of settings) {
      setting.set(value);
    }
    this.releaseHeldAction(componentId);
    if (nextId !== componentId) {
      // `renameId` re-seats the node and moves the selection; it emits its own change.
      if (!this.renameWith(componentId, nextId, edit) && edit) {
        this.editor.execute(edit);
        this.emitChange("edit");
      }
      return this.idError === undefined;
    }
    this.idError = undefined;
    if (moved) {
      moved.join(() => this.emitChange("edit"));
    } else {
      this.emitChange("edit");
    }
    return true;
  }

  /** Throws the draft away. The tree was never touched, so there is nothing to undo. */
  public discardDraft(componentId: string | undefined = this.selectedId): void {
    if (!componentId || !this.drafts.has(componentId)) {
      return;
    }
    this.drafts.delete(componentId);
    this.releaseHeldAction(componentId);
    this.idError = undefined;
    // Re-validate against what the committed tree holds, now that the draft is gone.
    this.refreshCssClassChecks();
    this.dataKeyError = undefined;
    this.emitChange("edit");
  }

  public canUndo(): boolean {
    return this.editor.canUndo();
  }

  public canRedo(): boolean {
    return this.editor.canRedo();
  }

  /**
   * The step atop the undo side of the history, as an opaque mark compared by identity:
   * `undefined` when there is nothing to undo. A history kept over more than one controller (the
   * journeys Step view's) knows each step it recorded by the mark it left, and takes a
   * step back only while its controller's mark is still that one: a step undone elsewhere, or a
   * history started over (a rebuild), is never undone blind. A part absorbed into the step
   * atop (a rename's follow-ups) leaves the mark as it was.
   */
  public undoMark(): object | undefined {
    return this.editor.undoMark();
  }

  /** The step atop the redo side of the history, as {@link undoMark} reads the undo side. */
  public redoMark(): object | undefined {
    return this.editor.redoMark();
  }

  /**
   * Ends the redo side of the history with no entry made, when it holds an entry (a mark, as
   * {@link redoMark} gives) that `holding` picks; whether it did. A step made elsewhere ends it as
   * a new step here would: a designer page's edit after the page's Undo took that edit's
   * follow-up off this history (`formSteps.followUp`). It announces nothing, the tree being as it
   * was: the caller says so to whatever shows the history (the mode's history listeners), and a
   * bar bound to this controller reads `canRedo()` afresh when it is next drawn.
   */
  public dropRedo(holding: (entry: object) => boolean): boolean {
    return this.editor.dropRedo(holding);
  }

  /**
   * The node inserted for a newly-added `type`, taken from the registered definition's
   * `createDefault()` when there is one so a component ships its own starting configuration
   * (a button's `action`, a container's slots) instead of the generic label below. The id is
   * always the controller's generated one — `createDefault()` returns a template, and its own
   * id would collide on the second add.
   */
  private newNodeForType(type: string): ComponentNode {
    const id = this.nextId(this.idPrefixHook?.(type) ?? type);
    let definition: ComponentDefinition | undefined;
    try {
      definition = this.componentRegistry?.resolve(type);
    } catch {
      definition = undefined;
    }
    if (definition?.createDefault) {
      const template = structuredClone(definition.createDefault());
      const node: ComponentNode = { ...template, id, type };
      // A template that files its rows under its own id (a data grid) files the new
      // one's under the generated id, or the second grid would share the first one's rows.
      if (node.collection?.collectionPath !== undefined && node.collection.collectionPath === template.id) {
        node.collection = { ...node.collection, collectionPath: id };
      }
      return node;
    }
    // "Untitled field", not the type shouted back ("TEXT field"): a label nobody wrote reads as one
    // nobody wrote, and the author sees at a glance what still needs a name.
    return { id, type, configuration: { label: "Untitled field" } };
  }

  private componentEditorFor(type: string): PropertyEditorDefinition | undefined {
    if (!this.componentRegistry) {
      return undefined;
    }
    try {
      return this.componentRegistry.resolve(type).propertyEditor;
    } catch {
      return undefined;
    }
  }

  private allNodeIds(): string[] {
    const tree = this.editor.componentTree();
    const root = tree.getRoot();
    return [root.id, ...tree.descendantsOf(root.id).map((node) => node.id)];
  }

  /**
   * The ids something beside the tree owns ({@link BuilderControllerOptions.claimedIds}): a
   * planner building components for this form — the Data workspace's import, a PDF template's
   * "Create form fields" — takes them as taken, as {@link insertComponents} refuses them.
   */
  public claimedIds(): string[] {
    return [...(this.claimedIdsHook?.() ?? [])];
  }

  /** Why `id` cannot be taken although no node has it: something beside the tree owns it ({@link BuilderControllerOptions.claimedIds}). */
  private claimedIdError(id: string): string | undefined {
    for (const claimed of this.claimedIdsHook?.() ?? []) {
      if (claimed === id) {
        return `ID "${id}" is already used by a page-only field of a journey.`;
      }
    }
    return undefined;
  }

  /** Every id a node, a reserved id or a claimed id holds. */
  private takenIds(): Set<string> {
    const existing = new Set(this.allNodeIds());
    for (const id of [...(this.reservedIdsHook?.() ?? []), ...(this.claimedIdsHook?.() ?? [])]) {
      existing.add(id);
    }
    return existing;
  }

  private nextId(prefix: string): string {
    const existing = this.takenIds();
    while (existing.has(`${prefix}_${this.counter}`)) {
      this.counter += 1;
    }
    const id = `${prefix}_${this.counter}`;
    this.counter += 1;
    return id;
  }

  public slotChildCount(parentId: string, slotId: string): number {
    try {
      return this.editor.componentTree().childrenOf(parentId, slotId).length;
    } catch {
      return 0;
    }
  }

  // --- mutations -------------------------------------------------------

  /**
   * The panels' path to a selection change. {@link select} switches at once — the direct
   * path for a host driving the builder — while this asks first when the selected component
   * has edits that have not been saved. The canvas previews a draft as though it were real,
   * so an author who clicks away believes the edit landed; finding it gone, or finding an
   * "Unsaved" flag on a field they left an hour ago, is exactly the surprise the draft model
   * must not spring. Returns whether the selection moved now; `false` means the prompt is up.
   */
  public requestSelect(componentId: string | undefined): boolean {
    if (componentId === this.selectedId) {
      // Re-selecting the component being edited is not leaving it.
      this.select(componentId);
      return true;
    }
    return this.holdUnlessClean("select", (follow) => this.select(componentId === undefined ? undefined : follow(componentId)));
  }

  /** {@link add} through the same guard: a new component takes the selection with it. */
  public requestAdd(type: string, parentId?: string, slotId?: string, init?: AddComponentInit): boolean {
    return this.holdUnlessClean("add", (follow) => this.add(type, parentId === undefined ? undefined : follow(parentId), slotId, init));
  }

  /**
   * Where a component goes when the caller names no parent or slot (the palette's click):
   * the tree's root, in its `content` slot when it has one, else the first of its slots that
   * takes the type, else its first slot — so a PDF document (`document`, whose slots are
   * `body`, `header`, `footer`) takes it in the body, and a PDF template (whose first slot
   * holds the PDF's own fields and takes nothing else) takes an area in its `areas` slot.
   */
  private addTarget(parentId: string | undefined, slotId: string | undefined, type?: string): { parentId: string; slotId: string } {
    const parent = parentId ?? this.editor.componentTree().rootId();
    if (slotId !== undefined) {
      return { parentId: parent, slotId };
    }
    const node = this.editor.componentTree().find(parent);
    const slots = Object.keys(node?.children ?? {});
    let target: { parentId: string; slotId: string };
    if (slots.includes("content") || slots.length === 0) {
      target = { parentId: parent, slotId: "content" };
    } else {
      const declared = node ? this.resolver?.(node.type)?.children?.slots ?? [] : [];
      const accepting =
        type === undefined
          ? undefined
          : slots.find((id) => {
              const definition = declared.find((slot) => slot.id === id);
              return !definition?.allowedTypes || definition.allowedTypes.length === 0 || definition.allowedTypes.includes(type);
            });
      target = { parentId: parent, slotId: accepting ?? slots[0]! };
    }
    if (type === undefined || !node || this.slotTakes(node, target.slotId, type)) {
      return target;
    }
    /*
     * The slot above would refuse the type, or is one its node never declares and nothing
     * reads (a journey's root declares `pages` alone, and a page `content` for its
     * questions and `routes` for its routes). The slots are chosen by what they declare
     * instead: one of this node's own that takes the type; else, for a palette click (no
     * parent named), the nearest node around the selection that has one, then the last in
     * the tree; else the slot above, whose refusal then says why.
     */
    const own = this.acceptingSlotOf(node, type);
    if (own !== undefined) {
      return { parentId: parent, slotId: own };
    }
    if (parentId === undefined) {
      const around = this.acceptingAncestor(type) ?? this.acceptingCanvasRoot(type) ?? this.lastAccepting(type);
      if (around) {
        return around;
      }
    }
    return target;
  }

  /** Whether `node`'s slot takes `type` by what the node's type declares; an undeclared slot does only when the node restricts none. */
  private slotTakes(node: ComponentNode, slotId: string, type: string): boolean {
    const declared = this.resolver?.(node.type)?.children?.slots ?? [];
    const slot = declared.find((entry) => entry.id === slotId) ?? this.resolver?.(node.type)?.otherSlots;
    if (slot) {
      return !slot.allowedTypes || slot.allowedTypes.length === 0 || slot.allowedTypes.includes(type);
    }
    return !declared.some((entry) => entry.allowedTypes && entry.allowedTypes.length > 0);
  }

  /** The first slot `node` declares for `type` by name, else the first it declares open to any type. */
  private acceptingSlotOf(node: ComponentNode, type: string): string | undefined {
    const declared = this.resolver?.(node.type)?.children?.slots ?? [];
    return (
      declared.find((slot) => slot.allowedTypes?.includes(type))?.id ??
      declared.find((slot) => !slot.allowedTypes || slot.allowedTypes.length === 0)?.id
    );
  }

  /**
   * The node the canvas draws as its root (a journey's step in the Step view, {@link BuilderControllerOptions.canvasView}),
   * when it declares a slot taking `type`: what a palette click with nothing selected adds to, rather than the last place in the tree.
   */
  private acceptingCanvasRoot(type: string): { parentId: string; slotId: string } | undefined {
    if (!this.canvasViewHook) {
      return undefined;
    }
    const node = this.editor.componentTree().find(this.canvasRootId());
    const slotId = node ? this.acceptingSlotOf(node, type) : undefined;
    return node && slotId !== undefined ? { parentId: node.id, slotId } : undefined;
  }

  /** The selection, or the nearest node above it, that declares a slot taking `type`. */
  private acceptingAncestor(type: string): { parentId: string; slotId: string } | undefined {
    const tree = this.editor.componentTree();
    let id = this.selectedId;
    while (id !== undefined) {
      const node = tree.find(id);
      if (!node) {
        return undefined;
      }
      const slotId = this.acceptingSlotOf(node, type);
      if (slotId !== undefined) {
        return { parentId: node.id, slotId };
      }
      id = tree.locate(id)?.parentId;
    }
    return undefined;
  }

  /** The last node in document order that declares a slot taking `type`. */
  private lastAccepting(type: string): { parentId: string; slotId: string } | undefined {
    let found: { parentId: string; slotId: string } | undefined;
    const visit = (node: ComponentNode): void => {
      const slotId = this.acceptingSlotOf(node, type);
      if (slotId !== undefined) {
        found = { parentId: node.id, slotId };
      }
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group) {
          visit(child);
        }
      }
    };
    visit(this.editor.componentTree().getRoot());
    return found;
  }

  /**
   * The host's path out of the builder — switching to another page, closing a dialog the
   * builder sits in — through the same guard. Leaving the builder is leaving the component
   * being edited, and the draft model must not let it go quietly there either: the author
   * who moves to the renderer to try their edit has to be told it has not been saved. `run`
   * performs the departure once the draft is dealt with; it runs at once when nothing is
   * unsaved. Returns whether it ran now.
   */
  public requestLeave(run: () => void): boolean {
    return this.holdUnlessClean("leave", run);
  }

  /**
   * Puts away the panel that edits the form root's draft (the Form panel, the Header & footer
   * panel): `run` waits behind the same prompt the inspector asks with while the root
   * has unapplied edits, and runs at once otherwise. The selection's draft is not asked about:
   * the inspector holding it stays on screen.
   */
  public requestPanelLeave(run: () => void): boolean {
    const root = this.rootId();
    if (this.hasPendingChanges(root)) {
      this.heldAction = { prompt: { componentId: root, action: "panel" }, run };
      this.emitChange("select");
      return false;
    }
    run();
    return true;
  }

  /**
   * Registers (or, with `undefined`, removes) the editor outside the tree whose unsaved edits
   * {@link requestLeave} holds for once the tree's draft is clean — see {@link LeaveGuard}.
   */
  public setLeaveGuard(guard: LeaveGuard | undefined): void {
    this.leaveGuard = guard;
  }

  /**
   * Whether the leave guard holds edits not yet written — the Logic surface's open rule, the PDF
   * designer's template mapping — that {@link requestLeave} would ask about.
   */
  public hasPendingLeaveGuard(): boolean {
    return this.guardInForce()?.pending() ?? false;
  }

  /**
   * The id a held leave would name for the guard in force (`LeaveGuardSubject.id`: the Languages
   * texts editor, the Tests panel, a template layout's mapping) — the one holding edits first when
   * guards are stacked — or `undefined` when no guard is installed. Today a page reads it only
   * from a raised prompt; the browser-assistant tools read it here to name what
   * is in the way exactly, without raising one. Pair it with {@link hasPendingLeaveGuard}: a guard
   * with nothing pending holds nothing back.
   *
   * @internal
   */
  public leaveGuardSubject(): string | undefined {
    return this.guardInForce()?.subject().id;
  }

  /**
   * Stacks a guard over the slot {@link setLeaveGuard} fills, for an editor that can be open
   * while a surface holds the slot (the Tests panel beside Logic). A leave asks the
   * stacked guards first, newest first, then the slot's; Save saves every one that holds edits
   * and stops at the first refusal. Returns the remover; `setLeaveGuard` never touches the stack.
   */
  public pushLeaveGuard(guard: LeaveGuard): () => void {
    this.stackedLeaveGuards.push(guard);
    return () => {
      const at = this.stackedLeaveGuards.indexOf(guard);
      if (at >= 0) {
        this.stackedLeaveGuards.splice(at, 1);
      }
    };
  }

  /** The slot's guard alone, or the stack and the slot asked as one. */
  private guardInForce(): LeaveGuard | undefined {
    if (this.stackedLeaveGuards.length === 0) {
      return this.leaveGuard;
    }
    const all = (): LeaveGuard[] => [...this.stackedLeaveGuards].reverse().concat(this.leaveGuard ? [this.leaveGuard] : []);
    const holding = (): LeaveGuard[] => all().filter((guard) => guard.pending());
    return {
      pending: () => holding().length > 0,
      subject: () => (holding()[0] ?? all()[0]!).subject(),
      save: () => {
        for (const guard of holding()) {
          if (!guard.save()) {
            return false;
          }
        }
        return true;
      },
      discard: () => {
        for (const guard of holding()) {
          guard.discard();
        }
      }
    };
  }

  /**
   * The guard in the slot {@link setLeaveGuard} fills (the Logic surface's while connected), the
   * stacked ones aside. A second editor stacks with {@link pushLeaveGuard} rather than chaining
   * over this one, because a surface clears the slot whole when it goes.
   */
  public leaveGuardInForce(): LeaveGuard | undefined {
    return this.leaveGuard;
  }

  /** The prompt the author must answer before the held action runs, if one is up. */
  public unsavedChangesPrompt(): UnsavedChangesPrompt | undefined {
    return this.heldAction ? { ...this.heldAction.prompt } : undefined;
  }

  /**
   * Answers the prompt. `save` commits the draft and carries on with what was held — unless
   * the save is refused (an unusable id or class), in which case nothing moves and the
   * refusal shows where it always does. A Save that gives the component a new id carries the
   * held action to it under that id: a drop into it lands there, a move of it moves it.
   * `discard` throws the draft away and carries on. `stay` drops the held action: the author
   * is where they were, draft intact. A prompt held for a leave guard's edits is settled
   * through the guard the same way.
   */
  public answerUnsavedChangesPrompt(decision: UnsavedChangesDecision): void {
    const held = this.heldAction;
    if (!held) {
      return;
    }
    this.heldAction = undefined;
    if (decision === "stay") {
      this.emitChange("select");
      return;
    }
    if (held.prompt.external) {
      const guard = this.guardInForce();
      if (decision === "discard") {
        guard?.discard();
      } else if (!guard?.save()) {
        this.emitChange("select");
        return;
      }
      this.emitChange("select");
      held.run((id) => id);
      return;
    }
    const from = held.prompt.componentId;
    const to = this.drafts.get(from)?.id.trim();
    if (decision === "discard") {
      this.discardDraft(from);
    } else if (!this.commitDraft(from)) {
      return;
    }
    // A Save that renamed the component: what the action names by its old id it now finds under the new.
    const tree = this.editor.componentTree();
    const renamed = decision === "save" && to !== undefined && to !== from && !tree.find(from) && tree.find(to) !== undefined;
    // Back through the guard: the draft is settled, but a leave may still have a leave
    // guard's edits to ask about (a second prompt); anything else runs now.
    this.holdUnlessClean(held.prompt.action, (follow) => held.run((id) => follow(renamed && id === from ? to : id)));
  }

  /**
   * Runs `run` now, or holds it behind a prompt while the selection has unsaved edits. A
   * newer held action replaces an older one: the author's latest click is the one that counts.
   */
  private holdUnlessClean(action: HeldActionKind, run: HeldRun, vanishing?: ReadonlySet<string>): boolean {
    /*
     * Which drafts count depends on where the author is going.
     *
     * Moving around the tree — selecting, adding — only risks the *selection's* draft, since
     * that is what the inspector is showing and what disappears from view. The root's draft
     * is the Form panel's, and that panel stays where it is with its own Save and Cancel on
     * screen; asking about it every time a field is clicked would be a prompt about an edit
     * the author can still see.
     *
     * Leaving the builder takes both away, so it asks about the selection and then the root.
     *
     * A draft whose component the action itself takes away (`vanishing`: deleting the selected
     * component, or a container around it) is not asked about: it goes with the component, as
     * a draft goes when Undo takes its component away.
     */
    const subjects = action === "leave" ? [this.selectedId, this.rootId()] : [this.selectedId];
    for (const subject of subjects) {
      if (subject !== undefined && !vanishing?.has(subject) && this.hasPendingChanges(subject)) {
        this.heldAction = { prompt: { componentId: subject, action }, run };
        this.emitChange("select");
        return false;
      }
    }
    // Leaving also asks a mode's own editor (see LeaveGuard); an action on the tree does not.
    const guard = action === "leave" ? this.guardInForce() : undefined;
    if (guard?.pending()) {
      const external = guard.subject();
      this.heldAction = { prompt: { componentId: external.id, action, external }, run };
      this.emitChange("select");
      return false;
    }
    this.heldAction = undefined;
    run((id) => id);
    return true;
  }

  /** Forgets a held action once the draft it was waiting on is gone. */
  private releaseHeldAction(componentId: string): void {
    if (this.heldAction?.prompt.componentId === componentId) {
      this.heldAction = undefined;
    }
  }

  public select(componentIdRaw: string | undefined): void {
    // An id the tree does not hold (a palette command captured before the component went, an
    // agent's stale id) selects nothing, rather than leave a ghost selected.
    const componentId = componentIdRaw !== undefined && this.editor.componentTree().find(componentIdRaw) === undefined ? undefined : componentIdRaw;
    // A selection that moves by other means makes the author's earlier click stale, and so is
    // a refused drop or move's reason: the canvas paints it as an alert on every change.
    this.heldAction = undefined;
    this.dropError = undefined;
    this.selectedId = componentId;
    // Drafts survive a selection change, so the id error has to follow the new selection
    // rather than simply clearing — coming back to a field with a clashing id must still say so.
    const draft = componentId ? this.drafts.get(componentId) : undefined;
    this.idError = draft ? this.validateId(componentId as string, draft.id) : undefined;
    // cssClass follows too, and is checked even without a draft: a committed class the
    // binding does not declare is worth flagging the moment the component is selected.
    this.refreshCssClassChecks();
    // The data key only while a draft changes it (see dataKeyError).
    this.dataKeyError = draft && componentId ? this.checkDataKeyFor(componentId) : undefined;
    this.emit("selection", { selectedComponentId: componentId });
    this.emitChange("select");
  }

  /**
   * Adds a component of `type` (one undo entry). `init` seeds it: an id, when the caller has a
   * meaningful one (an area's `area_3`) and nothing holds it yet, and configuration laid over
   * the type's default — a rectangle drawn on a page lands with the node rather than as a
   * second edit to undo. It lands at the end of the slot, or just before an untouched seeded
   * Submit button that closes a `content` slot, so Submit stays last (see {@link addNode}).
   */
  public add(type: string, parentId?: string, slotId?: string, init?: AddComponentInit): void {
    this.addNode(type, parentId, slotId, undefined, init);
  }

  /** {@link add} at `index` in the slot (the end when `undefined`); the new id, or `undefined` when refused. */
  private addNode(type: string, parentId: string | undefined, slotId: string | undefined, index: number | undefined, init?: AddComponentInit): string | undefined {
    const created = this.newNodeForType(type);
    const wantedId = init?.id?.trim();
    const node: ComponentNode =
      wantedId && !this.editor.componentTree().find(wantedId) && this.validateId("", wantedId) === undefined
        ? { ...created, id: wantedId }
        : created;
    // A path seeded from the template's id (a data grid's) follows the id the author chose.
    if (node !== created) {
      followCollectionPath(node, created.id, wantedId!);
    }
    if (init?.configuration) {
      node.configuration = { ...(isPlainObject(node.configuration) ? (node.configuration as Record<string, unknown>) : {}), ...structuredClone(init.configuration) };
    }
    const id = node.id;
    const target = this.addTarget(parentId, slotId, type);
    // No position named: the end of the slot, except that a `content` slot closed by the Submit
    // button File > New seeded, untouched (`isSeededSubmit`), takes the newcomer before it, so
    // that Submit stays last as fields are added. A named index, a
    // drop, a move, or a Submit the author changed or moved off the end place as before.
    const position = index ?? this.beforeSeededSubmit(target);
    const clash = this.dataPathProblemAfter((tree) => tree.insert(node, target.parentId, target.slotId, position));
    if (clash) {
      this.dropError = clash;
      this.emitChange("edit");
      return undefined;
    }
    try {
      this.editor.execute(
        new AddComponentCommand(
          this.editor.componentTree(),
          node,
          target.parentId,
          target.slotId,
          position,
          this.resolver
        )
      );
    } catch (error) {
      this.dropError = error instanceof Error ? error.message : this.builderWords().text("controller.notAllowed");
      this.emitChange("edit");
      return undefined;
    }
    this.dropError = undefined;
    this.selectedId = id;
    this.emitChange("add");
    return id;
  }

  /** The seeded Submit's index when it closes `target`'s `content` slot (see {@link addNode}); else `undefined`, the end. */
  private beforeSeededSubmit(target: { parentId: string; slotId: string }): number | undefined {
    if (target.slotId !== "content") {
      return undefined;
    }
    const group = this.editor.componentTree().find(target.parentId)?.children?.[target.slotId] ?? [];
    const last = group[group.length - 1];
    return last && isSeededSubmit(last) ? group.length - 1 : undefined;
  }

  // --- whole subtrees at once ---------------------------------------------

  /**
   * Places several whole subtrees as **one** undoable edit — a form built from a data model is
   * one thing to the author, and one Undo takes it all back. Each entry lands where
   * {@link add} would put its type unless it names a parent, a slot and an index.
   *
   * Everything is checked before anything is placed, and a refusal places nothing: every id in
   * every subtree must be usable, new and claimed by nothing beside the tree ({@link
   * BuilderControllerOptions.claimedIds}; the tree only checks a subtree's top node), every
   * child must be one its parent's slot takes, and no answer may land where another component's
   * is. A refusal sets {@link dropError}, as a refused drop does.
   */
  public insertComponents(entries: readonly InsertComponentEntry[], options: InsertComponentsOptions = {}): InsertComponentsResult {
    if (entries.length === 0) {
      return { ok: true, ids: [] };
    }
    // Measured before the copy, whose recursion a node nested thousands of levels would exhaust;
    // where each node lands is weighed after it, with the whole tree.
    if (entries.some((entry) => nestsPast(entry.node))) {
      return this.refuseInsert(FORM_TOO_DEEP);
    }
    const tree = this.editor.componentTree();
    const claimed = new Set(this.claimedIds());
    const placed = entries.map((entry) => {
      // A grid arriving with no collection binding is bound at its id before its ids and slots
      // are judged, as a load does (`normalizeRoot`).
      const node = structuredClone(normalizeDataGrids(entry.node));
      return { node, target: this.addTarget(entry.parentId, entry.slotId, node.type), index: entry.index };
    });
    const taken = new Set<string>();
    for (const { node } of placed) {
      for (const id of collectIds(node)) {
        if (!isValidComponentId(id)) {
          return this.refuseInsert(componentIdProblem(id)!);
        }
        if (taken.has(id) || tree.find(id)) {
          return this.refuseInsert(`The id "${id}" is already used.`);
        }
        if (claimed.has(id)) {
          return this.refuseInsert(this.claimedIdError(id) as string);
        }
        taken.add(id);
      }
      const slotProblem = this.subtreeSlotProblem(node);
      if (slotProblem) {
        return this.refuseInsert(slotProblem);
      }
    }
    const clash = this.dataPathProblemAfter((scratch) => {
      for (const { node, target, index } of placed) {
        scratch.insert(node, target.parentId, target.slotId, index);
      }
    });
    if (clash) {
      return this.refuseInsert(clash);
    }
    const commands: BuilderCommand[] = placed.map(
      ({ node, target, index }) => new AddComponentCommand(tree, node, target.parentId, target.slotId, index, this.resolver)
    );
    // A copy carries its translations under its new ids; a paste carries what the clipboard holds.
    let translations = this.translationsValue ?? {};
    for (const [copy, original] of Object.entries(options.copiedFrom ?? {})) {
      translations = copyTranslations(translations, "components", original, copy);
    }
    entries.forEach((entry, index) => {
      if (entry.translations) {
        translations = this.withPastedTranslations(translations, placed[index]!.node, entry.translations);
      }
    });
    const carried = this.translationsCommand(this.translationsValue, translations);
    if (carried) {
      commands.push(carried);
    }
    try {
      const [only] = commands;
      this.editor.execute(commands.length === 1 && only ? only : new CompositeCommand("ADD_COMPONENT", commands));
    } catch (error) {
      return this.refuseInsert(error instanceof Error ? error.message : this.builderWords().text("controller.notAllowedMany"));
    }
    const ids = placed.map(({ node }) => node.id);
    this.dropError = undefined;
    if ((options.select ?? "first") === "first") {
      this.selectedId = ids[0];
      this.idError = undefined;
      this.dataKeyError = undefined;
      this.refreshCssClassChecks();
    }
    this.emitChange("add");
    return { ok: true, ids };
  }

  /**
   * {@link insertComponents} through the unsaved-edits guard, as a palette click goes through
   * it. `entries` may be a function, so a plan is made against the tree as it stands when the
   * insert actually runs — after the author has saved or discarded what was held.
   */
  public requestInsertComponents(
    entries: readonly InsertComponentEntry[] | (() => readonly InsertComponentEntry[]),
    options: InsertComponentsOptions & { onResult?: (result: InsertComponentsResult) => void } = {}
  ): boolean {
    return this.holdUnlessClean("add", (follow) => {
      const planned = typeof entries === "function" ? entries() : entries.map((entry) => (entry.parentId === undefined ? entry : { ...entry, parentId: follow(entry.parentId) }));
      const result = this.insertComponents(planned, options);
      options.onResult?.(result);
    });
  }

  /**
   * Replaces what the form root's slot (`content` by default) holds with `nodes`, as **one**
   * undoable edit; the root's own settings stay. Components named in `keep` stay too, after the
   * new ones, in their order — a form's closing buttons, say. Checked like
   * {@link insertComponents}: the new ids only have to avoid what remains (the root, its other
   * slots and what is kept) and what is claimed beside the tree, so a rebuilt form may reuse the
   * ids it replaces. Drafts of the removed components go with them, a reused id's too (its draft
   * holds the old component's settings); the selection is dropped if it went too.
   */
  public replaceContent(nodes: readonly ComponentNode[], options: { slotId?: string; keep?: readonly string[] } = {}): InsertComponentsResult {
    const tree = this.editor.componentTree();
    const root = tree.getRoot();
    const slotId = options.slotId ?? "content";
    const keep = new Set(options.keep ?? []);
    // The tree's own nodes: what stays is the same node to the history, what is new is new
    // whatever its id (`ReplaceChildrenCommand`), so a rename later follows the right one.
    const live = tree.find(root.id)?.children ?? {};
    const current = live[slotId] ?? [];
    const kept = current.filter((child) => keep.has(child.id));
    // Measured before the copy, as insertComponents does.
    if (nodes.some((node) => nestsPast(node))) {
      return this.refuseInsert(FORM_TOO_DEEP);
    }
    const fresh = nodes.map((node) => structuredClone(normalizeDataGrids(node)));
    const nextChildren: Record<string, ComponentNode[]> = { ...live, [slotId]: [...fresh, ...kept] };

    const remaining = new Set<string>([root.id]);
    for (const [otherSlot, group] of Object.entries(root.children ?? {})) {
      for (const child of otherSlot === slotId ? kept : group) {
        for (const id of collectIds(child)) {
          remaining.add(id);
        }
      }
    }
    const taken = new Set<string>();
    const claimed = new Set(this.claimedIds());
    for (const node of fresh) {
      for (const id of collectIds(node)) {
        if (!isValidComponentId(id)) {
          return this.refuseInsert(componentIdProblem(id)!);
        }
        if (taken.has(id) || remaining.has(id)) {
          return this.refuseInsert(`The id "${id}" is already used.`);
        }
        if (claimed.has(id)) {
          return this.refuseInsert(this.claimedIdError(id) as string);
        }
        taken.add(id);
      }
    }
    const top = nextChildren[slotId] ?? [];
    for (let index = 0; index < top.length; index += 1) {
      const acceptance = canAcceptInSlot(root, top[index]!, slotId, index, this.resolver);
      if (!acceptance.ok) {
        return this.refuseInsert(acceptance.reason ?? this.builderWords().text("controller.notAllowed"));
      }
    }
    for (const node of fresh) {
      const slotProblem = this.subtreeSlotProblem(node);
      if (slotProblem) {
        return this.refuseInsert(slotProblem);
      }
    }
    // Checked against an empty form, not the one being replaced: what goes may clash freely.
    const clash = this.dataPathProblemAfter((scratch) => scratch.replaceChildren(root.id, nextChildren));
    if (clash) {
      return this.refuseInsert(clash);
    }

    const going = current.filter((child) => !keep.has(child.id)).flatMap((child) => collectIds(child));
    // What goes takes its translations with it, from every language and in the same undo entry; an id the new content reuses keeps them (a changed string flags them stale).
    const staying = new Set([...fresh, ...kept].flatMap((node) => collectIds(node)));
    const prune = this.pruneOwnersCommand(going.filter((id) => !staying.has(id)));
    const replacement = new ReplaceChildrenCommand(tree, root.id, nextChildren);
    this.editor.execute(prune ? new CompositeCommand("REPLACE_CONTENT", [replacement, prune]) : replacement);
    // A draft is of the node it was opened on, which is gone even when a new one reuses its id.
    for (const id of going) {
      this.drafts.delete(id);
    }
    this.heldAction = undefined;
    this.dropError = undefined;
    this.reconcileSelection();
    this.emitChange("edit");
    return { ok: true, ids: fresh.map((node) => node.id) };
  }

  /** {@link replaceContent} through the unsaved-edits guard; see {@link requestInsertComponents}. */
  public requestReplaceContent(
    nodes: readonly ComponentNode[] | (() => readonly ComponentNode[]),
    options: { slotId?: string; keep?: readonly string[]; onResult?: (result: InsertComponentsResult) => void } = {}
  ): boolean {
    return this.holdUnlessClean("replace", (follow) => {
      const result = this.replaceContent(typeof nodes === "function" ? nodes() : nodes, options.keep ? { ...options, keep: options.keep.map((id) => follow(id)) } : options);
      options.onResult?.(result);
    });
  }

  /**
   * Puts `node` in the place of the component `componentId` — its parent, its slot, its index —
   * as **one** undoable edit: a journey's question asked differently. Only what comes
   * is checked, as {@link insertComponents} checks it (its ids usable, new but for what goes,
   * claimed by nothing; its parent's slot taking it), so nothing else the tree holds — a
   * hand-written node the slots would refuse now — stands in its way. Drafts of what goes go
   * with it, and a selection inside it is put down.
   */
  public replaceComponent(componentId: string, node: ComponentNode): InsertComponentsResult {
    const tree = this.editor.componentTree();
    const location = tree.locate(componentId);
    if (location?.parentId === undefined || location.slotId === undefined || location.index === undefined) {
      return this.refuseInsert(`Component not found: ${componentId}`);
    }
    const { parentId, slotId, index } = location;
    // Measured before the copy, as insertComponents does.
    if (nestsPast(node)) {
      return this.refuseInsert(FORM_TOO_DEEP);
    }
    const fresh = structuredClone(normalizeDataGrids(node));
    const going = new Set(collectIds(location.node));
    const claimed = new Set(this.claimedIds());
    const taken = new Set<string>();
    for (const id of collectIds(fresh)) {
      if (!isValidComponentId(id)) {
        return this.refuseInsert(componentIdProblem(id)!);
      }
      if (taken.has(id) || (tree.find(id) && !going.has(id))) {
        return this.refuseInsert(`The id "${id}" is already used.`);
      }
      if (claimed.has(id)) {
        return this.refuseInsert(this.claimedIdError(id) as string);
      }
      taken.add(id);
    }
    const commands: BuilderCommand[] = [new RemoveComponentCommand(tree, componentId), new AddComponentCommand(tree, fresh, parentId, slotId, index, this.resolver)];
    const arriving = new Set(collectIds(fresh));
    const prune = this.pruneOwnersCommand([...going].filter((id) => !arriving.has(id)));
    if (prune) {
      commands.push(prune);
    }
    const problem =
      this.subtreeSlotProblem(fresh) ??
      this.dataPathProblemAfter((scratch) => {
        scratch.remove(componentId);
        scratch.insert(fresh, parentId, slotId, index);
      });
    if (problem) {
      return this.refuseInsert(problem);
    }
    try {
      this.editor.execute(new CompositeCommand("REPLACE_COMPONENT", commands));
    } catch (error) {
      return this.refuseInsert(error instanceof Error ? error.message : this.builderWords().text("controller.notAllowed"));
    }
    for (const id of going) {
      this.drafts.delete(id);
    }
    this.heldAction = undefined;
    this.dropError = undefined;
    this.reconcileSelection();
    this.emitChange("edit");
    return { ok: true, ids: [fresh.id] };
  }

  /**
   * {@link replaceComponent} through the unsaved-edits guard; `node` may be a function, planned
   * when the replacement runs (`undefined`: nothing to put there now, and nothing is done).
   */
  public requestReplaceComponent(
    componentId: string,
    node: ComponentNode | (() => ComponentNode | undefined),
    options: { onResult?: (result: InsertComponentsResult) => void } = {}
  ): boolean {
    return this.holdUnlessClean("replace", (follow) => {
      const planned = typeof node === "function" ? node() : node;
      options.onResult?.(planned ? this.replaceComponent(follow(componentId), planned) : { ok: false, ids: [] });
    });
  }

  /**
   * `map` with the translations of another form's `fragment` for the subtree `node` written in
   * (paste carries what the clipboard holds). Only languages this form declares and
   * texts `node`'s subtree words are taken. Each entry is written as the clipboard held it
   * (`writeTranslationEntry`): a current one stays current, and a stale one keeps its exact
   * `source`, so it stays flagged "Source changed" against the text it answered.
   */
  private withPastedTranslations(map: FormTranslations, node: ComponentNode, fragment: FormTranslations): FormTranslations {
    const wanted = readFormTranslations(fragment, supportedLocaleCodes(this.localizationValue));
    if (!wanted) {
      return map;
    }
    const defaults = new Map(this.textsOf(node, false, {}).map((text) => [addressKey(text.address), text.default]));
    const declared = new Set(supportedLocaleCodes(this.localizationValue));
    let next = map;
    for (const { locale, address, entry } of listTranslations(wanted)) {
      const known = address.kind === "components" ? defaults.get(addressKey(address)) : undefined;
      if (known === undefined || !declared.has(locale)) {
        continue;
      }
      next = writeTranslationEntry(next, locale, address, entry);
    }
    return next;
  }

  /**
   * The command that prunes everything under the component ids `ids` from every language (a delete prunes), or `undefined` when the map holds nothing for them. It rides the same
   * undo entry as the removal, so an Undo brings the translations back with the components.
   */
  private pruneOwnersCommand(ids: Iterable<string>): BuilderCommand | undefined {
    let next = this.translationsValue ?? {};
    for (const id of ids) {
      next = pruneTranslations(next, { kind: "components", owner: id });
    }
    return this.translationsCommand(this.translationsValue, next);
  }

  private refuseInsert(error: string): InsertComponentsResult {
    this.dropError = error;
    this.emitChange("edit");
    return { ok: false, ids: [], error };
  }

  /**
   * The first child in `node`'s subtree its parent's slot would refuse, in words; the top node's
   * place is its caller's to check. A node of the subtree, the top one included, carrying a page
   * id no translation could be keyed by is refused here too, so every insert says so.
   */
  private subtreeSlotProblem(node: ComponentNode): string | undefined {
    const reserved = newReservedPageId(undefined, node.configuration);
    if (reserved !== undefined) {
      return reservedPageIdMessage(reserved);
    }
    for (const [slotId, children] of Object.entries(node.children ?? {})) {
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!;
        const acceptance = canAcceptInSlot(node, child, slotId, index, this.resolver);
        if (!acceptance.ok) {
          return `${child.id} cannot go in ${node.id}: ${acceptance.reason ?? "not allowed there"}.`;
        }
        const deeper = this.subtreeSlotProblem(child);
        if (deeper) {
          return deeper;
        }
      }
    }
    return undefined;
  }

  /** Whether the builder can draw and edit `type`: the registry has it (always, without a registry). */
  public hasComponentType(type: string): boolean {
    return this.knowsType(type);
  }

  /** What a new `type` starts as — its registered default, or nothing without one. The caller gives it an id. */
  public componentTemplate(type: string): ComponentNode | undefined {
    try {
      const definition = this.componentRegistry?.resolve(type);
      return definition?.createDefault ? structuredClone(definition.createDefault()) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Every component type the builder can insert, or the one named, or none when it is unknown
   * (what the builder agent tools list and check a slot against). With a registry the
   * types are its definitions', in registration order; without one, the palette's. A pure read:
   * the tree, the history, the selection, the drafts and the id counter are left as they were,
   * and every answer is a copy.
   */
  public typeInfo(type?: string): readonly BuilderTypeInfo[] {
    const known = this.componentRegistry ? this.registeredTypes : this.types.map((entry) => entry.type);
    const types = type === undefined ? [...new Set(known)] : known.includes(type) ? [type] : [];
    return types.map((name) => this.typeInfoOf(name));
  }

  private typeInfoOf(type: string): BuilderTypeInfo {
    let definition: ComponentDefinition | undefined;
    try {
      definition = this.componentRegistry?.resolve(type);
    } catch {
      definition = undefined;
    }
    // newNodeForType's generic shape when the type has no default of its own.
    const template = this.componentTemplate(type) ?? { id: type, type, configuration: { label: "Untitled field" } };
    const listed = this.types.find((entry) => entry.type === type);
    const palette: ComponentPaletteEntry | undefined = listed
      ? { label: listed.label, ...(listed.group !== undefined ? { group: listed.group } : {}), ...(listed.icon !== undefined ? { icon: listed.icon } : {}) }
      : definition?.palette
        ? { ...definition.palette }
        : undefined;
    // The model is composed over a copy of the template under an id no node holds, the way a
    // new node would be, without taking an id from the counter (nextId moves it).
    const probe: ComponentNode = { ...structuredClone(template), type, id: this.unusedIdFor(type) };
    let model: InspectorModel | undefined;
    try {
      model = this.composeInspectorModel(probe);
    } catch {
      model = undefined;
    }
    return {
      type,
      template,
      slots: definition?.children?.slots ? structuredClone(definition.children.slots) : undefined,
      palette,
      fixed: false,
      model
    };
  }

  /** An id for `type` no node, reserved id or claimed id holds, read without moving the counter. */
  private unusedIdFor(type: string): string {
    const prefix = this.idPrefixHook?.(type) ?? type;
    const existing = this.takenIds();
    let n = this.counter;
    while (existing.has(`${prefix}_${n}`)) {
      n += 1;
    }
    return `${prefix}_${n}`;
  }

  /**
   * Whether the inspector offers `type` a Data key: the value-bearing types and the
   * data-scoping container do, a button or static HTML does not. A host's own type answers by
   * what its editor declares.
   */
  public offersDataKey(type: string): boolean {
    const cached = this.dataKeyOffers.get(type);
    if (cached !== undefined) {
      return cached;
    }
    const composed = composePropertyEditor(
      this.capabilitiesFor(type),
      { component: { id: "probe", type, configuration: {} } },
      this.componentEditorFor(type)
    );
    const offers = composed?.fields.some((field) => field.propertyPath === DATA_KEY_PROPERTY) ?? false;
    this.dataKeyOffers.set(type, offers);
    return offers;
  }

  /**
   * Where a component's data sits in the document the form describes (`billing.street`,
   * `items[].sku`), open drafts applied; `undefined` for one with no place of its own — a
   * grouping container, a button, the root.
   */
  public dataPathOf(componentId: string): string | undefined {
    const preview = this.previewSnapshot();
    const node = new ComponentTree(preview).find(componentId);
    if (!node || node.id === preview.id || !holdsData(node)) {
      return undefined;
    }
    return buildDataPaths(preview).get(componentId);
  }

  /** Everything wrong with where the form's answers would be stored, open drafts applied. */
  public dataKeyProblems(): DataKeyProblem[] {
    return findDataKeyProblems(this.previewSnapshot());
  }

  /** Whether the node's type is `fixed` (see `ComponentDefinition.fixed`): edited, never removed. */
  public isFixedNode(componentId: string): boolean {
    const node = this.editor.componentTree().find(componentId);
    return node !== undefined && this.isFixedType(node.type);
  }

  /** {@link isFixedType} of a node, as `moveRefusal` asks it. */
  private readonly isFixedComponent = (node: ComponentNode): boolean => this.isFixedType(node.type);

  /** Why a fixed component may not move to `target`, in the move-legality rules' words. */
  private fixedMoveReason(componentId: string, target: { parentId: string; slotId: string }): string | undefined {
    return moveRefusal(this.editor.snapshot(), componentId, target.parentId, target.slotId, this.resolver, this.isFixedComponent)?.reason;
  }

  private isFixedType(type: string): boolean {
    if (!this.componentRegistry) {
      return false;
    }
    try {
      return this.componentRegistry.resolve(type).fixed === true;
    } catch {
      return false;
    }
  }

  /**
   * What else in the form names the component or something inside it: other components'
   * rules, journey pages, PDF layouts. The delete confirmation lists them
   * ({@link dependentLines}), and {@link remove} can clear them. The journeys and layouts are
   * read through the modes' documents ({@link setOutsideDocuments}); with none lent, only the
   * rules are found. Empty for a component the form does not have.
   */
  public dependentsOf(componentId: string): Dependent[] {
    return this.editor.componentTree().find(componentId) ? dependentsOf(this.dependentsSource(), componentId) : [];
  }

  /** The tree and the modes' blocks, as {@link dependentsOf} reads them. */
  private dependentsSource(): DependentsSource {
    const documents = this.outsideDocuments?.() ?? [];
    return {
      root: this.editor.snapshot(),
      journey: documents.find((document) => document.id === "journeys")?.read() as DependentsSource["journey"],
      pdf: documents.find((document) => document.id === "pdf")?.read() as DependentsSource["pdf"]
    };
  }

  /**
   * The commands that clear what names `componentId`: the rules of other components, and the
   * journeys' and layouts' blocks through the modes' documents (the same seam a language change
   * rewrites them by, so an Undo carries just this change back onto what the author did there since).
   */
  private referenceClearing(componentId: string): BuilderCommand[] {
    const cleared = withoutDependents(this.dependentsSource(), componentId);
    const tree = this.editor.componentTree();
    const commands: BuilderCommand[] = cleared.rules.map((entry) => new SetRulesCommand(tree, entry.componentId, entry.rules));
    const outside = this.outsideCommand((document, value) =>
      document.id === "journeys" && cleared.journey !== undefined ? cleared.journey : document.id === "pdf" && cleared.pdf !== undefined ? cleared.pdf : value
    );
    if (outside) {
      commands.push(outside);
    }
    return commands;
  }

  /**
   * Removes the component and its subtree (one undo entry). With `removeReferences` the
   * references to it go in the same entry — rules that read it, journey questions and conditions,
   * PDF bindings ({@link withoutDependents}) — so one Undo brings back the component and
   * everything that named it. Without it they stay, and show as missing where the builder
   * already says so (a rule's field gone, a journey page's question, a PDF field's source).
   */
  public remove(componentId: string, options: { removeReferences?: boolean } = {}): void {
    if (this.isFixedNode(componentId)) {
      throw new Error(`Component "${componentId}" cannot be removed`);
    }
    // Only a host can remove anything while the prompt is up (the panel is covered), and
    // what the author was about to do may no longer make sense afterwards.
    this.heldAction = undefined;
    const removed = this.editor.componentTree().find(componentId);
    // What the subtree's fields are called in their rows, before they go: an open draft's rules read them by key.
    const taken = removed ? removalOf(this.editor.componentTree().getRoot(), componentId) : undefined;
    const removal = new RemoveComponentCommand(this.editor.componentTree(), componentId);
    const references = options.removeReferences && removed ? this.referenceClearing(componentId) : [];
    // The references first and the removal last: an Undo puts the component back before it
    // puts the rules and blocks that name it back. Its translations go in the same entry, from
    // every language (delete prunes), and come back with it.
    const prune = removed ? this.pruneOwnersCommand(collectIds(removed)) : undefined;
    const steps = [...references, ...(prune ? [prune] : []), removal];
    this.editor.execute(steps.length > 1 ? new CompositeCommand("REMOVE_COMPONENT", steps) : removal);
    if (options.removeReferences && removed && taken) {
      // A rule an open draft holds would write the reference back at its Save, whether or not
      // the committed tree had one to clear.
      for (const [id, draft] of this.drafts) {
        if (isPlainObject(draft.rules)) {
          draft.rules = rulesWithout(draft.rules as ComponentRules, taken.ids, rowKeysOf(taken, id));
        }
      }
    }
    // A draft for a component that no longer exists would be committed onto nothing, so it
    // goes with the subtree it belonged to.
    this.drafts.delete(componentId);
    if (removed) {
      for (const node of collectIds(removed)) {
        this.drafts.delete(node);
      }
    }
    // The selection goes with the subtree: the removed component, or one inside it (a button in
    // a group, a field in a panel) — the inspector would otherwise read a component that is gone.
    if (this.selectedId !== undefined && (this.selectedId === componentId || !this.editor.componentTree().find(this.selectedId))) {
      this.selectedId = undefined;
      this.idError = undefined;
      this.cssClassError = undefined;
      this.cssClassWarning = undefined;
      this.dataKeyError = undefined;
    }
    this.emitChange("remove");
  }

  /**
   * Removes several components as **one** undoable edit — a journey's questions whose component
   * the form no longer has. Ids not in the tree, fixed ones, the root, and ones inside
   * another listed component (which goes with it) are passed over. Drafts go with what they
   * belonged to, and a selection inside what went is dropped. Returns the ids removed, in the
   * order given; nothing removed is no edit and no change.
   */
  public removeComponents(componentIds: readonly string[]): string[] {
    const tree = this.editor.componentTree();
    const rootId = this.rootId();
    // What can go: the root, a fixed node or an id not in the tree never does, and so takes
    // nothing along with it either.
    const listed = new Set(componentIds.filter((id) => id !== rootId && tree.find(id) !== undefined && !this.isFixedNode(id)));
    const within = (id: string): boolean => {
      // Whether an ancestor of `id` is listed too, and so takes it along.
      let parentId = tree.locate(id)?.parentId;
      while (parentId !== undefined) {
        if (listed.has(parentId)) {
          return true;
        }
        parentId = tree.locate(parentId)?.parentId;
      }
      return false;
    };
    const ids = [...listed].filter((id) => !within(id));
    if (ids.length === 0) {
      return [];
    }
    this.heldAction = undefined;
    const gone = new Set(ids.flatMap((id) => collectIds(tree.find(id)!)));
    const commands: BuilderCommand[] = ids.map((id) => new RemoveComponentCommand(tree, id));
    const prune = this.pruneOwnersCommand(gone);
    if (prune) {
      commands.push(prune);
    }
    const [only] = commands;
    this.editor.execute(commands.length === 1 && only ? only : new CompositeCommand("REMOVE_COMPONENT", commands));
    for (const id of gone) {
      this.drafts.delete(id);
    }
    if (this.selectedId !== undefined && gone.has(this.selectedId)) {
      this.selectedId = undefined;
      this.idError = undefined;
      this.cssClassError = undefined;
      this.cssClassWarning = undefined;
      this.dataKeyError = undefined;
    }
    this.emitChange("remove");
    return ids;
  }

  /**
   * {@link removeComponents} through the unsaved-edits guard, as a palette click goes through
   * it. `componentIds` may be a function, so what goes is decided against the tree as it stands
   * when the removal actually runs — after the author has saved or discarded what was held.
   *
   * Listed ids are known up front, so a draft of what they take away (the selected component
   * deleted from the canvas, or one inside a deleted container) is not asked about: it goes
   * with its component. Only a draft of something that stays holds the removal.
   * `removeReferences` removes each listed component with what names it, as {@link remove}
   * does with the option (one undo entry per component).
   */
  public requestRemoveComponents(
    componentIds: readonly string[] | (() => readonly string[]),
    options: { onResult?: (removed: string[]) => void; removeReferences?: boolean } = {}
  ): boolean {
    let vanishing: Set<string> | undefined;
    if (typeof componentIds !== "function") {
      const tree = this.editor.componentTree();
      vanishing = new Set(
        componentIds.flatMap((id) => {
          const node = id === this.rootId() || this.isFixedNode(id) ? undefined : tree.find(id);
          return node ? collectIds(node) : [];
        })
      );
    }
    return this.holdUnlessClean(
      "remove",
      (follow) => {
        const ids = typeof componentIds === "function" ? componentIds() : componentIds.map((id) => follow(id));
        const removed = options.removeReferences ? this.removeEachWithReferences(ids) : this.removeComponents(ids);
        options.onResult?.(removed);
      },
      vanishing
    );
  }

  /** {@link remove} with `removeReferences` for each of `componentIds` the tree can give up; the ids removed. */
  private removeEachWithReferences(componentIds: readonly string[]): string[] {
    const removed: string[] = [];
    for (const id of componentIds) {
      if (id !== this.rootId() && !this.isFixedNode(id) && this.editor.componentTree().find(id)) {
        this.remove(id, { removeReferences: true });
        removed.push(id);
      }
    }
    return removed;
  }

  // --- structure: move, duplicate, add after (the selection's actions) ------------------

  /** Where `componentId` sits: its parent, the slot and its index there; `undefined` for the root or an id not in the tree. */
  public parentOf(componentId: string): { parentId: string; slotId: string; index: number } | undefined {
    const location = this.editor.componentTree().locate(componentId);
    if (!location || location.parentId === undefined || location.slotId === undefined || location.index === undefined) {
      return undefined;
    }
    return { parentId: location.parentId, slotId: location.slotId, index: location.index };
  }

  /**
   * Moves a component to `target` as one undo entry, by the path a canvas drop of it takes —
   * the same slot constraints and data-place checks — and keeps it selected.
   *
   * `target.index` is a gap among the target slot's children as they stand **before** the
   * move, as a drop's is: in `[a, b, c]`, moving `a` to index 2 puts it between `b` and `c`
   * (`[b, a, c]`); index 3 puts it last. Returns `false`, changing nothing, when the move is
   * refused — the root, a fixed node (see {@link isFixedNode}; {@link dropError} says why, as
   * for a drop of it), an id or parent not in the tree, an index outside `0..length`, a slot
   * that does not take it (which sets {@link dropError}) — and when the component is already there.
   */
  public move(componentId: string, target: { parentId: string; slotId: string; index: number }): boolean {
    const tree = this.editor.componentTree();
    if (this.parentOf(componentId) && this.isFixedNode(componentId)) {
      // Worded as a drop of it is: the caller already learns `false`, so no change is announced.
      this.dropError = this.fixedMoveReason(componentId, target);
      return false;
    }
    if (!this.parentOf(componentId) || !tree.find(target.parentId)) {
      return false;
    }
    const count = this.slotChildCount(target.parentId, target.slotId);
    if (!Number.isInteger(target.index) || target.index < 0 || target.index > count || this.isOwnPlace(componentId, target)) {
      return false;
    }
    return this.performDrop({
      kind: "move-existing",
      componentId,
      target: { parentId: target.parentId, slotId: target.slotId, index: this.moveIndexAfterRemoval(componentId, target) }
    });
  }

  /**
   * Moves a component one place up (`-1`) or down (`1`) within its own slot, past its
   * neighbour, as {@link move} does. `false` at either end of the slot, or when refused.
   */
  public moveBy(componentId: string, delta: -1 | 1): boolean {
    const place = this.parentOf(componentId);
    // A fixed node has no place to step to, as the selection bar's disabled Up and Down say;
    // the keyboard and the command palette reach here too and must not word a refusal for it.
    if (!place || this.isFixedNode(componentId)) {
      return false;
    }
    const neighbour = place.index + delta;
    if (neighbour < 0 || neighbour >= this.slotChildCount(place.parentId, place.slotId)) {
      return false;
    }
    // A gap as the slot stands: before the previous sibling, or after the next one.
    return this.move(componentId, { parentId: place.parentId, slotId: place.slotId, index: delta < 0 ? neighbour : neighbour + 1 });
  }

  /**
   * Every slot `componentId` may move to, its own included, in the canvas's reading
   * order: the tree's root first, then each container depth first. Legal by the rules a drop
   * meets (`moveRefusal`), less a slot where the move would give two components one place in
   * the data. Empty for the root, a fixed node or an id not in the tree.
   */
  public moveTargets(componentId: string): BuilderMoveTarget[] {
    const root = this.editor.snapshot();
    const place = this.parentOf(componentId);
    if (!place || this.isFixedNode(componentId)) {
      return [];
    }
    const view = buildNestedTreeView(root, this.resolver, this.locale, this.nodeLabeler, this.labelSources());
    const targets: BuilderMoveTarget[] = [];
    const visit = (container: NestedTreeNodeView): void => {
      if (container.id === componentId) {
        // Nothing inside the moving component is a place for it.
        return;
      }
      const open = container.slots.filter((slot) => this.moveAllowed(root, componentId, container.id, slot.slotId));
      const tabs = container.type === TABS_COMPONENT_TYPE ? readTabDescriptors(container.node) : [];
      for (const slot of open) {
        const own = place.parentId === container.id && place.slotId === slot.slotId;
        const tab = tabs.find((entry) => entry.id === slot.slotId)?.label;
        const pageId = isPlainObject(container.node.configuration) ? (container.node.configuration as { pageId?: unknown }).pageId : undefined;
        targets.push({
          parentId: container.id,
          slotId: slot.slotId,
          ...(typeof pageId === "string" && pageId.trim() !== "" ? { pageId } : {}),
          label: container.label,
          ...(open.length > 1 ? { slotLabel: (typeof tab === "string" && tab !== "" ? resolveText(tab, tabLabelAddress(container.id, slot.slotId), this.locale, { translations: this.translationsValue, catalog: this.translationCatalog() }) : "") || slot.slotId } : {}),
          depth: container.depth,
          siblings: slot.children.filter((child) => child.id !== componentId).map((child) => ({ id: child.id, label: child.label })),
          ...(own ? { current: place.index } : {})
        });
      }
      for (const slot of container.slots) {
        for (const child of slot.children) {
          visit(child);
        }
      }
    };
    visit(view);
    return targets;
  }

  /** Whether `componentId` may move into `parentId`'s `slotId`: a drop's rules, then the data places. */
  private moveAllowed(root: ComponentNode, componentId: string, parentId: string, slotId: string): boolean {
    if (moveRefusal(root, componentId, parentId, slotId, this.resolver, this.isFixedComponent)) {
      return false;
    }
    const own = this.parentOf(componentId);
    if (own?.parentId === parentId) {
      // The same parent keeps the same data place.
      return true;
    }
    return this.dataPathProblemAfter((tree) => tree.move(componentId, parentId, slotId, 0)) === undefined;
  }

  /**
   * Moves `componentId` into `container` at `index`: the position it ends at among
   * the slot's other components, 0 first and their count last. `container` is a component id,
   * or a journey page's `pageId` when no component has that id (the page's node id is
   * internal). Without `slotId`, the container's first slot that takes it. As {@link move}: one
   * undo entry by a drop's path, the component keeps its id, configuration, rules and data
   * binding and stays selected; only its parent and place change. `false`, changing nothing,
   * when the move is refused ({@link moveTargets} does not list the slot, or `index` is outside
   * `0..count`) or the component is already there.
   */
  public moveTo(componentId: string, container: string, index: number, slotId?: string): boolean {
    return this.moveToResult(componentId, container, index, slotId).moved;
  }

  /**
   * {@link moveTo}, saying what the move left behind: `leftEmpty` names the container it came
   * out of when that holds nothing now — a journey page by its `pageId` once its
   * questions slot is empty, its routes aside; any other container by its component id once
   * every slot of it is empty. The tree's root is never named, nor a container the component
   * moved within. The caller warns; nothing is refused for it.
   */
  public moveToResult(componentId: string, container: string, index: number, slotId?: string): BuilderMoveToResult {
    const parentId = this.moveContainerId(container);
    const targets = this.moveTargets(componentId).filter((target) => target.parentId === parentId && (slotId === undefined || target.slotId === slotId));
    const target = targets[0];
    if (!target || !Number.isInteger(index) || index < 0 || index > target.siblings.length || target.current === index) {
      return { moved: false, leftEmpty: [] };
    }
    const from = this.parentOf(componentId);
    // From a final position to a gap among the slot's children as they stand (see `move`).
    const gap = target.current !== undefined && index > target.current ? index + 1 : index;
    if (!this.move(componentId, { parentId: target.parentId, slotId: target.slotId, index: gap })) {
      return { moved: false, leftEmpty: [] };
    }
    const tree = this.editor.componentTree();
    const source = from && from.parentId !== tree.rootId() && from.parentId !== target.parentId ? tree.find(from.parentId) : undefined;
    if (!source) {
      return { moved: true, leftEmpty: [] };
    }
    const pageId = isPlainObject(source.configuration) ? (source.configuration as { pageId?: unknown }).pageId : undefined;
    const isPage = typeof pageId === "string" && pageId.trim() !== "";
    const emptied = isPage
      ? (source.children?.[from!.slotId]?.length ?? 0) === 0
      : Object.values(source.children ?? {}).every((group) => group.length === 0);
    return { moved: true, leftEmpty: emptied ? [isPage ? (pageId as string) : source.id] : [] };
  }

  /**
   * {@link moveTo} through the unsaved-edits guard, as {@link requestMoveBy}. Whether it ran now.
   * `after` hears whether it moved, and the {@link moveToResult} (what it left empty).
   */
  public requestMoveTo(
    componentId: string,
    container: string,
    index: number,
    slotId?: string,
    after?: (moved: boolean, result: BuilderMoveToResult) => void
  ): boolean {
    // `after` runs when the move does, now or once the prompt's Save or Apply lets it through.
    return this.holdUnlessClean("drop", (follow) => {
      const result = this.moveToResult(follow(componentId), follow(container), index, slotId);
      after?.(result.moved, result);
    });
  }

  /** A container named by its component id, else by a journey page's `pageId` naming exactly one node. */
  private moveContainerId(container: string): string {
    const tree = this.editor.componentTree();
    if (tree.find(container)) {
      return container;
    }
    const named = collectNodes(tree.getRoot()).filter(
      (node) => isPlainObject(node.configuration) && (node.configuration as { pageId?: unknown }).pageId === container
    );
    return named.length === 1 ? named[0]!.id : container;
  }

  /**
   * Copies a component and everything in it, placing the copy right after it in the same slot
   * as one undo entry, and selects the copy. Returns the copy's id; `undefined` when refused —
   * the root, an id not in the tree, a fixed node or a subtree holding one, a slot with no room
   * (which sets {@link dropError}, as {@link insertComponents} does).
   *
   * - **Ids:** every id in the copy is new, numbered after its original's (`email` → `email_2`,
   *   `text_3` → `text_4`, the next free number).
   * - **Data:** the copy would store its answer where the original does, so the
   *   data key is dropped from the copy and from every copied node in the same data scope —
   *   the place then falls back to the new id. Nodes under a copied data-scoping container or
   *   repeating section keep their keys: the container's place is new, so theirs are too. A
   *   copied repeating section's `collectionPath` is dropped the same way (a collection path is
   *   not prefixed by anything above it), and its `itemFields` name the copied fields. A
   *   copy that would still share a place is refused.
   * - **Rules:** a rule in the copy that reads a component inside the copied subtree reads
   *   that component's copy; one that reads a component outside it is unchanged.
   */
  public duplicate(componentId: string): string | undefined {
    const place = this.parentOf(componentId);
    const original = this.editor.componentTree().find(componentId);
    if (!place || !original || collectNodes(original).some((node) => this.isFixedType(node.type))) {
      return undefined;
    }
    const copied = this.copyOf(original);
    if (!copied) {
      return undefined;
    }
    // The copy's translations ride the insert (duplicate copies): under its new ids, the original's untouched.
    const copiedFrom = Object.fromEntries([...copied.renames].map(([from, to]) => [to, from]));
    const result = this.insertComponents([{ node: copied.node, parentId: place.parentId, slotId: place.slotId, index: place.index + 1 }], { copiedFrom });
    return result.ok ? result.ids[0] : undefined;
  }

  /** {@link duplicate}'s copy of `original`: new ids, keys out of the original's place, rules re-pointed; with the old id → new id pairs. `undefined` when no id can be found. */
  private copyOf(original: ComponentNode): { node: ComponentNode; renames: ReadonlyMap<string, string> } | undefined {
    const taken = new Set([...this.allNodeIds(), ...(this.reservedIdsHook?.() ?? []), ...(this.claimedIdsHook?.() ?? [])]);
    const renames = new Map<string, string>();
    for (const node of collectNodes(original)) {
      const match = /^(.*?)_(\d+)$/.exec(node.id);
      const base = match?.[1] || node.id;
      let n = match ? Number(match[2]) + 1 : 2;
      while (taken.has(`${base}_${n}`)) {
        n += 1;
      }
      const id = `${base}_${n}`;
      if (!isValidComponentId(id)) {
        return undefined;
      }
      taken.add(id);
      renames.set(node.id, id);
    }
    const copy = structuredClone(original);
    const visit = (node: ComponentNode, sameScope: boolean): void => {
      node.id = renames.get(node.id) ?? node.id;
      const configuration = isPlainObject(node.configuration) ? (node.configuration as Record<string, unknown>) : undefined;
      if (sameScope && configuration && DATA_KEY_PROPERTY in configuration) {
        delete configuration[DATA_KEY_PROPERTY];
      }
      if (node.collection) {
        delete node.collection.collectionPath;
        // The row's fields are named by id: the copied section's rows hold the copies.
        if (node.collection.itemFields) {
          node.collection.itemFields = node.collection.itemFields.map((id) => renames.get(id) ?? id);
        }
      }
      if (node.rules) {
        node.rules = repointRulePaths(node.rules, renames);
      }
      // Below a data-scoping container or a repeating section, places hang off its new one.
      const childScope = sameScope && !isDataScopeContainer(node) && node.collection === undefined;
      for (const group of Object.values(node.children ?? {})) {
        for (const child of group) {
          visit(child, childScope);
        }
      }
    };
    visit(copy, true);
    return { node: copy, renames };
  }

  /**
   * Adds a component of `type` right after `afterId` in `afterId`'s slot when that slot takes
   * it (its types and its room); otherwise — no `afterId`, the root, an id not in the tree, a
   * slot that refuses — where {@link add} would put it. One undo entry; the new component is
   * selected. Returns its id, or `undefined` when refused (which sets {@link dropError}).
   */
  public addAfter(type: string, afterId?: string, init?: AddComponentInit): string | undefined {
    const place = afterId === undefined ? undefined : this.parentOf(afterId);
    const tree = this.editor.componentTree();
    const parent = place ? tree.find(place.parentId) : undefined;
    if (place && parent) {
      const fits = canAcceptInSlot(parent, { id: "probe", type, configuration: {} }, place.slotId, this.slotChildCount(place.parentId, place.slotId), this.resolver);
      if (fits.ok && this.slotTakes(parent, place.slotId, type)) {
        return this.addNode(type, place.parentId, place.slotId, place.index + 1, init);
      }
    }
    return this.addNode(type, undefined, undefined, undefined, init);
  }

  /** {@link move} through the unsaved-edits guard, as a drop goes through it. Whether it ran now. */
  public requestMove(componentId: string, target: { parentId: string; slotId: string; index: number }): boolean {
    return this.holdUnlessClean("drop", (follow) => this.move(follow(componentId), { ...target, parentId: follow(target.parentId) }));
  }

  /** {@link moveBy} through the unsaved-edits guard. Whether it ran now. */
  public requestMoveBy(componentId: string, delta: -1 | 1): boolean {
    return this.holdUnlessClean("drop", (follow) => this.moveBy(follow(componentId), delta));
  }

  /** {@link duplicate} through the unsaved-edits guard: the copy takes the selection, as an add does. Whether it ran now. */
  public requestDuplicate(componentId: string): boolean {
    return this.holdUnlessClean("add", (follow) => this.duplicate(follow(componentId)));
  }

  /** {@link addAfter} through the unsaved-edits guard, as {@link requestAdd}. Whether it ran now. */
  public requestAddAfter(type: string, afterId?: string, init?: AddComponentInit): boolean {
    return this.holdUnlessClean("add", (follow) => this.addAfter(type, afterId === undefined ? undefined : follow(afterId), init));
  }

  /**
   * Writes rules straight to the tree (one undo entry). The Rules tab goes through
   * {@link setDraftRules} instead; this is the direct path for a host driving the builder.
   */
  public setRules(componentId: string, rules: ComponentRules | undefined): void {
    this.assertFitsAt(componentId, 0, rules, "The rules");
    this.editor.setRules(componentId, rules);
    // An open draft is kept in step, as {@link setProperty} keeps it: its Save would otherwise
    // write the rules it was opened over straight back.
    const draft = this.drafts.get(componentId);
    if (draft) {
      draft.rules = rules && Object.keys(rules).length > 0 ? structuredClone(rules) : undefined;
    }
    this.emitChange("edit");
  }

  /**
   * Writes a configuration value straight to the tree (one undo entry per call). The
   * properties panel goes through {@link setDraftProperty} instead; this stays the direct path
   * for a host driving the builder programmatically. An open draft is kept in step so the
   * canvas preview does not fall behind the tree.
   */
  public setProperty(componentId: string, propertyPath: string, value: unknown): void {
    assertSafePropertyPath(propertyPath);
    const tree = this.editor.componentTree();
    const node = tree.find(componentId);
    if (!node) {
      throw new Error(`Component not found: ${componentId}`);
    }
    this.assertFitsAt(componentId, propertyPath.split(".").length, value, `The value for "${propertyPath}"`);
    const set = new SetPropertyCommand(tree, componentId, propertyPath, value);
    // What the configuration will be once `set` runs — a grid's column fold is decided from
    // it, and joins the same undo entry (see commitDraft).
    const nextConfiguration: Record<string, unknown> = isPlainObject(node.configuration)
      ? structuredClone(node.configuration)
      : {};
    setNestedValue(nextConfiguration, propertyPath, value);
    this.refuseRepeatedChromeId(componentId, node.configuration, nextConfiguration);
    this.refuseReservedPageId(node.configuration, nextConfiguration);
    const fold = this.gridColumnFoldFor(componentId, nextConfiguration);
    // An option, message, tab or part this write deletes takes its translations with it, in the same entry.
    const renamedTexts: RenamedTextId[] = [];
    const swept = this.translationsCommand(
      this.translationsValue,
      sweepConfigurationTexts(this.translationsValue ?? {}, componentId, componentId === this.rootId(), node.configuration, nextConfiguration, renamedTexts)
    );
    const steps: BuilderCommand[] = [set, ...(fold ? [fold] : []), ...(swept ? [swept] : [])];
    const command = steps.length > 1 ? new CompositeCommand(set.id, steps) : set;
    // A key that moves where answers are stored takes what reads them by path along, in one step.
    const moved = movesData(node.configuration, nextConfiguration) ? this.executeMovingData(command) : (this.editor.execute(command), undefined);
    this.announceRenames(renamedTexts);
    const draft = this.drafts.get(componentId);
    if (draft) {
      if (!isPlainObject(draft.configuration)) {
        draft.configuration = {};
      }
      setNestedValue(draft.configuration as Record<string, unknown>, propertyPath, structuredClone(value));
    }
    this.idError = undefined;
    this.refreshCssClassChecks();
    // Heard inside the step a move of data opened, so a follow-up made as it is heard joins it.
    if (moved) {
      moved.join(() => this.emitChange("edit"));
    } else {
      this.emitChange("edit");
    }
  }

  /**
   * Writes a configuration value straight to the tree **without** an undo entry, the open draft
   * kept in step as {@link setProperty} keeps it. For a value a catalog owns and mirrors into
   * the tree, whose changes are not the tree's to undo: a journey renamed from the documents
   * menu, so the author's next Undo takes back their own last edit.
   */
  public setPropertyUnrecorded(componentId: string, propertyPath: string, value: unknown): void {
    assertSafePropertyPath(propertyPath);
    const tree = this.editor.componentTree();
    const node = tree.find(componentId);
    if (!node) {
      throw new Error(`Component not found: ${componentId}`);
    }
    this.assertFitsAt(componentId, propertyPath.split(".").length, value, `The value for "${propertyPath}"`);
    const nextConfiguration: Record<string, unknown> = isPlainObject(node.configuration) ? structuredClone(node.configuration) : {};
    setNestedValue(nextConfiguration, propertyPath, value);
    this.refuseReservedPageId(node.configuration, nextConfiguration);
    this.editor.executeUnrecorded(new SetPropertyCommand(tree, componentId, propertyPath, value));
    const draft = this.drafts.get(componentId);
    if (draft) {
      if (!isPlainObject(draft.configuration)) {
        draft.configuration = {};
      }
      setNestedValue(draft.configuration as Record<string, unknown>, propertyPath, value);
    }
    this.emitChange("edit");
  }

  /**
   * Writes several configuration values straight to the tree as **one** undo entry: the PDF
   * designer filling every field of a template at once, say. Each is written as
   * {@link setProperty} writes it, in order, and a grid's column fold joins the same entry.
   * An edit with `target: "rules"` sets the node's rule `propertyPath` (a key of its `rules`;
   * `undefined` removes it) in the same entry instead — a journey following a rename into the
   * rules of a presentation's own nodes; one with `target: "children"` puts `value`
   * as the node's whole children map, unchecked — a journey following a rename into nodes that
   * share an id, which no edit by id reaches. Every id is checked first, so an unknown one
   * throws before anything is written. The translations of an option, message, tab or header
   * or footer part an edit deletes go in the same entry. Translations are written
   * with {@link setTranslations}, never here. `unrecorded` writes them with no entry at all, as
   * {@link setPropertyUnrecorded} does: a journey's tree following a form rename, which the form's
   * step re-derives on its Undo and Redo.
   */
  public setProperties(
    edits: ReadonlyArray<{ componentId: string; propertyPath: string; value: unknown; target?: "rules" | "children" | undefined }>,
    options: { unrecorded?: boolean } = {}
  ): void {
    if (edits.length === 0) {
      return;
    }
    // Every path first: a refused one leaves no half of the batch written and no empty entry.
    for (const edit of edits) {
      // An unknown id is named as such, before its value is measured against a place it has not.
      if (!this.editor.componentTree().find(edit.componentId)) {
        throw new Error(`Component not found: ${edit.componentId}`);
      }
      // A rule sits one level under `rules`, a children map is the node's own `children`, a
      // setting as deep under `configuration` as its path goes.
      const levels = edit.target === "rules" ? 1 : edit.target === "children" ? 0 : edit.propertyPath.split(".").length;
      this.assertFitsAt(edit.componentId, levels, edit.value, `The value for "${edit.propertyPath}"`);
      if (edit.target === "rules") {
        if (isPrototypeName(edit.propertyPath)) {
          throw new Error(`Invalid rule name "${edit.propertyPath}": it is a reserved name.`);
        }
      } else if (edit.target !== "children") {
        assertSafePropertyPath(edit.propertyPath);
      }
    }
    const tree = this.editor.componentTree();
    const next = new Map<string, Record<string, unknown>>();
    const nextRules = new Map<string, Record<string, unknown>>();
    for (const edit of edits) {
      const node = tree.find(edit.componentId);
      if (!node) {
        throw new Error(`Component not found: ${edit.componentId}`);
      }
      if (edit.target === "rules") {
        const rules = nextRules.get(edit.componentId) ?? (isPlainObject(node.rules) ? structuredClone(node.rules as Record<string, unknown>) : {});
        writeRule(rules, edit.propertyPath, edit.value);
        nextRules.set(edit.componentId, rules);
        continue;
      }
      if (edit.target === "children") {
        continue;
      }
      const configuration = next.get(edit.componentId) ?? (isPlainObject(node.configuration) ? structuredClone(node.configuration) : {});
      setNestedValue(configuration, edit.propertyPath, edit.value);
      next.set(edit.componentId, configuration);
    }
    for (const [componentId, configuration] of next) {
      this.refuseReservedPageId(tree.find(componentId)?.configuration, configuration);
    }
    const commands: BuilderCommand[] = edits.flatMap((edit) =>
      edit.target === "rules"
        ? []
        : [
            edit.target === "children"
              ? new ReplaceChildrenCommand(tree, edit.componentId, edit.value as Record<string, ComponentNode[]>)
              : new SetPropertyCommand(tree, edit.componentId, edit.propertyPath, edit.value)
          ]
    );
    for (const [componentId, rules] of nextRules) {
      commands.push(new SetRulesCommand(tree, componentId, rules as ComponentRules));
    }
    for (const [componentId, configuration] of next) {
      const fold = this.gridColumnFoldFor(componentId, configuration);
      if (fold) {
        commands.push(fold);
      }
    }
    // The options, messages, tabs and parts these writes delete take their translations with them.
    let translations = this.translationsValue ?? {};
    const renamedTexts: RenamedTextId[] = [];
    for (const [componentId, configuration] of next) {
      this.refuseRepeatedChromeId(componentId, tree.find(componentId)?.configuration, configuration);
      translations = sweepConfigurationTexts(translations, componentId, componentId === this.rootId(), tree.find(componentId)?.configuration, configuration, renamedTexts);
    }
    const swept = this.translationsCommand(this.translationsValue, translations);
    if (swept) {
      commands.push(swept);
    }
    const [first] = commands;
    if (!first) {
      return;
    }
    const command = commands.length === 1 ? first : new CompositeCommand(first.id, commands);
    const moving = [...next].some(([componentId, configuration]) => movesData(tree.find(componentId)?.configuration, configuration));
    const moved = options.unrecorded ? (this.editor.executeUnrecorded(command), undefined) : moving ? this.executeMovingData(command) : (this.editor.execute(command), undefined);
    this.announceRenames(renamedTexts);
    for (const edit of edits) {
      const draft = this.drafts.get(edit.componentId);
      if (draft && edit.target === "rules") {
        // An open draft keeps step with the tree, as its configuration does.
        const rules = isPlainObject(draft.rules) ? { ...(draft.rules as Record<string, unknown>) } : {};
        writeRule(rules, edit.propertyPath, edit.value);
        draft.rules = Object.keys(rules).length > 0 ? (rules as ComponentRules) : undefined;
      } else if (draft && edit.target !== "children") {
        if (!isPlainObject(draft.configuration)) {
          draft.configuration = {};
        }
        setNestedValue(draft.configuration as Record<string, unknown>, edit.propertyPath, edit.value);
      }
    }
    this.idError = undefined;
    this.refreshCssClassChecks();
    // Heard inside the step a move of data opened, so a follow-up made as it is heard joins it.
    if (moved) {
      moved.join(() => this.emitChange("edit"));
    } else {
      this.emitChange("edit");
    }
  }

  /**
   * Re-seats a component under another id (refused, with {@link idError}, for one the tree or
   * {@link BuilderControllerOptions.claimedIds} has, one outside the grammar, or one that would
   * put the component's answer where another component's is). The rename is one
   * step of the history with everything it rewrites: its
   * collection path and the row fields that list it, the rules that read it, its translations,
   * and what a listener of the change writes as it hears of it (a PDF layout's conditions and
   * sources) or a moment later through {@link followRename} (the scenarios). Undo takes all of it
   * back and Redo makes it again, and the steps before it are undone on the component under the
   * id it had then. A draft left under the new id is dropped. Its change carries
   * {@link BuilderChangeEvent.renamed}; an Undo or Redo of it, {@link BuilderChangeEvent.renameStepped}.
   */
  public renameId(currentId: string, nextIdRaw: string): void {
    this.renameWith(currentId, nextIdRaw, undefined);
  }

  /**
   * {@link renameId}, with `edit` (an edit of the component made against `currentId`, a Save's)
   * as the first part of the rename's entry. Whether the rename was made: when it is not, `edit`
   * has not run and is the caller's to make.
   */
  private renameWith(currentId: string, nextIdRaw: string, edit: BuilderCommand | undefined): boolean {
    const tree = this.editor.componentTree();
    const node = tree.find(currentId);
    if (!node) {
      return false;
    }
    const nextId = nextIdRaw.trim();
    if (nextId === currentId) {
      this.idError = undefined;
      return false;
    }
    if (nextId.length === 0) {
      this.idError = "ID is required.";
      this.emitChange("edit");
      return false;
    }
    const taken = tree.find(nextId) ? `ID "${nextId}" already exists.` : this.claimedIdError(nextId);
    if (taken) {
      this.idError = taken;
      this.emitChange("edit");
      return false;
    }
    try {
      assertValidComponentId(nextId);
      // The form's root is the definition, not a component: its id is never re-seated.
      if (currentId === tree.rootId()) {
        this.idError = this.builderWords().text("controller.renameFailed");
        this.emitChange("edit");
        return false;
      }
      const clash = this.renameDataProblem(currentId, nextId);
      if (clash) {
        this.idError = clash;
        this.emitChange("edit");
        return false;
      }
      const original = tree.find(currentId)!;
      // Where every component sits before the step: the rules inside a row read by key, so they
      // follow the keys the step moved (this component's own, when it has no data key, and those
      // under it), measured, never the id.
      const pathsBefore = buildDataPaths(tree.getRoot());
      // Where its data sits, for a reference that reads answers by path. A grouping node holds none.
      const dataPathBefore = holdsData(original) ? pathsBefore.get(currentId) : undefined;
      // Saved with other edits (a new data key with the new id), the data may move further than
      // the id alone moves it: where each answer sits now, and where the rename alone would put it.
      let placesBefore: Map<string, string> | undefined;
      let renamedOnly: Map<string, string> | undefined;
      if (edit) {
        placesBefore = dataPlacesOf(tree);
        const scratch = new ComponentTree(this.editor.snapshot());
        renameNodeCommand(scratch, currentId, nextId).execute();
        renamedOnly = dataPlacesOf(scratch);
      }
      // The rename and every follow-up below are one entry of the history:
      // Undo takes the id back with the rules, translations and row fields that
      // followed it, and whatever a listener rewrites as it hears of the rename joins too.
      const step = new RenameStep({ from: currentId, to: nextId }, [...(edit ? [edit] : []), renameNodeCommand(tree, currentId, nextId)], (by) => this.historyStepped(step, by));
      this.editor.execute(step);
      this.openRename = step;
      this.remember(step);
      // A draft left under the new id belonged to a component gone since: it is not this one's.
      this.drafts.delete(nextId);
      const draft = this.drafts.get(currentId);
      if (draft) {
        this.drafts.delete(currentId);
        draft.id = nextId;
        this.drafts.set(nextId, draft);
      }
      // The selection follows only when it was this component's: another one's rename (an agent's, a
      // host's) leaves what the author is editing, and its unsaved draft, where they are.
      if (this.selectedId === currentId) {
        this.selectedId = nextId;
      }
      this.idError = undefined;
      step.join(() => {
        // Its translations move to the new id (renames move); the change reports the
        // move for a host keeping entries under the same address.
        if (this.translationsValue && isSafeSegment(nextId)) {
          const moved = this.translationsCommand(
            this.translationsValue,
            moveTranslations(this.translationsValue, { kind: "components", owner: currentId }, { kind: "components", owner: nextId })
          );
          if (moved) {
            this.editor.execute(moved);
          }
        }
        this.renamedIdsToAnnounce = [{ kind: "components", from: currentId, to: nextId }];
        // The tree's own rules follow, unless the tree's owner does that itself. Then announced
        // like removed locales, for whoever keeps references of its own (journeys, PDF layouts).
        // What the Save's other edits moved past what the new id alone moves: each such answer's
        // place before and after the Save. The change carries them for whoever reads answers by
        // value path (a reader that follows the rename by id skips a component with a data key).
        const moves: ValuePathMove[] = [];
        if (placesBefore && renamedOnly) {
          for (const [id, now] of dataPlacesOf(tree)) {
            const was = placesBefore.get(id === nextId ? currentId : id);
            if (was !== undefined && was !== now && renamedOnly.get(id) !== now) {
              moves.push({ from: was, to: now });
            }
          }
        }
        if (moves.length > 0) {
          this.dataMovedToAnnounce = moves;
          step.moved = moves[0];
          step.dataMoved = moves;
        }
        // The rules inside a row follow every key the step moved, the id's part included; a tree
        // whose owner follows the id itself still has the moves the id does not explain followed.
        const keyMoves: ValuePathMove[] = [];
        if (this.renameFollowsRulesOption === false) {
          keyMoves.push(...moves);
        } else {
          for (const [id, now] of buildDataPaths(tree.getRoot())) {
            const was = pathsBefore.get(id === nextId ? currentId : id);
            if (was !== undefined && was !== now) {
              keyMoves.push({ from: was, to: now });
            }
          }
        }
        const rowRules = this.followRowKeys(tree, keyMoves);
        const followedById = this.renameFollowsRulesOption === false ? { rules: [], unparsed: [] } : this.followRenameInRules(tree, currentId, nextId);
        const followed = { rules: [...new Set([...followedById.rules, ...rowRules])], unparsed: followedById.unparsed };
        this.renameNotesValue = followed.unparsed;
        const dataPathAfter = dataPathBefore === undefined ? undefined : buildDataPaths(tree.getRoot()).get(nextId);
        this.renamedToAnnounce = {
          from: currentId,
          to: nextId,
          ...(dataPathBefore !== undefined && dataPathAfter !== undefined && (dataPathBefore !== currentId || dataPathAfter !== nextId) && dataPathBefore !== dataPathAfter
            ? { dataPath: { from: dataPathBefore, to: dataPathAfter } }
            : {}),
          ...(followed.rules.length > 0 ? { rules: followed.rules } : {}),
          ...(followed.unparsed.length > 0 ? { unparsed: followed.unparsed } : {})
        };
        // Heard inside the step: a mode that rewrites a document of the form's own (a PDF
        // layout's condition, the scenarios) as it hears of the rename writes into this entry.
        this.emitChange("edit");
      });
      return true;
    } catch (error) {
      this.idError = error instanceof Error ? error.message : this.builderWords().text("controller.idInvalid");
      this.emitChange("edit");
      return false;
    }
  }

  /**
   * Runs `command` (an edit that may move where answers are stored) as a step of the history.
   * When it moved a data-holding component's value path, the step stays open to the follow-ups
   * like a rename's ({@link followRename}): the rules inside a grid row that read a moved row
   * key follow at once, the moves are announced ({@link BuilderChangeEvent.dataMoved}), and the
   * step is returned so the caller announces its change inside it. `undefined` otherwise.
   */
  private executeMovingData(command: BuilderCommand): RenameStep | undefined {
    const tree = this.editor.componentTree();
    const before = dataPlacesOf(tree);
    const step: RenameStep = new RenameStep({ from: "", to: "" }, [command], (by) => this.historyStepped(step, by), "MOVE_DATA");
    this.editor.execute(step);
    const after = dataPlacesOf(tree);
    const moves: ValuePathMove[] = [];
    for (const [id, path] of before) {
      const now = after.get(id);
      if (now !== undefined && now !== path) {
        moves.push({ from: path, to: now });
      }
    }
    const [first] = moves;
    if (!first) {
      return undefined;
    }
    step.rename = first;
    step.dataMoved = moves;
    this.openRename = step;
    this.remember(step);
    step.join(() => {
      this.followRowKeys(tree, moves);
      this.dataMovedToAnnounce = moves;
    });
    return step;
  }

  /**
   * The rules inside a grid row read its fields by key (`row.<key>`), so they follow the keys
   * that moved in that row's collection, in the tree and in the open drafts: all of one edit's
   * keys as one map, so a swap stays a swap. Run inside the step that moved them. The ids of the
   * components whose rules in the tree it rewrote.
   */
  private followRowKeys(tree: ComponentTree, moves: readonly ValuePathMove[]): string[] {
    const keysByCollection = new Map<string, { from: string; to: string }[]>();
    for (const move of moves) {
      const row = rowKeyMoveOf(move);
      if (row) {
        keysByCollection.set(row.collection, [...(keysByCollection.get(row.collection) ?? []), { from: row.from, to: row.to }]);
      }
    }
    const commands: BuilderCommand[] = [];
    const rewritten: string[] = [];
    if (keysByCollection.size > 0) {
      // A component's row is the innermost collection it sits in; a grid nested in a row reads that row.
      const rows = buildRowCollections(tree.getRoot());
      for (const [id, collection] of rows) {
        const keys = keysByCollection.get(collection);
        const node = keys ? tree.find(id) : undefined;
        if (!keys || !node) {
          continue;
        }
        if (isPlainObject(node.rules)) {
          const current = node.rules as ComponentRules;
          const next = Object.fromEntries(Object.entries(current).map(([key, rule]) => [key, renameRowKeysInRuleSource(rule, keys)])) as ComponentRules;
          if (Object.entries(next).some(([key, rule]) => rule !== (current as Record<string, unknown>)[key])) {
            commands.push(new SetRulesCommand(tree, id, next));
            rewritten.push(id);
          }
        }
        const draft = this.drafts.get(id);
        if (draft && isPlainObject(draft.rules)) {
          draft.rules = Object.fromEntries(Object.entries(draft.rules).map(([key, rule]) => [key, renameRowKeysInRuleSource(rule, keys)])) as ComponentRules;
        }
      }
    }
    const [one] = commands;
    if (one) {
      this.editor.execute(commands.length === 1 ? one : new CompositeCommand("MOVE_ROW_KEY_RULES", commands));
    }
    return rewritten;
  }

  /**
   * Runs `run` — a follow-up of the rename `rename` made a moment after it (the scenarios,
   * rewritten once the Tests chunk is in) — so that what it writes joins the rename's own entry
   * of the history, and an Undo takes it back with the id. That holds while the rename is still
   * the last thing done, and again on the change a Redo of it makes. While the rename is undone,
   * `run` is not run at all: it would write what the Undo took away and cost the Redo; the Redo
   * announces the rename again ({@link BuilderChangeEvent.historyStep}) for it to follow then.
   * After another edit, or for a rename the builder does not know, `run` writes a step of its
   * own. Whether it joined.
   */
  public followRename(rename: { from: string; to: string }, run: () => void): boolean {
    // `rename` is the rename's ids, or the first value path an edit moved (`dataMoved[0]`), a
    // rename's Save included.
    const names = (step: RenameStep): boolean => [step.rename, step.moved].some((handle) => handle !== undefined && handle.from === rename.from && handle.to === rename.to);
    const open = this.openRename;
    if (open !== undefined && names(open)) {
      open.join(run);
      return true;
    }
    // The newest step of that name: a rename made again after its Undo is a step of its own.
    let known: RenameStep | undefined;
    for (let at = this.recentSteps.length - 1; at >= 0 && known === undefined; at -= 1) {
      const step = this.recentSteps[at]!;
      known = names(step) ? step : undefined;
    }
    if (known?.isUndone()) {
      return false;
    }
    run();
    return false;
  }

  /** Keeps `step` among the latest renames and moves of data, for {@link followRename} to know. */
  private remember(step: RenameStep): void {
    this.recentSteps.push(step);
    if (this.recentSteps.length > RECENT_STEPS_KEPT) {
      this.recentSteps.shift();
    }
  }

  /**
   * An Undo or a Redo (`by`) took a rename or a move of data back or made it again. A step that
   * moved data announces its moves, reversed on an Undo and as at first on a Redo, and a Redo
   * leaves the step open to follow-ups once it is through.
   */
  private historyStepped(step: RenameStep, by: "undo" | "redo"): void {
    if (step.id === "RENAME_COMPONENT") {
      this.renameStepped(step, by);
    }
    // An edit that turned out to move no data is a plain step: nothing follows it.
    const moved = step.dataMoved !== undefined && step.dataMoved.length > 0;
    if (moved) {
      // An Undo moves the answers back, so its moves run the other way; a Redo's are the first run's.
      this.dataMovedToAnnounce = step.dataMoved!.map((move) => (by === "undo" ? { from: move.to, to: move.from } : { from: move.from, to: move.to }));
    }
    if (by === "redo" && (step.id === "RENAME_COMPONENT" || moved)) {
      this.redoneStep = step;
    }
  }

  /**
   * An Undo or a Redo moved a rename's ids (`by`): the change says which way
   * ({@link BuilderChangeEvent.renameStepped}), the translations' hosts hear the ids move as at
   * the rename, and a selection on the id it left goes with it.
   */
  private renameStepped(step: RenameStep, by: "undo" | "redo"): void {
    const { from, to } = by === "undo" ? { from: step.rename.to, to: step.rename.from } : step.rename;
    this.renameSteppedToAnnounce = { from, to, by };
    this.renamedIdsToAnnounce = [...(this.renamedIdsToAnnounce ?? []), { kind: "components", from, to }];
    if (this.selectedId === from) {
      this.selectedId = to;
      this.emit("selection", { selectedComponentId: to });
    }
  }

  /**
   * The formulas the last {@link renameId} could not follow: rules that spell the old id yet
   * do not parse, left as written. For the Logic diagnostics to show beside the rules they name;
   * empty until a rename leaves one, and replaced by the next rename.
   */
  public renameNotes(): readonly BuilderRenameNote[] {
    return this.renameNotesValue;
  }

  /**
   * Every rule of every component that reads `from` rewritten to read `to` (a string formula
   * over the parser's spans, a tree through its path nodes, the object form through both) in
   * the tree and in the open drafts alike, whatever the rule's key (`visibleWhen`, `value`,
   * `defaultValue`, `filter`, `navigationGating` and the rest). A read of a grid row's key
   * (`row.sku`) is not the id's and is left to {@link followRowKeys}. Written to the tree as one
   * command, which {@link renameId} runs inside the rename's own history entry. A rule that is
   * left byte for byte is not written at all. A formula the parser rejects is left as it stands and reported in
   * `unparsed`, once per component and rule.
   */
  private followRenameInRules(tree: ComponentTree, from: string, to: string): { rules: string[]; unparsed: BuilderRenameNote[] } {
    const rules: string[] = [];
    const unparsed: BuilderRenameNote[] = [];
    const report = (componentId: string, notes: ReadonlyArray<{ rule: string; formula: string }>): void => {
      for (const note of notes) {
        if (!unparsed.some((entry) => entry.componentId === componentId && entry.rule === note.rule && entry.formula === note.formula)) {
          unparsed.push({ componentId, rule: note.rule, from, to, formula: note.formula });
        }
      }
    };
    const commands: BuilderCommand[] = [];
    for (const node of collectNodes(tree.getRoot())) {
      if (!isPlainObject(node.rules)) {
        continue;
      }
      const followed = renameRules(node.rules as ComponentRules, from, to);
      report(node.id, followed.unparsed);
      if (followed.rules !== node.rules) {
        commands.push(new SetRulesCommand(tree, node.id, followed.rules));
        rules.push(node.id);
      }
    }
    const [first] = commands;
    if (first) {
      this.editor.execute(commands.length === 1 ? first : new CompositeCommand("RENAME_RULES", commands));
    }
    for (const [draftId, draft] of this.drafts) {
      if (!isPlainObject(draft.rules)) {
        continue;
      }
      const followed = renameRules(draft.rules, from, to);
      report(draftId, followed.unparsed);
      if (followed.rules !== draft.rules) {
        draft.rules = followed.rules;
      }
    }
    return { rules, unparsed };
  }

  /**
   * Takes back the last step. It never throws: a step the tree no longer matches leaves the tree
   * as it was, takes the steps before it along, and says so in {@link dropError}; a listener that
   * throws is reported, not thrown (see {@link emit}).
   */
  public undo(): void {
    if (this.editor.canUndo()) {
      this.stepThroughHistory(() => this.editor.undo(), "undone", "before");
    }
  }

  public redo(): void {
    if (this.editor.canRedo()) {
      this.stepThroughHistory(() => this.editor.redo(), "redone", "after");
    }
  }

  /**
   * One step through the history. A step that cannot be taken — the tree no longer holds what
   * it recorded — is never thrown at the bar's Undo or Redo: the tree stays as it was, the steps
   * beyond it go with it (`CommandHistory.undo`), and {@link dropError} says so on the canvas.
   * Drafts of components the step took away go with them.
   */
  private stepThroughHistory(step: () => void, taken: string, beyond: string): void {
    this.stepping = true;
    // What each open draft's component looks like before the step (a copy: a command may edit
    // the node in place), and the tree's shape. A step that changes the component must not
    // leave the draft's stale copy for a later Save to write over what undo or redo just
    // restored. A step that only changed its properties re-sets the paths it
    // touched into the draft, which keeps the rest of what the author has pending (an options
    // dialog's Apply undone under an open label edit); any other change discards it.
    const before = new Map<string, ComponentNode>();
    for (const id of this.drafts.keys()) {
      const node = this.editor.componentTree().find(id);
      if (node) {
        const { children: _children, ...own } = node;
        before.set(id, structuredClone(own));
      }
    }
    const shapeBefore = before.size > 0 ? treeShape(this.editor.componentTree().getRoot()) : "";
    this.historyStepToAnnounce = taken === "undone" ? "undo" : "redo";
    this.redoneStep = undefined;
    try {
      try {
        step();
        this.dropError = undefined;
      } catch (error) {
        this.dropError = `This step could not be ${taken}${error instanceof Error ? ` (${error.message})` : ""}, nor can the ones ${beyond} it.`;
      }
      const structural = before.size > 0 && treeShape(this.editor.componentTree().getRoot()) !== shapeBefore;
      for (const [id, draft] of this.drafts) {
        const node = this.editor.componentTree().find(id);
        const was = before.get(id);
        if (node && was && this.ownSignature(node) === this.ownSignature(was)) {
          continue;
        }
        if (!node || !was || structural || !this.restoreIntoDraft(id, draft, was, node)) {
          this.drafts.delete(id);
          // A prompt asking about that draft would ask about nothing; it goes with it, and so
          // does the action it held (a forced change never leaves a prompt stranded).
          this.releaseHeldAction(id);
        }
      }
      this.reconcileSelection();
      // A rename or a move of data made again takes its follow-ups as at its first run: one
      // dropped while it was undone joins it on this change.
      if (this.redoneStep !== undefined) {
        this.openRename = this.redoneStep;
        this.redoneStep = undefined;
      }
      this.emitChange("edit");
    } finally {
      this.stepping = false;
    }
  }

  /** A node's own content, children left out: what a draft of it edits. */
  private ownSignature(node: ComponentNode): string {
    return JSON.stringify({ ...node, children: undefined });
  }

  /**
   * After a step that changed only `was`'s configuration or rules into `now`'s (same id, type and
   * everything else), writes each path the step touched into `draft` as the tree holds it now,
   * so the draft's own pending edits elsewhere survive while undo's restored values are
   * what both the tree and the draft hold. `false` when the step changed more than that, or
   * when nothing is left pending: the caller discards the draft (and any prompt held on it) then.
   */
  private restoreIntoDraft(id: string, draft: ComponentDraft, was: ComponentNode, now: ComponentNode): boolean {
    const rest = (node: ComponentNode): string => JSON.stringify({ ...node, configuration: undefined, rules: undefined, children: undefined });
    if (rest(was) !== rest(now)) {
      return false;
    }
    draft.configuration = restoreTouchedPaths(isPlainObject(draft.configuration) ? draft.configuration : {}, was.configuration, now.configuration) ?? {};
    const rules = restoreTouchedPaths(draft.rules ?? {}, was.rules, now.rules);
    draft.rules = isPlainObject(rules) && Object.keys(rules).length > 0 ? (rules as ComponentRules) : undefined;
    return this.hasPendingChanges(id);
  }

  /**
   * A step through the history may take the selected component away (undoing its add, redoing
   * its removal): the selection is put down then, as {@link remove} puts it down, so the next
   * edit's checks do not run over a component the tree no longer has.
   */
  private reconcileSelection(): void {
    if (this.selectedId !== undefined && !this.editor.componentTree().find(this.selectedId)) {
      this.selectedId = undefined;
      this.idError = undefined;
      this.cssClassError = undefined;
      this.cssClassWarning = undefined;
      this.dataKeyError = undefined;
      this.emit("selection", { selectedComponentId: undefined });
    }
  }

  // --- drag & drop -------------------------------------------------------

  public dragPayloadForType(type: string): BuilderDragPayload {
    return { kind: "template-component", component: this.newNodeForType(type) };
  }

  public applyDrop(
    dataTransfer: DataTransferLike,
    parentId: string,
    slotId: string,
    index: number
  ): void {
    const read = readDragPayload(dataTransfer);
    if (!read) {
      return;
    }
    let payload: BuilderDragPayload = read;
    if (read.kind === "template-component") {
      // A drag's data is anyone's to write (another window, another page): only the type is
      // trusted, and only when it is one this builder offers. The node is built here, from that
      // type, with ids of this form's own; the payload's configuration is data laid over it.
      const template = this.templateFromDragged(read.component);
      if (!template) {
        return;
      }
      payload = { kind: "template-component", component: template };
    }
    const target = { parentId, slotId, index };

    // A form that holds only the Submit button it started with shows its drop prompt under that
    // button, so the first component dropped there would land after it: it goes before, as an
    // add with no position does (see addNode). Any other drop places where it was dropped.
    if (payload.kind === "template-component" && index > 0 && this.beforeSeededSubmit(target) === 0) {
      target.index = 0;
    }

    if (payload.kind === "existing-component") {
      // A drag's data is anyone's to write: it cannot move what move() refuses (the root, a
      // fixed node, an id the tree does not hold).
      if (!this.parentOf(payload.componentId)) {
        return;
      }
      if (this.isFixedNode(payload.componentId)) {
        // Said on the canvas, in the words move() and the Move to list use.
        this.dropError = this.fixedMoveReason(payload.componentId, target);
        this.emitChange("edit");
        return;
      }
      // No-op when an existing component is dropped onto its own current position.
      if (this.isOwnPlace(payload.componentId, target)) {
        this.dropError = undefined;
        return;
      }
      // The canvas measures the gap among the slot's children as they stand, the dragged one
      // still among them; the tree places it after taking it out (see moveIndexAfterRemoval).
      target.index = this.moveIndexAfterRemoval(payload.componentId, target);
    }
    const intent = toDropIntent(payload, target);

    // The dropped component takes the selection with it. Moving the very component whose
    // edits are pending leaves nothing behind, so only a drop that lands the selection
    // somewhere else waits on the unsaved-changes prompt.
    const run: HeldRun = (follow) => {
      const target = { ...intent.target, parentId: follow(intent.target.parentId) };
      this.performDrop(intent.kind === "move-existing" ? { ...intent, componentId: follow(intent.componentId), target } : { ...intent, target });
    };
    if (intent.kind === "move-existing" && intent.componentId === this.selectedId) {
      run((id) => id);
    } else {
      this.holdUnlessClean("drop", run);
    }
  }

  /**
   * The node a dragged template stands for: a new one of its type, the dragged configuration (a
   * plain object, copied, keys the type's template declares) over the type's own. `undefined` when the payload names no type, a type
   * this builder does not offer, or the form's root type, which is never placed twice.
   */
  private templateFromDragged(dragged: unknown): ComponentNode | undefined {
    const type = isPlainObject(dragged) ? (dragged as { type?: unknown }).type : undefined;
    if (typeof type !== "string" || type === "" || type === "form" || !this.offersType(type)) {
      return undefined;
    }
    const node = this.newNodeForType(type);
    const configuration = (dragged as { configuration?: unknown }).configuration;
    if (isPlainObject(configuration)) {
      // Only the keys the type's own template declares, as the palette writes them: a payload from
      // another page does not get to add configuration the type never had.
      const declared = (node.configuration ?? {}) as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const key of Object.keys(declared)) {
        if (Object.prototype.hasOwnProperty.call(configuration, key)) {
          Object.defineProperty(kept, key, {
            value: structuredClone((configuration as Record<string, unknown>)[key]),
            enumerable: true,
            writable: true,
            configurable: true
          });
        }
      }
      node.configuration = { ...declared, ...kept };
    }
    return node;
  }

  /** Whether `type` is one the palette lists and the registry (when the builder has one) knows. */
  private offersType(type: string): boolean {
    if (!this.types.some((entry) => entry.type === type)) {
      return false;
    }
    if (!this.componentRegistry) {
      return true;
    }
    try {
      this.componentRegistry.resolve(type);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether `target` — a gap among the slot's children as they stand — is where the component
   * already is: the gap before it or the one after it.
   */
  private isOwnPlace(componentId: string, target: { parentId: string; slotId: string; index: number }): boolean {
    const location = this.editor.componentTree().locate(componentId);
    return (
      location?.parentId === target.parentId &&
      location.slotId === target.slotId &&
      location.index !== undefined &&
      (target.index === location.index || target.index === location.index + 1)
    );
  }

  /**
   * `target.index` is a gap among the slot's children *before* the move; the tree's move takes
   * the component out first and places it among what is left. Within its own slot, a gap past
   * it is therefore one less.
   */
  private moveIndexAfterRemoval(componentId: string, target: { parentId: string; slotId: string; index: number }): number {
    const location = this.editor.componentTree().locate(componentId);
    const sameSlot = location?.parentId === target.parentId && location.slotId === target.slotId;
    return sameSlot && location?.index !== undefined && target.index > location.index ? target.index - 1 : target.index;
  }

  /** Places the drop; whether it landed (a refusal sets {@link dropError}). */
  private performDrop(intent: BuilderDropIntent): boolean {
    const clash = this.dataPathProblemAfter((tree) => {
      if (intent.kind === "move-existing") {
        tree.move(intent.componentId, intent.target.parentId, intent.target.slotId, intent.target.index);
      } else {
        tree.insert(intent.component, intent.target.parentId, intent.target.slotId, intent.target.index);
      }
    });
    if (clash) {
      this.dropError = clash;
      this.emitChange("edit");
      return false;
    }
    try {
      applyDropIntent(this.editor, intent, this.resolver);
    } catch (error) {
      this.dropError = error instanceof Error ? error.message : this.builderWords().text("controller.notAllowed");
      this.emitChange("edit");
      return false;
    }
    this.dropError = undefined;
    this.selectedId =
      intent.kind === "insert-template" ? intent.component.id : intent.componentId;
    this.emitChange(intent.kind === "insert-template" ? "add" : "move");
    return true;
  }
}

/** The components above `componentId` in `tree`, nearest first (the form's root last); none when it is not there. */
function ancestorsOf(tree: ComponentNode, componentId: string): ComponentNode[] {
  const walk = (node: ComponentNode, trail: ComponentNode[]): ComponentNode[] | undefined => {
    if (node.id === componentId) {
      return trail;
    }
    for (const slot of Object.values(node.children ?? {})) {
      for (const child of slot ?? []) {
        const found = walk(child, [node, ...trail]);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(tree, []) ?? [];
}
