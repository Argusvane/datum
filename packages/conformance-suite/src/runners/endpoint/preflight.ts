import { validValues } from "../../fixtures/base-form.js";
import type { Json, Observation } from "../../observation.js";
import { BudgetExhausted, RateLimitedOut } from "./budget.js";
import { TransportError } from "./http.js";
import { sendSpec, type Runtime } from "./runtime.js";
import { isFixtureProblem } from "./wire.js";

/** One thing the run checks before it sends a single attack: the fixture is installed and the account may use it. */
export interface PreflightCheck {
  /** The vector the check stands for: CTL-01, CTL-02, OPT-01; FIXTURE for the marker. */
  id: "CTL-01" | "CTL-02" | "OPT-01" | "FIXTURE";
  ok: boolean;
  /** What is wrong and what to do about it. */
  message: string;
  observation?: Observation;
}

export interface PreflightOutcome {
  ok: boolean;
  checks: PreflightCheck[];
  /** The ids of the checks that passed (the report's evidence list). */
  evidence: string[];
  /** The fixture marker's value when the public definition could be read, else undefined. */
  marker: string | undefined;
  /** True when the definition was read and carries the fixture marker. */
  markerVerified: boolean;
}

const validBody = (): Record<string, Json> => validValues() as Record<string, Json>;

export async function runPreflight(runtime: Runtime): Promise<PreflightOutcome> {
  const checks: PreflightCheck[] = [];
  const finish = (marker?: string, markerVerified = false): PreflightOutcome => ({
    ok: checks.every((check) => check.ok),
    checks,
    evidence: checks.filter((check) => check.ok && check.id !== "FIXTURE").map((check) => check.id),
    marker,
    markerVerified
  });

  const steps: { id: PreflightCheck["id"]; values: Json; accept: (observation: Observation) => string | undefined; wanted: string }[] = [
    {
      id: "CTL-01",
      values: validBody(),
      wanted: "a valid submission accepted with no errors",
      accept: (observation) => (observation.kind === "verdict" && observation.accepted && observation.errors.length === 0 ? undefined : "")
    },
    {
      id: "CTL-02",
      values: { ...validBody(), name: "" },
      wanted: "exactly required@name for a blank name",
      accept: (observation) => (observation.kind === "verdict" && !observation.accepted && observation.errors.length === 1 && observation.errors[0]?.code === "required" && observation.errors[0]?.field === "name" ? undefined : "")
    },
    {
      id: "OPT-01",
      values: { ...validBody(), addr: { city: "Ottawa", pick: "ZZ" } },
      wanted: "exactly option.notAllowed@pick for an answer outside the options",
      accept: (observation) =>
        observation.kind === "verdict" && !observation.accepted && observation.errors.length === 1 && observation.errors[0]?.code === "option.notAllowed" && observation.errors[0]?.field === "pick" ? undefined : ""
    }
  ];

  for (const step of steps) {
    let observation: Observation;
    try {
      observation = (await sendSpec(runtime, { kind: "check", values: step.values }, `preflight ${step.id}`)).observation;
    } catch (error) {
      if (error instanceof RateLimitedOut || error instanceof BudgetExhausted) {
        throw error;
      }
      const message = error instanceof TransportError ? error.message : error instanceof Error ? error.message : String(error);
      checks.push({ id: step.id, ok: false, message: `cannot reach the endpoint: ${message}. Check --endpoint, the network and the proxy.` });
      return finish();
    }
    if (step.accept(observation) === undefined) {
      checks.push({ id: step.id, ok: true, message: step.wanted, observation });
      continue;
    }
    checks.push({ id: step.id, ok: false, message: diagnose(observation, step.id, step.wanted, runtime), observation });
    return finish();
  }

  // The fixture marker, when the public definition can be read.
  let marker: string | undefined;
  let markerVerified = false;
  if (runtime.definitionUrl !== undefined) {
    const read = await sendSpec(runtime, { kind: "get", what: "definition" }, "preflight marker");
    const body = read.observation.kind === "answer" ? (read.observation.json as { status?: number; body?: unknown }) : undefined;
    if (body?.status === 200 && body.body !== null && typeof body.body === "object") {
      const configuration = ((body.body as { root?: { configuration?: Record<string, unknown> } }).root?.configuration ?? {}) as Record<string, unknown>;
      const value = configuration["securitySuiteFixture"];
      if (value === "1") {
        marker = "1";
        markerVerified = true;
        checks.push({ id: "FIXTURE", ok: true, message: "the public definition carries the fixture marker" });
      } else {
        checks.push({
          id: "FIXTURE",
          ok: false,
          message: `the public definition is not the suite's fixture (root.configuration.securitySuiteFixture is ${JSON.stringify(value)}, not "1"): install it with \`datum-security-check fixture\``
        });
      }
    } else {
      checks.push({
        id: "FIXTURE",
        ok: true,
        message: `the public definition at ${runtime.definitionUrl} could not be read (HTTP ${String(body?.status ?? "?")}); the fixture marker is not verified`
      });
    }
  }
  return finish(marker, markerVerified);
}

/** What is misconfigured, from the way the server answered the control. */
function diagnose(observation: Observation, id: PreflightCheck["id"], wanted: string, runtime: Runtime): string {
  const tail = `Preflight ${id} wanted ${wanted}.`;
  const problem = isFixtureProblem(observation);
  if (problem !== undefined) {
    return `${problem}. ${tail}`;
  }
  if (observation.kind === "refusal") {
    switch (observation.refusal) {
      case "not_found":
        return `HTTP 404: no such form or route. Check --endpoint and --form "${runtime.target.formId}". ${tail}`;
      case "outdated":
        return `HTTP 409 ${observation.code ?? ""}: the form's version is not "${runtime.target.formVersion}". Pass the installed version with --form-version. ${tail}`;
      case "unavailable":
        return `HTTP ${observation.http ?? 503}: the server's sandbox is unavailable. ${tail}`;
      case "server_error":
      case "malformed_response":
        return `${observation.detail}. The server broke on a well-formed check. ${tail}`;
      case "bad_document":
        return `HTTP 400 bad_document for a well-formed check: the form is probably not the fixture (the journey "main" is missing, or the form id differs). ${tail}`;
      case "method":
        return `HTTP 405: the check route does not accept POST here. Check --profile. ${tail}`;
      default:
        return `${observation.detail}. ${tail}`;
    }
  }
  if (observation.kind === "verdict") {
    const seen = observation.errors.map((error) => (error.field !== undefined && error.field !== null ? `${error.code}@${error.field}` : error.code)).join(", ");
    if (observation.errors.some((error) => error.code === "journey.unknown")) {
      return `the form has no journey "main" (journey.unknown): install the fixture form. ${tail}`;
    }
    if (observation.errors.some((error) => error.code.startsWith("spam."))) {
      return `the form's anti-spam check fired (${seen}): switch it off on the fixture form. ${tail}`;
    }
    return `the form answered ${observation.accepted ? "accepted" : "rejected"} [${seen}]: it does not behave as the fixture form (install it with \`datum-security-check fixture\`). ${tail}`;
  }
  return tail;
}
