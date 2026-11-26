import { describe, expect, it } from "vitest";

import { DEFAULT_PDF_ACCESSIBILITY, DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES, DEFAULT_PDF_ATTACHMENT_NAME, DEFAULT_PDF_AREA_DRAW, DEFAULT_PDF_PAGE_SETUP, PDF_BUILTIN_PROFILES, PDF_DOCUMENT_COMPONENT_TYPE, PDF_PAGE_SIZES, builtinProfileOf, builtinProfileSource, findPdfLayout, pdfALevel, pdfAPart, pdfAWithLevel, pdfPageDimensions, readComponentPdfOptions, readDefaultPdfLayoutId, readIccColorSpace, readPdfConfiguration, resolvePdfAccessibility, resolvePdfAttachmentPolicy, resolvePdfConformance, resolvePdfAreaDraw, resolvePdfAreaField, resolvePdfPageSetup, validatePdfLayout, type PdfGeneratedLayout, type PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import { resolvePdfSignatureConfiguration } from "../form-engine/core/schema/pdf-signature-configuration.js";
import { bytesToBase64 } from "../form-engine/core/schema/file-upload.js";

/** The 128-byte header of an ICC profile: the colour space at 16, `acsp` at 36. */
function iccHeader(space: "RGB " | "CMYK" | "GRAY" | "Lab "): Uint8Array {
  const bytes = new Uint8Array(128);
  bytes.set([...space].map((char) => char.charCodeAt(0)), 16);
  bytes.set([0x61, 0x63, 0x73, 0x70], 36);
  return bytes;
}

function generated(id: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    root: { id: "doc", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [] } }
  };
}

function template(id: string): PdfTemplateLayout {
  return {
    id,
    kind: "template",
    template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 3, data: "AAA=" },
    fields: [{ pdfField: "Name", source: { kind: "component", componentId: "name" } }]
  };
}

describe("resolvePdfPageSetup", () => {
  it("is Letter portrait with three-quarter-inch margins when the layout says nothing", () => {
    expect(resolvePdfPageSetup(undefined)).toEqual(DEFAULT_PDF_PAGE_SETUP);
    expect(resolvePdfPageSetup("junk")).toEqual(DEFAULT_PDF_PAGE_SETUP);
    expect(resolvePdfPageSetup({ size: "Tabloid", orientation: "sideways" })).toEqual(
      DEFAULT_PDF_PAGE_SETUP
    );
  });

  it("returns a fresh margins object, never the shared default", () => {
    const setup = resolvePdfPageSetup(undefined);
    setup.margins.top = 0;
    expect(DEFAULT_PDF_PAGE_SETUP.margins.top).toBe(54);
  });

  it("keeps a named size, a usable custom size, and each usable margin", () => {
    expect(
      resolvePdfPageSetup({
        size: "A4",
        orientation: "landscape",
        margins: { top: 20, right: -5, bottom: "x", left: 0 },
        header: { height: 30 },
        footer: { height: 0 }
      })
    ).toEqual({
      size: "A4",
      orientation: "landscape",
      margins: { top: 20, right: 54, bottom: 54, left: 0 },
      header: { height: 30 }
    });
    expect(resolvePdfPageSetup({ size: { width: 400, height: 600 } }).size).toEqual({
      width: 400,
      height: 600
    });
    // A custom size too small to lay out on is not a size.
    expect(resolvePdfPageSetup({ size: { width: 10, height: 600 } }).size).toBe("Letter");
  });

  it("swaps the dimensions for landscape", () => {
    expect(pdfPageDimensions(resolvePdfPageSetup({ size: "Legal" }))).toEqual(PDF_PAGE_SIZES.Legal);
    expect(pdfPageDimensions(resolvePdfPageSetup({ size: "Legal", orientation: "landscape" }))).toEqual({
      width: 1008,
      height: 612
    });
  });
});

describe("resolvePdfAccessibility", () => {
  it("tags by default and shows the title", () => {
    expect(resolvePdfAccessibility(undefined)).toEqual(DEFAULT_PDF_ACCESSIBILITY);
    expect(resolvePdfAccessibility({ tagged: "yes", lang: "" })).toEqual(DEFAULT_PDF_ACCESSIBILITY);
  });

  it("honours real switches, a language and a title (a string; its translations are the definition's map)", () => {
    expect(
      resolvePdfAccessibility({
        tagged: false,
        displayDocTitle: false,
        lang: "fr-CA",
        title: "Intake"
      })
    ).toEqual({
      tagged: false,
      displayDocTitle: false,
      lang: "fr-CA",
      title: "Intake"
    });
    // An object is not a title: there is no reader of the inline shape.
    expect(resolvePdfAccessibility({ title: { default: "Intake", locales: { fr: "Admission" } } }).title).toBeUndefined();
  });
});

describe("resolvePdfConformance", () => {
  const profile = { storage: "base64", name: "org.icc", type: "application/vnd.iccprofile", size: 128, data: bytesToBase64(iccHeader("RGB ")) };

  it("asks for nothing without a level, and takes a level in any case", () => {
    expect(resolvePdfConformance(undefined)).toBeUndefined();
    expect(resolvePdfConformance({})).toBeUndefined();
    expect(resolvePdfConformance({ pdfa: "" })).toBeUndefined();
    expect(resolvePdfConformance({ pdfa: "1b" })).toBeUndefined();
    expect(resolvePdfConformance({ pdfa: "1a" })).toBeUndefined();
    expect(resolvePdfConformance({ pdfa: " 2B " })).toEqual({ pdfa: "2b", attachData: false, attachment: { name: DEFAULT_PDF_ATTACHMENT_NAME } });
    expect(resolvePdfConformance({ pdfa: "2a" })?.pdfa).toBe("2a");
    expect(resolvePdfConformance({ pdfa: "3a", attachData: true })?.attachData).toBe(true);
  });

  it("takes a level apart and puts it together", () => {
    expect(pdfAPart("3a")).toBe(3);
    expect(pdfALevel("3a")).toBe("a");
    expect(pdfALevel("2u")).toBe("u");
    expect(pdfAWithLevel("3a", "u")).toBe("3u");
    expect(pdfAWithLevel("1b", "a")).toBe("1a");
  });

  it("names the kernel's built-in profiles as envelopes the kernel resolves, and refuses one it does not carry", () => {
    expect(PDF_BUILTIN_PROFILES.map((profile) => profile.id)).toEqual(["srgb", "gray", "cmyk"]);
    expect(builtinProfileSource("cmyk")).toEqual({ storage: "builtin", ref: "cmyk", name: "CGATS TR 001 compatible.icc", type: "application/vnd.iccprofile", size: 8464 });
    expect(builtinProfileOf(builtinProfileSource("gray"))?.components).toBe(1);
    expect(builtinProfileOf({ storage: "builtin", ref: "lab", name: "x", type: "", size: 0 })).toBeUndefined();
    expect(builtinProfileOf({ storage: "asset", ref: "srgb", name: "x", type: "", size: 0 })).toBeUndefined();
    expect(resolvePdfConformance({ pdfa: "2b", outputIntent: { profile: builtinProfileSource("srgb") } })?.outputIntent?.profile).toEqual(builtinProfileSource("srgb"));
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "2b", outputIntent: { profile: builtinProfileSource("gray") } } })).toEqual([]);
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "2b", outputIntent: { profile: { storage: "builtin", ref: "lab", name: "Lab.icc", type: "", size: 0 } } } })).toEqual([
      "conformance.outputIntent.profile names no built-in profile (srgb, gray, cmyk)"
    ]);
  });

  it("reads an ICC profile's colour space from its header, and nothing from bytes that are no profile", () => {
    expect(readIccColorSpace(iccHeader("RGB "))).toBe(3);
    expect(readIccColorSpace(iccHeader("CMYK"))).toBe(4);
    expect(readIccColorSpace(iccHeader("GRAY"))).toBe(1);
    expect(readIccColorSpace(iccHeader("Lab "))).toBeUndefined();
    expect(readIccColorSpace(new Uint8Array(200))).toBeUndefined();
    expect(readIccColorSpace(new Uint8Array(10))).toBeUndefined();
  });

  it("attaches the submission under part 3 only, under the name and description given", () => {
    expect(resolvePdfConformance({ pdfa: "2b", attachData: true })?.attachData).toBe(false);
    expect(resolvePdfConformance({ pdfa: "3u", attachData: true, attachment: { name: "answers.json", description: "Answers" } })).toEqual({
      pdfa: "3u",
      attachData: true,
      attachment: { name: "answers.json", description: "Answers" }
    });
    // A path is no file name: the default stands.
    expect(resolvePdfConformance({ pdfa: "3b", attachment: { name: "../etc/passwd" } })?.attachment.name).toBe(DEFAULT_PDF_ATTACHMENT_NAME);
    expect(resolvePdfConformance({ pdfa: "3b", attachment: { name: "  " } })?.attachment.name).toBe(DEFAULT_PDF_ATTACHMENT_NAME);
  });

  it("keeps an output intent that names a usable profile, with its names trimmed, and drops one that does not", () => {
    expect(resolvePdfConformance({ pdfa: "2b", outputIntent: { profile, identifier: " Org RGB ", info: "", registry: "http://www.color.org" } })?.outputIntent).toEqual({
      profile,
      identifier: "Org RGB",
      registry: "http://www.color.org"
    });
    expect(resolvePdfConformance({ pdfa: "2b", outputIntent: { identifier: "x" } })?.outputIntent).toBeUndefined();
    expect(resolvePdfConformance({ pdfa: "2b", outputIntent: { profile: { storage: "base64", name: "x.icc", type: "", size: 0 } } })?.outputIntent).toBeUndefined();
    expect(resolvePdfConformance({ pdfa: "2b", outputIntent: { profile: { storage: "asset", name: "x.icc", type: "", size: 0, ref: "a1" } } })?.outputIntent?.profile.storage).toBe("asset");
  });
});

describe("validatePdfLayout", () => {
  it("accepts a well-formed generated layout and a well-formed template layout", () => {
    expect(validatePdfLayout(generated("a"))).toEqual([]);
    expect(validatePdfLayout(template("t"))).toEqual([]);
  });

  it("checks a conformance block on either kind", () => {
    const profile = { storage: "base64", name: "org.icc", type: "application/vnd.iccprofile", size: 128, data: bytesToBase64(iccHeader("CMYK")) };
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "3b", attachData: true, attachment: { name: "answers.json" }, outputIntent: { profile } } })).toEqual([]);
    expect(validatePdfLayout({ ...template("t"), conformance: { pdfa: "2u" } })).toEqual([]);
    expect(validatePdfLayout({ ...template("t"), conformance: { pdfa: "3a" } })).toEqual([]);
    expect(validatePdfLayout({ ...generated("a"), conformance: "2b" })).toEqual(["conformance must be an object"]);
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "1b" } })).toEqual(["conformance.pdfa must be one of 2b, 2u, 2a, 3b, 3u, 3a"]);
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "1a" } })).toEqual(["conformance.pdfa must be one of 2b, 2u, 2a, 3b, 3u, 3a"]);
    // An inline profile is checked for what it is; a host-stored one is the kernel's to check.
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "2b", outputIntent: { profile: { ...profile, data: "AAAA" } } } })).toEqual(["conformance.outputIntent.profile is not an ICC profile"]);
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "2b", outputIntent: { profile: { ...profile, data: "not base64!!" } } } })).toEqual(["conformance.outputIntent.profile is not an ICC profile"]);
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "2b", outputIntent: { profile: { storage: "asset", name: "x.icc", type: "", size: 0, ref: "a1" } } } })).toEqual([]);
    expect(validatePdfLayout({ ...template("t"), conformance: { pdfa: "2b", outputIntent: { identifier: "x" } } })).toEqual([
      "conformance.outputIntent needs a profile with a storage kind (and its data when base64)"
    ]);
    expect(validatePdfLayout({ ...generated("a"), conformance: { pdfa: "3b", attachment: { name: "a/b.json" } } })).toEqual(["conformance.attachment.name must be a bare file name"]);
  });

  it("checks an attachments block on either kind", () => {
    expect(validatePdfLayout({ ...generated("a"), attachments: { budgetMb: 4, onExceeded: "fail" } })).toEqual([]);
    expect(validatePdfLayout({ ...template("t"), attachments: {} })).toEqual([]);
    expect(validatePdfLayout({ ...generated("a"), attachments: "16" })).toEqual(["attachments must be an object"]);
    expect(validatePdfLayout({ ...template("t"), attachments: { budgetMb: "4", onExceeded: "warn" } })).toEqual([
      "attachments.budgetMb must be a number of megabytes, zero or more",
      'attachments.onExceeded must be "skip" or "fail"'
    ]);
    expect(validatePdfLayout({ ...generated("a"), attachments: { budgetMb: -1 } })).toEqual(["attachments.budgetMb must be a number of megabytes, zero or more"]);
  });

  it("checks a signature block on either kind, and reads one tolerantly", () => {
    expect(validatePdfLayout({ ...generated("a"), signature: { field: "server-signature", certify: "noChanges", reason: { default: "Sealed" }, appearance: { rect: [36, 36, 180, 48] }, placeholderBytes: 16384 } })).toEqual([]);
    expect(validatePdfLayout({ ...template("t"), signature: { field: "OfficerSignature", appearance: false } })).toEqual([]);
    expect(validatePdfLayout({ ...generated("a"), signature: "yes" })).toEqual(["signature must be an object"]);
    expect(validatePdfLayout({ ...generated("a"), signature: { subFilter: "adbe.x509.rsa_sha1", certify: "locked", field: "", appearance: { rect: [1, 2] }, placeholderBytes: 1 << 20 } })).toEqual([
      'signature.subFilter must be "ETSI.CAdES.detached" or "adbe.pkcs7.detached"',
      'signature.certify must be false, "noChanges", "formFilling" or "annotations"',
      "signature.field must be a field name",
      "signature.appearance.rect must be four numbers: x, y, width, height",
      "signature.placeholderBytes must be a whole number of bytes up to 65536"
    ]);
    expect(resolvePdfSignatureConfiguration(undefined)).toBeUndefined();
    expect(resolvePdfSignatureConfiguration({ certify: "noChanges", field: " ", timestamp: "yes", appearance: { page: 0, rect: [1, 2, 3, 4], lines: ["a", 1], fontSize: 9 }, placeholderBytes: 12.5 })).toEqual({
      certify: "noChanges",
      appearance: { rect: [1, 2, 3, 4], fontSize: 9 }
    });
    expect(resolvePdfSignatureConfiguration({ appearance: false, required: true, reason: "Why" })).toEqual({ appearance: false, required: true, reason: "Why" });
  });

  it("names each problem in words", () => {
    expect(validatePdfLayout(null)).toEqual(["layout must be an object"]);
    expect(validatePdfLayout({ kind: "generated" })).toEqual([
      "layout.id is required",
      "generated layout needs a root component node"
    ]);
    expect(
      validatePdfLayout({ id: "x", kind: "generated", root: { id: "r", type: "form" } })
    ).toEqual([`generated layout root must be a "${PDF_DOCUMENT_COMPONENT_TYPE}" node`]);
    expect(validatePdfLayout({ id: "x", kind: "sideways" })).toEqual([
      'layout.kind must be "generated" or "template"'
    ]);
    expect(
      validatePdfLayout({
        id: "t",
        kind: "template",
        template: { storage: "base64", name: "t.pdf", type: "", size: 0 },
        fields: [{ pdfField: "" }, { pdfField: "Name" }, { pdfField: "Ok", source: { kind: "literal", value: 1 } }]
      })
    ).toEqual([
      "a base64 template source needs its data",
      "fields[0] needs a pdfField name",
      'fields[1] ("Name") needs a source'
    ]);
  });

  it("accepts a template with no fields and areas drawn on its pages, and names what an area lacks", () => {
    const paper: PdfTemplateLayout = {
      ...template("paper"),
      fields: [],
      areas: [
        { id: "name", label: "Name", page: 1, rect: { x: 60, y: 40, width: 200, height: 14 }, source: { kind: "component", componentId: "name" } },
        { id: "tick", page: 2, rect: { x: 60, y: 60, width: 12, height: 12 }, source: { kind: "literal", value: true }, draw: { kind: "check" } }
      ]
    };
    expect(validatePdfLayout(paper)).toEqual([]);
    expect(readPdfConfiguration({ pdf: { layouts: [paper] } })).toEqual([paper]);
    expect(validatePdfLayout({ ...paper, areas: {} })).toEqual(["template layout areas must be a list"]);
    expect(
      validatePdfLayout({
        ...paper,
        areas: [
          { page: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, source: { kind: "literal", value: 1 } },
          { id: "a", label: "First", page: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, source: { kind: "literal", value: 1 } },
          { id: "a", page: 1, rect: { x: 0, y: 0, width: 0, height: 1 }, source: { kind: "literal", value: 1 } },
          { id: "b", page: 1.5, rect: { x: "0", y: 0, width: 1, height: 1 } },
          { id: "c", page: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, source: { kind: "literal", value: 1 } }
        ]
      })
    ).toEqual([
      "areas[0] needs an id",
      'areas[1] ("First") needs a page number from 1',
      'areas[2] repeats the id "a"',
      'areas[2] ("a") needs a rect with a positive width and height',
      'areas[3] ("b") needs a page number from 1',
      'areas[3] ("b") needs a rect with a positive width and height',
      'areas[3] ("b") needs a source'
    ]);
  });
});

describe("fillable areas", () => {
  it("accepts a field block and names what it lacks", () => {
    const paper: PdfTemplateLayout = {
      ...template("paper"),
      fields: [],
      areas: [
        { id: "name", label: "Full name", page: 1, rect: { x: 60, y: 40, width: 200, height: 14 }, source: { kind: "component", componentId: "name" }, field: {} },
        { id: "tick", page: 1, rect: { x: 60, y: 60, width: 12, height: 12 }, source: { kind: "literal", value: true }, draw: { kind: "check" }, field: { name: "agree", required: true, tooltip: "Agree" } }
      ]
    };
    expect(validatePdfLayout(paper)).toEqual([]);
    expect(
      validatePdfLayout({
        ...paper,
        areas: [
          { ...paper.areas![0], field: "yes" },
          { ...paper.areas![1], field: { name: " " } },
          { ...paper.areas![1], id: "dots", field: { name: "a..b" } }
        ]
      })
    ).toEqual(['areas[0] ("Full name") field must be an object', 'areas[1] ("tick") field needs a name', 'areas[2] ("dots") field needs a name']);
  });

  it("resolves the field's name from the area's name or label or id, and its tooltip from the label", () => {
    expect(resolvePdfAreaField({ id: "a1" })).toBeUndefined();
    expect(resolvePdfAreaField({ id: "a1", field: {} })).toEqual({ name: "a1", required: false, readOnly: false });
    expect(resolvePdfAreaField({ id: "a1", label: "Full name", field: {} })).toEqual({ name: "Full name", required: false, readOnly: false, tooltip: "Full name" });
    expect(resolvePdfAreaField({ id: "a1", label: "Full name", field: { name: " applicant ", required: true, readOnly: true, tooltip: "Type your name" } })).toEqual({
      name: "applicant",
      required: true,
      readOnly: true,
      tooltip: "Type your name"
    });
  });
});

describe("resolvePdfAreaDraw", () => {
  it("fills the defaults in and puts anything unusable back to its default", () => {
    expect(resolvePdfAreaDraw(undefined)).toEqual(DEFAULT_PDF_AREA_DRAW);
    expect(resolvePdfAreaDraw({})).toEqual(DEFAULT_PDF_AREA_DRAW);
    expect(resolvePdfAreaDraw({ kind: "check", fontSize: 12, align: "end", valign: "bottom", padding: 0, wrap: false, bold: true, color: "#123456" })).toEqual({
      kind: "check",
      fontSize: 12,
      align: "end",
      valign: "bottom",
      padding: 0,
      wrap: false,
      bold: true,
      color: "#123456"
    });
    expect(resolvePdfAreaDraw({ kind: "image" as never, fontSize: 0, align: "left" as never, valign: "centre" as never, padding: -1, color: "" })).toEqual(DEFAULT_PDF_AREA_DRAW);
  });
});

describe("a layout's when", () => {
  it("is no schema fault, however it is written: a malformed one never holds, and the layout stays usable", () => {
    for (const when of ["x", 42, null, { kind: "binary", operator: "equals" }, { kind: "path", path: "province" }]) {
      const layouts = [{ ...generated("a"), when }, { ...template("t"), when }];
      for (const layout of layouts) {
        expect(validatePdfLayout(layout)).toEqual([]);
      }
      expect(readPdfConfiguration({ pdf: { layouts } }).map((layout) => layout.id)).toEqual(["a", "t"]);
      expect(findPdfLayout({ pdf: { layouts, defaultLayoutId: "t" } })?.id).toBe("t");
    }
  });
});

describe("readPdfConfiguration / findPdfLayout", () => {
  it("reads nothing from a definition without layouts, or with unusable ones", () => {
    expect(readPdfConfiguration(undefined)).toEqual([]);
    expect(readPdfConfiguration({})).toEqual([]);
    expect(readPdfConfiguration({ pdf: { layouts: "nope" } })).toEqual([]);
    expect(readPdfConfiguration({ pdf: { layouts: [{ id: "broken", kind: "generated" }] } })).toEqual([]);
  });

  it("keeps the usable layouts in order and skips the broken ones", () => {
    const layouts = readPdfConfiguration({
      pdf: { layouts: [generated("a"), { kind: "template" }, template("t")] }
    });
    expect(layouts.map((layout) => layout.id)).toEqual(["a", "t"]);
  });

  it("finds a layout by id, then the default, then the first", () => {
    const definition = {
      pdf: { layouts: [generated("a"), generated("b"), template("t")], defaultLayoutId: "b" }
    };
    expect(findPdfLayout(definition, "t")?.id).toBe("t");
    expect(findPdfLayout(definition)?.id).toBe("b");
    expect(findPdfLayout({ pdf: { layouts: [generated("a")], defaultLayoutId: "zzz" } })?.id).toBe("a");
    expect(findPdfLayout(definition, "missing")).toBeUndefined();
    expect(findPdfLayout(undefined)).toBeUndefined();
    expect(readDefaultPdfLayoutId(definition)).toBe("b");
    expect(readDefaultPdfLayoutId({ pdf: { defaultLayoutId: "" } })).toBeUndefined();
  });
});

describe("readComponentPdfOptions", () => {
  it("reads a rendition and an exclusion off a form component's configuration", () => {
    expect(readComponentPdfOptions(undefined)).toEqual({});
    expect(readComponentPdfOptions({ label: "Name" })).toEqual({});
    expect(readComponentPdfOptions({ pdf: { rendition: "field", exclude: true } })).toEqual({
      rendition: "field",
      exclude: true
    });
    expect(readComponentPdfOptions({ pdf: { rendition: " ", exclude: "yes" } })).toEqual({});
  });

  it("reads the attach switch of a file component, true alone", () => {
    expect(readComponentPdfOptions({ pdf: { attach: true } })).toEqual({ attach: true });
    expect(readComponentPdfOptions({ pdf: { attach: false } })).toEqual({});
    expect(readComponentPdfOptions({ pdf: { attach: "yes" } })).toEqual({});
    expect(readComponentPdfOptions({ pdf: { rendition: "image", attach: true, exclude: true } })).toEqual({ rendition: "image", attach: true, exclude: true });
  });
});

describe("resolvePdfAttachmentPolicy", () => {
  it("defaults to 4 MiB and skip, and takes the layout's megabytes and policy", () => {
    expect(resolvePdfAttachmentPolicy(undefined)).toEqual({ budgetBytes: DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES, onExceeded: "skip" });
    expect(DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES).toBe(4 * 1024 * 1024);
    expect(resolvePdfAttachmentPolicy({ budgetMb: 2, onExceeded: "fail" })).toEqual({ budgetBytes: 2 * 1024 * 1024, onExceeded: "fail" });
    expect(resolvePdfAttachmentPolicy({ budgetMb: 0 })).toEqual({ budgetBytes: 0, onExceeded: "skip" });
    expect(resolvePdfAttachmentPolicy({ budgetMb: 0.5 })).toEqual({ budgetBytes: 512 * 1024, onExceeded: "skip" });
  });

  it("lets the call override each field on its own, and lets junk fall through", () => {
    expect(resolvePdfAttachmentPolicy({ budgetMb: 2, onExceeded: "fail" }, { budgetBytes: 1000 })).toEqual({ budgetBytes: 1000, onExceeded: "fail" });
    expect(resolvePdfAttachmentPolicy({ budgetMb: 2 }, { onExceeded: "fail" })).toEqual({ budgetBytes: 2 * 1024 * 1024, onExceeded: "fail" });
    expect(resolvePdfAttachmentPolicy({ budgetMb: -1, onExceeded: "explode" }, { budgetBytes: Number.NaN, onExceeded: "warn" as never })).toEqual({
      budgetBytes: DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES,
      onExceeded: "skip"
    });
    expect(resolvePdfAttachmentPolicy("lots")).toEqual({ budgetBytes: DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES, onExceeded: "skip" });
  });
});
