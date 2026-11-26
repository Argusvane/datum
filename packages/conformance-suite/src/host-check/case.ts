import type { Capability } from "./capabilities.js";
import type { HostHttp, Reply, SendOptions } from "./http.js";
import { api, type HostTarget, type Who } from "./target.js";

/**
 * The case model. A case is one @Test method of the Java kit (the oracle): the same requests, the
 * same assertions, in the same order, with the same skips by assumption. `oracle` names the Java
 * method (`SubmissionsContract#theGoldenValidDocumentIsAcceptedWithADigestAndAReceipt`) and its
 * @Order; the title is that method name as words. Cases of one capability run in `order`; the
 * capabilities run in CAPABILITY_ORDER.
 */
export interface CaseContext {
  readonly target: HostTarget;
  readonly http: HostHttp;
  /** `baseUrl + apiPath + path`. */
  api(path: string): string;
}

export interface HostCase {
  /** SUB-01, FRM-02, ... */
  readonly id: string;
  readonly capability: Capability;
  /** The Java @Order. */
  readonly order: number;
  /** `<Contract>#<method>`. */
  readonly oracle: string;
  /** The Java method name as words. */
  readonly title: string;
  /** What the case sends and what it holds the host to, for `explain`. */
  readonly expects: string;
  run(context: CaseContext): Promise<void>;
}

/** What a preflight probe found: the host is set up (ok), it is not (missing, the run is INCONCLUSIVE), or it could not tell. */
export type ProbeOutcome = { status: "ok" | "missing" | "unknown"; message: string };

/**
 * A check before any case runs, for set-up a capability needs (the fixture form, a switch). Probes
 * send through `probe`, which applies no wire rule: a probe never fails the host, it only says
 * whether the run can say anything. Probes are deduplicated by id across capabilities.
 */
export interface Probe {
  readonly id: string;
  /** For `explain` and the report. */
  readonly checks: string;
  run(context: ProbeContext): Promise<ProbeOutcome>;
}

export interface ProbeContext {
  readonly target: HostTarget;
  /** A request with no wire rule applied (a transport failure still throws TransportError). */
  probe(method: string, url: string, options?: SendOptions): Promise<Reply>;
  api(path: string): string;
  /** The persona's token under `--csrf` (its jar's, else what `GET <endpoint>/` sets); undefined without a recipe or a cookie. */
  csrfToken(who?: Who): Promise<string | undefined>;
}

/** One capability's cases and probes (src/host-check/cases/<capability>.ts). */
export interface CapabilityModule {
  readonly capability: Capability;
  readonly cases: readonly HostCase[];
  readonly probes: readonly Probe[];
  /**
   * The Java contracts' assumeTrue on a missing key (`build-form`, `signing-form`), for the whole
   * group: when it returns a reason, every case of the capability is SKIPPED with it and none of its
   * probes runs, so the host is never touched for it (HostTck's "asserted nothing", exit 2).
   */
  readonly assumption?: (target: HostTarget) => string | undefined;
}

export function contextFor(target: HostTarget, http: HostHttp): CaseContext {
  return { target, http, api: (path) => api(target, path) };
}

/** A case from its parts; the title is the oracle's method name as words. */
export function hostCase(spec: Omit<HostCase, "title">): HostCase {
  const method = spec.oracle.slice(spec.oracle.indexOf("#") + 1);
  return { ...spec, title: titleOf(method) };
}

/**
 * A Java method name as words: `theDefinitionCarriesAnETagThatEarnsA304` is "the definition carries
 * an ETag that earns a 304". Capitalised words are lower-cased; acronyms (two capitals or more,
 * and ETag) keep their case; a run of digits is a word.
 */
export function titleOf(method: string): string {
  const tokens = method.match(/ETag|[A-Z]{2,}(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|[A-Z]|\d+/g) ?? [method];
  return tokens.map((token) => (token === "ETag" || /^[A-Z]{2,}$/.test(token) ? token : token.toLowerCase())).join(" ");
}
