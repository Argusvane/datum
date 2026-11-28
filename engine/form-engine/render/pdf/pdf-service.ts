/**
 * From a running form to PDF bytes: build the render model for `mode: "pdf"`,
 * gather what the kernel cannot fetch itself (fonts, template bytes, images by URL), and hand
 * the provider one request. A host calls this once it has a provider; the renderer element's
 * `renderPdf()` is this over its own runtime.
 */
import type { FormulaErrorPolicy } from "../../core/expressions/expression.js";
import { supportedLocaleCodes } from "../../core/localization/supported-locales.js";
import { MAX_PDF_TEMPLATE_BYTES, PDF_BUILTIN_ASSET_STORAGE, type PdfAttachmentPolicyOptions, type PdfLayoutDocument } from "../../core/schema/pdf-layout.js";
import { buildRuntimeRenderOutput, type RenderableRuntime } from "../core/runtime-render-bridge.js";
import { localCalendarDate } from "../../runtime/browser/form-runtime.js";
import { FormEventType } from "../../core/events/event-types.js";
import { PDF_ABI_VERSION, pdfAbiCompatible, PdfKernelError, type PdfAreaReport, type PdfFillReport, type PdfRenderOptions, type PdfSignatureAlgorithm, type PdfSignatureCommitment, type PdfUnknownComponentPolicy } from "./pdf-abi.js";
import { isResolvedPdfAttachment, type PdfDocument, type PdfDocumentAttachment, type PdfDocumentConformance, type PdfWarning } from "./pdf-document.js";
import {
  BASE64_TEMPLATE_RESOLVER,
  DEFAULT_PDF_ENVIRONMENT,
  NO_PDF_FONTS,
  base64ToBytes,
  buildPdfCompleteRequest,
  buildPdfFillRequest,
  buildPdfRenderRequest,
  buildPdfTimestampRequest,
  bytesToBase64,
  pdfFillFontNeed,
  pdfFontNeed,
  pdfKernelEnv,
  pdfSignatureSpec,
  type PdfEnvironment,
  type PdfFontProvider,
  type PdfImageResolver,
  type PdfRenderProvider,
  type PdfRenderResult,
  type PdfSigner,
  type PdfTemplateResolver,
  type PdfTimestamper
} from "./pdf-provider.js";
import type { PdfSignatureRequestSettings } from "./pdf-signer.js";
import { registerPdfRenderMode } from "./pdf-render-mode.js";
import { pdfThemeLookup, type PdfBindingSuggestion, type PdfThemeDefinition, type PdfThemeSource } from "./pdf-theme.js";
import type { PdfRenderModel } from "./pdf-render-model.js";
import { createPdfRenditionResolver, type PdfRenditionResolver } from "./pdf-renditions.js";

export interface PdfServiceDependencies {
  provider: PdfRenderProvider;
  fonts?: PdfFontProvider | undefined;
  templates?: PdfTemplateResolver | undefined;
  images?: PdfImageResolver | undefined;
  environment?: PdfEnvironment | undefined;
  /** The host's default PDF theme (`target: "pdf"`), for a layout that names none. */
  theme?: PdfThemeDefinition | undefined;
  /**
   * The binding the form is drawn by and the PDF theme it suggests. When neither the call, the
   * layout nor `theme` names a PDF theme, the document prints under the suggestion: an id
   * `themes` holds, or the theme itself. The renderer element passes its own binding's here, and
   * a server host the catalog's entry for the binding id it serves the form with.
   */
  binding?: PdfBindingSuggestion | undefined;
  /**
   * Where a theme named by id — a layout's `theme`, the call's `themeId` — is looked up:
   * typically the host's `PdfThemeRegistry`, or a lookup function. Absent, every id is unknown and warns.
   */
  themes?: PdfThemeSource | undefined;
  /**
   * Where a component's renditions are looked up. Absent, one is built from the runtime's own
   * registries (`RenderableRuntime.pdfRenditionSources`: the component definitions and the
   * plugins' contributions), so a definition's `pdf` block prints without any wiring.
   */
  renditions?: PdfRenditionResolver | undefined;
}

export interface RenderFormPdfOptions {
  /**
   * The layout to render, by id: it wins over every layout's `when`. Absent, the form chooses:
   * the first layout whose condition holds on the answers as they would be
   * submitted, else its default, else its first.
   */
  layoutId?: string | undefined;
  /** Render under this registered PDF theme, whatever the layout says. */
  themeId?: string | undefined;
  /** A layout to render instead of one the definition declares; no condition is tried. */
  layout?: PdfLayoutDocument | undefined;
  fileName?: string | undefined;
  render?: PdfRenderOptions | undefined;
  hostContext?: Record<string, unknown> | undefined;
  /**
   * The locale to render in, instead of the form's current one — the way one submission
   * becomes an English and a French PDF without switching the live form. Every label, option
   * caption, layout text, the document's `/Lang` and its text direction follow it, through the
   * same translation catalog the form uses. Refused, as `FormRuntime.setLocale` refuses it,
   * when the form declares locales and this is not one of them. The default file name carries
   * the locale asked for (`<form>-<layout>-<locale>-<stamp>.pdf`).
   */
  locale?: string | undefined;
  /**
   * What to do with a bound component whose type offers no PDF rendition: draw it
   * generically and say nothing, warn `component.unknown` (the default), or reject with a
   * `PdfKernelError` whose code is `unknown_component`.
   */
  unknownComponents?: PdfUnknownComponentPolicy | undefined;
  /**
   * The budget for the uploaded files the document embeds, over the layout's own:
   * how many bytes in total, and whether an overflow skips the rest (`attachment.skipped`) or
   * refuses the document (`PdfKernelError`, code `attachment_budget`).
   */
  attachments?: PdfAttachmentPolicyOptions | undefined;
  /**
   * The calendar day (`YYYY-MM-DD`) the PDF's rules read through `today()`: a layout's
   * `when`, a field's visibility, an expression source. Default: the runtime's own day when it
   * exposes one (`today()`, the snapshot its rules computed with), else the local calendar date.
   */
  today?: string | undefined;
  /**
   * What to do with a rule the parser rejects (formulas): `fail` (the default)
   * rejects with a `PdfKernelError` whose code is `formula_invalid`; `warn`, the explicit
   * opt-in, drops it and reports `formula.invalid`. Over the form's own
   * `configuration.formulaErrors`.
   */
  formulaErrors?: FormulaErrorPolicy | undefined;
  /** `"refuse"` (the default) or `"allow"`: a `matches` pattern of a catastrophic shape in a layout formula (see `PdfDocumentInputs.riskyPatterns`). */
  riskyPatterns?: "refuse" | "allow" | undefined;
  /**
   * Sign the document: the kernel prepares the signature over the layout's
   * settings (these `settings` over them), the `signer` signs what it hands back, the kernel
   * embeds it — and, with a `timestamper`, an RFC 3161 token over the signature. Refused,
   * never silently unsigned: a provider without `complete`, or one that prepares no
   * signature, throws `PdfKernelError` with code `signature`.
   */
  signature?: { signer: PdfSigner; settings?: PdfSignatureRequestSettings | undefined; timestamper?: PdfTimestamper | undefined } | undefined;
}

/** What was signed, for the caller and the `PDF_SIGNED` event. */
export interface RenderFormPdfSignature {
  field: string;
  algorithm: PdfSignatureAlgorithm;
  subFilter: string;
  certificates: string[];
  timestamped: boolean;
  /** The signed commitment-type attribute the request asked for. */
  commitment?: PdfSignatureCommitment;
}

export interface RenderFormPdfResult extends PdfRenderResult {
  layoutId: string;
  /** The id of the PDF theme the document rendered under. */
  themeId: string;
  layoutKind: PdfRenderModel["layoutKind"];
  /** How the layout was chosen: `condition` when a layout's `when` held on the answers. */
  layoutChoice: PdfRenderModel["layoutChoice"];
  fileName: string;
  /** For a template layout: what happened to each mapped field. */
  fields?: PdfFillReport[];
  /** For a template layout with areas: what happened to each. */
  areas?: PdfAreaReport[];
  /** The document that was rendered, for a host that wants to inspect or cache it. */
  document?: PdfDocument;
  /** Present when the call asked for a signature: the file is signed. */
  signature?: RenderFormPdfSignature;
}

/** The day the PDF's rules read: the call's, else the runtime's (`RenderableRuntime.today`), else the local date. */
function pdfToday(runtime: RenderableRuntime, options: RenderFormPdfOptions): string {
  if (options.today !== undefined) {
    return options.today;
  }
  const fromRuntime = runtime.today?.();
  return fromRuntime !== undefined && fromRuntime !== "" ? fromRuntime : localCalendarDate(new Date());
}

/**
 * `<form id>-<layout id>-<stamp>.pdf`, the stamp being the environment's instant with the
 * punctuation removed; with a `locale`, `<form id>-<layout id>-<locale>-<stamp>.pdf`, so two
 * renderings of one submission in two languages are told apart by name.
 */
export function pdfFileName(formId: string, layoutId: string, createdAt: string, locale?: string): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/(\.\d+)?Z?$/, "").replace("T", "-");
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "_");
  const tag = locale !== undefined && locale !== "" ? `-${safe(locale)}` : "";
  return `${safe(formId)}-${safe(layoutId)}${tag}-${stamp}.pdf`;
}

/**
 * Swaps every image the layout named by URL for its bytes, through the host's resolver. An
 * image the resolver cannot supply stays a URL, which the kernel skips with a warning; the
 * document is never lost to a missing logo.
 */
export async function resolvePdfImages(document: PdfDocument, images: PdfImageResolver | undefined): Promise<PdfWarning[]> {
  const warnings: PdfWarning[] = [];
  for (const [id, resource] of Object.entries(document.resources.images)) {
    if (!("url" in resource)) {
      continue;
    }
    if (!images) {
      warnings.push({ code: "image.unresolved", message: `Image "${resource.url}" was not resolved: no image resolver.` });
      continue;
    }
    try {
      const resolved = await images.resolve(resource.url);
      if (resolved) {
        document.resources.images[id] = resolved;
      } else {
        warnings.push({ code: "image.unresolved", message: `Image "${resource.url}" was not resolved.` });
      }
    } catch (error) {
      warnings.push({
        code: "image.unresolved",
        message: `Image "${resource.url}" could not be fetched: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  return warnings;
}

/**
 * Swaps an output intent's profile envelope for its bytes, through the host's template (asset)
 * resolver. A profile the resolver cannot supply is dropped with a warning: the kernel then
 * declares its sRGB default, a conformant file under a different condition, never a false claim.
 */
export async function resolvePdfOutputIntent(conformance: PdfDocumentConformance | undefined, templates: PdfTemplateResolver | undefined): Promise<PdfWarning[]> {
  const intent = conformance?.outputIntent;
  if (!intent || !("source" in intent.profile)) {
    return [];
  }
  const source = intent.profile.source;
  if (source.storage === PDF_BUILTIN_ASSET_STORAGE) {
    // The kernel carries these: nothing to fetch, and the same bytes on every host.
    return [];
  }
  try {
    const bytes = await (templates ?? BASE64_TEMPLATE_RESOLVER).resolve(source);
    intent.profile = { data: bytesToBase64(bytes) };
    return [];
  } catch (error) {
    delete conformance!.outputIntent;
    return [
      {
        code: "pdfa.outputIntent",
        message: `The output intent profile "${source.name}" could not be resolved (${error instanceof Error ? error.message : String(error)}); the document declares sRGB instead.`
      }
    ];
  }
}

/**
 * Swaps every uploaded file a host storage keeps for its bytes, through the host's template
 * (asset) resolver — the envelope is the one a template or an ICC profile travels in. A file
 * the resolver cannot supply is dropped with a warning: the document is never lost to one
 * attachment, and the program could not have fetched it either way.
 */
export async function resolvePdfAttachments(attachments: PdfDocumentAttachment[] | undefined, templates: PdfTemplateResolver | undefined): Promise<PdfWarning[]> {
  const warnings: PdfWarning[] = [];
  if (!attachments) {
    return warnings;
  }
  for (let index = attachments.length - 1; index >= 0; index -= 1) {
    const attachment = attachments[index]!;
    if (isResolvedPdfAttachment(attachment)) {
      continue;
    }
    try {
      const bytes = await (templates ?? BASE64_TEMPLATE_RESOLVER).resolve(attachment.source);
      const { source: _source, ...rest } = attachment;
      attachments[index] = { ...rest, data: bytesToBase64(bytes) };
    } catch (error) {
      attachments.splice(index, 1);
      warnings.push({
        code: "attachment.unresolved",
        message: `The uploaded file "${attachment.name}" (storage "${attachment.source.storage}") could not be resolved (${error instanceof Error ? error.message : String(error)}); it was not attached.`,
        componentId: attachment.componentId
      });
    }
  }
  return warnings;
}

/** The archival profile a fill request carries once the per-render override is applied (the kernel reads `options.pdfa` only on render). */
function fillConformance(conformance: PdfDocumentConformance | undefined, render: PdfRenderOptions | undefined): PdfDocumentConformance | undefined {
  if (render?.pdfa === false) {
    return undefined;
  }
  if (render?.pdfa) {
    return { ...(conformance ?? {}), pdfa: render.pdfa };
  }
  return conformance;
}

/** An image resolver over `fetch`, where the platform has one; PNG and JPEG only. */
export function createFetchImageResolver(fetchImpl?: typeof fetch): PdfImageResolver {
  return {
    resolve: async (url) => {
      const doFetch = fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
      if (!doFetch) {
        return undefined;
      }
      const response = await doFetch(url);
      if (!response.ok) {
        return undefined;
      }
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (type !== "image/png" && type !== "image/jpeg") {
        return undefined;
      }
      return { type, data: bytesToBase64(new Uint8Array(await response.arrayBuffer())) };
    }
  };
}

/**
 * The host's half of the two-call protocol, once the provider has prepared the
 * signature: sign the attributes, fetch a timestamp when asked, and have the kernel embed
 * them. Throws `signature` rather than handing back an unsigned file.
 */
async function finishSignature<T extends PdfRenderResult>(
  result: T,
  deps: PdfServiceDependencies,
  signature: NonNullable<RenderFormPdfOptions["signature"]>,
  spec: ReturnType<typeof pdfSignatureSpec>,
  layoutId: string,
  runtime: RenderableRuntime,
  formId: string
): Promise<T & { signature: RenderFormPdfSignature }> {
  if (!result.signing || !spec) {
    throw new PdfKernelError("signature", `PDF provider "${deps.provider.id}" did not prepare a signature`);
  }
  if (!deps.provider.complete) {
    throw new PdfKernelError("signature", `PDF provider "${deps.provider.id}" cannot complete signatures`);
  }
  const value = await signature.signer.sign(base64ToBytes(result.signing.toBeSigned), result.signing.signatureAlgorithm);
  let timestamp: { token: string } | undefined;
  if (signature.timestamper) {
    if (!deps.provider.timestampRequest) {
      throw new PdfKernelError("signature", `PDF provider "${deps.provider.id}" cannot build timestamp requests`);
    }
    const request = await deps.provider.timestampRequest(buildPdfTimestampRequest(value));
    timestamp = { token: bytesToBase64(await signature.timestamper.timestamp(request)) };
  }
  const { timestamp: _reserve, ...completionSpec } = spec;
  const completed = await deps.provider.complete(
    buildPdfCompleteRequest(result.bytes, {
      ...completionSpec,
      value: bytesToBase64(value),
      toBeSignedDigest: result.signing.toBeSignedDigest,
      ...(timestamp ? { timestamp } : {})
    })
  );
  const signed: RenderFormPdfSignature = {
    field: completed.field,
    algorithm: result.signing.signatureAlgorithm,
    subFilter: result.signing.subFilter,
    certificates: spec.certificates,
    timestamped: completed.timestamped,
    ...(spec.commitment ? { commitment: spec.commitment } : {})
  };
  const events = runtime.events?.();
  if (events) {
    // What was signed and how — never the bytes, the attributes or the value.
    events.publish({
      id: "pdf_signed",
      type: FormEventType.PDF_SIGNED,
      timestamp: Date.now(),
      source: "renderer",
      formId,
      data: {
        layoutId,
        field: signed.field,
        algorithm: signed.algorithm,
        subFilter: signed.subFilter,
        certification: spec.certify || null,
        certificateCount: spec.certificates.length,
        digest: result.signing.digest,
        timestamped: signed.timestamped,
        commitment: spec.commitment?.type ?? null,
        byteLength: completed.bytes.length
      }
    });
  }
  const { signing: _handoff, ...rest } = result;
  return { ...(rest as T), bytes: completed.bytes, signature: signed };
}

/** A runtime that carries its form definition (`FormRuntime.definition`), whose `kinds` map the PDF reads. */
interface PdfDefinitionRuntime {
  definition?(): { kinds?: Readonly<Record<string, string>> | undefined } | undefined;
}

/** The definition's `kinds` map, when the runtime has a definition behind it (the builder's preview has none). */
function definitionKinds(runtime: RenderableRuntime): Readonly<Record<string, string>> | undefined {
  return (runtime as RenderableRuntime & PdfDefinitionRuntime).definition?.()?.kinds;
}

export async function renderFormPdf(
  runtime: RenderableRuntime,
  deps: PdfServiceDependencies,
  options: RenderFormPdfOptions = {}
): Promise<RenderFormPdfResult> {
  // A provider of another PDF ABI major reads and answers other messages: refused before anything is built.
  if (!pdfAbiCompatible(PDF_ABI_VERSION, deps.provider.abiVersion)) {
    throw new PdfKernelError(
      "abi_mismatch",
      `PDF provider "${deps.provider.id}" speaks PDF ABI ${String(deps.provider.abiVersion)}; this engine needs PDF ABI ${PDF_ABI_VERSION.split(".")[0]}.x`
    );
  }
  // The pipeline brings its own render mode: the orchestrator learns of "pdf" here.
  registerPdfRenderMode();
  if (options.locale !== undefined) {
    // The same rule `FormRuntime.setLocale` applies: a form that declares its locales gets a
    // PDF only in one of them; a form that declares none renders in whatever is asked.
    const supported = supportedLocaleCodes(runtime.localization?.());
    if (supported.length > 0 && !supported.includes(options.locale)) {
      throw new Error(`Locale "${options.locale}" is not supported`);
    }
  }
  const output = await buildRuntimeRenderOutput(runtime, "pdf", {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    pdf: {
      layoutId: options.layoutId,
      layout: options.layout,
      pdf: runtime.pdfConfiguration?.(),
      renditions: deps.renditions ?? (runtime.pdfRenditionSources ? createPdfRenditionResolver(runtime.pdfRenditionSources()) : undefined),
      hostContext: options.hostContext,
      theme: deps.theme,
      binding: deps.binding,
      themeId: options.themeId,
      resolveTheme: pdfThemeLookup(deps.themes),
      unknownComponents: options.unknownComponents,
      attachments: options.attachments,
      today: pdfToday(runtime, options),
      formulaErrors: options.formulaErrors,
      riskyPatterns: options.riskyPatterns,
      // The definition's `kinds` map: a plugin's or a binding's type prints as its base engine
      // type, as the program's PDF of the same submission prints it.
      kinds: definitionKinds(runtime)
    }
  });
  if (output.mode !== "pdf") {
    throw new Error(`Expected a pdf render model, got "${output.mode}"`);
  }
  const environment = deps.environment ?? DEFAULT_PDF_ENVIRONMENT;
  const env = pdfKernelEnv(environment);
  const formId = runtime.formId?.() ?? runtime.formRoot().id;
  const fileName = options.fileName ?? pdfFileName(formId, output.layoutId, env.createdAt, options.locale);
  const fonts = deps.fonts ?? NO_PDF_FONTS;

  if (output.fill) {
    if (!deps.provider.fill) {
      throw new Error(`PDF provider "${deps.provider.id}" cannot fill templates`);
    }
    const templates = deps.templates ?? BASE64_TEMPLATE_RESOLVER;
    const templateBytes = await templates.resolve(output.fill.template);
    if (templateBytes.length > MAX_PDF_TEMPLATE_BYTES) {
      throw new PdfKernelError("template", `The template is ${templateBytes.length} bytes, over the ${MAX_PDF_TEMPLATE_BYTES} byte (25 MiB) cap a layout fills.`);
    }
    const attachmentWarnings = await resolvePdfAttachments(output.fill.attachments, templates);
    const fontWarnings: PdfWarning[] = [];
    const fontResources = await fonts.resolve({ ...pdfFillFontNeed(output.fill), faces: output.fontFaces, themeId: output.themeId, warn: (warning) => fontWarnings.push(warning) });
    const conformance = fillConformance(output.fill.conformance, options.render);
    const { conformance: _declared, ...fillWithoutClaim } = output.fill;
    const plan = conformance ? { ...fillWithoutClaim, conformance } : fillWithoutClaim;
    const spec = pdfSignatureSpec(output.fill.signature, options.signature?.signer, options.signature?.settings);
    const filled = await deps.provider.fill(buildPdfFillRequest(plan, templateBytes, fontResources, env, spec));
    const result = options.signature ? await finishSignature(filled, deps, options.signature, spec, output.layoutId, runtime, formId) : filled;
    const warnings = [
      ...output.warnings,
      ...fontWarnings,
      ...attachmentWarnings,
      ...result.warnings
    ];
    return {
      ...result,
      layoutId: output.layoutId,
      themeId: output.themeId,
      layoutKind: output.layoutKind,
      layoutChoice: output.layoutChoice,
      fileName,
      fields: result.fields,
      ...(result.areas ? { areas: result.areas } : {}),
      warnings
    };
  }

  const document = output.document!;
  const imageWarnings = await resolvePdfImages(document, deps.images);
  const intentWarnings = await resolvePdfOutputIntent(document.conformance, deps.templates);
  const attachmentWarnings = await resolvePdfAttachments(document.attachments, deps.templates);
  const fontWarnings: PdfWarning[] = [];
  const fontResources = await fonts.resolve({ ...pdfFontNeed(document), faces: output.fontFaces, themeId: output.themeId, warn: (warning) => fontWarnings.push(warning) });
  const spec = pdfSignatureSpec(document.signature, options.signature?.signer, options.signature?.settings);
  const rendered = await deps.provider.render(buildPdfRenderRequest(document, fontResources, env, options.render, spec));
  const result = options.signature ? await finishSignature(rendered, deps, options.signature, spec, output.layoutId, runtime, formId) : rendered;
  return {
    ...result,
    layoutId: output.layoutId,
    themeId: output.themeId,
    layoutKind: output.layoutKind,
    layoutChoice: output.layoutChoice,
    fileName,
    document,
    warnings: [
      ...output.warnings,
      ...fontWarnings,
      ...imageWarnings,
      ...intentWarnings,
      ...attachmentWarnings,
      ...result.warnings
    ]
  };
}
