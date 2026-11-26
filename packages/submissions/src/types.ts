/**
 * What the submissions server keeps and what it says: the catalog of forms it
 * accepts submissions for, the record it writes for each one, and the settings that decide
 * what happens on receipt. Plain data throughout — every type here is what a store persists
 * and what a future HTTP host puts on the wire — so nothing in it names a DOM, a React or a
 * Node API.
 */
import type {
  CanonicalSubmission,
  FormDefinition,
  FormulaErrorPolicy,
  FormulaProblem,
  DefinitionProblem,
  PdfAConformance,
  PdfLayoutChoice,
  SignedSubmissionDocument,
  ValidationLogThreshold,
  WasmLogEntry,
  WasmSubmissionContext,
  WasmUnknownFieldsMode,
  WasmValidationError
} from "@argusvane/datum-engine";

/**
 * The options a form's data sources hold, by source id: `{ countries: [{ value: "CA", label: "Canada" }] }`.
 * The kernel holds every answer to a source-backed choice to its source's list, and
 * refuses one whose source is not here (`option.sourceUnavailable`).
 */
export type OptionSnapshot = NonNullable<WasmSubmissionContext["optionSnapshot"]>;

/**
 * Works out the snapshot for one judgement (a function cannot be stored with a catalog entry,
 * so this one is handed to `createSubmissionService` as `optionSnapshot`): the definition as
 * registered, the answers being judged and their locale. A source it leaves out is unavailable
 * for this judgement and an answer picking from it is refused; one that throws refuses the
 * whole call (`validator_unavailable`, a 503) and nothing is kept.
 */
export type OptionSnapshotProvider = (
  definition: FormDefinition,
  values: Record<string, unknown>,
  locale: string | undefined
) => OptionSnapshot | undefined | Promise<OptionSnapshot | undefined>;

/** The document a form delivers: the envelope, or the signed wrapper around it. */
export type DeliveredDocument = CanonicalSubmission | SignedSubmissionDocument;

/** `<form id>@<form version>`: how the catalog keys a definition. */
export type CatalogKey = string;

export function catalogKeyOf(formId: string, formVersion: string): CatalogKey {
  // `@` and `%` in the id are escaped so that no two (id, version) pairs share a key.
  return `${formId.replace(/%/g, "%25").replace(/@/g, "%40")}@${formVersion}`;
}

/** What the server does with a PDF once a submission is accepted. */
export interface PdfSettings {
  /** Render a PDF on receipt and keep it beside the record. */
  enabled: boolean;
  /**
   * The layout to render, whatever the answers: it overrides every layout's `when`. Absent, the
   * form chooses: the first layout, in its list's order, whose condition holds on the
   * judged answers (`recordValuesOf`), else its declared default, else its first — the layout the
   * person's own download printed from the same form.
   */
  layoutId?: string;
  /** Sign it with the server's key; the layout's `signature` settings shape the field and policy. */
  sign: boolean;
  /** Embed the record's envelope as `submission.json`, an associated file with the `Data` relationship, so the PDF carries what it was rendered from. */
  attachSubmission: boolean;
  /** Override the layout's PDF/A conformance for the server's copy. */
  conformance?: PdfAConformance;
}

/** The receipt the server hands back for the form to show. */
export interface ReceiptSettings {
  title?: string;
  message?: string;
  /** Put the record id and the digest in the notice's details. */
  showRecordId: boolean;
}

export interface SubmissionSettings {
  validation: {
    /** What the sandbox does with keys the form does not define. */
    unknownFields: WasmUnknownFieldsMode;
    /** What the run log keeps. */
    logLevel?: ValidationLogThreshold;
    /**
     * What a formula that does not parse does: `"fail"` (the default) refuses to register the form, `"warn"`, the explicit opt-in for staging, registers
     * it and reports the problems (a server-run rule calling a function the server lacks still
     * refuses every submission). Absent or any other value, the form's own
     * `configuration.formulaErrors`, else `"fail"`. Under `"warn"` the rule that does not parse
     * is absent when the form is judged.
     */
    formulaErrors?: FormulaErrorPolicy;
    /**
     * What happens to a regular expression of a catastrophic shape (a repeat of a repeat such as
     * `(x+)+`, a repeated back-reference): `"refuse"` (the default) reads a literal `matches`
     * pattern as a formula problem (`pattern.risky`, judged by `formulaErrors`, at register and in
     * the sandbox) and neither runs a field's `pattern` of that shape (the sandbox logs it and,
     * under `"fail"`, refuses a non-empty answer); `"allow"` runs them. Sent to the sandbox and
     * the PDF build.
     */
    riskyPatterns?: "refuse" | "allow";
    /**
     * The options this form's data sources hold, as plain data kept beside the definition (it
     * persists with the entry, so it must be JSON): sent to the sandbox as `optionSnapshot` on
     * every judgement. A source a choice names that is not in it is unavailable and an answer
     * picking from that choice is refused (`option.sourceUnavailable`). A snapshot that changes
     * with the day or the answers is the service's `optionSnapshot` provider instead (see
     * {@link OptionSnapshotProvider}); where both name a source the provider's list is used.
     */
    optionSnapshot?: OptionSnapshot;
  };
  pdf?: PdfSettings;
  receipt: ReceiptSettings;
}

export const DEFAULT_SUBMISSION_SETTINGS: SubmissionSettings = {
  validation: { unknownFields: "strip", logLevel: "info" },
  receipt: { title: "Submission received", message: "Your answers were validated and stored.", showRecordId: true }
};

/** One form the server accepts submissions for: the definition as registered, and the settings that apply to it. */
export interface FormCatalogEntry {
  key: CatalogKey;
  formId: string;
  formVersion: string;
  /** ISO 8601. */
  registeredAt: string;
  /** The form's title as the definition's root names it, for lists. */
  title?: string;
  /** The definition exactly as registered, secrets and all: never changed, never compiled, what a host hashes and stores. */
  definition: FormDefinition;
  /**
   * A compiled copy of {@link definition}: every formula string replaced by its tree, so the
   * server's own readers (the fold that gives its hooks their values) need no parser. Absent on
   * an entry registered before formulas, which the service then compiles when it needs one.
   */
  compiled?: FormDefinition;
  /** What did not parse when the form was registered under the `"warn"` policy; absent when nothing. */
  formulaProblems?: FormulaProblem[];
  /** What the kernel's structural check warned of at registration (`component.type.unknown`, `journey.route.backward`, ...); absent when nothing. */
  structureWarnings?: DefinitionProblem[];
  settings: SubmissionSettings;
  /** Set when a later version of the same form id was registered: the version that superseded this one. */
  supersededBy?: string;
  /** The host registered this version as still open: a superseded version is judged only when this is set. */
  open?: boolean;
}

/** A catalog entry with what the store knows about its records. */
export interface FormCatalogSummary extends FormCatalogEntry {
  counts: { accepted: number; rejected: number };
}

export type SubmissionStatus = "accepted" | "rejected";

/** Where a record came from. */
export type SubmissionSource = "renderer" | "pdf-import" | "api";

/** How the signatures on a record stood when it was written; the inspector recomputes live. */
export type SignatureStatus = "valid" | "invalid" | "unverifiable" | "none";

export interface SignatureStatusSummary {
  count: number;
  status: SignatureStatus;
  /**
   * What the signatures cover, when there are any, the narrowest of them: `"values"` (the
   * answers only, not the form id, version or locale), `"submission"` (answers and locale), or `"envelope"`. A `valid` status says nothing
   * about this without it.
   */
  scope?: "envelope" | "submission" | "values";
}

/** The PDF kept beside an accepted record. */
export interface StoredPdf {
  fileName: string;
  pageCount: number;
  /** The blob the bytes live under. */
  blobRef: string;
  /** SHA-256 of the bytes, hex. */
  sha256: string;
  size: number;
  layoutId: string;
  /**
   * How the layout was chosen: `asked` (the settings' `layoutId`), `condition` (its
   * `when` held on the judged answers), `default`, `fallback` (the first, none declared) or
   * `derived`. Absent when the render reports none.
   */
  layoutChoice?: PdfLayoutChoice;
  signed: boolean;
  /** Whether `submission.json` went in — it does not under PDF/A-1/2. */
  attached: boolean;
  conformance?: PdfAConformance;
  warnings: string[];
}

export interface SubmissionRecord {
  id: string;
  formId: string;
  formVersion: string;
  /** ISO 8601. */
  receivedAt: string;
  status: SubmissionStatus;
  /** The document as delivered: the envelope, or the signed wrapper around it. */
  document: DeliveredDocument;
  /**
   * The answers the verdict judged: the kernel's submittable values — keys the form
   * does not define stripped (unless kept), hidden answers the fold withheld left out,
   * calculations as the server worked them out. What the server's PDF, the exports and the
   * statistics read (`recordValuesOf`), since `document` stays exactly as delivered for its
   * digest and signatures. Absent on a record refused before anything was judged
   * (`journey.unknown`): readers then fall back to the document's.
   */
  values?: Record<string, unknown>;
  /**
   * The value paths among {@link values} whose answers were worked out in the browser and kept
   * as sent: the target of a presentation's worked-out value, a calculation the
   * sandbox could not reproduce (it reads `host.`, or an answer it was not sent), and any
   * calculation reading one of those. Each was held to the form's rules like any answer; none
   * was recomputed from inputs the server holds. As the sandbox's outcome lists them
   * (`clientDerived`), in document order; absent when there is none.
   */
  clientDerived?: string[];
  /**
   * The components whose rules read the clock (`today()`, `age()`), as the sandbox lists them:
   * the verdict depends on the day it was judged, which is `receivedAt`'s. Absent when none.
   */
  clockDependent?: string[];
  /**
   * The components whose server-only or secret rules the sandbox applied, in document
   * order: what a host reads to explain "the server requires this" for a field the browser never
   * marked. Absent when none.
   */
  serverRules?: string[];
  /**
   * The components whose own visibility rule the sandbox could not replay (`visibilitySkipped`):
   * it reads `host.`, runs in the browser, or reads the clock with no day. The server
   * treated each, and what is under it, as hidden for requiredness, so an answer the browser may
   * have hidden was not demanded. Absent when none.
   */
  visibilitySkipped?: string[];
  /** SHA-256 hex over the canonical serialization of the envelope — the record's identity across copies. */
  digest: string;
  /**
   * The key of the submit attempt that delivered it: a retry of the attempt carries the
   * same key and document and is answered with this record; another person's identical answers
   * carry another key and are another record.
   */
  submissionKey: string;
  locale: string;
  source: SubmissionSource;
  /**
   * The validation verdict: the sandbox's errors, then the server hooks'. An accepted record
   * holds warnings at most — nothing of severity `"error"`.
   */
  errors: WasmValidationError[];
  /** The sandbox run's log, when it kept anything. */
  logs?: WasmLogEntry[];
  pdf?: StoredPdf;
  signatures?: { envelope: SignatureStatusSummary; pdf?: SignatureStatusSummary };
  /** For a record that came back out of a PDF (PDF import). */
  importedFrom?: { fileName?: string; sha256: string; method: "attachment" | "template-fields"; signatureStatus?: SignatureStatus };
}

export interface RecordFilter {
  formKey?: CatalogKey;
  status?: SubmissionStatus;
  /** ISO 8601, inclusive. */
  from?: string;
  /** ISO 8601, exclusive. */
  to?: string;
  locale?: string;
  source?: SubmissionSource;
  /** The document digest a record stores. */
  digest?: string;
  /** The submission key a record stores (`receive` finds the record a retry repeats by it). */
  submissionKey?: string;
}

export interface RecordListOptions {
  filter?: RecordFilter;
  /** Page size; the store's default when absent. */
  limit?: number;
  /** The `cursor` a previous page returned. */
  cursor?: string;
  /** Newest first unless told otherwise. */
  order?: "desc" | "asc";
}

export interface Page<T> {
  items: T[];
  /** How many match the filter in all. */
  total: number;
  /** Where the next page starts; absent on the last page. */
  cursor?: string;
}

/** The server's signing identity as the store keeps it. */
export interface StoredKeyMaterial {
  algorithm: "ECDSA-P256-SHA256";
  /** PKCS#8 DER, base64. */
  privateKeyPkcs8: string;
  /** The self-signed certificate, DER base64. */
  certificateDer: string;
  subject: string;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * The codes of a sandbox run that gave no verdict: it was cut off or threw (`wasm.execution_error`),
 * its verdict was larger than the sandbox's cap (`outcome_too_large`), or the registered form is nested
 * past what the sandbox reads (`definition.tooDeep`). The same run fails the same way, so none of them
 * is ever a verdict on the answers: a refusal of the whole call, 503 with the run's own code.
 */
export const RUN_FAILED_CODES: ReadonlySet<string> = new Set(["wasm.execution_error", "outcome_too_large", "definition.tooDeep"]);

export type RunFailedCode = "wasm.execution_error" | "outcome_too_large" | "definition.tooDeep";

/**
 * A refusal the service raises: a code a host maps to an HTTP status (`statusOf`), and words
 * for a person. `validator_unavailable`: the sandbox or a server hook threw, so no verdict
 * could be reached and nothing was kept — a 503, which a journey's check reads as a server it
 * cannot reach. `invalid_definition`: the form has formulas that do not parse and the
 * policy is `"fail"`, so it was not registered — a 422. `version_superseded`: the document names a
 * form version that a later registration replaced and the host did not keep open — a 409.
 */
export class SubmissionServiceError extends Error {
  constructor(
    public readonly code:
      | "unknown_form"
      | "unknown_record"
      | "bad_document"
      | "pdf_unavailable"
      | "not_extractable"
      | "keys_unavailable"
      | "validator_unavailable"
      | "invalid_definition"
      | "version_superseded"
      /** The submission key was already used for an accepted delivery of a different document: a 409. */
      | "submission.keyConflict"
      /** The body is larger than the service's `maxBodyBytes`: a 413. */
      | "payload_too_large"
      /** A sandbox run that gave no verdict ({@link RunFailedCode}): no verdict and nothing kept, a 503 with the run's own code. */
      | RunFailedCode,
    message: string
  ) {
    super(message);
    this.name = "SubmissionServiceError";
  }
}
