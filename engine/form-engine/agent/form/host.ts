/**
 * The host seam of the renderer catalogue. Everything the
 * twelve tools need from the page goes through it, so `createFormAgentTools` is pure over a
 * `FormRuntime` and never touches the DOM: the element host (`packages/datum/src/
 * agent-host.ts`) answers with the banner, the live region, `inert` and the renderer's paint
 * promise; the node host here answers at once and records every DOM-facing call into `calls`
 * for the engine tests.
 *
 * `id` is an input: the element's `id` attribute at registration, `""` when
 * none. The handle the envelope carries is the registrar's output; the catalogue never reads
 * `id` to fill a result.
 */

import type { FormError } from "../../core/errors/form-error.js";
import type { AgentProvenance } from "../../core/events/hooks.js";
import type { FormTextCatalog } from "../../core/localization/form-texts.js";
import type { LanguagePack } from "../../core/localization/translations.js";
import type { ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import type { SubmissionVersionContext } from "../../core/submission/canonical-submission.js";
import type { FormNotice } from "../../core/submission/form-notice.js";
import type { DrawingCapabilityId, DrawingSupport } from "../../registry/capabilities/drawing-capabilities.js";
import type { DraftStore, FormDraftSummary } from "../../persistence/core/draft-store.js";
import type { JourneyRenderKit } from "../../render/core/journey-render-kit.js";
import { defaultJourneyRenderKit } from "../../render/core/journey-render-kit-default.js";
import type { RuntimeRenderOptions } from "../../render/core/runtime-render-bridge.js";
import type { DownloadPdfResult } from "../../render/web-component/pdf-download.js";
import type { PdfLayoutOption } from "../../render/web-component/form-renderer-element.js";
import type { FormRuntime, SubmitResult } from "../../runtime/browser/form-runtime.js";

/**
 * The page features a tool asks the host about: nothing reads server validation.
 * `drafts` and `pdf` are answered by the element from its `features` list,
 * so a page that leaves either out gets `feature-off` from `drafts` / `download_pdf`.
 */
export type FormAgentFeature = "translations" | "signing" | "journeys" | "data-sources" | "drafts" | "pdf";

/**
 * Where the form keeps its draft: `browser` (the browser's storage),
 * `server` (a `draft-store="server:<url>"`), `page` (a `draftStore` the page assigned, destination
 * unknown, so assumed to leave the page). The kind is all a result ever says of the store: never
 * its key, URL, origin or error text.
 */
export type FormAgentDraftStoreKind = "browser" | "server" | "page";

/**
 * The form's draft, as `drafts` acts on it. The element answers from
 * `<datum-form>`'s public `saveDraft()` / `restoreDraft()` / `clearDraft()`; the node host from the
 * runtime and the store it was given.
 */
export interface FormAgentDrafts {
  store: FormAgentDraftStoreKind;
  /** Saves the answers now under the form's draft key (the element's `saveDraft()`, which also clears its autosave timer). */
  save(): Promise<FormDraftSummary>;
  /** Puts the saved draft back (the element's `restoreDraft()`); rejects with a `DraftError` (`draft.notFound`, `draft.formMismatch`, `draft.incompatible`, `draft.malformed`) or the store's own error. */
  restore(): Promise<{ updatedAt: number; locale: string }>;
  /** Deletes the saved draft (the element's `clearDraft()`). */
  clear(): Promise<void>;
}

/**
 * The form's PDF, as `download_pdf` acts on it. `download` takes the
 * layout and the language and nothing else: never a layout object, a signature, a host context,
 * render options, attachments, a date, a file name or a theme, so a tool cannot reach the
 * signing or rendering knobs the page set.
 */
export interface FormAgentPdf {
  /** Whether the page signs every PDF it makes (the element's `agentPdfSigns`, read without calling the signer). */
  signed(): boolean;
  /** The form's layouts as a picker lists them (the element's `pdfLayouts()`). */
  layouts(): PdfLayoutOption[];
  /** Renders and hands the file over as the PDF button does (the element's `downloadPdf({ layoutId, locale, agent: true })`). */
  download(options: { layoutId?: string; locale?: string }): Promise<DownloadPdfResult>;
}

/** What the element knows about its build that `form.runtime` does not say. */
export type FormAgentBuildState = "loading" | "failed" | "ready";

/** What `host.submit` hands back: the element's `datum-submit` detail in substance, the runtime's result beside it. */
export interface FormAgentSubmitOutcome {
  accepted: boolean;
  errors: FormError[];
  result?: SubmitResult;
}

/**
 * The banner states the catalogue asks the element host to show . The open
 * variant's `resumed` marks a re-render for a purpose a second `begin_session` changed: the host redraws the banner and moves no focus.
 */
export type AgentSessionUi =
  | { open: true; purpose: string; onStop(): void; resumed?: true }
  | {
      open: false;
      summary?: string;
      undoAvailable: boolean;
      onUndoAll?(): void;
      /**
       * The ended line when a saved draft replaced the answers during the session, worded in the form's language (`agentSessionEndedAfterRestore`):
       * the host shows it beside the summary; with `undoAvailable` false the banner offers
       * Dismiss alone, the builder's pattern.
       */
      restoredNote?: string;
    }
  | { stopped: true; undone: number; onAllowAgain(): void };

export interface FormAgentHost {
  /** The element's `id` attribute at registration (`""` when none); an input to the registrar's handle, never the handle. */
  id: string;
  /** False after the element disconnected or its `features` dropped `agent`. */
  connected(): boolean;
  /**
   * The host's policy for this form's tools: `"always"`
   * registers them live whatever the definition says (the host enforces); `"definition"` lets the
   * definition's `root.configuration.agentTools` decide (`"allowed"` live, `"off"` or absent
   * sealed). Absent answers `"always"`. `"never"` never reaches a host: nothing registers.
   */
  agentAccess?(): "always" | "definition";
  /** The runtime, or `undefined` before the first build. During a rebuild this is the previous runtime (not a readiness signal). */
  runtime(): FormRuntime | undefined;
  /** The element's package-internal build state; the node host answers `"ready"`. */
  buildState(): FormAgentBuildState;
  /**
   * What the render-output memo is built with: its journey kit when
   * `journeys` is allowed, and the host's data sources already wrapped with the renderer's
   * timeout (the memo wraps nothing itself). Never `answerMemo`: the catalogue keeps its own.
   * Return the same `dataSources` object while the renderer's set and timeout are unchanged: the
   * catalogue compares it by identity and a new one clears the answer memo, so a fresh wrapper per
   * call would re-ask every data source on every tool call (memoise the wrap in the element host).
   */
  renderOptions(): Pick<RuntimeRenderOptions, "dataSources" | "journeyKit">;
  /**
   * The id of the binding the page draws the form with (`"datum"` for Datum's own); absent when
   * the host draws nothing (the node host). `describe_form` reports it.
   */
  bindingId?(): string | undefined;
  /**
   * The binding's language pack (its `texts` and `messages` by locale): the layer between the
   * form's `texts` translations and the engine's English, which words the errors and texts an
   * assistant reads the way the person reads them. Absent: the engine's words.
   */
  languagePack?(): LanguagePack | undefined;
  /**
   * What the binding answers for a component type's drawing capabilities (`live.capabilitiesOf`
   * on the element), by capability: `drawn`, `degraded` or `none`. `describe_form` marks a field
   * that uses a capability the binding does not draw. Absent, or `undefined` for a type nothing
   * draws: nothing is marked.
   */
  capabilitiesOf?(type: string): { readonly answers: Readonly<Partial<Record<DrawingCapabilityId, DrawingSupport>>> } | undefined;
  /**
   * The journey render kit the catalogue reads a journey page through (its title, the components
   * it draws): the renderer's drawn kit on the element, which is `NoopJourneyRenderKit` unless
   * `journeys` is allowed and its chunk has loaded. The catalogue never imports
   * `render/core/journey-render.js` itself, so the agent chunk shares no journey code with the
   * journeys chunk.
   */
  journeyKit(): JourneyRenderKit;
  messages?(): ValidationMessageCatalog | undefined;
  texts?(): FormTextCatalog | undefined;
  /** Whether the page's `features` list allows a feature; the node host answers true unless told otherwise. */
  allows(feature: FormAgentFeature): boolean;
  /** The element's `signWith` (a host forcing every submission to sign); absent or empty when none. */
  signWith?(): string | null | undefined;
  /**
   * The element's `submit({ agent: true })`; the node host calls `runtime.submit(modeId,
   * versionContext, { agent: provenance })` (that one key, never
   * `signWith`, `signing` or `trigger`). `provenance` is the catalogue's snapshot taken right
   * before the call, before the runtime resets anything on `SUBMISSION_COMPLETED`;
   * the element leaves it unread, since `<datum-form>`'s `runSubmit` takes the same account from
   * its registration at the same moment and hands it to the runtime and to `datum-submit`.
   */
  submit(options: { agent: true }, provenance?: AgentProvenance): Promise<FormAgentSubmitOutcome>;
  /** The form's draft; `undefined` when the form keeps none (no draft key, or drafts left out). */
  drafts?(): FormAgentDrafts | undefined;
  /** The form's PDF; `undefined` when the page makes no PDF of this form (no `pdf` attribute, no `pdfSupport`). */
  pdf?(): FormAgentPdf | undefined;
  /** The element's `setLocale` (keeps its locale attribute coherent); the node host calls `runtime.setLocale`. */
  setLocale(locale: string): void;
  /** The confirmation notice a host set after delivery, when any. */
  notice?(): FormNotice | undefined;
  /** The renderer's data-source timeout: `get_options` waits this long plus a second for a slow source. */
  dataSourceTimeoutMs(): number;
  /**
   * The value path of the caret control the person is typing in right now, else `undefined`
   * (`document.hasFocus()` true and the deepest active element a caret control).
   * The node host answers what its option says.
   */
  focusedValuePath(): string | undefined;
  /** Resolves once the paint after the latest runtime change has landed (RE `painted()`); the node host resolves at once. */
  painted(): Promise<void>;
  /** Opens the tab holding the first component and highlights every one of them; never focuses. */
  reveal(componentIds: readonly string[]): void;
  /**
   * Scrolls a component into view. The catalogue calls it only outside a
   * session and while `focusedValuePath()` names no caret control; that seam knows caret controls
   * alone, so the host itself leaves the page where it is while any control inside either shadow
   * root has focus (a select, a checkbox, the banner's Stop button): `document.hasFocus()` and the
   * deepest `activeElement`.
   */
  scrollTo?(componentId: string): void;
  /**
   * The journey page change `navigate` is about to ask the runtime for moves no focus and scrolls
   * nothing while the person's focus is outside the form: the element calls the renderer's `quietNextPageFocus()`. The page still
   * paints. Returns the release `navigate` calls once its move settles, so a refused move leaves
   * no quiet for a later page change. Absent on the node host.
   */
  quietPageFocus?(): () => void;
  /** Says `text` in the polite live region. */
  announce(text: string): void;
  /** Shows, replaces or removes the session banner and toggles `inert` on the form body. */
  setSessionUi(state: AgentSessionUi): void;
  /** Commits the person's pending keystroke before the body goes inert (RE `settleInput()`). */
  settleInput?(): void;
  /** True on a host whose `setSessionUi` locks a UI (the element: `inert` + banner); absent on the node host, so `begin_session` reports `locked: false`. */
  locksUi?: true;
  /** Dispatches a `datum-agent-*` event on the element; the node host records it. */
  emit(type: "datum-agent-action" | "datum-agent-session" | "datum-agent-tools", detail: unknown): void;
}

export interface RuntimeAgentHostOptions {
  /** The handle input (the element's `id`); `""` by default. */
  id?: string;
  /** The submission mode `submit` runs; `"embed"` by default (what `<datum-form>` registers). */
  modeId?: string;
  /** The version context `submit` posts; built from the definition when absent. */
  versionContext?: SubmissionVersionContext;
  /** Features the host leaves out: absent features are allowed. */
  allows?: Partial<Record<FormAgentFeature, boolean>>;
  /** The host's forced signing provider id, when any. */
  signWith?: string | null;
  /** What `focusedValuePath()` answers; absent: nothing has focus. */
  focusedValuePath?: () => string | undefined;
  texts?: FormTextCatalog;
  messages?: ValidationMessageCatalog;
  notice?: () => FormNotice | undefined;
  /** What `buildState()` answers; `"ready"` by default. */
  buildState?: () => FormAgentBuildState;
  /** What `connected()` answers; true by default. */
  connected?: () => boolean;
  /**
   * What `agentAccess()` answers; `"always"` by default, so the engine's
   * renderer tests run live over every fixture without a definition flag. The page default
   * (`DEFAULT_AGENT_ACCESS`, `"definition"`) is the element's, not this test and server seam's.
   */
  agentAccess?: "always" | "definition";
  /** The renderer's data-source timeout stand-in; 15 000 ms by default. */
  dataSourceTimeoutMs?: number;
  /** The render options the memo is built with; `{}` by default (the runtime's own sources, the default journey kit). */
  renderOptions?: Pick<RuntimeRenderOptions, "dataSources" | "journeyKit">;
  /** What `bindingId()` answers; absent: the node host names no binding. */
  bindingId?: () => string | undefined;
  /** What `languagePack()` answers; absent: the engine's own words. */
  languagePack?: () => LanguagePack | undefined;
  /** What `capabilitiesOf(type)` answers; absent: nothing is marked as not drawn. */
  capabilitiesOf?: FormAgentHost["capabilitiesOf"];
  /**
   * What `journeyKit()` answers. By default the kit `renderOptions.journeyKit` names, else the
   * render layer's default slot (`defaultJourneyRenderKit()`, the Noop kit until a host or test
   * setup registers one): the same kit the render bridge draws the memo with, so a page's title
   * and members are never read through one kit while its errors are drawn through another. A
   * journey runtime's tests may pass the eager kit (`render/core/journey-render-kit-eager.ts`),
   * as the element hands its loaded one.
   */
  journeyKit?: JourneyRenderKit;
  /** Replaces the runtime `runtime()` answers (a swap mid-test); the given runtime by default. */
  runtime?: () => FormRuntime | undefined;
  /**
   * The form's draft key: with it the node host answers `drafts()` with
   * store kind `"page"`, saving through `runtime.saveDraft(draftKey)` (the runtime's own
   * `draftStore`); without it `drafts()` is `undefined` (`no-drafts`).
   */
  draftKey?: string;
  /**
   * The store the runtime was built with, which restore and clear read and delete through: the
   * runtime keeps its `draftStore` to itself and offers no load or delete of its own (the
   * element reaches its store the same way, beside the runtime).
   */
  draftStore?: DraftStore;
  /** The form's PDF stand-in: absent, `pdf()` is `undefined` (`no-pdf`); `download` rejects with "No PDF support" when not given. */
  pdf?: {
    layouts?: PdfLayoutOption[];
    signed?: boolean;
    download?(options: { layoutId?: string; locale?: string }): Promise<DownloadPdfResult>;
  };
}

export interface RecordedHostCall {
  method: string;
  args: unknown[];
}

/** The node test host: `FormAgentHost` over a bare runtime, every DOM-facing call recorded. */
export interface RuntimeAgentHost extends FormAgentHost {
  calls: RecordedHostCall[];
}

function versionContextOf(runtime: FormRuntime): SubmissionVersionContext {
  const definition = runtime.definition();
  return {
    form: { id: definition.id, version: definition.version },
    client: { runtimeVersion: "agent-test", rendererVersion: "agent-test", schemaVersion: definition.schemaVersion }
  };
}

/**
 * The host the engine tests drive the catalogue through : reads go to the
 * runtime, `submit` calls `runtime.submit(modeId, versionContext, { agent })` with the
 * catalogue's provenance as its only option (no `signWith`, `signing` or `trigger`
 * ever reaches it), drafts and the PDF answer from the options,
 * and everything a browser would show (reveal, announce, banner, events) lands in `calls`.
 */
export function runtimeAgentHost(runtime: FormRuntime, options: RuntimeAgentHostOptions = {}): RuntimeAgentHost {
  const calls: RecordedHostCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const current = options.runtime ?? (() => runtime);
  const live = (): FormRuntime => {
    const now = current();
    if (now === undefined) {
      throw new Error("The form has no runtime");
    }
    return now;
  };
  const store = (): DraftStore => {
    if (options.draftStore === undefined) {
      throw new Error("Draft store is not configured");
    }
    return options.draftStore;
  };
  const draftKey = options.draftKey;
  const drafts: FormAgentDrafts | undefined =
    draftKey === undefined
      ? undefined
      : {
          store: "page",
          save: () => live().saveDraft(draftKey),
          async restore() {
            const draft = await store().load(draftKey);
            await live().hydrateFromDraft(draft);
            // The language the form is in now: a draft naming one the form does not offer leaves the form where it was.
            return { updatedAt: draft.updatedAt, locale: live().state().locale };
          },
          clear: () => store().delete(draftKey)
        };
  const pdfOptions = options.pdf;
  const pdf: FormAgentPdf | undefined =
    pdfOptions === undefined
      ? undefined
      : {
          signed: () => pdfOptions.signed === true,
          layouts: () => [...(pdfOptions.layouts ?? [])],
          download(downloadOptions) {
            record("pdf.download", downloadOptions);
            return pdfOptions.download !== undefined ? pdfOptions.download(downloadOptions) : Promise.reject(new Error("No PDF support"));
          }
        };
  const host: RuntimeAgentHost = {
    id: options.id ?? "",
    calls,
    connected: () => options.connected?.() ?? true,
    agentAccess: () => options.agentAccess ?? "always",
    runtime: () => current(),
    buildState: () => options.buildState?.() ?? "ready",
    renderOptions: () => ({ ...(options.renderOptions ?? {}) }),
    bindingId: () => options.bindingId?.(),
    languagePack: () => options.languagePack?.(),
    capabilitiesOf: (type) => options.capabilitiesOf?.(type),
    journeyKit: () => options.journeyKit ?? options.renderOptions?.journeyKit ?? defaultJourneyRenderKit(),
    messages: () => options.messages,
    texts: () => options.texts,
    allows: (feature) => options.allows?.[feature] !== false,
    signWith: () => options.signWith,
    async submit(submitOptions, provenance) {
      record("submit", submitOptions);
      const runtimeNow = live();
      // The provenance and nothing else: the options object is built here, key by key.
      const result = await runtimeNow.submit(options.modeId ?? "embed", options.versionContext ?? versionContextOf(runtimeNow), provenance !== undefined ? { agent: provenance } : {});
      return { accepted: result.accepted, errors: result.errors, result };
    },
    setLocale(locale) {
      record("setLocale", locale);
      live().setLocale(locale);
    },
    drafts: () => drafts,
    pdf: () => pdf,
    notice: () => options.notice?.(),
    dataSourceTimeoutMs: () => options.dataSourceTimeoutMs ?? 15_000,
    focusedValuePath: () => options.focusedValuePath?.(),
    painted: () => Promise.resolve(),
    reveal(componentIds) {
      record("reveal", [...componentIds]);
    },
    scrollTo(componentId) {
      record("scrollTo", componentId);
    },
    announce(text) {
      record("announce", text);
    },
    setSessionUi(state) {
      record("setSessionUi", state);
    },
    settleInput() {
      record("settleInput");
    },
    emit(type, detail) {
      record("emit", type, detail);
    }
  };
  return host;
}
