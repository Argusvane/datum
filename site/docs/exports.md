# JavaScript exports

`datum-form.js` and `datum-builder.js` are ES modules. Importing one defines its elements and gives you the names below.

- `datum-builder.js` exports everything `datum-form.js` does, so a page that loads the builder needs no second import.
- The classic scripts, `datum-form.iife.js` and `datum-builder.iife.js`, expose the same names as `window.DatumForm` and `window.DatumBuilder`.
- Two more modules define nothing when they load: `datum-engine.js`, the runtime with no element, and `datum-pdf.js`, the PDF kernel. Their names are under [The engine file](#the-engine-file) and [The PDF file](#the-pdf-file).

```js
import { plugins, createFormRuntime, defineDataSources } from "./datum-form.js";
```

Types are listed beside the values they describe. The engine's own types are exported here too, so one import gives a page its typings.

## The form element

| Name | What it is | Page |
|---|---|---|
| `DATUM_FORM_TAG` | The tag name, `"datum-form"`. | [The form element](/form-element) |
| `DatumFormElement`, `defineDatumFormElement` | The element's class, and the function that defines it. Importing the module has already defined it. | [The form element](/form-element) |
| `DatumFormRendererElement`, `defineDatumFormRendererElement` | The inner `<datum-form-renderer>` element and its definer. | [The form element](/form-element) |
| Types `DatumFormSubmitDetail`, `DatumFormChangeDetail`, `DatumFormValidatedDetail`, `DatumFormReadyDetail`, `DatumFormPageChangeDetail`, `DatumFormWasmReadyDetail`, `DatumFormWasmValidatedDetail`, `DatumErrorDetail`, `DatumWarningDetail`, `DatumDownloadDetail`, `DatumPrintDetail`, `DatumFormActionDetail`, `DatumLocaleAppliedDetail`, `DatumLocaleRejectedDetail`, `BindingErrorDetail` | The `detail` of each event. | [Event details](/form-element#event-details) |
| Types `DatumFormChangeOn`, `DatumFormMode`, `DatumFormJourneyOption`, `DatumFormDataSources`, `DatumFormWasmHost`, `DatumFormWasmExternalData`, `DatumFormWasmExternalDataContext` | Types of the element's properties and method results. | [The form element](/form-element) |
| `toFormDefinition` | Checks that a value is a definition and returns it typed; throws a located reason when it is not. | [Definition](/definition) |

## Running a form without the element

`createFormRuntime` builds the engine's runtime for a definition, with no element and no page. It is the entry for a test or a shell of your own. `datum-form.js` needs a DOM when it loads; where there is none, import the same names from `datum-engine.js`.

```js
import { createFormRuntime } from "./datum-form.js";

const runtime = createFormRuntime(definition, { dataSources });
runtime.setValue("fullName", "Ada");
const errors = await runtime.validate();
```

| Name | What it is |
|---|---|
| `createFormRuntime(definition, config)` | Builds a `FormRuntime`. `config` is a `FormRuntimeConfig`: data sources, translations, component definitions, plugins, a draft store, a sandbox host, signing providers, a journey choice, the formula error and risky pattern policies, and `today`. |
| `FormRuntime` | The runtime class: values, validation, submission, drafts, locale, journeys, events. The element hands the same object out as `datum-ready`'s `detail.runtime` and `form.runtime`. |
| `FormRuntimeConfig` | The type of `config`. |
| `EMBED_SUBMISSION_MODE`, `EMBED_RUNTIME_VERSION` | The submission mode the element runs (`"embed"`) and the runtime and renderer version it records in an envelope (`"1.0.0"`). |
| `versionContextFor(definition)` | The `versionContext` an envelope carries for a definition. See [Submissions and replies](/submissions#the-envelope). |
| `FormEventType` | The names of the runtime's events, such as `FormEventType.COMPONENT_CHANGED`, for `runtime.events().subscribe(name, listener)`. Each is the same string as its key, and a plain string subscribes too. Types `FormEvent` and `FormEventListener` describe what a listener is given. |
| `ValidationPipeline`, `createFieldConstraintsStage` | The validation stages a runtime runs, and the stage that checks a field's own constraints. For a runtime built by hand. |
| `createComponentRegistry` | A component registry over the standard catalogue, plugin components and your own. |
| `createFileStorageResolver` | A resolver for where uploaded files are kept, over your own storages plus the built-in base64 one. |
| `FormDefinition`, `FormError`, `HostError`, `ComponentNode`, `ComponentDefinition`, `ComponentPaletteEntry`, `BuilderComponentType` | The definition, error and component types. `FormError` and `HostError` are described under [Event details](/form-element#event-details) and [Setting errors and notices](/form-element#setting-errors-and-notices). |
| `TranslationCatalog`, `ValidationMessageCatalog`, `LocaleOption` | The types of the host's translation and message objects, and of a language the switcher offers. See [Languages](/languages). |

[The engine on its own](/engine) shows the runtime in use and says which names are stable. The runtime's other methods are the engine's own surface and are not described on this site; prefer the element where you can.

## Data sources

| Name | What it is | Page |
|---|---|---|
| `defineDataSources(sources, options)` | Builds one data source set from lists, functions and provider objects. The `dataSources` property does the same for an object. | [Data](/data#supplying-a-source-from-the-page) |
| `DataSourceInputs`, `DataSourceSet` | The types of the object it takes and the set it returns. | [Data](/data) |
| `withPluginDataSources` | Adds the data sources plugins carry behind a set. | |

## Plugins and components

| Name | What it is | Page |
|---|---|---|
| `plugins` | The page's shared plugin registry. `plugins.register(...)` installs a plugin for every form on the page. | [Custom components](/custom-components) |
| `createPluginRegistry`, `createPluginPlatform` | A registry of your own, and the platform that installs plugins into a runtime. | |
| `pluginComponents`, `uniquePlugins` | The component definitions of a list of plugins, and a list without duplicates. | |
| `FormPlugin`, `DatumPluginRegistry`, `PluginRegistration`, `RegisterPluginsOptions`, `PluginPlatformResult` | The plugin and registry types. | |
| `standardComponentDefinitions`, `standardComponentTypes`, `mergeComponentDefinitions` | The standard catalogue, its type names, and a merge of catalogues where a later type replaces an earlier one. | [Custom components](/custom-components) |
| `standardFieldCapabilities`, `cssClassCapability`, `paletteEntriesOf` | What a component type of your own builds its inspector and palette entry from. | [Custom components](/custom-components) |

## Design-system bindings and the Datum look

| Name | What it is | Page |
|---|---|---|
| `bindings` | The registry of bindings by id: `register`, `fromFactory`, `get`, `assets`, `list` and `subscribe`. | [Bindings](/bindings), [Writing a binding](/writing-a-binding) |
| `extendBinding` | A binding with some parts replaced or wrapped. | [Writing a binding](/writing-a-binding) |
| `createDatumBinding`, `composeDatumOptions` | The Datum binding with its tokens, dark set, frames, parts and controls set, and a function that lays option sets over one another. | [Look and chrome](/look) |
| `ASSETS_TRUSTED_TYPES_POLICY` | The name of the Trusted Types policy a binding's script addresses are set through. A page that enforces Trusted Types lists it. | [Security headers](/security-headers) |
| Types `LiveBinding`, `LiveAssets`, `BindingFactory`, `BindingRegistration`, `DatumBinding`, `DatumBindingOptions`, `DatumTokens`, `DatumFrame`, `DatumParts`, `DatumControls`, `DatumFieldOrder`, `AdapterOverride`, `ChromeOverride` | The binding and option types. | [Writing a binding](/writing-a-binding) |

## Themes

| Name | What it is | Page |
|---|---|---|
| `themes` | The registry of builder and PDF themes. | |
| `builderThemes` | The builder's theme registry (`themes.builder`). | [Customising the builder](/customising-the-builder) |
| `pdfThemes` | The PDF theme registry (`themes.pdf`). | [PDFs](/pdf) |
| `createThemeRegistry` | A theme registry of your own. | |
| `DEFAULT_PDF_THEME_ID`, `DEFAULT_BUILDER_THEME_ID`, `PDF_THEMES`, `PDF_THEME_OPTIONS`, `BUILDER_THEMES` | The default ids, and the registered lists. | |
| `resolvePdfThemeInput`, `resolveBuilderTheme` | Turn an id or a definition into the theme it names. | |
| Types `PdfThemeInput`, `PdfThemeChoice`, `PdfThemeRegistration`, `BuilderThemeInput`, `BuilderThemeRegistration`, `RegisteredTheme`, `RegisterThemesOptions`, `DatumThemeRegistry`, `DatumBuilderThemeRegistry`, `DatumPdfThemeRegistry` | The registry types. | |

## Print

| Name | What it is | Page |
|---|---|---|
| `datumPrintTheme`, `basicPrintTheme` | The print themes Datum ships. | [Print](/print) |
| `PRINT_TRUSTED_TYPES_POLICY` | The Trusted Types policy a print theme's HTML is set through. | [Print](/print) |
| Types `PrintTheme`, `PrintContext`, `PrintDrawers`, `PrintModel`, `PrintNode`, `PrintField`, `PrintGroup`, `PrintGrid`, `PrintSection`, `PrintPage`, `PrintPageSize`, `PrintAnswer`, `PrintOption`, `PrintNotice`, `PrintContent`, `PrintWords`, `PrintAssets`, `PrintHtmlValue`, `PrintCallOptions`, `PrintRendition`, `SafeHtml` | What a print theme of your own is written against. | [Print](/print) |

## Icons

| Name | What it is | Page |
|---|---|---|
| `setDefaultIconSet`, `defaultIconSet` | Register and read the icon set the builder draws with. | [Customising the builder](/customising-the-builder) |
| `svgIconSet`, `markupIconSet` | Build an icon set from SVG glyphs or from markup. | [Customising the builder](/customising-the-builder) |
| `BUILTIN_ICONS`, `DATUM_ICON_NAMES`, `isDatumIconName`, `renderIcon`, `ICON_FALLBACK_CLASS` | The built-in set, the list of names a set draws, a check for one, one glyph from a set with the built-in drawing as fallback, and the class the fallback carries. | [Customising the builder](/customising-the-builder) |
| Types `IconSet`, `DatumIconName`, `IconRenderOptions`, `SvgGlyph` | The icon types. | |

## Journeys

| Name | What it is | Page |
|---|---|---|
| `loadJourneyEngine()` | Starts loading the journeys file ahead of the first journey form. It shares one load with the element. A failed load rejects, and the next call asks again. | [Journeys](/journeys) |
| `createFetchJourneyValidator(url, options)`, `JourneyValidationHttpError` | The validator that posts a journey's checks to a URL in the body a Datum host's `POST /api/submissions/validate` takes, as `validate-url` does, and the error it throws for an HTTP failure. | [Journeys](/journeys) |
| `loadJourneyDiagnostics()` | Loads the checker that reports what will not work in a definition's journeys, which `debug` uses. | [Journeys](/journeys) |
| Types `Journey`, `JourneyConfiguration`, `JourneyHostChoice`, `JourneyView`, `JourneyNavigationResult`, `JourneyDiagnostic`, `JourneyServerValidator`, `JourneyValidationRequest`, `JourneyValidationResponse`, `JourneyEngineBundle`, `FetchJourneyValidatorOptions`, `DiagnoseJourneys`, `PageChangeDirection` | The journey types. | [Journeys](/journeys) |

## Features and drafts

| Name | What it is | Page |
|---|---|---|
| `FORM_FEATURES`, `FORM_FEATURE_PRESETS`, `parseFormFeatures` | The feature names, the presets (`all`, `minimal`), and the parser of a `features` value. | [Leaving parts out](/leaving-parts-out) |
| Types `FormFeature`, `FormFeaturesInput`, `ParsedFormFeatures` | The feature types. | |
| `createUrlDraftStore`, `parseDraftStoreSpec` | The server draft store that `draft-store="server:<url>"` builds, and the parser of that value. For a page that builds one itself, to assign as `draftStore`. | [Drafts](/drafts) |
| `DraftStoreSpec` | The parsed value's type. | |
| `serializeDraftFile(draft)`, `parseDraftFile(text)` | The draft as JSON with its keys in a stable order, and the check that reads such a file back into a draft. Use them for a draft file the person downloads and uploads. | [Drafts](/drafts#helpers-for-the-file) |
| Type `FormDraft` | The shape of a draft. | |

## Loading the optional files

| Name | What it is | Page |
|---|---|---|
| `loadPdfSupport`, `resolvePdfModuleUrl` | Load the PDF file and resolve its address. | [PDFs](/pdf) |
| `renderPdf(runtime, options)` | A runtime's form as a PDF, with no element: loads `datum-pdf.js` on its first call and runs [its `renderPdf`](#the-pdf-file). `options.pdf` is the file's address, `"auto"` (beside the bundle) when left out. | [The engine on its own](/engine#a-pdf-from-a-runtime) |
| `loadWasmValidationHost`, `resolveWasmModuleUrl` | Load the sandbox file and resolve its address. | [Validation](/validation) |
| `WasmValidationHost` | The sandbox host class. | [Validation](/validation) |
| Types `DatumPdfSupport`, `RenderPdfOptions`, `CreateWasmValidationHostOptions`, `WasmLogEntry`, `WasmLogLevel`, `WasmPluginModule`, `WasmPluginSource`, `WasmSandboxPolicy` | Their types. | |

## Signing

| Name | What it is | Page |
|---|---|---|
| `createWebAuthnSigningProvider`, `registerCredential`, `requestAssertion` | The passkey signing provider, and the registration and assertion ceremonies. | [Signing with a passkey](/passkey-signing) |
| `verifyWebAuthnSubmission`, `verifyAssertion`, `verifyRegistration` | Verify a signed submission, an assertion and a registration. | [Signing with a passkey](/passkey-signing) |
| `WebAuthnError`, `describeWebAuthnError` | The error class of a failed ceremony, and a function that words one. | [Signing with a passkey](/passkey-signing) |
| `signalApiAvailable`, `signalUnknownCredential`, `signalAllAcceptedCredentials`, `signalCurrentUserDetails` | The browser's Signal API helpers, which tell the browser what the server accepts. | [Signing](/signing) |
| `canonicalizeJcs`, `signedCanonicalOf`, `signedCanonicalForSignature` | The canonical text of a value (RFC 8785), the text a signature covers, and the text one delivered signature covers. | [Submissions and replies](/submissions#the-canonical-form-and-the-digest) |
| `createAgentPdfSigner`, `agentPdfSignerFor`, `listAgentCertificates`, `DEFAULT_PDF_SIGNING_AGENT_URL`, `PdfSigningAgentError` | The hardware-token PDF signer: build one, build one for a listed certificate, list what the token holds, the agent's default address, and its error class. | [Signing](/signing) |
| Types `CanonicalSubmission`, `SignatureResult`, `SignedSubmissionDocument`, `SigningProvider`, `SubmissionCanonicalization`, `SubmissionSigningFormat`, `SubmissionSigningOptions`, `WebAuthnAssertion`, `WebAuthnCredentialRecord`, `WebAuthnRegistrationResult`, `WebAuthnSubmissionVerdict`, `AssertionVerdict`, `RegistrationVerdict`, `PdfSigner`, `PdfSignatureOptions`, `PdfTimestamper`, `PdfSigningAgentCertificate`, `PdfSigningAgentErrorCode`, `PdfSigningAgentInventory` | The signing and envelope types. | [Signing](/signing), [Submissions and replies](/submissions) |

## The engine file

`datum-engine.js` is the runtime with no element.

- It touches no DOM when it loads, so a web worker, a test runner and Node import it as they are.
- It draws nothing: there is no element, renderer or binding in it.
- The journeys runtime is in it, so a form with journeys walks page by page here as it does in `<datum-form>`.

[The engine on its own](/engine) shows it in use.

```js
import { createFormRuntime, FormEventType } from "./datum-engine.js";
```

| Name | What it is |
|---|---|
| `createFormRuntime`, `FormRuntime`, `FormRuntimeConfig`, `createComponentRegistry`, `EMBED_SUBMISSION_MODE`, `EMBED_RUNTIME_VERSION`, `versionContextFor` | The runtime, as under [Running a form without the element](#running-a-form-without-the-element). Here `createFormRuntime` builds every runtime with the journeys runtime. |
| `EagerJourneyEngine` | The journeys runtime itself, which `createFormRuntime` passes for you. Pass it as `journeyEngine` to a `FormRuntime` you build with `new`. |
| `JOURNEY_END` | `"$end"`, the route target that ends a journey. |
| `createFetchJourneyValidator(url, options)`, `JourneyValidationHttpError` | A `journeyServerValidator` that posts each check to a Datum host, and the error it rejects with for a status that is no verdict. See [Checking between pages on the server](/journeys#checking-between-pages-on-the-server). |
| `FormEventType` | The runtime's event names. Types `FormEvent` and `FormEventListener`. |
| `standardComponentDefinitions`, `standardComponentTypes`, `mergeComponentDefinitions`, `standardFieldCapabilities`, `cssClassCapability`, `paletteEntriesOf` | The standard catalogue's definitions: types, defaults and what each validates. Not the drawing, which is the element's. |
| `plugins`, `createPluginRegistry`, `createPluginPlatform`, `pluginComponents`, `uniquePlugins`, `withPluginDataSources` | The plugin registry and its helpers, as in `datum-form.js`. A page that loads both files has one registry. |
| `defineDataSources` | One data source set from lists, functions and providers. |
| `ValidationPipeline`, `createFieldConstraintsStage`, `createFileStorageResolver` | The validation stages and the file storage resolver. |
| `canonicalizeJcs`, `signedCanonicalOf`, `signedCanonicalForSignature` | The envelope's canonical text: see [Submissions and replies](/submissions#the-canonical-form-and-the-digest). |
| `serializeDraftFile`, `parseDraftFile` | The draft file: see [Drafts](/drafts#helpers-for-the-file). |
| `plainHostContext`, `HOST_CONTEXT_MAX_DEPTH`, `HOST_CONTEXT_MAX_VALUES` | The check the element runs on `hostContext`: the value as plain data, with what was left out. |
| `toFormDefinition` | Checks that a value is a definition and returns it typed. |
| Types `FormDefinition`, `FormError`, `HostError`, `ComponentNode`, `ComponentDefinition`, `ComponentPaletteEntry`, `BuilderComponentType`, `TranslationCatalog`, `ValidationMessageCatalog`, `LocaleOption`, `FormPlugin`, `PluginPlatformResult`, `DatumPluginRegistry`, `PluginRegistration`, `RegisterPluginsOptions`, `DataSourceInputs`, `DataSourceSet`, `DraftStore`, `FormDraft`, `PlainHostContext`, `CanonicalSubmission`, `SignedSubmissionDocument`, `SigningProvider`, `SubmissionCanonicalization`, `SubmissionSigningFormat`, `SubmissionSigningOptions`, `SubmissionVersionContext`, `Journey`, `JourneyConfiguration`, `JourneyHostChoice`, `JourneyNavigationResult`, `JourneyServerValidator`, `JourneyValidationRequest`, `JourneyValidationResponse`, `JourneyView`, `PageChangeDirection`, `JourneyPage`, `JourneyPageEntry`, `JourneyPageKind`, `JourneyRoute`, `JourneyValidation`, `JourneyValidationSettings`, `JourneyContinueValidation`, `JourneyServerUnavailable`, `ResolvedJourneyValidation`, `JourneyState`, `JourneyTrace`, `JourneyBlockReason`, `JourneyEngine`, `JourneyChangedEventData`, `PageChangedEventData`, `PageBlockedEventData`, `JourneyCheckEventData`, `JourneyCheckCompletedEventData`, `FetchJourneyValidatorOptions`, `WasmLogEntry`, `WasmLogLevel`, `WasmSandboxPolicy`, `WasmValidationHost` | The types that go with them. |

A form with journeys opens as its journey. `nextPage()`, `previousPage()`, `goToPage(id)`, `journeyView()` and the page's server checks work as the element's do: see [Walking a journey](/engine#walking-a-journey). The journey's drawing is not in the file.

## The PDF file

`datum-pdf.js` is the PDF kernel and its fonts. The element loads it with `pdf="auto"`; a script can import it too, in a page or in Node.

| Name | What it is | Page |
|---|---|---|
| `renderPdf(runtime, options)` | A runtime's form as a PDF: the bytes and the result `<datum-form>`'s `renderPdf()` gives for the same answers, language, layout and theme. The options are the element's, with four more for its properties: `support`, `theme` (an id or a theme), `templates` and `binding`. | [The engine on its own](/engine#a-pdf-from-a-runtime) |
| `createPdfSupport(options)` | The kernel with its fonts loaded, the value `pdfSupport` and `renderPdf`'s `support` take. `fontsUrl` is where the fonts are, `fonts/` beside the file by default. | [PDFs](/pdf) |
| `createInProcessPdfProvider`, `loadFontPack`, `createFontProvider`, `createFaceFontProvider`, `composeFontProviders`, `DEFAULT_FONT_PACK` | The parts `createPdfSupport` is made of, for a support of your own. | [PDFs](/pdf#fonts) |
| Types `DatumPdfSupport`, `CreatePdfSupportOptions`, `RenderPdfOptions` | Their types. | |

## The builder (`datum-builder.js` only)

| Name | What it is | Page |
|---|---|---|
| `DATUM_FORM_BUILDER_TAG`, `DatumFormBuilderElement`, `defineDatumFormBuilderElement` | The `<datum-form-builder>` tag, class and definer. | [The builder element](/builder-element) |
| `DatumBuilderElement`, `defineDatumBuilderElement` | The builder `<datum-form-builder>` is built on, and its definer. | [The builder element](/builder-element) |
| `formDefinitionProblem` | What the builder's own Open refuses beyond `toFormDefinition`, so a page's own Open can refuse the same files with the same reasons. | [Embedding the builder](/embedding-the-builder) |
| `BUILDER_FEATURES`, `BUILDER_FEATURE_PRESETS`, `parseBuilderFeatures`, `normalizeBuilderFeatures` | The builder's feature list, presets, parser and normaliser. | [Embedding the builder](/embedding-the-builder) |
| `BUILDER_WORKSPACES` | The names of the builder's workspaces. | [The builder element](/builder-element) |
| `BUILDER_HOST_CONTROL_STYLES`, `adoptBuilderHostControlStyles` | The styles of the controls a host places beside the builder, and the function that adopts them into a document. | [Embedding the builder](/embedding-the-builder) |
| `createPdfTemplateResolver` | Builds a resolver that finds the PDF file of a template. | [PDFs](/pdf) |
| `JOURNEY_BUILDER_MODE`, `loadJourneyBuilderMode`, `loadPdfBuilderMode` | The journeys mode's name, and the loaders of the journeys and PDF modes, which are separate files of the module build. | |
| Types `DatumFormBuilder...Detail` (`Change`, `FileAction`, `Save`, `ModeChange`, `WorkspaceChange`, `DirtyChange`, `BindingChange`), `DatumJourneyChangeDetail`, `DatumJourneySelectDetail`, `DatumPdfDesignerReadyDetail`, `DatumPdfLayoutChangeDetail`, `DatumPdfLayoutSelectDetail` | The `detail` of the builder and designer events. | [The builder element](/builder-element) |
| Types `DatumFormBuilderFileActions`, `BuilderFileActions`, `BuilderFileActionDetail`, `BuilderFormFile`, `BuilderChangeReason`, `BuilderController`, `BuilderFeature`, `BuilderMode`, `BuilderModeChangeDetail`, `BuilderWorkspace`, `BuilderWorkspaceChangeDetail`, `BuilderCommand`, `BuilderCommandGroup`, `BuilderCommandSource`, `DatumBuilderComponentType`, `DatumBuilderLayout`, `DatumBuilderOptions`, `NewLayoutOptions` | The builder's option and command types. | [The builder element](/builder-element) |
| Types `JourneyBuilderMode`, `JourneyBuilderModeModule`, `JourneyBuilderModeOptions`, `JourneyBuilderModeChangeDetail`, `JourneyBuilderModeSelectDetail`, `JourneyMapLayout`, `JourneyModeView`, `JourneyPreviewRuntime`, `JourneyPreviewRuntimeRequest`, `NewJourneyOptions`, `PdfBuilderMode`, `PdfBuilderModeModule`, `PdfBuilderModeOptions`, `PdfBuilderModeSupport`, `PdfTemplateOption`, `PdfTemplateResolver` | The journeys and PDF modes' types. | |

The engine package is private and ships no files of its own, so everything the engine exposes to a page is in the lists above.
