import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenarios } from "../form-engine/core/form-tests/form-test-run.js";
import type { DefinitionInspectResponse } from "../form-engine/core/expressions/inspect.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import {
  addressOf,
  listTranslations,
  resolveText,
  type FormTranslations,
  type TextAddress
} from "../form-engine/core/localization/translations.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { createFormTestKernelDriver } from "../form-engine/validation/wasm/form-test-kernel-driver.js";
import { InProcessWasmHostAdapter, createInProcessWasmValidationHost } from "../form-engine/validation/wasm/in-process-host.js";
import { kernelResolveText, runKernel } from "../form-engine/validation/wasm/portable-kernel.js";
import { JsonWasmAbi, WASM_ABI_VERSION, WasmValidationHost, stableStringify } from "../form-engine/validation/wasm/wasm-validation-host.js";

/**
 * The validation kernel's reading of a definition's translations: its own copy of
 * `resolveText` (catalog exact locale, map exact, catalog primary subtag, map primary subtag, the
 * default; the catalog is the run context's optional `catalog`),
 * which words a failed pattern's message in a run. The `test` op words a form's messages from the
 * map alone. Held to the original over the canonical fixture and over hostile maps and catalogs.
 */

const fixture = JSON.parse(readFileSync(new URL("./fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;
const translations = fixture.translations as FormTranslations;

const LOCALES = ["en", "fr-CA", "fr-ca", "FR_CA", "fr_CA", "fr", "es", "es-MX", "ES", "de", "", " fr-CA", "fr-"];

/** Every address the fixture translates, and a few it does not. */
const ADDRESSES: TextAddress[] = [
  ...listTranslations(translations).map((row) => row.address),
  addressOf.form("description"),
  addressOf.component("fullName", "placeholder"),
  addressOf.message("contact", "required"),
  addressOf.option("contact", "sms", "label"),
  addressOf.chrome("help", "text"),
  addressOf.message("fullName", "number.min")
];

/** The default each address resolves from: any string, the same on both sides. */
const DEFAULT = "the default";

describe("kernelResolveText mirrors resolveText over the map alone", () => {
  it("agrees on every address of the fixture, in every locale", () => {
    for (const address of ADDRESSES) {
      for (const locale of LOCALES) {
        expect(kernelResolveText(DEFAULT, address, locale, translations), `${JSON.stringify(address)} ${locale}`).toBe(
          resolveText(DEFAULT, address, locale, { translations })
        );
      }
    }
  });

  it("words the fixture's required message on fullName per locale, es falling back to the default", () => {
    const address = addressOf.message("fullName", "required");
    expect(kernelResolveText("Enter your full name.", address, "en", translations)).toBe("Enter your full name.");
    expect(kernelResolveText("Enter your full name.", address, "fr-CA", translations)).toBe("Entrez votre nom complet.");
    expect(kernelResolveText("Enter your full name.", address, "es", translations)).toBe("Enter your full name.");
  });

  it("resolves a message code with a dot in it as one segment", () => {
    const dotted = { fr: { components: { age: { messages: { "number.min": { text: "Au moins {min}", source: "x" }, number: { text: "Un nombre", source: "y" } } } } } };
    const address = addressOf.message("age", "number.min");
    expect(kernelResolveText("At least {min}", address, "fr-CA", dotted)).toBe("Au moins {min}");
    expect(kernelResolveText("At least {min}", address, "fr-CA", dotted)).toBe(resolveText("At least {min}", address, "fr-CA", { translations: dotted }));
    // Never split on the dot: `messages › number › min` is not the address.
    expect(kernelResolveText("x", { kind: "components", owner: "age", path: ["messages", "number", "min"] }, "fr", dotted)).toBe("x");
  });

  it("ignores an unsafe segment or a malformed map, and never throws", () => {
    const hostile = JSON.parse(`{
      "__proto__": { "components": { "a": { "label": { "text": "Proto locale", "source": "x" } } } },
      "constructor": { "components": { "a": { "label": { "text": "Constructor locale", "source": "x" } } } },
      "fr": {
        "components": {
          "__proto__": { "label": { "text": "Proto owner", "source": "x" } },
          "a": { "prototype": { "text": "Prototype segment", "source": "x" }, "label": { "text": 5, "source": "x" }, "hint": "bare" },
          "b": { "label": { "text": "B", "source": 1 } },
          "c": ["not", "a", "tree"],
          "d": { "label": { "text": "D", "source": "x" } }
        },
        "form": { "title": null }
      },
      "es": "not a locale",
      "de": [1, 2]
    }`) as FormTranslations;
    const addresses: TextAddress[] = [
      addressOf.component("a", "label"),
      addressOf.component("a", "prototype"),
      addressOf.component("a", "hint"),
      addressOf.component("__proto__", "label"),
      addressOf.component("constructor", "label"),
      addressOf.component("b", "label"),
      addressOf.component("c", "0"),
      addressOf.component("d", "label"),
      addressOf.form("title"),
      { kind: "components", owner: "d", path: [] },
      { kind: "nosuch" as never, owner: "d", path: ["label"] },
      { kind: "form", owner: "d", path: ["title"] }
    ];
    const locales = ["__proto__", "constructor", "prototype", "fr", "fr-CA", "es", "de", "toString"];
    for (const address of addresses) {
      for (const locale of locales) {
        expect(kernelResolveText(DEFAULT, address, locale, hostile), `${JSON.stringify(address)} ${locale}`).toBe(
          resolveText(DEFAULT, address, locale, { translations: hostile })
        );
      }
    }
    expect(kernelResolveText(DEFAULT, addressOf.component("d", "label"), "fr", hostile)).toBe("D");
    expect(kernelResolveText(DEFAULT, addressOf.component("a", "prototype"), "fr", hostile)).toBe(DEFAULT);
    expect(kernelResolveText(DEFAULT, addressOf.component("__proto__", "label"), "fr", hostile)).toBe(DEFAULT);
    expect(kernelResolveText(DEFAULT, addressOf.component("a", "label"), "__proto__", hostile)).toBe(DEFAULT);
    for (const map of [undefined, null, "fr", 3, [], [{ fr: {} }]]) {
      expect(kernelResolveText(DEFAULT, addressOf.component("d", "label"), "fr", map)).toBe(DEFAULT);
    }
    // A prototype the map does not own is never read: Object.prototype gains nothing here.
    expect(({} as Record<string, unknown>).components).toBeUndefined();
  });
});

describe("kernelResolveText mirrors resolveText with the host catalog", () => {
  const address = addressOf.component("a", "label");
  const entry = (text: string) => ({ text, source: "x" });
  const mapOf = (locale: string, text: string): FormTranslations => ({ [locale]: { components: { a: { label: entry(text) } } } }) as FormTranslations;
  const catalogOf = (locale: string, text: unknown) => ({ [locale]: { components: { a: { label: text } } } });
  const both = (locale: string, map: unknown, catalog: unknown) => {
    const got = kernelResolveText(DEFAULT, address, locale, map, catalog);
    expect(got, locale).toBe(resolveText(DEFAULT, address, locale, { translations: map as FormTranslations, catalog: catalog as never }));
    return got;
  };

  it("the catalog under the exact tag beats the map under the exact tag", () => {
    expect(both("fr-CA", mapOf("fr-CA", "map"), catalogOf("fr-CA", "catalog"))).toBe("catalog");
    expect(both("fr_ca", mapOf("fr-CA", "map"), catalogOf("FR-ca", "catalog"))).toBe("catalog");
  });

  it("the map under the exact tag beats the catalog under the primary subtag", () => {
    expect(both("fr-CA", mapOf("fr-CA", "map"), catalogOf("fr", "catalog"))).toBe("map");
  });

  it("the catalog's primary subtag beats the map's primary subtag, and either serves a region", () => {
    expect(both("fr-CA", mapOf("fr", "map"), catalogOf("fr", "catalog"))).toBe("catalog");
    expect(both("fr-CA", mapOf("fr", "map"), undefined)).toBe("map");
    expect(both("fr-CA", undefined, catalogOf("fr", "catalog"))).toBe("catalog");
    expect(both("fr", mapOf("fr-CA", "map"), catalogOf("fr-CA", "catalog"))).toBe(DEFAULT);
  });

  it("a blank or non-string catalog leaf falls through to the next rung", () => {
    expect(both("fr-CA", mapOf("fr-CA", "map"), catalogOf("fr-CA", ""))).toBe("map");
    expect(both("fr-CA", mapOf("fr-CA", "map"), catalogOf("fr-CA", 5))).toBe("map");
    expect(both("fr-CA", mapOf("fr-CA", "map"), catalogOf("fr-CA", entry("an entry is not a leaf")))).toBe("map");
    expect(both("fr-CA", undefined, catalogOf("fr-CA", ""))).toBe(DEFAULT);
  });

  it("agrees on every address of the fixture, in every locale, with a catalog built over the same addresses", () => {
    const catalog: Record<string, unknown> = {};
    for (const row of listTranslations(translations)) {
      const leaf = (locale: string) => {
        const keys = row.address.kind === "form" ? ["form", ...row.address.path] : [row.address.kind, row.address.owner as string, ...row.address.path];
        let cursor = (catalog[locale] ??= {}) as Record<string, unknown>;
        keys.forEach((key, index) => {
          cursor[key] = index === keys.length - 1 ? "catalog " + locale : (cursor[key] ?? {});
          cursor = cursor[key] as Record<string, unknown>;
        });
      };
      // The catalog speaks `fr` and `es-MX` for what the map says in `fr-CA`, so every rung is met.
      leaf("fr");
      leaf("es-MX");
    }
    for (const address of ADDRESSES) {
      for (const locale of LOCALES) {
        expect(kernelResolveText(DEFAULT, address, locale, translations, catalog), `${JSON.stringify(address)} ${locale}`).toBe(
          resolveText(DEFAULT, address, locale, { translations, catalog: catalog as never })
        );
      }
    }
  });

  it("a hostile catalog never throws and reads as the original does", () => {
    const hostile = JSON.parse(`{
      "__proto__": { "components": { "a": { "label": "Proto locale" } } },
      "constructor": { "components": { "a": { "label": "Constructor locale" } } },
      "fr": {
        "components": {
          "__proto__": { "label": "Proto owner" },
          "a": { "prototype": "Prototype segment", "label": 5 },
          "b": ["not", "a", "tree"],
          "d": { "label": "D" }
        },
        "form": { "title": null }
      },
      "es": "not a locale",
      "de": [1, 2]
    }`);
    const addresses: TextAddress[] = [
      addressOf.component("a", "label"),
      addressOf.component("a", "prototype"),
      addressOf.component("__proto__", "label"),
      addressOf.component("b", "0"),
      addressOf.component("d", "label"),
      addressOf.form("title")
    ];
    const map = mapOf("fr", "map");
    for (const address of addresses) {
      for (const locale of ["__proto__", "constructor", "prototype", "fr", "fr-CA", "es", "de", "toString"]) {
        for (const sources of [undefined, map]) {
          expect(kernelResolveText(DEFAULT, address, locale, sources, hostile), `${JSON.stringify(address)} ${locale}`).toBe(
            resolveText(DEFAULT, address, locale, { translations: sources, catalog: hostile })
          );
        }
      }
    }
    expect(kernelResolveText(DEFAULT, addressOf.component("d", "label"), "fr", undefined, hostile)).toBe("D");
    expect(kernelResolveText(DEFAULT, addressOf.component("a", "label"), "fr", map, hostile)).toBe("map");
    // A catalog that is not a record is skipped, the map still words it.
    for (const bad of [null, "fr", 3, [], [{ fr: {} }]]) {
      expect(kernelResolveText(DEFAULT, addressOf.component("a", "label"), "fr", map, bad)).toBe("map");
      expect(kernelResolveText(DEFAULT, addressOf.component("a", "label"), "fr", undefined, bad)).toBe(DEFAULT);
    }
    expect(({} as Record<string, unknown>).components).toBeUndefined();
  });
});

describe("a run words a failed pattern's message from the catalog it is handed", () => {
  const catalogFor = (locale: string) => ({ [locale]: { components: { newsletterEmail: { patternMessage: "Courriel, svp (catalogue)" } } } });
  const messageOf = (locale: string, catalog?: unknown) =>
    runKernel(
      { formId: fixture.id, form: fixture.root, values: { fullName: "Ada", newsletterEmail: "nope" }, locale, translations, ...(catalog !== undefined ? { catalog } : {}) },
      []
    ).errors.find((error) => error.code === "pattern")?.parameters?.message;

  it("from the catalog for fr-CA, over the map's own words", () => {
    expect(messageOf("fr-CA", catalogFor("fr-CA"))).toBe("Courriel, svp (catalogue)");
    // The catalog's primary subtag serves a region, but the map's exact tag beats it.
    expect(messageOf("fr-CA", catalogFor("fr"))).toBe("Entrez une adresse courriel.");
  });

  it("from the map where the catalog lacks the tag, and without a catalog", () => {
    expect(messageOf("fr-CA", catalogFor("es"))).toBe("Entrez une adresse courriel.");
    expect(messageOf("fr-CA")).toBe("Entrez une adresse courriel.");
    expect(messageOf("en", catalogFor("fr-CA"))).toBe("Enter an email address.");
  });

  it("ignores a catalog that is not a record", () => {
    for (const bad of [null, "fr-CA", 5, [catalogFor("fr-CA")]]) {
      expect(messageOf("fr-CA", bad)).toBe("Entrez une adresse courriel.");
    }
  });

  it("crosses the ABI inside the serialized context", () => {
    const catalog = catalogFor("fr-CA");
    const wire = new JsonWasmAbi().serializeContext({ formId: fixture.id, form: fixture.root, values: {}, locale: "fr-CA", translations, catalog }, WasmValidationHost.STRICT_POLICY);
    expect(JSON.parse(wire).catalog).toEqual(catalog);
  });
});

describe("a run words a failed pattern's own message from the map it is handed", () => {
  const run = (locale: string, withMap = true) =>
    runKernel({ formId: fixture.id, form: fixture.root, values: { fullName: "Ada", newsletterEmail: "nope" }, locale, ...(withMap ? { translations } : {}) }, []);

  it("in the run's locale, the default where the map has no words for it", () => {
    const messageIn = (locale: string, withMap = true) => run(locale, withMap).errors.find((error) => error.code === "pattern")?.parameters?.message;
    expect(messageIn("en")).toBe("Enter an email address.");
    expect(messageIn("fr-CA")).toBe("Entrez une adresse courriel.");
    expect(messageIn("fr_ca")).toBe("Entrez une adresse courriel.");
    expect(messageIn("es")).toBe("Enter an email address.");
    // `fr-CA` does not serve `fr`: only a primary subtag serves a region.
    expect(messageIn("fr")).toBe("Enter an email address.");
    expect(messageIn("fr-CA", false)).toBe("Enter an email address.");
  });

  it("does not change the verdict: the map only words", () => {
    expect(run("fr-CA").errors.map((error) => `${error.componentId}:${error.code}`)).toEqual(run("fr-CA", false).errors.map((error) => `${error.componentId}:${error.code}`));
  });

  it("crosses the ABI inside the serialized context", () => {
    const abi = new JsonWasmAbi();
    const wire = abi.serializeContext({ formId: fixture.id, form: fixture.root, values: {}, locale: "fr-CA", translations }, WasmValidationHost.STRICT_POLICY);
    expect(JSON.parse(wire).translations).toEqual(translations);
  });
});

describe("the test op and the kernel driver word the form's messages from the map", () => {
  const instance = new InProcessWasmHostAdapter().instantiate([], new JsonWasmAbi());
  const scenario = (locale: string, expected: string) =>
    `test "required in ${locale}"\n  given locale = "${locale}"\n  check\n  expect error on fullName: required\n  expect message on fullName = "${expected}"`;
  const cases: Array<[string, string]> = [
    ["en", "Enter your full name."],
    ["fr-CA", "Entrez votre nom complet."],
    ["es", "Enter your full name."]
  ];

  it("in the op, en, fr-CA and es (es falling back to the default)", () => {
    for (const [locale, expected] of cases) {
      const text = instance.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition: fixture, tests: scenario(locale, expected) })) as string;
      const answer = JSON.parse(text) as DefinitionInspectResponse;
      if (!answer.ok || answer.op !== "test") {
        throw new Error("not a test answer: " + text);
      }
      expect(answer.report.scenarios.map((entry) => [entry.name, entry.status, entry.reason]), locale).toEqual([[`required in ${locale}`, "passed", undefined]]);
    }
  });

  it("in the kernel driver, the same", async () => {
    const host = createInProcessWasmValidationHost();
    for (const [locale, expected] of cases) {
      const parsed = kernelParseFormTests(scenario(locale, expected), formulaFunctionSignatures());
      expect(parsed.problems).toEqual([]);
      const [result] = await runFormTestScenarios(parsed.scenarios, () => createFormTestKernelDriver(fixture, { host }));
      expect(result?.status, locale).toBe("passed");
    }
  });

  it("a wrong expectation fails in both, so the words are really read", async () => {
    const wrong = scenario("fr-CA", "Enter your full name.");
    const text = instance.inspect!(stableStringify({ abi: WASM_ABI_VERSION, op: "test", definition: fixture, tests: wrong })) as string;
    const answer = JSON.parse(text) as DefinitionInspectResponse;
    expect(answer.ok && answer.op === "test" ? answer.report.scenarios[0]?.status : undefined).toBe("failed");
    const parsed = kernelParseFormTests(wrong, formulaFunctionSignatures());
    const [result] = await runFormTestScenarios(parsed.scenarios, () => createFormTestKernelDriver(fixture, { host: createInProcessWasmValidationHost() }));
    expect(result?.status).toBe("failed");
  });
});
