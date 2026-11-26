import { errorToken, observationText, type Json, type Observation, type RefusalKind } from "./observation.js";

/**
 * The serialisable predicate DSL. A vector's `expect` is data, so the Markdown
 * report prints it, `explain <id>` shows it and the endpoint table derives from it. The one
 * code-defined escape hatch is `custom`, which must be registered by name and describe itself.
 */
export type Expectation =
  /** The verdict accepted (or did not). A refusal is never accepted. */
  | { op: "accepted"; value: boolean }
  /**
   * Error tokens (`code@field`, or `code` to match any field). `exactly`: the same multiset;
   * `includes`: each present; `excludes`: each absent.
   */
  | { op: "codes"; exactly?: string[]; includes?: string[]; excludes?: string[] }
  /** None of these texts appear anywhere in the sanitized values. */
  | { op: "valuesExcludeText"; text: string[] }
  /** None of these markers appear anywhere in the whole observation's JSON. */
  | { op: "textExcludes"; markers: string[] }
  /** Every one of these markers appears somewhere in the whole observation's JSON. */
  | { op: "textIncludes"; markers: string[] }
  /**
   * The program's outcome JSON (a verdict's `raw`) at a dotted path (`errors.0.parameters.message`,
   * `digest`): `equals` (deep equal), `contains` (an array holding it, or a text containing it) or
   * `absent` (nothing there).
   */
  | { op: "rawAt"; path: string; equals?: Json; contains?: Json; absent?: boolean }
  /** The outcome text's length and SHA-256 equal the golden case's (`golden.goldenCase`): the program wrote the pinned bytes. */
  | { op: "goldenCase" }
  /** Some log message matches the pattern. */
  | { op: "logsSome"; pattern: string; flags?: string }
  /** No log message is longer than `max` characters. */
  | { op: "logsMaxMessage"; max: number }
  /**
   * The observation is a refusal of one of these kinds, and (when `codes` is given) carries one of
   * those typed codes, and (when `includesCodes` is given) every one of those is among the codes
   * the body listed (a 422's `kernel[]`).
   */
  | { op: "refusal"; anyOf: RefusalKind[]; codes?: string[]; includesCodes?: string[] }
  /**
   * One of an inspect answer's problem lists (`check`: `problems`, `warnings`, `structure`,
   * `structureWarnings`) as `code@where` tokens: `where` exact, or `prefix*`; a bare `code`
   * matches any `where`. `includes`/`exactly` on a list the answer does not have FAIL;
   * `excludes` and `max` pass on an absent list. `last`
   * is the code of the final entry.
   */
  | { op: "answerProblems"; list: "structure" | "structureWarnings" | "problems" | "warnings"; includes?: string[]; excludes?: string[]; exactly?: string[]; max?: number; last?: string }
  /** The whole answer, as JSON text, is at most this many bytes (UTF-8). */
  | { op: "answerSize"; maxBytes: number }
  /** The verdict's digest equals the named golden digest (`golden.documents[name].digest`). */
  | { op: "digestEquals"; golden: string }
  /** The verdict's canonical text equals the named golden document's. */
  | { op: "canonicalEquals"; golden: string }
  /** The observation matches the pinned control `golden.controls[key]` (accepted, error tokens, sanitized values). */
  | { op: "golden"; key: string }
  /** An inspect answer holds `equals` at the dotted path (`ok`, `error.code`). */
  | { op: "answerPath"; path: string; equals: Json }
  /** The run ended within `ms`. */
  | { op: "elapsedMax"; ms: number }
  | { op: "all"; of: Expectation[] }
  | { op: "any"; of: Expectation[] }
  | { op: "not"; of: Expectation }
  | { op: "custom"; name: string };

export interface GoldenControl {
  accepted: boolean;
  errors: string[];
  values?: Json;
}

/** What predicates may consult besides the observation. */
export interface PredicateEnv {
  elapsedMs?: number;
  golden?: {
    controls: Record<string, GoldenControl>;
    documents: { name: string; canonical: string; digest: string }[];
    goldenCase?: { canonicalLength: number; canonicalSha256: string };
  };
  customs?: Record<string, CustomPredicate>;
}

export interface CustomPredicate {
  describe(): string;
  check(observation: Observation, env: PredicateEnv): PredicateResult;
}

export interface PredicateResult {
  pass: boolean;
  /** A pass that still deserves a WARN row (a banner that disagrees with the program's own answer). */
  warn?: boolean;
  /** Why it failed (or, on a pass, what was seen); short. */
  reason: string;
}

const pass = (reason = "ok"): PredicateResult => ({ pass: true, reason });
const fail = (reason: string): PredicateResult => ({ pass: false, reason });

export function evaluate(expect: Expectation, observation: Observation, env: PredicateEnv = {}): PredicateResult {
  switch (expect.op) {
    case "accepted": {
      if (observation.kind !== "verdict") {
        return fail(`wanted ${expect.value ? "accepted" : "rejected"}, got ${observation.kind}`);
      }
      return observation.accepted === expect.value ? pass() : fail(`wanted ${expect.value ? "accepted" : "rejected"}, got ${observation.accepted ? "accepted" : "rejected"}`);
    }
    case "codes": {
      if (observation.kind !== "verdict") {
        return fail(`wanted a verdict, got ${observation.kind}`);
      }
      const observed = observation.errors.map(errorToken);
      if (expect.exactly !== undefined) {
        const rest = observation.errors.map((error) => ({ code: error.code, token: errorToken(error) }));
        for (const want of expect.exactly) {
          const at = rest.findIndex((entry) => matchesToken(entry, want));
          if (at < 0) {
            return fail(`missing ${want}; saw [${observed.join(", ")}]`);
          }
          rest.splice(at, 1);
        }
        if (rest.length > 0) {
          return fail(`unexpected ${rest.map((entry) => entry.token).join(", ")}; wanted exactly [${expect.exactly.join(", ")}]`);
        }
      }
      for (const want of expect.includes ?? []) {
        if (!observation.errors.some((error) => matchesToken({ code: error.code, token: errorToken(error) }, want))) {
          return fail(`missing ${want}; saw [${observed.join(", ")}]`);
        }
      }
      for (const unwanted of expect.excludes ?? []) {
        if (observation.errors.some((error) => matchesToken({ code: error.code, token: errorToken(error) }, unwanted))) {
          return fail(`unexpected ${unwanted}; saw [${observed.join(", ")}]`);
        }
      }
      return pass(`[${observed.join(", ")}]`);
    }
    case "valuesExcludeText": {
      if (observation.kind !== "verdict") {
        return fail(`wanted a verdict, got ${observation.kind}`);
      }
      const text = JSON.stringify(observation.values ?? null);
      const found = expect.text.find((needle) => text.includes(needle));
      return found === undefined ? pass() : fail(`the sanitized values contain ${JSON.stringify(found)}`);
    }
    case "textExcludes": {
      const text = observationText(observation);
      const found = expect.markers.find((marker) => text.includes(marker));
      return found === undefined ? pass() : fail(`the observation contains ${JSON.stringify(found)}`);
    }
    case "textIncludes": {
      const text = observationText(observation);
      const missing = expect.markers.find((marker) => !text.includes(marker));
      return missing === undefined ? pass() : fail(`the observation lacks ${JSON.stringify(missing)}`);
    }
    case "rawAt": {
      if (observation.kind !== "verdict" || observation.raw === undefined) {
        return fail(`wanted a verdict with an outcome, got ${observation.kind}`);
      }
      let at: unknown = observation.raw;
      for (const key of expect.path.split(".")) {
        at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[key] : undefined;
      }
      if (expect.absent === true) {
        return at === undefined ? pass() : fail(`${expect.path} is present: ${JSON.stringify(at).slice(0, 120)}`);
      }
      if (expect.equals !== undefined) {
        return JSON.stringify(at) === JSON.stringify(expect.equals) ? pass() : fail(`${expect.path} is ${JSON.stringify(at)?.slice(0, 120)}, wanted ${JSON.stringify(expect.equals)}`);
      }
      if (expect.contains !== undefined) {
        const held = Array.isArray(at)
          ? at.some((item) => JSON.stringify(item) === JSON.stringify(expect.contains))
          : typeof at === "string" && typeof expect.contains === "string" && at.includes(expect.contains);
        return held ? pass() : fail(`${expect.path} (${JSON.stringify(at)?.slice(0, 120)}) does not contain ${JSON.stringify(expect.contains)}`);
      }
      return at !== undefined ? pass() : fail(`${expect.path} is absent`);
    }
    case "goldenCase": {
      if (observation.kind !== "verdict" || observation.outcome === undefined) {
        return fail(`wanted a verdict with outcome bytes, got ${observation.kind}`);
      }
      const pinned = env.golden?.goldenCase;
      if (pinned === undefined) {
        return fail("the golden file has no golden case");
      }
      if (observation.outcome.length !== pinned.canonicalLength) {
        return fail(`the outcome is ${observation.outcome.length} characters, golden says ${pinned.canonicalLength}`);
      }
      return observation.outcome.sha256 === pinned.canonicalSha256 ? pass() : fail(`the outcome's SHA-256 ${observation.outcome.sha256.slice(0, 12)}... differs from golden ${pinned.canonicalSha256.slice(0, 12)}...`);
    }
    case "logsSome": {
      if (observation.kind !== "verdict") {
        return fail(`wanted a verdict, got ${observation.kind}`);
      }
      const pattern = new RegExp(expect.pattern, expect.flags);
      return (observation.logs ?? []).some((entry) => pattern.test(entry.message)) ? pass() : fail(`no log message matches /${expect.pattern}/`);
    }
    case "logsMaxMessage": {
      if (observation.kind !== "verdict") {
        return fail(`wanted a verdict, got ${observation.kind}`);
      }
      const longest = Math.max(0, ...(observation.logs ?? []).map((entry) => entry.message.length));
      return longest <= expect.max ? pass(`longest ${longest}`) : fail(`a log message is ${longest} characters, over ${expect.max}`);
    }
    case "refusal": {
      if (observation.kind !== "refusal") {
        return fail(`wanted a refusal of ${expect.anyOf.join("|")}, got ${observation.kind}`);
      }
      if (!expect.anyOf.includes(observation.refusal)) {
        return fail(`wanted a refusal of ${expect.anyOf.join("|")}, got ${observation.refusal}${observation.code !== undefined ? ` (${observation.code})` : ""}: ${observation.detail}`);
      }
      if (expect.codes !== undefined && (observation.code === undefined || !expect.codes.includes(observation.code))) {
        return fail(`wanted a refusal coded ${expect.codes.join("|")}, got ${observation.code ?? "no code"}: ${observation.detail}`);
      }
      if (expect.includesCodes !== undefined) {
        const held = observation.codes ?? (observation.code !== undefined ? [observation.code] : []);
        const missing = expect.includesCodes.find((code) => !held.some((entry) => entry === code || entry.startsWith(`${code}@`)));
        if (missing !== undefined) {
          return fail(`the refusal lacks the code ${missing}; it listed [${held.join(", ")}]`);
        }
      }
      return pass(observation.refusal);
    }
    case "answerProblems": {
      if (observation.kind !== "answer") {
        return fail(`wanted an answer, got ${observation.kind}`);
      }
      return judgeProblems(expect, observation.json);
    }
    case "answerSize": {
      if (observation.kind !== "answer") {
        return fail(`wanted an answer, got ${observation.kind}`);
      }
      const bytes = Buffer.byteLength(JSON.stringify(observation.json) ?? "", "utf8");
      return bytes <= expect.maxBytes ? pass(`${bytes} bytes`) : fail(`the answer is ${bytes} bytes, over ${expect.maxBytes}`);
    }
    case "digestEquals":
    case "canonicalEquals": {
      if (observation.kind !== "verdict") {
        return fail(`wanted a verdict, got ${observation.kind}`);
      }
      const document = env.golden?.documents.find((entry) => entry.name === expect.golden);
      if (document === undefined) {
        return fail(`golden document ${expect.golden} is not in the golden file`);
      }
      const seen = expect.op === "digestEquals" ? observation.digest : observation.canonical;
      const want = expect.op === "digestEquals" ? document.digest : document.canonical;
      return seen === want ? pass() : fail(`${expect.op === "digestEquals" ? "digest" : "canonical text"} ${seen === undefined ? "absent" : "differs"} from golden ${expect.golden}`);
    }
    case "golden": {
      if (observation.kind !== "verdict") {
        return fail(`wanted a verdict, got ${observation.kind}`);
      }
      const control = env.golden?.controls[expect.key];
      if (control === undefined) {
        return fail(`golden control ${expect.key} is not in the golden file`);
      }
      if (observation.accepted !== control.accepted) {
        return fail(`golden says ${control.accepted ? "accepted" : "rejected"}, got ${observation.accepted ? "accepted" : "rejected"}`);
      }
      const seen = observation.errors.map(errorToken).sort();
      const want = [...control.errors].sort();
      if (seen.length !== want.length || seen.some((token, at) => token !== want[at])) {
        return fail(`golden errors [${want.join(", ")}], got [${seen.join(", ")}]`);
      }
      if (control.values !== undefined && JSON.stringify(sortKeys(observation.values ?? null)) !== JSON.stringify(sortKeys(control.values))) {
        return fail(`the sanitized values differ from golden: ${JSON.stringify(observation.values ?? null)}`);
      }
      return pass();
    }
    case "answerPath": {
      if (observation.kind !== "answer") {
        return fail(`wanted an answer, got ${observation.kind}`);
      }
      let at: unknown = observation.json;
      for (const key of expect.path.split(".")) {
        // A list is read by index (`report.scenarios.1.status`), the one place an answer holds a list the vectors judge.
        if (Array.isArray(at)) {
          at = /^(0|[1-9][0-9]*)$/.test(key) ? at[Number(key)] : undefined;
        } else {
          at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[key] : undefined;
        }
      }
      return JSON.stringify(at) === JSON.stringify(expect.equals) ? pass() : fail(`${expect.path} is ${JSON.stringify(at)}, wanted ${JSON.stringify(expect.equals)}`);
    }
    case "elapsedMax": {
      const elapsed = env.elapsedMs;
      if (elapsed === undefined) {
        return fail("no elapsed time was measured");
      }
      return elapsed <= expect.ms ? pass(`${Math.round(elapsed)} ms`) : fail(`took ${Math.round(elapsed)} ms, over ${expect.ms} ms`);
    }
    case "all": {
      for (const part of expect.of) {
        const result = evaluate(part, observation, env);
        if (!result.pass) {
          return result;
        }
      }
      return pass();
    }
    case "any": {
      const reasons: string[] = [];
      for (const part of expect.of) {
        const result = evaluate(part, observation, env);
        if (result.pass) {
          return result;
        }
        reasons.push(result.reason);
      }
      return fail(`none held: ${reasons.join("; ")}`);
    }
    case "not": {
      const inner = evaluate(expect.of, observation, env);
      return inner.pass ? fail(`${describe(expect.of)} held, wanted it not to`) : pass();
    }
    case "custom": {
      const custom = env.customs?.[expect.name];
      return custom === undefined ? fail(`custom predicate ${expect.name} is not registered`) : custom.check(observation, env);
    }
  }
}

/** `code@where` for one problem entry (`where` empty: just the code). */
export function problemToken(entry: unknown): string {
  const record = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const code = typeof record["code"] === "string" ? record["code"] : "?";
  return typeof record["where"] === "string" && record["where"] !== "" ? `${code}@${record["where"]}` : code;
}

function problemMatches(token: string, want: string): boolean {
  if (!want.includes("@")) {
    return token === want || token.startsWith(`${want}@`);
  }
  if (want.endsWith("*")) {
    return token.startsWith(want.slice(0, -1));
  }
  return token === want;
}

function judgeProblems(expect: Extract<Expectation, { op: "answerProblems" }>, json: Json): PredicateResult {
  const answer = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, Json>) : {};
  const list = answer[expect.list];
  if (!Array.isArray(list)) {
    if (expect.includes !== undefined || expect.exactly !== undefined || expect.last !== undefined) {
      return fail(`the answer has no ${expect.list} list`);
    }
    return pass(`no ${expect.list} list`);
  }
  const tokens = list.map(problemToken);
  const shown = `${expect.list} [${tokens.slice(0, 6).join(", ")}${tokens.length > 6 ? `, ... ${tokens.length} in all` : ""}]`;
  for (const want of expect.includes ?? []) {
    if (!tokens.some((token) => problemMatches(token, want))) {
      return fail(`${expect.list} lacks ${want}; ${shown}`);
    }
  }
  for (const unwanted of expect.excludes ?? []) {
    if (tokens.some((token) => problemMatches(token, unwanted))) {
      return fail(`${expect.list} holds ${unwanted}; ${shown}`);
    }
  }
  if (expect.exactly !== undefined) {
    const rest = [...tokens];
    for (const want of expect.exactly) {
      const at = rest.findIndex((token) => problemMatches(token, want));
      if (at < 0) {
        return fail(`${expect.list} lacks ${want}; ${shown}`);
      }
      rest.splice(at, 1);
    }
    if (rest.length > 0) {
      return fail(`${expect.list} holds more than [${expect.exactly.join(", ")}]: ${shown}`);
    }
  }
  if (expect.max !== undefined && tokens.length > expect.max) {
    return fail(`${expect.list} holds ${tokens.length} entries, over ${expect.max}`);
  }
  if (expect.last !== undefined) {
    const finalEntry = list[list.length - 1];
    const code = finalEntry !== null && typeof finalEntry === "object" ? (finalEntry as Record<string, unknown>)["code"] : undefined;
    if (code !== expect.last) {
      return fail(`the last ${expect.list} entry is ${JSON.stringify(code)}, wanted ${expect.last}`);
    }
  }
  return pass(shown);
}

function matchesToken(entry: { code: string; token: string }, want: string): boolean {
  return want.includes("@") ? entry.token === want : entry.code === want;
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, Json>)[key] as Json)]));
  }
  return value;
}

/** A short English reading of an expectation, for the report's Expected column. */
export function describe(expect: Expectation, customs: Record<string, CustomPredicate> = {}): string {
  switch (expect.op) {
    case "accepted":
      return expect.value ? "accepted" : "rejected";
    case "codes": {
      const parts: string[] = [];
      if (expect.exactly !== undefined) {
        parts.push(`errors exactly [${expect.exactly.join(", ")}]`);
      }
      if (expect.includes !== undefined) {
        parts.push(`errors include [${expect.includes.join(", ")}]`);
      }
      if (expect.excludes !== undefined) {
        parts.push(`errors exclude [${expect.excludes.join(", ")}]`);
      }
      return parts.join("; ");
    }
    case "valuesExcludeText":
      return `values hold none of ${expect.text.map((text) => JSON.stringify(text)).join(", ")}`;
    case "textExcludes":
      return `output holds none of ${expect.markers.map((text) => JSON.stringify(text)).join(", ")}`;
    case "textIncludes":
      return `output holds ${expect.markers.map((text) => JSON.stringify(text)).join(", ")}`;
    case "rawAt":
      return expect.absent === true
        ? `outcome.${expect.path} absent`
        : expect.equals !== undefined
          ? `outcome.${expect.path} = ${JSON.stringify(expect.equals)}`
          : expect.contains !== undefined
            ? `outcome.${expect.path} contains ${JSON.stringify(expect.contains)}`
            : `outcome.${expect.path} present`;
    case "goldenCase":
      return "the outcome bytes (length, SHA-256) equal the golden case";
    case "logsSome":
      return `a log message matches /${expect.pattern}/`;
    case "logsMaxMessage":
      return `log messages at most ${expect.max} characters`;
    case "refusal":
      return `refusal ${expect.anyOf.join(" or ")}${expect.codes !== undefined ? ` coded ${expect.codes.join(" or ")}` : ""}${expect.includesCodes !== undefined ? ` listing ${expect.includesCodes.join(", ")}` : ""}`;
    case "answerProblems": {
      const parts: string[] = [];
      if (expect.exactly !== undefined) {
        parts.push(`exactly [${expect.exactly.join(", ")}]`);
      }
      if (expect.includes !== undefined) {
        parts.push(`includes [${expect.includes.join(", ")}]`);
      }
      if (expect.excludes !== undefined) {
        parts.push(`excludes [${expect.excludes.join(", ")}]`);
      }
      if (expect.max !== undefined) {
        parts.push(`at most ${expect.max} entries`);
      }
      if (expect.last !== undefined) {
        parts.push(`ends with ${expect.last}`);
      }
      return `${expect.list} ${parts.join("; ")}`;
    }
    case "answerSize":
      return `answer at most ${expect.maxBytes} bytes`;
    case "digestEquals":
      return `digest equals golden ${expect.golden}`;
    case "canonicalEquals":
      return `canonical text equals golden ${expect.golden}`;
    case "golden":
      return `matches pinned control ${expect.key}`;
    case "answerPath":
      return `${expect.path} = ${JSON.stringify(expect.equals)}`;
    case "elapsedMax":
      return `ends within ${expect.ms} ms`;
    case "all":
      return expect.of.map((part) => describe(part, customs)).join("; ");
    case "any":
      return expect.of.map((part) => describe(part, customs)).join(" or ");
    case "not":
      return `not (${describe(expect.of, customs)})`;
    case "custom":
      return customs[expect.name]?.describe() ?? `custom ${expect.name}`;
  }
}
