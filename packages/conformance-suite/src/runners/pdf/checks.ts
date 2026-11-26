import { X509Certificate, createPublicKey, createPrivateKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPdfCompleteRequest, buildPdfFillRequest, buildPdfRenderRequest, buildPdfVerifyRequest, base64ToBytes, bytesToBase64, type PdfCapabilities, type PdfFontResource } from "@argusvane/datum-engine/render";
import type { QuickJsPdfProvider } from "@argusvane/datum-pdf-kernel/quickjs";

import {
  ENV,
  HOSTILE,
  TEXT_KEYS,
  deriveDefaultPdfLayout,
  documentRequest,
  fileForm,
  fillPlan,
  formWith,
  liar,
  templateBytes,
  textForm,
  upload
} from "./fixtures.js";
import {
  activeContent,
  annotationSubtypes,
  dumpPdf,
  embeddedSubtypes,
  extractText,
  findVeraPdf,
  metadataOf,
  overflowingItems,
  pdfjsAttachments,
  rawStructure,
  rawText,
  veraPdf,
  xmlProblem
} from "./inspect.js";
import { loadPdfLib } from "./libs.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The PDF operations the checks use; the QuickJS provider and the in-process one both fit. */
export type PdfProvider = Pick<QuickJsPdfProvider, "document" | "fill" | "render" | "sign" | "complete" | "verify" | "capabilities">;

export interface CheckContext {
  provider: PdfProvider;
  /** DejaVu Sans when it could be found; empty means the kernel's standard-14 fallbacks. */
  fonts: PdfFontResource[];
  capabilities: PdfCapabilities;
}

export type Outcome = { verdict: "pass" | "fail" | "skip"; detail: string };

const pass = (detail: string): Outcome => ({ verdict: "pass", detail });
const fail = (detail: string): Outcome => ({ verdict: "fail", detail });
const skip = (detail: string): Outcome => ({ verdict: "skip", detail });
const squash = (text: string): string => text.replace(/\s+/g, "");
const codes = (result: { warnings: Array<{ code: string }> }): string[] => result.warnings.map((warning) => warning.code);

function fontSets(ctx: CheckContext): Array<[string, PdfFontResource[]]> {
  return ctx.fonts.length > 0 ? [["embedded DejaVu", ctx.fonts], ["standard-14", []]] : [["standard-14", []]];
}

/** OUT-01: hostile answers stay string data in the content stream. */
export async function checkTextIntegrity(ctx: CheckContext): Promise<Outcome> {
  const form = textForm(Object.keys(HOSTILE));
  const benign = Object.fromEntries(Object.keys(HOSTILE).map((id) => [id, "benign"]));
  const notes: string[] = [];
  for (const [label, fonts] of fontSets(ctx)) {
    const bad = await ctx.provider.document(documentRequest(form, HOSTILE, fonts));
    const good = await ctx.provider.document(documentRequest(form, benign, fonts));
    const badDump = await dumpPdf(bad.bytes);
    const goodDump = await dumpPdf(good.bytes);
    if (badDump.objects !== goodDump.objects) {
      return fail(`${label}: hostile answers changed the object count (${goodDump.objects} -> ${badDump.objects})`);
    }
    const active = activeContent(badDump.text);
    if (active.length > 0) {
      return fail(`${label}: active keys in the output: ${active.join(", ")}`);
    }
    const injected = ["/Evil", "app.alert", "99 0 obj"].filter((needle) => badDump.contents.includes(needle) || rawText(bad.bytes).includes(needle));
    if (injected.length > 0) {
      return fail(`${label}: answer text reached the file as syntax: ${injected.join(", ")}`);
    }
    const text = squash((await extractText(bad.bytes)).join(" "));
    for (const key of TEXT_KEYS) {
      if (!text.includes(squash(HOSTILE[key]!))) {
        return fail(`${label}: the text layer does not hold the answer "${key}" as typed`);
      }
    }
    notes.push(`${label}: ${badDump.objects} objects`);
  }
  return pass(notes.join("; "));
}

/** OUT-02: no active content or link in anything the program writes from answers. */
export async function checkNoActiveContent(ctx: CheckContext): Promise<Outcome> {
  const fonts = ctx.fonts;
  const urlForm = formWith([
    { id: "u", type: "url", configuration: { label: "Site" } },
    { id: "t", type: "text", configuration: { label: "T" } },
    { id: "ta", type: "textarea", configuration: { label: "TA" } },
    { id: "e", type: "email", configuration: { label: "E" } },
    { id: "doc", type: "file", configuration: { label: "Doc", storage: "base64", pdf: { attach: true } } }
  ]);
  const values = {
    u: "https://evil.example/phish?x=1",
    t: "javascript:alert(1)",
    ta: '<a href="https://evil.example">click</a> file:///etc/passwd /URI (https://x) /S /Launch',
    e: "mailto:a@b.c?cc=x",
    doc: [upload("evil.html", "text/html", "<script>alert(1)</script>"), upload("x.pdf", "application/pdf", "%PDF-1.7 /OpenAction")]
  };
  const outputs: Array<[string, Uint8Array]> = [];
  for (const rendition of [undefined, "field"]) {
    const request = documentRequest(urlForm, values, fonts);
    const result = await ctx.provider.document((rendition ? { ...request, pdf: { renditionDefaults: { "*": rendition } } } : request) as never);
    outputs.push([rendition ?? "default", result.bytes]);
  }
  const { document } = await import("./blocks.js");
  const evil = "x) >> /AA << /S /JavaScript /JS (app.alert(1)) >> (";
  const evilOption = "o/ ) /AA << /JS (1) >> #";
  const blocks = [
    { id: "w1", kind: "widget", label: evil, field: { name: "t", kind: "text", value: evil, tooltip: evil } },
    { id: "w2", kind: "widget", label: "r", field: { name: "r", kind: "radio", value: evilOption, options: [{ value: evilOption, label: evil }, { value: "b", label: "B" }] } },
    { id: "w3", kind: "widget", label: "d", field: { name: "d", kind: "dropdown", value: evilOption, options: [{ value: evilOption, label: evil }] } },
    { id: "w4", kind: "widget", label: "m", field: { name: "m", kind: "multiline", value: "a\u0000b\r\n)\\\u202E" } }
  ];
  const widgets = await ctx.provider.render(buildPdfRenderRequest(document(blocks as never) as never, fonts, ENV));
  outputs.push(["widgets", widgets.bytes]);
  for (const [label, bytes] of outputs) {
    const found = [...activeContent((await dumpPdf(bytes)).text), ...activeContent(rawStructure(bytes))];
    if (found.length > 0) {
      return fail(`${label}: active keys in the output: ${[...new Set(found)].join(", ")}`);
    }
    const links = (await annotationSubtypes(bytes)).filter((subtype) => subtype === "Link");
    if (links.length > 0) {
      return fail(`${label}: ${links.length} link annotation(s)`);
    }
  }
  return pass(`${outputs.length} outputs (URL-looking answers, hostile widget values, HTML and PDF uploads): no active key, no link annotation`);
}

/** Hostile attachment names and the name each is read back as (the kernel's sanitizeAttachmentName, replaces the reserved characters `: < > " | ? *` with `_`). */
const PARENS: ReadonlyArray<readonly [string, string]> = [
  ["resume (final.pdf", "resume (final.pdf"],
  ["resume) final.pdf", "resume) final.pdf"],
  // `>>` becomes `__`: the dictionary terminator can no longer be typed into the name.
  ["a) >> endobj", "a) __ endobj"],
  ["ok.txt", "ok.txt"]
];

/** OUT-03: an attachment's Filespec parses, whatever the file is called. */
export async function checkFilespec(ctx: CheckContext): Promise<Outcome> {
  for (const [name, expectedName] of PARENS) {
    const result = await ctx.provider.document(documentRequest(fileForm, { doc: [upload(name)] }, ctx.fonts));
    let names: string[];
    try {
      names = await pdfjsAttachments(result.bytes);
    } catch (error) {
      return fail(`"${name}": pdf.js cannot read the attachments (${error instanceof Error ? error.message : String(error)})`);
    }
    if (names.length !== 1 || names[0] !== expectedName) {
      return fail(`"${name}": pdf.js read back ${JSON.stringify(names)} (expected ${JSON.stringify(expectedName)}); the Filespec is malformed or missing`);
    }
    const active = activeContent((await dumpPdf(result.bytes)).text);
    if (active.length > 0) {
      return fail(`"${name}": active keys ${active.join(", ")}`);
    }
  }
  return pass(`${PARENS.length} hostile names read back as the kernel sanitises them`);
}

/** OUT-04: attachment names are bare, printable and bounded; the type claim is kept only when well formed. */
export async function checkAttachmentNames(ctx: CheckContext): Promise<Outcome> {
  const files = [
    upload("../../etc/passwd"),
    upload("C:\\Users\\a\\evil.exe", "application/octet-stream"),
    upload("invoice\u202Etxt.exe", "application/octet-stream"),
    upload("a\u0000b\nc\u0007.txt"),
    upload(`${"n".repeat(4000)}.txt`),
    upload(".."),
    // (a name, not a type: an HTML claim is refused as an attachment, which OUT-15 judges)
    upload("dup.html", "text/plain", "one"),
    upload("dup.html", "text/plain", "two"),
    upload("h.html", "a/b#c%2F")
  ];
  const result = await ctx.provider.document(documentRequest(fileForm, { doc: files }, ctx.fonts));
  const names = await pdfjsAttachments(result.bytes);
  const expected = ["passwd", "evil.exe", "invoicetxt.exe", "abc.txt", "file", "dup.html", "dup-2.html"];
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    return fail(`names not cleaned as the policy says: missing ${JSON.stringify(missing)} in ${JSON.stringify(names.map((n) => (n.length > 40 ? `${n.slice(0, 20)}...(${n.length})` : n)))}`);
  }
  for (const name of names) {
    // eslint-disable-next-line no-control-regex
    if (name.length > 255 || /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(name)) {
      return fail(`a name keeps a control or bidi character, or is over 255 characters (${name.length})`);
    }
  }
  const types = await embeddedSubtypes(result.bytes);
  const bad = types.filter((type) => !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+$/.test(type) || type === "a/b#c%2F");
  if (bad.length > 0 || !types.includes("application/octet-stream")) {
    return fail(`a malformed type claim was kept or not replaced: ${JSON.stringify(bad.length > 0 ? bad : types)}`);
  }
  return pass(`${names.length} names cleaned (path, control, bidi, zero-width, length, dot runs, duplicates); ${types.length} type claims well formed`);
}

/** OUT-05: the attachment budget charges the bytes carried, not the size the envelope claims. */
export async function checkSizeHonesty(ctx: CheckContext): Promise<Outcome> {
  const layout = { ...deriveDefaultPdfLayout(fileForm, {}), attachments: { budgetMb: 0.05 } };
  const control = await ctx.provider.document(documentRequest(fileForm, { doc: [upload("small.txt")] }, ctx.fonts, { layout: layout as never }));
  if ((await pdfjsAttachments(control.bytes)).length !== 1) {
    return fail("a small honest file was not embedded (the check would prove nothing)");
  }
  const lie = await ctx.provider.document(documentRequest(fileForm, { doc: [liar("big.bin", 200_000)] }, ctx.fonts, { layout: layout as never }));
  const embedded = await pdfjsAttachments(lie.bytes);
  if (embedded.length > 0) {
    return fail(`a 200,000-byte file declared as size 0 was embedded against a 52,428-byte budget (${embedded.join(", ")}); the budget trusts the declared size`);
  }
  // The budget charges the decoded bytes (attachment.skipped), and bytes well past the declared size are a lie, skipped as file.sizeMismatch.
  const dropped = codes(lie).find((code) => code === "attachment.skipped" || code === "file.sizeMismatch");
  if (dropped === undefined) {
    return fail(`the file was dropped silently: warnings ${JSON.stringify(codes(lie))}`);
  }
  return pass(`a file claiming size 0 and carrying 200,000 bytes is skipped with ${dropped}; an honest small file is embedded`);
}

const REF_LAYOUT = {
  id: "l",
  kind: "generated",
  root: { id: "d", type: "pdf-document", configuration: {}, children: { header: [], footer: [], body: [{ id: "t", type: "pdf-text", configuration: { text: "Ref {{ref}} - page {{page}} of {{pages}} - DENIED" } }] } }
};
const REF_FORM = formWith([{ id: "ref", type: "text", configuration: { label: "Ref" } }]);
const renderRef = (ctx: CheckContext, ref: string) => ctx.provider.document(documentRequest(REF_FORM, { ref }, ctx.fonts, { pdf: { layouts: [REF_LAYOUT as never], defaultLayoutId: "l" } }));

/** OUT-06: bidi embedding and override controls typed into an answer cannot reorder the author's text. */
export async function checkBidi(ctx: CheckContext): Promise<Outcome> {
  const good = await renderRef(ctx, "A-100");
  const bad = await renderRef(ctx, "\u202EA-100");
  const goodText = (await extractText(good.bytes)).join(" ");
  const badText = (await extractText(bad.bytes)).join(" ");
  if (goodText !== badText) {
    return fail(`an override in one answer reordered the text: "${goodText}" became "${badText}"`);
  }
  if (!codes(bad).includes("text.bidiStripped")) {
    return fail("the controls were removed (or not) without the text.bidiStripped warning");
  }
  if (codes(good).includes("text.bidiStripped")) {
    return fail("text.bidiStripped fired for text without controls");
  }
  return pass(`"${badText}" is unchanged by U+202E and the removal is reported`);
}

/** OUT-07: an unbreakable answer wider than the column stays on the page. */
export async function checkOverflow(ctx: CheckContext): Promise<Outcome> {
  const form = formWith([{ id: "id", type: "text", configuration: { label: "Reference" } }, { id: "n", type: "text", configuration: { label: "Next" } }]);
  const value = `${Array.from({ length: 12 }, (_, i) => `SEG${i}`.padEnd(10, "0")).join("")}-TAIL-HIDDEN-PAST-EDGE`;
  const result = await ctx.provider.document(documentRequest(form, { id: value, n: "after" }, ctx.fonts));
  const { pageWidth, over, text } = await overflowingItems(result.bytes);
  if (over.length > 0) {
    return fail(`${over.length} text item(s) end past the ${pageWidth} pt page edge (${JSON.stringify(over[0])}...)`);
  }
  if (!squash(text).includes(value)) {
    return fail("the broken lines no longer hold the whole answer");
  }
  return pass(`a ${value.length}-character atom breaks inside the ${pageWidth} pt page and the text layer holds all of it`);
}

/** OUT-08: a character the font cannot draw is reported, not silently drawn as a box. */
export async function checkMissingGlyph(ctx: CheckContext): Promise<Outcome> {
  const known = ["text.glyphMissing", "font.unencodable"];
  const bad = await renderRef(ctx, "\u65E5\u672C\u8A9E");
  if (!codes(bad).some((code) => known.includes(code))) {
    return fail(`CJK text the font lacks produced no warning (warnings ${JSON.stringify(codes(bad))})`);
  }
  const good = await renderRef(ctx, "plain");
  if (codes(good).some((code) => known.includes(code))) {
    return fail("a missing-glyph warning fired for plain Latin text");
  }
  return pass(`reported as ${codes(bad).filter((code) => known.includes(code)).join(", ")}; plain text is quiet`);
}

/** OUT-09: template field values are escaped, clamped, and not contradicted by an old appearance. */
export async function checkTemplateFill(ctx: CheckContext): Promise<Outcome> {
  const lib = await loadPdfLib();
  const template = await templateBytes();
  const fill = (values: Record<string, unknown>, appearances: "viewer" | "regenerate") => ctx.provider.fill(buildPdfFillRequest(fillPlan(template, values, appearances) as never, template, [], ENV));
  const load = (bytes: Uint8Array) => lib.PDFDocument.load(bytes, { updateMetadata: false });
  const widget = (pdf: any, name: string) => pdf.getForm().getTextField(name).acroField.getWidgets()[0].dict;

  const viewer = await fill({ Pre: "NEW-VALUE" }, "viewer");
  const filled = await load(viewer.bytes);
  if (widget(filled, "Pre").has(lib.PDFName.of("AP"))) {
    return fail("with appearances left to the viewer the old appearance of a changed field is still there (it contradicts /V)");
  }
  if (filled.getForm().getTextField("Pre").getText() !== "NEW-VALUE") {
    return fail("the changed field does not read back its new value");
  }
  if (filled.getForm().acroForm.dict.get(lib.PDFName.of("NeedAppearances"))?.toString() !== "true") {
    return fail("viewer mode did not set NeedAppearances");
  }
  if (!widget(filled, "Other").has(lib.PDFName.of("AP"))) {
    return fail("an untouched field lost its appearance");
  }

  const hostile = "x) >> /AA << /S /JavaScript /JS (app.alert(1)) >> (";
  const escaped = await fill({ Other: hostile }, "regenerate");
  const escapedPdf = await load(escaped.bytes);
  if (escapedPdf.getForm().getTextField("Other").getText() !== hostile) {
    return fail("a value with string and dictionary syntax did not read back as typed");
  }
  const active = activeContent((await dumpPdf(escaped.bytes)).text);
  if (active.length > 0) {
    return fail(`a field value became active content: ${active.join(", ")}`);
  }

  const long = await fill({ Short: "S".repeat(100), Other: "o".repeat(6000) }, "viewer");
  const longPdf = await load(long.bytes);
  const short = longPdf.getForm().getTextField("Short").getText() ?? "";
  const other = longPdf.getForm().getTextField("Other").getText() ?? "";
  if (short.length > 8) {
    return fail(`a field with /MaxLen 8 holds ${short.length} characters`);
  }
  if (other.length > 4096) {
    return fail(`a field without /MaxLen holds ${other.length} characters (cap 4096)`);
  }
  if (!codes(long).includes("field.overflow")) {
    return fail(`the clamp is silent: warnings ${JSON.stringify(codes(long))}`);
  }
  return pass("viewer mode drops the stale appearance; hostile values read back as typed; /MaxLen and the 4,096 cap hold with field.overflow");
}

/** OUT-10: metadata is escaped and never carries an answer. */
export async function checkMetadata(ctx: CheckContext): Promise<Outcome> {
  const title = "T) >> /AA << /S /JavaScript >> <x>&\"'";
  const marker = "ANSWER-MARKER-7f3a9c";
  const form = formWith([{ id: "a", type: "text", configuration: { label: "A" } }], { title });
  const base = deriveDefaultPdfLayout(form, { title });
  const layout = { ...base, conformance: { pdfa: "3b" } };
  const result = await ctx.provider.document(documentRequest(form, { a: `${marker} <&> ) >>` }, ctx.fonts, { layout: layout as never }));
  const meta = await metadataOf(result.bytes);
  if (meta.title !== title) {
    return fail(`the document title reads back as ${JSON.stringify(meta.title)}, not the form's title`);
  }
  if (meta.xmp === undefined) {
    return fail("a PDF/A document has no XMP packet");
  }
  const problem = xmlProblem(meta.xmp);
  if (problem !== undefined) {
    return fail(`the XMP packet is not well formed: ${problem}`);
  }
  for (const [label, value] of [["Info", JSON.stringify(meta)], ["XMP", meta.xmp]] as const) {
    if (value.includes(marker)) {
      return fail(`an answer reached the document ${label}`);
    }
  }
  return pass("Info title round-trips; the XMP packet is well formed and holds no answer");
}

/** OUT-11: PDF/A-3b conformance survives hostile answers and a hostile attachment name (veraPDF). */
export async function checkPdfA(ctx: CheckContext): Promise<Outcome> {
  const cli = findVeraPdf();
  if (cli === undefined) {
    return skip("veraPDF was not found (set VERAPDF or install it at ~/verapdf/verapdf)");
  }
  const dir = mkdtempSync(join(tmpdir(), "datum-out-"));
  try {
    const values: Record<string, unknown> = { ...HOSTILE, nul: "a\u0000b\u0001\u007f\u0085", doc: [upload("resume (final.pdf")] };
    const form = formWith([...Object.keys(HOSTILE).map((id) => ({ id, type: "text", configuration: { label: id } })), ...fileForm.children!["content"]!]);
    const layout = deriveDefaultPdfLayout(form, {});
    const result = await ctx.provider.document(documentRequest(form, values, ctx.fonts, { layout: { ...layout, conformance: { pdfa: "3b", attachData: true, attachment: { name: "answers.json" } } } as never }));
    const file = join(dir, "doc.pdf");
    writeFileSync(file, result.bytes);
    const verdict = veraPdf(cli, file, "3b");
    if (!verdict.compliant) {
      return fail(`veraPDF 3b: not compliant (rules ${verdict.failed.join(", ") || "unreported"})`);
    }
    return pass("veraPDF 3b: compliant with hostile text and a parenthesis in an attachment name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mintIdentity(dir: string): { key: ReturnType<typeof createPrivateKey>; certificate: string } | undefined {
  try {
    execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(dir, "k.pem")], { stdio: "ignore", timeout: 20_000 });
    execFileSync("openssl", ["req", "-x509", "-new", "-key", join(dir, "k.pem"), "-sha256", "-days", "30", "-subj", "/CN=datum-security-suite", "-out", join(dir, "c.pem")], { stdio: "ignore", timeout: 20_000 });
    return { key: createPrivateKey(readFileSync(join(dir, "k.pem"), "utf8")), certificate: new X509Certificate(readFileSync(join(dir, "c.pem"), "utf8")).raw.toString("base64") };
  } catch {
    return undefined;
  }
}

/** OUT-12: a seal over a document of hostile text verifies, and the text under it is unchanged. */
export async function checkSealedSignature(ctx: CheckContext): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "datum-out-"));
  try {
    const identity = mintIdentity(dir);
    if (identity === undefined) {
      return skip("openssl is not available to mint a throwaway signing key");
    }
    const form = textForm(Object.keys(HOSTILE));
    const options = { certificates: [identity.certificate], certify: "noChanges", reason: "Archived" } as const;
    const prepared = await ctx.provider.document(documentRequest(form, HOSTILE, ctx.fonts, { signature: options as never }));
    if (prepared.signing === undefined) {
      return fail("the program returned no signing handoff for a document with a signature request");
    }
    const unsealedText = squash((await extractText(prepared.bytes)).join(" "));
    const value = bytesToBase64(new Uint8Array(nodeSign("sha256", Buffer.from(base64ToBytes(prepared.signing.toBeSigned)), { key: identity.key, dsaEncoding: "der" })));
    const sealed = await ctx.provider.complete(buildPdfCompleteRequest(prepared.bytes, { ...options, value, toBeSignedDigest: prepared.signing.toBeSignedDigest } as never));
    const verified = await ctx.provider.verify(buildPdfVerifyRequest(sealed.bytes));
    const report = verified.signatures[0];
    if (report === undefined || !report.digestMatches || !report.coversDocument) {
      return fail(`the program does not verify its own seal (digestMatches ${String(report?.digestMatches)}, coversDocument ${String(report?.coversDocument)})`);
    }
    // The host's independent check: the signature over the bytes the program says it covers.
    const publicKey = createPublicKey({ key: Buffer.from(base64ToBytes(report.signer!.publicKey)), format: "der", type: "spki" });
    if (!nodeVerify("sha256", Buffer.from(base64ToBytes(report.toBeVerified)), { key: publicKey, dsaEncoding: "der" }, Buffer.from(base64ToBytes(report.signature)))) {
      return fail("the signature value does not verify under the signer's public key");
    }
    const sealedText = squash((await extractText(sealed.bytes)).join(" "));
    if (sealedText !== unsealedText) {
      return fail("sealing changed the text layer");
    }
    const active = activeContent((await dumpPdf(sealed.bytes)).text);
    if (active.length > 0) {
      return fail(`the sealed file carries active keys: ${active.join(", ")}`);
    }
    return pass("sealed with a throwaway P-256 key: the program and an independent check agree; text and keys unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LONG_FORM = formWith([{ id: "ta", type: "textarea", configuration: { label: "Story" } }]);
const errorText = (error: unknown): string => `${(error as { code?: string })?.code ?? ""} ${error instanceof Error ? error.message : String(error)}`;

/** OUT-13: an answer past the layout's character cap is cut with a marker and a warning; a document past the page cap is refused, not rendered. */
export async function checkRenderCaps(ctx: CheckContext): Promise<Outcome> {
  const honest = await ctx.provider.document(documentRequest(LONG_FORM, { ta: "a short story" }, ctx.fonts));
  if (codes(honest).includes("render.truncated")) {
    return fail("render.truncated fired for a short answer");
  }
  const marker = "TAILMARK-PAST-THE-CAP";
  const long = `${"lorem ipsum ".repeat(5400)}${marker}`;
  const started = performance.now();
  const cut = await ctx.provider.document(documentRequest(LONG_FORM, { ta: long }, ctx.fonts));
  const took = Math.round(performance.now() - started);
  if (!codes(cut).includes("render.truncated")) {
    return fail(`a ${long.length}-character answer was drawn without a render.truncated warning (${JSON.stringify(codes(cut))})`);
  }
  const text = squash((await extractText(cut.bytes)).join(" "));
  if (text.includes(marker)) {
    return fail("the answer's tail past the 20,000-character cap is still in the text layer");
  }
  if (cut.pageCount >= 60) {
    return fail(`a ${long.length}-character answer made ${cut.pageCount} pages: the cap did not bound the render`);
  }
  const layout = { ...deriveDefaultPdfLayout(LONG_FORM, {}), limits: { answerChars: 100 } };
  const small = await ctx.provider.document(documentRequest(LONG_FORM, { ta: "word ".repeat(200) }, ctx.fonts, { layout: layout as never }));
  if (!codes(small).includes("render.truncated")) {
    return fail("a layout's limits.answerChars (100) was not honoured");
  }
  const paged = { ...deriveDefaultPdfLayout(LONG_FORM, {}), limits: { pages: 1, answerChars: 20_000 } };
  let refused: string | undefined;
  try {
    await ctx.provider.document(documentRequest(LONG_FORM, { ta: "word ".repeat(3000) }, ctx.fonts, { layout: paged as never }));
  } catch (error) {
    refused = errorText(error);
  }
  if (refused === undefined) {
    return fail("a document past the layout's page cap (1) was rendered instead of refused");
  }
  if (!/render_limit|render\.pageCap/.test(refused)) {
    return fail(`the page cap was refused as something else: ${refused.slice(0, 160)}`);
  }
  return pass(`a ${long.length}-character answer is cut with render.truncated in ${took} ms (${cut.pageCount} pages), the layout's answerChars is honoured, and a document past limits.pages is refused as render_limit`);
}

/** OUT-14: a file whose bytes pass its declared size are skipped as file.sizeMismatch, or refused under the fail policy. */
export async function checkSizeMismatch(ctx: CheckContext): Promise<Outcome> {
  const lying = (name: string, declared: number, bytes: number) => ({ ...upload(name, "application/octet-stream", ""), size: declared, data: Buffer.alloc(bytes, 7).toString("base64") });
  const layout = deriveDefaultPdfLayout(fileForm, {});
  const honest = await ctx.provider.document(documentRequest(fileForm, { doc: [lying("honest.bin", 4000, 4096)] }, ctx.fonts, { layout: layout as never }));
  if ((await pdfjsAttachments(honest.bytes)).length !== 1 || codes(honest).includes("file.sizeMismatch")) {
    return fail("a file within the tolerance (4,000 declared, 4,096 carried) was not embedded as honest");
  }
  const zero = await ctx.provider.document(documentRequest(fileForm, { doc: [lying("zero.bin", 0, 20_000)] }, ctx.fonts, { layout: layout as never }));
  const small = await ctx.provider.document(documentRequest(fileForm, { doc: [lying("small.bin", 100, 4096)] }, ctx.fonts, { layout: layout as never }));
  for (const [label, result] of [["declared 0, carrying 20,000", zero], ["declared 100, carrying 4,096", small]] as const) {
    const embedded = await pdfjsAttachments(result.bytes);
    if (embedded.length > 0) {
      return fail(`a file ${label} bytes was embedded (${embedded.join(", ")})`);
    }
    if (!codes(result).includes("file.sizeMismatch")) {
      return fail(`a file ${label} bytes was dropped without file.sizeMismatch: warnings ${JSON.stringify(codes(result))}`);
    }
  }
  const strict = { ...layout, attachments: { onExceeded: "fail" } };
  let refused: string | undefined;
  try {
    await ctx.provider.document(documentRequest(fileForm, { doc: [lying("zero.bin", 0, 20_000)] }, ctx.fonts, { layout: strict as never }));
  } catch (error) {
    refused = errorText(error);
  }
  if (refused === undefined || !/sizeMismatch/.test(refused)) {
    return fail(`under onExceeded "fail" the lie was ${refused === undefined ? "rendered" : `refused as something else: ${refused.slice(0, 160)}`}`);
  }
  return pass("bytes past the declared size by more than 1% + 1 KiB are skipped as file.sizeMismatch (refused under onExceeded fail); a 4,096-byte file declared 4,000 is embedded");
}

/** OUT-15: executable, script and HTML attachments are refused by claimed type and by magic bytes. */
export async function checkRefusedTypes(ctx: CheckContext): Promise<Outcome> {
  const layout = deriveDefaultPdfLayout(fileForm, {});
  const bytes = (body: number[]): string => Buffer.from([...body, 0, 0, 0, 0]).toString("base64");
  const claimed = (name: string, type: string, body = "x"): Record<string, unknown> => upload(name, type, body);
  const sniffed = (name: string, type: string, data: string): Record<string, unknown> => ({ storage: "base64", name, type, size: Buffer.from(data, "base64").length, data });
  // A DOS header whose e_lfanew (offset 0x3C) points at "PE\0\0": what a Windows executable starts with. A text that only starts "MZ" is not one.
  const pe = Buffer.alloc(0x48);
  pe.write("MZ", 0, "latin1");
  pe.writeUInt32LE(0x40, 0x3c);
  pe.write("PE\0\0", 0x40, "latin1");
  const refusals: Array<[string, Record<string, unknown>]> = [
    ["a Windows executable by type", claimed("a.exe", "application/x-msdownload")],
    ["a script by type", claimed("a.js", "application/javascript")],
    ["an HTML page by type", claimed("a.html", "text/html", "<p>x</p>")],
    ["a shell script by type", claimed("a.sh", "application/x-sh")],
    ["a PE file called text/plain", sniffed("note.txt", "text/plain", pe.toString("base64"))],
    ["an ELF file called text/plain", sniffed("note.txt", "text/plain", bytes([0x7f, 0x45, 0x4c, 0x46]))],
    ["a Mach-O file called text/plain", sniffed("note.txt", "text/plain", bytes([0xcf, 0xfa, 0xed, 0xfe]))],
    ["a shebang script called text/plain", claimed("note.txt", "text/plain", "#!/bin/sh\necho hi")],
    ["HTML called text/plain", claimed("note.txt", "text/plain", "<!DOCTYPE html><script>alert(1)</script>")],
    ["SVG with a script called image/png", claimed("pic.png", "image/png", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')]
  ];
  const control = await ctx.provider.document(documentRequest(fileForm, { doc: [claimed("ok.txt", "text/plain", "plain words"), claimed("ok.pdf", "application/pdf", "%PDF-1.7 plain")] }, ctx.fonts, { layout: layout as never }));
  if ((await pdfjsAttachments(control.bytes)).length !== 2 || codes(control).includes("attachment.refusedType")) {
    return fail("honest text and PDF attachments were not both embedded (the check would prove nothing)");
  }
  for (const [label, file] of refusals) {
    const result = await ctx.provider.document(documentRequest(fileForm, { doc: [file] }, ctx.fonts, { layout: layout as never }));
    const embedded = await pdfjsAttachments(result.bytes);
    if (embedded.length > 0) {
      return fail(`${label} was embedded (${embedded.join(", ")})`);
    }
    if (!codes(result).includes("attachment.refusedType")) {
      return fail(`${label} was dropped without attachment.refusedType: warnings ${JSON.stringify(codes(result))}`);
    }
  }
  const strict = { ...layout, attachments: { onExceeded: "fail" } };
  let refused: string | undefined;
  try {
    await ctx.provider.document(documentRequest(fileForm, { doc: [claimed("a.exe", "application/x-msdownload")] }, ctx.fonts, { layout: strict as never }));
  } catch (error) {
    refused = errorText(error);
  }
  if (refused === undefined || !/refusedType/.test(refused)) {
    return fail(`under onExceeded "fail" an executable was ${refused === undefined ? "rendered" : `refused as something else: ${refused.slice(0, 160)}`}`);
  }
  return pass(`${refusals.length} kinds of executable, script and HTML attachment are skipped with attachment.refusedType (refused under onExceeded fail); honest text and PDF files are embedded`);
}
