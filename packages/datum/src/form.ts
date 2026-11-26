/**
 * The renderer bundle: `<datum-form>`, defined on load.
 *
 * Built as `dist/datum-form.js` (a module, for `<script type="module">`) and
 * `dist/datum-form.iife.js` (a classic script exposing everything here as `window.DatumForm`).
 * Beside the element it exports what a page needs to go further than attributes: the runtime
 * factory, the standard catalogue, the bindings and themes, and the engine pieces a custom wiring uses.
 */
export {
  DATUM_FORM_TAG,
  DatumFormElement,
  defineDatumFormElement,
  type DatumFormChangeDetail,
  type DatumFormChangeOn,
  type DatumFormDataSources,
  type DatumFormJourneyOption,
  type DatumFormMode,
  type DatumFormPageChangeDetail,
  type DatumFormReadyDetail,
  type DatumFormSubmitDetail,
  type DatumFormValidatedDetail,
  type DatumFormWasmExternalData,
  type DatumFormWasmExternalDataContext,
  type DatumFormWasmHost,
  type DatumFormWasmReadyDetail,
  type DatumFormWasmValidatedDetail
} from "./form-element.js";
export {
  EMBED_RUNTIME_VERSION,
  EMBED_SUBMISSION_MODE,
  createComponentRegistry,
  createFormRuntime,
  versionContextFor,
  type FormRuntimeConfig
} from "./runtime-factory.js";
export {
  mergeComponentDefinitions,
  standardComponentDefinitions,
  standardComponentTypes
} from "./standard-components.js";
// The page's plugin registry: a component library, a validator, a submission
// handler — a `FormPlugin` the host installs and registers here, or hands one element.
export {
  createPluginPlatform,
  createPluginRegistry,
  pluginComponents,
  plugins,
  uniquePlugins,
  withPluginDataSources,
  type DatumPluginRegistry,
  type PluginRegistration,
  type RegisterPluginsOptions
} from "./plugins.js";
// The page's design-system bindings: a binding a host registers once is named by id
// (`<datum-form>`'s `binding`, `<datum-form-builder>`'s `binding`) and drawn by every element on the
// page, beside `builderThemes.register` and `pdfThemes.register`. Registering under an id already held
// replaces it and draws the forms naming it again; the Datum binding is every form's default and is
// never registered.
export const bindings = {
  // `bindings.register(binding, { assets })`: the design system's files the binding draws with
  // wherever it is named by id and given none of its own (a form, the builder's canvas picker).
  register: registerBinding,
  // `bindings.fromFactory(createBinding)`: a binding package's factory called with the page's lit and
  // Datum's binding; the result goes to `register`.
  fromFactory: bindingFromFactory,
  get: bindingById,
  assets: bindingAssetsById,
  list: registeredBindings,
  subscribe: onBindingsChanged
} as const;
export { extendBinding, type BindingErrorDetail, type BindingFactory, type BindingRegistration, type LiveAssets, type LiveBinding } from "@argusvane/datum-engine";
// The Datum binding with its seams set (tokens, the dark set, frames, parts, controls): a host's
// restyled Datum, set on a form (`form.binding = createDatumBinding({ tokens })`) or registered
// under an id of its own. `composeDatumOptions` lays option sets over one another.
export {
  composeDatumOptions,
  createDatumBinding,
  type AdapterOverride,
  type ChromeOverride,
  type DatumBinding,
  type DatumBindingOptions,
  type DatumControls,
  type DatumFieldOrder,
  type DatumFrame,
  type DatumParts,
  type DatumTokens
} from "@argusvane/datum-engine";
// The Trusted Types policy a design system's script addresses (`assets.scripts`) are set through:
// a page that enforces Trusted Types names it in its trusted-types directive.
export { ASSETS_TRUSTED_TYPES_POLICY } from "@argusvane/datum-engine";
// The page's builder-shell and PDF theme registries: the bundles carry the engine's own
// themes; a builder or PDF theme is a package the host installs and registers here.
export {
  DEFAULT_PDF_THEME_ID,
  PDF_THEMES,
  PDF_THEME_OPTIONS,
  builderThemes,
  createThemeRegistry,
  pdfThemes,
  resolvePdfThemeInput,
  themes,
  type RegisteredTheme,
  type BuilderThemeInput,
  type BuilderThemeRegistration,
  type DatumBuilderThemeRegistry,
  type DatumPdfThemeRegistry,
  type DatumThemeRegistry,
  type PdfThemeChoice,
  type PdfThemeInput,
  type PdfThemeRegistration,
  type RegisterThemesOptions
} from "./themes.js";
// A journey's checks with the page's service: what `validate-url` posts through.
// Both are light: the fetch-and-read-back code is a chunk `validate-url` loads.
export {
  JourneyValidationHttpError,
  createFetchJourneyValidator,
  type FetchJourneyValidatorOptions
} from "./server-validator-loader.js";
// What will not work in a definition's journeys as written, in a chunk of its own
// that `debug` loads: the engine's `diagnoseJourneys` is not re-exported here, which would
// carry it in the bundle for every form.
export { loadJourneyDiagnostics, type DiagnoseJourneys } from "./journey-debug.js";
// The journeys runtime: the engine and the render kit a journey form needs, in a chunk
// of its own that nothing fetches until a journey form builds. A host can call this to warm the
// chunk (it shares one load with the element); a failed load rejects as a ChunkLoadError and
// the next call asks again.
export { loadJourneyEngine, type JourneyEngineBundle } from "./journey-engine-loader.js";
export { loadJourneyReview, type JourneyReviewBundle } from "./journey-review-loader.js";
export { toFormDefinition, type DatumErrorDetail, type DatumWarningDetail } from "./support.js";
// Which optional capabilities a form has: the `features` list, and the draft store its
// `draft-store` attribute spells, for a page that builds either itself.
export { FORM_FEATURES, FORM_FEATURE_PRESETS, parseFormFeatures, type FormFeature, type FormFeaturesInput, type ParsedFormFeatures } from "./form-features.js";
export { createUrlDraftStore, parseDraftStoreSpec, type DraftStoreSpec } from "./draft-store-url.js";
// The draft file: a draft as stable JSON a person keeps, and the check that reads it back. Both
// are plain functions over the draft, so a page that keeps files needs no store for them.
export { serializeDraftFile, parseDraftFile, type FormDraft } from "@argusvane/datum-engine";
// `renderPdf(runtime, options)` draws a runtime's form as the element's `renderPdf()` does, with the
// PDF module's own function: the wrapper loads `datum-pdf.js` on its first call, as `pdf="auto"` does.
export { loadPdfSupport, renderPdf, resolvePdfModuleUrl } from "./pdf-loader.js";
export type { DatumPdfSupport, RenderPdfOptions } from "./pdf.js";
// The sandbox is `datum-wasm.js`, loaded by `<datum-form wasm>`; the types alone are here.
export { loadWasmValidationHost, resolveWasmModuleUrl } from "./wasm-loader.js";
export type { CreateWasmValidationHostOptions } from "./wasm.js";

// WebAuthn keeps its names here and leaves its code in a chunk: the
// ceremony and the signing provider are light wrappers that load the chunk on first use, and the
// class, the error wording, `verifyRegistration` and the Signal API helpers (small, and sync or
// instanceof-shaped) come straight from the engine. The real functions, no hop, are the
// package's `./webauthn` subpath, the built `datum-webauthn.js`.
export {
  createWebAuthnSigningProvider,
  registerCredential,
  requestAssertion,
  verifyAssertion,
  verifyWebAuthnSubmission
} from "./webauthn-loader.js";

// The engine surface a page reaches for once attributes are not enough. `standardFieldCapabilities`
// and `cssClassCapability` are what a component type of the page's own builds its inspector from,
// the same way the standard catalogue does.
export {
  BUILTIN_ICONS,
  DATUM_ICON_NAMES,
  DEFAULT_PDF_SIGNING_AGENT_URL,
  DatumFormRendererElement,
  // The runtime's event names (`runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, …)`);
  // the bare strings still subscribe.
  FormEventType,
  FormRuntime,
  ICON_FALLBACK_CLASS,
  PdfSigningAgentError,
  ValidationPipeline,
  WasmValidationHost,
  WebAuthnError,
  agentPdfSignerFor,
  canonicalizeJcs,
  createAgentPdfSigner,
  createFieldConstraintsStage,
  createFileStorageResolver,
  cssClassCapability,
  describeWebAuthnError,
  defaultIconSet,
  defineDataSources,
  defineDatumFormRendererElement,
  isDatumIconName,
  listAgentCertificates,
  markupIconSet,
  paletteEntriesOf,
  renderIcon,
  setDefaultIconSet,
  signalAllAcceptedCredentials,
  signalApiAvailable,
  signalCurrentUserDetails,
  signalUnknownCredential,
  signedCanonicalForSignature,
  signedCanonicalOf,
  standardFieldCapabilities,
  svgIconSet,
  verifyRegistration,
  type AssertionVerdict,
  type RegistrationVerdict,
  type CanonicalSubmission,
  type SignatureResult,
  type SignedSubmissionDocument,
  type SigningProvider,
  type SubmissionCanonicalization,
  type SubmissionSigningFormat,
  type SubmissionSigningOptions,
  type WebAuthnAssertion,
  type WebAuthnCredentialRecord,
  type WebAuthnRegistrationResult,
  type WebAuthnSubmissionVerdict,
  type PdfSignatureOptions,
  type PdfSigner,
  type PdfSigningAgentCertificate,
  type PdfSigningAgentErrorCode,
  type PdfSigningAgentInventory,
  type PdfTimestamper,
  type DatumIconName,
  type IconRenderOptions,
  type IconSet,
  type SvgGlyph,
  type BuilderComponentType,
  type ComponentDefinition,
  type ComponentNode,
  type ComponentPaletteEntry,
  type DataSourceInputs,
  type DataSourceSet,
  type DatumDownloadDetail,
  type DatumFormActionDetail,
  type DatumLocaleAppliedDetail,
  type DatumLocaleRejectedDetail,
  type DatumPrintDetail,
  type FormDefinition,
  type FormError,
  type FormEvent,
  type FormEventListener,
  type FormPlugin,
  type HostError,
  type Journey,
  type JourneyConfiguration,
  type JourneyDiagnostic,
  type JourneyHostChoice,
  type JourneyNavigationResult,
  type JourneyServerValidator,
  type JourneyValidationRequest,
  type JourneyValidationResponse,
  type JourneyView,
  type LocaleOption,
  type PageChangeDirection,
  type PluginPlatformResult,
  type TranslationCatalog,
  type ValidationMessageCatalog,
  type WasmLogEntry,
  type WasmLogLevel,
  type WasmPluginModule,
  type WasmPluginSource,
  type WasmSandboxPolicy
} from "@argusvane/datum-engine";
// Print themes: `<datum-form>.printTheme` takes one. A theme built as a package of its
// own draws through the `html` tag its drawers are handed (`PrintContext`), never a copy it bundles.
export {
  basicPrintTheme,
  datumPrintTheme,
  PRINT_TRUSTED_TYPES_POLICY,
  type PrintAnswer,
  type PrintAssets,
  type PrintCallOptions,
  type PrintContent,
  type PrintContext,
  type PrintDrawers,
  type PrintField,
  type PrintGrid,
  type PrintGroup,
  type PrintHtmlValue,
  type PrintModel,
  type PrintNode,
  type PrintNotice,
  type PrintOption,
  type PrintRun,
  type PrintPage,
  type PrintPageSize,
  type PrintRendition,
  type PrintSection,
  type PrintTheme,
  type PrintWords,
  type SafeHtml
} from "@argusvane/datum-engine";

import { bindingAssetsById, bindingById, bindingFromFactory, registerBinding, registeredBindings, onBindingsChanged } from "@argusvane/datum-engine";
import { defineDatumFormElement } from "./form-element.js";

defineDatumFormElement();
