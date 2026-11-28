/**
 * The conformance check itself: every PDF/A file the kernel makes goes through
 * veraPDF, the reference validator, at the level it declares. Runs when `verapdf` is on the
 * PATH or named by `VERAPDF` (`brew install verapdf`, or the installer at verapdf.org, which
 * puts it in `~/verapdf`); skipped otherwise, so the suite needs no Java. The structural
 * assertions live in `kernel-pdfa.test.ts`; this file asks the one question they cannot.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PDF_AREA_DRAW, PDF_BUILTIN_PROFILES, builtinProfileSource, type ComponentNode } from "@argusvane/datum-engine/core";
import { PDF_ABI_VERSION, base64ToBytes, bytesToBase64, deriveDefaultPdfLayout, type PdfDocumentRequest } from "@argusvane/datum-engine/render";
import { handlePdfRequest } from "../src/program/entry.js";
import { renderDocument } from "../src/kernel/render.js";
import { fillTemplate } from "../src/kernel/template.js";
import { ENV, PLAN_THEME, RED_PNG_BASE64, fonts, paragraph } from "./helpers.js";
import { FILL_OPTIONS, SUBMISSION, SYLLABICS, WIDGETS, archivalDocument, cffFont, cmykProfile, pdfLibTemplate, syllabicsDocument } from "./pdfa-fixtures.js";
import { completeSignature, prepareSignature } from "../src/kernel/signature/sign.js";
import { verifySignatures } from "../src/kernel/signature/verify.js";
import { hostSign, identity } from "./signing-fixtures.js";

/** The veraPDF CLI, when this machine has one. */
export function findVeraPdf(): string | undefined {
  const named = process.env.VERAPDF;
  if (named && existsSync(named)) {
    return named;
  }
  const candidates = [
    ...(process.env.PATH ?? "").split(":").map((dir) => join(dir, "verapdf")),
    join(homedir(), "verapdf", "verapdf"),
    "/usr/local/bin/verapdf",
    "/opt/homebrew/bin/verapdf",
    "/opt/verapdf/verapdf"
  ];
  return candidates.find((candidate) => candidate !== "verapdf" && existsSync(candidate));
}

export interface VeraPdfVerdict {
  compliant: boolean;
  /** The failed rules as `clause-test`, e.g. `6.2.11.4.2-1`. */
  failed: string[];
  flavour: string;
}

/** Validates a file at the level its metadata declares (`--flavour 0`), or the one given. */
export function validateWithVeraPdf(cli: string, file: string, flavour = "0"): VeraPdfVerdict {
  let xml: string;
  try {
    xml = execFileSync(cli, ["--flavour", flavour, "--format", "xml", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // veraPDF exits non-zero for a non-compliant file; the report is still on stdout.
    xml = String((error as { stdout?: string }).stdout ?? "");
  }
  const compliant = /isCompliant="true"/.test(xml);
  const failed = [...xml.matchAll(/<rule specification="[^"]+" clause="([^"]+)" testNumber="(\d+)" status="failed"/g)].map((match) => `${match[1]}-${match[2]}`);
  const flavourMatch = /flavour="([^"]+)"/.exec(xml) ?? /profileName="([^"]+)"/.exec(xml);
  return { compliant, failed: [...new Set(failed)], flavour: flavourMatch?.[1] ?? flavour };
}

const cli = findVeraPdf();

describe.skipIf(!cli)("veraPDF conformance", () => {
  const dir = mkdtempSync(join(tmpdir(), "datum-pdfa-"));

  async function check(name: string, bytes: Uint8Array, flavour?: string): Promise<void> {
    const file = join(dir, `${name}.pdf`);
    writeFileSync(file, bytes);
    const verdict = validateWithVeraPdf(cli!, file, flavour);
    expect(verdict.failed, `${name}: veraPDF failed rules ${verdict.failed.join(", ")} (${file})`).toEqual([]);
    expect(verdict.compliant, `${name}: not compliant (${file})`).toBe(true);
  }

  it("accepts a generated document at every level the kernel offers", async () => {
    for (const level of ["2b", "2u", "2a", "3b", "3u", "3a"] as const) {
      const rendered = await renderDocument(archivalDocument({ conformance: { pdfa: level } }), await fonts(), ENV);
      await check(`generated-${level}`, rendered.bytes, level);
    }
    const untagged = await renderDocument(archivalDocument({ accessibility: { tagged: false, displayDocTitle: true } }), await fonts(), ENV);
    await check("generated-2b-untagged", untagged.bytes, "2b");
    const compact = await renderDocument(archivalDocument(), await fonts(), ENV, { compact: true });
    await check("generated-2b-compact", compact.bytes, "2b");
    // Level "a" of a layout that turned tagging off: tagged anyway, and conformant.
    const taggedAnyway = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" }, accessibility: { tagged: false, displayDocTitle: true } }), await fonts(), ENV);
    await check("generated-2a-forced-tags", taggedAnyway.bytes, "2a");
  }, 180_000);

  it("accepts level \"a\" through a fill: areas drawn and fields made join the template's tree; a flattened one is honest at \"u\"", async () => {
    const own = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" }, blocks: [paragraph("p", "Fill me."), ...WIDGETS] }), await fonts(), ENV);
    await check("template-own-2a", own.bytes, "2a");
    const areas = [
      { id: "a1", page: 1, rect: { x: 40, y: 600, width: 200, height: 20 }, value: "Drawn answer", draw: { ...DEFAULT_PDF_AREA_DRAW, color: "#112233" } },
      { id: "a2", page: 1, rect: { x: 40, y: 630, width: 20, height: 20 }, value: true, draw: { ...DEFAULT_PDF_AREA_DRAW, kind: "check" as const } },
      { id: "a3", page: 1, rect: { x: 40, y: 660, width: 200, height: 20 }, value: "Field answer", draw: { ...DEFAULT_PDF_AREA_DRAW, bold: true }, field: { name: "area3", required: false, readOnly: false } }
    ];
    const filled = await fillTemplate(own.bytes, { first: "Grace", agree: true, colour: "r" }, FILL_OPTIONS, await fonts(), ENV, areas, { pdfa: "3a", attachments: [SUBMISSION] }, undefined, PLAN_THEME);
    expect(filled.pdfa).toBe("3a");
    await check("filled-own-3a-areas", filled.bytes, "3a");
    const flat = await fillTemplate(own.bytes, { first: "Grace" }, { ...FILL_OPTIONS, flatten: true }, await fonts(), ENV, areas.slice(0, 1), { pdfa: "2a" }, undefined, PLAN_THEME);
    expect(flat.pdfa).toBe("2u");
    await check("filled-own-2a-flat-as-2u", flat.bytes, "2u");
  }, 180_000);

  it("accepts CFF/OpenType faces: a syllabics document, and a fill whose appearances use the face", async () => {
    const both = [...(await fonts()), cffFont()];
    for (const level of ["2b", "2u", "2a"] as const) {
      const rendered = await renderDocument(syllabicsDocument({ conformance: { pdfa: level } }), both, ENV);
      expect(rendered.warnings).toEqual([]);
      await check(`syllabics-${level}`, rendered.bytes, level);
    }
    const own = await renderDocument(archivalDocument({ blocks: [paragraph("p", "Fill me."), WIDGETS[0]!] }), await fonts(), ENV);
    const filled = await fillTemplate(own.bytes, { first: SYLLABICS }, FILL_OPTIONS, [cffFont()], ENV, [], { pdfa: "2b" });
    await check("filled-cff-appearance", filled.bytes, "2b");
  }, 180_000);

  it("accepts a part-3 document with the submission attached, and custom output intents", async () => {
    const attached = await renderDocument(archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] } }), await fonts(), ENV);
    await check("generated-3b-attached", attached.bytes, "3b");
    const cmyk = await renderDocument(
      archivalDocument({ conformance: { pdfa: "3u", outputIntent: { profile: { data: bytesToBase64(cmykProfile()) }, identifier: "CGATS TR 001", info: "CGATS TR 001" } } }),
      await fonts(),
      ENV
    );
    await check("generated-3u-cmyk", cmyk.bytes, "3u");
  }, 120_000);

  it("accepts every built-in output condition the kernel carries", async () => {
    for (const profile of PDF_BUILTIN_PROFILES) {
      const rendered = await renderDocument(
        archivalDocument({ conformance: { pdfa: "2u", outputIntent: { profile: { source: builtinProfileSource(profile.id) }, identifier: profile.identifier, info: profile.info, ...(profile.registry ? { registry: profile.registry } : {}) } } }),
        await fonts(),
        ENV
      );
      expect(rendered.warnings).toEqual([]);
      await check(`builtin-${profile.id}`, rendered.bytes, "2u");
    }
  }, 120_000);

  it("accepts the kernel's own output filled as a template, raised to part 3 and flattened", async () => {
    const own = await renderDocument(archivalDocument({ blocks: [paragraph("p", "Fill me."), ...WIDGETS] }), await fonts(), ENV);
    await check("template-own", own.bytes, "2b");
    const filled = await fillTemplate(own.bytes, { first: "Grace", agree: false, colour: "r", country: "France" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2b" });
    await check("filled-own-2b", filled.bytes, "2b");
    const raised = await fillTemplate(own.bytes, { first: "Grace" }, { ...FILL_OPTIONS, flatten: true }, await fonts(), ENV, [], { pdfa: "3b", attachments: [SUBMISSION] });
    await check("filled-own-3b-flat", raised.bytes, "3b");
  }, 120_000);

  it("keeps templates from another producer conformant through a fill: part 1, and a CMYK intent with areas", async () => {
    const one = await fillTemplate(await pdfLibTemplate("1B"), { Name: "Ada é", Agree: true }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2b" });
    await check("filled-lib-1b", one.bytes, "1b");
    const cmyk = await fillTemplate(
      await pdfLibTemplate("2B", "cmyk"),
      { Name: "Ada", Agree: true },
      FILL_OPTIONS,
      await fonts(),
      ENV,
      [
        { id: "a1", page: 1, rect: { x: 20, y: 150, width: 200, height: 20 }, value: "Drawn answer", draw: { ...DEFAULT_PDF_AREA_DRAW, color: "#112233" } },
        { id: "a2", page: 1, rect: { x: 20, y: 180, width: 200, height: 20 }, value: "Field answer", draw: { ...DEFAULT_PDF_AREA_DRAW, bold: true }, field: { name: "area2", required: false, readOnly: false } }
      ],
      { pdfa: "2b" },
      undefined,
      PLAN_THEME
    );
    await check("filled-lib-cmyk", cmyk.bytes, "2b");
  }, 120_000);

  it("accepts a document the program builds itself from a form tree and a layout that declares PDF/A-3 with the answers attached", async () => {
    const form: ComponentNode = {
      id: "intake",
      type: "form",
      configuration: { title: "Archival intake" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name", required: true } },
          { id: "vip", type: "checkbox", configuration: { label: "VIP" } },
          { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } }
        ]
      }
    };
    const layout = deriveDefaultPdfLayout(form, {});
    const request: PdfDocumentRequest = {
      abi: PDF_ABI_VERSION,
      op: "document",
      form,
      layout: { ...layout, conformance: { pdfa: "3b", attachData: true, attachment: { name: "answers.json", description: "The answers" } } },
      values: { name: "Ada — مرحبا", vip: true, country: "CA" },
      locale: "en",
      optionSnapshot: { country: [{ value: "CA", label: "Canada" }] },
      fonts: await fonts(),
      env: ENV
    };
    const response = await handlePdfRequest(request);
    expect(response.ok).toBe(true);
    if (response.ok && response.op === "document") {
      expect(response.pdfa).toBe("3b");
      expect(response.warnings).toEqual([]);
      await check("document-op-3b", base64ToBytes(response.bytes), "3b");
      expect(Buffer.from(base64ToBytes(response.bytes)).toString("latin1")).toContain("/AFRelationship /Data");
    }
  }, 60_000);

  it("accepts a PDF/A-3 document with uploaded files attached — a PDF and a picture — and the same as PDF/A-2 with them left out", async () => {
    const { withoutClaim } = await import("./pdfa-fixtures.js");
    const own = await renderDocument(withoutClaim(archivalDocument()), await fonts(), ENV);
    const scan = { name: "scan.pdf", mimeType: "application/pdf", description: "A scanned page", relationship: "Supplement" as const, data: bytesToBase64(own.bytes), componentId: "scan" };
    const photo = { name: "photo.png", mimeType: "image/png", description: "A photo", relationship: "Supplement" as const, data: RED_PNG_BASE64, componentId: "photo" };
    const attached = await renderDocument(archivalDocument({ conformance: { pdfa: "3b" }, attachments: [scan, photo] }), await fonts(), ENV);
    expect(attached.pdfa).toBe("3b");
    expect(attached.warnings).toEqual([]);
    expect(attached.attachments).toEqual(["scan.pdf", "photo.png"]);
    await check("generated-3b-uploads", attached.bytes, "3b");
    expect(Buffer.from(attached.bytes).toString("latin1")).toContain("/AFRelationship /Supplement");

    const refused = await renderDocument(archivalDocument({ conformance: { pdfa: "2b" }, attachments: [scan, photo] }), await fonts(), ENV);
    expect(refused.warnings.map((warning) => warning.code)).toEqual(["pdfa.attachments"]);
    expect(refused.attachments).toEqual([]);
    await check("generated-2b-uploads-refused", refused.bytes, "2b");
  }, 120_000);

  it("accepts a document the program builds from a form whose file component attaches its upload", async () => {
    const form: ComponentNode = {
      id: "claim",
      type: "form",
      configuration: { title: "Claim" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "photo", type: "file", configuration: { label: "Photo", storage: "base64", pdf: { attach: true } } }
        ]
      }
    };
    const layout = deriveDefaultPdfLayout(form, {});
    const upload = { storage: "base64", name: "photo.png", type: "image/png", size: 68, data: RED_PNG_BASE64 };
    const request: PdfDocumentRequest = {
      abi: PDF_ABI_VERSION,
      op: "document",
      form,
      layout: { ...layout, conformance: { pdfa: "3b", attachData: true, attachment: { name: "answers.json" } } },
      values: { name: "Ada", photo: upload },
      locale: "en",
      fonts: await fonts(),
      env: ENV
    };
    const response = await handlePdfRequest(request);
    expect(response.ok).toBe(true);
    if (response.ok && response.op === "document") {
      expect(response.pdfa).toBe("3b");
      expect(response.warnings).toEqual([]);
      expect(response.attachments).toEqual(["answers.json", "photo.png"]);
      await check("document-op-3b-upload", base64ToBytes(response.bytes), "3b");
    }
    const kept = await handlePdfRequest({ ...request, layout: { ...layout, conformance: { pdfa: "2b" } } });
    if (kept.ok && kept.op === "document") {
      expect(kept.attachments).toEqual([]);
      expect(kept.warnings.map((warning) => warning.code)).toEqual(["pdfa.attachments"]);
      await check("document-op-2b-upload-refused", base64ToBytes(kept.bytes), "2b");
    }
  }, 120_000);

  it("stays conformant through a signature: generated, attached, filled, certified, visible and not", async () => {
    const who = identity("rsa2048");
    const sign = async (bytes: Uint8Array, spec: Parameters<typeof prepareSignature>[1] extends infer T ? Partial<T> : never) => {
      const prepared = await prepareSignature(bytes, { certificates: who.certificates, ...spec }, await fonts(), ENV);
      const value = hostSign(who, prepared.signing.toBeSigned);
      const { timestamp: _reserve, ...rest } = spec;
      return completeSignature(prepared.bytes, { certificates: who.certificates, ...rest, value });
    };
    // Part 3 with the submission attached: the signature seals the JSON too.
    const attached = await renderDocument(archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] } }), await fonts(), ENV);
    const sealed = await sign(attached.bytes, { certify: "noChanges", reason: "Archived" });
    await check("signed-3b-attached-certified", sealed.bytes, "3b");
    const report = await verifySignatures(sealed.bytes);
    expect(report.signatures[0]).toMatchObject({ digestMatches: true, coversDocument: true, certification: { permissions: "noChanges" } });
    expect(report.attachments.map((attachment) => attachment.name)).toEqual(["submission.json"]);
    // Every level, invisible and visible with the DejaVu resource.
    for (const level of ["2b", "2u", "3u"] as const) {
      const rendered = await renderDocument(archivalDocument({ conformance: { pdfa: level } }), await fonts(), ENV);
      await check(`signed-${level}-visible`, (await sign(rendered.bytes, {})).bytes, level);
      await check(`signed-${level}-invisible`, (await sign(rendered.bytes, { appearance: false })).bytes, level);
    }
    // A CMYK intent: the appearance stream declares DefaultRGB like every other.
    const cmyk = await renderDocument(
      archivalDocument({ conformance: { pdfa: "3u", outputIntent: { profile: { data: bytesToBase64(cmykProfile()) }, identifier: "CGATS TR 001", info: "CGATS TR 001" } } }),
      await fonts(),
      ENV
    );
    await check("signed-3u-cmyk", (await sign(cmyk.bytes, {})).bytes, "3u");
    // Into the layout's own signature widget, on a level-"a" document.
    const own = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" }, blocks: [paragraph("p", "Sign below."), { id: "sig", kind: "widget", label: "Sealed by", field: { name: "server-signature", kind: "signature" } }] }), await fonts(), ENV);
    await check("signed-2a-into-widget", (await sign(own.bytes, { field: "server-signature" })).bytes, "2a");
    // A fill of the kernel's own output, raised to part 3, then signed; and a second signature on it.
    const filled = await fillTemplate(own.bytes, { first: "Grace" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "3b" });
    const once = await sign(filled.bytes, { certify: "formFilling" });
    await check("signed-filled-3b-certified-p2", once.bytes, "3b");
    const twice = await sign(once.bytes, { reason: "Countersigned" });
    await check("signed-filled-3b-twice", twice.bytes, "3b");
    expect((await verifySignatures(twice.bytes)).signatures.map((entry) => entry.digestMatches)).toEqual([true, true]);
  }, 300_000);

  it("rejects what the kernel does not claim, so a pass above means something", async () => {
    const plain = await renderDocument(archivalDocument(), [], ENV).catch(() => undefined);
    expect(plain).toBeUndefined();
    const { withoutClaim } = await import("./pdfa-fixtures.js");
    const ordinary = await renderDocument(withoutClaim(archivalDocument()), await fonts(), ENV);
    const file = join(dir, "ordinary.pdf");
    writeFileSync(file, ordinary.bytes);
    expect(validateWithVeraPdf(cli!, file, "2b").compliant).toBe(false);
  }, 60_000);
});
