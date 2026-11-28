/**
 * The PDF layout designer: the form builder's own controller, panels, drop
 * pipeline, drafts and undo — pointed at a layout tree instead of a form tree. A host mounts
 * `<datum-builder>` (or a `BuilderController`) with the options this factory returns; nothing
 * in the builder knows it is designing a PDF.
 *
 * The one thing a layout needs from the form is a picture of each bound component. The
 * designer renders the form once, read-only, over the sample answers the host supplies (the
 * live form's current values, typically), folds that output through the presentation fold (the
 * walk the live form and print read too, so a preview agrees with them on a field's type and its
 * words), draws each bound field on its own through the Datum binding (`renderFieldPreview`) and
 * hands the drawing to its `pdf-field` face on the canvas.
 * The faces are live-renderer adapters (`pdf-canvas-adapters.ts`) the canvas lays over the
 * designer's binding.
 */
import type { DataSourceSet } from "../../core/schema/contracts.js";
import type { RuleSource } from "../../core/expressions/expression.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { addressOf, resolveText, type FormTranslations, type TextSources, type TranslationCatalog } from "../../core/localization/translations.js";
import { BUTTON_COMPONENT_TYPE } from "../../core/schema/button.js";
import { pdfPageDimensions, resolvePdfPageSetup, type PdfGeneratedLayout } from "../../core/schema/pdf-layout.js";
import { flattenComponentTree } from "../../render/core/component-model.js";
import type { DataSourceResolver } from "../../render/core/component-options.js";
import { foldPresentation } from "../../render/core/presentation-tree.js";
import { buildRuntimeRenderOutput } from "../../render/core/runtime-render-bridge.js";
import { renderFieldPreview } from "../../render/live/field-preview.js";
import { deriveDefaultPdfLayout } from "../../render/pdf/default-layout.js";
import {
  pdfComponentDefinitions,
  pdfComponentTypes,
  type PdfBindableCollection,
  type PdfBindableComponent,
  type PdfComponentText,
  type PdfThemeOption
} from "../../render/pdf/pdf-components.js";
import { createPdfDesignerBinding, pdfCanvasComponents } from "./pdf-canvas-adapters.js";
import { BuilderWords, type BuilderTextCatalog } from "../logic/builder-texts.js";
import { areaWords } from "./pdf-texts-en.js";
import type { PdfProfileOption } from "../../render/pdf/pdf-provider.js";
import { BuilderPreviewRuntime } from "../preview/builder-preview-runtime.js";
import type { BuilderControllerOptions } from "../controller/builder-controller.js";
import { formulaSignatures } from "../formula/feel-functions.js";
import type { FormulaFunctionsSource } from "../web-component/builder-panels.js";

export interface PdfDesignerOptions {
  /** The form the layout prints. */
  formRoot: ComponentNode;
  /** The layout to edit. Absent: the layout the engine derives from the form. */
  layout?: PdfGeneratedLayout | undefined;
  /** Sample answers the previews show; absent, fields preview empty. */
  values?: Record<string, unknown> | undefined;
  locale?: string | undefined;
  /** The host's builder texts per locale: the palette and the theme field's labels read it. */
  textCatalog?: BuilderTextCatalog | undefined;
  /** The definition's own translations: component labels and a layout's canvas texts are worded through them. */
  translations?: FormTranslations | undefined;
  translationCatalog?: TranslationCatalog | undefined;
  dataSources?: DataSourceSet | undefined;
  dataSourceResolver?: DataSourceResolver | undefined;
  /** The form's title, for the derived layout's heading. Absent: the root's `configuration.title`. */
  title?: string | undefined;
  /** The host's registered PDF themes, for the document's "PDF theme" select. Absent: a free-text id. */
  pdfThemes?: readonly PdfThemeOption[] | undefined;
  /** The ICC profiles the host offers as PDF/A output conditions, for the document's profile picker. */
  outputIntentProfiles?: readonly PdfProfileOption[] | undefined;
  /**
   * The plugin formula functions the host wired: the previews work out a field a
   * plugin function computes as the form will. Absent, such a field previews empty.
   */
  formulaFunctions?: FormulaFunctionsSource | undefined;
}

export interface PdfDesigner {
  /** What to hand `<datum-builder>` / `BuilderController`: the definitions, and the binding and faces the canvas draws them with. */
  builderOptions: BuilderControllerOptions;
  /**
   * The layout as the designer started with it. Its name and its `when` stay at the top level
   * only, where the engine and the catalog read them; the tree the builder edits
   * (`builderOptions.initialRoot`) carries both on the document root instead, for the
   * inspector's "Layout name" and the Rules tab. A name only a hand-written root carried is
   * lifted to the top level.
   */
  layout: PdfGeneratedLayout;
  /**
   * The layout document a builder tree (`controller.snapshot()` / `<datum-builder>.value`)
   * stands for. The root's `name` is the layout's name, lifted to the top level and taken off
   * the root; blank or absent, the layout has none. The root's `when` is the layout's
   * condition, lifted back the same way; cleared, the layout has none. The layout holds one
   * copy of each.
   */
  layoutFrom(root: ComponentNode): PdfGeneratedLayout;
  /** The form's components a `pdf-field` may bind. */
  components: PdfBindableComponent[];
  /**
   * Rebuilds the field previews over other sample answers. The host repaints the canvas afterwards.
   * When calls overlap, the last one started wins, however their renders finish.
   */
  refresh(values: Record<string, unknown>): Promise<void>;
  /**
   * Adopts plugin formula functions wired after the designer was built and rebuilds the field
   * previews over the last sample answers. The host repaints the canvas afterwards.
   */
  setFormulaFunctions(source: FormulaFunctionsSource | undefined): Promise<void>;
  /** The read-only drawing of one bound component (`renderFieldPreview`), once previews are built. */
  fieldPreview(componentId: string): HTMLElement | undefined;
}

function readConfig(node: ComponentNode): Record<string, unknown> {
  const configuration = node.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : {};
}

/** A text a definition authors: a string in the form's default language. */
function readText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The document root carrying the layout's name in its configuration, where the inspector's
 * "Layout name" box edits it. The root as given when it already says so, or the layout has
 * no name.
 */
function rootNamed(root: ComponentNode, name: string | undefined): ComponentNode {
  if (name === undefined || readText(readConfig(root).name) === name) {
    return root;
  }
  return { ...root, configuration: { ...readConfig(root), name } };
}

/** The document root with no name of its own: the layout's name lives at its top level. The root as given when it has none. */
function rootUnnamed(root: ComponentNode): ComponentNode {
  const configuration = readConfig(root);
  if (!("name" in configuration)) {
    return root;
  }
  const { name: _copy, ...rest } = configuration;
  return { ...root, configuration: rest };
}

/**
 * The document root carrying the layout's condition in its configuration, where the
 * Rules tab edits it — or, with `when` absent, carrying none. The root as given when it already
 * says so. The engine reads a layout's `when` at its top level only, so a `when` found on the
 * root is never the layout's own: seeding replaces it, and `layoutFrom` lifts it back.
 */
function rootConditioned(root: ComponentNode, when: unknown): ComponentNode {
  const configuration = readConfig(root);
  if (when === undefined) {
    if (!("when" in configuration)) {
      return root;
    }
    const { when: _stray, ...rest } = configuration;
    return { ...root, configuration: rest };
  }
  return configuration.when === when ? root : { ...root, configuration: { ...configuration, when } };
}

/** CSS pixels per PDF point: CSS fixes the inch at 96px, PDF at 72pt. */
const PX_PER_POINT = 96 / 72;

/**
 * The width the designer's sheet takes for a layout tree: the page's paper width in CSS pixels,
 * read from the document root's page setup (size and orientation, defaults filled in the way
 * the kernel fills them). Letter previews at 816px, A4 at 794px, and landscape turns the sheet
 * — the width is the page's, so the canvas offers no picker or grips to change it.
 */
export function pdfSheetWidth(root: ComponentNode): number {
  const { width } = pdfPageDimensions(resolvePdfPageSetup(readConfig(root).page));
  return Math.round(width * PX_PER_POINT);
}

/** A component's label for the picker: its translation at `components › id › label` in `locale`, else the string, else the id. */
function pickerLabel(node: ComponentNode, locale: string, sources: TextSources): string {
  const label = readText(readConfig(node).label);
  return label === undefined ? node.id : resolveText(label, addressOf.component(node.id, "label"), locale, sources) || node.id;
}

/** The components a layout may bind: everything but buttons and the root, labelled for the locale. */
export function bindableComponents(formRoot: ComponentNode, locale: string, sources: TextSources = {}): PdfBindableComponent[] {
  return flattenComponentTree(formRoot)
    .slice(1)
    .filter((node) => node.type !== BUTTON_COMPONENT_TYPE)
    .map((node) => ({
      id: node.id,
      label: pickerLabel(node, locale, sources),
      type: node.type,
      container: !!node.children && Object.keys(node.children).length > 0
    }));
}

/** The collections a repeat or table may draw rows from. */
export function bindableCollections(formRoot: ComponentNode, locale: string, sources: TextSources = {}): PdfBindableCollection[] {
  return flattenComponentTree(formRoot)
    .filter((node) => node.collection !== undefined)
    .map((node) => ({
      path: node.collection?.collectionPath ?? node.id,
      label: pickerLabel(node, locale, sources)
    }));
}

export async function createPdfDesigner(options: PdfDesignerOptions): Promise<PdfDesigner> {
  const locale = options.locale ?? "en";
  const sources: TextSources = { translations: options.translations, catalog: options.translationCatalog };
  const components = bindableComponents(options.formRoot, locale, sources);
  const collections = bindableCollections(options.formRoot, locale, sources);
  // A layout started from the form carries the form's own words in the default language: the
  // designer edits the authored strings, and the Languages workspace translates them.
  const given = options.layout ?? deriveDefaultPdfLayout(options.formRoot, { ...(options.title !== undefined ? { title: options.title } : {}) });
  // The layout's name rides on the root of the tree the builder edits, where the inspector's
  // "Layout name" box edits it, and comes back through `layoutFrom` to the top level — one
  // name, whichever side changes it, and one copy of it in the layout.
  const layoutName = given.name;
  const layout: PdfGeneratedLayout = {
    ...given,
    ...(layoutName !== undefined ? { name: layoutName } : {}),
    root: rootConditioned(rootUnnamed(given.root), undefined)
  };
  // Its condition rides on that root too, where the Rules tab finds it, and nowhere
  // in the catalog's copy but the top level.
  const initialRoot = rootConditioned(rootNamed(layout.root, layoutName), given.when);

  const previews = new Map<string, HTMLElement>();

  let formulaSource = options.formulaFunctions;
  let lastValues: Record<string, unknown> = options.values ?? {};
  // Bumped by every refresh: one whose render finishes after a later one started leaves the
  // previews to that later one, which drew them over the newer answers and functions.
  let refreshRun = 0;

  const refresh = async (values: Record<string, unknown>): Promise<void> => {
    lastValues = values;
    const run = (refreshRun += 1);
    const pluginFunctions = formulaSource !== undefined && typeof formulaSource.functions === "function" ? formulaSource.functions() : undefined;
    const preview = new BuilderPreviewRuntime(options.formRoot, {
      ...(pluginFunctions !== undefined ? { functions: pluginFunctions } : {}),
      ...(formulaSource !== undefined ? { signatures: formulaSignatures(formulaSource) } : {}),
      ...(options.dataSourceResolver ? { dataSourceResolver: options.dataSourceResolver } : {}),
      ...(options.dataSources ? { dataSources: options.dataSources } : {}),
      ...(options.translations !== undefined ? { translations: options.translations } : {}),
      ...(options.translationCatalog !== undefined ? { translationCatalog: options.translationCatalog } : {}),
      locale
    });
    for (const [path, value] of Object.entries(values)) {
      preview.setValue(path, value);
    }
    const output = await buildRuntimeRenderOutput(preview, "readonly", {
      ...(options.dataSources ? { dataSources: options.dataSources } : {})
    });
    if (run !== refreshRun) {
      return;
    }
    previews.clear();
    if (output.mode !== "readonly") {
      return;
    }
    // The output folded as the live form folds it, every component kept (a hidden one is still
    // bindable): the fold words what the flat list leaves raw (a row's label, the form's texts layered
    // under the host's catalog and the form's own translations) and names each field's base type.
    const tree = foldPresentation(output, {
      locale,
      includeHidden: true,
      // A collection's columns are bindable as they are authored (the repeat draws them per row): the template is the one row.
      dataGridRows: "template",
      ...(options.translations !== undefined ? { translations: options.translations } : {}),
      ...(options.translationCatalog !== undefined ? { translationCatalog: options.translationCatalog } : {})
    });
    for (const field of tree.fields) {
      const bound = components.find((component) => component.id === field.model.id);
      // The first copy of a component a collection repeats stands for it.
      if (!bound || bound.container || previews.has(field.model.id)) {
        continue;
      }
      previews.set(field.model.id, renderFieldPreview(field, locale, { words: tree.text, dir: output.meta.textDirection }));
    }
  };
  await refresh(options.values ?? {});

  const setFormulaFunctions = async (source: FormulaFunctionsSource | undefined): Promise<void> => {
    if (source === formulaSource) {
      return;
    }
    formulaSource = source;
    await refresh(lastValues);
  };

  const fieldPreview = (componentId: string): HTMLElement | undefined => previews.get(componentId);
  const base = new BuilderWords();
  base.locale = locale;
  base.catalog = options.textCatalog;
  const words = areaWords(base);
  const texts: PdfComponentText = (key, params) => words.text(key, params);
  const definitions = pdfComponentDefinitions({
    formComponents: components,
    collections,
    pdfThemes: options.pdfThemes,
    outputIntentProfiles: options.outputIntentProfiles,
    texts
  });
  const canvasComponents = pdfCanvasComponents({
    formComponents: components,
    collections,
    fieldPreview,
    locale,
    translations: options.translations,
    layoutId: layout.id,
    translationCatalog: options.translationCatalog,
    texts
  });

  return {
    builderOptions: {
      componentTypes: pdfComponentTypes(texts),
      componentDefinitions: definitions,
      initialRoot,
      locale,
      binding: createPdfDesignerBinding(),
      canvasComponents,
      sheetWidth: pdfSheetWidth
    },
    layout,
    components,
    layoutFrom: (root) => {
      const { name: _seeded, when: _given, ...rest } = layout;
      const configuration = readConfig(root);
      const name = readText(configuration.name);
      // Written as it stands, an expression or not: one the evaluator cannot run never holds,
      // and is the author's to see and mend rather than the designer's to drop.
      const when = configuration.when;
      return {
        ...rest,
        root: rootConditioned(rootUnnamed(root), undefined),
        ...(name !== undefined && name.trim() !== "" ? { name } : {}),
        ...(when !== undefined && when !== null ? { when: when as RuleSource } : {})
      };
    },
    refresh,
    setFormulaFunctions,
    fieldPreview
  };
}
