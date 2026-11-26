/**
 * The builder bundle: `<datum-form-builder>` (the HTML and PDF builder in one)
 * and `<datum-form>`, both defined on load.
 *
 * Built as `dist/datum-builder.js` (a module) and `dist/datum-builder.iife.js` (a classic
 * script exposing everything here as `window.DatumBuilder`). A superset of the renderer
 * bundle: the canvas previews through the same renderer, so a page that has the builder has
 * the form as well. The PDF executor (the kernel and its fonts) is a lazy chunk of the module
 * build, fetched on the first preview, and so is the Journeys designer, fetched
 * when the Journeys side is first opened; the PDF and Journeys modes themselves are chunks
 * fetched only for a side that is on; the classic script carries them all inline. What a page
 * wants beyond the engine — a component library, a design-system binding, an icon library — is
 * a bundle it loads beside this one, or a package it registers.
 */
export * from "./form.js";
export {
  DATUM_FORM_BUILDER_TAG,
  DatumFormBuilderElement,
  defineDatumFormBuilderElement,
  type DatumFormBuilderChangeDetail,
  type DatumFormBuilderFileActionDetail,
  type DatumFormBuilderFileActions,
  type DatumFormBuilderSaveDetail,
  type DatumFormBuilderModeChangeDetail,
  type DatumFormBuilderWorkspaceChangeDetail,
  type DatumFormBuilderDirtyChangeDetail,
  type DatumFormBuilderBindingChangeDetail,
  type DatumJourneyChangeDetail,
  type DatumJourneySelectDetail,
  type DatumPdfDesignerReadyDetail,
  type DatumPdfLayoutChangeDetail,
  type DatumPdfLayoutSelectDetail
} from "./builder-element.js";
// What the builder's own Open refuses beyond `toFormDefinition`, for a page's own
// Open to refuse the same files with the same located reasons.
export { formDefinitionProblem } from "./support.js";
export {
  BUILDER_THEMES,
  DEFAULT_BUILDER_THEME_ID,
  DEFAULT_PDF_THEME_ID,
  PDF_THEME_OPTIONS,
  resolveBuilderTheme,
  resolvePdfThemeInput,
  type PdfThemeInput
} from "./themes.js";
export {
  BUILDER_FEATURES,
  BUILDER_FEATURE_PRESETS,
  BUILDER_HOST_CONTROL_STYLES,
  DatumBuilderElement,
  JOURNEY_BUILDER_MODE,
  adoptBuilderHostControlStyles,
  createPdfTemplateResolver,
  defineDatumBuilderElement,
  // The PDF and Journeys modes are chunks of this bundle: a page building its own
  // <datum-builder> awaits the factory (`(await loadPdfBuilderMode()).createPdfBuilderMode`);
  // the engine package keeps exporting both factories directly.
  loadJourneyBuilderMode,
  loadPdfBuilderMode,
  // The builder's `features` list as a model, for a page that wants to read one the way the builder does.
  normalizeBuilderFeatures,
  parseBuilderFeatures,
  type BuilderChangeReason,
  type BuilderController,
  type BuilderFeature,
  type BuilderFileActionDetail,
  type BuilderFileActions,
  type BuilderFormFile,
  type BuilderMode,
  type BuilderModeChangeDetail,
  BUILDER_WORKSPACES,
  type BuilderCommand,
  type BuilderCommandGroup,
  type BuilderCommandSource,
  type BuilderWorkspace,
  type BuilderWorkspaceChangeDetail,
  type DatumBuilderComponentType,
  type DatumBuilderLayout,
  type DatumBuilderOptions,
  type JourneyBuilderMode,
  type JourneyBuilderModeModule,
  type JourneyBuilderModeChangeDetail,
  type JourneyBuilderModeOptions,
  type JourneyBuilderModeSelectDetail,
  type JourneyMapLayout,
  type JourneyModeView,
  type JourneyPreviewRuntime,
  type JourneyPreviewRuntimeRequest,
  type NewJourneyOptions,
  type PdfBuilderMode,
  type PdfBuilderModeModule,
  type PdfBuilderModeOptions,
  type PdfBuilderModeSupport,
  type PdfTemplateOption,
  type PdfTemplateResolver
} from "@argusvane/datum-engine";
// The builder's chrome icons: the engine's own drawings, unless the page
// registered a set before this script ran — an icon package's bundle registers its set on
// load, so a page loads it first for that look — or sets `builder.icons` on one
// element. The API for a set of the page's own (`svgIconSet`, `markupIconSet`,
// `setDefaultIconSet`, `BUILTIN_ICONS`) is exported with the renderer's surface above; this
// bundle carries no icon library.

import { EagerJourneyEngine, EagerJourneyRenderKit, defineDatumBuilderElement, setDefaultJourneyEngine, setDefaultJourneyRenderKit } from "@argusvane/datum-engine";
import { defineDatumFormBuilderElement } from "./builder-element.js";
import { defineDatumFormElement } from "./form-element.js";

// The builder previews journeys through runtimes it builds itself (the Journeys mode, the canvas),
// so this entry names the engine that runs them. The engine package registers nothing
// by being imported, and the renderer entry (form.ts) registers nothing: each <datum-form> hands its
// runtime and renderer the pair it loaded from the journeys chunk, or the Noop pair.
setDefaultJourneyEngine(EagerJourneyEngine);
setDefaultJourneyRenderKit(EagerJourneyRenderKit);

// <datum-form> is defined here by name, not left to the re-export of form.ts above: the build
// treats this package's modules as free of side effects (vite.config.ts, moduleSideEffects), so
// a define that form.ts runs on import is dropped from this bundle, and a page waiting on
// `customElements.whenDefined("datum-form")` after loading the builder alone would wait for ever.
defineDatumFormElement();
defineDatumBuilderElement();
defineDatumFormBuilderElement();
