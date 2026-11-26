import { describe, expect, it } from "vitest";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { PDF_ABI_VERSION, buildPdfRenderRequest } from "@argusvane/datum-engine/render";
import { kernelStableStringify } from "@argusvane/datum-engine";
import { handlePdfRequest } from "../src/program/entry.js";
import { ENV, document, fonts, paragraph } from "./helpers.js";
import { SUBMISSION, archivalDocument } from "./pdfa-fixtures.js";
import { hostSign, hostVerify, identity } from "./signing-fixtures.js";

const PROGRAM_PATH = join(process.cwd(), "dist", "datum-pdf.program.js");

/**
 * A bare context: no Node globals, no DOM, no timers, no clock, no randomness — the
 * sandbox's conditions, in Node's own VM. What the program needs it must bring itself.
 */
function bareContext(): vm.Context {
  const scope: Record<string, unknown> = {
    console,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Promise,
    Math: Object.assign(Object.create(Math), {
      random: () => {
        throw new Error("Math.random is disabled");
      }
    }),
    Date: function ThrowingDate() {
      throw new Error("Date is disabled");
    }
  };
  return vm.createContext(scope);
}

describe("the bundled program", () => {
  it("exists, is one file with no loader references, and stays within its budget", () => {
    expect(existsSync(PROGRAM_PATH)).toBe(true);
    const text = readFileSync(PROGRAM_PATH, "utf8");
    // The ceiling covers the formula parser, compiler and function library, the attachment-size, template and output-safety guards (same budget as scripts/build-program.mjs).
    expect(text.length).toBeLessThan(1_336_000);
    expect(text).toContain("__datum_pdf");
    expect(/\bimport\s*\(/.test(text)).toBe(false);
  });

  it("runs on a QuickJS older than the typed-array write it would otherwise make", () => {
    // The three base64 decoders (pdf-lib, its standard fonts, fontkit) overrun their buffer by
    // the padding; a QuickJS before 2023 throws on that in strict code, so the build guards
    // them and records how many it found. The program reaches for no API such an engine lacks.
    const meta = JSON.parse(readFileSync(join(process.cwd(), "dist", "datum-pdf.program.meta.json"), "utf8")) as {
      portability: { base64DecodersGuarded: number };
    };
    expect(meta.portability.base64DecodersGuarded).toBe(3);
    const text = readFileSync(PROGRAM_PATH, "utf8");
    expect(text).not.toMatch(/new Uint8Array\(bufferLength\)/);
    for (const api of ["Object.hasOwn(", ".findLast(", ".findLastIndex(", "Array.prototype.at", "WeakRef", "FinalizationRegistry"]) {
      expect(text).not.toContain(api);
    }
  });

  it("evaluates in a bare context and answers capabilities", async () => {
    const context = bareContext();
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    expect(typeof call).toBe("function");
    expect(vm.runInContext("globalThis.__datum_pdf_abi", context)).toBe(PDF_ABI_VERSION);
    const response = JSON.parse(await call(JSON.stringify({ abi: PDF_ABI_VERSION, op: "capabilities" })));
    expect(response).toMatchObject({ ok: true, op: "capabilities", abi: PDF_ABI_VERSION });
    // How a host tells a program that chooses layouts by their `when` from one that ignores it.
    expect(response.features).toEqual(expect.arrayContaining(["data-keys", "layout-conditions", "field-tooltips"]));
    // How a host tells a program that reads formula strings, the if node and the function library from one that reads a string rule as absent.
    expect(response.features).toEqual(expect.arrayContaining(["conditional-expressions", "formulas", "formula-functions"]));
    // How a host tells a program that reads an encrypted template (empty user password) from one that fails on it.
    expect(response.features).toEqual(expect.arrayContaining(["template-decryption"]));
    // How a host tells a program that translates answers by a mapping's value map from one that writes them as they are.
    expect(response.features).toEqual(expect.arrayContaining(["mapping-values"]));
    expect(response.features).toContain("default-font-fallback");
    expect(response.abi).toBe("4.0.0");
  });

  it("reads a rule written as a formula over today in a bare context, as the in-process modules do", async () => {
    const context = bareContext();
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    const form = {
      id: "f",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "early", type: "text", configuration: { label: "Early bird" }, rules: { visibleWhen: 'today() < "2030-01-01"' } }
        ]
      }
    };
    const request = (today?: string) => ({ abi: PDF_ABI_VERSION, op: "build", form, values: { name: "Ada", early: "yes" }, locale: "en", ...(today !== undefined ? { today } : {}) });
    // With the day, the rule holds and the field prints; without one the clock reads as no answer and the field is hidden.
    const withDay = await call(kernelStableStringify(request("2026-10-07")));
    expect(JSON.parse(withDay)).toMatchObject({ ok: true, op: "build", layoutKind: "derived" });
    expect(withDay).toContain("Early bird");
    expect(withDay).toBe(kernelStableStringify(await handlePdfRequest(request("2026-10-07"))));
    const noDay = await call(kernelStableStringify(request()));
    expect(JSON.parse(noDay)).toMatchObject({ ok: true, op: "build" });
    expect(noDay).not.toContain("Early bird");
    expect(noDay).toContain("Name");
    // A formula the parser rejects: refused by default (fail, so a rule is never silently dropped),
    // dropped with a word under the warn opt-in; a word that is neither is no word.
    const broken = { ...request("2026-10-07"), form: { ...form, children: { content: [{ id: "x", type: "text", configuration: { label: "X" }, rules: { visibleWhen: "name = " } }] } } };
    expect(JSON.parse(await call(kernelStableStringify(broken)))).toMatchObject({ ok: false, error: { code: "formula_invalid" } });
    expect(JSON.parse(await call(kernelStableStringify({ ...broken, formulaErrors: "warn" })))).toMatchObject({ ok: true, warnings: [{ code: "formula.invalid", componentId: "x" }] });
    expect(JSON.parse(await call(kernelStableStringify({ ...broken, formulaErrors: "fail" })))).toMatchObject({ ok: false, error: { code: "formula_invalid" } });
    expect(JSON.parse(await call(kernelStableStringify({ ...broken, formulaErrors: "ignore" })))).toMatchObject({ ok: false, error: { code: "formula_invalid" } });
    // A literal matches pattern that repeats a repeat: refused like a formula that
    // does not parse, unless the request says riskyPatterns "allow" (no ABI bump). Same bytes in-process.
    const risky = { ...request("2026-10-07"), form: { ...form, children: { content: [{ id: "x", type: "text", configuration: { label: "X" }, rules: { visibleWhen: 'matches(name, "(a+)+$")' } }] } } };
    expect(JSON.parse(await call(kernelStableStringify(risky)))).toMatchObject({ ok: false, error: { code: "formula_invalid" } });
    expect(JSON.parse(await call(kernelStableStringify({ ...risky, formulaErrors: "warn" })))).toMatchObject({ ok: true, warnings: [{ code: "formula.invalid", componentId: "x" }] });
    const allowed = await call(kernelStableStringify({ ...risky, riskyPatterns: "allow", values: { name: "aaa" } }));
    expect(JSON.parse(allowed)).toMatchObject({ ok: true, op: "build" });
    expect(allowed).toBe(kernelStableStringify(await handlePdfRequest({ ...risky, riskyPatterns: "allow", values: { name: "aaa" } } as never)));
    expect(await handlePdfRequest(risky as never)).toMatchObject({ ok: false, error: { code: "formula_invalid" } });
  });

  it("lets a module register functions a layout's when may call, and refuses a built-in's name", async () => {
    const context = bareContext();
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const register = vm.runInContext("globalThis.__datum_pdf_register", context) as (module: unknown) => number;
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    expect(register({ functions: { isQuebec: (args: unknown[]) => args[0] === "QC" } })).toBe(1);
    expect(() => register({ functions: { sum: () => 0 } })).toThrow(/collides with a built-in/);
    expect(() => register({ functions: { isQuebec: () => true } })).toThrow(/another module/);
    expect(() => register({ functions: { "not-a-name": () => true } })).toThrow(/plain identifier/);
    const request = {
      abi: PDF_ABI_VERSION,
      op: "build",
      form: { id: "f", type: "form", configuration: {}, children: { content: [{ id: "province", type: "text", configuration: {} }] } },
      pdf: {
        layouts: [
          { id: "standard", kind: "generated", root: { id: "d1", type: "pdf-document", configuration: {}, children: { body: [] } } },
          { id: "quebec", kind: "generated", when: "isQuebec(province)", root: { id: "d2", type: "pdf-document", configuration: {}, children: { body: [] } } }
        ],
        defaultLayoutId: "standard"
      },
      values: { province: "QC" },
      locale: "en"
    };
    expect(JSON.parse(await call(kernelStableStringify(request)))).toMatchObject({ ok: true, op: "build", layoutId: "quebec", layoutChoice: "condition", warnings: [] });
    expect(JSON.parse(await call(kernelStableStringify({ ...request, values: { province: "ON" } })))).toMatchObject({ ok: true, layoutId: "standard", layoutChoice: "default" });
    // The in-process modules know no such function: the condition is a parse problem there, warned, and the default prints.
    // (The default, fail, would refuse; the warn opt-in reads the condition as a parse problem.)
    expect(await handlePdfRequest({ ...request, formulaErrors: "warn" } as never)).toMatchObject({ ok: true, layoutId: "standard", warnings: [{ code: "formula.invalid" }] });
    expect(await handlePdfRequest(request as never)).toMatchObject({ ok: false, error: { code: "formula_invalid" } });
  });

  it("chooses a layout by its condition in a bare context and names it on the document reply", async () => {
    const context = bareContext();
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    const request = {
      abi: PDF_ABI_VERSION,
      op: "document",
      form: { id: "f", type: "form", configuration: {}, children: { content: [{ id: "province", type: "text", configuration: {} }] } },
      pdf: {
        layouts: [
          { id: "standard", kind: "generated", root: { id: "d1", type: "pdf-document", configuration: {}, children: { body: [] } } },
          {
            id: "quebec",
            kind: "generated",
            when: { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } },
            root: { id: "d2", type: "pdf-document", configuration: {}, children: { body: [] } }
          }
        ],
        defaultLayoutId: "standard"
      },
      values: { province: "QC" },
      locale: "en",
      fonts: [],
      env: ENV
    };
    const fromProgram = await call(kernelStableStringify(request));
    expect(JSON.parse(fromProgram)).toMatchObject({ ok: true, op: "document", layoutId: "quebec", layoutKind: "generated", layoutChoice: "condition" });
    expect(fromProgram).toBe(kernelStableStringify(await handlePdfRequest(request)));
  });

  it("produces the same bytes as the in-process modules for the same request", async () => {
    const context = bareContext();
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    const request = buildPdfRenderRequest(
      document([
        { id: "h", kind: "heading", level: 2, runs: [{ text: "Parity" }] },
        paragraph("p", "The same request yields the same bytes, wherever the program runs. مرحبا"),
        { id: "w", kind: "widget", label: "Name", field: { name: "name", kind: "text", value: "Ada" } }
      ]),
      await fonts(),
      ENV
    );
    const fromProgram = await call(kernelStableStringify(request));
    const fromModules = kernelStableStringify(await handlePdfRequest(request));
    expect(fromProgram.length).toBeGreaterThan(1000);
    expect(fromProgram).toBe(fromModules);
  });

  it("makes a PDF/A-3 document with an attachment where Date throws", async () => {
    // The conformance pass writes dates into XMP and the embedded file; every one of them
    // must come from `env`, and this context has no `Date` to fall back on.
    const context = bareContext();
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    // No image: PNG decoding reads `Date.now`, which this context lacks altogether (the real
    // sandbox stubs it) — a limit of the fixture, not of the conformance pass under test.
    const doc = archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] } });
    const request = buildPdfRenderRequest({ ...doc, blocks: doc.blocks.filter((block) => block.kind !== "image"), resources: { images: {} } }, await fonts(), ENV);
    const response = JSON.parse(await call(kernelStableStringify(request))) as { ok: boolean; pdfa?: string; warnings?: unknown[]; error?: unknown };
    expect(response.error).toBeUndefined();
    expect(response).toMatchObject({ ok: true, pdfa: "3b", warnings: [] });
    expect(await call(kernelStableStringify(request))).toBe(kernelStableStringify(await handlePdfRequest(request)));
    const features = (JSON.parse(await call(JSON.stringify({ abi: PDF_ABI_VERSION, op: "capabilities" }))) as { features: string[] }).features;
    expect(features).toContain("pdfa");
    expect(features).toContain("attachments");
  });

  it("signs, completes and verifies where Date throws, byte for byte as in-process", async () => {
    const context = bareContext();
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    const who = identity("rsa2048");
    const request = buildPdfRenderRequest(document([paragraph("p", "Sealed in a bare context.")]), await fonts(), ENV);
    const signed = { ...request, signature: { certificates: who.certificates, certify: "noChanges" as const, reason: "Bare" } };
    const fromProgram = await call(kernelStableStringify(signed));
    expect(fromProgram).toBe(kernelStableStringify(await handlePdfRequest(signed)));
    const prepared = JSON.parse(fromProgram) as { ok: boolean; bytes: string; signing: { toBeSigned: string; toBeSignedDigest: string } };
    expect(prepared.ok).toBe(true);
    const value = hostSign(who, prepared.signing.toBeSigned);
    const completion = { abi: PDF_ABI_VERSION, op: "complete" as const, pdf: { data: prepared.bytes }, signing: { certificates: who.certificates, certify: "noChanges" as const, reason: "Bare", value, toBeSignedDigest: prepared.signing.toBeSignedDigest } };
    const completedText = await call(kernelStableStringify(completion));
    expect(completedText).toBe(kernelStableStringify(await handlePdfRequest(completion)));
    const completed = JSON.parse(completedText) as { ok: boolean; bytes: string };
    expect(completed.ok).toBe(true);
    const verified = JSON.parse(await call(kernelStableStringify({ abi: PDF_ABI_VERSION, op: "verify", pdf: { data: completed.bytes } }))) as { ok: boolean; signatures: Array<{ digestMatches: boolean; certification: unknown }> };
    expect(verified.signatures[0]).toMatchObject({ digestMatches: true, certification: { permissions: "noChanges" } });
    expect(hostVerify(verified.signatures[0] as never)).toBe(true);
    const features = (JSON.parse(await call(JSON.stringify({ abi: PDF_ABI_VERSION, op: "capabilities" }))) as { features: string[] }).features;
    expect(features).toContain("signature");
  });
});
