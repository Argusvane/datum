import { CUSTOM_PREDICATES } from "../../customs.js";
import { judge, statusFor } from "../../judge.js";
import type { Observation } from "../../observation.js";
import { describe as describeExpectation, type Expectation, type PredicateEnv } from "../../predicates.js";
import type { EndpointReport, ExchangeTimes, ResultStatus, VariantResult, VectorResult } from "../../report/model.js";
import { VECTORS, matchesSelector } from "../../vectors/index.js";
import { DERIVED_VECTOR_IDS } from "../../vectors/receiver.js";
import type { Fixture, Vector } from "../../vectors/schema.js";
import { EARLIER_ENDPOINT_SPECS } from "./applicability.js";
import { Budget, BudgetExhausted, RateLimitedOut } from "./budget.js";
import { HttpClient, TransportError, routesFor, type EndpointTarget, type Exchange, type ProfileName } from "./http.js";
import { runPreflight, type PreflightOutcome } from "./preflight.js";
import { profileFor } from "./profiles/index.js";
import type { EndpointRow, EndpointSpec, RequestSpec } from "./rows.js";
import { rowNeedsWrites } from "./rows.js";
import { byteLength, createRuntime, goldenSent, rowContext, sendSpec, sentDocument, sha256, type Runtime, type Sent } from "./runtime.js";
import { JOURNEY_ENDPOINT_SPECS } from "./specs-journeys.js";
import { RECEIVER_ENDPOINT_SPECS } from "./specs-receiver.js";
import { isFixtureProblem, violatesNever500, wireProblems } from "./wire.js";

export interface EndpointConfig {
  baseUrl: string;
  formId: string;
  formVersion: string;
  /** Header lines from the operator (`--auth-header`, `--cookie`, `--header`): never reported beyond their names. */
  headers: Record<string, string>;
  allowWrites: boolean;
  /** `--i-installed-the-suite-fixture`: writes may go ahead although the marker could not be read. */
  fixtureAcknowledged: boolean;
  publicDefinitionUrl?: string;
  bodyLimit: number;
  maxRequests: number;
  delayMs: number;
  timeoutMs: number;
  heavy: boolean;
  gate: "release" | "full";
  only: string[];
  skip: string[];
  /** Replaces the catalogue (tests). */
  vectors?: readonly Vector[];
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onResult?: (result: VectorResult) => void;
}

export interface EndpointRun {
  results: VectorResult[];
  endpoint: EndpointReport;
  /** Why the run cannot be called a PASS whatever the results say (preflight failed, rate limited out, budget spent). */
  inconclusive: string[];
}

const SYNTHETIC: Record<string, Pick<VectorResult, "title" | "class" | "severity" | "attacker">> = {
  "CTL-01": { title: "A valid submission is accepted", class: "control", severity: "S3", attacker: "filler" },
  "CTL-02": { title: "A blank required field is refused with exactly required@name", class: "control", severity: "S3", attacker: "filler" },
  "OPT-01": { title: "A select answer outside the options is refused", class: "options", severity: "S1", attacker: "filler" }
};

function targetOf(config: EndpointConfig, profile: ProfileName): EndpointTarget {
  return {
    baseUrl: config.baseUrl,
    profile,
    formId: config.formId,
    formVersion: config.formVersion,
    allowWrites: config.allowWrites,
    ...(config.publicDefinitionUrl !== undefined ? { publicDefinitionUrl: config.publicDefinitionUrl } : {})
  };
}

interface PlannedRow {
  row: EndpointRow;
  skip?: string;
}

interface Plan {
  rows: PlannedRow[];
  heavy: boolean;
  note?: string;
}

/** The endpoint rows of a vector: an entry of the spec tables, else the vector's own `values` inputs when it declares `applies.endpoint`. */
function specFor(vector: Vector): EndpointSpec | undefined {
  const known = EARLIER_ENDPOINT_SPECS[vector.id] ?? RECEIVER_ENDPOINT_SPECS[vector.id] ?? JOURNEY_ENDPOINT_SPECS[vector.id];
  if (known !== undefined) {
    return known;
  }
  const applies = vector.applies.endpoint;
  // The builder profile's vectors (DEF, BLD) run through a host's save route, not the receiving one: `profile/builder-lifecycle.ts` owns them.
  if (applies === false || vector.fixture.definition !== "base" || DERIVED_VECTOR_IDS.includes(vector.id) || applies.profiles?.every((profile) => profile === "builder") === true) {
    return undefined;
  }
  const rows: EndpointRow[] = [];
  const add = (id: string, input: Vector["input"], expect: Expectation): void => {
    if (input.kind === "values") {
      const requests: RequestSpec[] = [
        {
          kind: "check",
          values: input.values as never,
          ...(input.locale !== undefined ? { locale: input.locale } : {})
        }
      ];
      rows.push({ id, requests, expect });
    } else if (input.kind === "raw") {
      rows.push({ id, requests: [{ kind: "raw", route: input.route, body: typeof input.body === "string" ? input.body : JSON.stringify(input.body), ...(input.contentType !== undefined ? { contentType: input.contentType } : {}) }], expect });
    }
  };
  add("(base)", vector.input, applies.expect ?? vector.expect);
  for (const variant of vector.variants ?? []) {
    add(variant.id, variant.input ?? vector.input, variant.expect ?? applies.expect ?? vector.expect);
  }
  return rows.length === 0 ? undefined : { rows, ...(applies.heavy === true ? { heavy: true } : {}) };
}

/** Whether an endpoint run drives this vector (it has rows in a spec table, or declares `applies.endpoint` over the base form). */
export function runsOnEndpoint(vector: Vector): boolean {
  return DERIVED_VECTOR_IDS.includes(vector.id) || specFor(vector) !== undefined;
}

/** The endpoint rows of a vector as text lines, for `explain`: what each sends (by id) and what each expects, per profile. */
export function endpointRowLines(vector: Vector): string[] {
  const spec = specFor(vector);
  if (spec === undefined) {
    return DERIVED_VECTOR_IDS.includes(vector.id) ? ["  endpoint: derived row, judged over every response of the run"] : [];
  }
  const lines = spec.note !== undefined ? [`  endpoint note: ${spec.note}`] : [];
  for (const row of spec.rows) {
    const where = row.profiles !== undefined ? ` [${row.profiles.join(", ")} only]` : "";
    const writes = rowNeedsWrites(row) ? " [needs --allow-writes]" : "";
    lines.push(`  endpoint row ${row.id}${where}${writes}: ${describeExpectation(row.expect, CUSTOM_PREDICATES)}`);
    for (const [profile, expect] of Object.entries(row.profileExpect ?? {})) {
      lines.push(`    on ${profile}: ${describeExpectation(expect, CUSTOM_PREDICATES)}`);
    }
  }
  return lines;
}

export async function runEndpoint(config: EndpointConfig): Promise<EndpointRun> {
  const budget = new Budget({ maxRequests: config.maxRequests, delayMs: config.delayMs, ...(config.sleep !== undefined ? { sleep: config.sleep } : {}) });
  const catalogue = config.vectors ?? VECTORS;
  const inconclusive: string[] = [];
  const results: VectorResult[] = [];
  const authHeaderName = Object.keys(config.headers)[0] ?? null;

  const reportOf = (profile: string, preflight: PreflightOutcome | undefined, writes: boolean, recordsCreated: number, marker: string | undefined): EndpointReport => ({
    baseUrl: stripCredentials(config.baseUrl),
    profile,
    formId: config.formId,
    formVersion: config.formVersion,
    authHeaderName,
    fixtureVersion: marker ?? null,
    preflight: { ok: preflight?.ok ?? false, evidence: preflight?.evidence ?? [] },
    writes,
    requestsSent: budget.sent,
    rateLimited: budget.rateLimited,
    recordsCreated
  });

  const profileName: ProfileName = "submissions";
  const target = targetOf(config, profileName);
  const client = new HttpClient({ target, budget, timeoutMs: config.timeoutMs, headers: config.headers, ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}) });
  const runtime = createRuntime(target, client, config.bodyLimit);

  // 1. Preflight: the control, the option check and (when readable) the fixture marker.
  let preflight: PreflightOutcome;
  try {
    preflight = await runPreflight(runtime);
  } catch (error) {
    if (error instanceof RateLimitedOut || error instanceof BudgetExhausted) {
      inconclusive.push(error.message);
      return { results, endpoint: reportOf(profileName, undefined, false, 0, undefined), inconclusive };
    }
    throw error;
  }
  if (!preflight.ok) {
    for (const check of preflight.checks.filter((entry) => !entry.ok)) {
      inconclusive.push(`preflight ${check.id}: ${check.message}`);
      const base = catalogue.find((vector) => vector.id === check.id);
      const meta = base !== undefined ? { title: base.title, class: base.class, severity: base.severity, attacker: base.attacker } : SYNTHETIC[check.id];
      if (meta !== undefined) {
        results.push({
          id: check.id,
          ...meta,
          runner: "endpoint",
          status: "ERROR",
          gate: "enforced",
          blockedBy: null,
          expected: "the preflight control",
          observed: check.observation ?? null,
          durationMs: 0,
          limitMs: null,
          notes: check.message
        });
      }
    }
    return { results, endpoint: reportOf(profileName, preflight, false, 0, preflight.marker), inconclusive };
  }

  // 2. Writes: off unless asked for, and then only for a form that proves (or is vouched to be) the fixture.
  let writes = config.allowWrites;
  let writesNote: string | undefined;
  if (writes && !preflight.markerVerified && !config.fixtureAcknowledged) {
    writes = false;
    writesNote = "writes are off: --allow-writes needs the fixture marker in the public definition (pass --public-definition-url) or --i-installed-the-suite-fixture";
    inconclusive.push(writesNote);
  }
  // 3. The vectors.
  const selected = catalogue.filter((vector) => {
    if (config.only.length > 0 && !config.only.some((selector) => matchesSelector(vector, selector))) {
      return false;
    }
    return !config.skip.some((selector) => matchesSelector(vector, selector));
  });
  const slots: (VectorResult | undefined)[] = selected.map(() => undefined);
  let stopped: string | undefined;
  const notRun: string[] = [];

  for (const [at, vector] of selected.entries()) {
    if (DERIVED_VECTOR_IDS.includes(vector.id)) {
      continue;
    }
    const spec = specFor(vector);
    if (spec === undefined) {
      continue;
    }
    let result: VectorResult;
    if (stopped !== undefined) {
      result = skipped(vector, `not run: ${stopped}`);
      notRun.push(vector.id);
    } else if (vector.gate.status === "pending" && config.gate === "release") {
      result = { ...skipped(vector, `pending (blocked by ${vector.gate.blockedBy}); run with --gate full`), gate: "pending", blockedBy: vector.gate.blockedBy };
    } else if ((spec.heavy === true || (vector.applies.endpoint !== false && vector.applies.endpoint.heavy === true)) && !(config.heavy || config.gate === "full")) {
      result = skipped(vector, "heavy vector; run with --heavy or --gate full");
    } else {
      try {
        result = await runVector(runtime, vector, spec, { writes, writesNote, gate: config.gate, secrets: Object.values(config.headers).filter((value) => value.length >= 6) });
      } catch (error) {
        if (error instanceof RateLimitedOut || error instanceof BudgetExhausted) {
          stopped = error.message;
          result = { ...skipped(vector, `stopped: ${error.message}`), status: "ERROR" };
        } else {
          throw error;
        }
      }
    }
    slots[at] = result;
    config.onResult?.(result);
  }
  if (stopped !== undefined) {
    inconclusive.push(`${stopped}${notRun.length > 0 ? ` Not run: ${notRun.join(", ")}.` : ""}`);
  }

  // 4. The derived rows, over everything the run sent.
  for (const [at, vector] of selected.entries()) {
    if (!DERIVED_VECTOR_IDS.includes(vector.id)) {
      continue;
    }
    const result = vector.id === "SEC-05" ? judgeHygiene(vector, client.exchanges, profileName) : vector.id === "REC-16" ? judgeUnavailable(vector, client.exchanges) : judgeFlood(vector, client.exchanges);
    slots[at] = result;
    config.onResult?.(result);
  }
  results.push(...slots.filter((slot): slot is VectorResult => slot !== undefined));

  const created = client.exchanges.filter((exchange) => exchange.method === "POST" && exchange.path === new URL(routesFor(target).submit).pathname && (exchange.status === 200 || exchange.status === 201)).length;
  return { results, endpoint: reportOf(profileName, preflight, writes, created, preflight.marker), inconclusive };
}

function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** A vector's result row with no verdict yet (status SKIP, no notes). */
function bare(vector: Vector): Omit<VectorResult, "notes"> {
  return {
    id: vector.id,
    title: vector.title,
    class: vector.class,
    severity: vector.severity,
    attacker: vector.attacker,
    runner: "endpoint",
    status: "SKIP",
    gate: vector.gate.status,
    blockedBy: vector.gate.status === "pending" ? vector.gate.blockedBy : null,
    expected: describeExpectation(vector.expect, CUSTOM_PREDICATES),
    observed: null,
    durationMs: 0,
    limitMs: null
  };
}

function skipped(vector: Vector, notes: string): VectorResult {
  return { ...bare(vector), notes };
}

interface RowRun {
  observation: Observation;
  /**
   * The row's HTTP exchanges, summed: each from the open connection to the answer's last byte. The
   * row's time bound is judged on this, never on the pacing pause or a wait inside the client.
   */
  elapsedMs: number;
  /** The same exchanges to their first answer byte, summed. */
  firstByteMs?: number;
  /** DNS and TCP connect before those exchanges, summed (where known). */
  connectMs?: number;
  /** How many requests went out (a request never sent is not counted). */
  requests?: number;
  last: Sent | undefined;
  /** The golden document "sent", for digest checks. */
  sent?: { name: string; canonical: string; digest: string };
  /** A skip reason: the row could not run in this setup. */
  skip?: string;
}

async function runRow(runtime: Runtime, vector: Vector, row: EndpointRow): Promise<RowRun> {
  if (row.procedure === "validate-stores-nothing") {
    return storesNothing(runtime, vector, row);
  }
  if (row.procedure === "replay-same-record") {
    return replaySameRecord(runtime, vector, row);
  }
  let last: Sent | undefined;
  let elapsedMs = 0;
  let firstByteMs = 0;
  let connectMs = 0;
  let requests = 0;
  for (const [at, request] of row.requests.entries()) {
    last = await sendSpec(runtime, request, `${vector.id}/${row.id}${row.requests.length > 1 ? `#${at + 1}` : ""}`);
    elapsedMs += last.elapsedMs;
    firstByteMs += last.firstByteMs;
    connectMs += last.connectMs ?? 0;
    requests += last.sent ? 1 : 0;
  }
  if (last === undefined) {
    return { observation: { kind: "refusal", refusal: "other", detail: "a row with no request" }, elapsedMs: 0, last };
  }
  const sentDoc = row.digestOfSent === true ? sentDocument(runtime, last.requestBody) : undefined;
  return {
    observation: last.observation,
    elapsedMs,
    firstByteMs,
    connectMs,
    requests,
    last,
    ...(sentDoc !== undefined ? { sent: goldenSent(sentDoc) } : {})
  };
}

/** REC-13: the record count around a check. */
async function storesNothing(runtime: Runtime, vector: Vector, row: EndpointRow): Promise<RowRun> {
  const url = routesFor(runtime.target).submissions;
  if (url === undefined) {
    return { observation: { kind: "answer", json: {} }, elapsedMs: 0, last: undefined, skip: "this profile has no record list the suite may read" };
  }
  const count = async (label: string): Promise<number | undefined> => {
    const response = await runtime.client.send({ method: "GET", url, label: `submissions ${label}` });
    const total = (response.json as { total?: unknown } | undefined)?.total;
    return response.status === 200 && typeof total === "number" ? total : undefined;
  };
  const before = await count("before");
  if (before === undefined) {
    return { observation: { kind: "answer", json: {} }, elapsedMs: 0, last: undefined, skip: "the form's record list cannot be read with this account" };
  }
  const check = await sendSpec(runtime, { kind: "check" }, `${vector.id}/${row.id}`);
  const after = await count("after");
  return {
    observation: { kind: "answer", json: { unchanged: before === after, before, after: after ?? null, check: check.observation.kind === "verdict" ? check.observation.accepted : check.observation.kind } },
    elapsedMs: check.elapsedMs,
    firstByteMs: check.firstByteMs,
    connectMs: check.connectMs ?? 0,
    requests: check.sent ? 1 : 0,
    last: check
  };
}

/** The record id a receipt carries (`id`, or a record's `record.id`), as text; undefined when the answer holds none. */
function recordIdOf(sent: Sent): string | undefined {
  const body = sent.response?.json;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as { id?: unknown; record?: { id?: unknown } };
  const id = record.id ?? record.record?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/**
 * REC-12: the same delivery twice. Handled is the first record again (the same id): a retry of one
 * attempt is never refused, so a 409 is a defect as much as a second accepted record under another id.
 * The answer is the evidence: both ids, the second status and the outcome the rows assert.
 */
async function replaySameRecord(runtime: Runtime, vector: Vector, row: EndpointRow): Promise<RowRun> {
  let first: Sent | undefined;
  let second: Sent | undefined;
  for (const [at, request] of row.requests.entries()) {
    const sent = await sendSpec(runtime, request, `${vector.id}/${row.id}#${at + 1}`);
    if (at === 0) {
      first = sent;
    } else {
      second = sent;
    }
  }
  if (first === undefined || second === undefined) {
    return { observation: { kind: "refusal", refusal: "other", detail: "a replay row needs two requests" }, elapsedMs: 0, last: first };
  }
  const firstId = recordIdOf(first);
  const secondId = recordIdOf(second);
  const accepted = first.observation.kind === "verdict" && first.observation.accepted;
  const sameRecord = secondId !== undefined && secondId === firstId;
  const conflict = second.observation.kind === "refusal" && second.observation.refusal === "outdated";
  const broke = [first, second].find((sent) => violatesNever500(sent.observation));
  if (broke !== undefined) {
    return { observation: broke.observation, ...pairTimes(first, second), last: second };
  }
  return {
    observation: {
      kind: "answer",
      json: {
        firstAccepted: accepted,
        firstId: firstId ?? null,
        secondId: secondId ?? null,
        secondStatus: second.response?.status ?? null,
        outcome: !accepted ? "first-not-accepted" : sameRecord ? "same-record" : conflict ? "conflict" : "new-record",
        handled: accepted && sameRecord
      }
    },
    ...pairTimes(first, second),
    last: second
  };
}

function pairTimes(first: Sent, second: Sent): Pick<RowRun, "elapsedMs" | "firstByteMs" | "connectMs" | "requests"> {
  return {
    elapsedMs: first.elapsedMs + second.elapsedMs,
    firstByteMs: first.firstByteMs + second.firstByteMs,
    connectMs: (first.connectMs ?? 0) + (second.connectMs ?? 0),
    requests: (first.sent ? 1 : 0) + (second.sent ? 1 : 0)
  };
}

async function runVector(runtime: Runtime, vector: Vector, spec: EndpointSpec, setup: { writes: boolean; writesNote: string | undefined; gate: "release" | "full"; secrets: string[] }): Promise<VectorResult> {
  const planned: PlannedRow[] = spec.rows.map((row) => {
    if (row.manual !== undefined) {
      return { row, skip: `manual: ${row.manual}` };
    }
    const vectorProfiles = vector.applies.endpoint === false ? undefined : vector.applies.endpoint.profiles;
    if (vectorProfiles !== undefined && !vectorProfiles.includes(runtime.target.profile)) {
      return { row, skip: `${vector.id} is for the ${vectorProfiles.join(", ")} profile only` };
    }
    if (row.profiles !== undefined && !row.profiles.includes(runtime.target.profile)) {
      return { row, skip: row.skipNote ?? `not for the ${runtime.target.profile} profile` };
    }
    if (rowNeedsWrites(row) && !setup.writes) {
      return { row, skip: setup.writesNote ?? "needs --allow-writes (a submission stores a record)" };
    }
    if (row.requests.some((request) => request.kind === "get") && runtime.definitionUrl === undefined) {
      return { row, skip: "needs --public-definition-url" };
    }
    return { row };
  });
  const shell = bare(vector);
  const toRun = planned.filter((entry) => entry.skip === undefined);
  if (toRun.length === 0) {
    const reasons = [...new Set(planned.map((entry) => entry.skip ?? ""))];
    return { ...shell, notes: reasons.join("; ") };
  }

  const variants: VariantResult[] = [];
  const failures: string[] = [];
  const skippedNotes: string[] = planned.filter((entry) => entry.skip !== undefined).map((entry) => `${entry.row.id}: skipped (${entry.skip})`);
  let allPass = true;
  let anyWarn = false;
  let first: { observation: Observation; limitMs: number | null; run: RowRun } | undefined;
  let evidenceRun: RowRun | undefined;
  let violated = false;
  let fixtureProblem: string | undefined;
  const started = performance.now();
  let ran = 0;
  const exchange = { requests: 0, connectMs: 0, firstByteMs: 0, totalMs: 0 };

  for (const entry of toRun) {
    const { row } = entry;
    let run: RowRun;
    try {
      run = await runRow(runtime, vector, row);
    } catch (error) {
      if (error instanceof TransportError) {
        failures.push(`${row.id}: ${error.message}`);
        fixtureProblem ??= error.message;
        continue;
      }
      throw error;
    }
    if (run.skip !== undefined) {
      skippedNotes.push(`${row.id}: skipped (${run.skip})`);
      continue;
    }
    ran += 1;
    const rowExchange = exchangeOf(run);
    exchange.requests += rowExchange.requests;
    exchange.connectMs += rowExchange.connectMs;
    exchange.firstByteMs += rowExchange.firstByteMs;
    exchange.totalMs += rowExchange.totalMs;
    const expect = row.profileExpect?.[runtime.target.profile] ?? row.expect;
    const limitMs = row.limitMs ?? vector.limits.endpointMs ?? null;
    const env: PredicateEnv = {
      elapsedMs: run.elapsedMs,
      golden: { controls: {}, documents: run.sent !== undefined ? [run.sent] : [] },
      customs: CUSTOM_PREDICATES
    };
    const judgement = judge(expect, run.observation, env, limitMs);
    let pass = judgement.pass;
    let reason = judgement.reason;
    if (violatesNever500(run.observation)) {
      pass = false;
      violated = true;
      reason = `never-500 rule: ${run.observation.kind === "refusal" ? run.observation.detail : "the server broke"}`;
    }
    const problem = isFixtureProblem(run.observation);
    if (problem !== undefined) {
      fixtureProblem ??= problem;
    }
    first ??= { observation: run.observation, limitMs, run };
    allPass &&= pass;
    anyWarn ||= judgement.warn && pass;
    if (!pass || judgement.warn) {
      failures.push(`${row.id}: ${reason}`);
      evidenceRun ??= run;
    }
    if (spec.rows.length > 1 || row.id !== "(base)") {
      variants.push({
        id: row.id,
        status: pass ? (judgement.warn ? statusFor({ pass: true, warn: true }, vector.gate) : statusFor({ pass: true, warn: false }, vector.gate)) : statusFor({ pass: false, warn: false }, vector.gate),
        expected: describeExpectation(expect, CUSTOM_PREDICATES),
        observed: run.observation,
        ...(rowExchange.requests > 0 ? { exchange: rowExchange } : {}),
        ...(pass && !judgement.warn ? {} : { notes: reason })
      });
    }
  }

  const evidence = evidenceOf(evidenceRun ?? first?.run, setup.secrets);
  let status: ResultStatus;
  if (ran === 0 && fixtureProblem === undefined) {
    return { ...shell, notes: skippedNotes.join("; ") };
  }
  if (fixtureProblem !== undefined && failures.length > 0 && !allPass) {
    status = "ERROR";
  } else {
    status = statusFor({ pass: allPass, warn: anyWarn }, vector.gate);
    if (violated && vector.gate.status !== "pending") {
      status = "FAIL";
    }
  }
  const notes = [...failures, ...skippedNotes, ...(fixtureProblem !== undefined ? [fixtureProblem] : [])];
  return {
    ...shell,
    status,
    expected: describeExpectation(spec.rows[0]?.profileExpect?.[runtime.target.profile] ?? spec.rows[0]?.expect ?? vector.expect, CUSTOM_PREDICATES),
    observed: first?.observation ?? null,
    durationMs: performance.now() - started,
    limitMs: first?.limitMs ?? null,
    ...(exchange.requests > 0 ? { exchange: roundExchange(exchange) } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(notes.length > 0 ? { notes: notes.join(" | ") } : {})
  };
}

/** A row's timed HTTP exchanges (rounded to 0.1 ms for the report). */
function exchangeOf(run: RowRun): ExchangeTimes {
  return roundExchange({ requests: run.requests ?? 0, connectMs: run.connectMs ?? 0, firstByteMs: run.firstByteMs ?? 0, totalMs: run.elapsedMs });
}

function roundExchange(times: ExchangeTimes): ExchangeTimes {
  const round = (ms: number): number => Math.round(Math.max(0, ms) * 10) / 10;
  return { requests: times.requests, connectMs: round(times.connectMs), firstByteMs: round(times.firstByteMs), totalMs: round(times.totalMs) };
}

function evidenceOf(run: RowRun | undefined, secrets: readonly string[]): VectorResult["evidence"] | undefined {
  if (run?.last === undefined) {
    return undefined;
  }
  const body = run.last.requestBody;
  const excerpt = redact(run.last.response?.text.slice(0, 2048), secrets);
  const digest = sha256(body);
  return {
    ...(digest !== undefined ? { requestSha256: digest, requestBytes: byteLength(body) } : {}),
    ...(excerpt !== undefined ? { responseExcerpt: excerpt } : {})
  };
}

/** The operator's header values never appear in a report, even if a server echoes one. */
function redact(text: string | undefined, secrets: readonly string[]): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  return secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

/** SEC-05: the never-500 and hygiene rule over every exchange of the run. */
function judgeHygiene(vector: Vector, exchanges: readonly Exchange[], profile: ProfileName): VectorResult {
  const base = bare(vector);
  if (exchanges.length === 0) {
    return { ...base, notes: "no request was sent" };
  }
  const problems = exchanges.flatMap((exchange) => wireProblems(exchange, profile));
  const pass = problems.length === 0;
  const observed: Observation = { kind: "answer", json: { responses: exchanges.length, problems: problems.slice(0, 20) } };
  return {
    ...base,
    status: statusFor({ pass, warn: false }, vector.gate),
    expected: "no 5xx but a typed 503, JSON bodies of the contract's shape, no stack trace, host path or secret marker, over every response",
    observed,
    durationMs: 0,
    limitMs: null,
    ...(pass ? {} : { notes: problems.slice(0, 20).join(" | ") })
  };
}

/** REC-16: any 503 the run met is a typed refusal with a JSON body (`server.busy`, `server.unavailable`, `validator_unavailable`). Never provoked. */
function judgeUnavailable(vector: Vector, exchanges: readonly Exchange[]): VectorResult {
  const base = bare(vector);
  const met = exchanges.filter((exchange) => exchange.status === 503);
  if (met.length === 0) {
    return { ...base, notes: "no 503 was met (the suite never saturates the sandbox)" };
  }
  const codeOf = (exchange: Exchange): string => {
    const errors = (exchange.json as { errors?: { code?: unknown }[] } | undefined)?.errors;
    return exchange.jsonOk && Array.isArray(errors) && typeof errors[0]?.code === "string" ? errors[0].code : "";
  };
  const worst = met.find((exchange) => !(vector.expect.op === "refusal" && vector.expect.codes?.includes(codeOf(exchange)) === true)) ?? met[0]!;
  const observation: Observation = { kind: "refusal", refusal: "unavailable", http: 503, ...(codeOf(worst) !== "" ? { code: codeOf(worst) } : { code: "" }), detail: `HTTP 503${worst.jsonOk ? "" : " with a body that is not JSON"} (${met.length} met)` };
  const judgement = judge(vector.expect, observation, { customs: CUSTOM_PREDICATES }, null);
  return {
    ...base,
    status: statusFor(judgement, vector.gate),
    expected: describeExpectation(vector.expect, CUSTOM_PREDICATES),
    observed: observation,
    durationMs: 0,
    limitMs: null,
    ...(judgement.pass ? {} : { notes: judgement.reason })
  };
}

/** REC-14: any 429 the run met carries a JSON body with the code `flood`. Never provoked. */
function judgeFlood(vector: Vector, exchanges: readonly Exchange[]): VectorResult {
  const base = bare(vector);
  const met = exchanges.find((exchange) => exchange.status === 429);
  if (met === undefined) {
    return { ...base, notes: "no 429 was met (the suite never provokes one)" };
  }
  const observation = (() => {
    const errors = (met.json as { errors?: { code?: unknown }[] } | undefined)?.errors;
    const code = Array.isArray(errors) && typeof errors[0]?.code === "string" ? errors[0].code : undefined;
    return { kind: "refusal", refusal: "rate_limited", http: 429, ...(code !== undefined ? { code } : {}), detail: `HTTP 429${met.jsonOk ? "" : " with a body that is not JSON"}` } satisfies Observation;
  })();
  const judgement = judge(vector.expect, met.jsonOk ? observation : { ...observation, code: "" }, { customs: CUSTOM_PREDICATES }, null);
  return {
    ...base,
    status: statusFor(judgement, vector.gate),
    expected: describeExpectation(vector.expect, CUSTOM_PREDICATES),
    observed: observation,
    durationMs: 0,
    limitMs: null,
    ...(judgement.pass ? {} : { notes: judgement.reason })
  };
}

export { profileFor, rowContext };
export type { Fixture };
