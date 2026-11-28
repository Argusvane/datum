/**
 * The provider seam: the engine
 * builds documents and fill plans; something else turns them into bytes. That something is a
 * `PdfRenderProvider` — `@argusvane/datum-pdf-kernel`'s in-process program, the same program inside a
 * QuickJS runtime, or any other implementation of the ABI — injected by the host the way a
 * theme or a draft store is. `@argusvane/datum-engine` takes no PDF dependency.
 *
 * Nothing here touches a DOM or a Node global at module scope: this module is in the render
 * barrel, which is imported under Node with no DOM.
 */
import type { LocalizedText, ThemeFontFace } from "../../core/schema/contracts.js";
import { base64ToBytes, bytesToBase64 } from "../../core/schema/file-upload.js";
import type { PdfAConformance, PdfTemplateSource } from "../../core/schema/pdf-layout.js";
import {
  PDF_ABI_VERSION,
  type PdfAreaReport,
  type PdfAttachmentReport,
  type PdfCapabilities,
  type PdfCompleteRequest,
  type PdfDocumentRequest,
  type PdfFillReport,
  type PdfFillRequest,
  type PdfFontResource,
  type PdfInspectAttachments,
  type PdfInspectRequest,
  type PdfKernelEnv,
  type PdfLayoutReply,
  type PdfLayoutRequest,
  type PdfPageReport,
  type PdfRenderOptions,
  type PdfRenderRequest,
  type PdfSignRequest,
  type PdfSignatureAlgorithm,
  type PdfSignatureCompletion,
  type PdfSignatureReport,
  type PdfSignatureSpec,
  type PdfSigningHandoff,
  type PdfTemplateInfo,
  type PdfTimestampRequest,
  type PdfVerifyRequest
} from "./pdf-abi.js";
import type { PdfDocument, PdfWarning } from "./pdf-document.js";
import { walkPdfBlocks } from "./pdf-document.js";
import type { PdfFillPlan, PdfFillValue } from "./pdf-template.js";

export interface PdfRenderResult {
  bytes: Uint8Array;
  pageCount: number;
  pages: PdfPageReport[];
  warnings: PdfWarning[];
  providerId: string;
  /** The PDF/A level the file declares; absent for an ordinary PDF. */
  pdfa?: PdfAConformance;
  /**
   * The embedded files' names as written, after any `-2` suffix a clash earned;
   * absent when none were asked for.
   */
  attachments?: string[];
  /** Present when the request asked for a signature: `bytes` are then the prepared file and this is what the host signs. */
  signing?: PdfSigningHandoff;
}

export interface PdfFillResult extends PdfRenderResult {
  fields: PdfFillReport[];
  /** One per area asked for. */
  areas?: PdfAreaReport[];
}

export interface PdfLayoutResult {
  pages: PdfPageReport[];
  warnings: PdfWarning[];
}

/** A prepared signature: the file with its placeholder and what the host must sign. */
export interface PdfSignResult {
  bytes: Uint8Array;
  signing: PdfSigningHandoff;
  warnings: PdfWarning[];
  providerId: string;
}

export interface PdfCompleteResult {
  bytes: Uint8Array;
  field: string;
  /** The CMS as embedded, base64. */
  cms: string;
  timestamped: boolean;
  providerId: string;
}

export interface PdfVerifyResult {
  signatures: PdfSignatureReport[];
  attachments: PdfAttachmentReport[];
  warnings: PdfWarning[];
  /** The trailer `/ID`'s first element, lowercase hex, or `null` when the trailer has none. */
  documentId?: string | null;
  providerId: string;
}

/**
 * The one operation a host keeps for itself: signing the DER attributes the kernel
 * prepares, with a key the kernel never sees — platform crypto, a hardware token, a cloud KMS.
 * `certificates` are the signer's chain, DER base64, leaf first.
 */
export interface PdfSigner {
  certificates: string[];
  sign(toBeSigned: Uint8Array, algorithm: PdfSignatureAlgorithm): Promise<Uint8Array>;
}

/** Fetches an RFC 3161 token for a request the kernel built — a POST to the host's timestamp authority. */
export interface PdfTimestamper {
  timestamp(request: Uint8Array): Promise<Uint8Array>;
}

/**
 * Turns the engine's document model into bytes. `render` is the one operation every provider
 * has; the rest are what the kernel offers and a thinner provider may leave out. A host
 * checks for them before offering the feature (a template mode without `fill` is no mode).
 */
export interface PdfRenderProvider {
  id: string;
  abiVersion: string;
  render(request: PdfRenderRequest): Promise<PdfRenderResult>;
  layout?(request: PdfLayoutRequest): Promise<PdfLayoutResult>;
  fill?(request: PdfFillRequest): Promise<PdfFillResult>;
  inspect?(request: PdfInspectRequest): Promise<PdfTemplateInfo>;
  /**
   * Form + layout + values to bytes in one call — what a host without the engine's model builder
   * uses. The result names the layout that printed and how it was chosen.
   */
  document?(request: PdfDocumentRequest): Promise<PdfRenderResult & { fields?: PdfFillReport[]; areas?: PdfAreaReport[] } & PdfLayoutReply>;
  /** Prepare a signature over any PDF. */
  sign?(request: PdfSignRequest): Promise<PdfSignResult>;
  /** Embed the host's signature value into a prepared PDF. */
  complete?(request: PdfCompleteRequest): Promise<PdfCompleteResult>;
  /** The RFC 3161 request for a signature value, DER. */
  timestampRequest?(request: PdfTimestampRequest): Promise<Uint8Array>;
  /** Every signature in a PDF, structurally checked. */
  verify?(request: PdfVerifyRequest): Promise<PdfVerifyResult>;
  capabilities?(): Promise<PdfCapabilities>;
  dispose?(): void;
}

/**
 * What a document needs of its fonts: the families the theme names, the scripts its text
 * uses, and the faces the theme ships for those families (`assets.fonts`) — files
 * named relative to the host's bundle, which a provider that can load files turns into
 * resources. A provider that has its own idea of the families ignores `faces`.
 */
export interface PdfFontNeed {
  families: string[];
  scripts: string[];
  faces?: ThemeFontFace[];
  /**
   * The id of the PDF theme the document renders under, so a provider can address the files of
   * `faces` per theme (each design system's fonts are served from a place of their own).
   */
  themeId?: string;
  /**
   * Where a provider reports a face it could not supply (a file that is missing, or not a font):
   * the document goes on in the default pack and the warning is on the result. A provider that
   * throws instead fails the whole render.
   */
  warn?(warning: PdfWarning): void;
}

export interface PdfFontProvider {
  resolve(need: PdfFontNeed): Promise<PdfFontResource[]>;
}

/**
 * A PDF form the host provides for template layouts: what the designer offers an
 * author beside uploading their own. The layout carries the `source` — a host storage kind
 * and its reference, never the bytes — and the resolver turns it into bytes at render time,
 * so the file lives in the host's wiring (an asset store, a URL) rather than in the definition.
 */
export interface PdfTemplateOption {
  id: string;
  /** What a picker shows. */
  label: LocalizedText;
  source: PdfTemplateSource;
}

/**
 * An ICC profile the host offers as an output condition: the same shape as a
 * template option, since the profile travels in the same envelope and the same resolver
 * serves its bytes.
 */
export type PdfProfileOption = PdfTemplateOption;

/** Resolves a template source (an attachment envelope) to the PDF's bytes. */
export interface PdfTemplateResolver {
  resolve(source: PdfTemplateSource): Promise<Uint8Array>;
  /** The PDF forms the host offers authors to populate. Absent or empty: authors upload their own. */
  list?(): Promise<PdfTemplateOption[]>;
  /**
   * The ICC profiles the host offers as output conditions for PDF/A (its organisation's press
   * profiles), beside the kernel's built-in ones. Absent or empty: built-ins and uploads only.
   */
  listProfiles?(): Promise<PdfProfileOption[]>;
}

/** Resolves an image URL a layout named to bytes the kernel can embed; `undefined` to leave it out. */
export interface PdfImageResolver {
  resolve(url: string): Promise<{ type: "image/png" | "image/jpeg"; data: string } | undefined>;
}

/** Time and identity, supplied by the host — the one place a clock is read on the PDF path. */
export interface PdfEnvironment {
  now(): string;
  newDocumentId(): string;
  producer?: string;
}

let documentCounter = 0;

/** A host-side environment: the real clock and a random id where the platform has one. */
export const DEFAULT_PDF_ENVIRONMENT: PdfEnvironment = {
  now: () => new Date().toISOString(),
  newDocumentId: () => {
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return cryptoApi.randomUUID();
    }
    documentCounter += 1;
    return `${Date.now().toString(36)}-${documentCounter.toString(36)}`;
  }
};

export function pdfKernelEnv(environment: PdfEnvironment = DEFAULT_PDF_ENVIRONMENT): PdfKernelEnv {
  return {
    createdAt: environment.now(),
    documentId: environment.newDocumentId(),
    ...(environment.producer ? { producer: environment.producer } : {})
  };
}

// The base64 helpers live in `core/schema/file-upload.ts` (the layout schema decodes an inline
// ICC profile); they stay exported here for the kernel and every host that imports them.
export { base64ToBytes, bytesToBase64 };

const SCRIPT_RANGES: Array<[string, RegExp]> = [
  ["Arab", /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/],
  ["Hebr", /[֐-׿יִ-ﭏ]/],
  ["Cyrl", /[Ѐ-ӿԀ-ԯ]/],
  ["Grek", /[Ͱ-Ͽἀ-῿]/],
  ["Hani", /[一-鿿㐀-䶿]/],
  ["Hira", /[぀-ゟ]/],
  ["Kana", /[゠-ヿ]/],
  ["Hang", /[가-힯ᄀ-ᇿ]/],
  ["Deva", /[ऀ-ॿ]/],
  ["Thai", /[฀-๿]/],
  ["Cans", /[᐀-ᙿᢰ-᣿]/]
];

/** Collects the scripts the texts it is fed use; `Latn` always. */
function scriptCollector(): { scan(text: string): void; scripts(): string[] } {
  const scripts = new Set<string>(["Latn"]);
  return {
    scan: (text) => {
      for (const [script, pattern] of SCRIPT_RANGES) {
        if (!scripts.has(script) && pattern.test(text)) {
          scripts.add(script);
        }
      }
    },
    scripts: () => [...scripts]
  };
}

/** The families and scripts a document needs fonts for, from its typography and every run of text. */
/** Every family a typography names: its roles' and its per-script fallbacks. */
function typographyFamilies(typography: PdfDocument["typography"]): Set<string> {
  const families = new Set<string>([typography.body.family, typography.label.family, typography.heading.family]);
  for (const role of ["mono", "hint", "option", "legend", "required", "small", "affix", "stepTag"] as const) {
    const spec = typography[role];
    if (spec) {
      families.add(spec.family);
    }
  }
  for (const family of Object.values(typography.fallbacks ?? {})) {
    families.add(family);
  }
  return families;
}

export function pdfFontNeed(document: PdfDocument): PdfFontNeed {
  const families = typographyFamilies(document.typography);
  const collector = scriptCollector();
  const scan = collector.scan;
  const visit = (blocks: readonly PdfDocument["blocks"][number][]): void =>
    walkPdfBlocks(blocks, (block) => {
      if ("runs" in block) {
        for (const run of block.runs) {
          scan(run.text);
        }
      }
      if (block.kind === "heading") {
        scan(block.tag ?? "");
        scan(block.number ?? "");
      }
      if (block.kind === "labelValue") {
        scan(block.label);
        for (const run of block.value) {
          scan(run.text);
        }
        scan(`${block.hint ?? ""}${block.labelSuffix ?? ""}${block.prefix ?? ""}${block.suffix ?? ""}`);
      }
      if (block.kind === "widget") {
        scan(block.label ?? "");
        const value = block.field.value;
        scan(typeof value === "string" ? value : Array.isArray(value) ? value.join("") : "");
        for (const option of block.field.options ?? []) {
          scan(option.label);
        }
        scan(`${block.hint ?? ""}${block.labelSuffix ?? ""}${block.prefix ?? ""}${block.suffix ?? ""}`);
      }
      if (block.kind === "checkmark") {
        scan(block.label);
        scan(block.hint ?? "");
      }
      if (block.kind === "checklist") {
        scan(block.label ?? "");
        scan(`${block.hint ?? ""}${block.labelSuffix ?? ""}`);
        for (const item of block.items) {
          scan(item.label);
          scan(item.description ?? "");
        }
      }
      if (block.kind === "list") {
        for (const item of block.items) {
          for (const run of item.runs) {
            scan(run.text);
          }
        }
      }
    });
  visit(document.blocks);
  visit(document.header ?? []);
  visit(document.footer ?? []);
  visit(document.anchored.map((entry) => entry.box));
  scan(document.metadata.title);
  return { families: [...families], scripts: collector.scripts() };
}

/**
 * The families and scripts a fill plan needs: the theme's typography the plan carries (what a
 * content area draws in) and the scripts its values use,
 * which the font the kernel draws areas (and regenerated field appearances) with must cover.
 * A plan from an older engine carries no typography and names no families.
 */
export function pdfFillFontNeed(plan: PdfFillPlan): PdfFontNeed {
  const collector = scriptCollector();
  const scanValue = (value: PdfFillValue): void => {
    if (typeof value === "string") {
      collector.scan(value);
    } else if (Array.isArray(value)) {
      value.forEach((entry) => collector.scan(entry));
    }
  };
  Object.values(plan.values).forEach(scanValue);
  plan.areas.forEach((area) => scanValue(area.value));
  const families = plan.typography ? typographyFamilies(plan.typography) : new Set<string>();
  return { families: [...families], scripts: collector.scripts() };
}

export function buildPdfRenderRequest(
  document: PdfDocument,
  fonts: PdfFontResource[],
  env: PdfKernelEnv,
  options?: PdfRenderOptions,
  signature?: PdfSignatureSpec
): PdfRenderRequest {
  return {
    abi: PDF_ABI_VERSION,
    op: "render",
    document,
    fonts,
    env,
    ...(options ? { options } : {}),
    ...(signature ? { signature } : {})
  };
}

export function buildPdfLayoutRequest(document: PdfDocument, fonts: PdfFontResource[], env: PdfKernelEnv): PdfLayoutRequest {
  return { abi: PDF_ABI_VERSION, op: "layout", document, fonts, env };
}

export function buildPdfFillRequest(plan: PdfFillPlan, templateBytes: Uint8Array, fonts: PdfFontResource[], env: PdfKernelEnv, signature?: PdfSignatureSpec): PdfFillRequest {
  return {
    abi: PDF_ABI_VERSION,
    op: "fill",
    template: { data: bytesToBase64(templateBytes) },
    values: plan.values,
    // Left out when empty, so a fields-only request carries no `areas` key.
    ...(plan.areas.length > 0 ? { areas: plan.areas } : {}),
    fonts,
    env,
    options: plan.options,
    ...(plan.conformance ? { conformance: plan.conformance } : {}),
    ...(plan.attachments && plan.attachments.length > 0 ? { attachments: plan.attachments, ...(plan.attachmentPolicy ? { attachmentPolicy: plan.attachmentPolicy } : {}) } : {}),
    ...(plan.typography ? { typography: plan.typography } : {}),
    ...(plan.colors ? { colors: plan.colors } : {}),
    ...(signature ? { signature } : {})
  };
}

export function buildPdfInspectRequest(templateBytes: Uint8Array, options: { attachments?: PdfInspectAttachments } = {}): PdfInspectRequest {
  return { abi: PDF_ABI_VERSION, op: "inspect", template: { data: bytesToBase64(templateBytes) }, ...(options.attachments ? { attachments: options.attachments } : {}) };
}

export function buildPdfSignRequest(bytes: Uint8Array, signature: PdfSignatureSpec, env: PdfKernelEnv, fonts?: PdfFontResource[]): PdfSignRequest {
  return { abi: PDF_ABI_VERSION, op: "sign", pdf: { data: bytesToBase64(bytes) }, signature, env, ...(fonts ? { fonts } : {}) };
}

export function buildPdfCompleteRequest(prepared: Uint8Array, signing: PdfSignatureCompletion): PdfCompleteRequest {
  return { abi: PDF_ABI_VERSION, op: "complete", pdf: { data: bytesToBase64(prepared) }, signing };
}

export function buildPdfTimestampRequest(signatureValue: Uint8Array): PdfTimestampRequest {
  return { abi: PDF_ABI_VERSION, op: "timestampRequest", signature: bytesToBase64(signatureValue) };
}

/** `knownCertificates`: DER certificates a signer may be found among when the file does not carry it. */
export function buildPdfVerifyRequest(bytes: Uint8Array, knownCertificates?: readonly Uint8Array[]): PdfVerifyRequest {
  return {
    abi: PDF_ABI_VERSION,
    op: "verify",
    pdf: { data: bytesToBase64(bytes) },
    ...(knownCertificates && knownCertificates.length > 0 ? { knownCertificates: knownCertificates.map((certificate) => bytesToBase64(certificate)) } : {})
  };
}

/**
 * The layout's signature settings with the host's certificates, the host's own keys winning.
 * `undefined` when the host has no signer — the kernel then warns or refuses by
 * the layout's `required`.
 */
export function pdfSignatureSpec(settings: Partial<Omit<PdfSignatureSpec, "certificates">> | undefined, signer: PdfSigner | undefined, overrides?: Partial<Omit<PdfSignatureSpec, "certificates">>): PdfSignatureSpec | undefined {
  if (!signer) {
    return undefined;
  }
  return { ...(settings ?? {}), ...(overrides ?? {}), certificates: signer.certificates };
}

/** Resolves an inline `base64` template source; anything else is the host's to add. */
export const BASE64_TEMPLATE_RESOLVER: PdfTemplateResolver = {
  resolve: async (source) => {
    if (source.storage !== "base64" || typeof source.data !== "string") {
      throw new Error(`No resolver for template storage "${source.storage}"`);
    }
    return base64ToBytes(source.data);
  }
};

export interface PdfTemplateResolverOptions {
  /** The PDF forms the host offers authors (see {@link PdfTemplateOption}), fixed or looked up when asked. */
  templates?: readonly PdfTemplateOption[] | (() => Promise<readonly PdfTemplateOption[]>) | undefined;
  /** The ICC profiles the host offers as PDF/A output conditions (see {@link PdfProfileOption}), fixed or looked up when asked. */
  profiles?: readonly PdfProfileOption[] | (() => Promise<readonly PdfProfileOption[]>) | undefined;
}

/**
 * A template resolver over several storages: the inline one always, plus whatever the host
 * adds keyed by storage kind (an asset store, a URL fetch) — and, when the host provides PDF
 * forms of its own, the list the designer offers.
 */
export function createPdfTemplateResolver(
  byStorage: Record<string, (source: PdfTemplateSource) => Promise<Uint8Array>> = {},
  options: PdfTemplateResolverOptions = {}
): PdfTemplateResolver {
  const templates = options.templates;
  const profiles = options.profiles;
  return {
    resolve: (source) => {
      const custom = byStorage[source.storage];
      return custom ? custom(source) : BASE64_TEMPLATE_RESOLVER.resolve(source);
    },
    ...(templates !== undefined
      ? { list: async () => [...(typeof templates === "function" ? await templates() : templates)] }
      : {}),
    ...(profiles !== undefined
      ? { listProfiles: async () => [...(typeof profiles === "function" ? await profiles() : profiles)] }
      : {})
  };
}

/** No fonts at all: the kernel falls back to the standard 14 and says so in its warnings. */
export const NO_PDF_FONTS: PdfFontProvider = { resolve: async () => [] };
