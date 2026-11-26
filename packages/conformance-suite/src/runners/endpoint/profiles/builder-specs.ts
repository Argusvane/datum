import {
  BASE_DEFINITION_ID,
  DECOY_MARKER,
  SUITE_MARKER,
  hostileId,
  resolveDefinitionText,
  retargetDefinitionText,
  secretRulesMatrix
} from "../../../fixtures/definitions.js";
import type { Expectation } from "../../../predicates.js";
import { DEFINITION_VECTORS } from "../../../vectors/definition.js";
import type { Fixture, Gate, Vector } from "../../../vectors/schema.js";
import type { BuilderCtx, BuilderRow, BuilderSpec, SaveSpec } from "./builder-types.js";

/**
 * What each DEF and BLD vector sends through a host's definition-saving route and what it expects
 * back.
 *
 * A row is judged under its vector's gate unless it names its own. A 5xx is a failure whatever the
 * gate: the never-500 rule judges every response.
 */

const http = (status: number): Expectation => ({ op: "answerPath", path: "http", equals: status });
const saved: Expectation = { op: "any", of: [http(200), http(201)] };
const refusedAs = (...kinds: Extract<Expectation, { op: "refusal" }>["anyOf"]): Expectation => ({ op: "refusal", anyOf: kinds });
const refused: Expectation = { op: "refusal", anyOf: ["definition_refused"] };
const either = (...of: Expectation[]): Expectation => ({ op: "any", of });
const NEVER_5XX: Expectation = { op: "custom", name: "builder-never-5xx" };

const definitionBody = (text: string | (() => string)): ((ctx: BuilderCtx) => SaveSpec) => (ctx) => ({ body: retargetDefinitionText(typeof text === "function" ? text() : text, ctx.formId) });

/** The base fixture as a save body for this run. */
export function baseBody(ctx: Pick<BuilderCtx, "formId">): string {
  return retargetDefinitionText(resolveDefinitionText({}), ctx.formId);
}

function definitionTextOf(vector: Vector, variantId: string): string {
  const fixture: Fixture = variantId === "(base)" ? vector.fixture : { ...vector.fixture, ...vector.variants?.find((variant) => variant.id === variantId)?.fixture };
  return resolveDefinitionText(fixture);
}

const defVector = (id: string): Vector => DEFINITION_VECTORS.find((vector) => vector.id === id) as Vector;

interface DefRow {
  of: string;
  /** The row's id when it differs from `of` (a second expectation over the same definition). */
  as?: string;
  expect: Expectation;
  gate?: Gate;
  heavy?: boolean;
  chain?: boolean;
  note?: string;
}

function defRows(id: string, rows: DefRow[], extra: Partial<BuilderSpec> = {}): BuilderSpec {
  const vector = defVector(id);
  return {
    ...extra,
    rows: rows.map((row) => ({
      id: row.as ?? row.of,
      save: definitionBody(() => definitionTextOf(vector, row.of)),
      expect: row.expect,
      // Every builder row states its own gate: enforced unless the row names another.
      gate: row.gate ?? { status: "enforced" },
      ...(row.heavy === true ? { heavy: true } : {}),
      ...(row.chain === false ? { chain: false } : {}),
      ...(row.note !== undefined ? { skipNote: row.note } : {})
    }))
  };
}

const sizeOfBody = (spec: SaveSpec): number => (typeof spec.body === "string" ? Buffer.byteLength(spec.body) : spec.body.length);

/** A definition body of exactly `bytes` bytes: the base fixture with a metadata member padded to the size. */
export function paddedBody(formId: string, bytes: number): string {
  const base = retargetDefinitionText(resolveDefinitionText({}), formId);
  const head = base.slice(0, -1);
  const open = `,"metadata":{"pad":"`;
  const close = `"}}`;
  const fixed = Buffer.byteLength(head) + Buffer.byteLength(open) + Buffer.byteLength(close);
  return `${head}${open}${"x".repeat(Math.max(0, bytes - fixed))}${close}`;
}

const encoder = new TextEncoder();
const bytesOf = (text: string): Uint8Array => encoder.encode(text);

const infinityBody = (ctx: BuilderCtx): SaveSpec => ({ body: baseBody(ctx).replace('"securitySuiteFixture":"1"', '"securitySuiteFixture":"1","n":1e999,"m":-1e999') });

const duplicateKeyBody = (ctx: BuilderCtx): SaveSpec => ({ body: `{"id":${JSON.stringify(`${ctx.formId}_first`)},${baseBody(ctx).slice(1)}` });

const nestedBody = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;

/** The id a duplicate-key body means to store: the last member wins in every JSON reader the suite knows of. */
async function readBackIdIs(ctx: BuilderCtx, expected: string, outcome: { observation: { kind: string } }): Promise<string | undefined> {
  if (outcome.observation.kind !== "answer") {
    return undefined;
  }
  const stored = await ctx.host?.readBack(ctx, "page build after duplicate keys");
  const id = (stored?.definition as { id?: unknown } | undefined)?.id;
  return id === expected ? undefined : `the host accepted a body with two "id" members and stored the id ${JSON.stringify(id)}, not ${JSON.stringify(expected)}: its parser and the judge may read different documents`;
}

export const BUILDER_SPECS: Record<string, BuilderSpec> = {
  // ---- DEF vectors through the save route -----------------------------------------------------
  "DEF-01": { rows: [{ id: "(base)", scenario: "base-save", expect: saved }] },
  "DEF-02": defRows("DEF-02", [
    { of: "(base)", expect: either(refusedAs("bad_document"), refused), note: "a definition that is an array" },
    { of: "root-type-is-group", expect: refused }
  ]),
  "DEF-03": defRows("DEF-03", [{ of: "(base)", expect: refused }]),
  "DEF-04": defRows("DEF-04", [{ of: "(base)", expect: refused }]),
  "DEF-05": defRows("DEF-05", [{ of: "(base)", expect: refused }]),
  "DEF-06": defRows("DEF-06", [
    { of: "(base)", expect: refused },
    { of: "depth-32-is-read", expect: saved }
  ]),
  "DEF-07": defRows("DEF-07", [
    { of: "(base)", expect: refused, chain: false },
    // `toString` only warns, but `constructor` and `prototype` are reserved ids: the save is refused (a host may refuse
    // with its own code before the kernel; the program rows hold the kernel's `component.id.reserved`).
    { of: "prototype-names-as-ids-only-warn", expect: refused, chain: false },
    // A rule's scope words (`component`, `host`, `row`, `ancestor`) are no component ids.
    { of: "scope-words-as-ids-are-reserved", expect: refused, chain: false }
  ]),
  "DEF-08": defRows("DEF-08", [
    { of: "(base)", expect: refused },
    { of: "unknown-type-with-types-sent", expect: saved }
  ]),
  "DEF-09": { rows: [{ id: "(base)", scenario: "secrets-public", expect: { op: "all", of: [{ op: "textExcludes", markers: [SUITE_MARKER] }, { op: "textIncludes", markers: [DECOY_MARKER] }] } }] },
  "DEF-10": {
    rows: [
      {
        id: "with-a-duplicate-id",
        save: definitionBody(() => definitionTextOf(defVector("DEF-10"), "with-a-duplicate-id")),
        // Whatever the host answers about secret rules, the body names neither the marker nor the function the rule calls.
        expect: { op: "textExcludes", markers: [SUITE_MARKER, "secretfn"] },
        chain: false
      }
    ]
  },
  "DEF-11": defRows("DEF-11", [
    { of: "(base)", expect: saved },
    { of: "pages-not-a-list", expect: refused, chain: false }
  ]),
  "DEF-12": defRows("DEF-12", [
    { of: "(base)", expect: refused, gate: { status: "enforced" } },
    { of: "(base)", as: "refusal-names-the-code", expect: refused, gate: { status: "enforced" }, chain: false }
  ]),
  "DEF-13": defRows("DEF-13", [{ of: "(base)", expect: refused }], { heavy: true }),
  "DEF-14": {
    rows: [
      ...defRows("DEF-14", [
        { of: "(base)", expect: refused },
        { of: "version-65-characters", expect: refused }
      ]).rows
    ]
  },
  "DEF-16": defRows("DEF-16", [{ of: "(base)", expect: refused }]),

  // ---- BLD vectors ---------------------------------------------------------------------------
  "BLD-05": {
    heavy: true,
    rows: [
      {
        id: "one-byte-over-the-limit",
        save: (ctx) => ({ body: paddedBody(ctx.formId, ctx.config.definitionLimit + 1) }),
        expect: { op: "custom", name: "definition-limit" },
        chain: false
      }
    ]
  },
  "BLD-06": {
    rows: [
      { id: "empty-body", save: () => ({ body: "" }), expect: refusedAs("bad_document"), htmlOk: true },
      { id: "open-brace", save: () => ({ body: "{" }), expect: refusedAs("bad_document") },
      { id: "byte-order-mark", save: (ctx) => ({ body: `﻿${baseBody(ctx)}` }), expect: either(refusedAs("bad_document"), refused), chain: false },
      { id: "invalid-utf8", save: (ctx) => ({ body: new Uint8Array([...bytesOf(baseBody(ctx).slice(0, -1)), 0x2c, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }), expect: refusedAs("bad_document") },
      { id: "json-depth-257", save: () => ({ body: nestedBody(257) }), expect: either(refusedAs("bad_document"), refused) },
      { id: "numbers-past-the-float-range", save: infinityBody, expect: either(refusedAs("bad_document"), refused) },
      { id: "duplicate-id-members", save: duplicateKeyBody, expect: either(saved, refused), after: (ctx, outcome) => readBackIdIs(ctx, ctx.formId, outcome) },
      { id: "nul-in-an-id", save: definitionBody(() => hostileId("a\u0000b")), expect: NEVER_5XX }
    ]
  },
  "BLD-07": { rows: [{ id: "idempotent-and-stable", scenario: "twice", expect: { op: "all", of: [{ op: "answerPath", path: "sameHash", equals: true }, { op: "answerPath", path: "readBackMatchesResponse", equals: true }, { op: "answerPath", path: "unknownKeyKept", equals: true }] }, gate: { status: "enforced" } }] },
  "BLD-08": {
    rows: [
      { id: "anonymous-copy", scenario: "secrets-public", expect: { op: "all", of: [{ op: "textExcludes", markers: [SUITE_MARKER] }, { op: "textIncludes", markers: [DECOY_MARKER] }] } },
      // SEC-03 on the submissions service: the check answer names where and which code, never the rule's text.
      { id: "check-answer-names-where-and-code", scenario: "secrets-check", profiles: ["submissions"], expect: { op: "all", of: [{ op: "textExcludes", markers: [SUITE_MARKER] }, { op: "answerPath", path: "ok", equals: true }] }, skipNote: "this host has no check route" }
    ]
  }
};

/**
 * The existing vectors that gain a builder form, and the vectors whose rows are that form.
 * Selecting the existing vector (`--only REC-01`) in a builder run runs the target's rows, reported
 * under the target's id. REC-07 to REC-09, REC-14, CTL, ABI, ISO, FIL, CAN and PAR have none.
 */
export const BUILDER_FORM_OF: Readonly<Record<string, readonly string[]>> = {
  "REC-01": ["BLD-06"],
  "REC-02": ["BLD-06"],
  "REC-03": ["BLD-05"],
  "REC-04": ["BLD-06", "DEF-06"],
  "REC-11": ["DEF-07"],
  "REC-12": ["BLD-07"],
  "REC-13": ["BLD-04"],
  "RES-05": ["BLD-05"],
  "RES-06": ["BLD-06"],
  "RES-07": ["DEF-05", "DEF-06"],
  "OPT-11": ["DEF-04"],
  "CTX-05": ["DEF-12"],
  "SEC-02": ["BLD-08", "DEF-09"],
  "SEC-03": ["BLD-08"]
};

/** Whether the vector has rows on the builder profile (its own, or through {@link BUILDER_FORM_OF}). */
export function runsOnBuilder(vector: Vector): boolean {
  return BUILDER_SPECS[vector.id] !== undefined || (vector.class === "builder" && DERIVED_BUILDER_IDS.includes(vector.id)) || BUILDER_FORM_OF[vector.id] !== undefined || vector.id === "SEC-01" || vector.id === "SEC-05";
}

/** Rows judged over the whole run, with no request of their own. */
export const DERIVED_BUILDER_IDS: readonly string[] = ["BLD-04", "BLD-09", "BLD-10", "BLD-11", "SEC-01", "SEC-05"];

/** The secret matrix the BLD-08 / DEF-09 scenario saves. */
export const secretsDefinition = (): string => secretRulesMatrix(2);

/** The rows of a builder vector as `explain` lines. */
export function builderRowLines(vector: Vector, describe: (expect: Expectation) => string): string[] {
  const spec = BUILDER_SPECS[vector.id];
  if (spec === undefined) {
    const forms = BUILDER_FORM_OF[vector.id];
    if (forms !== undefined) {
      return [`  builder form of this vector: ${forms.join(", ")} (select ${vector.id} in a --builder run to run them)`];
    }
    return DERIVED_BUILDER_IDS.includes(vector.id) ? ["  builder: derived row, judged over the whole run"] : [];
  }
  const lines = spec.note !== undefined ? [`  builder note: ${spec.note}`] : [];
  for (const row of spec.rows) {
    const gate = row.gate?.status === "pending" ? ` [pending ${row.gate.blockedBy}]` : "";
    const heavy = row.heavy === true || spec.heavy === true ? " [heavy]" : "";
    lines.push(`  builder row ${row.id}${gate}${heavy}: ${describe(row.expect)}`);
  }
  return lines;
}

export { BASE_DEFINITION_ID, sizeOfBody };
