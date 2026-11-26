/**
 * The model-building layer inside the program: a form, a layout and the answers
 * to a `PdfRenderModel`, using the engine's own `buildPdfRenderModel`. It exists so a host with
 * no TypeScript engine — a JVM embedding QuickJS — sends the `document` operation and gets
 * bytes, the engine's semantics included.
 *
 * Effective visibility is recomputed here from the tree's rules when the host does not send
 * it, through the same resolver the runtime uses (`RulesSemanticStateResolver`), folded with
 * `computeEffectiveNodeState` exactly as `RuntimeOrchestrator.recompute` does — without the
 * orchestrator itself, which stamps events with the clock the sandbox does not have.
 */
import {
  ComponentTree,
  computeEffectiveNodeState,
  buildComponentIdsByPath,
  buildValuePaths,
  valuesByComponentId,
  type ComponentNode,
  type EffectiveNodeState,
  type FormState,
  type SemanticNodeState
} from "@argusvane/datum-engine/core";
import { RulesSemanticStateResolver, type SemanticResolutionContext } from "@argusvane/datum-engine/runtime";
import {
  buildPdfRenderModel,
  compilePdfDefinition,
  type DataSourceResolver,
  type PdfDocumentInputs,
  type PdfFormulaFunctions,
  type PdfRenderModel,
  type PdfRenditionResolver
} from "@argusvane/datum-engine/render";

function stateFrom(inputs: PdfDocumentInputs): FormState {
  return {
    values: { ...inputs.values },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: inputs.locale
  };
}

function snapshotResolver(snapshot: PdfDocumentInputs["optionSnapshot"]): DataSourceResolver {
  return {
    resolveDataSource: async ({ componentId }) => {
      const items = snapshot?.[componentId];
      return items ? { items } : undefined;
    }
  };
}

/**
 * Effective state per component, from the tree's rules over the values. `today` is the day
 * `today()` reads and `functions` the plugin functions a rule may call;
 * both ride on the resolution context for the resolver's rule contexts. The tree is read as
 * given: a caller compiles its formula strings first (`buildFromInputs` does).
 */
export function computeEffectiveStates(
  root: ComponentNode,
  values: Record<string, unknown>,
  locale: string,
  hostContext: Record<string, unknown> = {},
  today?: string,
  functions?: PdfFormulaFunctions
): Map<string, EffectiveNodeState> {
  const tree = new ComponentTree(root);
  const valuePaths = buildValuePaths(root);
  const resolver = new RulesSemanticStateResolver();
  const context: SemanticResolutionContext = {
    // A rule names fields by component id, wherever a container or a data key stores their
    // answers — the re-keying `RuntimeOrchestrator` makes for the browser.
    values: valuesByComponentId(values, buildComponentIdsByPath(root)),
    locale,
    hostContext,
    ...(today !== undefined ? { today } : {}),
    ...(functions ? { functions } : {}),
    valueOf: (componentId) => values[valuePaths.get(componentId) ?? componentId],
    ancestorValuesFor: (componentId) => {
      const out: Record<string, unknown> = {};
      for (const ancestor of tree.ancestorsOf(componentId)) {
        out[ancestor.id] = values[valuePaths.get(ancestor.id) ?? ancestor.id];
      }
      return out;
    }
  };
  const nodes: ComponentNode[] = [];
  const walk = (node: ComponentNode): void => {
    nodes.push(node);
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child);
      }
    }
  };
  walk(root);
  const semantic = new Map<string, SemanticNodeState>();
  for (const node of nodes) {
    semantic.set(node.id, resolver.resolve(node, context));
  }
  const effective = new Map<string, EffectiveNodeState>();
  for (const node of nodes) {
    const own = semantic.get(node.id)!;
    const chain = tree
      .ancestorsOf(node.id)
      .map((ancestor) => semantic.get(ancestor.id))
      .filter((entry): entry is SemanticNodeState => entry !== undefined);
    effective.set(node.id, computeEffectiveNodeState(own, chain));
  }
  return effective;
}

/**
 * The render model for a `document` or `build` request. The formulas are compiled first, in
 * copies (the request is already the program's own copy), under the request's `formulaErrors`
 * over the form's: the effective states are computed over the compiled tree, so a string rule
 * hides a field as a tree would, and the render model reads the compiled layouts. `functions`
 * is the program's registry of plugin functions (`__datum_pdf_register`).
 */
export async function buildFromInputs(inputs: PdfDocumentInputs, renditions?: PdfRenditionResolver, functions?: PdfFormulaFunctions): Promise<PdfRenderModel> {
  // The definition's `kinds` map reads a plugin's or a binding's type as its base from here on:
  // the effective states and the render model below see the compiled tree with base types.
  const compiled = compilePdfDefinition(inputs.form, inputs.pdf, inputs.layout, { formulaErrors: inputs.formulaErrors, functions, riskyPatterns: inputs.riskyPatterns, kinds: inputs.kinds });
  const effectiveStates = inputs.effectiveStates
    ? new Map(Object.entries(inputs.effectiveStates))
    : computeEffectiveStates(compiled.root, inputs.values, inputs.locale, inputs.hostContext ?? {}, inputs.today, functions);
  const model = await buildPdfRenderModel(
    compiled.root,
    stateFrom(inputs),
    snapshotResolver(inputs.optionSnapshot),
    {
      effectiveStates,
      locale: inputs.locale,
      translations: inputs.formTranslations,
      translationCatalog: inputs.translations
    },
    {
      layout: compiled.layout,
      pdf: compiled.pdf,
      layoutId: inputs.layoutId,
      theme: inputs.theme,
      renditions,
      title: inputs.title,
      hostContext: inputs.hostContext,
      unknownComponents: inputs.unknownComponents,
      attachments: inputs.attachments,
      today: inputs.today,
      formulaErrors: inputs.formulaErrors,
      riskyPatterns: inputs.riskyPatterns,
      functions
    }
  );
  // The render model compiles again; a tree passes through unchanged, so a problem is reported once.
  return compiled.warnings.length > 0 ? { ...model, warnings: [...compiled.warnings, ...model.warnings] } : model;
}
