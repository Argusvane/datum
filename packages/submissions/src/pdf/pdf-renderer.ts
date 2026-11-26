import {
  BASE64_TEMPLATE_RESOLVER,
  PDF_ABI_VERSION,
  PdfKernelError,
  buildPdfCompleteRequest,
  buildPdfFillRequest,
  buildPdfInspectRequest,
  buildPdfRenderRequest,
  buildPdfVerifyRequest,
  pdfSignatureSpec,
  type FormDefinition,
  type FormulaErrorPolicy,
  type PdfAConformance,
  type PdfAttachmentReport,
  type PdfDocumentAttachment,
  type PdfDocumentInputs,
  type PdfFontResource,
  type PdfInspectAttachments,
  type PdfKernelRequest,
  type PdfKernelResponse,
  type PdfLayoutChoice,
  type PdfRenderProvider,
  type PdfSignatureReport,
  type PdfSigner,
  type PdfTemplateInfo,
  type PdfTemplateResolver,
  type PdfTemplateSource,
  type PdfWarning
} from "@argusvane/datum-engine";

import { warnDevelopmentOnly } from "../development-warning.js";
import { base64ToBytes, bytesToBase64 } from "./submission-attachment.js";

/**
 * How the server turns an accepted record into a PDF, and reads one back: a seam
 * the host binds to a `PdfRenderProvider` — the in-process kernel in the page, the PDF program
 * in a QuickJS on a server. The path is the kernel's own, in four calls: `build` turns the
 * form, the layout and the answers into the document model (or the fill plan for a template);
 * the server adds its `submission.json` to the model's attachments — the one thing the
 * one-call `document` op leaves no room for; `render` or `fill` produces the bytes, prepared
 * for a signature when the server has a key; `complete` embeds the value the key produced.
 */
export interface SubmissionPdfRenderInput {
  definition: FormDefinition;
  /**
   * The layout to render, by id: it wins over every layout's `when`. Absent, the form chooses:
   * the first layout whose condition holds on `values`, else its default, else its
   * first — the choice the person's browser made over the same answers.
   */
  layoutId?: string;
  values: Record<string, unknown>;
  locale: string;
  /** The calendar day, `YYYY-MM-DD`, that `today()` reads in the layout's formulas. Absent, a formula reading it is skipped as unavailable. */
  today?: string;
  /** What `host.` reads in the layouts' and the rules' formulas: the server's own context, the one the verdict was judged with. */
  hostContext?: Record<string, unknown>;
  /** What a formula that does not parse does in the kernel's build; absent, the form's own, else `"warn"`. */
  formulaErrors?: FormulaErrorPolicy;
  /** `"refuse"` (the default) or `"allow"` a `matches` pattern of a catastrophic shape in a layout formula (PDF inputs `riskyPatterns`). */
  riskyPatterns?: "refuse" | "allow";
  /** Files to embed — `submission.json` among them. */
  attachments?: PdfDocumentAttachment[];
  /** Sign with this key; the layout's `signature` settings shape the field and the policy. */
  signer?: PdfSigner;
  /** The server's copy under this conformance rather than the layout's. */
  conformance?: PdfAConformance;
  /** The document id and creation time the kernel writes; the service passes the record's. */
  documentId: string;
  createdAt: string;
}

export interface SubmissionPdfRenderResult {
  bytes: Uint8Array;
  pageCount: number;
  layoutId: string;
  layoutKind: "generated" | "template" | "derived";
  /**
   * How the layout was chosen: `asked` by the operator's id, by its `condition`, as
   * the `default`, as the first (`fallback`), or `derived` from the form.
   */
  layoutChoice?: PdfLayoutChoice;
  signed: boolean;
  /** Which attachments the kernel embedded, by name. */
  attached: string[];
  conformance?: PdfAConformance;
  warnings: PdfWarning[];
}

/** What `op: "verify"` answers, as the kernel types it. */
export interface SubmissionPdfVerifyResult {
  signatures: PdfSignatureReport[];
  attachments: PdfAttachmentReport[];
  warnings: PdfWarning[];
}

export interface SubmissionPdfRenderer {
  render(input: SubmissionPdfRenderInput): Promise<SubmissionPdfRenderResult>;
  verify(bytes: Uint8Array): Promise<SubmissionPdfVerifyResult>;
  /** The fields and, when asked, the embedded files with their bytes. */
  inspect(bytes: Uint8Array, options?: { attachments?: PdfInspectAttachments }): Promise<PdfTemplateInfo>;
}

/** The kernel's `build` op, however the host reaches the kernel: `handlePdfRequest` in-process, `__datum_pdf` through a program host. */
export type PdfBuildHandler = (request: PdfKernelRequest) => Promise<PdfKernelResponse>;

export interface ProviderPdfRendererDeps {
  provider: PdfRenderProvider;
  /** The fonts every request embeds — the same files the server samples read from `fonts/`. */
  fonts: PdfFontResource[];
  build: PdfBuildHandler;
  /** Template PDFs for template layouts; inline base64 sources resolve without one. */
  templates?: PdfTemplateResolver;
  producer?: string;
}

function fail(response: PdfKernelResponse, op: string): never {
  if (response.ok === false) {
    throw new PdfKernelError(response.error.code, response.error.message);
  }
  throw new PdfKernelError("invalid_request", `The kernel answered "${response.op}" to a ${op} request`);
}

export function createProviderPdfRenderer(deps: ProviderPdfRendererDeps): SubmissionPdfRenderer {
  const { provider, fonts } = deps;
  // `IN_PROCESS_PDF_PROVIDER_ID` of @argusvane/datum-pdf-kernel, not imported here: that package is heavy.
  if (provider.id === "datum-pdf-kernel") {
    warnDevelopmentOnly("The in-process PDF provider (createInProcessPdfProvider)", "Bind the PDF program in a QuickJS host instead.");
  }
  const templates = deps.templates ?? BASE64_TEMPLATE_RESOLVER;

  return {
    async render(input) {
      const env = { createdAt: input.createdAt, documentId: input.documentId, ...(deps.producer ? { producer: deps.producer } : {}) };
      const inputs: PdfDocumentInputs & { today?: string; formulaErrors?: FormulaErrorPolicy } = {
        form: input.definition.root,
        ...(input.definition.pdf ? { pdf: input.definition.pdf } : {}),
        ...(input.definition.translations ? { formTranslations: input.definition.translations } : {}),
        ...(input.definition.kinds ? { kinds: input.definition.kinds } : {}),
        ...(input.layoutId ? { layoutId: input.layoutId } : {}),
        values: input.values,
        locale: input.locale,
        ...(input.today !== undefined ? { today: input.today } : {}),
        ...(input.hostContext !== undefined ? { hostContext: input.hostContext } : {}),
        ...(input.formulaErrors !== undefined ? { formulaErrors: input.formulaErrors } : {}),
        ...(input.riskyPatterns !== undefined ? { riskyPatterns: input.riskyPatterns } : {})
      };
      const built = await deps.build({ abi: PDF_ABI_VERSION, op: "build", ...inputs });
      if (built.ok !== true || built.op !== "build") {
        return fail(built, "build");
      }
      const extra = input.attachments ?? [];
      const warnings: PdfWarning[] = [...built.warnings];

      if (built.document) {
        const document = { ...built.document, attachments: [...(built.document.attachments ?? []), ...extra] };
        if (input.conformance && input.conformance !== "1a" && input.conformance !== "1b") {
          // The server's copy under its own PDF/A level; parts 1 are not claimable by the kernel.
          document.conformance = { ...(document.conformance ?? {}), pdfa: input.conformance };
        }
        const signature = pdfSignatureSpec(document.signature, input.signer);
        const rendered = await provider.render(buildPdfRenderRequest(document, fonts, env, undefined, signature));
        warnings.push(...rendered.warnings);
        const bytes = rendered.signing && input.signer ? await complete(provider, rendered.bytes, rendered.signing, signature!, input.signer) : rendered.bytes;
        return {
          bytes,
          pageCount: rendered.pageCount,
          layoutId: built.layoutId,
          layoutKind: built.layoutKind,
          ...(built.layoutChoice ? { layoutChoice: built.layoutChoice } : {}),
          signed: rendered.signing !== undefined && input.signer !== undefined,
          attached: rendered.attachments ?? [],
          ...(rendered.pdfa ? { conformance: rendered.pdfa } : {}),
          warnings
        };
      }

      if (built.fill) {
        if (!provider.fill) {
          throw new PdfKernelError("invalid_request", `PDF provider "${provider.id}" cannot fill templates`);
        }
        const plan = { ...built.fill, attachments: [...(built.fill.attachments ?? []), ...extra] };
        const templateBytes = await resolveTemplate(templates, plan.template, built.layoutId, built.layoutChoice);
        const signature = pdfSignatureSpec(plan.signature, input.signer);
        const filled = await provider.fill(buildPdfFillRequest(plan, templateBytes, fonts, env, signature));
        warnings.push(...filled.warnings);
        const bytes = filled.signing && input.signer ? await complete(provider, filled.bytes, filled.signing, signature!, input.signer) : filled.bytes;
        return {
          bytes,
          pageCount: filled.pageCount,
          layoutId: built.layoutId,
          layoutKind: built.layoutKind,
          ...(built.layoutChoice ? { layoutChoice: built.layoutChoice } : {}),
          signed: filled.signing !== undefined && input.signer !== undefined,
          attached: filled.attachments ?? [],
          ...(filled.pdfa ? { conformance: filled.pdfa } : {}),
          warnings
        };
      }
      throw new PdfKernelError("invalid_request", "The kernel built neither a document nor a fill plan");
    },

    async verify(bytes) {
      if (!provider.verify) {
        throw new PdfKernelError("invalid_request", `PDF provider "${provider.id}" cannot verify signatures`);
      }
      const result = await provider.verify(buildPdfVerifyRequest(bytes));
      return { signatures: result.signatures, attachments: result.attachments, warnings: result.warnings };
    },

    async inspect(bytes, options = {}) {
      if (!provider.inspect) {
        throw new PdfKernelError("invalid_request", `PDF provider "${provider.id}" cannot inspect PDFs`);
      }
      return provider.inspect(buildPdfInspectRequest(bytes, options));
    }
  };
}

/**
 * The template's bytes, or an error that names the layout. Which template prints can depend on
 * the answers, so a server that cannot resolve one learns it only from the records
 * whose answers chose that layout; the record's log then says which layout, and why it printed.
 */
async function resolveTemplate(
  templates: PdfTemplateResolver,
  source: PdfTemplateSource,
  layoutId: string,
  choice: PdfLayoutChoice | undefined
): Promise<Uint8Array> {
  try {
    return await templates.resolve(source);
  } catch (error) {
    const why = choice === "condition" ? " (its condition held on the answers)" : choice === "asked" ? " (the layout set for this form)" : "";
    throw new PdfKernelError("template", `Template layout "${layoutId}"${why} has no PDF this server can resolve: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The host's one cryptographic step and the kernel's last: sign what was prepared, embed the value. */
async function complete(
  provider: PdfRenderProvider,
  prepared: Uint8Array,
  signing: { toBeSigned: string; toBeSignedDigest: string; signatureAlgorithm: import("@argusvane/datum-engine").PdfSignatureAlgorithm },
  spec: import("@argusvane/datum-engine").PdfSignatureSpec,
  signer: PdfSigner
): Promise<Uint8Array> {
  if (!provider.complete) {
    throw new PdfKernelError("signature", `PDF provider "${provider.id}" cannot complete signatures`);
  }
  const value = await signer.sign(base64ToBytes(signing.toBeSigned), signing.signatureAlgorithm);
  const { timestamp: _timestamp, ...settings } = spec;
  const completed = await provider.complete(buildPdfCompleteRequest(prepared, { ...settings, value: bytesToBase64(value), toBeSignedDigest: signing.toBeSignedDigest }));
  return completed.bytes;
}
