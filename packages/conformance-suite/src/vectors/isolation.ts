import { CONTROL_VALUES } from "../fixtures/controls.js";
import type { Json } from "../observation.js";
import type { Expectation } from "../predicates.js";
import { accepted, all, any, TESTS, vector } from "./helpers.js";
import type { DefinitionBuilder, PluginSource, Variant, Vector, VectorInput } from "./schema.js";

/**
 * ISO: isolation and the fail-closed gate. Each probe is a plugin module (the plugin author's
 * code runs inside the sandbox) whose validator reports what it found as the `code` of an
 * `info` error, so the finding rides the ordinary outcome and needs no special channel.
 */
const probeModule = (id: string, validators: string[], extra = ""): PluginSource => ({
  id,
  version: "1.0.0",
  source: `({ validators: [ ${validators.join(", ")} ]${extra} })`
});

const validator = (body: string): string => `function (context) { ${body} }`;

/** A validator body that returns one info error whose code is `prefix` + the findings the expression lists. */
const reporting = (prefix: string, expression: string): string =>
  validator(`var found = ${expression}; return { errors: [ { code: ${JSON.stringify(prefix)} + found.join(","), stage: "probe", source: "custom", severity: "info" } ] };`);

const found = (prefix: string, findings: string[]): Expectation => ({ op: "codes", includes: [`${prefix}${findings.join(",")}`] });

const validRun = (): VectorInput => ({ kind: "values", values: CONTROL_VALUES["CTL-01"]() });
const provenance = (...tests: { path: string; name?: string }[]) => ({ tests });

const SYMBOLS_1 = ["fetch", "XMLHttpRequest", "WebSocket", "require", "process", "window", "document", "setTimeout", "queueMicrotask"];
const SYMBOLS_2 = ["std", "os", "print", "console", "scriptArgs", "performance", "bjson"];

const typeofList = (names: string[]): string => `[${names.map((name) => `typeof ${name}`).join(", ")}]`;

/** Registration failures: the sandbox must refuse to start, with a typed error. */
const refusesToStart: Expectation = { op: "refusal", anyOf: ["other"], codes: ["not_a_module", "compile_error"] };

const startup = (id: string, plugins: PluginSource[]): Variant => ({ id, fixture: { plugins }, input: validRun(), expect: refusesToStart });

/** A rule that reads the clock, on the fixture form: required once today() is after 2020-01-01. */
const withClockRule: DefinitionBuilder = (root) => {
  const children = root["children"] as { content: Record<string, unknown>[] };
  children.content.push({
    id: "late",
    type: "text",
    configuration: {},
    rules: { requiredWhen: { run: "server", formula: 'dateDiff("2020-01-01", today(), "days") > 0' } }
  });
  return root;
};

/** A run whose validator returns `expression`: the run must throw, never accept. */
const unusable = (id: string, expression: string): Variant => ({
  id,
  fixture: { plugins: [probeModule(`return-${id}`, [validator(`return ${expression};`)])] },
  input: validRun(),
  expect: { op: "refusal", anyOf: ["other"], codes: ["runtime_error"] }
});

const unusableEntries: Variant[] = [
  unusable("undefined", "undefined"),
  unusable("null", "null"),
  unusable("number", "1"),
  unusable("text", '"x"'),
  unusable("promise", "Promise.resolve({ errors: [] })"),
  unusable("thenable", "{ then: function () {} }"),
  unusable("empty-object", "{}"),
  unusable("errors-not-a-list", "{ errors: {} }"),
  unusable("null-entry", "{ errors: [null] }"),
  unusable("non-string-code", "{ errors: [{ code: 1 }] }"),
  unusable("sparse-list", "{ errors: new Array(2) }")
];

const gettersModule = (id: string, body: string): PluginSource => probeModule(id, [validator(body)]);

export const ISOLATION_VECTORS: Vector[] = [
  vector({
    id: "ISO-01",
    title: "A plugin sees no network, DOM, process, module loader or timers",
    class: "isolation",
    severity: "S2",
    attacker: "plugin-author",
    provenance: provenance({ path: TESTS.isolation, name: "has no host capabilities" }),
    fixture: { definition: "base", plugins: [probeModule("iso-01", [reportingTypeof("iso01:", SYMBOLS_1)])] },
    input: validRun(),
    expect: found("iso01:", SYMBOLS_1.map(() => "undefined"))
  }),
  vector({
    id: "ISO-02",
    title: "A plugin sees no QuickJS std/os, print, console, scriptArgs, performance or bjson, and dynamic import() gives it no module",
    class: "isolation",
    severity: "S3",
    attacker: "plugin-author",
    provenance: { tests: [] },
    hostSensitive: true,
    fixture: {
      definition: "base",
      plugins: [
        probeModule("iso-02", [
          validator(
            `var found = ${typeofList(SYMBOLS_2)}; var imported; try { var loaded = import("datum-probe-module"); imported = "promise"; if (loaded && typeof loaded.catch === "function") { loaded.catch(function () {}); } } catch (error) { imported = "throws"; } found.push(imported); return { errors: [ { code: "iso02:" + found.join(","), stage: "probe", source: "custom", severity: "info" } ] };`
          )
        ])
      ]
    },
    input: validRun(),
    expect: any(found("iso02:", [...SYMBOLS_2.map(() => "undefined"), "throws"]), found("iso02:", [...SYMBOLS_2.map(() => "undefined"), "promise"]))
  }),
  vector({
    id: "ISO-03",
    title: "The wall clock and randomness are unreachable: Math.random, Date.now and new Date throw, and today() without a day is left unevaluated",
    class: "isolation",
    severity: "S3",
    attacker: "plugin-author",
    provenance: provenance({ path: TESTS.isolation, name: "disables nondeterministic APIs" }),
    fixture: {
      definition: "base",
      plugins: [
        probeModule("iso-03", [
          validator(
            `var found = []; try { Math.random(); found.push("ok"); } catch (e) { found.push("throws"); } try { Date.now(); found.push("ok"); } catch (e) { found.push("throws"); } try { new Date(); found.push("ok"); } catch (e) { found.push("throws"); } return { errors: [ { code: "iso03:" + found.join(","), stage: "probe", source: "custom", severity: "info" } ] };`
          )
        ])
      ]
    },
    input: validRun(),
    expect: found("iso03:", ["throws", "throws", "throws"]),
    variants: [
      {
        id: "today-without-a-day",
        fixture: { definition: "base+patch", patch: withClockRule },
        input: validRun(),
        expect: all(accepted(true), { op: "codes", excludes: ["required@late"] })
      },
      {
        id: "today-with-a-day-reads-the-given-day",
        fixture: { definition: "base+patch", patch: withClockRule },
        input: { kind: "values", values: CONTROL_VALUES["CTL-01"](), today: "2026-01-01" },
        expect: { op: "codes", includes: ["required@late"] }
      }
    ]
  }),
  vector({
    id: "ISO-04",
    title: "A validator that rebinds kernel functions or patches Array.prototype.push/some or JSON.stringify in the shared sandbox does not change the next run, and a module that redefines a global with a descriptor, or gives the global object a prototype of its own, does not change what another module reads (the host freezes the intrinsics)",
    class: "isolation",
    severity: "S4",
    attacker: "plugin-author",
    provenance: {
      tests: [
        { path: TESTS.isolation, name: "a plugin cannot rebind the kernel or patch the language for the runs after it" },
        { path: "packages/quickjs-wasm-host/tests/host-freeze-global-descriptors.test.ts", name: "the freeze holds a global against a redefining descriptor" },
        { path: "packages/quickjs-wasm-host/tests/host-freeze-global-descriptors.test.ts", name: "the freeze keeps the global object's prototype" }
      ]
    },
    fixture: {
      definition: "base",
      plugins: [
        probeModule("iso-04", [
          validator(
            `if (context.values.name === "rebind") { try { kernelIsEmptyValue = function () { return false; }; } catch (e) {} try { JSON.stringify = function () { return "{}"; }; } catch (e) {} try { Array.prototype.some = function () { return false; }; } catch (e) {} try { Array.prototype.push = function () { return 0; }; } catch (e) {} } return { errors: [] };`
          )
        ])
      ]
    },
    input: {
      kind: "series",
      steps: [
        { kind: "values", values: { ...(CONTROL_VALUES["CTL-01"]() as Record<string, Json>), name: "rebind" } },
        { kind: "values", values: CONTROL_VALUES["CTL-02"]() }
      ]
    },
    expect: all(accepted(false), { op: "codes", exactly: ["required@name"] }),
    variants: [
      {
        // The first module redefines globals as it loads, by every descriptor route; the second reads them.
        id: "global-redefined-by-a-descriptor",
        fixture: {
          plugins: [
            {
              id: "iso-04-redefine",
              version: "1.0.0",
              source: `(function () {
                var fake = function () { return { test: function () { return true; } }; };
                try { Object.defineProperty(globalThis, "RegExp", { value: fake }); } catch (e) {}
                try { Object.defineProperties(globalThis, { RegExp: { value: fake } }); } catch (e) {}
                try { Reflect.defineProperty(globalThis, "JSON", { value: {} }); } catch (e) {}
                try { Object.defineProperty(globalThis, "undefined", { value: 7 }); } catch (e) {}
                try { Object.defineProperty(new Proxy(globalThis, {}), "NaN", { value: 7 }); } catch (e) {}
                return { validators: [] };
              })()`
            },
            probeModule("iso-04-read", [
              reporting(
                "iso04:",
                `[new RegExp("^[0-9]+$").test("abc") ? "regexp-replaced" : "regexp", typeof JSON.parse === "function" ? "json" : "json-replaced", String(undefined) === "undefined" ? "undefined" : "undefined-replaced", String(NaN) === "NaN" ? "nan" : "nan-replaced"]`
              )
            ])
          ]
        },
        input: validRun(),
        expect: found("iso04:", ["regexp", "json", "undefined", "nan"])
      },
      {
        // The first module tries to give the global object a prototype of its own, by every route;
        // the second reads bare names that resolve through that prototype.
        id: "global-prototype-swapped",
        fixture: {
          plugins: [
            {
              id: "iso-04-swap",
              version: "1.0.0",
              source: `(function () {
                var fake = new Proxy({}, { has: function () { return true; }, get: function (t, k) { return k === Symbol.unscopables ? undefined : "fake"; } });
                try { Object.setPrototypeOf(globalThis, fake); } catch (e) {}
                try { Reflect.setPrototypeOf(globalThis, fake); } catch (e) {}
                try { globalThis.__proto__ = fake; } catch (e) {}
                try { Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").set.call(globalThis, fake); } catch (e) {}
                return { validators: [] };
              })()`
            },
            probeModule("iso-04-names", [
              reporting(
                "iso04:",
                `[hasOwnProperty === Object.prototype.hasOwnProperty ? "own" : "own-replaced", typeof nobodyDefinedThis === "undefined" ? "unset" : "unset-replaced"]`
              )
            ])
          ]
        },
        input: validRun(),
        expect: found("iso04:", ["own", "unset"])
      }
    ]
  }),
  vector({
    id: "ISO-05",
    title: "A plugin module that is not a module, or registers something that is not a function, stops the sandbox from starting",
    class: "isolation",
    severity: "S3",
    attacker: "plugin-author",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/quickjs-wasm-adapter.test.ts", name: "typed errors for broken plugin modules" }] },
    fixture: { definition: "base", plugins: [{ id: "iso-05", version: "1.0.0", source: "(42)" }] },
    input: validRun(),
    expect: refusesToStart,
    variants: [
      startup("functions-array", [{ id: "p", version: "1.0.0", source: "({ functions: [] })" }]),
      startup("function-not-a-function", [{ id: "p", version: "1.0.0", source: "({ functions: { twice: 1 } })" }]),
      startup("built-in-name", [{ id: "p", version: "1.0.0", source: "({ functions: { len: function () { return 1; } } })" }]),
      startup("duplicate-across-plugins", [
        { id: "p1", version: "1.0.0", source: "({ functions: { twice: function () { return 2; } } })" },
        { id: "p2", version: "1.0.0", source: "({ functions: { twice: function () { return 2; } } })" }
      ]),
      startup("validators-not-an-array", [{ id: "p", version: "1.0.0", source: "({ validators: {} })" }]),
      startup("good-validator-then-a-bad-one", [{ id: "p", version: "1.0.0", source: "({ validators: [ function () { return { errors: [] }; }, 5 ] })" }])
    ]
  }),
  vector({
    id: "ISO-06",
    title: "A validator that answers nothing usable makes the run throw and is never accepted; a severity typo blocks",
    class: "isolation",
    severity: "S3",
    attacker: "plugin-author",
    provenance: { tests: [{ path: TESTS.portableKernel }] },
    fixture: { definition: "base", plugins: [probeModule("return-first", [validator("return undefined;")])] },
    input: validRun(),
    expect: { op: "refusal", anyOf: ["other"], codes: ["runtime_error"] },
    variants: [
      ...unusableEntries.slice(1),
      {
        id: "severity-typo-blocks",
        fixture: { plugins: [probeModule("severity-typo", [validator('return { errors: [ { code: "typo", severity: "Info" } ] };')])] },
        input: validRun(),
        expect: all(accepted(false), { op: "codes", includes: ["typo"] })
      }
    ]
  }),
  vector({
    id: "ISO-07",
    title: "A validator whose errors list or error code changes between reads is judged on the first read",
    class: "isolation",
    severity: "S4",
    attacker: "plugin-author",
    provenance: { tests: [{ path: TESTS.quickjsKernel, name: "a validator whose errors list changes between reads is judged on its first read" }, { path: TESTS.kernelLimits }] },
    fixture: {
      definition: "base",
      plugins: [
        gettersModule(
          "iso-07-list",
          `var reads = 0; return { get errors() { reads += 1; return reads === 1 ? [ { code: "first-read" } ] : []; } };`
        )
      ]
    },
    input: validRun(),
    expect: all(accepted(false), { op: "codes", includes: ["first-read"] }),
    variants: [
      {
        id: "code-getter",
        fixture: {
          plugins: [
            gettersModule(
              "iso-07-code",
              `var reads = 0; return { errors: [ { get code() { reads += 1; return reads === 1 ? "first-code" : 5; } } ] };`
            )
          ]
        },
        input: validRun(),
        expect: any({ op: "refusal", anyOf: ["other"] }, { op: "codes", includes: ["first-code"] })
      }
    ]
  }),
  vector({
    id: "ISO-08",
    title: "A validator cannot read the delivered document, and what it mutates of its context does not reach the next run",
    class: "isolation",
    severity: "S3",
    attacker: "plugin-author",
    provenance: { tests: [] },
    fixture: {
      definition: "base",
      plugins: [
        probeModule("iso-08", [
          validator(
            `if (context.values.name !== "probe") { return { errors: [] }; } var seen = typeof context.document; try { context.values.name = "TAMPER"; } catch (e) {} try { context.form.children = null; } catch (e) {} try { context.form.configuration.formulaErrors = "warn"; } catch (e) {} try { context.locale = "xx"; } catch (e) {} return { errors: [ { code: "iso08:document-" + seen, stage: "probe", source: "custom", severity: "info" } ] };`
          )
        ])
      ]
    },
    input: {
      kind: "series",
      steps: [
        { kind: "values", values: { ...(CONTROL_VALUES["CTL-01"]() as Record<string, Json>), name: "probe" }, document: { delivered: "ZZDOCUMENTZZ" } },
        { kind: "values", values: CONTROL_VALUES["CTL-01"]() }
      ]
    },
    expect: all(accepted(true), { op: "golden", key: "CTL-01" }),
    variants: [
      {
        id: "document-is-hidden",
        input: { kind: "values", values: { ...(CONTROL_VALUES["CTL-01"]() as Record<string, Json>), name: "probe" }, document: { delivered: "ZZDOCUMENTZZ" } },
        expect: { op: "codes", includes: ["iso08:document-undefined"] }
      }
    ]
  })
];

function reportingTypeof(prefix: string, names: string[]): string {
  return reporting(prefix, typeofList(names));
}
