/**
 * The agent tools of `<datum-form>` (WebMCP) as a module reached by dynamic import, so
 * the bundler gives it a lazy chunk (`datum-form-agent-*.js`) beside the renderer bundle. A page
 * turns it on with `features="all agent"` on `<datum-form>`; `agent-loader.ts` fetches it then,
 * and the element hands this module itself and its per-connection signal. Nothing may import
 * this statically from a bundle's entry, and the entries never re-export the engine's agent
 * layer, or it rides in the bundle again.
 *
 * The builder has its own chunk, `builder/agent.ts` (`datum-builder-agent-*.js`): each bundle's
 * agent chunk carries the registrar, the binding and its own catalogue only, so nothing here names the builder beyond the attachment type and the shared
 * types (`BuilderSummary`, `BuilderRegistration`); no builder value (`createBuilderTools`,
 * `createControllerHost`, `shellLoaders`, `BUILDER_AGENT_TOOL_NAMES`, `AGENT_EN` and its
 * lookups) is ever re-exported here. The builder bundle
 * never loads this chunk: `<datum-form>` inside `datum-builder.js` has no agent tools (see
 * `agent-loader.ts`).
 *
 * It is a module of this package's source, reached only by `agent-loader.ts`'s dynamic import
 * and by type from the elements; it is not an export of the published package (the engine's
 * agent layer is `@argusvane/datum-engine/agent`, never the engine root).
 */

// Named, never `export *`: this module is the form chunk's entry, so every name the
// engine's agent barrel gains for the builder (its catalogue, host, loaders and words) would ride
// into datum-form-agent-*.js through a star. Only the form side and the shared layer are listed;
// a new form-side name is added here by hand.
export {
  AGENT_TOOLSET_VERSION,
  FORM_AGENT_TOOL_NAMES,
  INPUT_BYTE_LIMIT,
  NOT_READY_CODES,
  QUEUE_TIMEOUT_MS,
  RESULT_BYTE_LIMIT,
  RESULT_STRING_CAP,
  RETRYABLE_CODES,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_PURPOSE_MAX,
  SESSION_SUMMARY_MAX,
  SESSION_TOOL_ANNOTATIONS,
  SESSION_TOOL_NAMES,
  SESSION_TOOL_TEXTS,
  SHARED_REFUSAL_CODES,
  ToolRefusal,
  agentRegistrarFor,
  bindTools,
  capResult,
  checkInput,
  cleanText,
  createAgentRegistrar,
  createFormAgentTools,
  cutString,
  detectModelContext,
  jsonByteLength,
  pageOf,
  retryableFor,
  runtimeAgentHost,
  sessionToolSchemas
} from "@argusvane/datum-engine/agent";
export type {
  AgentAccessState,
  AgentActionDetail,
  AgentActionPartial,
  AgentCatalogue,
  AgentCatalogueFactory,
  AgentEventType,
  AgentOk,
  AgentRefusal,
  AgentRegistrar,
  AgentRegistrarOptions,
  AgentSessionDetail,
  AgentSessionUi,
  AgentTool,
  AgentToolAnnotations,
  AgentToolResult,
  BindingFailure,
  BindingState,
  BoundRun,
  BuilderRegistration,
  BuilderSummary,
  CappedResult,
  CatalogueLink,
  CatalogueReadiness,
  CheckedInput,
  Field,
  FieldColumn,
  FieldKind,
  FieldRows,
  DownloadPdfToolResult,
  DraftsResult,
  FormAgentBuildState,
  FormAgentDrafts,
  FormAgentDraftStoreKind,
  FormAgentFeature,
  FormAgentHost,
  FormAgentPdf,
  FormAgentSubmitOutcome,
  FormPage,
  FormRegistration,
  FormSummary,
  JournalEntry,
  Kept,
  KeptReason,
  LocaleOption,
  ModelContextLike,
  Option,
  Page,
  PageRef,
  RecordedHostCall,
  Refusal,
  RegisteredToolEntry,
  RegistrarEvent,
  RegistrationEntry,
  RuntimeAgentHost,
  RuntimeAgentHostOptions,
  SchemaProblem,
  SessionEndReason,
  SessionEndedReason,
  SessionHooks,
  SessionState,
  SessionToolName,
  SharedRefusalCode,
  Structure,
  SubmitInfo,
  TargetKind,
  ToolContext,
  ToolData,
  UndoScope,
  UnfillableKind,
  UnregisterReason,
  WhyNotWritable,
  WordedError
} from "@argusvane/datum-engine/agent";
// The provenance account is a core type: the runtime carries it
// into the submit hooks without knowing agents, so it comes from the engine root, as a type only.
export type { AgentProvenance } from "@argusvane/datum-engine";
export { elementAgentHost } from "./agent-host.js";
export { AGENT_HIGHLIGHT_MS, AGENT_HIGHLIGHT_RULE } from "./agent-ui.js";
export type { AgentAttachment, AgentMarks, BuilderAgentAttachment, DatumAgentToolsDetail, FormAgentAttachment } from "./agent-attach.js";

import { agentRegistrarFor, createFormAgentTools } from "@argusvane/datum-engine/agent";

import { attach, type AgentMarks, type FormAgentAttachment } from "./agent-attach.js";
import { elementAgentHost } from "./agent-host.js";
import type { DatumFormElement } from "./form-element.js";

/**
 * Registers a `<datum-form>` with the page's registrar under its per-connection `signal`: the element host, the renderer catalogue, then the browser binding, whose outcome the
 * element reports as `datum-agent-tools`. The handle is the element's `id` when free, else
 * `form-<n>`. `marks` are the element's provenance marks, which the attachment
 * keeps up to date and the element reads after a detach.
 */
export function attachFormAgent(form: DatumFormElement, signal: AbortSignal, marks?: AgentMarks): FormAgentAttachment {
  const registrar = agentRegistrarFor(form.ownerDocument);
  const host = elementAgentHost(form);
  const registration = registrar.registerForm({ host, catalogue: createFormAgentTools, signal, id: form.id });
  return attach(form, "form", registrar, registration, () => host.resetUi(), marks);
}
