import { validValues } from "../../fixtures/base-form.js";
import { CONSTRUCTOR_MARKER, CONTROL_VALUES, POLLUTION_MARKER, STRAY_MARKER, TOSTRING_MARKER } from "../../fixtures/controls.js";
import type { Json } from "../../observation.js";
import type { Expectation } from "../../predicates.js";
import type { EndpointRow, EndpointSpec, RequestSpec } from "./rows.js";

/**
 * Which of the earlier (program-first) vectors an endpoint run also drives, and what each looks
 * like on the wire. A vector of the catalogue without an entry here, and without its own
 * `applies.endpoint`, is simply not run against an endpoint. The rows are self-contained: the
 * wire carries no sanitized values, no logs and no `path`, so the expectations are over the
 * `{field, code}` pairs and the status (the field is the component id: `pick`, not `addr.pick`).
 */
const accepted = (value: boolean): Expectation => ({ op: "accepted", value });
const all = (...of: Expectation[]): Expectation => ({ op: "all", of });
const any = (...of: Expectation[]): Expectation => ({ op: "any", of });
const exactly = (...tokens: string[]): Expectation => ({ op: "codes", exactly: tokens });
const includes = (...tokens: string[]): Expectation => ({ op: "codes", includes: tokens });
const without = (...markers: string[]): Expectation => ({ op: "textExcludes", markers });
const refusal = (...anyOf: Extract<Expectation, { op: "refusal" }>["anyOf"]): Expectation => ({ op: "refusal", anyOf });
const noFailure: Expectation = { op: "custom", name: "no-server-failure" };
/** A verdict of either kind, or the typed bad_document: "judged or refused, nothing else". */
const judgedOrRefused: Expectation = any(accepted(true), accepted(false), refusal("bad_document"));

const check = (parts: Omit<Extract<RequestSpec, { kind: "check" }>, "kind"> = {}): RequestSpec => ({ kind: "check", ...parts });
const submit = (parts: Omit<Extract<RequestSpec, { kind: "submit" }>, "kind"> = {}): RequestSpec => ({ kind: "submit", ...parts });
const valid = (): Record<string, Json> => validValues() as Record<string, Json>;
const row = (id: string, requests: RequestSpec[], expect: Expectation, rest: Partial<EndpointRow> = {}): EndpointRow => ({ id, requests, expect, ...rest });

/** A value nested `levels` deep: `{ k: { k: ... { k: 1 } } }`. Built by loop, never by recursion. */
export function nested(levels: number, key = "k"): Json {
  let value: Json = 1;
  for (let at = 0; at < levels; at += 1) {
    value = { [key]: value };
  }
  return value;
}

/** An object holding `entries` of the valid answers, plus whatever `more` adds (own keys; `__proto__` stays an own key). */
function withValues(more: Record<string, Json>): Json {
  const out: Record<string, Json> = { ...valid() };
  for (const key of Object.keys(more)) {
    Object.defineProperty(out, key, { value: more[key], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function hostile(text: string): Json {
  return JSON.parse(text) as Json;
}

const bodyOver = (extra: number) => (context: { bodyLimit: number }): string => {
  const head = `{"pad":"`;
  const tail = `"}`;
  return `${head}${"x".repeat(Math.max(0, context.bodyLimit + extra - head.length - tail.length))}${tail}`;
};

const PICK_CASES: [string, Json][] = [
  ["outside", "ZZ"],
  ["leading-space", " ok"],
  ["case", "OK"],
  ["trailing-space", "ok "],
  ["label-not-value", "Ok"],
  ["nul-suffix", "ok\u0000"]
];
const PICK_SHAPES: [string, Json][] = [
  ["object", { ok: true }],
  ["array", ["ok"]],
  ["number", 1],
  ["true", true],
  ["zero", 0]
];

/** The endpoint spec of each earlier vector, by id. */
export const EARLIER_ENDPOINT_SPECS: Record<string, EndpointSpec> = {
  "CTL-01": { rows: [row("(base)", [check({ values: CONTROL_VALUES["CTL-01"]() })], all(accepted(true), exactly()))] },
  "CTL-02": { rows: [row("(base)", [check({ values: CONTROL_VALUES["CTL-02"]() })], all(accepted(false), exactly("required@name")))] },
  "CTL-03": { rows: [row("(base)", [check({ values: CONTROL_VALUES["CTL-03"]() })], all(accepted(false), exactly("maxLength@name")))] },
  "CTL-04": { rows: [row("(base)", [check({ values: CONTROL_VALUES["CTL-04"]() })], all(accepted(false), exactly("pattern@code")))] },
  "CTL-05": {
    note: "The wire holds no sanitized values: the check is that stray keys are not an error and nothing is echoed back.",
    rows: [row("(base)", [check({ values: CONTROL_VALUES["CTL-05"]() })], all(accepted(true), without(STRAY_MARKER, CONSTRUCTOR_MARKER)))]
  },
  "CTL-06": {
    rows: [
      row("(base)", [check({ values: CONTROL_VALUES["CTL-06"]() })], all(accepted(true), without(POLLUTION_MARKER, TOSTRING_MARKER, "polluted"))),
      row("10k-unknown-keys", [check({ values: CONTROL_VALUES["CTL-06-bulk"]() })], accepted(true)),
      row("next-run-is-clean", [check({ values: CONTROL_VALUES["CTL-06"]() }), check({ values: CONTROL_VALUES["CTL-01"]() })], all(accepted(true), exactly()))
    ]
  },

  "RES-05": {
    rows: [row("over-the-limit", [{ kind: "raw", route: "validate", body: bodyOver(1) }], { op: "custom", name: "body-limit" })]
  },
  "RES-06": {
    rows: [
      row("100-levels", [check({ values: withValues({ deep: nested(100) }) })], any(refusal("bad_document"), accepted(true), accepted(false)))
    ]
  },
  "RES-08": {
    rows: [row("56-levels-legit", [check({ values: withValues({ deep: nested(56) }) })], all(accepted(true), exactly()))]
  },
  "RES-11": {
    rows: [row("risky-pattern", [check({ values: withValues({ risky: `${"a".repeat(40)}!` }) })], all(accepted(false), includes("pattern@risky")), { limitMs: 10_000 })]
  },
  "RES-12": {
    note: "The fixture has no composed-regex rule; the row sends the risky-pattern answer again and asks that the run ends within its bound without a failure.",
    rows: [row("risky-pattern-bound", [check({ values: withValues({ risky: `${"a".repeat(40)}!` }) })], noFailure, { limitMs: 10_000 })]
  },
  "RES-16": {
    heavy: true,
    rows: [row("20000-blank-rows", [check({ values: withValues({ rows: { $gen: "rows", n: 20_000, row: { sku: "" } } as unknown as Json }) })], all(accepted(false), includes("required@sku")), { limitMs: 10_000 })]
  },
  "RES-17": {
    heavy: true,
    rows: [row("70000-blank-rows", [check({ values: withValues({ rows: { $gen: "rows", n: 70_000, row: { sku: "" } } as unknown as Json }) })], noFailure, { limitMs: 20_000 })]
  },

  "OPT-01": {
    rows: [
      ...PICK_CASES.map(([id, value]) => row(id, [check({ values: withValues({ addr: { city: "Ottawa", pick: value } }) })], all(accepted(false), exactly("option.notAllowed@pick")))),
      row("in-options", [check({ values: withValues({ addr: { city: "Ottawa", pick: "fine" } }) })], all(accepted(true), exactly()))
    ]
  },
  "OPT-02": {
    rows: PICK_SHAPES.map(([id, value]) => row(id, [check({ values: withValues({ addr: { city: "Ottawa", pick: value } }) })], all(accepted(false), includes("option.notAllowed@pick"))))
  },
  "OPT-03": {
    rows: [
      row("ticked-non-option", [check({ values: withValues({ tags: { x: true, evil: true } }) })], all(accepted(false), includes("option.notAllowed@tags"))),
      row("non-boolean", [check({ values: withValues({ tags: { x: "yes" } }) })], all(accepted(false), includes("option.notAllowed@tags"))),
      row("constructor-key", [check({ values: withValues({ tags: hostile('{"x":true,"constructor":true}') }) })], all(accepted(false), includes("option.notAllowed@tags"))),
      row("proto-key", [check({ values: withValues({ tags: hostile('{"x":true,"__proto__":true}') }) })], noFailure),
      row("unticked-ignored", [check({ values: withValues({ tags: { x: true, evil: false } }) })], all(accepted(true), exactly()))
    ]
  },
  "OPT-06": {
    rows: [
      row("nested-object", [check({ values: withValues({ addr: { city: "Ottawa", pick: "evil" } }) })], all(accepted(false), includes("option.notAllowed@pick"))),
      row("flat-key", [check({ values: withValues({ addr: { city: "Ottawa" }, "addr.pick": "evil" }) })], all(accepted(false), includes("option.notAllowed@pick"))),
      row("valid-nested", [check({ values: withValues({ addr: { city: "Ottawa", pick: "ok" } }) })], all(accepted(true), exactly()))
    ]
  },
  "OPT-07": {
    note: "Not observable on the wire (a check returns no values): the row asks that an object 21 levels down is not an error and is not echoed.",
    rows: [row("21-levels-at-container", [check({ values: withValues({ addr: { city: "Ottawa", pick: "ok", evil: nested(21, "evil") } }) })], all(accepted(true), without('"evil"')))]
  },
  "OPT-08": {
    rows: [
      row("rows-posted-whole", [check({ values: withValues({ rows: [{ sku: "s1", n: 1 }] }) })], all(accepted(true), exactly())),
      row("9-levels-in-a-row", [check({ values: withValues({ rows: [{ sku: "s1", n: 1, evil: nested(9, "evil") }] }) })], any(accepted(true), refusal("bad_document")))
    ]
  },
  "OPT-09": {
    rows: ["rows[00].sku", "rows[01].sku", "rows[ 0].sku", "rows[0]..sku", "addr[0].pick"].map((key) => row(key, [check({ values: withValues({ [key]: "ZZ" }) })], noFailure))
  },

  "FIL-01": {
    rows: [
      row(
        "size-lie",
        [check({ values: withValues({ doc: { storage: "base64", name: "a.bin", type: "application/octet-stream", size: 10, data: Buffer.alloc(4096).toString("base64") } }) })],
        any(all(accepted(false), includes("file.sizeMismatch@doc")), refusal("bad_document"))
      )
    ]
  },
  "CTX-01": {
    rows: [
      ["number", 5],
      ["object", {}],
      ["array", ["en"]],
      ["long-text", "x".repeat(36)],
      ["null", null]
    ].map(([id, locale]) => row(id as string, [check({ locale: locale as Json })], judgedOrRefused))
  },

  "CAN-06": {
    note: "Writes: one record lands in the fixture form. The digest the server stores must be the independent reference's digest of the delivered document.",
    rows: [
      row(
        "floats",
        [
          submit({
            values: withValues({
              rows: [0.1, 1 / 3, 1e21, 1e-7, 123456789012345680000].map((n, at) => ({ sku: `s${at}`, n }))
            })
          })
        ],
        all(accepted(true), { op: "digestEquals", golden: "sent" }),
        { digestOfSent: true }
      )
    ]
  },
  "CAN-07": {
    rows: [
      row("lone-surrogate", [check({ values: withValues({ name: "\ud800" }) })], refusal("bad_document")),
      row("nul-key", [check({ values: withValues({ "\u0000key": 1 }) })], refusal("bad_document"))
    ]
  },

  "SEC-01": {
    rows: [
      row("trigger", [check({ values: withValues({ name: "ZZSECRETZZ" }) })], all(accepted(false), includes("required@secret"), without("ZZSECRETZZ", "server-secret"))),
      row("not-triggered", [check({ values: CONTROL_VALUES["CTL-01"]() })], all(accepted(true), without("ZZSECRETZZ", "server-secret")))
    ]
  },
  "SEC-02": {
    note: "The public copy of the definition (--public-definition-url; the submissions profile serves it at /api/forms/:key/definition) holds no server-secret rule.",
    rows: [row("public-definition", [{ kind: "get", what: "definition" }], all({ op: "answerPath", path: "status", equals: 200 }, without("server-secret", "ZZSECRETZZ")))]
  }
};
