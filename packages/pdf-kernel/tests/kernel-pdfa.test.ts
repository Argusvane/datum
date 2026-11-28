import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, getDefaultSRGBProfile } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { DEFAULT_PDF_AREA_DRAW, PDF_BUILTIN_PROFILES, builtinProfileSource } from "@argusvane/datum-engine/core";
import { PdfKernelError, base64ToBytes, bytesToBase64, type PdfWarning } from "@argusvane/datum-engine/render";
import { cffGlyphCount, cidSetBitmap, iccComponents, isLanguageTag, pdfDateToXmp, readMetadataXml, trueTypeGlyphCount } from "../src/kernel/pdfa.js";
import { builtinProfile, builtinProfileSizes, grayGamma22Profile } from "../src/kernel/profiles.js";
import { renderDocument, layoutOnly } from "../src/kernel/render.js";
import { fillClaim, fillTemplate, inspectTemplate } from "../src/kernel/template.js";
import { ENV, extractText, fonts, paragraph, PLAN_THEME, reload } from "./helpers.js";
import {
  EXTENDED_SYLLABICS,
  FILL_OPTIONS,
  SUBMISSION,
  SYLLABICS,
  WIDGETS,
  archivalDocument,
  cffFont,
  cmykProfile,
  pdfLibTemplate,
  plainTemplate,
  syllabicsDocument,
  withParentTreeKids,
  withoutClaim
} from "./pdfa-fixtures.js";

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/** A page's content streams, inflated and joined. */
function pageContent(pdf: PDFDocument, index: number): string {
  const contents = pdf.getPage(index).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs
    .map((entry) => {
      const stream = pdf.context.lookup(entry as PDFRef) as PDFRawStream;
      return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    })
    .join("\n");
}

/** Every indirect dictionary of a kind. */
function dictsOfType(pdf: PDFDocument, type: string): PDFDict[] {
  return pdf.context
    .enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object): object is PDFDict => object instanceof PDFDict && object.lookup(PDFName.of("Type")) === PDFName.of(type));
}

function annotations(pdf: PDFDocument): PDFDict[] {
  const out: PDFDict[] = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; annots && i < annots.size(); i += 1) {
      out.push(annots.lookup(i, PDFDict));
    }
  }
  return out;
}

function xmpOf(pdf: PDFDocument): string {
  const xml = readMetadataXml(pdf);
  expect(xml).toBeDefined();
  return xml!;
}

describe("PDF/A", () => {
  it("declares the level, an sRGB output intent and metadata that mirrors the Info dictionary", async () => {
    const rendered = await renderDocument(archivalDocument(), await fonts(), ENV);
    expect(rendered.pdfa).toBe("2b");
    expect(rendered.warnings).toEqual([]);
    const pdf = await reload(rendered.bytes);
    const xmp = xmpOf(pdf);
    expect(xmp).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
    expect(xmp).toContain("<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Fixture &amp; &lt;title&gt;</rdf:li></rdf:Alt></dc:title>");
    expect(xmp).toContain("<dc:creator><rdf:Seq><rdf:li>Ada</rdf:li></rdf:Seq></dc:creator>");
    expect(xmp).toContain("<pdf:Keywords>a b</pdf:Keywords>");
    expect(xmp).toContain("<pdf:Producer>Datum tests</pdf:Producer>");
    expect(xmp).toContain("<xmp:CreateDate>2026-09-05T10:11:12Z</xmp:CreateDate>");
    expect(xmp).toContain("<xmp:ModifyDate>2026-09-05T10:11:12Z</xmp:ModifyDate>");
    expect(pdf.getKeywords()).toBe("a b");
    // The packet is stored as it is, no filter: readers that cannot inflate must still find it.
    const metadata = pdf.catalog.lookup(PDFName.of("Metadata"), PDFStream);
    expect(metadata.dict.has(PDFName.of("Filter"))).toBe(false);

    const intents = pdf.catalog.lookup(PDFName.of("OutputIntents"), PDFArray);
    expect(intents.size()).toBe(1);
    const intent = intents.lookup(0, PDFDict);
    expect(intent.lookup(PDFName.of("S"))).toBe(PDFName.of("GTS_PDFA1"));
    expect(intent.lookup(PDFName.of("OutputConditionIdentifier"))?.toString()).toBe("(sRGB IEC61966-2.1)");
    expect(intent.lookup(PDFName.of("RegistryName"))?.toString()).toBe("(http://www.color.org)");
    const profile = intent.lookup(PDFName.of("DestOutputProfile"), PDFStream);
    expect(profile.dict.lookup(PDFName.of("N"))).toEqual(PDFNumber.of(3));
    expect(iccComponents(decodePDFRawStream(profile as PDFRawStream).decode())).toBe(3);
    expect(pdf.context.trailerInfo.ID).toBeDefined();
  });

  it("embeds every font with a CIDSet and Length1, draws no standard-14 face, and keeps the text readable", async () => {
    const rendered = await renderDocument(archivalDocument(), await fonts(), ENV);
    const pdf = await reload(rendered.bytes);
    const descriptors = dictsOfType(pdf, "FontDescriptor");
    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      const file = descriptor.lookup(PDFName.of("FontFile2"), PDFStream);
      expect(file.dict.lookup(PDFName.of("Length1"))).toBeInstanceOf(PDFNumber);
      const program = decodePDFRawStream(file as PDFRawStream).decode();
      expect(file.dict.lookup(PDFName.of("Length1"))).toEqual(PDFNumber.of(program.length));
      const cidSet = decodePDFRawStream(descriptor.lookup(PDFName.of("CIDSet"), PDFStream) as PDFRawStream).decode();
      expect(cidSet).toEqual(cidSetBitmap(trueTypeGlyphCount(program)!));
    }
    const fonts_ = dictsOfType(pdf, "Font");
    expect(fonts_.some((font) => font.lookup(PDFName.of("Subtype")) === PDFName.of("Type1"))).toBe(false);
    expect(latin1(rendered.bytes)).not.toContain("/BaseFont /Helvetica");
    const text = (await extractText(rendered.bytes)).join(" ");
    expect(text).toContain("Archival form");
    expect(text).toContain("مرحبا");
  });

  it("gives every widget an appearance with /N alone and leaves nothing to the viewer", async () => {
    const rendered = await renderDocument(archivalDocument(), await fonts(), ENV);
    const pdf = await reload(rendered.bytes);
    const annots = annotations(pdf);
    expect(annots.length).toBe(WIDGETS.length + 1);
    for (const annotation of annots) {
      const ap = annotation.lookup(PDFName.of("AP"), PDFDict);
      expect(ap.has(PDFName.of("N"))).toBe(true);
      expect(ap.has(PDFName.of("D"))).toBe(false);
      expect(ap.has(PDFName.of("R"))).toBe(false);
    }
    expect(pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict).has(PDFName.of("NeedAppearances"))).toBe(false);
    // The plain render keeps pdf-lib's down appearances: the pass only runs under a claim.
    const plain = await renderDocument(withoutClaim(archivalDocument()), await fonts(), ENV);
    expect(annotations(await reload(plain.bytes)).some((annotation) => annotation.lookup(PDFName.of("AP"), PDFDict).has(PDFName.of("D")))).toBe(true);
    expect(plain.pdfa).toBeUndefined();
    expect(readMetadataXml(await reload(plain.bytes))).toBeUndefined();
  });

  it("associates the submission under part 3, names it as configured, and refuses it under part 2", async () => {
    const attached = await renderDocument(archivalDocument({ conformance: { pdfa: "3b", attachments: [{ ...SUBMISSION, name: "answers.json", description: "The answers" }] } }), await fonts(), ENV);
    expect(attached.pdfa).toBe("3b");
    expect(attached.warnings).toEqual([]);
    const pdf = await reload(attached.bytes);
    const af = pdf.catalog.lookup(PDFName.of("AF"), PDFArray);
    expect(af.size()).toBe(1);
    const spec = af.lookup(0, PDFDict);
    expect(spec.lookup(PDFName.of("AFRelationship"))).toBe(PDFName.of("Data"));
    expect(spec.lookup(PDFName.of("F"), PDFHexString).decodeText()).toBe("answers.json");
    expect(spec.lookup(PDFName.of("Desc"), PDFHexString).decodeText()).toBe("The answers");
    expect(spec.lookup(PDFName.of("UF"), PDFHexString).decodeText()).toBe("answers.json");
    const file = spec.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F"), PDFStream);
    expect(file.dict.lookup(PDFName.of("Subtype"))).toBe(PDFName.of("application/json"));
    expect(file.dict.lookup(PDFName.of("Params"), PDFDict).lookup(PDFName.of("ModDate"))?.toString()).toBe("(D:20260905101112Z)");
    expect(Buffer.from(decodePDFRawStream(file as PDFRawStream).decode()).toString("utf8")).toBe('{"a":1}');
    const names = pdf.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
    expect(names.size()).toBe(2);
    expect(xmpOf(pdf)).toContain("<pdfaid:part>3</pdfaid:part>");

    const refused = await renderDocument(archivalDocument({ conformance: { pdfa: "2b", attachments: [SUBMISSION] } }), await fonts(), ENV);
    expect(refused.warnings.map((warning) => warning.code)).toEqual(["pdfa.attachments"]);
    expect(latin1(refused.bytes)).not.toContain("/EmbeddedFile");
  });

  it("declares a configured output intent, adds DefaultRGB under a CMYK one, and falls back to sRGB for bytes that are no profile", async () => {
    const rgb = await renderDocument(
      archivalDocument({ conformance: { pdfa: "2b", outputIntent: { profile: { data: bytesToBase64(getDefaultSRGBProfile()) }, identifier: "Custom sRGB", info: "A custom condition", registry: "http://example.org" } } }),
      await fonts(),
      ENV
    );
    expect(rgb.warnings).toEqual([]);
    const rgbIntent = (await reload(rgb.bytes)).catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict);
    expect(rgbIntent.lookup(PDFName.of("OutputConditionIdentifier"))?.toString()).toBe("(Custom sRGB)");
    expect(rgbIntent.lookup(PDFName.of("Info"))?.toString()).toBe("(A custom condition)");
    expect(rgbIntent.lookup(PDFName.of("RegistryName"))?.toString()).toBe("(http://example.org)");
    expect(latin1(rgb.bytes)).not.toContain("/DefaultRGB");

    const cmyk = await renderDocument(
      archivalDocument({ conformance: { pdfa: "3u", outputIntent: { profile: { data: bytesToBase64(cmykProfile()) }, identifier: "CGATS TR 001", info: "CGATS" } } }),
      await fonts(),
      ENV
    );
    expect(cmyk.warnings).toEqual([]);
    const cmykPdf = await reload(cmyk.bytes);
    const cmykIntent = cmykPdf.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict);
    expect(cmykIntent.lookup(PDFName.of("DestOutputProfile"), PDFStream).dict.lookup(PDFName.of("N"))).toEqual(PDFNumber.of(4));
    expect(cmykIntent.has(PDFName.of("RegistryName"))).toBe(false);
    for (const page of cmykPdf.getPages()) {
      expect(page.node.Resources()?.lookup(PDFName.of("ColorSpace"), PDFDict).has(PDFName.of("DefaultRGB"))).toBe(true);
    }
    for (const annotation of annotations(cmykPdf)) {
      const normal = annotation.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"));
      const streams = normal instanceof PDFStream ? [normal] : (normal as PDFDict).entries().map(([, value]) => cmykPdf.context.lookup(value, PDFStream));
      for (const stream of streams) {
        expect(stream.dict.lookup(PDFName.of("Resources"), PDFDict).lookup(PDFName.of("ColorSpace"), PDFDict).has(PDFName.of("DefaultRGB"))).toBe(true);
      }
    }

    const bogus = await renderDocument(
      archivalDocument({ conformance: { pdfa: "2b", outputIntent: { profile: { data: bytesToBase64(new TextEncoder().encode("not a profile")) }, identifier: "x", info: "x" } } }),
      await fonts(),
      ENV
    );
    expect(bogus.warnings.map((warning) => warning.code)).toEqual(["pdfa.outputIntent"]);
    expect(latin1(bogus.bytes)).toContain("(sRGB IEC61966-2.1)");

    const unresolved = await renderDocument(
      archivalDocument({ conformance: { pdfa: "2b", outputIntent: { profile: { source: { storage: "asset", name: "org.icc", type: "application/vnd.iccprofile", size: 1 } }, identifier: "org", info: "org" } } }),
      await fonts(),
      ENV
    );
    expect(unresolved.warnings.map((warning) => warning.code)).toEqual(["pdfa.outputIntent"]);
    expect(unresolved.pdfa).toBe("2b");
  });

  it("refuses a render without a font resource, replaces glyphs no font has, and leaves out CMYK JPEGs", async () => {
    await expect(renderDocument(archivalDocument(), [], ENV)).rejects.toMatchObject({ name: "PdfKernelError", code: "font" });
    await expect(layoutOnly(archivalDocument(), [])).rejects.toBeInstanceOf(PdfKernelError);
    // Without the claim the same request degrades to the standard 14 with a warning, as before.
    const plain = await renderDocument(withoutClaim(archivalDocument()), [], ENV);
    expect(plain.warnings.map((warning) => warning.code)).toContain("font.unencodable");

    const cjk = await renderDocument(archivalDocument({ blocks: [paragraph("p", "Han 漢字 here")] }), await fonts(), ENV);
    expect(cjk.warnings.map((warning) => warning.code)).toEqual(["font.unencodable"]);
    expect((await extractText(cjk.bytes))[0]).toContain("Han ?? here");

    // A JPEG whose start-of-frame names four components.
    const sof = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x04, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0x04, 0x11, 0x00, 0xff, 0xd9];
    const withCmyk = await renderDocument(
      archivalDocument({ resources: { images: { logo: { type: "image/jpeg", data: bytesToBase64(new Uint8Array(sof)) } } } }),
      await fonts(),
      ENV
    );
    expect(withCmyk.warnings.map((warning) => warning.code)).toContain("pdfa.image");
    expect(latin1(withCmyk.bytes)).not.toContain("/DeviceCMYK");
  });

  it("honours the request's override over the document's claim, in both directions", async () => {
    const off = await renderDocument(archivalDocument(), await fonts(), ENV, { pdfa: false });
    expect(off.pdfa).toBeUndefined();
    expect(latin1(off.bytes)).not.toContain("pdfaid");
    const forced = await renderDocument(withoutClaim(archivalDocument()), await fonts(), ENV, { pdfa: "3u" });
    expect(forced.pdfa).toBe("3u");
    expect(xmpOf(await reload(forced.bytes))).toContain("<pdfaid:conformance>U</pdfaid:conformance>");
  });

  it("writes the same bytes twice, compact or not", async () => {
    for (const compact of [false, true]) {
      const first = await renderDocument(archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] } }), await fonts(), ENV, { compact });
      const second = await renderDocument(archivalDocument({ conformance: { pdfa: "3b", attachments: [SUBMISSION] } }), await fonts(), ENV, { compact });
      expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
      expect(latin1(first.bytes).includes("/ObjStm")).toBe(compact);
    }
  });

  describe("templates", () => {
    it("keeps the kernel's own PDF/A output conformant through a fill, and raises it to part 3 for an attachment", async () => {
      const own = await renderDocument(archivalDocument({ blocks: [paragraph("p", "Fill me."), ...WIDGETS] }), await fonts(), ENV);
      const filled = await fillTemplate(own.bytes, { first: "Grace", agree: false, colour: "r", country: "France" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2b" });
      expect(filled.pdfa).toBe("2b");
      expect(filled.warnings).toEqual([]);
      expect(filled.fields.map((report) => report.status)).toEqual(["filled", "cleared", "filled", "filled"]);
      const pdf = await reload(filled.bytes);
      expect(xmpOf(pdf)).toContain("<xmp:ModifyDate>2026-09-05T10:11:12Z</xmp:ModifyDate>");
      expect(pdf.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).size()).toBe(1);
      for (const annotation of annotations(pdf)) {
        expect(annotation.lookup(PDFName.of("AP"), PDFDict).has(PDFName.of("D"))).toBe(false);
      }
      expect(latin1(filled.bytes)).not.toContain("/BaseFont /Helvetica");

      const raised = await fillTemplate(own.bytes, { first: "Grace" }, { ...FILL_OPTIONS, flatten: true }, await fonts(), ENV, [], { pdfa: "3b", attachments: [SUBMISSION] });
      expect(raised.pdfa).toBe("3b");
      expect(raised.warnings).toEqual([]);
      const raisedPdf = await reload(raised.bytes);
      expect(xmpOf(raisedPdf)).toContain("<pdfaid:part>3</pdfaid:part>");
      expect(raisedPdf.catalog.lookup(PDFName.of("AF"), PDFArray).size()).toBe(1);
      expect(latin1(raised.bytes)).not.toContain("/BaseFont /Helvetica");
      expect((await inspectTemplate(raised.bytes)).pdfa).toBe("3b");
    });

    it("keeps a part-1 template at part 1 and a 'b' template at 'b', and reports the template's level on inspect", async () => {
      const template = await pdfLibTemplate("1B");
      expect((await inspectTemplate(template)).pdfa).toBe("1b");
      const filled = await fillTemplate(template, { Name: "Ada é", Agree: true }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "3u", attachments: [SUBMISSION] });
      expect(filled.pdfa).toBe("1b");
      expect(filled.warnings.map((warning) => warning.code).sort()).toEqual(["pdfa.attachments", "pdfa.level"]);
      expect(xmpOf(await reload(filled.bytes))).toContain("<pdfaid:part>1</pdfaid:part>");
      expect(fillClaim("2b", "2u", [])).toBe("2b");
      expect(fillClaim("2u", "2b", [])).toBe("2u");
      expect(fillClaim("2b", "3b", [])).toBe("3b");
      expect(fillClaim("3b", "2b", [])).toBe("3b");
      expect(fillClaim(undefined, undefined, [])).toBeUndefined();
    });

    it("keeps a template's own CMYK intent and declares DefaultRGB for what it draws", async () => {
      const template = await pdfLibTemplate("2B", "cmyk");
      const filled = await fillTemplate(
        template,
        { Name: "Ada", Agree: true },
        FILL_OPTIONS,
        await fonts(),
        ENV,
        [
          { id: "a1", page: 1, rect: { x: 20, y: 150, width: 200, height: 20 }, value: "Drawn answer", draw: { ...DEFAULT_PDF_AREA_DRAW, color: "#112233" } },
          { id: "a2", page: 1, rect: { x: 20, y: 180, width: 200, height: 20 }, value: "Field answer", draw: { ...DEFAULT_PDF_AREA_DRAW, bold: true }, field: { name: "area2", required: false, readOnly: false } }
        ],
        { pdfa: "2b", outputIntent: { profile: { data: bytesToBase64(getDefaultSRGBProfile()) }, identifier: "ignored", info: "ignored" } },
        undefined,
        PLAN_THEME
      );
      expect(filled.pdfa).toBe("2b");
      expect(filled.warnings.map((warning) => warning.code)).toEqual(["pdfa.outputIntent"]);
      const pdf = await reload(filled.bytes);
      const intent = pdf.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict);
      expect(intent.lookup(PDFName.of("OutputConditionIdentifier"))?.toString()).toBe("(CGATS TR 001)");
      expect(pdf.getPage(0).node.Resources()?.lookup(PDFName.of("ColorSpace"), PDFDict).has(PDFName.of("DefaultRGB"))).toBe(true);
      expect(filled.areas.map((area) => area.status)).toEqual(["filled", "filled"]);
    });

    it("fills a template that declares nothing as an ordinary PDF and says so", async () => {
      const filled = await fillTemplate(await plainTemplate(), { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2b" });
      expect(filled.pdfa).toBeUndefined();
      expect(filled.warnings.map((warning) => warning.code)).toEqual(["pdfa.template"]);
      expect(readMetadataXml(await reload(filled.bytes))).toBeUndefined();
    });

    it("regenerates appearances a layout would leave to the viewer, and refuses an encrypted template or a fill with no font", async () => {
      const template = await pdfLibTemplate("2B");
      const viewer = await fillTemplate(template, { Name: "Ada" }, { ...FILL_OPTIONS, appearances: "viewer" }, await fonts(), ENV, [], { pdfa: "2b" });
      expect(viewer.warnings.map((warning) => warning.code)).toEqual(["pdfa.appearances"]);
      expect(latin1(viewer.bytes)).not.toContain("/NeedAppearances true");
      await expect(fillTemplate(template, { Name: "Ada" }, FILL_OPTIONS, [], ENV, [], { pdfa: "2b" })).rejects.toMatchObject({ code: "font" });
      // Without the claim, Latin-1 values draw with Helvetica as they always did.
      const plain = await fillTemplate(template, { Name: "Ada" }, FILL_OPTIONS, [], ENV);
      expect(plain.pdfa).toBeUndefined();

      // An encrypted template can never fill to PDF/A, whatever it declares (its metadata is not even readable).
      const locked = await PDFDocument.create({ updateMetadata: false });
      locked.addPage([200, 200]);
      // Filling allowed, so the refusal below is the PDF/A one and not the owner's.
      locked.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { fillingForms: true } });
      const lockedBytes = await locked.save({ useObjectStreams: false, objectsPerTick: Infinity });
      await expect(fillTemplate(lockedBytes, {}, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2b" })).rejects.toMatchObject({ code: "conformance" });
      expect((await fillTemplate(lockedBytes, {}, FILL_OPTIONS, await fonts(), ENV)).pdfa).toBeUndefined();
    });
  });

  describe("level \"a\"", () => {
    /** The structure elements under the document element, by role. */
    function documentKids(pdf: PDFDocument): string[] {
      const root = pdf.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
      const element = root.lookup(PDFName.of("K"), PDFArray).lookup(0, PDFDict);
      expect(element.lookup(PDFName.of("S"))).toBe(PDFName.of("Document"));
      return element
        .lookup(PDFName.of("K"), PDFArray)
        .asArray()
        .map((kid) => pdf.context.lookup(kid, PDFDict).lookup(PDFName.of("S")))
        .map((role) => (role as PDFName).decodeText());
    }

    function parentTreeNums(pdf: PDFDocument): PDFArray {
      return pdf.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict).lookup(PDFName.of("ParentTree"), PDFDict).lookup(PDFName.of("Nums"), PDFArray);
    }

    it("declares A for a tagged document, and tags an untagged layout anyway with a warning", async () => {
      const rendered = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" } }), await fonts(), ENV);
      expect(rendered.pdfa).toBe("2a");
      expect(rendered.warnings).toEqual([]);
      const pdf = await reload(rendered.bytes);
      expect(xmpOf(pdf)).toContain("<pdfaid:conformance>A</pdfaid:conformance>");
      expect(pdf.catalog.has(PDFName.of("StructTreeRoot"))).toBe(true);
      expect((await inspectTemplate(rendered.bytes)).pdfa).toBe("2a");

      const untagged = await renderDocument(archivalDocument({ conformance: { pdfa: "3a" }, accessibility: { tagged: false, displayDocTitle: true } }), await fonts(), ENV);
      expect(untagged.pdfa).toBe("3a");
      expect(untagged.warnings.map((warning) => warning.code)).toEqual(["pdfa.tagged"]);
      expect((await reload(untagged.bytes)).catalog.has(PDFName.of("StructTreeRoot"))).toBe(true);
      // The override says off too, and is overridden the same way.
      const forcedOff = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" } }), await fonts(), ENV, { tagged: false });
      expect(forcedOff.warnings.map((warning) => warning.code)).toEqual(["pdfa.tagged"]);
    });

    it("replaces Private Use Area characters under \"a\" only, and drops to \"u\" for a language that is no tag", async () => {
      const pua = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" }, blocks: [paragraph("p", "Logo  here")] }), await fonts(), ENV);
      expect(pua.warnings.map((warning) => warning.code)).toContain("font.privateUse");
      expect((await extractText(pua.bytes))[0]).toContain("Logo ? here");
      const puaB = await renderDocument(archivalDocument({ conformance: { pdfa: "2b" }, blocks: [paragraph("p", "Logo  here")] }), await fonts(), ENV);
      expect(puaB.warnings.map((warning) => warning.code)).not.toContain("font.privateUse");

      const badLang = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" }, metadata: { title: "T", lang: "en_US!", textDirection: "ltr" } }), await fonts(), ENV);
      expect(badLang.pdfa).toBe("2u");
      expect(badLang.warnings.map((warning) => warning.code)).toEqual(["pdfa.level"]);
      expect(xmpOf(await reload(badLang.bytes))).toContain("<pdfaid:conformance>U</pdfaid:conformance>");
      expect(isLanguageTag("en-CA")).toBe(true);
      expect(isLanguageTag("")).toBe(true);
      expect(isLanguageTag("en_US")).toBe(false);
    });

    it("tags what a fill adds into the template's own tree, and keeps the letter", async () => {
      const own = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" }, blocks: [paragraph("p", "Fill me."), ...WIDGETS] }), await fonts(), ENV);
      const before = await reload(own.bytes);
      const kidsBefore = documentKids(before).length;
      const page = before.getPage(0);
      const keyBefore = page.node.lookup(PDFName.of("StructParents"), PDFNumber).asNumber();
      const numsBefore = parentTreeNums(before);
      const mcidsBefore = before.context.lookup(numsBefore.get(numsBefore.asArray().findIndex((entry) => entry instanceof PDFNumber && entry.asNumber() === keyBefore) + 1), PDFArray).size();

      const filled = await fillTemplate(
        own.bytes,
        { first: "Grace" },
        FILL_OPTIONS,
        await fonts(),
        ENV,
        [
          { id: "a1", page: 1, rect: { x: 20, y: 600, width: 200, height: 20 }, value: "Drawn answer", draw: DEFAULT_PDF_AREA_DRAW },
          { id: "a2", page: 1, rect: { x: 20, y: 630, width: 20, height: 20 }, value: true, draw: { ...DEFAULT_PDF_AREA_DRAW, kind: "check" } },
          { id: "a3", page: 1, rect: { x: 20, y: 660, width: 200, height: 20 }, value: "Field answer", draw: DEFAULT_PDF_AREA_DRAW, field: { name: "area3", required: false, readOnly: false } }
        ],
        { pdfa: "3a", attachments: [SUBMISSION] },
        undefined,
        PLAN_THEME
      );
      expect(filled.pdfa).toBe("3a");
      expect(filled.warnings).toEqual([]);
      expect(filled.areas.map((area) => area.status)).toEqual(["filled", "filled", "filled"]);
      const pdf = await reload(filled.bytes);
      expect(xmpOf(pdf)).toContain("<pdfaid:conformance>A</pdfaid:conformance>");
      const kids = documentKids(pdf);
      expect(kids.slice(kidsBefore)).toEqual(["P", "P", "Form"]);
      // The page's parent-tree array grew by the two marked sequences, at MCIDs the page did not have.
      const nums = parentTreeNums(pdf);
      const pageArray = pdf.context.lookup(nums.get(nums.asArray().findIndex((entry) => entry instanceof PDFNumber && entry.asNumber() === keyBefore) + 1), PDFArray);
      expect(pageArray.size()).toBe(mcidsBefore + 2);
      const content = pageContent(pdf, 0);
      expect(content).toMatch(new RegExp(`/P\\s*<<\\s*/MCID ${mcidsBefore}\\s*>>\\s*BDC\\s*q`));
      expect(content).toMatch(new RegExp(`/P\\s*<<\\s*/MCID ${mcidsBefore + 1}\\s*>>\\s*BDC`));
      expect(content).toMatch(/Q\s*EMC/);
      // The new widget hangs off its Form element through an OBJR, under a fresh StructParent key.
      const root = pdf.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
      const nextKey = root.lookup(PDFName.of("ParentTreeNextKey"), PDFNumber).asNumber();
      const widget = pdf.getForm().getTextField("area3").acroField.getWidgets()[0]!.dict;
      const key = widget.lookup(PDFName.of("StructParent"), PDFNumber).asNumber();
      expect(key).toBe(nextKey - 1);
      const form = pdf.context.lookup(nums.get(nums.asArray().findIndex((entry) => entry instanceof PDFNumber && entry.asNumber() === key) + 1), PDFDict);
      expect(form.lookup(PDFName.of("S"))).toBe(PDFName.of("Form"));
      const objr = form.lookup(PDFName.of("K"), PDFArray).lookup(0, PDFDict);
      expect(objr.lookup(PDFName.of("Type"))).toBe(PDFName.of("OBJR"));
      expect(objr.get(PDFName.of("Obj"))).toBeInstanceOf(PDFRef);
      // Keys stay sorted, as a number tree asks.
      const keys = nums.asArray().filter((entry, index) => index % 2 === 0 && entry instanceof PDFNumber).map((entry) => (entry as PDFNumber).asNumber());
      expect(keys).toEqual([...keys].sort((a, b) => a - b));
    });

    it("drops to \"u\" when the fill flattens or the tree cannot be extended, and never raises a letter", async () => {
      const own = await renderDocument(archivalDocument({ conformance: { pdfa: "2a" }, blocks: [paragraph("p", "Fill me."), WIDGETS[0]!] }), await fonts(), ENV);
      const flat = await fillTemplate(own.bytes, { first: "Grace" }, { ...FILL_OPTIONS, flatten: true }, await fonts(), ENV, [], { pdfa: "2a" });
      expect(flat.pdfa).toBe("2u");
      expect(flat.warnings.map((warning) => warning.code)).toEqual(["pdfa.level"]);
      expect(xmpOf(await reload(flat.bytes))).toContain("<pdfaid:conformance>U</pdfaid:conformance>");

      const kids = await fillTemplate(await withParentTreeKids(own.bytes), { first: "Grace" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2a" });
      expect(kids.pdfa).toBe("2u");
      expect(kids.warnings.map((warning) => warning.code)).toEqual(["pdfa.level"]);

      const b = await fillTemplate(await pdfLibTemplate("2B"), { Name: "Ada" }, FILL_OPTIONS, await fonts(), ENV, [], { pdfa: "2a" });
      expect(b.pdfa).toBe("2b");
      expect(b.warnings.map((warning) => warning.code)).toEqual(["pdfa.level"]);
      expect(fillClaim("2a", "2u", [])).toBe("2a");
      expect(fillClaim("2a", "2b", [])).toBe("2a");
      expect(fillClaim("2a", "3b", [])).toBe("3a");
      const warnings: PdfWarning[] = [];
      expect(fillClaim("2u", "2a", warnings)).toBe("2u");
      expect(warnings.map((warning) => warning.code)).toEqual(["pdfa.level"]);
    });
  });

  describe("CFF / OpenType fonts", () => {
    it("embeds a CFF face with a CIDSet and no Length1, drops the CIDToGIDMap, and keeps the syllabics readable", async () => {
      const rendered = await renderDocument(syllabicsDocument(), [...(await fonts()), cffFont()], ENV);
      expect(rendered.pdfa).toBe("2u");
      expect(rendered.warnings).toEqual([]);
      const pdf = await reload(rendered.bytes);
      const cid0 = dictsOfType(pdf, "Font").filter((font) => font.lookup(PDFName.of("Subtype")) === PDFName.of("CIDFontType0"));
      expect(cid0.length).toBe(1);
      expect(cid0[0]!.has(PDFName.of("CIDToGIDMap"))).toBe(false);
      const descriptor = cid0[0]!.lookup(PDFName.of("FontDescriptor"), PDFDict);
      const file = descriptor.lookup(PDFName.of("FontFile3"), PDFStream);
      expect(file.dict.lookup(PDFName.of("Subtype"))).toBe(PDFName.of("CIDFontType0C"));
      expect(file.dict.has(PDFName.of("Length1"))).toBe(false);
      const program = decodePDFRawStream(file as PDFRawStream).decode();
      const glyphs = cffGlyphCount(program);
      // .notdef, the seven syllabics, the two extended letters that fell back to the face, and the space after them (it follows the letters).
      expect(glyphs).toBe(1 + new Set(SYLLABICS).size + new Set(EXTENDED_SYLLABICS).size + 1);
      expect(decodePDFRawStream(descriptor.lookup(PDFName.of("CIDSet"), PDFStream) as PDFRawStream).decode()).toEqual(cidSetBitmap(glyphs!));
      // The TrueType face beside it is completed as before.
      const cid2 = dictsOfType(pdf, "Font").filter((font) => font.lookup(PDFName.of("Subtype")) === PDFName.of("CIDFontType2"));
      expect(cid2.length).toBeGreaterThan(0);
      const text = (await extractText(rendered.bytes)).join(" ");
      expect(text).toContain(`Plains Cree: ${SYLLABICS} (2026)`);
      // The Latin around the extended letters stayed in the default face: nothing became `?`.
      expect(text).toContain(`Extended: ${EXTENDED_SYLLABICS} (2026)`);
      expect(latin1(rendered.bytes)).not.toContain("/BaseFont /Helvetica");
    });

    it("reads a CFF program's glyph count from its CharStrings", () => {
      const otf = base64ToBytes(cffFont().data);
      // The OpenType wrapper is not a bare CFF; its `CFF ` table is one.
      expect(cffGlyphCount(otf)).toBeUndefined();
      expect(trueTypeGlyphCount(otf)).toBe(748);
      const view = new DataView(otf.buffer, otf.byteOffset, otf.byteLength);
      const tables = view.getUint16(4);
      let cff: Uint8Array | undefined;
      for (let i = 0; i < tables; i += 1) {
        const record = 12 + i * 16;
        if (String.fromCharCode(...otf.subarray(record, record + 4)) === "CFF ") {
          cff = otf.subarray(view.getUint32(record + 8), view.getUint32(record + 8) + view.getUint32(record + 12));
        }
      }
      expect(cff).toBeDefined();
      expect(cffGlyphCount(cff!)).toBe(748);
      expect(cffGlyphCount(new Uint8Array([2, 0, 4, 1]))).toBeUndefined();
    });

    it("draws field appearances with a CFF face through a fill", async () => {
      const own = await renderDocument(archivalDocument({ blocks: [paragraph("p", "Fill me."), WIDGETS[0]!] }), await fonts(), ENV);
      const filled = await fillTemplate(own.bytes, { first: SYLLABICS }, FILL_OPTIONS, [cffFont()], ENV, [], { pdfa: "2b" });
      expect(filled.pdfa).toBe("2b");
      expect(filled.warnings).toEqual([]);
      const pdf = await reload(filled.bytes);
      const cid0 = dictsOfType(pdf, "Font").filter((font) => font.lookup(PDFName.of("Subtype")) === PDFName.of("CIDFontType0"));
      expect(cid0.length).toBe(1);
      const descriptor = cid0[0]!.lookup(PDFName.of("FontDescriptor"), PDFDict);
      expect(descriptor.has(PDFName.of("CIDSet"))).toBe(true);
      expect(descriptor.lookup(PDFName.of("FontFile3"), PDFStream).dict.lookup(PDFName.of("Subtype"))).toBe(PDFName.of("CIDFontType0C"));
      expect(pdf.getForm().getTextField("first").getText()).toBe(SYLLABICS);
    });
  });

  describe("built-in profiles", () => {
    it("carries sRGB, a grey it builds itself and a compact CMYK, each the size the schema says", () => {
      expect(builtinProfileSizes()).toEqual(Object.fromEntries(PDF_BUILTIN_PROFILES.map((profile) => [profile.id, profile.size])));
      for (const profile of PDF_BUILTIN_PROFILES) {
        expect(iccComponents(builtinProfile(profile.id)!)).toBe(profile.components);
      }
      const gray = grayGamma22Profile();
      expect(Buffer.from(gray.subarray(12, 16)).toString("latin1")).toBe("mntr");
      expect(Buffer.from(gray.subarray(36, 40)).toString("latin1")).toBe("acsp");
      expect(Buffer.from(gray).readUInt32BE(0)).toBe(gray.length);
      // The CMYK one is declared as an output profile, whatever pdf.js's copy said of itself.
      expect(Buffer.from(builtinProfile("cmyk")!.subarray(12, 16)).toString("latin1")).toBe("prtr");
      expect(builtinProfile("lab")).toBeUndefined();
    });

    it("declares a built-in condition from the kernel's own bytes, with DefaultRGB where it is not RGB, and sRGB for one it does not carry", async () => {
      const gray = await renderDocument(
        archivalDocument({ conformance: { pdfa: "2u", outputIntent: { profile: { source: builtinProfileSource("gray") }, identifier: "Gray gamma 2.2", info: "Gray gamma 2.2, D65 white point" } } }),
        await fonts(),
        ENV
      );
      expect(gray.warnings).toEqual([]);
      const grayPdf = await reload(gray.bytes);
      const grayIntent = grayPdf.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict);
      expect(grayIntent.lookup(PDFName.of("OutputConditionIdentifier"))?.toString()).toBe("(Gray gamma 2.2)");
      const grayProfile = grayIntent.lookup(PDFName.of("DestOutputProfile"), PDFStream);
      expect(grayProfile.dict.lookup(PDFName.of("N"))).toEqual(PDFNumber.of(1));
      expect(decodePDFRawStream(grayProfile as PDFRawStream).decode()).toEqual(grayGamma22Profile());
      expect(grayPdf.getPage(0).node.Resources()?.lookup(PDFName.of("ColorSpace"), PDFDict).has(PDFName.of("DefaultRGB"))).toBe(true);

      const cmyk = await renderDocument(
        archivalDocument({ conformance: { pdfa: "2b", outputIntent: { profile: { source: builtinProfileSource("cmyk") }, identifier: "CGATS TR 001", info: "CGATS TR 001", registry: "http://www.color.org" } } }),
        await fonts(),
        ENV
      );
      expect(cmyk.warnings).toEqual([]);
      const cmykIntent = (await reload(cmyk.bytes)).catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict);
      expect(cmykIntent.lookup(PDFName.of("DestOutputProfile"), PDFStream).dict.lookup(PDFName.of("N"))).toEqual(PDFNumber.of(4));

      const unknown = await renderDocument(
        archivalDocument({ conformance: { pdfa: "2b", outputIntent: { profile: { source: { storage: "builtin", ref: "lab", name: "Lab.icc", type: "application/vnd.iccprofile", size: 0 } }, identifier: "Lab", info: "Lab" } } }),
        await fonts(),
        ENV
      );
      expect(unknown.warnings.map((warning) => warning.code)).toEqual(["pdfa.outputIntent"]);
      expect(latin1(unknown.bytes)).toContain("(sRGB IEC61966-2.1)");
    });
  });

  describe("helpers", () => {
    it("converts PDF dates to XMP form and reads ICC headers", () => {
      expect(pdfDateToXmp("D:20260905101112Z")).toBe("2026-09-05T10:11:12Z");
      expect(pdfDateToXmp("D:20260905101112+05'30'")).toBe("2026-09-05T10:11:12+05:30");
      expect(pdfDateToXmp("D:20260905101112-0400")).toBe("2026-09-05T10:11:12-04:00");
      expect(pdfDateToXmp("D:2026")).toBe("2026-01-01T00:00:00Z");
      expect(pdfDateToXmp("yesterday")).toBeUndefined();
      expect(iccComponents(getDefaultSRGBProfile())).toBe(3);
      expect(iccComponents(cmykProfile())).toBe(4);
      expect(iccComponents(new Uint8Array(200))).toBeUndefined();
      expect(Array.from(cidSetBitmap(10))).toEqual([0xff, 0xc0]);
    });
  });
});
