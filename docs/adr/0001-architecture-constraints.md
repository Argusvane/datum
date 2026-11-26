# ADR 0001: Foundations

## Status
Accepted.

## Context
Datum is a form engine whose one definition (a tree of components with rules, validation, translations and layouts) is filled in a browser, checked again in a WASM sandbox and on a server, printed, and edited by a builder. For those places to agree, the engine holds to a small set of constraints:

- The definition is data, not a UI artifact.
- The state and rules live in a framework-neutral core.
- What is deterministic is deterministic everywhere.
- Each environment has only the privileges it is given.

The rest of the ADRs build on the rules below, which name the module or type a reader can open to see them at work.

## Decision

### The definition is a semantic model
A form is a `ComponentNode` tree (`core/schema/types.ts`), held by `ComponentTree` (`core/tree/component-tree.ts`). It carries meaning (types, configuration, rules, validation), never framework markup. Components are addressed by a stable id (`core/tree/component-id.ts`), never by position, so a move, a reorder or a repeated row does not change what a rule, an error or a translation refers to. Renderers draw the runtime's state; they own no answers of their own.

### The core imports no upper layer
Everything under `engine/form-engine/core` is independent of React, the DOM and every layer above it: builder, render, runtime, data, persistence, plugins, registry, validation and the agent tools. `npm run lint:arch` (`engine/scripts/check-architecture-boundaries.mjs`) walks `core/` and fails when an import names one of those layers or an icon library; it runs first in `npm run ci`. Anything the core shares with a higher layer lives in the core and the higher layer imports it.

### Environments have explicit privileges
Code runs in one of three places: the browser (`runtime/browser`), the WASM sandbox (`validation/wasm`) and a server (`runtime/server`, `validation/server`). Each is handed what it may use and nothing else:

- The sandbox has no ambient authority. `WasmSandboxPolicy` is typed with `allowNetwork`, `allowFilesystem`, `allowProcess` and `allowEnvironment` all `false`; `WasmValidationHost` throws on any other policy before a run, and `WasmValidationHost.STRICT_POLICY` is what the runtime passes. The only way data from outside reaches it is `WasmSubmissionContext.externalData`, which the host resolves beforehand; the host rejects values that are not JSON-serializable and keys outside `allowedExternalDataKeys`. ADR 0029 describes the sandbox.
- Server validation is a hook (`ServerValidationRunner`, `validation/server/server-validation.ts`) that receives only the services a `ServerServicePolicy` allow-list names, and refuses an environment other than `"server"`.
- A data-source provider declares the environments it may resolve in (`DataSourceProvider.environments`); the runtime for an environment rejects a provider that excludes it.

### Rules and validators are deterministic
A rule or a validator marked deterministic is a pure function of explicit inputs: the answers, the locale, the definition, and whatever the host supplies through the context (`ValidationContext`, `RuleEvaluationContext`, including the day `today()` reads). Nothing deterministic reads a clock, the network or ambient state. External input reaches a deterministic stage only as host-supplied context.

A validation error is identified by its code, component, path, stage, source, severity and parameters, never by its message text. `stableErrorSignature` (`validation/core/test-vectors.ts`) turns an error into that canonical string, and `normalizeErrors` sorts the signatures so the order a stage emits them in does not matter. `runParity` (`validation/parity/parity-runner.ts`) runs the same vectors through the browser, sandbox and server adapters and passes a vector only when every adapter produces the same signature list.

`ValidationPipeline` (`validation/core/validation-pipeline.ts`) runs stages in constructor order with every `deterministic` stage ahead of any `async` one; `runDeterministic` runs only the pure stages, synchronously, and throws if one returns a promise. That entry point is what the parity harness uses.

Reasoning: parity between client, sandbox and server is only checkable if the same input yields the same errors everywhere, so determinism is a property of the stage, declared on it, and tested with shared vectors.

### The runtime fixes the order of validation and submission
`FormRuntime` (`runtime/browser/form-runtime.ts`) is the source of truth for values, touched and dirty state and locale. The order of its two flows is fixed, so a host or a plugin can rely on it whichever renderer is attached.

Validation (`validate`):

1. `VALIDATION_STARTED` is published.
2. The `beforeValidation` hooks run.
3. The staged pipeline runs.
4. The errors are stored in `ErrorStore`.
5. The `afterValidation` hooks run.
6. `VALIDATION_COMPLETED` and then `ERRORS_CHANGED` are published.

Submission (`submit`, under a `SubmissionMode` of `{ id, validate, sign, serverValidation }`):

1. `SUBMISSION_STARTED` is published.
2. The `beforeSubmit` hooks run, then the `transformValues` transforms run in order over the answers.
3. When the mode validates, the transformed answers are validated (the flow above, marked as the submission's own). A blocking error ends the submission.
4. When a sandbox host is configured, the sandbox judges the same transformed answers and its sanitized values become the submission from there on. A blocking error, or a sandbox that fails to run, ends the submission: the sandbox fails closed.
5. When the mode asks for `serverValidation` and a runner is configured, the server stage runs over the same snapshot.
6. The hidden-value policy is applied, the journey's end check runs, and `assertEnvelopeComplete` requires the version context to be whole.
7. The payload is canonicalized.
8. Signing runs when the mode or the call asks for it.
9. `SUBMISSION_COMPLETED` is published, post-acceptance submission handlers run (one that throws is isolated and reported; the submission stays accepted), and then the `afterSubmit` hooks run.

A blocking error in any stage returns `{ accepted: false, errors }`, puts the errors in the error store for the renderer to show, and publishes `SUBMISSION_FAILED`, so a host can tell the failing stage (`client`, `wasm`, `server`, `signing`) from the errors' `stage`. Canonicalization, signing and delivery happen only after every required validation stage has passed. A hook or transform that throws settles the submission back to idle and publishes `SUBMISSION_FAILED` with the stage `host`.

Reasoning: one transformed snapshot flows through every stage, so the failure source is unambiguous and the canonical envelope is made only from answers that every required stage accepted.

### A submission is one canonical envelope
`CanonicalSubmission` (`core/submission/canonical-submission.ts`) holds a `versionContext`, the `submission` (`locale`, `values`, and the id of the journey when there was one) and, when signed, `signatures`. `canonicalizeSubmission` sorts object keys recursively by UTF-16 code unit and keeps array order, so insertion order never changes the bytes; the same order is the sandbox kernel's, so every runtime digests the same bytes. The text a signature covers is written in RFC 8785 (`canonicalizeJcs`, `core/submission/jcs.ts`), chosen by `signedCanonicalOf` (see ADR 0063 for the signing format).

`SubmissionVersionContext` records the client (runtime, renderer, schema versions, and the version of each component type and plugin) and the server (runtime, validator, components, plugins) independently, so a server can judge a submission made by a client it did not build.

### Signing is delegated to a provider
The engine canonicalizes and serializes the submission and hands the text to an injected `SigningProvider` (`core/submission/signing.ts`): `sign(request)` takes a `SigningRequest` (`canonical`, `participants`, `modeId`) and returns `SignatureResult[]`.

The engine depends on no cryptography library; the algorithm, the keys and the trust chain are the provider's. `FormRuntimeDependencies` accepts a default `signingProvider` and several `signingProviders`; a submission names one with `SubmitOptions.signWith`. A submission that must be signed (the mode has `sign: true`, or the call names a provider) and has no usable provider is refused as `signing.providerMissing`, and a provider that fails to sign refuses it as `signing.failed`; a submission is never delivered unsigned by accident.

Participants are declared in the definition through the signature capability (`core/schema/signature.ts`). ADR 0061 covers signatures on PDFs and ADR 0063 covers WebAuthn signatures and the signing format.

### Versions, release gates and telemetry
Version ranges (a plugin's `engineRange`, a dependency's `versionRange`) are a small explicit subset of npm semver, implemented in `registry/version-range.ts` with no third-party dependency, with no pre-release or build metadata; the grammar is in `docs/reference/sandbox-abi.md`, "Version ranges".

Cross-environment parity is a release gate, not a convention. `evaluateReleaseGates` (`verification/release-gates.ts`) names the checks (vector parity across the browser, sandbox and server adapters, the performance budgets, the sandbox isolation and plugin failure isolation checks, and PDF render determinism), a release is blocked when any fails, and CI runs it; `docs/releasing.md`, "The engine's release gates", lists them.

Telemetry has a typed contract (`verification/telemetry.ts`): a closed list of metric names and a fixed set of dimensions, validated before a payload is emitted, fed from the runtime's event bus by `attachTelemetry` into a sink the host binds (`docs/reference/development.md`, "Telemetry").

### Plugins install before they initialize, and fail alone
`PluginRegistry` holds plugins by id and version and orders them by dependency (`resolveDependencyOrder`; a cycle is an error). `PluginPlatform.installAndInitialize` (`plugins/platform/plugin-platform.ts`) goes through them in that order:

1. A plugin is rejected, with a `PLUGIN_INCOMPATIBLE` event and the `onIncompatible` hook, when it does not support the install environment, or when the engine version does not satisfy its `engineRange`.
2. Its contributions (components, with the adapters that draw them, capabilities, validators, builder and PDF themes, property editors, data-source providers and data sources, submission handlers, PDF renditions, formula functions) are registered. If any registration throws, the registries are put back to how they were before this plugin and its initialization is skipped.
3. The plugins that installed are initialized by `PluginLifecycle`; a plugin whose `initialize` throws is recorded and the others still run.

A broken plugin therefore cannot block an unrelated one. The result lists the installed, incompatible, initialized and failed plugin ids, together with the hooks, handlers, validators, formula functions and sandbox modules the installed plugins contribute. `FormRuntime` takes the platform's result at startup (`pluginPlatform`), merges the hooks after the host's own, and publishes `PLUGIN_INCOMPATIBLE`, `PLUGIN_INITIALIZE_FAILED` and `PLUGINS_INITIALIZED`. How a plugin is described and discovered is in `docs/plugins/packaging-and-discovery.md`.

### Data sources resolve through providers
A component names a data source by a semantic id (`data.sourceId` by default); it never names an implementation. A `DataSourceProvider` (`core/schema/contracts.ts`) loads items and may declare the environments it can resolve in; a `DataSourceDefinition` maps a source id to a provider id and an optional `defaultQuery`; `RegisteredDataSourceRuntime` resolves the definition, then the provider, and merges the request's query over the default. The environment belongs to the runtime (`RegisteredClientDataSourceRuntime`, `RegisteredServerDataSourceRuntime`) and a request cannot set it: resolving a provider that excludes it throws, and so does resolving a provider id the registry does not hold (`DataSourceProviderRegistry`).

`FormRuntime.resolveDataSource` is the one entry point a renderer uses. An unknown component id throws without an event, as does a component that names a source when the runtime has no data-source runtime; a component that names no source returns `undefined` (so do the nodes a running journey presentation owns, except a worked-out value, which resolves the source of the form field it copies). A source that answers nothing, or fails, throws after publishing `DATA_SOURCE_RESOLVE_FAILED`, and a load that outlasts the timeout is a failure too. The renderer reaches the runtime through a narrow `DataSourceResolver` (`render/core/component-options.ts`), so it knows no provider or registry, and `resolveComponentOptionState` gives it a component's options as a state (`not-applicable`, `loading`, `ready` or `error`; `resolveOptionStatesForTree` pre-resolves a whole tree): a failure is a state a renderer can show, never a silent partial render. `docs/data-sources.md` is the guide for authors and hosts.

### Render modes are registered model builders, and the surfaces style apart
`buildRenderOutput` (`render/core/render-orchestrator.ts`) is the single entry point for a render, selecting a model builder by `RenderMode` (`interactive`, `readonly`, `pdf`). The interactive (`render/react/interactive-renderer.ts`) and read-only (`render/readonly/readonly-renderer.ts`) builders are pure: they take the semantic tree and a state snapshot, resolve option states through the bridge above, and return a deterministic model with no UI framework in sight.

The `pdf` builder is registered by the PDF pipeline with `registerRenderModeAdapter` when it loads; asking for a mode with no builder is an explicit error, never a fallback.

The form is drawn by `<datum-form-renderer>` through a binding inside a shadow root (ADR 0162 to 0164). Builder themes and PDF themes are registered apart, each in its own registry (`BuilderThemeRegistry`, `PdfThemeRegistry`, both over `registry/versioned-theme-registry.ts`), so the three surfaces style themselves independently.

### Accessibility semantics come from the runtime
Accessibility is computed from semantic inputs, not from renderer-local state, so every mode and nesting depth behaves alike.

- `buildAccessibilitySemantics` (`core/accessibility/accessibility-semantics.ts`) gives a field a deterministic id, label id, description, count and error ids, its required, invalid, readonly and disabled state, its label position and text direction, and the ordered `aria-describedby` list (description, count, error). A repeated instance gets its path in the id.
- `buildErrorAnnouncement` and `resolveFirstErrorFocusTarget` (`render/core/error-accessibility.ts`) give a deterministic announcement payload and the first blocking error's focus target, with the tab and step ids to activate first (`resolveErrorNavigationTarget`, `core/errors/error-navigation.ts`), so the error summary can open nested containers before moving focus.
- `nextFocusableId` and `previousFocusableId` (`core/accessibility/keyboard-navigation.ts`) give deterministic next and previous targets, in the standard or the wizard mode.
- A locale or text-direction change is a state change; it never resets values.

The rules a binding follows for assistive technology are in ADR 0162 (what the contract demands of every binding) and ADR 0163 (what the Datum binding does).

### Builder edits are commands
Every change the builder makes to a definition is a `BuilderCommand` with `execute` and `undo` (`builder/history/command-history.ts`) and is run by `TreeEditor` (`builder/tree-editor/tree-editor.ts`): `ADD_COMPONENT`, `REMOVE_COMPONENT`, `MOVE_COMPONENT`, `SET_PROPERTY`, `REMOVE_PROPERTY` and `REPLACE_CONFIGURATION`, plus the commands for rules, whole-component edits and children, and `CompositeCommand` for several as one entry (all-or-nothing).

`CommandHistory` keeps the done and undone stacks; running a new command clears what could be redone. `TreeEditor` publishes a mutation event for each execute, undo and redo, so undo history, audit and collaboration hang on one stream. The tree exposes location lookup and nested configuration path get, set and remove, and the builder has no other way to write to it, which keeps the behavior renderer-agnostic and testable without a DOM.

Whether an add or a move is valid comes from the component's own definition: `canAcceptInSlot` (`builder/tree-editor/slot-constraints.ts`) resolves the parent's slots through the component registry (`createParentConstraintsResolverFromRegistry`) and rejects a child that breaks `multiple`, `max` or `allowedTypes`, a child placed in a leaf, and a form placed inside another component. A type the registry does not know is unconstrained until it is registered.

### The property editor is composed from capabilities
`composePropertyEditor` (`builder/property-editor/editor-composer.ts`) builds a component's editor from the capabilities it declares, each contributing fields, sections and features through `configureEditor`. A component's own `PropertyEditorDefinition` has a `mode`:

- `default`: the capabilities' contributions only.
- `extend`: the capabilities' contributions followed by the component's additions.
- `replace`: the component's editor only.
- `none`: no editor.

The editor changes configuration through `ComponentEditorContext` (`get`, `set`, `remove`, `update`), which routes every write through the `TreeEditor`'s commands when one is supplied, so an edit is part of undo and redo history and never touches renderer state.

Reasoning: a component gets a useful editor by declaring what it can do, a complex component can replace it entirely, and either way the write path is the one the history already covers.

### Drafts are behavior, not only values
A draft (`FormDraft`, `persistence/core/draft-store.ts`) holds the values, the touched and dirty sets, the locale, the navigation (step, visited and completed steps) and the journey position. `FormRuntime.hydrateFromDraft` restores all of it: it checks the draft before changing anything and throws a `DraftError` (`draft.malformed`, `draft.formMismatch` or `draft.incompatible`) rather than half restoring; it recomputes the effective state and revalidates; it runs the `afterDraftLoad` hooks and publishes `DRAFT_LOADED`.

`evaluateDraftCompatibility` requires the draft's schema version to be the runtime's, and its form version to be one the host's `DraftCompatibilityPolicy.allowedFormVersions` lists (any, without a policy).

`DraftStore` (`save`, `load`, `list`, `delete`) is the only persistence the runtime sees, and `load` rejects with `draft.notFound` for an unknown id. The adapters take their storage through an injected contract, so each is tested without the environment and the core carries no storage code: `BrowserLocalDraftStore` over a `StorageLike`, `IndexedDbDraftStore` over an `IndexedDraftRepository`, `ServerDraftStore` over a `DraftServerApi`, and `InMemoryDraftStore`. A draft can also be saved to and read from a file (`persistence/file-draft/draft-file.ts`).

## Consequences
- The core stays portable: the same definition and the same rules run in the browser, the sandbox and a server, and a renderer is replaceable.
- Cross-environment parity is testable, and is a release gate rather than a convention.
- Hosts can rely on the order of events and hooks, on a failing stage being named, and on a submission being canonical, complete and (when required) signed before it is delivered.
- A plugin, a data source, a draft store or a sandbox failing is reported and contained; none stops the form.
- Ordinary evolution is cheap, and a breaking change needs a named handler and shows up in the version context.
