import type { ComponentNode } from "../../core/schema/types.js";
import type { FormState } from "../../core/state/form-state.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import type { ComponentTree } from "../../core/tree/component-tree.js";
import type { StepsNavigationState } from "../../core/schema/steps.js";
import type {
  AccessibilityOptions,
  TextDirection
} from "../../core/accessibility/accessibility-semantics.js";
import type { DataSourceResolver } from "./component-options.js";
import type { RenderMode, ErrorPresentationConfiguration } from "./render-contracts.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import {
  resolveErrorPresentationPolicy,
  type ErrorPresentationPolicy
} from "./render-policy.js";
import {
  resolveFirstErrorFocusTarget,
  type ErrorFocusTarget
} from "./error-accessibility.js";
import { isRtlLocale } from "../../core/localization/localized-text.js";
import {
  buildContainerLayouts,
  type ContainerDescriptor,
  type RenderModelContext
} from "./component-model.js";
import {
  buildInteractiveRenderModel,
  type InteractiveRenderModel
} from "../react/interactive-renderer.js";
import {
  buildReadonlyRenderModel,
  type ReadonlyRenderModel
} from "../readonly/readonly-renderer.js";
import type { PdfRenderModel, PdfRenderModelOptions } from "../pdf/pdf-render-model.js";
import type { JourneyView } from "../../core/journey/journey-types.js";
import type { RenderJourneyMeta } from "./journey-render.js";
import type { JourneyRenderKit } from "./journey-render-kit.js";
import { defaultJourneyRenderKit } from "./journey-render-kit-default.js";
import { wordErrorSummary, type ErrorSummaryEntry, type ErrorSummaryFormEntry } from "./error-summary.js";
import type { ErrorWordingSources } from "./error-wording.js";

export interface RenderErrorSummary {
  total: number;
  byComponent: Record<string, number>;
  /**
   * Errors that name no component — a host's "the form could not be sent", an envelope
   * failure — which belong to the form as a whole. `total` counts them; the summary lists
   * them ahead of the per-field entries, with nothing to focus. On a journey page
   * an error on a component the page does not draw — one on another page, off the path, on
   * no page, or named by a server — is listed here too: there is no field on the page to go
   * to, so the summary says it as text and takes focus itself.
   */
  formErrors: FormError[];
  /**
   * The summary worded, blocking errors only (warnings and info are notices, never listed): the
   * heading, the form-level errors as text and one entry per field error with the control it
   * goes to. Empty when the render output carries no component models to word them against.
   * `total`, `byComponent` and `formErrors` keep counting every error.
   */
  heading: string;
  formEntries: ErrorSummaryFormEntry[];
  entries: ErrorSummaryEntry[];
}

export interface RenderOutputMeta {
  presentation: ErrorPresentationPolicy;
  errorSummary: RenderErrorSummary;
  firstErrorFocus: ErrorFocusTarget | undefined;
  /** `"rtl"` when `state.locale` is a right-to-left locale, else `"ltr"`. */
  textDirection: TextDirection;
  /** Layout descriptor for every container node, keyed by component id. */
  containersById: Record<string, ContainerDescriptor>;
  /**
   * The runtime's step navigation as the markup reads it: which step a `steps`
   * container shows, and which its indicator marks visited or completed.
   */
  navigation: StepsNavigationState;
  /**
   * The journey page being drawn, when the form runs as a journey and renders
   * `interactive`; absent, the whole form is drawn. `errorSummary` and `firstErrorFocus` are
   * then the page's: errors on its components as always, the rest as the form's.
   */
  journey?: RenderJourneyMeta;
}

export type RenderModel = InteractiveRenderModel | ReadonlyRenderModel | PdfRenderModel;
export type RenderOutput = RenderModel & { meta: RenderOutputMeta };

export interface RenderOrchestratorRequest {
  mode: RenderMode;
  root: ComponentNode;
  state: FormState;
  resolver: DataSourceResolver;
  /** Current validation errors; grouped onto components and summarized in `meta`. */
  errors?: FormError[];
  /** Effective semantic state per component id (from the runtime orchestrator). */
  effectiveStates?: ReadonlyMap<string, EffectiveNodeState>;
  /** Per-component requiredness from the runtime: `required` OR `rules.requiredWhen`. */
  requiredByComponent?: ReadonlyMap<string, boolean>;
  /** Needed for first-error focus target resolution (tab/step activation ids). */
  componentTree?: ComponentTree;
  errorPresentation?: ErrorPresentationConfiguration;
  /**
   * The definition's `accessibility.focusFirstError`: stands under an `errorPresentation` that
   * sets it and over the engine's default (focus goes to the first error).
   */
  definitionFocusFirstError?: boolean;
  accessibilityOptions?: AccessibilityOptions;
  /**
   * The page's message catalog and form texts, beneath which the definition's own `messages`
   * and the engine's wording apply. Every error on the render model, the summary's entries
   * included, is worded from them in the state's locale.
   */
  wording?: ErrorWordingSources;
  interactiveQueryByComponentId?: Record<string, Record<string, unknown>>;
  interactiveSourcePathByComponentId?: Record<string, string>;
  /** Host-supplied translations (`FormRuntimeDependencies.translationCatalog`), if any; an entry there wins over the definition's. */
  translationCatalog?: TranslationCatalog;
  /** The definition's own translations (`FormDefinition.translations`), if any. */
  translations?: FormTranslations;
  /**
   * For `mode: "pdf"`: which layout, which PDF theme, which renditions.
   */
  pdf?: PdfRenderModelOptions;
  /**
   * The journey page the runtime is showing, `FormRuntime.journeyView()`. Read in
   * `interactive` mode only: a review, a printed copy and a PDF show the whole form. Its
   * `hosts` move a form field's errors onto the node of the page's own that stands
   * for it ({@link journeyPageErrors}).
   */
  journey?: JourneyView | undefined;
  /**
   * What draws a journey page: which components it shows, its errors and its meta.
   * The renderer element hands the kit it loaded; absent, the eager kit. A
   * `NoopJourneyRenderKit` ignores `journey` and draws the form whole.
   */
  journeyKit?: JourneyRenderKit | undefined;
  /**
   * While a presentation with nodes of its own runs and `root` is the runtime's
   * combined root (`FormRuntime.journeyRenderRoot`): where its nodes' answers live, and which
   * of them are worked-out values' copies (`RenderModelContext`). Absent, every path is the
   * tree's.
   */
  valuePathOverrides?: ReadonlyMap<string, string> | undefined;
  workedOutComponents?: ReadonlySet<string> | undefined;
  /** The runtime's stable entry keys by collection path (`FormRuntime.entryKeysByCollection`), carried onto the row models as `row.rowKey`. */
  entryKeys?: ReadonlyMap<string, readonly string[]> | undefined;
}

/**
 * A render-mode adapter: the model builder for one mode, registered rather than
 * imported when the mode is optional. The two HTML modes are built in; the `pdf` mode is
 * registered by the PDF pipeline (`render/pdf/pdf-render-mode.ts`) when it loads, so a
 * renderer that never produces a PDF never carries the PDF model builder.
 */
export type RenderModeAdapter = (
  request: RenderOrchestratorRequest,
  modelContext: Omit<RenderModelContext, "readOnlyByMode">
) => Promise<RenderModel>;

const modeAdapters = new Map<string, RenderModeAdapter>();

/** Registers the model builder for `mode`; returns a function that removes it again. */
export function registerRenderModeAdapter(mode: RenderMode, adapter: RenderModeAdapter): () => void {
  modeAdapters.set(mode, adapter);
  return () => {
    if (modeAdapters.get(mode) === adapter) {
      modeAdapters.delete(mode);
    }
  };
}

export function hasRenderModeAdapter(mode: RenderMode): boolean {
  return modeAdapters.has(mode);
}

const DEFAULT_ERROR_PRESENTATION: ErrorPresentationConfiguration = {
  showComponentErrors: true,
  showErrorSummary: true
};

function groupErrorsByComponent(errors: FormError[]): Map<string, FormError[]> {
  const grouped = new Map<string, FormError[]>();
  for (const error of errors) {
    if (!error.componentId) {
      continue;
    }
    const list = grouped.get(error.componentId);
    if (list) {
      list.push(error);
    } else {
      grouped.set(error.componentId, [error]);
    }
  }
  return grouped;
}

function buildMeta(
  request: RenderOrchestratorRequest,
  errors: FormError[],
  kit: JourneyRenderKit
): { meta: RenderOutputMeta; fieldErrors: FormError[] } {
  // A journey page draws some of the form's components; the rest have no field to go to.
  const journey = request.mode === "interactive" ? request.journey : undefined;
  const onPage = journey ? kit.pageComponentIds(request.root, journey.members, journey) : undefined;
  const journeyMeta = journey
    ? kit.buildMeta(request.root, journey, {
        locale: request.state.locale,
        translations: request.translations,
        translationCatalog: request.translationCatalog,
        effectiveStates: request.effectiveStates
      })
    : undefined;
  const byComponent: Record<string, number> = {};
  const formErrors: FormError[] = [];
  const fieldErrors: FormError[] = [];
  for (const error of errors) {
    if (error.componentId && (!onPage || onPage.has(error.componentId))) {
      fieldErrors.push(error);
    } else {
      formErrors.push(error);
    }
  }
  // The runtime reports errors in the tree's order; a page draws its components in its own. The summary and the first error's focus follow what the person sees, so a
  // page's errors are put in its drawn order — `onPage` holds its ids in that order. A stable
  // sort: one field's errors keep theirs.
  if (onPage) {
    const rank = new Map<string, number>();
    for (const id of onPage) {
      rank.set(id, rank.size);
    }
    fieldErrors.sort((a, b) => (rank.get(a.componentId as string) ?? 0) - (rank.get(b.componentId as string) ?? 0));
  }
  for (const error of fieldErrors) {
    const componentId = error.componentId as string;
    byComponent[componentId] = (byComponent[componentId] ?? 0) + 1;
  }

  const meta: RenderOutputMeta = {
    presentation: resolveErrorPresentationPolicy(
      request.errorPresentation ?? DEFAULT_ERROR_PRESENTATION,
      request.definitionFocusFirstError
    ),
    errorSummary: { total: errors.length, byComponent, formErrors, heading: "", formEntries: [], entries: [] },
    firstErrorFocus: request.componentTree
      ? resolveFirstErrorFocusTarget(onPage ? fieldErrors : errors, request.componentTree)
      : undefined,
    textDirection: isRtlLocale(request.state.locale) ? "rtl" : "ltr",
    containersById: buildContainerLayouts(request.root),
    navigation: {
      currentStepId: request.state.navigation.currentStepId,
      visitedStepIds: [...request.state.navigation.visitedSteps],
      completedStepIds: [...request.state.navigation.completedSteps]
    },
    ...(journeyMeta ? { journey: journeyMeta } : {})
  };
  return { meta, fieldErrors };
}

export async function buildRenderOutput(
  request: RenderOrchestratorRequest
): Promise<RenderOutput> {
  // A journey page shows a form field's errors on the node of its own standing for it.
  const kit = request.journeyKit ?? defaultJourneyRenderKit();
  const errors = kit.pageErrors(request.errors ?? [], request.mode === "interactive" ? request.journey?.hosts : undefined);
  const locale = request.state.locale;
  // A caller-supplied textDirection wins; otherwise it follows the state locale.
  const accessibilityOptions: AccessibilityOptions = {
    textDirection: isRtlLocale(locale) ? "rtl" : "ltr",
    ...request.accessibilityOptions
  };
  const { meta, fieldErrors } = buildMeta(request, errors, kit);
  // A journey page is worded by its journey's texts, and its page's, over the host's.
  const wording: ErrorWordingSources = {
    ...request.wording,
    ...(meta.journey ? { texts: kit.pageTexts(request.wording?.texts, meta.journey.texts) } : {})
  };
  const modelContext: Omit<RenderModelContext, "readOnlyByMode"> = {
    effectiveStates: request.effectiveStates,
    requiredByComponent: request.requiredByComponent,
    errorsByComponent: groupErrorsByComponent(errors),
    accessibilityOptions,
    wording,
    locale,
    translations: request.translations,
    translationCatalog: request.translationCatalog,
    ...(request.valuePathOverrides ? { valuePathOverrides: request.valuePathOverrides } : {}),
    ...(request.workedOutComponents ? { workedOutComponents: request.workedOutComponents } : {}),
    ...(request.entryKeys ? { entryKeys: request.entryKeys } : {})
  };

  // The summary is worded against the finished models: a row's heading, a grid's cell error and
  // the catalogs layered down the parent chain all need the whole list.
  const withSummary = <M extends RenderModel>(model: M): M & { meta: RenderOutputMeta } => {
    if (errors.length > 0) {
      Object.assign(
        meta.errorSummary,
        wordErrorSummary({
          components: model.components,
          byComponent: meta.errorSummary.byComponent,
          fieldErrors,
          formErrors: meta.errorSummary.formErrors,
          locale,
          wording: {
            ...wording,
            locale,
            translations: request.translations,
            translationCatalog: request.translationCatalog
          }
        })
      );
      // The first error goes where the summary's first line does (a row's control, a grid for
      // a cell error no row owns): the summary lists the errors in the order the focus takes the first.
      const first = meta.errorSummary.entries[0];
      if (meta.firstErrorFocus !== undefined && first !== undefined) {
        meta.firstErrorFocus = { ...meta.firstErrorFocus, targetPath: first.targetPath, targetComponentId: first.componentId };
      }
    }
    return { ...model, meta };
  };

  if (request.mode === "interactive") {
    const model = await buildInteractiveRenderModel(
      request.root,
      request.state,
      request.resolver,
      request.interactiveQueryByComponentId,
      request.interactiveSourcePathByComponentId,
      modelContext
    );
    return withSummary(model);
  }

  if (request.mode === "readonly") {
    const model = await buildReadonlyRenderModel(
      request.root,
      request.state,
      request.resolver,
      modelContext
    );
    return withSummary(model);
  }

  const adapter = modeAdapters.get(request.mode);
  if (adapter) {
    const model = await adapter(request, modelContext);
    return withSummary(model);
  }

  if (request.mode === "pdf") {
    throw new Error('Render mode "pdf" is not available: load the PDF pipeline (render/pdf) first');
  }
  throw new Error(`Render mode not implemented: ${request.mode as string}`);
}
