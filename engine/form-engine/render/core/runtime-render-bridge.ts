import type { AccessibilityConfiguration, ComponentNode, LocalizationConfiguration } from "../../core/schema/types.js";
import type { EventBus } from "../../core/events/event-bus.js";
import type { FormState } from "../../core/state/form-state.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import type { ComponentTree } from "../../core/tree/component-tree.js";
import type { AccessibilityOptions } from "../../core/accessibility/accessibility-semantics.js";
import { DataSourcePending, type DataSourceResolver } from "./component-options.js";
import type { RenderMode, ErrorPresentationConfiguration } from "./render-contracts.js";
import type { DataSourceResult, DataSourceSet, TranslationCatalog } from "../../core/schema/contracts.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";
import type { PdfRenderModelOptions } from "../pdf/pdf-render-model.js";
import type { PdfRenditionResolverOptions } from "../pdf/pdf-renditions.js";
import type { JourneyView } from "../../core/journey/journey-types.js";
import type { PresentationIndex } from "../../core/journey/presentation.js";
import { buildRenderOutput, type RenderOutput } from "./render-orchestrator.js";
import { createHostDataSourceResolver } from "./host-data-sources.js";
import type { JourneyRenderKit } from "./journey-render-kit.js";
import { defaultJourneyRenderKit } from "./journey-render-kit-default.js";
import type { ErrorWordingSources } from "./error-wording.js";

/**
 * The slot a presentation's container sits in on the combined root (`PRESENTATION_SLOT` in
 * `core/journey/presentation.ts`, pinned equal by a test). Spelled here so the bridge does not
 * import the presentation module, which belongs to the journeys chunk.
 */
const PRESENTATION_SLOT = "@presentation";

/**
 * The subset of the runtime that a renderer needs. `FormRuntime` satisfies this
 * structurally, keeping the dependency direction render -> runtime.
 */
export interface RenderableRuntime {
  formRoot(): ComponentNode;
  state(): FormState;
  errors(): FormError[];
  effectiveStatesMap(): ReadonlyMap<string, EffectiveNodeState>;
  requiredMap(): ReadonlyMap<string, boolean>;
  componentTree(): ComponentTree;
  resolveDataSource: DataSourceResolver["resolveDataSource"];
  /** Host-supplied translations (`FormRuntimeDependencies.translationCatalog`), if any. */
  translationCatalog?(): TranslationCatalog | undefined;
  /** The definition's own translations (`FormDefinition.translations`), if any. */
  translations?(): FormTranslations | undefined;
  /**
   * The form's `localization` block, if it declares one. A language switcher offers its
   * `supportedLocales` under their authored labels; a runtime that has no form definition
   * behind it (the builder preview) leaves this out.
   */
  localization?(): LocalizationConfiguration | undefined;
  /** The form's `accessibility` block, if it declares one; `focusFirstError` there is the form's own say on where errors take focus. */
  accessibility?(): AccessibilityConfiguration | undefined;
  /** The form's `pdf` block (its layouts), if the definition declares one. */
  pdfConfiguration?(): PdfConfiguration | undefined;
  /**
   * The registries a PDF's rendition lookup consults beyond the engine's built-ins — the
   * component definitions' own `pdf` renditions and the plugins' contributions.
   * Absent, only the built-in table applies.
   */
  pdfRenditionSources?(): PdfRenditionResolverOptions;
  /** The form definition's id (`FormDefinition.id`), which names a PDF file; absent, the root node's id does. */
  formId?(): string;
  /**
   * The calendar day (`YYYY-MM-DD`) the runtime's rules read through `today()` (formulas,
   * `FormRuntime.today`): what a PDF's rules read too, so the document agrees with the form.
   * Absent, as on the builder canvas's preview, the local calendar date stands in.
   */
  today?(): string;
  /**
   * What the rules' `host.` paths read (`FormRuntime.hostContext`): what a printed form's header
   * and footer read as `{{host.<path>}}` too. Absent, `host.` reads nothing.
   */
  hostContext?(): Record<string, unknown> | undefined;
  /** The runtime's event bus, where `renderFormPdf` publishes `PDF_SIGNED`; absent, nothing is published. */
  events?(): EventBus;
  /**
   * The journey page the form is showing; `undefined` while it runs as the whole
   * form. Absent, as on the builder canvas's preview, the whole form is drawn.
   */
  journeyView?(): JourneyView | undefined;
  /**
   * The answers as they would be submitted, keyed by value path (`FormRuntime.submittableValues`):
   * what a PDF layout's `when` reads to choose the layout when the caller names none.
   * Absent, as on the builder canvas's preview, the state's values stand in.
   */
  submittableValues?(): Record<string, unknown>;
  /**
   * The answers as stored without a presentation's own (`FormRuntime.formValues`):
   * what a host's data source is handed as its context. Absent, the state's values stand in.
   */
  formValues?(): Record<string, unknown>;
  /**
   * The answers as stored with the hidden-value policy applied (`FormRuntime.printableValues`):
   * what a PDF and a printed or read-only copy read, so none shows an answer the submission
   * leaves out. Absent, {@link formValues} stands in.
   */
  printableValues?(): Record<string, unknown>;
  /**
   * What a live journey page is drawn from while the running presentation holds nodes of its
   * own (`FormRuntime.journeyRenderRoot`): the form's root with one more slot, the
   * last, holding the presentation's container. `undefined` when no journey runs or it lists
   * component ids alone. Read for an `interactive` journey page only.
   */
  journeyRenderRoot?(): { root: ComponentNode; tree: ComponentTree } | undefined;
  /**
   * Where the answer of a node the running presentation owns lives (`FormRuntime.presentationValuePathOf`): an alias's and a worked-out value's copy at the form
   * field's value path, any other own field at its `@` key. `undefined` for anything else.
   */
  presentationValuePathOf?(id: string): string | undefined;
  /**
   * The running presentation's own nodes (`FormRuntime.presentationIndex`): read
   * outside the live page, where none is drawn, to put an alias's errors on the form field it
   * fills and leave out any other own node's. `undefined` when none runs.
   */
  presentationIndex?(): Pick<PresentationIndex, "kindOf" | "aliasOf" | "aliases"> | undefined;
  /** The stable keys of every collection's rows by collection path (`FormRuntime.entryKeysByCollection`); the row models carry their entry's. */
  entryKeysByCollection?(): ReadonlyMap<string, readonly string[]>;
}

/**
 * The combined root's reading for a journey page: the root and tree to draw, where
 * each node the presentation owns keeps its answer (the runtime's answer, never re-derived),
 * and which nodes are worked-out values' read-only copies — the nodes the runtime marks
 * `configuration.presentation.kind: "worked-out"` in the presentation's slot.
 */
interface PresentationRender {
  root: ComponentNode;
  tree: ComponentTree;
  valuePathOverrides: Map<string, string>;
  workedOutComponents: Set<string>;
  /** Every node in the presentation's slot: own nodes, placeholders and the container. */
  ownIds: Set<string>;
}

function presentationRender(runtime: RenderableRuntime): PresentationRender | undefined {
  const combined = runtime.journeyRenderRoot?.();
  if (!combined) {
    return undefined;
  }
  const valuePathOverrides = new Map<string, string>();
  const workedOutComponents = new Set<string>();
  const ownIds = new Set<string>();
  const stack: ComponentNode[] = [...(combined.root.children?.[PRESENTATION_SLOT] ?? [])];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    ownIds.add(node.id);
    const path = runtime.presentationValuePathOf?.(node.id);
    if (path !== undefined) {
      valuePathOverrides.set(node.id, path);
    }
    const configuration = node.configuration as Record<string, unknown> | undefined;
    const marker = configuration?.presentation as { kind?: unknown } | undefined;
    if (marker !== null && typeof marker === "object" && marker.kind === "worked-out") {
      workedOutComponents.add(node.id);
    }
    for (const group of Object.values(node.children ?? {})) {
      stack.push(...(group ?? []));
    }
  }
  return { root: combined.root, tree: combined.tree, valuePathOverrides, workedOutComponents, ownIds };
}

export interface RuntimeRenderOptions {
  /**
   * What draws a journey page, forwarded to the render orchestrator and used for the
   * page's errors. Absent, the default kit (eager until the lazy split).
   */
  journeyKit?: JourneyRenderKit | undefined;
  /**
   * Data sources the host defined when wiring the form (`defineDataSources`). Consulted for a
   * component's `data.sourceId` before the runtime's own registered sources.
   */
  dataSources?: DataSourceSet | undefined;
  errorPresentation?: ErrorPresentationConfiguration;
  accessibilityOptions?: AccessibilityOptions;
  /**
   * The page's message catalog and form texts the render model's errors are worded from (see
   * `RenderOrchestratorRequest.wording`); the runtime supplies the definition's translations.
   */
  wording?: ErrorWordingSources;
  interactiveQueryByComponentId?: Record<string, Record<string, unknown>>;
  interactiveSourcePathByComponentId?: Record<string, string>;
  /** For `mode: "pdf"`: the layout, PDF theme and renditions (see `PdfRenderModelOptions`). */
  pdf?: PdfRenderModelOptions;
  /**
   * Render for this locale instead of the runtime's current one: every label, option caption,
   * layout text and the text direction follow it, and the runtime is left as it is. The caller
   * is expected to have checked the form declares it (`FormRuntime.setLocale` refuses one it
   * does not); the bridge itself accepts any code.
   */
  locale?: string | undefined;
  /**
   * The last answer each data source gave, by component id. A build records into it as answers
   * land; with `provisional` set, the build answers from it at once instead of asking (nothing
   * known yet counts as pending: the field is drawn as loading), so a form can be drawn while a slow source is outstanding.
   */
  answerMemo?: Map<string, DataSourceResult | undefined>;
  provisional?: boolean;
}

/**
 * The resolver, recording each answer into the build's memo, or answering from it when
 * provisional. An answer is kept per locale: a remote source answers in the locale it was asked
 * for, so a build for another language must never be drawn from the previous language's answer.
 */
function memoizedResolver(options: RuntimeRenderOptions, inner: DataSourceResolver, locale: string): DataSourceResolver {
  const memo = options.answerMemo;
  if (!memo) {
    return inner;
  }
  const keyOf = (componentId: string): string => `${locale}\u0000${componentId}`;
  if (options.provisional) {
    // A source never answered is pending, not empty: its field is drawn as loading.
    return {
      resolveDataSource: (request) =>
        memo.has(keyOf(request.componentId))
          ? Promise.resolve(memo.get(keyOf(request.componentId)))
          : Promise.reject(new DataSourcePending())
    };
  }
  return {
    resolveDataSource: async (request) => {
      const answer = await inner.resolveDataSource(request);
      memo.set(keyOf(request.componentId), answer);
      return answer;
    }
  };
}

/**
 * Builds a render output for `mode` from a live runtime: current values, errors, effective
 * state, requiredness, and component tree are all pulled from the runtime's public API.
 */
export function buildRuntimeRenderOutput(
  runtime: RenderableRuntime,
  mode: RenderMode,
  options: RuntimeRenderOptions = {}
): Promise<RenderOutput> {
  const translationCatalog = runtime.translationCatalog?.();
  const translations = runtime.translations?.();
  const declared = runtime.accessibility?.()?.focusFirstError;
  const definitionFocusFirstError = typeof declared === "boolean" ? declared : undefined;
  // A journey draws its current page in a live form only: a review, a printed copy and a PDF
  // show every answer the form holds, whatever page the person is on.
  const journey = mode === "interactive" ? runtime.journeyView?.() : undefined;
  // A page of a presentation with nodes of its own is drawn from the combined root;
  // a review, a printed copy and a PDF keep the form's, where no own node is ever drawn.
  const presentation = journey ? presentationRender(runtime) : undefined;
  const current = runtime.state();
  // Own answers are the live page's alone: everything else — a review, a printed copy,
  // a PDF's paths, texts and expressions — reads the form's answers, as a server's copy would.
  // A copy either way: the runtime's own state is never written.
  // A PDF and a printed or read-only copy read them after the hidden-value policy too: a hidden
  // answer the submission leaves out is not printed by a path, a text or an expression either,
  // as the server's copy of the submission never holds it. The live form reads every answer.
  const state = {
    ...current,
    values: presentation
      ? current.values
      : ((mode === "interactive" ? undefined : runtime.printableValues?.()) ?? runtime.formValues?.() ?? current.values),
    locale: options.locale ?? current.locale
  };
  // Nor is an own node drawn there: an alias's errors are the form field's it fills, once, and
  // any other own node's are not shown (the page that draws it is the place for them).
  const index = presentation ? undefined : runtime.presentationIndex?.();
  const errors = index
    ? (options.journeyKit ?? defaultJourneyRenderKit()).pageErrors(
        runtime.errors().filter(({ componentId: id }) => id === undefined || !index.kindOf[id] || index.aliasOf[id]),
        Object.fromEntries(index.aliases.map((alias) => [alias.nodeId, alias.targetId]))
      )
    : runtime.errors();
  return buildRenderOutput({
    mode,
    root: presentation?.root ?? runtime.formRoot(),
    state,
    resolver: memoizedResolver(
      options,
      createHostDataSourceResolver(
      runtime,
      options.dataSources,
      // A host's data source answers the form's components, and a worked-out value's copy (it
      // carries the form field's configuration); a presentation's own field names none.
      presentation
        ? () => ({
            find: (id: string) =>
              presentation.ownIds.has(id) && !presentation.workedOutComponents.has(id) ? undefined : presentation.tree.find(id)
          })
        : () => runtime.componentTree()
      ),
      state.locale
    ),
    errors,
    effectiveStates: runtime.effectiveStatesMap(),
    requiredByComponent: runtime.requiredMap(),
    componentTree: presentation?.tree ?? runtime.componentTree(),
    ...(runtime.entryKeysByCollection ? { entryKeys: runtime.entryKeysByCollection() } : {}),
    ...(presentation
      ? { valuePathOverrides: presentation.valuePathOverrides, workedOutComponents: presentation.workedOutComponents }
      : {}),
    ...(translationCatalog ? { translationCatalog } : {}),
    ...(translations ? { translations } : {}),
    ...(journey ? { journey } : {}),
    ...(options.journeyKit ? { journeyKit: options.journeyKit } : {}),
    ...(options.errorPresentation ? { errorPresentation: options.errorPresentation } : {}),
    // Beneath a host's own setting: the form's say on whether the first error takes focus.
    ...(definitionFocusFirstError !== undefined ? { definitionFocusFirstError } : {}),
    ...(options.accessibilityOptions
      ? { accessibilityOptions: options.accessibilityOptions }
      : {}),
    ...(options.wording ? { wording: options.wording } : {}),
    ...(options.interactiveQueryByComponentId
      ? { interactiveQueryByComponentId: options.interactiveQueryByComponentId }
      : {}),
    ...(options.interactiveSourcePathByComponentId
      ? { interactiveSourcePathByComponentId: options.interactiveSourcePathByComponentId }
      : {}),
    ...(mode === "pdf"
      ? {
          pdf: {
            ...(options.pdf ?? {}),
            pdf: options.pdf?.pdf ?? runtime.pdfConfiguration?.(),
            // A layout's condition reads the runtime's own fold: the answers a
            // submission would carry, after journeys and the hidden-value policy — not the raw
            // state, which still holds an abandoned branch's answers.
            selectionValues: options.pdf?.selectionValues ?? runtime.submittableValues?.()
          }
        }
      : {})
  });
}
