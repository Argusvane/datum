/**
 * The program's entry: one request in, one response out, by operation. Bundled
 * by `scripts/build-program.mjs` into `dist/datum-pdf.program.js`, where `installProgramGlobals`
 * runs and exposes `globalThis.__datum_pdf` (string in, string out) and
 * `globalThis.__datum_pdf_register` (a plugin module's `pdfRenditions` and `functions`). In-process
 * hosts import `handlePdfRequest` directly and skip the strings.
 */
import {
  PDF_ABI_VERSION,
  PdfKernelError,
  base64ToBytes,
  bytesToBase64,
  createPdfRenditionResolver,
  pdfAbiCompatible,
  type PdfFormulaFunctions,
  type PdfDocumentAttachment,
  type PdfDocumentConformance,
  type PdfDocumentRequest,
  type PdfFontResource,
  type PdfKernelEnv,
  type PdfKernelRequest,
  type PdfKernelResponse,
  type PdfRenderModel,
  type PdfRenderOptions,
  type PdfRenditionResolver,
  type PdfSignatureSettings,
  type PdfSignatureSpec,
  type PdfSigningHandoff,
  type PdfWarning
} from "@argusvane/datum-engine/render";
import { PdfRenditionRegistry } from "@argusvane/datum-engine/registry";
import { FORMULA_FUNCTION_NAMES, findPdfLayout, kernelStableStringify } from "@argusvane/datum-engine";
import { buildFromInputs } from "../model/build-document.js";
import { layoutOnly, renderDocument } from "../kernel/render.js";
import { completeSignature, prepareSignature, timestampRequestFor } from "../kernel/signature/sign.js";
import { verifySignatures } from "../kernel/signature/verify.js";
import { fillTemplate, inspectTemplate } from "../kernel/template.js";
import { installPdfProgramPolyfills } from "./polyfills.js";

export const PDF_PROGRAM_VERSION = "0.1.0";


const pluginRenditions = new PdfRenditionRegistry();
let resolver: PdfRenditionResolver | undefined;

/**
 * The formula functions plugin modules registered: pure functions of their
 * arguments, handed to every rule context the program evaluates. A name is taken once, and
 * never one of the built-ins.
 */
const pluginFunctions: PdfFormulaFunctions = {};

/** The registered plugin functions, or `undefined` while there are none (a context with no registry). */
function formulaFunctions(): PdfFormulaFunctions | undefined {
  return Object.keys(pluginFunctions).length > 0 ? pluginFunctions : undefined;
}

function renditions(): PdfRenditionResolver {
  resolver ??= createPdfRenditionResolver({ renditions: pluginRenditions });
  return resolver;
}

/**
 * Registers a plugin module's `pdfRenditions` and `functions` (the module's reserved
 * keys). Returns how many of both. A function's name must be a plain identifier that no
 * built-in or earlier module took; a collision throws rather than shadowing silently.
 */
export function registerPdfProgramModule(module: unknown): number {
  if (!module || typeof module !== "object") {
    throw new Error("pdf program module must be an object");
  }
  const functions = (module as { functions?: unknown }).functions;
  let registered = 0;
  if (functions !== undefined) {
    if (!isRecord(functions)) {
      throw new Error("pdf program module 'functions' must be an object of name to function");
    }
    for (const [name, fn] of Object.entries(functions)) {
      if (typeof fn !== "function") {
        throw new Error(`functions entry "${name}" must be a function`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`functions entry "${name}" is not a plain identifier`);
      }
      if (FORMULA_FUNCTION_NAMES.has(name)) {
        throw new Error(`functions entry "${name}" collides with a built-in formula function`);
      }
      if (Object.prototype.hasOwnProperty.call(pluginFunctions, name)) {
        throw new Error(`functions entry "${name}" collides with a function another module registered`);
      }
      pluginFunctions[name] = fn as (args: unknown[]) => unknown;
      registered += 1;
    }
  }
  const list = (module as { pdfRenditions?: unknown }).pdfRenditions;
  if (list === undefined) {
    return registered;
  }
  if (!Array.isArray(list)) {
    throw new Error("pdf program module 'pdfRenditions' must be an array");
  }
  for (const entry of list) {
    const contribution = entry as { componentType?: unknown; id?: unknown; label?: unknown; render?: unknown };
    if (typeof contribution.componentType !== "string" || typeof contribution.id !== "string" || typeof contribution.render !== "function") {
      throw new Error("each pdfRenditions entry needs componentType, id and render");
    }
    pluginRenditions.register({
      componentType: contribution.componentType,
      rendition: {
        id: contribution.id,
        ...(typeof contribution.label === "string" ? { label: contribution.label } : {}),
        render: contribution.render as (node: unknown, context: unknown) => unknown
      }
    });
  }
  resolver = undefined;
  return registered + list.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validate(request: unknown): PdfKernelRequest {
  if (!isRecord(request)) {
    throw new PdfKernelError("invalid_request", "The request must be an object");
  }
  if (typeof request.abi !== "string") {
    throw new PdfKernelError("invalid_request", "The request names no abi version");
  }
  if (!pdfAbiCompatible(PDF_ABI_VERSION, request.abi)) {
    throw new PdfKernelError("abi_mismatch", `The request speaks PDF ABI ${request.abi}; this program speaks ${PDF_ABI_VERSION} and answers only its own major`);
  }
  if (typeof request.op !== "string") {
    throw new PdfKernelError("invalid_request", "The request names no op");
  }
  return request as unknown as PdfKernelRequest;
}

/** The archival profile a template fill carries once `options.pdfa` is applied — the same rule the render path uses. */
function fillConformance(conformance: PdfDocumentConformance | undefined, options: PdfRenderOptions | undefined): PdfDocumentConformance | undefined {
  if (options?.pdfa === false) {
    return undefined;
  }
  if (options?.pdfa) {
    return { ...(conformance ?? {}), pdfa: options.pdfa };
  }
  return conformance;
}

/**
 * The signature to prepare, if any: the layout's settings are the defaults, the
 * request's keys override them, and the certificates come from the request alone. A layout
 * that asks for a signature the request cannot supply is a warning — or, when the layout
 * says `required`, a refusal.
 */
function signatureToPrepare(layout: PdfSignatureSettings | undefined, requested: PdfSignatureSpec | undefined, warnings: PdfWarning[]): PdfSignatureSpec | undefined {
  const certificates = isRecord(requested) && Array.isArray(requested.certificates) && requested.certificates.length > 0 ? requested.certificates : undefined;
  if (certificates) {
    return { ...(layout ?? {}), ...requested, certificates };
  }
  if (layout) {
    if (layout.required) {
      throw new PdfKernelError("signature", "The layout requires the document to be signed, and the request carries no certificates");
    }
    warnings.push({ code: "signature.noCertificates", message: "The layout declares signature settings, but the request carries no certificates; the document is unsigned." });
  }
  return undefined;
}

/** Runs the prepare step over freshly produced bytes, for the render ops that carry `signature`. */
async function signProduced(
  bytes: Uint8Array,
  spec: PdfSignatureSpec | undefined,
  fonts: readonly PdfFontResource[],
  env: PdfKernelEnv,
  warnings: PdfWarning[]
): Promise<{ bytes: Uint8Array; signing?: PdfSigningHandoff }> {
  if (!spec) {
    return { bytes };
  }
  const prepared = await prepareSignature(bytes, spec, fonts, env);
  warnings.push(...prepared.warnings);
  return { bytes: prepared.bytes, signing: prepared.signing };
}

function requirePdf(value: unknown, op: string): Uint8Array {
  if (!isRecord(value) || typeof value.data !== "string" || value.data === "") {
    throw new PdfKernelError("invalid_request", `${op} needs pdf.data`);
  }
  return base64ToBytes(value.data);
}

/** How many known certificates a verify request may carry, and how large each may be. */
const MAX_KNOWN_CERTIFICATES = 64;
const MAX_KNOWN_CERTIFICATE_BYTES = 16 * 1024;

/** The verify request's `knownCertificates`: base64 strings, each one DER certificate. */
function knownCertificatesOf(value: unknown): Uint8Array[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new PdfKernelError("invalid_request", "verify knownCertificates must be an array of base64 certificates");
  }
  if (value.length > MAX_KNOWN_CERTIFICATES) {
    throw new PdfKernelError("invalid_request", `verify knownCertificates carries ${value.length} certificates; at most ${MAX_KNOWN_CERTIFICATES} are read`);
  }
  // Base64 is four characters for three bytes: refuse a far oversized one before decoding it, the rest after.
  const tooLarge = (): never => {
    throw new PdfKernelError("invalid_request", `verify knownCertificates holds a certificate over ${MAX_KNOWN_CERTIFICATE_BYTES} bytes`);
  };
  if (value.some((entry) => (entry as string).length > Math.ceil(MAX_KNOWN_CERTIFICATE_BYTES / 3) * 4 + 4)) {
    tooLarge();
  }
  const certificates = value.map((entry) => base64ToBytes(entry as string));
  if (certificates.some((certificate) => certificate.length > MAX_KNOWN_CERTIFICATE_BYTES)) {
    tooLarge();
  }
  return certificates;
}

function requireDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.blocks) || !isRecord(value.page) || !isRecord(value.metadata)) {
    throw new PdfKernelError("invalid_request", "The request carries no document");
  }
}

/**
 * Refuses template bytes sent for a layout the host did not name and a condition chose. A host
 * may resolve the template bytes of the layout printed when no condition
 * holds up front and send them unasked; the answers may choose another template layout, and its fill plan
 * (field names, areas, pages) applied to those bytes would fill the wrong PDF silently, with
 * only "missing" field reports to show for it. Refused only where that can happen: bytes came
 * with the request, a condition chose (so no `layoutId` or `layout` named the layout), and the
 * layout it chose is a template other than the one printed when no condition holds. A generated
 * layout uses no bytes; the very layout the host assumed is filled right.
 */
function refuseUnaskedTemplate(request: PdfDocumentRequest, model: PdfRenderModel): void {
  if (!model.fill || typeof request.template?.data !== "string" || model.layoutChoice !== "condition") {
    return;
  }
  const assumed = findPdfLayout({ pdf: request.pdf })?.id;
  if (assumed === model.layoutId) {
    return;
  }
  throw new PdfKernelError(
    "template",
    `A condition chose template layout "${model.layoutId}", and the request carries template bytes without naming the layout they are for` +
      `${assumed !== undefined ? ` (when no condition holds, "${assumed}" prints)` : ""}: send "layoutId": "${model.layoutId}" with that layout's bytes; the "build" op names the layout first`
  );
}

/** Which layout a `document` printed and how it was chosen, for a host that named none. */
function layoutReply(model: PdfRenderModel): { layoutId: string; layoutKind: PdfRenderModel["layoutKind"]; layoutChoice: PdfRenderModel["layoutChoice"] } {
  return { layoutId: model.layoutId, layoutKind: model.layoutKind, layoutChoice: model.layoutChoice };
}

export async function handlePdfRequest(raw: unknown): Promise<PdfKernelResponse> {
  try {
    // Every request is handled in its ABI-canonical form, in-process included: key order is
    // observable (a fill report lists fields in request order), and a host that skips the
    // JSON boundary must still get the bytes a sandboxed host gets.
    const request = validate(JSON.parse(kernelStableStringify(raw)));
    switch (request.op) {
      case "capabilities":
        return { ok: true, op: "capabilities", abi: PDF_ABI_VERSION, kernelVersion: PDF_PROGRAM_VERSION };
      case "build": {
        const model = await buildFromInputs(request, renditions(), formulaFunctions());
        return {
          ok: true,
          op: "build",
          layoutId: model.layoutId,
          layoutKind: model.layoutKind,
          layoutChoice: model.layoutChoice,
          ...(model.document ? { document: model.document } : {}),
          ...(model.fill ? { fill: model.fill } : {}),
          warnings: model.warnings
        };
      }
      case "document": {
        const model = await buildFromInputs(request, renditions(), formulaFunctions());
        refuseUnaskedTemplate(request, model);
        if (model.fill) {
          const template = request.template?.data ?? (model.fill.template.storage === "base64" ? model.fill.template.data : undefined);
          if (typeof template !== "string") {
            // A layout the answers chose is one the host could not know to resolve ahead.
            const chosen = model.layoutChoice === "condition" ? `; its condition chose it, so send "layoutId": "${model.layoutId}" with them (the "build" op names the layout first)` : "";
            throw new PdfKernelError("template", `Template layout "${model.layoutId}" needs its bytes: resolve the template and send it in the request${chosen}`);
          }
          const filled = await fillTemplate(
            base64ToBytes(template),
            model.fill.values,
            model.fill.options,
            request.fonts,
            request.env,
            model.fill.areas ?? [],
            fillConformance(model.fill.conformance, request.options),
            model.fill.attachments,
            { typography: model.fill.typography, colors: model.fill.colors }
          );
          const warnings = [...model.warnings, ...filled.warnings];
          const signed = await signProduced(filled.bytes, signatureToPrepare(model.fill.signature, request.signature, warnings), request.fonts, request.env, warnings);
          return {
            ok: true,
            op: "document",
            ...layoutReply(model),
            bytes: bytesToBase64(signed.bytes),
            pageCount: filled.pageCount,
            pages: [],
            fields: filled.fields,
            areas: filled.areas,
            warnings,
            ...(filled.pdfa ? { pdfa: filled.pdfa } : {}),
            ...(filled.attachments ? { attachments: filled.attachments } : {}),
            ...(signed.signing ? { signing: signed.signing } : {})
          };
        }
        const rendered = await renderDocument(model.document!, request.fonts, request.env, request.options ?? {});
        const warnings = [...model.warnings, ...rendered.warnings];
        const signed = await signProduced(rendered.bytes, signatureToPrepare(model.document!.signature, request.signature, warnings), request.fonts, request.env, warnings);
        return {
          ok: true,
          op: "document",
          ...layoutReply(model),
          bytes: bytesToBase64(signed.bytes),
          pageCount: rendered.pages.length,
          pages: rendered.pages,
          warnings,
          ...(rendered.pdfa ? { pdfa: rendered.pdfa } : {}),
          ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
          ...(signed.signing ? { signing: signed.signing } : {})
        };
      }
      case "render": {
        requireDocument(request.document);
        const rendered = await renderDocument(request.document, request.fonts ?? [], request.env, request.options ?? {});
        const warnings = [...rendered.warnings];
        const signed = await signProduced(rendered.bytes, signatureToPrepare(request.document.signature as PdfSignatureSettings | undefined, request.signature, warnings), request.fonts ?? [], request.env, warnings);
        return {
          ok: true,
          op: "render",
          bytes: bytesToBase64(signed.bytes),
          pageCount: rendered.pages.length,
          pages: rendered.pages,
          warnings,
          ...(rendered.pdfa ? { pdfa: rendered.pdfa } : {}),
          ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
          ...(signed.signing ? { signing: signed.signing } : {})
        };
      }
      case "layout": {
        requireDocument(request.document);
        const laid = await layoutOnly(request.document, request.fonts ?? []);
        return { ok: true, op: "layout", pages: laid.pages, warnings: laid.warnings };
      }
      case "fill": {
        if (!isRecord(request.template) || typeof request.template.data !== "string") {
          throw new PdfKernelError("invalid_request", "fill needs template.data");
        }
        const filled = await fillTemplate(
          base64ToBytes(request.template.data),
          request.values ?? {},
          request.options,
          request.fonts ?? [],
          request.env,
          Array.isArray(request.areas) ? request.areas : [],
          isRecord(request.conformance) ? (request.conformance as PdfDocumentConformance) : undefined,
          Array.isArray(request.attachments) ? (request.attachments as PdfDocumentAttachment[]) : undefined,
          { typography: isRecord(request.typography) ? request.typography : undefined, colors: isRecord(request.colors) ? request.colors : undefined }
        );
        const warnings = [...filled.warnings];
        const signed = await signProduced(filled.bytes, signatureToPrepare(undefined, request.signature, warnings), request.fonts ?? [], request.env, warnings);
        return {
          ok: true,
          op: "fill",
          bytes: bytesToBase64(signed.bytes),
          pageCount: filled.pageCount,
          fields: filled.fields,
          areas: filled.areas,
          warnings,
          ...(filled.pdfa ? { pdfa: filled.pdfa } : {}),
          ...(filled.attachments ? { attachments: filled.attachments } : {}),
          ...(signed.signing ? { signing: signed.signing } : {})
        };
      }
      case "inspect": {
        if (!isRecord(request.template) || typeof request.template.data !== "string") {
          throw new PdfKernelError("invalid_request", "inspect needs template.data");
        }
        const attachments = request.attachments === "digest" || request.attachments === "data" ? request.attachments : undefined;
        return { ok: true, op: "inspect", info: await inspectTemplate(base64ToBytes(request.template.data), attachments ? { attachments } : {}) };
      }
      case "sign": {
        const bytes = requirePdf(request.pdf, "sign");
        if (!isRecord(request.signature)) {
          throw new PdfKernelError("invalid_request", "sign needs signature.certificates");
        }
        if (!isRecord(request.env) || typeof request.env.createdAt !== "string") {
          throw new PdfKernelError("invalid_request", "sign needs env.createdAt");
        }
        const prepared = await prepareSignature(bytes, request.signature, Array.isArray(request.fonts) ? request.fonts : [], request.env);
        return { ok: true, op: "sign", bytes: bytesToBase64(prepared.bytes), signing: prepared.signing, warnings: prepared.warnings };
      }
      case "complete": {
        const bytes = requirePdf(request.pdf, "complete");
        if (!isRecord(request.signing)) {
          throw new PdfKernelError("invalid_request", "complete needs a signing block: the certificates, the value, and the settings the signature was prepared with");
        }
        const completed = await completeSignature(bytes, request.signing);
        return { ok: true, op: "complete", bytes: bytesToBase64(completed.bytes), field: completed.field, cms: bytesToBase64(completed.cms), timestamped: completed.timestamped };
      }
      case "timestampRequest": {
        if (typeof request.signature !== "string" || request.signature === "") {
          throw new PdfKernelError("invalid_request", "timestampRequest needs the signature value (base64)");
        }
        return { ok: true, op: "timestampRequest", request: bytesToBase64(timestampRequestFor(base64ToBytes(request.signature))) };
      }
      case "verify": {
        const verified = await verifySignatures(requirePdf(request.pdf, "verify"), { knownCertificates: knownCertificatesOf(request.knownCertificates) });
        return { ok: true, op: "verify", signatures: verified.signatures, attachments: verified.attachments, warnings: verified.warnings, documentId: verified.documentId };
      }
      default:
        throw new PdfKernelError("invalid_request", `Unknown op "${(request as { op: string }).op}"`);
    }
  } catch (error) {
    if (error instanceof PdfKernelError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: { code: "internal", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) } };
  }
}

/** String in, ABI-canonical string out — what a sandbox host calls. */
export async function handlePdfRequestJson(json: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return kernelStableStringify({ ok: false, error: { code: "invalid_request", message: "The request is not JSON" } });
  }
  return kernelStableStringify(await handlePdfRequest(parsed));
}

/** Installs the polyfills and the program's globals; the bundled program calls this once. */
export function installProgramGlobals(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  installPdfProgramPolyfills(scope);
  scope.__datum_pdf = handlePdfRequestJson;
  scope.__datum_pdf_register = registerPdfProgramModule;
  scope.__datum_pdf_abi = PDF_ABI_VERSION;
}
