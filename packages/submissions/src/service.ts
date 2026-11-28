import {
  FORMULA_FUNCTION_NAMES,
  WASM_ABI_VERSION,
  findJourney,
  readJourneyConfiguration,
  formulaFunctionSignatures,
  journeyOwnership,
  journeyPagesOfKey,
  kernelComponentIdsByPath,
  kernelErrorPassesFold,
  kernelCompileDefinition,
  kernelHoldsSecretSource,
  kernelRedactSecretProblems,
  kernelFormulaPolicy,
  kernelNormalizePath,
  kernelParseFormula,
  publicDefinition,
  resolveLocalizedText,
  runInspect,
  submissionEnvelopeOf,
  type CanonicalSubmission,
  type ComponentNode,
  type DefinitionInspectResponse,
  type DefinitionProblem,
  type FormDefinition,
  type FormNotice,
  type FormulaErrorPolicy,
  type FormulaProblem,
  type HostError,
  type Journey,
  type JourneyTrace,
  type ServerServices,
  type ServerValidationRunner,
  type ServerValidationScope,
  type TranslationCatalog,
  type WasmLogEntry,
  type WasmSubmissionContext,
  type WasmSubmissionOutcome,
  type WasmValidationError
} from "@argusvane/datum-engine";

import type { ServerKeys } from "./crypto/server-key.js";
import { bytesDigest, submissionDigest } from "./digest.js";
import type { SubmissionPdfRenderer } from "./pdf/pdf-renderer.js";
import { SUBMISSION_ATTACHMENT_NAME, buildSubmissionAttachment } from "./pdf/submission-attachment.js";
import { recordValuesOf } from "./record-values.js";
import { bestTemplateLayout, extractFromAttachment, extractFromTemplateFields, type ExtractedSubmission } from "./pdf/extract.js";
import { aggregate, type AggregateResult, type AggregateSpec } from "./aggregate/aggregate.js";
import { walkValueFields } from "./aggregate/field-index.js";
import { recordsToCsv, recordsToJson } from "./export/csv.js";
import { parseSubmissionDocument, type ParsedSubmissionDocument } from "./signatures/document.js";
import { inspectEnvelopeSignatures, summarize, type EnvelopeSignatureReport, type EnvelopeVerifierDeps } from "./signatures/envelope.js";
import { inspectPdfSignatures, type PdfSignatureReportSet } from "./signatures/pdf.js";
import type { SubmissionStore } from "./store/submission-store.js";
import {
  DEFAULT_SUBMISSION_SETTINGS,
  RUN_FAILED_CODES,
  SubmissionServiceError,
  catalogKeyOf,
  type CatalogKey,
  type DeliveredDocument,
  type FormCatalogEntry,
  type FormCatalogSummary,
  type OptionSnapshot,
  type OptionSnapshotProvider,
  type Page,
  type RecordListOptions,
  type RunFailedCode,
  type SignatureStatusSummary,
  type StoredPdf,
  type SubmissionRecord,
  type SubmissionSettings,
  type SubmissionSource
} from "./types.js";
import { warnDevelopmentOnly } from "./development-warning.js";
import { isSubmissionOutcome, type SubmissionValidator } from "./validation/validator.js";

/**
 * The submissions server as one object: what an HTTP host's routes call, and what
 * the Data tab calls directly. It owns the order of things on receipt — find the form, judge
 * the answers in the sandbox and then by the server's own hooks, digest, render and sign the
 * PDF if asked, write the record, word the receipt — and nothing about where the pieces run:
 * the store, the validator, the hooks, the PDF renderer and the keys are handed in.
 */
export interface SubmissionServiceDeps {
  store: SubmissionStore;
  validator: SubmissionValidator;
  /** Without one, `pdf.enabled` settings are kept but no PDF is rendered, and the record's warnings say so. */
  pdf?: SubmissionPdfRenderer;
  /** The server's signing identity; without one, `pdf.sign` produces an unsigned PDF with a warning. */
  keys?: ServerKeys;
  /** The relying-party context signatures on an envelope are checked against; without it, signatures are reported unverifiable. */
  envelopeVerifier?: EnvelopeVerifierDeps;
  /** Certificates this server trusts on PDFs beside its own, DER base64. */
  trustedCertificates?: readonly string[];
  /**
   * The server's own checks: hooks that need what only the server holds — its
   * records, a registry, a secret — which no browser and no sandbox can run. `receive` and
   * `validate` both run them after the sandbox, over the values it sanitized, with the scope
   * of the check, and only when the sandbox found nothing blocking in that scope. A hook that
   * throws refuses the call (`validator_unavailable`, a 503) and nothing is kept.
   */
  serverValidationRunner?: ServerValidationRunner;
  /** The services the hooks read (`context.services`), asked for on every run; none when absent. */
  serverServicesProvider?: () => ServerServices;
  /**
   * The options the form's data sources hold, worked out for each judgement (the server's side
   * of the sandbox's option snapshot): a provider, because a list may depend on the answers, the
   * locale or the day. Merged over `settings.validation.optionSnapshot` (the provider's list wins
   * per source). Neither given, the sandbox gets no snapshot and refuses every answer to a choice
   * that names a data source. A provider that throws refuses the call (`validator_unavailable`).
   */
  optionSnapshot?: OptionSnapshotProvider;
  /**
   * The host's translation catalog: locale to kind to owner
   * to property, string leaves, the shape the browser runtime reads. Handed to every run as the
   * context's `catalog` so a message the server words (a pattern message, a rule's text) resolves
   * through the same ladder as the browser's, catalog over the definition's own map; left out of
   * the context when absent or empty (a host passes it only when it holds something). The form's
   * own tests (`__datum_inspect` `test`) stay map-only and never see it.
   */
  translationCatalog?: TranslationCatalog;
  clock?: () => Date;
  /**
   * The calendar day formulas read through `today()`, as `YYYY-MM-DD`. Absent, the local
   * calendar date of `clock()`. One value per judgement: the sandbox and the server's own fold
   * read the same day, and a delivery judged across midnight does not disagree with itself.
   */
  today?: () => string;
  ids?: () => string;
  subtle?: SubtleCrypto;
  /**
   * The most a delivered body may hold, in UTF-8 bytes of its JSON, so one delivery cannot exhaust
   * the server's memory. A larger one is refused before anything is judged or kept
   * (`payload_too_large`, a 413). Default {@link DEFAULT_MAX_BODY_BYTES} (1 MiB); a host that
   * takes file uploads inline raises it. `Infinity` turns the check off.
   */
  maxBodyBytes?: number;
}

/** The default for {@link SubmissionServiceDeps.maxBodyBytes}: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * How deep a delivered body may nest (objects and lists, the body itself the first level). An
 * honest one is a few levels and a data-scoping container stores nothing past 16; the sandbox
 * refuses a request nested past 320 before it parses it, and this leaves room under that for the
 * envelope and the run's context around the body, so every validator and the in-process kernel
 * refuse the same bodies, as the filler's (`bad_document`), never an outage.
 */
export const MAX_BODY_DEPTH = 256;

/**
 * Refuses a body nested past {@link MAX_BODY_DEPTH}, walked without recursion and before anything
 * stringifies or digests it: a body a few hundred thousand levels deep (still under the size cap)
 * would otherwise overflow the stack of every recursive reader after it.
 */
function checkBodyDepth(body: unknown): void {
  const pending: Array<{ value: object; depth: number }> = [];
  if (body !== null && typeof body === "object") {
    pending.push({ value: body, depth: 1 });
  }
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.depth > MAX_BODY_DEPTH) {
      throw new SubmissionServiceError("bad_document", `The body nests deeper than ${MAX_BODY_DEPTH} levels.`);
    }
    for (const child of Array.isArray(next.value) ? next.value : Object.values(next.value)) {
      if (child !== null && typeof child === "object") {
        pending.push({ value: child as object, depth: next.depth + 1 });
      }
    }
  }
}

/**
 * What a form delivers, or what a host receives on another channel with the form already known —
 * with the journey the answers were given through, when there was one.
 */
export type DeliveryInput =
  | { document: DeliveredDocument }
  | { formId: string; formVersion: string; values: Record<string, unknown>; locale?: string; journeyId?: string };

/**
 * What a submission key looks like: what the browser mints once per submit attempt (a UUID), or a
 * key another channel makes the same way (an import keys on the file it read): 1 to 128 letters,
 * digits, `.`, `_`, `:` and `-`, starting with a letter or digit.
 */
export const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A delivery and the key of the submit attempt it belongs to. The key, not the answers,
 * says whether two deliveries are one submission: a retry of the same attempt (a double click, a
 * proxy's repeat) carries the same key and document and is answered with the first record; two
 * people who give the same answers send two keys and are two records; a known key with another
 * document is refused (`submission.keyConflict`).
 */
export type ReceiveInput = DeliveryInput & { submissionKey: string };

/**
 * What the server knows of a request beside its body, for one `receive` or `validate`: the values
 * the form's `host.` paths read (`host.role`, `host.region`), worked out by the host from its own
 * session, never from the browser (whose `hostContext` is for display, and could say anything).
 * A plain JSON object: copied through JSON before the sandbox reads it. Left out, a rule reading
 * `host.` is not judged (lenient: the field keeps its configured state, a calculation is kept as
 * sent); given, the sandbox judges every such rule against it, a key it lacks reading as no answer.
 */
export interface JudgeOptions {
  hostContext?: Record<string, unknown>;
}

export interface ReceiveResult {
  record: SubmissionRecord;
  /** For the form to show, when the record was accepted. */
  receipt?: FormNotice;
  /** For the form to show (`setErrors`), when it was not. */
  errors: HostError[];
}

/**
 * What {@link SubmissionService.validate} checks: what `receive` takes, and how much of it. No scope, or `"journey"`, judges everything, as `receive` would. `"page"` judges
 * one page of the journey the input names, `pageId`: the verdict holds only the errors on that
 * page's components and those on the form as a whole. The values are every submittable answer
 * either way, so the server works the path out from all of them, as the browser did.
 */
export type ValidateInput = DeliveryInput & { scope?: "page" | "journey"; pageId?: string; submissionKey?: string };

/** What {@link SubmissionService.validate} answers: `receive`'s verdict, with nothing stored. */
export interface ValidationVerdict {
  /** Nothing in `errors` has severity `"error"` (an entry without one counts as an error). */
  accepted: boolean;
  /** Everything found in scope, warnings included, as `receive` words them (`setErrors`). */
  errors: HostError[];
  /**
   * The path the server worked out from the values, when the input names a journey the form
   * has: for diagnostics (a browser whose path differs has other answers), never to navigate by.
   */
  journey?: { pages: string[]; end: "end" | "exit" };
}

export interface RecordInspection {
  envelope: EnvelopeSignatureReport;
  /** When the record has a PDF. */
  pdf?: PdfSignatureReportSet;
}

/** A file inspected without being stored: what it was, what its signatures say, which record it matches when one does. */
export interface DocumentInspection {
  kind: ParsedSubmissionDocument["kind"] | "pdf";
  /** The form the document names, when it names one. */
  formKey?: CatalogKey;
  /** Whether that form is in the catalog. */
  registered?: boolean;
  digest?: string;
  /** A stored record with the same digest, when there is one. */
  recordId?: string;
  envelope?: EnvelopeSignatureReport;
  pdf?: PdfSignatureReportSet;
  /** For a PDF: whether it carries `submission.json`, and the record it names when it does. */
  carriesSubmission?: boolean;
}

export type InspectDocumentInput = { kind: "json"; text: string } | { kind: "pdf"; bytes: Uint8Array; fileName?: string };

export interface ImportResult {
  record: SubmissionRecord;
  method: ExtractedSubmission["method"];
  /** For the form to show, as `receive` words it. */
  receipt?: FormNotice;
  errors: HostError[];
  /** What could not be read back, and whether a record with the same digest was already here. */
  notes: string[];
}

export interface SubmissionService {
  /**
   * Registers a form: the definition as given is kept untouched, with a compiled copy beside it
   * (formula strings turned into trees). Formulas that do not parse follow the policy
   * (`settings.validation.formulaErrors`, else the form's `configuration.formulaErrors`, else
   * `"fail"`): `"fail"` refuses (`invalid_definition`, nothing stored); `"warn"`, the
   * explicit opt-in, registers and lists the
   * problems on the entry (`formulaProblems`).
   */
  register(definition: FormDefinition, settings?: Partial<SubmissionSettings>, options?: RegisterOptions): Promise<FormCatalogEntry>;
  /**
   * What a host serves to a browser for this form: the definition as registered without its
   * `server-secret` rules. `judge` (receive and validate) still uses the full one, so a secret
   * rule is enforced here and never shown. Refuses an unknown form (`unknown_form`).
   */
  publicDefinition(key: CatalogKey): Promise<FormDefinition>;
  /**
   * One of the sandbox's three questions about the registered definition, answered
   * by the same kernel code every host runs: `public` (what {@link publicDefinition} serves),
   * `check` (the compile's problems, the policy — the server's setting over the form's own —
   * and the verdict) or `inspect` (every component rule with its scope, reads and calls, the
   * functions used, the ones no built-in provides). Refuses an unknown form (`unknown_form`)
   * and an op that is none of the three (`bad_document`).
   */
  inspect(key: CatalogKey, op: InspectOp): Promise<DefinitionInspection>;
  getEntry(key: CatalogKey): Promise<FormCatalogEntry | undefined>;
  /**
   * The forms with their counts, as a host may show them to any caller: each entry's `definition`
   * and `compiled` copy are the public ones (the `server-secret` rules removed, as
   * {@link publicDefinition} serves them), its `formulaProblems` carry no text for a secret rule,
   * and the static `settings.validation.optionSnapshot` is left out. The HTTP
   * route `GET /api/forms` answers with this. The host that registered the forms and needs the
   * entries whole (secrets and all) calls {@link listCatalogFull}.
   */
  listCatalog(): Promise<FormCatalogSummary[]>;
  /** {@link listCatalog} with each entry exactly as registered: for the registering host, never for a route a browser can reach. */
  listCatalogFull(): Promise<FormCatalogSummary[]>;
  updateSettings(key: CatalogKey, patch: SettingsPatch): Promise<FormCatalogEntry>;
  deleteEntry(key: CatalogKey, options?: { cascade?: boolean }): Promise<void>;

  /**
   * Judges a delivery and keeps it: accepted when nothing found has severity `"error"`, so a
   * record may carry warnings. Refuses (`bad_document`) a body that asks
   * for a check — one with `scope` or `pageId` — so a journey's checks sent here by mistake
   * never write records.
   */
  receive(input: ReceiveInput, options?: { source?: SubmissionSource } & JudgeOptions): Promise<ReceiveResult>;
  /**
   * `receive`'s checks and verdict without keeping anything: the form looked up, the
   * journey found, the answers judged in the sandbox and by the server's hooks — no record, no
   * PDF, no digest. What a journey asks on Continue (`scope: "page"`) and before its final
   * Submit (`scope: "journey"`). A page check without a journey, or naming a page the journey
   * does not have, is refused (`bad_document`).
   */
  validate(input: ValidateInput, options?: JudgeOptions): Promise<ValidationVerdict>;
  listRecords(options?: RecordListOptions): Promise<Page<SubmissionRecord>>;
  getRecord(id: string): Promise<SubmissionRecord | undefined>;
  deleteRecord(id: string): Promise<void>;

  /** Statistics over a form's records (accepted ones unless the spec says otherwise). */
  aggregate(key: CatalogKey, spec?: AggregateSpec): Promise<AggregateResult>;
  /** A form's accepted records as a file: CSV with a column per field, or JSON. */
  exportRecords(key: CatalogKey, format: "csv" | "json", options?: { includeRejected?: boolean }): Promise<{ text: string; fileName: string; mimeType: string }>;

  /** The server's PDF for a record, or nothing when it has none. */
  getPdf(id: string): Promise<{ bytes: Uint8Array; fileName: string; mimeType: string } | undefined>;
  /** A server PDF back into a record: its `record.json`, else its template fields through a registered layout's mapping. */
  importPdf(bytes: Uint8Array, options?: { fileName?: string; source?: SubmissionSource; formKey?: CatalogKey }): Promise<ImportResult>;
  inspectRecord(id: string): Promise<RecordInspection>;
  inspectDocument(input: InspectDocumentInput): Promise<DocumentInspection>;

  /** The server's signing certificate, once it has one. */
  serverCertificate(): Promise<{ der: string; subject: string; createdAt: string } | undefined>;
  /** Mints the identity if there is none yet, and hands back the PEMs. */
  exportServerKey(): Promise<{ certificatePem: string; privateKeyPem: string; subject: string }>;
}

/** A partial settings document: each section merged over what is there. */
/** The questions {@link SubmissionService.inspect} answers. */
export type InspectOp = "public" | "check" | "inspect";

/** A successful answer from {@link SubmissionService.inspect}: the sandbox's own shape, errors raised instead. */
export type DefinitionInspection = Extract<DefinitionInspectResponse, { ok: true }>;

export interface SettingsPatch {
  validation?: Partial<SubmissionSettings["validation"]>;
  pdf?: Partial<NonNullable<SubmissionSettings["pdf"]>> | null;
  receipt?: Partial<SubmissionSettings["receipt"]>;
}

function titleOf(definition: FormDefinition): string | undefined {
  const title = (definition.root.configuration as { title?: unknown } | undefined)?.title;
  return typeof title === "string" && title.trim() ? title : undefined;
}

/**
 * A host context that is no plain object of JSON values: the host's mistake, never the filler's, so
 * it is a `TypeError` for the programmer. It carries the wire's word for it (`server.unavailable`) so
 * {@link errorResponse} answers it 503 where a host's provider failing is answered the same way.
 */
export class HostContextError extends TypeError {
  readonly code = "server.unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "HostContextError";
  }
}

/**
 * A host context as the sandbox reads it ({@link JudgeOptions}): a plain object, copied through JSON
 * so the in-process kernel and a sandbox program read the same data (a function left out, `NaN` as
 * `null`). `undefined` stays undefined; anything that is no plain object is the host's mistake, and
 * refused as one (a {@link HostContextError}, not a verdict on the filler's answers).
 */
function plainHostContext(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HostContextError("hostContext must be a plain object of JSON values");
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** The local calendar date of a moment, `YYYY-MM-DD`: the day a person at the server's clock would write. */
function localCalendarDate(moment: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(moment.getFullYear(), 4)}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/** The policy for a form: the server's setting, else the form's own word, else `"warn"`. */
function policyOf(definition: FormDefinition, settings: SubmissionSettings): FormulaErrorPolicy {
  return kernelFormulaPolicy(definition.root.configuration, settings.validation.formulaErrors);
}

/**
 * A compiled copy of a definition and what did not parse in it. Never changes the definition:
 * the copy shares what it does not rewrite, so nothing here is written to.
 */
function compileDefinition(definition: FormDefinition, riskyPatterns?: "refuse" | "allow"): { compiled: FormDefinition; problems: FormulaProblem[] } {
  const result = kernelCompileDefinition(definition.root, definition.journey, definition.pdf, kernelParseFormula, formulaFunctionSignatures(), riskyPatterns);
  const { root, journey, pdf } = result.definition as { root: FormDefinition["root"]; journey: FormDefinition["journey"]; pdf: FormDefinition["pdf"] };
  const compiled: FormDefinition = {
    ...definition,
    root,
    ...(journey !== undefined ? { journey } : {}),
    ...(pdf !== undefined ? { pdf } : {})
  };
  return { compiled, problems: result.problems };
}

/**
 * The kernel's structural check of a definition about to be registered. Throws
 * `invalid_definition` (422) when the request is unusable (not an object, `definition.tooDeep`) or
 * the answer holds a structure refusal; otherwise returns the structure warnings. The formula
 * findings of the same answer are not used here: `register` reads them from its own compile.
 */
function checkStructure(definition: FormDefinition, settings: Partial<SubmissionSettings> | undefined, options: RegisterOptions): DefinitionProblem[] {
  const hostPolicy = settings?.validation?.formulaErrors;
  const risky = settings?.validation?.riskyPatterns;
  const answer = runInspect(
    {
      abi: WASM_ABI_VERSION,
      op: "check",
      definition,
      ...(hostPolicy !== undefined ? { formulaErrors: hostPolicy } : {}),
      ...(risky !== undefined ? { riskyPatterns: risky } : {}),
      ...(options.componentTypes !== undefined ? { types: options.componentTypes } : {})
    },
    formulaFunctionSignatures(),
    [...FORMULA_FUNCTION_NAMES]
  );
  if (!answer.ok) {
    throw new SubmissionServiceError("invalid_definition", `The definition cannot be registered: ${answer.error.message}`);
  }
  if (answer.op === "check" && answer.structure.length > 0) {
    const shown = answer.structure.slice(0, 10).map((problem) => `${problem.where === "" ? problem.code : `${problem.code} at ${problem.where}`}: ${problem.message ?? ""}`.trim());
    const more = answer.structure.length > shown.length ? ` (and ${answer.structure.length - shown.length} more)` : "";
    throw new SubmissionServiceError("invalid_definition", `The definition has ${answer.structure.length} structure problem${answer.structure.length === 1 ? "" : "s"}: ${shown.join("; ")}${more}`);
  }
  return answer.op === "check" ? answer.structureWarnings : [];
}

function mergeSettings(base: SubmissionSettings, patch: Partial<SubmissionSettings> | SettingsPatch | undefined): SubmissionSettings {
  if (!patch) {
    return structuredClone(base);
  }
  const pdf = patch.pdf === null ? undefined : patch.pdf ? { enabled: false, sign: false, attachSubmission: true, ...(base.pdf ?? {}), ...patch.pdf } : base.pdf;
  return {
    validation: { ...base.validation, ...(patch.validation ?? {}) },
    ...(pdf ? { pdf } : {}),
    receipt: { ...base.receipt, ...(patch.receipt ?? {}) }
  };
}

/**
 * The journey an envelope names, read as the server hosts read it: `undefined` when
 * it names none (no `journey`, `null`, or an object with no id or a `null` id), the id as it came
 * otherwise — a non-string id (and an array, which is no object here) is kept, so it is refused as
 * unknown rather than ignored.
 */
function journeyIdOf(envelope: CanonicalSubmission): unknown {
  const journey: unknown = envelope.submission.journey;
  if (journey === undefined || journey === null) {
    return undefined;
  }
  const id = typeof journey === "object" && !Array.isArray(journey) ? (journey as { id?: unknown }).id : journey;
  return id === null ? undefined : id;
}

/**
 * The journey a body that names none is judged by (the rule every server host shares): the
 * form's only journey, else the one `journey.defaultJourneyId` names; `"required"` when it has
 * several and no usable default; `undefined` for a form with no journeys or one that opens as a
 * form (`journey.opensAs: "form"`), which stays judged whole.
 */
function impliedJourney(definition: FormDefinition): Journey | "required" | undefined {
  const { journeys = [], defaultJourneyId, opensAs } = readJourneyConfiguration(definition);
  if (journeys.length === 0 || opensAs === "form") {
    return undefined;
  }
  if (journeys.length === 1) {
    return journeys[0];
  }
  return journeys.find((journey) => journey.id === defaultJourneyId) ?? "required";
}

function hostErrorsOf(errors: readonly WasmValidationError[]): HostError[] {
  return errors.map((error) => ({
    code: error.code,
    ...(error.componentId !== undefined ? { componentId: error.componentId } : {}),
    ...(error.path !== undefined ? { path: String(error.path) } : {}),
    severity: error.severity ?? "error",
    source: "server",
    ...(error.parameters ? { parameters: error.parameters } : {})
  }));
}

/**
 * Whether a verdict blocks: any entry but a `"warning"` or an `"info"`. An entry with no
 * severity is an error, and so is one whose severity is none of the three words (a hook's typo
 * is not a pass).
 */
function blocks(errors: readonly WasmValidationError[]): boolean {
  return errors.some((error) => error.severity !== "warning" && error.severity !== "info");
}

/**
 * The submission key a delivery carries, checked: a body without one, or with one that is not a
 * key, is refused before anything is judged, so no delivery is ever kept without the key that
 * tells a retry from another person's identical answers.
 */
function submissionKeyOf(input: ReceiveInput): string {
  const key: unknown = (input as { submissionKey?: unknown }).submissionKey;
  if (typeof key !== "string" || !SUBMISSION_KEY_PATTERN.test(key)) {
    throw new SubmissionServiceError(
      "bad_document",
      key === undefined
        ? "A delivery carries the submission key of its submit attempt (submissionKey): one key per attempt, the same on a retry."
        : "The submission key is 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit."
    );
  }
  return key;
}

/**
 * Refuses a body that asks for a check: `scope` or `pageId` on the input, or on the
 * document it wraps. A journey's check pointed at the delivery endpoint by mistake would
 * otherwise write a record on every Continue.
 */
function refuseCheckRequest(input: ReceiveInput): void {
  const asks = (value: unknown): boolean =>
    value !== null && typeof value === "object" && ((value as { scope?: unknown }).scope !== undefined || (value as { pageId?: unknown }).pageId !== undefined);
  if (asks(input) || ("document" in input && asks(input.document))) {
    throw new SubmissionServiceError(
      "bad_document",
      "This body asks for a check (it has a scope or a pageId): send it to validate, which keeps nothing, not to receive."
    );
  }
}

/** The scope a `validate` input asks for, checked; a malformed one is refused. */
function checkScopeOf(input: ValidateInput): { kind: ServerValidationScope["kind"]; pageId?: string } {
  const { scope, pageId } = input as { scope?: unknown; pageId?: unknown };
  if (scope !== undefined && scope !== "page" && scope !== "journey") {
    throw new SubmissionServiceError("bad_document", `A check's scope is "page" or "journey", not ${JSON.stringify(scope)}.`);
  }
  if (scope === "page") {
    if (typeof pageId !== "string" || pageId.length === 0) {
      throw new SubmissionServiceError("bad_document", 'A check with scope "page" names the page it checks (pageId).');
    }
    return { kind: "page", pageId };
  }
  if (pageId !== undefined) {
    throw new SubmissionServiceError("bad_document", 'A pageId goes with scope "page" only.');
  }
  return { kind: scope === "journey" ? "journey" : "submission" };
}

/**
 * The component a value path stores, for an error that names only its path: the path as
 * written, else with its row indexes collapsed (`items[2].name` as `items.name`).
 */
function componentAt(idsByPath: Record<string, string[]>, path: unknown): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }
  for (const candidate of [path, kernelNormalizePath(path)]) {
    const ids = Object.hasOwn(idsByPath, candidate) ? idsByPath[candidate] : undefined;
    if (ids !== undefined && ids.length > 0) {
      return ids[0];
    }
  }
  return undefined;
}

/**
 * What a page check answers for: the components of the page's subtree, and the form
 * as a whole. Errors on other pages' components — later pages the person has not reached, most
 * often — are not the page's to show. Nor is `journey.exit`: a path that ends at an exit page
 * is where Continue leads, not a fault on the page being left. A page the server's path does
 * not take has its components folded to hidden by the sandbox, so its reply is clean.
 */
function pageScope(
  root: ComponentNode,
  journey: Journey,
  pageId: string
): { componentIds: string[]; holds: (error: WasmValidationError) => boolean; upTo: (values: Record<string, unknown>) => Record<string, unknown> } {
  const ownership = journeyOwnership(root, journey);
  const onPage = new Set<string>();
  for (const componentId of ownership.order) {
    const pages = Object.hasOwn(ownership.pagesOf, componentId) ? ownership.pagesOf[componentId] : undefined;
    if (pages !== undefined && pages.includes(pageId)) {
      onPage.add(componentId);
    }
  }
  const idsByPath = kernelComponentIdsByPath(root);
  const checkedAt = journey.pages.findIndex((candidate) => candidate.id === pageId);
  const pageIndex = new Map<string, number>();
  journey.pages.forEach((candidate, at) => {
    if (!pageIndex.has(candidate.id)) {
      pageIndex.set(candidate.id, at);
    }
  });
  return {
    componentIds: [...onPage],
    // A page check hands the server's hooks the answers of the pages up to and including the one
    // checked: a key every page of which comes later is the person's
    // answer to a page not reached, and not the check's to read or echo. Keys no page owns stay.
    upTo(values) {
      const kept: Record<string, unknown> = {};
      for (const key of Object.keys(values)) {
        const owners = journeyPagesOfKey(ownership, key);
        const later = owners !== undefined && owners.length > 0 && owners.every((owner) => (pageIndex.get(owner) ?? -1) > checkedAt);
        if (!later) {
          Object.defineProperty(kept, key, { value: values[key], enumerable: true, writable: true, configurable: true });
        }
      }
      return kept;
    },
    holds(error) {
      const componentId = error.componentId ?? componentAt(idsByPath, error.path);
      return componentId === undefined ? error.code !== "journey.exit" : onPage.has(componentId);
    }
  };
}

/** `<form id>-<record id>.pdf`, the id reduced to what a file system takes. */
function pdfFileNameOf(formId: string, recordId: string): string {
  const stem = formId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "form";
  return `${stem}-${recordId}.pdf`;
}

/** Deps for a server with no relying-party context: every WebAuthn signature reads unverifiable, with the reason. */
const UNVERIFIABLE_DEPS: EnvelopeVerifierDeps = {
  credentials: () => undefined,
  expectedOrigins: [],
  rpId: "",
  requireUserVerification: false
};

/**
 * `open: true` keeps this version judgeable after a later version of the same form id is
 * registered (a host that still serves the older form). Without it a document naming a
 * superseded version is refused, `version_superseded` (409), so a filler cannot pick the weakest
 * version.
 */
export interface RegisterOptions {
  open?: boolean;
  /**
   * The component types this host can draw (the sandbox's `check` op): a component of
   * another type is a `component.type.unknown` structure warning on the entry. Absent, none is judged.
   */
  componentTypes?: string[];
}

/** `^[A-Za-z0-9-]{1,32}$`: a BCP 47-ish tag, as the server hosts hold a locale to. */
const LOCALE_TAG = /^[A-Za-z0-9-]{1,32}$/;

/**
 * Refuses a document whose shape the service would otherwise misread: a wrapper (any `payload` key) is exactly `format`, `payload`, `signatures` and nothing
 * else, with a signature list and a format object; the envelope's locale is a short tag.
 */
function checkDelivered(document: unknown): void {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new SubmissionServiceError("bad_document", "A submission is a JSON object.");
  }
  const record = document as Record<string, unknown>;
  let envelope: unknown = record;
  if ("payload" in record) {
    const extra = Object.keys(record).filter((key) => key !== "payload" && key !== "signatures" && key !== "format");
    if (extra.length > 0) {
      throw new SubmissionServiceError("bad_document", `A signed document holds only format, payload and signatures, not ${extra.map((key) => JSON.stringify(key)).join(", ")}.`);
    }
    if (!Array.isArray(record.signatures)) {
      throw new SubmissionServiceError("bad_document", "A signed document must list its signatures.");
    }
    if (record.format === null || typeof record.format !== "object" || Array.isArray(record.format)) {
      throw new SubmissionServiceError("bad_document", "A signed document must say its signing format.");
    }
    envelope = record.payload;
  }
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  // The envelope itself: the service reads versionContext.form and submission.values.
  const form = object(envelope) && object(envelope.versionContext) ? envelope.versionContext.form : undefined;
  if (!object(form) || typeof form.id !== "string" || typeof form.version !== "string") {
    throw new SubmissionServiceError("bad_document", "A submission names its form: versionContext.form.id and version.");
  }
  const submission = (envelope as { submission?: unknown }).submission;
  if (!object(submission) || !object(submission.values)) {
    throw new SubmissionServiceError("bad_document", "A submission holds its answers as submission.values.");
  }
  const locale = submission !== null && typeof submission === "object" ? (submission as { locale?: unknown }).locale : undefined;
  if (locale !== undefined && (typeof locale !== "string" || !LOCALE_TAG.test(locale))) {
    throw new SubmissionServiceError("bad_document", "The locale is a short language tag.");
  }
}

/** A version's numeric tuple (`1.10.2`, `v2`, `1.0.0-rc1` read as `1.0.0`), or undefined when it does not parse. */
function versionTuple(version: string): number[] | undefined {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(version);
  return match ? match[1]!.split(".").map(Number) : undefined;
}

/**
 * Orders two versions of a form: negative when `a` is older. Undefined when either does not
 * parse as a numeric tuple (the caller then falls back to registration order).
 */
function compareVersions(a: string, b: string): number | undefined {
  const left = versionTuple(a);
  const right = versionTuple(b);
  if (!left || !right) {
    return undefined;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function createSubmissionService(deps: SubmissionServiceDeps): SubmissionService {
  if (deps.validator.id === "kernel") {
    warnDevelopmentOnly("The in-process kernel validator (createKernelValidator)", "Bind a QuickJS host instead: createQuickJsValidator from @argusvane/datum-submissions/node.");
  }
  const clock = deps.clock ?? (() => new Date());
  const ids = deps.ids ?? (() => globalThis.crypto.randomUUID());
  const { store } = deps;

  async function entryFor(formId: string, formVersion: string): Promise<FormCatalogEntry> {
    const entry = await store.getCatalogEntry(catalogKeyOf(formId, formVersion));
    if (!entry) {
      throw new SubmissionServiceError("unknown_form", `No form "${formId}" version ${formVersion} is registered here.`);
    }
    if (entry.supersededBy !== undefined && entry.open !== true) {
      throw new SubmissionServiceError("version_superseded", `Form "${formId}" version ${formVersion} was superseded by version ${entry.supersededBy}.`);
    }
    return entry;
  }

  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  /** Refuses a body past `maxBodyBytes`, before it is judged, digested or kept. */
  function checkBodySize(body: unknown): void {
    if (maxBodyBytes === Infinity) {
      return;
    }
    const text = JSON.stringify(body) ?? "";
    // A UTF-8 byte count is never below the UTF-16 length, and at most three times it.
    const bytes = text.length > maxBodyBytes ? text.length : text.length * 3 <= maxBodyBytes ? 0 : new TextEncoder().encode(text).length;
    if (bytes > maxBodyBytes) {
      throw new SubmissionServiceError("payload_too_large", `The body is larger than the ${maxBodyBytes} bytes this server accepts.`);
    }
  }

  /**
   * Refuses a delivery too deep or too large to read, before anything else is read from it (its
   * key included), so an oversized body is a 413 on every host whatever else is wrong with it.
   */
  function measureBody(input: DeliveryInput): void {
    // The whole delivery is measured, not only its answers: a bare delivery's locale and journey id
    // are as free as its values. Its depth first: the size check
    // stringifies it.
    const body = "document" in input ? input.document : { formId: input.formId, formVersion: input.formVersion, values: input.values, locale: input.locale, journeyId: input.journeyId };
    checkBodyDepth(body);
    checkBodySize(body);
  }

  /** The form a measured input is for, and the document it is (bare values wrapped as `receive` keeps them). */
  async function documentOf(input: DeliveryInput): Promise<{ entry: FormCatalogEntry; document: DeliveredDocument }> {
    if ("document" in input) {
      checkDelivered(input.document);
      const envelope = submissionEnvelopeOf(input.document);
      return { entry: await entryFor(envelope.versionContext.form.id, envelope.versionContext.form.version), document: input.document };
    }
    if (input.locale !== undefined && (typeof input.locale !== "string" || !LOCALE_TAG.test(input.locale))) {
      throw new SubmissionServiceError("bad_document", "The locale is a short language tag.");
    }
    const entry = await entryFor(input.formId, input.formVersion);
    const envelope: CanonicalSubmission = {
      versionContext: {
        form: { id: input.formId, version: input.formVersion },
        client: { runtimeVersion: "server", rendererVersion: "server", schemaVersion: entry.definition.schemaVersion }
      },
      submission: {
        locale: input.locale ?? "en",
        values: input.values,
        ...(input.journeyId !== undefined ? { journey: { id: input.journeyId } } : {})
      }
    };
    return { entry, document: envelope };
  }

  /** Runs one of the steps that reach a verdict; a throw means there is none (`validator_unavailable`). */
  async function unlessUnavailable<T>(step: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // A verdict too big for the sandbox's cap (an `unknownFields: "reject"` form and a body of
      // thousands of unknown keys) is a run that gave no verdict, answered under its own code
      // (`outcome_too_large`, a 503 with the other failed runs) and not as an outage of the
      // validator.
      if (step === "The sandbox" && (error as { code?: unknown } | null)?.code === "outcome_too_large") {
        throw new SubmissionServiceError("outcome_too_large", "The answers produce a verdict larger than this server will judge (outcome.tooLarge).");
      }
      // The sandbox refusing the request before it parsed it (nested or long past its limits) is the
      // same: the body's depth is bounded before this, so what is left to refuse is the filler's.
      if (step === "The sandbox" && (error as { code?: unknown } | null)?.code === "request_refused") {
        throw new SubmissionServiceError("bad_document", `The answers are more than the sandbox reads: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new SubmissionServiceError(
        "validator_unavailable",
        `${step} failed, so the answers could not be judged: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * The verdict on an envelope, in a scope: the sandbox's, over the form's schema
   * and — when the envelope names a journey — that journey, so the kernel works the path out
   * again from the values; then the server's hooks, when the sandbox found nothing blocking in
   * scope. A journey the form does not have is refused before anything is judged: without it
   * the server cannot know which answers the person was asked for.
   *
   * The hooks see the values the sandbox sanitized. A page check usually has blocking errors on
   * later pages, so the sandbox hands back no values; its fold's `submittable` values then give
   * the hooks the same values, and its `effectiveState` drops what they report on components the
   * fold does not validate — as the kernel drops a plugin validator's.
   *
   * It also answers with the values it judged — the sandbox's, else its fold's — and the
   * delivered keys the form defines that those leave out (`withheld`): hidden answers the fold withheld.
   * A record keeps the first, and reports the second, since a forged client can send answers
   * no browser would, and the fold never validated them.
   */
  async function judge(
    entry: FormCatalogEntry,
    envelope: CanonicalSubmission,
    scope: { kind: ServerValidationScope["kind"]; pageId?: string },
    options: { trace?: boolean; document?: DeliveredDocument; hostContext?: Record<string, unknown> } = {}
  ): Promise<{
    errors: WasmValidationError[];
    logs?: WasmLogEntry[];
    trace?: JourneyTrace;
    values?: Record<string, unknown>;
    withheld?: string[];
    /** The sandbox's list of answers worked out in the browser and kept as sent, when it gave one. */
    clientDerived?: string[];
    /** Components whose rule reads the clock (`today()`, `age()`), as the sandbox lists them, when it gave any. */
    clockDependent?: string[];
    /** Components whose server-only or secret rules the sandbox applied, when it gave any. */
    serverRules?: string[];
    /** Components whose own visibility rule the sandbox could not replay; they were treated as hidden for requiredness. */
    visibilitySkipped?: string[];
  }> {
    const { settings, definition } = entry;
    // The compiled copy of the full definition as registered (secret rules included) is what the
    // server's own reads (a page's scope) use: formulas parsed once at register, not on every
    // delivery. The sandbox is handed the definition as registered, which it compiles for itself
    // as every runtime does (a compiled copy's trees would read to it as an author's). Neither
    // is the served definition, and the stored original is never touched.
    const compiled = entry.compiled ?? compileDefinition(definition, settings.validation.riskyPatterns).compiled;
    const policy = policyOf(definition, settings);
    const today = deps.today ? deps.today() : localCalendarDate(clock());
    let journeyId = journeyIdOf(envelope);
    if (journeyId === undefined) {
      // A body that names no journey on a form that has journeys is judged by the form's only
      // journey or its declared default, and refused when it has several and no default
      // (`opensAs: "form"` keeps the whole form).
      const implied = impliedJourney(definition);
      if (implied === "required") {
        return { errors: [{ code: "journey.required", stage: "journey", source: "server" }] };
      }
      journeyId = implied?.id;
    }
    let journey: Journey | undefined;
    let compiledJourney: Journey | undefined;
    if (journeyId !== undefined) {
      journey = typeof journeyId === "string" ? findJourney(definition, journeyId) : undefined;
      compiledJourney = typeof journeyId === "string" ? findJourney(compiled, journeyId) : undefined;
      if (!journey || !compiledJourney) {
        return {
          errors: [{ code: "journey.unknown", stage: "journey", source: "server", parameters: { journey: typeof journeyId === "string" ? journeyId : String(journeyId) } }]
        };
      }
    }
    let page: ReturnType<typeof pageScope> | undefined;
    if (scope.kind === "page") {
      if (!journey) {
        throw new SubmissionServiceError("bad_document", "A page check names the journey its answers were given through (journeyId).");
      }
      const pageId = scope.pageId as string;
      if (!journey.pages.some((candidate) => candidate.id === pageId)) {
        throw new SubmissionServiceError("bad_document", `Journey "${journey.id}" has no page "${pageId}".`);
      }
      page = pageScope(compiled.root, compiledJourney as Journey, pageId);
    }
    const inScope = (error: WasmValidationError): boolean => page === undefined || page.holds(error);

    // The options the form's sources hold: the form's own static list, then the
    // provider's over it. A provider that throws leaves no verdict.
    // Labels cross the sandbox as plain strings in the submit locale (the kernel compares
    // VALUES): a localized label a host stored or supplied is read here.
    const locale = envelope.submission.locale;
    const plainSnapshot = (snapshot: OptionSnapshot): OptionSnapshot =>
      Object.fromEntries(
        Object.entries(snapshot).map(([sourceId, items]) => [
          sourceId,
          Array.isArray(items)
            ? items.map((item) => {
                if (item === null || typeof item !== "object") {
                  return item;
                }
                const plain: typeof item = { ...item };
                for (const key of ["label", "description"] as const) {
                  const text = plain[key];
                  if (text !== null && typeof text === "object") {
                    const resolved = resolveLocalizedText(text as Parameters<typeof resolveLocalizedText>[0], locale);
                    if (resolved === undefined) {
                      delete plain[key];
                    } else {
                      plain[key] = resolved;
                    }
                  }
                }
                return plain;
              })
            : items
        ])
      );
    let optionSnapshot: OptionSnapshot | undefined =
      settings.validation.optionSnapshot !== undefined ? plainSnapshot(settings.validation.optionSnapshot) : undefined;
    if (deps.optionSnapshot) {
      const provider: OptionSnapshotProvider = deps.optionSnapshot;
      const supplied = await unlessUnavailable("The option snapshot provider", async () =>
        provider(definition, envelope.submission.values, envelope.submission.locale)
      );
      if (supplied !== undefined) {
        optionSnapshot = { ...(optionSnapshot ?? {}), ...plainSnapshot(supplied) };
      }
    }

    const hostCatalog = deps.translationCatalog;
    const context: WasmSubmissionContext & { today?: string; formulaErrors?: FormulaErrorPolicy; riskyPatterns?: "refuse" | "allow" } = {
      formId: definition.id,
      form: definition.root,
      ...(definition.translations !== undefined ? { translations: definition.translations } : {}),
      // The definition's `kinds` map: the kernel reads a plugin's or a binding's type as its base.
      ...(definition.kinds !== undefined ? { kinds: definition.kinds } : {}),
      // Beside the definition's map, never merged into it: the
      // kernel reads the catalog rung first, so the two stay apart on the wire.
      ...(hostCatalog !== null && typeof hostCatalog === "object" && !Array.isArray(hostCatalog) && Object.keys(hostCatalog).length > 0 ? { catalog: hostCatalog } : {}),
      values: envelope.submission.values,
      locale: envelope.submission.locale,
      ...(options.document !== undefined ? { document: options.document } : {}),
      unknownFields: settings.validation.unknownFields,
      ...(settings.validation.logLevel ? { logLevel: settings.validation.logLevel } : {}),
      ...(optionSnapshot !== undefined ? { optionSnapshot } : {}),
      ...(journey ? { journey } : {}),
      today,
      // The server's own host context for this request (never one the browser sent).
      ...(options.hostContext !== undefined ? { hostContext: options.hostContext } : {}),
      reportFold: true,
      formulaErrors: policy,
      ...(settings.validation.riskyPatterns !== undefined ? { riskyPatterns: settings.validation.riskyPatterns } : {})
    };
    // The answer is read inside the same guard as the call: a sandbox that answers something
    // other than a verdict (a `null`, `{}`, a string, `errors` that is no list) is as
    // unavailable as one that throws, so the caller sees `validator_unavailable` (503), never a
    // raw TypeError from reading `errors` off it, and nothing is kept either way.
    const outcome: WasmSubmissionOutcome & { clockDependent?: string[]; serverRules?: string[]; visibilitySkipped?: string[] } = await unlessUnavailable("The sandbox", async () => {
      const answer: unknown = await deps.validator.validate(context);
      if (!isSubmissionOutcome(answer)) {
        throw new Error(`it answered ${answer === null ? "null" : Array.isArray(answer) ? "a list" : `a ${typeof answer}`} that is not a verdict`);
      }
      return answer;
    });
    // A run that failed (it was cut off, it threw, its verdict was too large, the form is too deep) is
    // no verdict, whichever page was asked about: it is refused whole, nothing is kept, and the code is
    // the run's own (a 503 on the wire), never a rejection the filler could fix.
    const failedRun = outcome.errors.find((error) => RUN_FAILED_CODES.has(error.code));
    if (failedRun !== undefined) {
      throw new SubmissionServiceError(failedRun.code as RunFailedCode, `The sandbox's run failed (${failedRun.code}), so the answers could not be judged.`);
    }
    // The sandbox named the document it was handed: its digest must be the one this
    // server takes, else the verdict is for some other document.
    if (options.document !== undefined && outcome.digest !== submissionDigest(options.document)) {
      throw new SubmissionServiceError(
        "validator_unavailable",
        "The sandbox did not name the document it judged (its digest is missing or differs), so the answers could not be judged."
      );
    }
    const errors = outcome.errors.filter(inScope);
    // The sandbox reports what its fold settled (`reportFold`): `withheld`, `effectiveState`,
    // `submittable` of a blocked run and `trace`, so nothing here folds or partitions again. The
    // keys are absent only when the fold did not run (the kernel refused the definition, which
    // blocks): then nothing was judged, so nothing is withheld and the judged values are empty.
    const runner = deps.serverValidationRunner;
    if (runner && !blocks(errors)) {
      const effectiveState = (outcome.effectiveState ?? {}) as Parameters<typeof kernelErrorPassesFold>[1];
      const whole = outcome.values ?? { ...(outcome.submittable ?? {}) };
      const values = page !== undefined ? page.upTo(whole) : whole;
      const hookScope: ServerValidationScope = {
        kind: scope.kind,
        ...(journey ? { journeyId: journey.id } : {}),
        ...(scope.pageId !== undefined && page ? { pageId: scope.pageId, componentIds: page.componentIds } : {})
      };
      const result = await unlessUnavailable("A server validation hook", () =>
        runner.run({
          values,
          formId: definition.id,
          validationContext: { formId: definition.id, values, locale: envelope.submission.locale },
          services: deps.serverServicesProvider ? deps.serverServicesProvider() : {},
          environment: "server",
          scope: hookScope
        })
      );
      errors.push(...result.errors.filter((error) => kernelErrorPassesFold(error, effectiveState) && inScope(error)));
    }

    const trace = options.trace && journey ? outcome.trace : undefined;
    // What the verdict judged: the sandbox's values, else — it blocked — its fold's. A
    // cleared answer is judged empty, so it is left out like an excluded one. Built from
    // entries, so an own `__proto__` key stays a key.
    const judged: Record<string, unknown> = Object.fromEntries(
      Object.entries(outcome.values ?? outcome.submittable ?? {}).filter(([, value]) => value !== undefined)
    );
    const withheld: string[] = Array.isArray(outcome.withheld) ? [...outcome.withheld] : [];
    return {
      errors,
      ...(outcome.logs && outcome.logs.length > 0 ? { logs: outcome.logs } : {}),
      ...(trace ? { trace } : {}),
      values: judged,
      ...(withheld.length > 0 ? { withheld } : {}),
      ...(Array.isArray(outcome.clientDerived) && outcome.clientDerived.length > 0 ? { clientDerived: [...outcome.clientDerived] } : {}),
      ...(Array.isArray(outcome.clockDependent) && outcome.clockDependent.length > 0 ? { clockDependent: [...outcome.clockDependent] } : {}),
      ...(Array.isArray(outcome.serverRules) && outcome.serverRules.length > 0 ? { serverRules: [...outcome.serverRules] } : {}),
      ...(Array.isArray(outcome.visibilitySkipped) && outcome.visibilitySkipped.length > 0 ? { visibilitySkipped: [...outcome.visibilitySkipped] } : {})
    };
  }

  function envelopeSignatures(document: DeliveredDocument): Promise<EnvelopeSignatureReport> {
    return inspectEnvelopeSignatures(document, deps.envelopeVerifier ?? UNVERIFIABLE_DEPS);
  }

  /** The stored record a document digest names, when there is one. */
  function findByDigest(records: readonly SubmissionRecord[], digest: string): SubmissionRecord | undefined {
    return records.find((record) => record.digest === digest);
  }

  async function pdfSignatures(bytes: Uint8Array, expectedDigest?: string): Promise<PdfSignatureReportSet> {
    if (!deps.pdf) {
      throw new SubmissionServiceError("pdf_unavailable", "This server has no PDF renderer, so it cannot read PDF signatures.");
    }
    const own = deps.keys ? (await deps.keys.certificate())?.der : undefined;
    return inspectPdfSignatures(bytes, {
      verify: (data) => deps.pdf!.verify(data),
      ...(own ? { own, trusted: [own, ...(deps.trustedCertificates ?? [])] } : { trusted: [...(deps.trustedCertificates ?? [])] }),
      ...(deps.subtle ? { subtle: deps.subtle } : {}),
      clock,
      ...(expectedDigest ? { expectedDigest } : {})
    });
  }

  /** Renders, signs and stores the record's PDF; a failure becomes a warning on the record, never a refusal of the submission. */
  async function renderPdfFor(
    record: SubmissionRecord,
    entry: FormCatalogEntry,
    hostContext?: Record<string, unknown>
  ): Promise<{ pdf?: StoredPdf; signatures?: SignatureStatusSummary; warnings: string[] }> {
    const settings = entry.settings.pdf;
    if (!settings?.enabled) {
      return { warnings: [] };
    }
    if (!deps.pdf) {
      return { warnings: ["pdf.unavailable: the server has no PDF renderer; the PDF was not rendered"] };
    }
    const warnings: string[] = [];
    let signer;
    if (settings.sign) {
      if (deps.keys) {
        signer = await deps.keys.signer();
      } else {
        warnings.push("pdf.unsigned: the server has no signing key; the PDF was rendered unsigned");
      }
    }
    const envelope = submissionEnvelopeOf(record.document);
    const rendered = await deps.pdf.render({
      // The definition as registered, not whatever the author has changed since: its layouts'
      // conditions choose the layout unless the operator named one, which overrides them.
      definition: entry.definition,
      // The day and the policy the verdict was judged under, so a layout's `today()` agrees with it.
      today: deps.today ? deps.today() : localCalendarDate(clock()),
      // And the host context it was judged with, so a layout's `host.` reads agree with it too.
      ...(hostContext !== undefined ? { hostContext } : {}),
      formulaErrors: policyOf(entry.definition, entry.settings),
      ...(entry.settings.validation.riskyPatterns !== undefined ? { riskyPatterns: entry.settings.validation.riskyPatterns } : {}),
      ...(settings.layoutId ? { layoutId: settings.layoutId } : {}),
      // The answers the verdict judged, not the delivered ones: an answer the fold withheld was
      // never validated, and the server does not print (or sign) it.
      values: recordValuesOf(record),
      locale: envelope.submission.locale,
      ...(settings.attachSubmission ? { attachments: [buildSubmissionAttachment(record.document, record.id)] } : {}),
      ...(signer ? { signer } : {}),
      ...(settings.conformance ? { conformance: settings.conformance } : {}),
      documentId: record.id,
      createdAt: record.receivedAt
    });
    warnings.push(...rendered.warnings.map((warning) => `${warning.code}: ${warning.message}`));
    const blobRef = `pdf:${record.id}`;
    await store.putBlob(blobRef, rendered.bytes, { mimeType: "application/pdf" });
    const pdf: StoredPdf = {
      fileName: pdfFileNameOf(record.formId, record.id),
      pageCount: rendered.pageCount,
      blobRef,
      sha256: bytesDigest(rendered.bytes),
      size: rendered.bytes.length,
      layoutId: rendered.layoutId,
      ...(rendered.layoutChoice ? { layoutChoice: rendered.layoutChoice } : {}),
      signed: rendered.signed,
      attached: settings.attachSubmission && rendered.attached.length > 0,
      ...(rendered.conformance ? { conformance: rendered.conformance } : {}),
      warnings
    };
    let signatures: SignatureStatusSummary | undefined;
    if (rendered.signed) {
      try {
        signatures = (await pdfSignatures(rendered.bytes, record.digest)).summary;
      } catch (error) {
        warnings.push(`pdf.verify: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      signatures = summarize([]);
    }
    return { pdf, ...(signatures ? { signatures } : {}), warnings };
  }

  async function summaries(): Promise<Array<{ entry: FormCatalogEntry; counts: FormCatalogSummary["counts"] }>> {
    const entries = await store.listCatalog();
    return Promise.all(
      entries.map(async (entry) => ({
        entry,
        counts: {
          accepted: await store.countRecords({ formKey: entry.key, status: "accepted" }),
          rejected: await store.countRecords({ formKey: entry.key, status: "rejected" })
        }
      }))
    );
  }

  /** An entry as any caller may see it: no `server-secret` rule in either copy, no text of one in a formula problem, no option rows. */
  function publicEntry(entry: FormCatalogEntry): FormCatalogEntry {
    const { optionSnapshot: _held, ...validation } = entry.settings.validation;
    const { compiled, formulaProblems, ...rest } = entry;
    // A secret value written in the journeys or PDF layouts: the compiled copy holds it as a
    // bare tree, so it is compiled again from the public definition.
    const misplaced = kernelHoldsSecretSource(entry.definition.journey) || kernelHoldsSecretSource(entry.definition.pdf);
    return {
      ...rest,
      definition: publicDefinition(entry.definition),
      ...(compiled !== undefined
        ? { compiled: misplaced ? publicDefinition(compileDefinition(publicDefinition(entry.definition), entry.settings.validation.riskyPatterns).compiled) : publicDefinition(compiled) }
        : {}),
      ...(formulaProblems !== undefined ? { formulaProblems: kernelRedactSecretProblems(formulaProblems, entry.definition.root, misplaced) } : {}),
      settings: { ...entry.settings, validation }
    };
  }

  /** The receipt for a record kept. */
  function receiptOf(record: SubmissionRecord, settings: SubmissionSettings): FormNotice {
    return {
      kind: "success",
      ...(settings.receipt.title ? { title: settings.receipt.title } : {}),
      ...(settings.receipt.message ? { message: settings.receipt.message } : {}),
      ...(settings.receipt.showRecordId
        ? {
            details: [
              { label: "Record", value: record.id },
              { label: "Digest", value: `${record.digest.slice(0, 16)}…` },
              ...(record.pdf ? [{ label: "PDF", value: `${record.pdf.fileName}${record.pdf.signed ? " (signed by the server)" : ""}` }] : [])
            ]
          }
        : {})
    };
  }

  /**
   * Deliveries being judged now, by form and submission key: a second with the same document shares
   * the first's run; one with another document waits for it, and is then judged against what it kept.
   */
  const receiving = new Map<string, { digest: string; work: Promise<ReceiveResult> }>();

  /** Judges a delivery that is not already kept, and keeps it. */
  async function deliver(
    entry: FormCatalogEntry,
    document: DeliveredDocument,
    digest: string,
    submissionKey: string,
    source: SubmissionSource,
    hostContext: Record<string, unknown> | undefined
  ): Promise<ReceiveResult> {
    const envelope = submissionEnvelopeOf(document);
    const { settings } = entry;

    // Before anything is digested or written: a hook that throws leaves no record behind.
    const verdict = await judge(entry, envelope, { kind: "submission" }, { document, ...(hostContext !== undefined ? { hostContext } : {}) });
    // Warnings do not refuse a submission; only a blocking error does.
    const accepted = !blocks(verdict.errors);
    const id = ids();
    const receivedAt = clock().toISOString();

    const signatureReport = await envelopeSignatures(document);
    const record: SubmissionRecord = {
      id,
      formId: entry.formId,
      formVersion: entry.formVersion,
      receivedAt,
      status: accepted ? "accepted" : "rejected",
      document: structuredClone(document),
      ...(verdict.values ? { values: structuredClone(verdict.values) } : {}),
      ...(verdict.clientDerived ? { clientDerived: verdict.clientDerived } : {}),
      ...(verdict.clockDependent ? { clockDependent: verdict.clockDependent } : {}),
      ...(verdict.serverRules ? { serverRules: verdict.serverRules } : {}),
      ...(verdict.visibilitySkipped ? { visibilitySkipped: verdict.visibilitySkipped } : {}),
      digest,
      submissionKey,
      locale: envelope.submission.locale,
      source,
      errors: verdict.errors,
      ...(verdict.logs ? { logs: verdict.logs } : {}),
      signatures: { envelope: signatureReport.summary }
    };
    if (verdict.withheld) {
      // The delivered document keeps them (its digest covers them); the stored values do not.
      record.logs = [
        ...(record.logs ?? []),
        {
          level: "warn",
          message: "values.withheld: answers the fold withheld are kept in the delivered document but not in the record's values",
          data: { fields: verdict.withheld }
        }
      ];
    }

    if (verdict.clientDerived) {
      // Kept, and held to the form's rules like any answer — but worked out in the browser
      // (a presentation's worked-out value, a calculation the sandbox could not reproduce),
      // so nobody reads them as figures the server checked.
      record.logs = [
        ...(record.logs ?? []),
        {
          level: "info",
          message: "values.client-derived: answers worked out in the browser are kept as sent, held to the form's rules but not recomputed here",
          data: { fields: verdict.clientDerived }
        }
      ];
    }

    if (accepted) {
      try {
        const result = await renderPdfFor(record, entry, hostContext);
        if (result.pdf) {
          record.pdf = result.pdf;
        }
        if (result.signatures) {
          record.signatures = { envelope: signatureReport.summary, pdf: result.signatures };
        }
        if (result.warnings.length > 0 && !record.pdf) {
          // No PDF to hang the warnings on: they go in the record's log instead.
          record.logs = [...(record.logs ?? []), ...result.warnings.map((message) => ({ level: "warn" as const, message }))];
        }
      } catch (error) {
        record.logs = [...(record.logs ?? []), { level: "error", message: `pdf.failed: ${error instanceof Error ? error.message : String(error)}` }];
      }
    }

    await store.putRecord(record);

    if (!accepted) {
      return { record, errors: hostErrorsOf(verdict.errors) };
    }
    return { record, receipt: receiptOf(record, settings), errors: [] };
  }

  const service: SubmissionService = {
    async register(definition, settings, options = {}) {
      // The structure first: a definition the gate cannot judge, or that says something
      // other than the author meant (repeated ids, two fields in one place, a malformed journey), is
      // refused here and not discovered per submission. Warnings ride on the entry.
      const structureWarnings = checkStructure(definition, settings, options);
      const key = catalogKeyOf(definition.id, definition.version);
      const existing = await store.getCatalogEntry(key);
      const title = titleOf(definition);
      const settingsOf = mergeSettings(existing?.settings ?? DEFAULT_SUBMISSION_SETTINGS, settings);
      const { compiled, problems } = compileDefinition(definition, settingsOf.validation.riskyPatterns);
      const policy = policyOf(definition, settingsOf);
      if (policy === "fail" && problems.length > 0) {
        throw new SubmissionServiceError(
          "invalid_definition",
          `Form "${key}" has ${problems.length} formula problem${problems.length === 1 ? "" : "s"} and the policy is "fail": ${problems
            .map((problem) => `${problem.where}: ${problem.message}`)
            .join("; ")}`
        );
      }
      // A new version supersedes every earlier one of the form id; one registered after a newer
      // version is itself superseded by it. Versions that do
      // not parse as numbers fall back to registration order: the new key is the newer.
      const siblings = existing === undefined ? (await store.listCatalog()).filter((other) => other.formId === definition.id && other.key !== key) : [];
      let supersededBy = existing?.supersededBy;
      const older: FormCatalogEntry[] = [];
      for (const other of siblings) {
        const order = compareVersions(definition.version, other.formVersion);
        if (order !== undefined && order < 0) {
          if (supersededBy === undefined || (compareVersions(supersededBy, other.formVersion) ?? 0) < 0) {
            supersededBy = other.formVersion;
          }
        } else {
          older.push(other);
        }
      }
      const entry: FormCatalogEntry = {
        key,
        formId: definition.id,
        formVersion: definition.version,
        registeredAt: existing?.registeredAt ?? clock().toISOString(),
        ...(title ? { title } : {}),
        definition: structuredClone(definition),
        compiled: structuredClone(compiled),
        ...(policy === "warn" && problems.length > 0 ? { formulaProblems: problems } : {}),
        ...(structureWarnings.length > 0 ? { structureWarnings } : {}),
        settings: settingsOf,
        ...(supersededBy !== undefined ? { supersededBy } : {}),
        ...((options.open ?? existing?.open) !== undefined ? { open: (options.open ?? existing?.open) as boolean } : {})
      };
      await store.putCatalogEntry(entry);
      if (supersededBy === undefined) {
        for (const other of older) {
          if (other.supersededBy === undefined) {
            await store.putCatalogEntry({ ...other, supersededBy: definition.version });
          }
        }
      }
      return entry;
    },

    async publicDefinition(key) {
      const entry = await store.getCatalogEntry(key);
      if (!entry) {
        throw new SubmissionServiceError("unknown_form", `No form "${key}" is registered here.`);
      }
      return publicDefinition(entry.definition);
    },

    async inspect(key, op) {
      // The `test` op runs every scenario of the form in process, with no budget: it is not one of
      // the three questions a host serves.
      if (op !== "public" && op !== "check" && op !== "inspect") {
        throw new SubmissionServiceError("bad_document", `"${String(op)}" is not a question this service answers: ask public, check or inspect.`);
      }
      const entry = await store.getCatalogEntry(key);
      if (!entry) {
        throw new SubmissionServiceError("unknown_form", `No form "${key}" is registered here.`);
      }
      const hostPolicy = entry.settings.validation.formulaErrors;
      const answer = runInspect(
        {
          abi: WASM_ABI_VERSION,
          op,
          definition: entry.definition,
          ...(hostPolicy !== undefined ? { formulaErrors: hostPolicy } : {}),
          ...(entry.settings.validation.riskyPatterns !== undefined ? { riskyPatterns: entry.settings.validation.riskyPatterns } : {})
        },
        formulaFunctionSignatures(),
        [...FORMULA_FUNCTION_NAMES]
      );
      if (!answer.ok) {
        throw new SubmissionServiceError("bad_document", answer.error.message);
      }
      return answer;
    },

    getEntry(key) {
      return store.getCatalogEntry(key);
    },

    async listCatalog() {
      return (await summaries()).map(({ entry, counts }) => ({ ...publicEntry(entry), counts }));
    },

    async listCatalogFull() {
      return (await summaries()).map(({ entry, counts }) => ({ ...entry, counts }));
    },

    async updateSettings(key, patch) {
      const entry = await store.getCatalogEntry(key);
      if (!entry) {
        throw new SubmissionServiceError("unknown_form", `No form "${key}" is registered here.`);
      }
      const next = { ...entry, settings: mergeSettings(entry.settings, patch) };
      await store.putCatalogEntry(next);
      return next;
    },

    async deleteEntry(key, options) {
      const gone = await store.getCatalogEntry(key);
      await store.deleteCatalogEntry(key, options);
      if (gone) {
        // Entries the deleted version superseded point at it no longer: the newest left is current again
        // (a rollback).
        const left = (await store.listCatalog()).filter((other) => other.formId === gone.formId);
        const pointing = left.filter((other) => other.supersededBy === gone.formVersion);
        if (pointing.length > 0) {
          let current = left.filter((other) => other.supersededBy === undefined || other.supersededBy === gone.formVersion).at(-1)!;
          for (const other of left.filter((candidate) => candidate.supersededBy === undefined || candidate.supersededBy === gone.formVersion)) {
            if ((compareVersions(other.formVersion, current.formVersion) ?? 0) > 0) {
              current = other;
            }
          }
          for (const other of pointing) {
            const { supersededBy: _gone, ...rest } = other;
            await store.putCatalogEntry(other.key === current.key ? rest : { ...rest, supersededBy: current.formVersion });
          }
        }
      }
    },

    async receive(input, options = {}) {
      measureBody(input);
      refuseCheckRequest(input);
      const submissionKey = submissionKeyOf(input);
      const source = options.source ?? "api";
      const hostContext = plainHostContext(options.hostContext);
      const { entry, document } = await documentOf(input);
      // A submission is its attempt's key, not its answers: a retry of the same attempt (a double
      // click, a proxy's repeat) is answered with the record its first delivery kept, while two
      // people who give the same answers are two records. A known key with another document is
      // refused and never answered with the stored record, so a guessed key reads nothing.
      const digest = submissionDigest(document);
      const formKey = catalogKeyOf(entry.formId, entry.formVersion);
      const flightKey = `${formKey}|${submissionKey}`;
      const running = receiving.get(flightKey);
      if (running !== undefined && running.digest === digest) {
        return running.work;
      }
      const work = (async (): Promise<ReceiveResult> => {
        if (running !== undefined) {
          await running.work.catch(() => undefined);
        }
        // The store's answer is checked, not trusted: a store that ignores the filter would
        // otherwise hand back some other delivery's record and this one would be lost.
        const kept = (await store.listRecords({ filter: { formKey, status: "accepted", submissionKey }, limit: 1 })).items.find(
          (record) => record.submissionKey === submissionKey && record.status === "accepted" && record.formId === entry.formId && record.formVersion === entry.formVersion
        );
        if (kept !== undefined) {
          if (kept.digest !== digest) {
            throw new SubmissionServiceError(
              "submission.keyConflict",
              "This submission key was already used for a different submission: a new submit attempt carries a new key."
            );
          }
          return { record: kept, receipt: receiptOf(kept, entry.settings), errors: [] };
        }
        return deliver(entry, document, digest, submissionKey, source, hostContext);
      })();
      const settled = (): void => {
        if (receiving.get(flightKey)?.work === work) {
          receiving.delete(flightKey);
        }
      };
      work.then(settled, settled);
      receiving.set(flightKey, { digest, work });
      return work;
    },

    async validate(input, options = {}) {
      const scope = checkScopeOf(input);
      measureBody(input);
      const hostContext = plainHostContext(options.hostContext);
      const { entry, document } = await documentOf(input);
      const verdict = await judge(entry, submissionEnvelopeOf(document), scope, { trace: true, document, ...(hostContext !== undefined ? { hostContext } : {}) });
      return {
        accepted: !blocks(verdict.errors),
        errors: hostErrorsOf(verdict.errors),
        ...(verdict.trace ? { journey: { pages: [...verdict.trace.pages], end: verdict.trace.end } } : {})
      };
    },

    listRecords(options) {
      return store.listRecords(options);
    },

    getRecord(id) {
      return store.getRecord(id);
    },

    deleteRecord(id) {
      return store.deleteRecord(id);
    },

    async aggregate(key, spec = {}) {
      const entry = await store.getCatalogEntry(key);
      if (!entry) {
        throw new SubmissionServiceError("unknown_form", `No form "${key}" is registered here.`);
      }
      const all = await store.listRecords({ filter: { formKey: key }, limit: 100_000, order: "asc" });
      return aggregate(all.items, entry.definition, { ...spec, now: spec.now ?? clock() });
    },

    async exportRecords(key, format, options = {}) {
      const entry = await store.getCatalogEntry(key);
      if (!entry) {
        throw new SubmissionServiceError("unknown_form", `No form "${key}" is registered here.`);
      }
      const all = await store.listRecords({ filter: { formKey: key, ...(options.includeRejected ? {} : { status: "accepted" }) }, limit: 100_000, order: "asc" });
      const stem = `${entry.formId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "form"}-${entry.formVersion}-submissions`;
      return format === "csv"
        ? { text: recordsToCsv(all.items, walkValueFields(entry.definition)), fileName: `${stem}.csv`, mimeType: "text/csv" }
        : { text: recordsToJson(all.items), fileName: `${stem}.json`, mimeType: "application/json" };
    },

    async getPdf(id) {
      const record = await store.getRecord(id);
      if (!record?.pdf) {
        return undefined;
      }
      const blob = await store.getBlob(record.pdf.blobRef);
      return blob ? { bytes: blob.bytes, fileName: record.pdf.fileName, mimeType: blob.mimeType } : undefined;
    },

    async importPdf(bytes, options = {}) {
      if (!deps.pdf) {
        throw new SubmissionServiceError("pdf_unavailable", "This server has no PDF renderer, so it cannot read a PDF.");
      }
      const info = await deps.pdf.inspect(bytes, { attachments: "data" });
      let extracted = extractFromAttachment(info);
      if (extracted && !extracted.document) {
        throw new SubmissionServiceError("not_extractable", extracted.notes.join("; "));
      }
      if (!extracted) {
        // No record.json: a template layout of a registered form whose fields this PDF has.
        const candidates = options.formKey ? [await store.getCatalogEntry(options.formKey)].filter((entry): entry is FormCatalogEntry => entry !== undefined) : (await store.listCatalog()).filter((entry) => entry.supersededBy === undefined || entry.open === true);
        let best: { entry: FormCatalogEntry; layout: ReturnType<typeof bestTemplateLayout> } | undefined;
        for (const entry of candidates) {
          const match = bestTemplateLayout(info, entry);
          if (match && (!best || match.score > best.layout!.score)) {
            best = { entry, layout: match };
          }
        }
        if (!best?.layout) {
          throw new SubmissionServiceError(
            "not_extractable",
            info.fields.length === 0
              ? `The PDF carries no ${SUBMISSION_ATTACHMENT_NAME} and has no form fields: a designed layout's pages are drawn text, and cannot be read back. Render with "embed the delivered document" on to make the PDF importable.`
              : `The PDF carries no ${SUBMISSION_ATTACHMENT_NAME}, and none of the registered forms has a template layout whose fields it has.`
          );
        }
        extracted = extractFromTemplateFields(info, best.entry, best.layout.layout);
      }
      const notes = [...extracted.notes];
      const digest = extracted.digest;
      if (digest) {
        const records = (await store.listRecords({ filter: { formKey: catalogKeyOf(extracted.formId, extracted.formVersion) }, limit: 5000 })).items;
        const same = findByDigest(records, digest);
        if (same) {
          notes.push(`a record with the same digest is already here: ${same.id}`);
          if (same.status === "accepted") {
            // The same delivery is one record: the import finds it and changes nothing.
            return { record: same, method: extracted.method, errors: [], notes };
          }
        }
      }
      let signatureStatus: SignatureStatusSummary["status"] | undefined;
      try {
        signatureStatus = (await pdfSignatures(bytes, digest)).summary.status;
      } catch {
        signatureStatus = undefined;
      }
      const source = options.source ?? "pdf-import";
      // The file is the submission: importing the same PDF again is a retry of the same import.
      const submissionKey = `pdf:${bytesDigest(bytes)}`;
      const received = extracted.document
        ? await service.receive({ document: extracted.document, submissionKey }, { source })
        : await service.receive({ formId: extracted.formId, formVersion: extracted.formVersion, values: extracted.values ?? {}, ...(extracted.locale ? { locale: extracted.locale } : {}), submissionKey }, { source });
      const record: SubmissionRecord = {
        ...received.record,
        importedFrom: { ...(options.fileName ? { fileName: options.fileName } : {}), sha256: bytesDigest(bytes), method: extracted.method, ...(signatureStatus ? { signatureStatus } : {}) }
      };
      if (!record.pdf) {
        // The form renders no PDF of its own: keep the one that came in, so the record shows what it was read from.
        const blobRef = `pdf:${record.id}`;
        await store.putBlob(blobRef, bytes, { mimeType: "application/pdf" });
        record.pdf = {
          fileName: options.fileName ?? `${record.formId}-${record.id}.pdf`,
          pageCount: info.pageCount,
          blobRef,
          sha256: bytesDigest(bytes),
          size: bytes.length,
          layoutId: "imported",
          signed: (info.signatures ?? 0) > 0,
          attached: extracted.method === "attachment",
          ...(info.pdfa ? { conformance: info.pdfa } : {}),
          warnings: []
        };
        if (signatureStatus) {
          record.signatures = { envelope: record.signatures?.envelope ?? summarize([]), pdf: (await pdfSignatures(bytes, digest)).summary };
        }
      }
      await store.putRecord(record);
      return { record, method: extracted.method, ...(received.receipt ? { receipt: received.receipt } : {}), errors: received.errors, notes };
    },

    async inspectRecord(id) {
      const record = await store.getRecord(id);
      if (!record) {
        throw new SubmissionServiceError("unknown_record", `No record ${id} here.`);
      }
      const envelope = await envelopeSignatures(record.document);
      if (!record.pdf) {
        return { envelope };
      }
      const blob = await store.getBlob(record.pdf.blobRef);
      if (!blob) {
        return { envelope };
      }
      return { envelope, pdf: await pdfSignatures(blob.bytes, record.digest) };
    },

    async inspectDocument(input) {
      if (input.kind === "pdf") {
        const report = await pdfSignatures(input.bytes);
        const carries = report.attachments.find((attachment) => attachment.name === SUBMISSION_ATTACHMENT_NAME);
        let match: SubmissionRecord | undefined;
        if (carries) {
          // The PDF's own digest of its `submission.json` is a record's digest: find it without reading the file back.
          match = findByDigest((await store.listRecords({ limit: 5000 })).items, carries.sha256Hex);
          if (match) {
            report.attachments = report.attachments.map((attachment) => (attachment === carries ? { ...attachment, matchesRecordDigest: true } : attachment));
          }
        }
        return {
          kind: "pdf",
          pdf: report,
          carriesSubmission: carries !== undefined,
          ...(carries ? { digest: carries.sha256Hex } : {}),
          ...(match ? { recordId: match.id, formKey: catalogKeyOf(match.formId, match.formVersion), registered: true } : {})
        };
      }
      let parsed: ParsedSubmissionDocument;
      try {
        parsed = parseSubmissionDocument(input.text);
      } catch (error) {
        throw new SubmissionServiceError("bad_document", error instanceof Error ? error.message : String(error));
      }
      if (parsed.kind === "bare") {
        return { kind: "bare" };
      }
      const envelope = submissionEnvelopeOf(parsed.document);
      const formKey = catalogKeyOf(envelope.versionContext.form.id, envelope.versionContext.form.version);
      const registered = (await store.getCatalogEntry(formKey)) !== undefined;
      const digest = submissionDigest(parsed.document);
      const match = registered
        ? findByDigest((await store.listRecords({ filter: { formKey }, limit: 5000 })).items, digest)
        : undefined;
      const report = await envelopeSignatures(parsed.document);
      return { kind: parsed.kind, formKey, registered, digest, ...(match ? { recordId: match.id } : {}), envelope: report };
    },

    async serverCertificate() {
      return deps.keys ? deps.keys.certificate() : undefined;
    },

    async exportServerKey() {
      if (!deps.keys) {
        throw new SubmissionServiceError("keys_unavailable", "This server has no signing identity.");
      }
      return deps.keys.export();
    }
  };

  return service;
}
