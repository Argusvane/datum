import { randomBytes } from "node:crypto";

import { CUSTOM_PREDICATES } from "../../../customs.js";
import { judge, statusFor } from "../../../judge.js";
import type { Json, Observation } from "../../../observation.js";
import { describe as describeExpectation, type Expectation, type PredicateEnv } from "../../../predicates.js";
import type { BuilderReport, ResultStatus, VariantResult, VectorResult } from "../../../report/model.js";
import { VECTORS, matchesSelector } from "../../../vectors/index.js";
import type { Gate, Vector } from "../../../vectors/schema.js";
import { Budget, BudgetExhausted, RateLimitedOut } from "../budget.js";
import { AllowlistViolation, HttpClient, TransportError, type EndpointTarget, type Exchange, type HttpResponse } from "../http.js";
import { violatesNever500 } from "../wire.js";
import { builderWireProblems } from "./builder-observe.js";
import { BUILDER_FORM_OF, BUILDER_SPECS, DERIVED_BUILDER_IDS, baseBody, secretsDefinition } from "./builder-specs.js";
import { readState, removeState, writeState, type RunState } from "./builder-state.js";
import { submissionsBuilderHost } from "./builder-submissions.js";
import {
  BuilderSetupError,
  SaveBudgetExhausted,
  type BuilderConfig,
  type BuilderCtx,
  type BuilderHost,
  type BuilderRow,
  type BuilderSpec,
  type HostResult,
  type SaveSpec,
  type StoredForm
} from "./builder-types.js";
import { retargetDefinitionText } from "../../../fixtures/definitions.js";

/** Requests held back for the cleanup: the run's own work stops at `maxRequests`, the cleanup may use these. */
const CLEANUP_RESERVE = 40;

export interface BuilderRun {
  results: VectorResult[];
  builder: BuilderReport;
  /** Why the run cannot be called a PASS whatever the results say (the form could not be made, the budget ran out, cleanup is incomplete). */
  inconclusive: string[];
}

class Interrupted extends Error {
  constructor() {
    super("the run was interrupted (SIGINT or SIGTERM); the cleanup ran");
    this.name = "Interrupted";
  }
}

class AuthRedirect extends Error {
  constructor(what: string) {
    super(`${what} answered with a redirect: the credentials do not open an administrator session (a login page?)`);
    this.name = "AuthRedirect";
  }
}

export function hostFor(_name: BuilderConfig["host"]): BuilderHost {
  return submissionsBuilderHost;
}

/** The request list a run would send, one line per row, for `--dry-run` (nothing is sent). */
export function builderPlan(config: Pick<BuilderConfig, "host" | "heavy" | "gate" | "only" | "skip" | "builderForm" | "baseUrl" | "stateFile" | "maxRequests" | "maxSaves">, catalogue: readonly Vector[] = VECTORS): string[] {
  const lines = [
    `Builder run against ${config.baseUrl} (host ${config.host}): ${config.builderForm !== undefined ? `adopts the form "${config.builderForm}" (never deletes it)` : "creates a form secsuite_<8 hex>, labelled \"Datum security suite (safe to delete)\", and deletes it at the end"}.`,
    `State file: ${config.stateFile}. At most ${config.maxRequests} requests and ${config.maxSaves} saves.`,
    "Requests: POST /api/forms (register); GET /api/forms/{key}/definition and /inspect?op=public|check; POST /api/submissions/validate and /api/submissions; DELETE /api/forms/{key}?cascade=true.",
    "Never sent: any other form id (but the one \"no such form\" probe), the forms list, the settings pages, extensions, data sources, translations."
  ];
  for (const vector of selectedVectors(catalogue, config)) {
    const spec = BUILDER_SPECS[vector.id];
    if (spec === undefined) {
      continue;
    }
    const heavy = spec.heavy === true && !(config.heavy || config.gate === "full");
    lines.push(`${vector.id}${heavy ? " (heavy: skipped without --heavy)" : ""}: ${spec.rows.map((row) => row.id).join(", ")}`);
  }
  return lines;
}

function selectedVectors(catalogue: readonly Vector[], config: Pick<BuilderConfig, "only" | "skip">): Vector[] {
  const chosen = catalogue.filter((vector) => {
    if (config.only.length > 0 && !config.only.some((selector) => matchesSelector(vector, selector))) {
      return false;
    }
    return !config.skip.some((selector) => matchesSelector(vector, selector));
  });
  // An existing vector that has a builder form (REC-01 -> BLD-06, ...) brings the rows of that form along when it is selected by name.
  if (config.only.length === 0) {
    return chosen;
  }
  const wanted = new Set(chosen.map((vector) => vector.id));
  for (const vector of chosen) {
    for (const target of BUILDER_FORM_OF[vector.id] ?? []) {
      wanted.add(target);
    }
  }
  return catalogue.filter((vector) => wanted.has(vector.id) && !config.skip.some((selector) => matchesSelector(vector, selector)));
}

function sameStored(before: StoredForm, after: StoredForm): boolean {
  if (before.hash !== "" && after.hash !== "" && before.hash !== after.hash) {
    return false;
  }
  if (before.text !== "" && after.text !== "" && before.text !== after.text) {
    return false;
  }
  return (before.hash !== "" && after.hash !== "") || before.text === after.text;
}

function combine(statuses: ResultStatus[]): ResultStatus {
  for (const wanted of ["FAIL", "ERROR", "XFAIL", "WARN", "XPASS"] as const) {
    if (statuses.includes(wanted)) {
      return wanted;
    }
  }
  return statuses.length === 0 ? "SKIP" : "PASS";
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

/** The path of an exchange as a template: the run's form id, the unknown id and catalogue keys replaced. */
function templateOf(exchange: Exchange, formId: string): string {
  const path = exchange.path.split(encodeURIComponent(formId)).join("{form}").replace(/(\/api\/forms\/)[^/]+/, "$1{key}");
  return `${exchange.method} ${path}`;
}

function bare(vector: Vector): Omit<VectorResult, "notes"> {
  return {
    id: vector.id,
    title: vector.title,
    class: vector.class,
    severity: vector.severity,
    attacker: vector.attacker,
    runner: "builder",
    status: "SKIP",
    gate: vector.gate.status,
    blockedBy: vector.gate.status === "pending" ? vector.gate.blockedBy : null,
    expected: describeExpectation(vector.expect, CUSTOM_PREDICATES),
    observed: null,
    durationMs: 0,
    limitMs: null
  };
}

interface RowOutcome {
  id: string;
  status: ResultStatus;
  expected: string;
  observation: Observation | null;
  notes: string[];
  skipped: boolean;
  evidence?: VectorResult["evidence"];
  gate: Gate;
  violated: boolean;
}

export async function runBuilder(config: BuilderConfig): Promise<BuilderRun> {
  const host = hostFor(config.host);
  const catalogue = config.vectors ?? VECTORS;
  const started = performance.now();
  const adopt = config.builderForm !== undefined;
  const runSuffix = config.runSuffix ?? randomBytes(4).toString("hex");
  const formId = adopt ? (config.builderForm as string) : `secsuite_${runSuffix}`;
  const budget = new Budget({ maxRequests: config.maxRequests + CLEANUP_RESERVE, delayMs: config.delayMs, ...(config.sleep !== undefined ? { sleep: config.sleep } : {}) });
  const target: EndpointTarget = { baseUrl: config.baseUrl, profile: config.host, formId, formVersion: config.formVersion, allowWrites: true };
  const ctx: BuilderCtx = {
    config,
    client: undefined as never,
    host,
    dirty: false,
    formId,
    formVersion: config.formVersion,
    recordsCreated: 0,
    saves: 0,
    keys: new Set(),
    atomicity: [],
    chained: [],
    notes: []
  };
  ctx.client = new HttpClient({ target, budget, timeoutMs: config.timeoutMs, headers: config.headers, allow: host.allow(ctx), ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}) });

  const inconclusive: string[] = [];
  const results: VectorResult[] = [];
  const state: RunState = { version: 1, runId: runSuffix, host: config.host, baseUrl: stripCredentials(config.baseUrl), formId, formVersion: config.formVersion, mode: adopt ? "adopt" : "create", phase: "creating", startedAt: new Date().toISOString(), recordsCreated: 0 };
  let original: StoredForm | undefined;
  let created = false;
  let fatal: unknown;
  let setupDone = false;
  let modified = false;

  const checkpoint = (): void => {
    if (config.signal?.aborted === true) {
      throw new Interrupted();
    }
  };

  try {
    if (!adopt) {
      writeState(config.stateFile, state);
      created = true; // from here on the form may exist: the cleanup tries to delete it
    }
    await host.prepare(ctx);
    if (adopt) {
      original = await host.describeAdopted(ctx);
      const marker = ((original?.definition as { root?: { configuration?: { securitySuiteFixture?: unknown } } } | undefined)?.root?.configuration ?? {}).securitySuiteFixture;
      if (original === undefined) {
        throw new BuilderSetupError(`the form "${formId}" cannot be read: is the id right, and does the account open its build page?`);
      }
      if (marker !== "1" && !config.fixtureAcknowledged) {
        throw new BuilderSetupError(`the form "${formId}" does not carry root.configuration.securitySuiteFixture "1": the suite will not save into a form it does not own (pass --i-installed-the-suite-fixture only for a form you installed from \`datum-security-check fixture\`)`);
      }
      if (marker !== "1") {
        ctx.notes.push("adopted without the fixture marker (--i-installed-the-suite-fixture)");
      }
      ctx.stored = original;
      writeState(config.stateFile, { ...state, phase: "created", original: { text: original.text, hash: original.hash } });
    } else {
      await host.create(ctx);
      writeState(config.stateFile, { ...state, phase: "created" });
    }

    // Base fixture: saved, read back, and checked once: the form is open, submittable and has the journey the chained checks use.
    modified = true;
    const base = await baseSave(ctx);
    ctx.baseSave = base;
    if (base.observation.kind !== "answer") {
      throw new BuilderSetupError(`the suite fixture could not be saved (${base.observation.kind === "refusal" ? `${base.observation.refusal}${base.observation.http !== undefined ? ` HTTP ${base.observation.http}` : ""}: ${base.observation.detail.slice(0, 300)}` : "unexpected answer"}): the account needs update access to the form and a valid CSRF session`);
    }
    const check = await host.validate(ctx, "setup/validate");
    if (check.observation.kind !== "verdict" || !check.observation.accepted) {
      throw new BuilderSetupError(`the base fixture was saved but a valid submission is not accepted by the form's check (${check.observation.kind === "refusal" ? `${check.observation.refusal}: ${check.observation.detail.slice(0, 240)}` : "the verdict refused a valid submission"}): open the form to the suite's account, switch anti-spam off, make sure the journey "main" exists`);
    }
    setupDone = true;

    // The vectors.
    const selected = selectedVectors(catalogue, config);
    for (const vector of selected) {
      checkpoint();
      const spec = BUILDER_SPECS[vector.id];
      if (spec === undefined) {
        continue;
      }
      let result: VectorResult;
      try {
        result = await runVector(ctx, vector, spec, config, budget);
      } catch (error) {
        if (error instanceof BudgetExhausted || error instanceof RateLimitedOut || error instanceof SaveBudgetExhausted) {
          inconclusive.push(error.message);
          results.push({ ...bare(vector), status: "ERROR", notes: error.message });
          break;
        }
        throw error;
      }
      results.push(result);
      config.onResult?.(result);
    }

    // The restored base fixture must still judge (the final proof that no hostile save left the form unusable).
    if (setupDone && ctx.dirty) {
      await restoreBase(ctx);
    }
    if (setupDone && selected.some((vector) => BUILDER_SPECS[vector.id] !== undefined)) {
      const final = await host.submit(ctx, "final/submit");
      ctx.chained.push({ row: "restored-base-submit", observation: final.observation, status: final.response.status });
      if (final.observation.kind !== "verdict" || !final.observation.accepted) {
        inconclusive.push("the restored base fixture no longer accepts a valid submission: a hostile save left the form unusable");
      }
    }
  } catch (error) {
    if (error instanceof BuilderSetupError || error instanceof AuthRedirect || error instanceof BudgetExhausted || error instanceof RateLimitedOut || error instanceof SaveBudgetExhausted || error instanceof Interrupted) {
      inconclusive.push(error.message);
    } else if (error instanceof TransportError) {
      inconclusive.push(`the server did not answer: ${error.message}`);
    } else {
      fatal = error;
    }
  }

  // Cleanup: always, also after an error or an interrupt; it never throws.
  const cleanup = await cleanUp(ctx, { adopt, created, original: modified ? original : undefined, state });
  if (!cleanup.complete) {
    inconclusive.push(`cleanup is incomplete: ${cleanup.detail}. Remedy: ${cleanup.remedy ?? "see the state file"}`);
  }
  if (fatal !== undefined) {
    throw fatal;
  }

  // The derived rows.
  const wanted = (id: string): Vector | undefined => selectedVectors(catalogue, config).find((vector) => vector.id === id);
  const derived = derivedResults(ctx, wanted, cleanup, adopt, original, config);
  for (const result of derived) {
    results.push(result);
    config.onResult?.(result);
  }
  // Catalogue order, not completion order.
  const order = new Map(catalogue.map((vector, at) => [vector.id, at]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const templates: Record<string, number> = {};
  for (const exchange of ctx.client.exchanges) {
    const key = templateOf(exchange, formId);
    templates[key] = (templates[key] ?? 0) + 1;
  }
  const report: BuilderReport = {
    baseUrl: stripCredentials(config.baseUrl),
    host: config.host,
    formId,
    mode: adopt ? "adopt" : "create",
    authHeaderName: Object.keys(config.headers).find((name) => name !== "cookie") ?? (config.headers["cookie"] !== undefined ? "cookie" : null),
    requestsSent: budget.sent,
    saves: ctx.saves,
    requestsByTemplate: templates,
    cleanup: { complete: cleanup.complete, formId, ...(cleanup.remedy !== undefined && !cleanup.complete ? { remedy: cleanup.remedy } : {}), detail: cleanup.detail },
    recordsCreated: ctx.recordsCreated,
    ...(ctx.notes.length > 0 ? { notes: ctx.notes } : {})
  };
  void started;
  return { results, builder: report, inconclusive };
}

/** The first save of the base fixture. */
async function baseSave(ctx: BuilderCtx): Promise<HostResult> {
  const spec: SaveSpec = { body: baseBody(ctx) };
  const result = await ctx.host.save(ctx, spec, "setup/save base");
  if (result.observation.kind === "answer") {
    afterAccepted(ctx, true);
    // The read-back must show what was judged: the stored hash equals the answer's.
    const stored = await ctx.host.readBack(ctx, "page build after the base save");
    if (stored !== undefined) {
      ctx.stored = stored;
    }
  }
  return result;
}

/** Bookkeeping after an accepted save: the stored copy is stale, and the dirty flag. */
function afterAccepted(ctx: BuilderCtx, isBase: boolean): void {
  ctx.stored = undefined;
  ctx.dirty = !isBase;
}

async function restoreBase(ctx: BuilderCtx): Promise<void> {
  const first = await ctx.host.save(ctx, { body: baseBody(ctx) }, "restore/base");
  if (first.observation.kind === "answer") {
    afterAccepted(ctx, true);
    return;
  }
  const second = await ctx.host.save(ctx, { body: baseBody(ctx) }, "restore/base retry");
  if (second.observation.kind === "answer") {
    afterAccepted(ctx, true);
  } else {
    ctx.notes.push(`the base fixture could not be restored (${second.observation.kind === "refusal" ? second.observation.refusal : "unexpected"}); later rows ran against the previous save`);
  }
}

async function runVector(ctx: BuilderCtx, vector: Vector, spec: BuilderSpec, config: BuilderConfig, budget: Budget): Promise<VectorResult> {
  const shell = bare(vector);
  if (spec.heavy === true && !(config.heavy || config.gate === "full")) {
    return { ...shell, notes: "heavy vector; run with --heavy or --gate full" };
  }
  const started = performance.now();
  const outcomes: RowOutcome[] = [];
  const skippedNotes: string[] = [];
  for (const row of spec.rows) {
    if (config.signal?.aborted === true) {
      throw new Interrupted();
    }
    if (budget.sent >= config.maxRequests) {
      throw new BudgetExhausted(config.maxRequests);
    }
    const skip = skipReason(ctx, vector, spec, row, config);
    if (skip !== undefined) {
      skippedNotes.push(`${row.id}: skipped (${skip})`);
      continue;
    }
    outcomes.push(await runRow(ctx, vector, row));
  }
  const ran = outcomes.filter((outcome) => !outcome.skipped);
  for (const outcome of outcomes.filter((entry) => entry.skipped)) {
    skippedNotes.push(`${outcome.id}: skipped (${outcome.notes.join("; ")})`);
  }
  if (ran.length === 0) {
    return { ...shell, notes: skippedNotes.join("; ") };
  }
  const status = combine(ran.map((outcome) => outcome.status));
  const first = ran[0] as RowOutcome;
  const variants: VariantResult[] = ran.length > 1 || first.id !== "(base)" ? ran.map((outcome) => ({ id: outcome.id, status: outcome.status, expected: outcome.expected, observed: outcome.observation, ...(outcome.notes.length > 0 ? { notes: outcome.notes.join("; ") } : {}) })) : [];
  const worst = ran.find((outcome) => outcome.status === "FAIL" || outcome.status === "ERROR") ?? ran.find((outcome) => outcome.notes.length > 0) ?? first;
  const notes = [...ran.flatMap((outcome) => outcome.notes.map((note) => `${outcome.id}: ${note}`)), ...skippedNotes];
  const gateStatus = ran.some((outcome) => outcome.gate.status === "enforced") ? "enforced" : (ran[0] as RowOutcome).gate.status;
  return {
    ...shell,
    gate: gateStatus,
    blockedBy: gateStatus === "pending" ? ran.map((outcome) => outcome.gate).find((gate): gate is Extract<Gate, { status: "pending" }> => gate.status === "pending")?.blockedBy ?? null : null,
    status,
    expected: first.expected,
    observed: first.observation,
    durationMs: performance.now() - started,
    limitMs: null,
    ...(variants.length > 0 ? { variants } : {}),
    ...(worst.evidence !== undefined ? { evidence: worst.evidence } : {}),
    ...(notes.length > 0 ? { notes: notes.join(" | ") } : {})
  };
}

function skipReason(ctx: BuilderCtx, vector: Vector, spec: BuilderSpec, row: BuilderRow, config: BuilderConfig): string | undefined {
  if (row.profiles !== undefined && !row.profiles.includes(ctx.host.name)) {
    return row.skipNote ?? `not for the ${ctx.host.name} host`;
  }
  if ((row.heavy === true || spec.heavy === true) && !(config.heavy || config.gate === "full")) {
    return "heavy row; run with --heavy or --gate full";
  }
  const gate = rowGate(vector, row);
  if (gate.status === "pending" && config.gate === "release") {
    return `pending (blocked by ${gate.blockedBy}); run with --gate full`;
  }
  return undefined;
}

function rowGate(vector: Vector, row: BuilderRow): Gate {
  return row.gate ?? vector.gate;
}

async function runRow(ctx: BuilderCtx, vector: Vector, row: BuilderRow): Promise<RowOutcome> {
  const label = `${vector.id}/${row.id}`;
  const gate = rowGate(vector, row);
  const expect: Expectation = row.expect;
  const notes: string[] = [];
  let observation: Observation;
  let response: HttpResponse | undefined;
  let skipNote: string | undefined;

  if (row.scenario !== undefined) {
    const scenario = await runScenario(ctx, row.scenario, label);
    observation = scenario.observation;
    skipNote = scenario.skip;
  } else {
    const spec = (row.save as (ctx: BuilderCtx) => SaveSpec)(ctx);
    if (ctx.saves >= ctx.config.maxSaves && (spec.method ?? "POST") === "POST") {
      throw new SaveBudgetExhausted(ctx.config.maxSaves);
    }
    if (ctx.host.name === "submissions" && ctx.stored === undefined) {
      ctx.stored = await ctx.host.readBack(ctx, `page ${label} baseline`);
    }
    const before = ctx.stored;
    const result = await ctx.host.save(ctx, row.htmlOk === true ? { ...spec, htmlOk: true } : spec, label);
    response = result.response;
    observation = result.observation;
    if (observation.kind === "refusal" && observation.refusal === "other" && observation.code === "redirect") {
      throw new AuthRedirect(`${label} (HTTP ${observation.http})`);
    }
    const writes = (spec.method ?? "POST") !== "GET";
    if (observation.kind === "answer") {
      afterAccepted(ctx, typeof spec.body === "string" && spec.body === baseBody(ctx));
    } else if (writes && row.noReadBack !== true) {
      const after = await ctx.host.readBack(ctx, `page ${label} after refusal`);
      const entry: BuilderCtx["atomicity"][number] = { row: label, status: result.response.status };
      if (before !== undefined && after !== undefined && !sameStored(before, after)) {
        entry.violation = `${label}: HTTP ${result.response.status} but the stored form changed (hash ${before.hash.slice(0, 12) || "?"} -> ${after.hash.slice(0, 12) || "?"})`;
      } else if (after === undefined) {
        entry.violation = `${label}: the form cannot be read back after HTTP ${result.response.status}`;
      }
      ctx.atomicity.push(entry);
      if (after !== undefined && before === undefined) {
        ctx.stored = after;
      }
    }
    if (observation.kind === "answer" && row.chain !== false) {
      const chained = await ctx.host.validate(ctx, `${label}/chained validate`);
      ctx.chained.push({ row: label, observation: chained.observation, status: chained.response.status });
    }
    if (observation.kind === "answer" && row.after !== undefined) {
      const problem = await row.after(ctx, { observation, response });
      if (problem !== undefined) {
        notes.push(problem);
      }
    }
  }

  if (skipNote !== undefined) {
    return { id: row.id, status: "SKIP", expected: describeExpectation(expect, CUSTOM_PREDICATES), observation: null, notes: [skipNote], skipped: true, gate, violated: false };
  }
  const env: PredicateEnv = { customs: CUSTOM_PREDICATES };
  const judgement = judge(expect, observation, env, null);
  let pass = judgement.pass && notes.length === 0;
  let violated = false;
  let reason = judgement.reason;
  if (violatesNever500(observation)) {
    pass = false;
    violated = true;
    reason = `never-500 rule: ${observation.kind === "refusal" ? observation.detail.slice(0, 300) : "the server broke"}`;
  }
  const status: ResultStatus = violated ? "FAIL" : statusFor({ pass, warn: judgement.warn && pass }, gate);
  const allNotes = [...(pass && !judgement.warn ? [] : [reason]), ...notes.filter((note) => !(pass && !judgement.warn) || true)];
  const secrets = Object.values(ctx.config.headers).filter((value) => value.length >= 6);
  const bodyOf = response !== undefined ? response.text.slice(0, 2048) : undefined;
  const evidence: VectorResult["evidence"] | undefined =
    response !== undefined
      ? {
          responseExcerpt: secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), bodyOf ?? "")
        }
      : undefined;
  return { id: row.id, status, expected: describeExpectation(expect, CUSTOM_PREDICATES), observation, notes: Array.from(new Set(allNotes.filter((note) => note !== "ok"))), skipped: false, ...(evidence !== undefined ? { evidence } : {}), gate, violated };
}

interface ScenarioResult {
  observation: Observation;
  skip?: string;
}

/** The scenarios that more than one vector reads: one save and one set of read-backs. */
const scenarioCache = new WeakMap<BuilderCtx, { secrets?: Promise<{ save: Observation; publicCopy?: { definition: unknown }; unreadable?: string }> }>();

async function secrets(ctx: BuilderCtx, label: string): Promise<{ save: Observation; publicCopy?: { definition: unknown }; unreadable?: string }> {
  const cache = scenarioCache.get(ctx) ?? {};
  scenarioCache.set(ctx, cache);
  cache.secrets ??= (async () => {
    if (ctx.saves >= ctx.config.maxSaves) {
      throw new SaveBudgetExhausted(ctx.config.maxSaves);
    }
    const saved = await ctx.host.save(ctx, { body: retargetDefinitionText(secretsDefinition(), ctx.formId) }, `${label}/save secrets`);
    if (saved.observation.kind !== "answer") {
      return { save: saved.observation, unreadable: `the secret-rule definition was not saved (${saved.observation.kind === "refusal" ? saved.observation.refusal : "unexpected"})` };
    }
    afterAccepted(ctx, false);
    const publicCopy = await ctx.host.readPublic(ctx, label);
    return {
      save: saved.observation,
      ...("unreadable" in publicCopy ? { unreadable: publicCopy.unreadable } : { publicCopy })
    };
  })();
  return cache.secrets;
}

async function runScenario(ctx: BuilderCtx, scenario: NonNullable<BuilderRow["scenario"]>, label: string): Promise<ScenarioResult> {
  switch (scenario) {
    case "base-save":
      return { observation: ctx.baseSave?.observation ?? { kind: "refusal", refusal: "other", detail: "the base fixture was not saved" } };
    case "secrets-public": {
      const found = await secrets(ctx, label);
      if (found.publicCopy === undefined) {
        return { observation: found.save, skip: found.unreadable ?? "the public copy cannot be read" };
      }
      return { observation: { kind: "answer", json: { definition: found.publicCopy.definition as Json } } };
    }
    case "secrets-check": {
      const found = await secrets(ctx, label);
      const read = ctx.host.readCheck !== undefined && found.save.kind === "answer" ? await ctx.host.readCheck(ctx, label) : undefined;
      if (read === undefined || "unreadable" in read) {
        return { observation: found.save, skip: read !== undefined && "unreadable" in read ? read.unreadable : (found.unreadable ?? "this host has no check route") };
      }
      return { observation: { kind: "answer", json: read.answer as Json } };
    }
    case "twice": {
      if (ctx.dirty) {
        await restoreBase(ctx);
      }
      const one = await ctx.host.save(ctx, { body: baseBody(ctx) }, `${label}/first`);
      const hashOne = ctx.host.hashOf(one.response);
      if (one.observation.kind === "answer") {
        afterAccepted(ctx, true);
      }
      const two = await ctx.host.save(ctx, { body: baseBody(ctx) }, `${label}/second`);
      const hashTwo = ctx.host.hashOf(two.response);
      if (two.observation.kind === "answer") {
        afterAccepted(ctx, true);
      }
      if (one.observation.kind !== "answer" || two.observation.kind !== "answer") {
        return { observation: two.observation.kind === "answer" ? one.observation : two.observation };
      }
      const rb = await ctx.host.readBack(ctx, `${label} read back`);
      const readBackMatchesResponse = rb !== undefined;
      // An unknown top-level member: kept as stored, or reported in the answer's warnings.
      const withExtra = `${baseBody(ctx).slice(0, -1)},"x-suite-extra":"kept"}`;
      const three = await ctx.host.save(ctx, { body: withExtra }, `${label}/unknown member`);
      let unknownKeyKept = false;
      if (three.observation.kind === "answer") {
        afterAccepted(ctx, false);
        const stored = await ctx.host.readBack(ctx, `${label} read back unknown member`);
        const kept = (stored?.definition as Record<string, unknown> | undefined)?.["x-suite-extra"] === "kept";
        const warned = Array.isArray((three.response.json as { warnings?: unknown } | undefined)?.warnings) && ((three.response.json as { warnings: unknown[] }).warnings.length > 0);
        unknownKeyKept = kept || warned;
      }
      return { observation: { kind: "answer", json: { sameHash: hashOne !== undefined && hashOne === hashTwo, readBackMatchesResponse, unknownKeyKept } } };
    }
  }
}

interface Cleanup {
  complete: boolean;
  detail: string;
  remedy?: string;
  gone: boolean;
  restored?: boolean;
  skipped: boolean;
}

/** Removes what the run made; never throws. Create mode deletes the form and checks it is gone; adopt mode restores the original definition and never deletes. */
async function cleanUp(ctx: BuilderCtx, input: { adopt: boolean; created: boolean; original: StoredForm | undefined; state: RunState }): Promise<Cleanup> {
  const { config } = ctx;
  try {
    if (input.adopt) {
      if (input.original === undefined) {
        return { complete: true, detail: "nothing was adopted", gone: false, skipped: true };
      }
      const restored = await ctx.host.restore(ctx, input.original);
      const after = restored ? await ctx.host.readBack(ctx, "page build after restore") : undefined;
      const same = after !== undefined && sameStored(input.original, after);
      if (same) {
        removeState(config.stateFile);
      } else {
        writeState(config.stateFile, { ...input.state, phase: "cleaning", recordsCreated: ctx.recordsCreated, original: { text: input.original.text, hash: input.original.hash } });
      }
      return {
        complete: same,
        detail: same ? (ctx.recordsCreated > 0 ? `the definition was restored; ${ctx.recordsCreated} record(s) remain in the adopted form "${ctx.formId}" (the suite never clears an adopted form: clear them from its Submissions tab)` : "the original definition was restored") : "the original definition could not be restored; it is in the state file",
        remedy: `restore the definition saved in ${config.stateFile} (original.text) with the builder's Save`,
        gone: false,
        restored: same,
        skipped: false
      };
    }
    if (!input.created) {
      return { complete: true, detail: "nothing was created", gone: true, skipped: true };
    }
    writeState(config.stateFile, { ...input.state, phase: "cleaning", recordsCreated: ctx.recordsCreated, keys: [...ctx.keys] });
    const removed = await ctx.host.remove(ctx);
    const gone = removed.complete && (await ctx.host.isGone(ctx));
    if (gone) {
      removeState(config.stateFile);
      return { complete: true, detail: removed.detail, gone: true, skipped: false };
    }
    return { complete: false, detail: removed.complete ? `${removed.detail}, but the form is still there` : removed.detail, remedy: removed.remedy, gone: false, skipped: false };
  } catch (error) {
    const reason = error instanceof AllowlistViolation ? error.message : error instanceof Error ? error.message : String(error);
    return { complete: false, detail: `cleanup failed: ${reason}`, remedy: `DELETE /api/forms/<key>?cascade=true for "${ctx.formId}"`, gone: false, skipped: false };
  }
}

function derivedResults(ctx: BuilderCtx, wanted: (id: string) => Vector | undefined, cleanup: Cleanup, adopt: boolean, original: StoredForm | undefined, config: BuilderConfig): VectorResult[] {
  const out: VectorResult[] = [];
  const make = (id: string, build: (vector: Vector) => Omit<VectorResult, keyof ReturnType<typeof bare>> & Partial<VectorResult>): void => {
    const vector = wanted(id) ?? (DERIVED_BUILDER_IDS.includes(id) ? undefined : undefined);
    if (vector !== undefined) {
      out.push({ ...bare(vector), ...build(vector) } as VectorResult);
    }
  };

  make("BLD-04", (vector) => {
    const observation: Observation = { kind: "answer", json: { checked: ctx.atomicity.length, violations: ctx.atomicity.flatMap((entry) => (entry.violation !== undefined ? [entry.violation] : [])) } };
    const judgement = judge(vector.expect, observation, { customs: CUSTOM_PREDICATES }, null);
    return { status: statusFor(judgement, vector.gate), observed: observation, notes: judgement.pass && !judgement.warn ? undefined : judgement.reason } as never;
  });

  make("BLD-09", (vector) => {
    // A 503 is typed whatever its code: the service is unavailable, or the run failed (wasm.execution_error) and gave no verdict.
    const typed = ctx.chained.filter((entry) => entry.observation.kind !== "verdict" && entry.status !== 503);
    const failClosed = ctx.chained.filter((entry) => entry.observation.kind === "verdict" && entry.observation.errors.some((error) => error.code === "journey.invalid" || error.code === "formula.invalid"));
    const observation: Observation = { kind: "answer", json: { chained: ctx.chained.length, notTyped: typed.map((entry) => `${entry.row}: HTTP ${entry.status}`), failClosed: failClosed.map((entry) => entry.row) } };
    const typedStatus: ResultStatus = ctx.chained.length === 0 ? "SKIP" : typed.length === 0 ? "PASS" : "FAIL";
    const gate = vector.gate;
    const failClosedStatus: ResultStatus = ctx.chained.length === 0 ? "SKIP" : statusFor({ pass: failClosed.length === 0, warn: false }, gate);
    const status = combine([typedStatus === "SKIP" ? "PASS" : typedStatus, failClosedStatus === "SKIP" ? "PASS" : failClosedStatus]);
    return {
      status: ctx.chained.length === 0 ? "SKIP" : status,
      observed: observation,
      variants: [
        { id: "chained-check-is-typed", status: typedStatus, expected: "a typed verdict (or a typed 503) after each accepted save", observed: observation },
        { id: "no-fail-closed-after-an-accepted-save", status: failClosedStatus, expected: "an accepted save never leaves a definition the judge refuses (journey.invalid, formula.invalid)", observed: observation }
      ],
      notes: [...typed.map((entry) => `${entry.row}: the chained check answered ${entry.observation.kind === "refusal" ? entry.observation.refusal : entry.observation.kind} (HTTP ${entry.status})`), ...failClosed.map((entry) => `${entry.row}: saved, but the judge refuses it`)].join("; ") || (ctx.chained.length === 0 ? "no save was accepted, so there was nothing to check" : undefined)
    } as never;
  });

  make("BLD-10", () => {
    if (cleanup.skipped) {
      return { status: "SKIP", notes: cleanup.detail } as never;
    }
    if (adopt) {
      return { status: "SKIP", notes: "adopt mode never deletes the form; see BLD-11" } as never;
    }
    return {
      status: cleanup.complete ? "PASS" : "ERROR",
      observed: { kind: "answer", json: { gone: cleanup.gone, detail: cleanup.detail } },
      notes: cleanup.complete ? undefined : `${cleanup.detail}. Remedy: ${cleanup.remedy ?? ""}`
    } as never;
  });

  make("BLD-11", () => {
    if (!adopt || original === undefined) {
      return { status: "SKIP", notes: "create mode; there is no adopted form to restore" } as never;
    }
    return { status: cleanup.restored === true ? "PASS" : "FAIL", observed: { kind: "answer", json: { restored: cleanup.restored === true } }, notes: cleanup.restored === true ? undefined : cleanup.detail } as never;
  });

  // SEC-01 and SEC-05 over every JSON exchange of the builder run.
  const exchanges = ctx.client.exchanges;
  const sec01 = wanted("SEC-01");
  if (sec01 !== undefined && sec01.class === "secrecy") {
    const leaks = exchanges.filter((exchange) => !exchange.label.startsWith("page ") && exchange.text.includes("ZZSECRETZZ")).map((exchange) => `${exchange.method} ${exchange.path} -> ${exchange.status}`);
    out.push({
      ...bare(sec01),
      runner: "builder",
      status: statusFor({ pass: leaks.length === 0, warn: false }, sec01.gate),
      expected: "no response of the builder run (a 422's problems included) names a server-secret rule's text",
      observed: { kind: "answer", json: { responses: exchanges.length, leaks } },
      ...(leaks.length > 0 ? { notes: leaks.join(" | ") } : {})
    });
  }
  const sec05 = wanted("SEC-05");
  if (sec05 !== undefined && sec05.class === "secrecy") {
    const problems = exchanges.flatMap((exchange) => builderWireProblems(exchange));
    out.push({
      ...bare(sec05),
      runner: "builder",
      status: statusFor({ pass: problems.length === 0, warn: false }, sec05.gate),
      expected: "no 5xx but a typed 503, JSON bodies where JSON is promised, no stack trace or host path, over every response of the builder run",
      observed: { kind: "answer", json: { responses: exchanges.length, problems: problems.slice(0, 20) } },
      ...(problems.length > 0 ? { notes: problems.slice(0, 20).join(" | ") } : {})
    });
  }
  void config;
  return out;
}

/** The cleanup subcommand: reads the state file and removes what a killed run left. */
export async function runBuilderCleanup(config: Omit<BuilderConfig, "host" | "onlyIds" | "builderForm">): Promise<{ ok: boolean; message: string }> {
  const state = readState(config.stateFile);
  if (state === undefined) {
    return { ok: true, message: `no state file at ${config.stateFile}: nothing to clean up` };
  }
  if (state.baseUrl !== stripCredentials(config.baseUrl)) {
    return { ok: false, message: `the state file is for ${state.baseUrl}, not ${stripCredentials(config.baseUrl)}` };
  }
  const host = hostFor(state.host);
  const budget = new Budget({ maxRequests: 60, delayMs: config.delayMs, ...(config.sleep !== undefined ? { sleep: config.sleep } : {}) });
  const full: BuilderConfig = { ...config, host: state.host, builderForm: state.mode === "adopt" ? state.formId : undefined } as BuilderConfig;
  const ctx: BuilderCtx = {
    config: full,
    client: undefined as never,
    host,
    dirty: false,
    formId: state.formId,
    formVersion: state.formVersion,
    recordsCreated: state.recordsCreated,
    saves: 0,
    keys: new Set(state.keys ?? []),
    atomicity: [],
    chained: [],
    notes: []
  };
  const target: EndpointTarget = { baseUrl: config.baseUrl, profile: state.host, formId: state.formId, formVersion: state.formVersion, allowWrites: true };
  ctx.client = new HttpClient({ target, budget, timeoutMs: config.timeoutMs, headers: config.headers, allow: host.allow(ctx), ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}) });
  try {
    await host.prepare(ctx);
    const original = state.original !== undefined ? ({ definition: JSON.parse(state.original.text) as unknown, hash: state.original.hash, text: state.original.text } satisfies StoredForm) : undefined;
    const cleanup = await cleanUp(ctx, { adopt: state.mode === "adopt", created: state.mode === "create", original, state });
    return { ok: cleanup.complete, message: cleanup.complete ? `cleaned up ${state.formId}: ${cleanup.detail}` : `could not clean up ${state.formId}: ${cleanup.detail}. Remedy: ${cleanup.remedy ?? ""}` };
  } catch (error) {
    return { ok: false, message: `cleanup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
