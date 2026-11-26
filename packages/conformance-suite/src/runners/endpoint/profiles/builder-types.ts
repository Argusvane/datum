import type { Expectation } from "../../../predicates.js";
import type { Observation } from "../../../observation.js";
import type { VectorResult } from "../../../report/model.js";
import type { Gate, Vector } from "../../../vectors/schema.js";
import type { HttpClient, HttpResponse } from "../http.js";

export type BuilderHostName = "submissions";

export const DEFAULT_DEFINITION_LIMIT = 8 * 1024 * 1024;
export const DEFAULT_BUILDER_MAX_REQUESTS = 120;
export const DEFAULT_BUILDER_MAX_SAVES = 60;
export const DEFAULT_STATE_FILE = "./.datum-security-run.json";

/** What a builder run is configured with (see `datum-security-check --builder`). */
export interface BuilderConfig {
  baseUrl: string;
  host: BuilderHostName;
  /** Header lines from the operator (`--cookie`, `--auth-header`): never reported beyond their names. */
  headers: Record<string, string>;
  allowWrites: boolean;
  /** `--i-installed-the-suite-fixture`: adopt mode may go ahead although the marker could not be read. */
  fixtureAcknowledged: boolean;
  /** Adopt mode: the suite form already installed (it must carry the marker). Left out: create a form for the run. */
  builderForm?: string;
  formVersion: string;
  stateFile: string;
  /** The operator's `max_definition_bytes` (BLD-05 sends one body of limit+1 bytes). */
  definitionLimit: number;
  dryRun: boolean;
  heavy: boolean;
  gate: "release" | "full";
  only: string[];
  skip: string[];
  maxRequests: number;
  /** Hard cap on POSTs of a definition to the save/register route. */
  maxSaves: number;
  delayMs: number;
  timeoutMs: number;
  /** Replaces the catalogue (tests). */
  vectors?: readonly Vector[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onResult?: (result: VectorResult) => void;
  /** Aborting (SIGINT, SIGTERM) stops after the request in flight; the cleanup still runs. */
  signal?: AbortSignal;
  /** Replaces the random run suffix (tests). */
  runSuffix?: string;
}

/** A stored form as a read-back sees it. */
export interface StoredForm {
  definition: unknown;
  /** SHA-256 of the canonical text of the public copy. */
  hash: string;
  /** The definition as JSON text, for comparisons. */
  text: string;
}

/** What one save request was, as a row describes it. */
export interface SaveSpec {
  /** The body as text or bytes (a definition retargeted to the suite form, or a raw hostile body). */
  body: string | Uint8Array;
  /** `null`: no Content-Type header. Default `application/json`. */
  contentType?: string | null;
  headers?: Record<string, string>;
  method?: "POST" | "GET" | "PUT" | "DELETE";
  /** A non-JSON 400 is the web server's answer (not a defect). */
  htmlOk?: boolean;
}

/** The context every host adapter and row works in. */
export interface BuilderCtx {
  config: BuilderConfig;
  client: HttpClient;
  host: BuilderHost;
  /** True while the stored form is something other than the base fixture (an accepted hostile save). */
  dirty: boolean;
  /** The form the run works on. */
  formId: string;
  formVersion: string;
  /** The last stored form the run knows (after a 2xx save or a read-back). */
  stored?: StoredForm | undefined;
  recordsCreated: number;
  saves: number;
  /** Every catalogue key the run registered (a hostile version is another key); the cleanup deletes each. */
  keys: Set<string>;
  /** The first save of the base fixture, for DEF-01. */
  baseSave?: HostResult;
  /** Every refused save, with what the read-back around it found (BLD-04). */
  atomicity: { row: string; status: number; violation?: string }[];
  /** Every chained check after an accepted hostile save (BLD-09). */
  chained: { row: string; observation: Observation; status: number }[];
  notes: string[];
}

export interface HostResult {
  response: HttpResponse;
  observation: Observation;
}

/** What a host adapter does for the lifecycle; what differs between hosts lives here. */
export interface BuilderHost {
  readonly name: BuilderHostName;
  /** The allowlist for the run's form (and the one unknown id). */
  allow(ctx: BuilderCtx): (method: string, url: URL) => boolean;
  /** Create mode: makes the form. Throws {@link BuilderSetupError} when it cannot. */
  create(ctx: BuilderCtx): Promise<void>;
  /** Fetches whatever the saves need. Throws {@link BuilderSetupError}. */
  prepare(ctx: BuilderCtx): Promise<void>;
  save(ctx: BuilderCtx, spec: SaveSpec, label: string): Promise<HostResult>;
  /** The stored form as the author sees it, or undefined when it cannot be read. */
  readBack(ctx: BuilderCtx, label: string): Promise<StoredForm | undefined>;
  /** The host's answer to "check this stored form" (`GET /api/forms/:key/inspect?op=check`), when it has a route for it. */
  readCheck?(ctx: BuilderCtx, label: string): Promise<{ answer: unknown } | { unreadable: string }>;
  /** The form's public copy as an anonymous visitor gets it: `undefined` when it cannot be read (the reason is in `unreadable`). */
  readPublic(ctx: BuilderCtx, label: string): Promise<{ definition: unknown } | { unreadable: string }>;
  /** The chained check: a valid submission checked, nothing stored. */
  validate(ctx: BuilderCtx, label: string): Promise<HostResult>;
  /** A valid submission delivered (stores a record). */
  submit(ctx: BuilderCtx, label: string): Promise<HostResult>;
  /** Removes the form (and records first). */
  remove(ctx: BuilderCtx): Promise<{ complete: boolean; detail: string; remedy: string }>;
  /** Whether the form is gone. */
  isGone(ctx: BuilderCtx): Promise<boolean>;
  /** The save response's hash and whether it names the kernel (`kernelWarnings`). */
  hashOf(response: HttpResponse): string | undefined;
  /** Read the form behind an adopted id: the definition and its marker. */
  describeAdopted(ctx: BuilderCtx): Promise<StoredForm | undefined>;
  /** Puts a definition back (adopt mode's restore). */
  restore(ctx: BuilderCtx, original: StoredForm): Promise<boolean>;
}

/** The run cannot go on (the form cannot be made, the credentials are wrong): INCONCLUSIVE, with the cleanup still run. */
export class BuilderSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderSetupError";
  }
}

/** The save budget is spent. */
export class SaveBudgetExhausted extends Error {
  constructor(public readonly max: number) {
    super(`the save budget (${max} POSTs of a definition) is spent; raise --max-saves or run fewer vectors`);
    this.name = "SaveBudgetExhausted";
  }
}

/** A row of the builder's plan: what to send and what the host must answer. */
export interface BuilderRow {
  id: string;
  /** Builds the request. Receives the run context (the current hash, the definition limit). */
  save?: (ctx: BuilderCtx) => SaveSpec;
  /** A row that is not a save (a read-back scenario): it produces its own observation. */
  scenario?: "base-save" | "secrets-public" | "secrets-check" | "twice";
  expect: Expectation;
  /** The row's own gate, over the vector's. */
  gate?: Gate;
  /** Run the chained check after an accepted save (default true for definition rows). */
  chain?: boolean;
  /** The next rows need the base fixture back after this one was accepted. */
  restoreAfter?: boolean;
  /** The refusal comes from the routing or access layer before the controller runs: nothing can have been stored, so the atomic read-back is skipped (it costs a request). */
  noReadBack?: boolean;
  /** A non-JSON 4xx is the web server's answer, not a defect. */
  htmlOk?: boolean;
  /** Extra check on an accepted save (the read-back must match what was judged). Returns a problem text. */
  after?: (ctx: BuilderCtx, outcome: { observation: Observation; response: HttpResponse }) => Promise<string | undefined>;
  heavy?: boolean;
  skipNote?: string;
  profiles?: BuilderHostName[];
}

export interface BuilderSpec {
  rows: BuilderRow[];
  /** Needs `--heavy` (or the full gate): a large body. */
  heavy?: boolean;
  note?: string;
}
