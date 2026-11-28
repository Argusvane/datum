/**
 * The PDF program ABI: the messages a host exchanges with the portable PDF
 * program, whether it imports the program in-process or evaluates it inside QuickJS-WASM on
 * a JVM. Versioned on its own, apart from the validation ABI (`WASM_ABI_VERSION`), because the
 * two programs ship and evolve separately.
 *
 * Everything here is plain JSON. Bytes travel as base64. Time and identity come from the host
 * in `env`; the program never reads a clock or a random source, which is what makes the same
 * request yield the same bytes on every host.
 */
import type { TranslationCatalog, LocalizedText, ResolvedDataSourceItem } from "../../core/schema/contracts.js";
import type { FormTranslations } from "../../core/localization/translations.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { FormulaErrorPolicy } from "../../core/expressions/expression.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import type {
  PdfAClaim,
  PdfAConformance,
  PdfAttachmentPolicyOptions,
  PdfConfiguration,
  PdfLayoutChoice,
  PdfLayoutDocument,
  PdfTemplateFillOptions
} from "../../core/schema/pdf-layout.js";
import type { PdfDocument, PdfDocumentAttachment, PdfDocumentConformance, PdfWarning } from "./pdf-document.js";
import type { PdfThemeDefinition, PdfThemeColors, PdfTypography } from "./pdf-theme.js";
import type { PdfFillArea, PdfFillPlan, PdfFillValue } from "./pdf-template.js";

/**
 * The version of this contract. A host and a program speak to each other only within one major
 * ({@link pdfAbiCompatible}); the program's `capabilities` reply names its version and its
 * kernel's, and each operation's message shapes are the types below.
 */
export const PDF_ABI_VERSION = "1.0.0";

export type PdfKernelOp = "capabilities" | "document" | "build" | "render" | "layout" | "fill" | "inspect" | "sign" | "complete" | "timestampRequest" | "verify";

/** A font the kernel may embed: TrueType or OpenType bytes and what they are. */
export interface PdfFontResource {
  id: string;
  family: string;
  /** CSS weight; 400 regular, 700 bold. Default 400. */
  weight?: number;
  style?: "normal" | "italic";
  /** The font file, base64. */
  data: string;
  /** Unicode script tags (`Latn`, `Arab`, `Hani`, …) the font covers, when the host knows. */
  coverage?: string[];
}

/** What only the host knows: when this is, and what to call the document. */
export interface PdfKernelEnv {
  /** ISO 8601 instant used for the creation and modification dates. */
  createdAt: string;
  /** Stable identity of the document; hashed into the trailer `/ID`. */
  documentId: string;
  producer?: string;
  creator?: string;
}

export interface PdfRenderOptions {
  /** Object streams and compressed cross-reference; smaller files, slower to write. Default off. */
  compact?: boolean;
  /** Overrides the document's own `accessibility.tagged`. */
  tagged?: boolean;
  /**
   * Overrides the document's own `conformance.pdfa`: a level to declare, or `false`
   * for an ordinary PDF whatever the layout says. The document's output intent and attachments
   * still apply when a level is in force.
   */
  pdfa?: PdfAClaim | false;
}

/**
 * What to do with a bound component whose type offers no PDF rendition at all — not built in,
 * not registered by a plugin module, not in a definition the host wired. `ignore`
 * draws it with the generic rendition for its shape and says nothing; `warn` (the default)
 * does the same and reports `component.unknown`; `fail` refuses the document with the
 * `unknown_component` failure. The verdict is about the schema and the layout, not the
 * answers: a component hidden by a rule counts, one the author excluded from PDFs does not.
 */
export type PdfUnknownComponentPolicy = "ignore" | "warn" | "fail";

export const DEFAULT_PDF_UNKNOWN_COMPONENT_POLICY: PdfUnknownComponentPolicy = "warn";

/** The inputs the model-building layer needs; a non-JS host sends exactly these for `document`. */
export interface PdfDocumentInputs {
  form: ComponentNode;
  /** The layout to render, or the definition's block plus an id to pick from. Either wins over every layout's `when`. */
  layout?: PdfLayoutDocument;
  pdf?: PdfConfiguration;
  layoutId?: string;
  /**
   * The answers, keyed by value path as a submission carries them: what prints, and — when
   * neither `layout` nor `layoutId` is given — what a layout's `when` reads to choose one.
   * Send the sandbox's validated `values`, so the choice is the browser's.
   */
  values: Record<string, unknown>;
  locale: string;
  /** The host's translation catalog (host data: an entry here wins over the definition's own). */
  translations?: TranslationCatalog;
  /**
   * The definition's own translations, `FormDefinition.translations`: the program
   * resolves the form's texts and a layout's (`pdf › <layoutId> › …`) from them, as the
   * browser's render does. A non-JS host sends the map with the definition it prints.
   */
  formTranslations?: FormTranslations;
  /**
   * The definition's `kinds` map, `FormDefinition.kinds`: each plugin or design-system type the
   * form uses → the engine type it is read as. The program prints such a component as its base
   * (a `gcds-date` as a date) without the plugin's or the binding's code. A non-JS host sends the
   * map with the definition it prints.
   */
  kinds?: Record<string, string>;
  /** Resolved data-source options per component id (the host resolves sources; the program never fetches). */
  optionSnapshot?: Record<string, ResolvedDataSourceItem[]>;
  /** Effective visibility per component id. Absent: rules are evaluated inside the program. */
  effectiveStates?: Record<string, EffectiveNodeState>;
  theme?: PdfThemeDefinition;
  title?: LocalizedText;
  hostContext?: Record<string, unknown>;
  /** Default `warn`. */
  unknownComponents?: PdfUnknownComponentPolicy;
  /** The budget for the uploaded files the document embeds. Default 4 MiB, `skip`. */
  attachments?: PdfAttachmentPolicyOptions;
  /**
   * The host's calendar day, `YYYY-MM-DD`, read by `today()` in a layout's `when`, a rule and
   * an expression source. Absent: a clock-reading rule is treated as unevaluable and
   * never holds. A server sends its own day; the browser's PDF sends the same snapshot the
   * runtime computed with.
   */
  today?: string;
  /**
   * What to do with a rule the program cannot parse: `fail` (the default)
   * refuses with the `formula_invalid` code; `warn`, the explicit opt-in, drops it and reports
   * `formula.invalid`. Overrides the form's own `configuration.formulaErrors`.
   */
  formulaErrors?: FormulaErrorPolicy;
  /**
   * What to do with a `matches` pattern of a catastrophic shape in a layout or field formula (a
   * repeat of a repeat such as `(x+)+`, a repeated back-reference): `refuse` (the
   * default) reads it as a `pattern.risky` problem, judged by `formulaErrors`; `allow` compiles it.
   *
   */
  riskyPatterns?: "refuse" | "allow";
}

export interface PdfTemplateBytes {
  /** The template PDF, base64. */
  data: string;
}

/** Any PDF, base64 — what `sign`, `complete` and `verify` take. */
export interface PdfBytes {
  data: string;
}

/** The signature profile: PAdES-B-B by default, the older Adobe PKCS#7 on request. */
export type PdfSignatureSubFilter = "ETSI.CAdES.detached" | "adbe.pkcs7.detached";

/** What a certification signature (DocMDP) permits after it: nothing, form filling and signing, or annotations too. */
export type PdfSignatureCertify = false | "noChanges" | "formFilling" | "annotations";

/** How the host must sign `toBeSigned`, decided by the key the leaf certificate certifies. */
export type PdfSignatureAlgorithm = "RSASSA-PKCS1-v1_5-SHA256" | "ECDSA-P256-SHA256" | "ECDSA-P384-SHA256";

/** Where and how the visible signature is drawn; `false` for an invisible one. */
export interface PdfSignatureAppearance {
  /** 1-based page; default the last. */
  page?: number;
  /** Points from the page's top-left corner, as areas are: x, y, width, height. Default: bottom-left inside the margin. */
  rect?: [number, number, number, number];
  /** The lines to draw; default "Digitally signed by …", the date, the reason. */
  lines?: string[];
  /** The font resource to draw with (its `id`); default the first resource, or Helvetica outside PDF/A. */
  fontId?: string;
  fontSize?: number;
}

/**
 * How a document is sealed — the policy a layout may declare and a request may
 * override key by key. Carries no key and no certificate: those are the host's.
 */
export interface PdfSignatureSettings {
  subFilter?: PdfSignatureSubFilter;
  /** Only SHA-256 for now. */
  digestAlgorithm?: "sha256";
  /** A certification signature with these DocMDP permissions; default `false`, an approval signature. */
  certify?: PdfSignatureCertify;
  /** An existing unsigned signature field to sign into; absent: a new field `Signature1`, `Signature2`, … */
  field?: string;
  /** The signer as shown; default the certificate's common name. */
  name?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  appearance?: false | PdfSignatureAppearance;
  /** Reserve room for an RFC 3161 timestamp token. Default off. */
  timestamp?: boolean;
  /** The document must be signed: a `document` without certificates fails instead of warning. */
  required?: boolean;
  /** The `/Contents` capacity in bytes; default from the certificates' size, at most 65536. */
  placeholderBytes?: number;
  /**
   * What the signer means by signing: a CAdES commitment type — proof of
   * approval, origin, receipt, delivery, sender or creation — with the signer's own statement
   * as its qualifier. Unlike `reason`, which sits in the signature dictionary, this is a
   * signed attribute: the key signs it, and `verify` reads it back.
   */
  commitment?: PdfSignatureCommitment;
}

export type PdfSignatureCommitmentType = "origin" | "receipt" | "delivery" | "sender" | "approval" | "creation";

export const PDF_SIGNATURE_COMMITMENT_TYPES: readonly PdfSignatureCommitmentType[] = ["approval", "origin", "receipt", "delivery", "sender", "creation"];

export interface PdfSignatureCommitment {
  type: PdfSignatureCommitmentType;
  /** Free text the signer supplied, e.g. what they affirm by signing. */
  statement?: string;
}

/** What a request carries to prepare a signature: the settings plus the certificate chain. */
export interface PdfSignatureSpec extends PdfSignatureSettings {
  /** DER certificates, base64, the signer's first and its issuers after. */
  certificates: string[];
}

/** What the host must sign, handed back by `sign` and by `document`/`render`/`fill` with a `signature`. */
export interface PdfSigningHandoff {
  field: string;
  byteRange: [number, number, number, number];
  /** SHA-256 over the byte range, base64. */
  digest: string;
  /** The DER signed attributes (a SET OF), base64 — what the host signs. */
  toBeSigned: string;
  /** SHA-256 of `toBeSigned`, base64, for signers that take a digest (a KMS). */
  toBeSignedDigest: string;
  signatureAlgorithm: PdfSignatureAlgorithm;
  subFilter: PdfSignatureSubFilter;
}

/** What `complete` takes back: the signature value and the same certificates and settings `sign` had. */
export interface PdfSignatureCompletion extends Omit<PdfSignatureSpec, "timestamp"> {
  /** The raw signature over `toBeSigned`, base64 (RSA PKCS#1 v1.5, or ECDSA as DER or `r‖s`). */
  value: string;
  /** Echoed from the handoff so a changed input is caught before the signature is embedded. */
  toBeSignedDigest?: string;
  /** An RFC 3161 `TimeStampToken` or the whole `TimeStampResp`, base64, over the signature value. */
  timestamp?: { token: string };
}

export interface PdfSignatureSigner {
  /** The signer's certificate, DER base64. */
  certificate: string;
  /** Its SubjectPublicKeyInfo, DER base64 — what a host imports as an "spki" key. */
  publicKey: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

/**
 * One signature as `verify` reads it: structure, digest and certificate binding checked; the
 * signature itself is the host's to check.
 */
export interface PdfSignatureReport {
  /**
   * The field's full name in the file's latest field tree. A signature no field links any more
   * is reported too, with the `signature.unlinked` warning and here the name
   * its signed revision gave it, or `""`.
   */
  field: string;
  subFilter: string;
  byteRange: [number, number, number, number];
  /** The range reaches the end of the file: nothing was added after this signature. */
  coversDocument: boolean;
  digestMatches: boolean;
  /** The signing-certificate attribute names the signer's certificate (`true` when the attribute is absent and the certificate was found). */
  certificateMatches: boolean;
  signer: PdfSignatureSigner | null;
  /**
   * Where `signer` came from: the signature's own certificates, the request's
   * `knownCertificates`, or `null` for no signer.
   */
  signerSource?: "signature" | "known" | null;
  /** Every certificate the signature carries, DER base64. */
  certificates: string[];
  /** The SignerInfo's signature algorithm, dotted OID. */
  signatureAlgorithm: string;
  /** The DER signed attributes as a SET OF, base64 — what the host verifies the signature over. */
  toBeVerified: string;
  /** The signature value as carried, base64. */
  signature: string;
  /** For ECDSA: the same value as fixed-width `r‖s`, base64, for WebCrypto. */
  signatureP1363?: string;
  /** The dictionary's `/M`, ISO. */
  signingTime: string | null;
  /** The signingTime attribute (PKCS#7 signatures), ISO. */
  signingTimeAttribute?: string;
  reason?: string;
  location?: string;
  name?: string;
  contactInfo?: string;
  certification: { permissions: Exclude<PdfSignatureCertify, false> } | null;
  /** An RFC 3161 token in the signature: when it says, who issued it, and whether it covers this signature value. */
  timestamp?: PdfTimestampReport;
  /** The signed commitment-type attribute: a known type's name, else its OID, and the signer's statement. */
  commitment?: { type: PdfSignatureCommitmentType | string; statement?: string };
  /**
   * Where `signedRevision` came from: `signed` when it was read from the revision
   * this signature covers, or the signature covers the whole file (then the top-level
   * `reason`, `location`, `name`, `contactInfo`, `signingTime` and `certification` are what was
   * signed, and `signedRevision` is absent); `current` when that revision or the signature's
   * dictionary in it could not be read, so only the file's latest definition is known.
   */
  details?: "signed" | "current";
  /**
   * The signature dictionary as the revision it covers defines it, present when the
   * signature does not cover the whole file and `details` is `signed`. A later incremental
   * update may define the dictionary again with other values; the top-level fields keep
   * meaning "as the file is now".
   */
  signedRevision?: PdfSignatureDetails;
  /**
   * What the file's latest definition says instead of the signed one: each key of
   * `PdfSignatureDetails` whose value differs, with the latest value (`null` when the latest
   * has none). Empty when nothing differs or the signature covers the whole file; absent when
   * `details` is `current`.
   */
  changedAfter?: PdfSignatureChanges;
  /**
   * What the incremental updates after this signature changed, present when the
   * signature does not cover the whole file and both the revision it signed and the later
   * ones could be read. A host treats its absence on a signature with `coversDocument: false`
   * as changes it cannot judge, never as none. A `permitted: true` holds only if every
   * signature in `reliedOnSignatures` is itself valid as the host checks it.
   */
  laterRevisions?: PdfLaterRevisionsReport;
  /**
   * The first element of the `/ID` in the trailer of the revision this signature covers,
   * lowercase hex, or `null` when that trailer has none. That trailer is inside the
   * signed bytes, so this is the identity the signer signed, where the reply's `documentId` is
   * only what the file says now. Absent when `details` is `current`.
   */
  signedDocumentId?: string | null;
}

/**
 * What kind of object a later update added, changed or freed. The kernel's
 * `signature/revisions.ts` classifies; its `LaterChangeKind` must stay this union (a
 * type-level check in `verify.ts` fails the build when they drift).
 *
 * - `signature-dictionary`: this signature's own dictionary defined again. Never permitted.
 * - `signature-field`: another signature (a new `/Sig` dictionary, its widget, its field).
 * - `field-value`: a form field's `/V`, or a filled field widget's `/AS` or `/AP`.
 * - `annotation`: an annotation other than a widget added, removed or changed.
 * - `acroform`: the AcroForm dictionary (fields added for a new signature, `/SigFlags`, `/DA`).
 * - `page-annots`: a page's `/Annots` list.
 * - `info`: the Info dictionary. Never permitted, as Acrobat reports it.
 * - `dss`: `/DSS` and what it references (PAdES long-term validation material).
 * - `other`: anything else (page content, the catalog beyond AcroForm and DSS, fonts). Never permitted.
 */
export type PdfLaterChangeKind = "signature-dictionary" | "signature-field" | "field-value" | "annotation" | "acroform" | "page-annots" | "info" | "dss" | "other";

/** One object a later update added, changed or freed. */
export interface PdfLaterChange {
  /** The object, as `<number> <generation> R`. */
  ref: string;
  kind: PdfLaterChangeKind;
  /** A few words on what changed, for a person reading the report. */
  detail?: string;
}

/** The updates after a signature. */
export interface PdfLaterRevisionsReport {
  /** How many revisions follow the one the signature covers. */
  revisions: number;
  changes: PdfLaterChange[];
  /**
   * Whether the certification's DocMDP permissions, as the signed revision gives them, allow
   * every change (ISO 32000-1 §12.8.2.2): P=1 none; P=2 `field-value`, `signature-field`,
   * `acroform`, `page-annots` and `dss`; P=3 those and `annotation`. `null` for an approval
   * signature, which permits nothing and forbids nothing by itself.
   */
  permitted: boolean | null;
  /**
   * The later signatures the classification trusted to seal their own updates: a
   * signature added under P=2 or P=3 is a permitted change only if it is itself a valid
   * signature, which the program cannot check. Each is named by the `field` and `byteRange` of
   * its report in the same reply (`field` is `""` when no report matches, which a host treats
   * as invalid). A certification is intact only if every signature here is itself valid
   * (digest, binding, value) as the host checks it; the program verifies none of them.
   */
  reliedOnSignatures: Array<{ field: string; byteRange: [number, number, number, number] }>;
}

/** A signature dictionary's own entries, as one revision of the file defines them. */
export interface PdfSignatureDetails {
  reason?: string;
  location?: string;
  name?: string;
  contactInfo?: string;
  /** The dictionary's `/M`, ISO. */
  signingTime: string | null;
  certification: { permissions: Exclude<PdfSignatureCertify, false> } | null;
}

/** What a later revision says instead of a signature's signed dictionary, by key. */
export type PdfSignatureChanges = { [K in keyof PdfSignatureDetails]?: NonNullable<PdfSignatureDetails[K]> | null };

/**
 * An RFC 3161 timestamp token on a signature, as `verify` reads it. The program checks the
 * imprint, the messageDigest and the certificate binding; the TSA's signature over
 * `toBeVerified` is the host's to check, with `signer.publicKey` (or a TSA certificate the host
 * already knows), `digestAlgorithm` and `signatureAlgorithm`.
 */
export interface PdfTimestampReport {
  /** The TSTInfo `genTime`, ISO, fractions dropped. A claim until the token's signature holds. */
  time: string;
  /** The TSTInfo `tsa` name, when the token gives one. */
  tsa?: string;
  /** The imprint is this signature value's SHA-256, SHA-384 or SHA-512 (a SHA-1 imprint never covers). */
  coversSignature: boolean;
  /** The `TimeStampToken` `ContentInfo`, DER base64. */
  token?: string;
  /** The imprint's hash algorithm, dotted OID. */
  imprintAlgorithm?: string;
  /** The imprint, base64. */
  imprint?: string;
  /** The TSTInfo serial number, lowercase hex. */
  serial?: string;
  /** The TSTInfo nonce, lowercase hex, when the request carried one. */
  nonce?: string;
  /** The TSTInfo accuracy, when the TSA states one. */
  accuracy?: { seconds?: number; millis?: number; micros?: number };
  /** The token SignerInfo's digest algorithm, dotted OID: the hash the TSA signed with. */
  digestAlgorithm?: string;
  /** The token's signed attributes as a DER SET OF, base64: what the TSA's signature covers. Empty when the SignerInfo cannot be read. */
  toBeVerified?: string;
  /** The token SignerInfo's signature algorithm, dotted OID. Empty when the SignerInfo cannot be read. */
  signatureAlgorithm?: string;
  /** The TSA's signature value as carried, base64. Empty when the SignerInfo cannot be read. */
  signature?: string;
  /** For ECDSA: the same value as fixed-width `r‖s`, base64, for WebCrypto. */
  signatureP1363?: string;
  /**
   * The certificate the SignerInfo names (by issuer and serial, or subject key identifier)
   * among the token's own, else among the request's `knownCertificates`; `null` when
   * neither has it.
   */
  signer?: PdfSignatureSigner | null;
  /** Where `signer` came from: the token's own certificates, the request's `knownCertificates`, or `null` for no signer. */
  signerSource?: "token" | "known" | null;
  /** Every certificate the token carries, DER base64. */
  certificates?: string[];
  /** The signed messageDigest attribute is the digest of the TSTInfo, with the SignerInfo's digest algorithm. */
  messageDigestMatches?: boolean;
  /** The signed contentType attribute is id-ct-TSTInfo, as RFC 5652 §11.1 asks. */
  contentTypeMatches?: boolean;
  /**
   * The ESSCertIDv2 of a signingCertificateV2 attribute, else the ESSCertID (SHA-1) of a
   * signingCertificate attribute, is the hash of `signer`'s certificate. `false`
   * when the attribute names another certificate or cannot be read, when the token has
   * neither attribute (RFC 3161 §2.4.2 requires one), and when no signer was found.
   */
  certificateMatches?: boolean;
}

/** An embedded file as `verify` reports it, so a host can check what the signature sealed. */
export interface PdfAttachmentReport {
  name: string;
  /** SHA-256 of the file's bytes, base64. */
  sha256: string;
  relationship?: string;
  size: number;
}

/** What `inspect` says about embedded files: nothing, their digests, or their bytes as well. */
export type PdfInspectAttachments = "none" | "digest" | "data";

/** An embedded file as `inspect` reports it: the digest report, its type and description, and its bytes when asked. */
export interface PdfEmbeddedFileInfo extends PdfAttachmentReport {
  /** The stream's `/Subtype`, a MIME type. */
  mimeType?: string;
  description?: string;
  /** The file's bytes, base64 — only for `attachments: "data"`. */
  data?: string;
}

export type PdfKernelRequest =
  | { abi: string; op: "capabilities" }
  | ({
      abi: string;
      op: "document";
      fonts: PdfFontResource[];
      env: PdfKernelEnv;
      options?: PdfRenderOptions;
      /** For a template layout whose source is not inline: the bytes the host resolved. */
      template?: PdfTemplateBytes;
      /** Prepare a signature over the result: the layout's settings, these keys over them, the certificates from here. */
      signature?: PdfSignatureSpec;
    } & PdfDocumentInputs)
  | ({ abi: string; op: "build" } & PdfDocumentInputs)
  | { abi: string; op: "render"; document: PdfDocument; fonts: PdfFontResource[]; env: PdfKernelEnv; options?: PdfRenderOptions; signature?: PdfSignatureSpec }
  | { abi: string; op: "layout"; document: PdfDocument; fonts: PdfFontResource[]; env: PdfKernelEnv }
  | {
      abi: string;
      op: "fill";
      template: PdfTemplateBytes;
      values: Record<string, PdfFillValue>;
      /** Answers drawn onto the pages; absent or empty, none. */
      areas?: PdfFillArea[];
      fonts: PdfFontResource[];
      env: PdfKernelEnv;
      options: Required<PdfTemplateFillOptions>;
      /** The archival profile to keep through the fill; absent, the template is filled as any PDF. */
      conformance?: PdfDocumentConformance;
      /** Uploaded files to embed; absent or empty, none. */
      attachments?: PdfDocumentAttachment[];
      /** Prepare a signature over the filled PDF. */
      signature?: PdfSignatureSpec;
      /**
       * The theme the plan was built under: what a content area draws with when its `draw` says
       * nothing. The plan always carries both; a request with `areas` and without them is an `invalid_request`.
       */
      typography?: PdfTypography;
      colors?: PdfThemeColors;
    }
  /** What a PDF holds; `attachments` lists its embedded files, by digest or with their bytes. */
  | { abi: string; op: "inspect"; template: PdfTemplateBytes; attachments?: PdfInspectAttachments }
  /** Prepare a signature over any PDF: the field, the placeholder, the digest and what to sign. */
  | { abi: string; op: "sign"; pdf: PdfBytes; signature: PdfSignatureSpec; fonts?: PdfFontResource[]; env: PdfKernelEnv }
  /** Embed the host's signature value (and a timestamp token) into a prepared PDF. */
  | { abi: string; op: "complete"; pdf: PdfBytes; signing: PdfSignatureCompletion }
  /** The RFC 3161 request a host posts to its timestamp authority, over a signature value (base64). */
  | { abi: string; op: "timestampRequest"; signature: string }
  /** Every signature in a PDF: structure, digest and certificate binding checked. */
  | {
      abi: string;
      op: "verify";
      pdf: PdfBytes;
      /**
       * Certificates the host already knows, DER base64: its timestamp authority's,
       * say. When a timestamp token or a signature names its signer and carries no matching
       * certificate (a token asked for without `certReq`), the signer is looked for among
       * these, and the report says so in `signerSource`. Knowing a certificate is not trusting
       * it: the host still judges the signer. At most 64 certificates of at most 16 KiB each;
       * more is an `invalid_request`.
       */
      knownCertificates?: string[];
    };

export type PdfRenderRequest = Extract<PdfKernelRequest, { op: "render" }>;
export type PdfLayoutRequest = Extract<PdfKernelRequest, { op: "layout" }>;
export type PdfFillRequest = Extract<PdfKernelRequest, { op: "fill" }>;
export type PdfInspectRequest = Extract<PdfKernelRequest, { op: "inspect" }>;
export type PdfDocumentRequest = Extract<PdfKernelRequest, { op: "document" }>;
export type PdfBuildRequest = Extract<PdfKernelRequest, { op: "build" }>;
export type PdfSignRequest = Extract<PdfKernelRequest, { op: "sign" }>;
export type PdfCompleteRequest = Extract<PdfKernelRequest, { op: "complete" }>;
export type PdfTimestampRequest = Extract<PdfKernelRequest, { op: "timestampRequest" }>;
export type PdfVerifyRequest = Extract<PdfKernelRequest, { op: "verify" }>;

/** One page as the kernel laid it out: its size and the blocks that landed on it. */
export interface PdfPageReport {
  index: number;
  width: number;
  height: number;
  blockIds: string[];
}

export interface PdfFillReport {
  pdfField: string;
  status: "filled" | "cleared" | "missing" | "unsupported";
  kind?: string;
  message?: string;
}

/**
 * What became of one area: drawn (or its field filled), nothing to draw (an empty field stays),
 * drawn but clipped, on a page the PDF lacks, or a field that could not be made (`unsupported`).
 */
export interface PdfAreaReport {
  id: string;
  page: number;
  status: "filled" | "empty" | "overflow" | "missing" | "unsupported";
  /** For a fillable area: the AcroForm field name the widget was created under. */
  field?: string;
  message?: string;
}

export type PdfTemplateFieldKind = "text" | "checkbox" | "radio" | "dropdown" | "listbox" | "signature" | "button" | "unknown";

export interface PdfTemplateFieldInfo {
  name: string;
  kind: PdfTemplateFieldKind;
  /** 1-based page of the first widget. */
  page?: number;
  /** Points from the page's left and bottom edges (PDF space). */
  rect?: { x: number; y: number; width: number; height: number };
  options?: string[];
  /** For checkboxes and radios: the export values that mean "on". */
  exportValues?: string[];
  maxLength?: number;
  multiline?: boolean;
  readOnly: boolean;
  required: boolean;
  value?: string | boolean | string[];
  /** For a signature field: whether it carries a signature. */
  signed?: boolean;
  /** The words a reader announces for the field (`/TU`); absent when it has none. */
  tooltip?: string;
}

/**
 * What an encrypted template's owner allows without the owner password (ISO 32000-1 Table 22,
 * decoded from /P). `fillForms` is true when the document may be filled at all: bit 6
 * (annotate and fill, all revisions) or, from revision 3, bit 9.
 */
export interface PdfTemplatePermissions {
  print: boolean;
  /** Printing at full quality: false when only a low-resolution print is allowed (revision 3 and later). */
  printHighQuality: boolean;
  /** Changing the document's content (bit 4). */
  modify: boolean;
  /** Copying or extracting text and graphics (bit 5). */
  copy: boolean;
  /** Adding or changing annotations (bit 6). */
  annotate: boolean;
  fillForms: boolean;
  /** Inserting, rotating or deleting pages (bit 11, revision 3 and later; below that, `modify`). */
  assemble: boolean;
}

export interface PdfTemplateInfo {
  pageCount: number;
  /** One per page; `index` is 1-based, matching each field's `page`. */
  pages: Array<{ index: number; width: number; height: number }>;
  fields: PdfTemplateFieldInfo[];
  hasXfa: boolean;
  /** Whether the template as supplied is encrypted; it is read decrypted when its user password is empty, and a fill of it is written unencrypted. */
  encrypted: boolean;
  /** The owner's permissions, decoded from the encryption dictionary; present only when `encrypted`. */
  permissions?: PdfTemplatePermissions;
  /** The PDF/A level the template declares in its XMP; absent when it declares none. */
  pdfa?: PdfAConformance;
  /** The embedded files, when the request asked for them; absent otherwise. */
  attachments?: PdfEmbeddedFileInfo[];
  /** What could not be read while listing attachments. */
  warnings?: PdfWarning[];
  /** How many signature fields are signed. */
  signatures?: number;
}

export interface PdfCapabilities {
  abi: string;
  kernelVersion: string;
}

/**
 * `conformance`: a PDF/A claim the kernel could not honour without lying — an
 * encrypted template, appearances it could not regenerate — where an ordinary render would
 * have warned and carried on. `attachment_budget`: the uploaded files outgrew the
 * layout's budget and its policy is `fail`. `signature`: a signature could not be
 * prepared, completed or read — a certificate the kernel cannot use, a certification over a
 * signed file, a value that does not fit, a token that vouches for something else.
 * `formula_invalid`: a rule the program could not parse under a `fail` policy.
 * `render_limit`: the document ran past its page cap (message begins `render.pageCap`).
 */
export type PdfKernelErrorCode =
  | "abi_mismatch"
  | "invalid_request"
  | "font"
  | "template"
  | "layout"
  | "unknown_component"
  | "conformance"
  | "attachment_budget"
  | "signature"
  | "formula_invalid"
  | "render_limit"
  | "internal";

export interface PdfKernelFailure {
  ok: false;
  error: { code: PdfKernelErrorCode; message: string };
}

/** The file a `document` or `render` produced, and what the kernel had to say about it. */
export interface PdfProducedReply {
  bytes: string;
  pageCount: number;
  pages: PdfPageReport[];
  warnings: PdfWarning[];
  fields?: PdfFillReport[];
  areas?: PdfAreaReport[];
  pdfa?: PdfAConformance;
  attachments?: string[];
  /** Present when the request carried `signature`: `bytes` are then the prepared file. */
  signing?: PdfSigningHandoff;
}

/**
 * Which layout a `document` printed and how it was chosen — so a host that
 * named none learns what the answers chose.
 */
export interface PdfLayoutReply {
  layoutId?: string;
  layoutKind?: "generated" | "template" | "derived";
  layoutChoice?: PdfLayoutChoice;
}

export type PdfKernelResponse =
  | ({ ok: true; op: "capabilities" } & PdfCapabilities)
  | ({ ok: true; op: "document" } & PdfProducedReply & PdfLayoutReply)
  /** `render` is handed a document already built: no layout was chosen, and none is named. */
  | ({ ok: true; op: "render" } & PdfProducedReply)
  | {
      ok: true;
      op: "build";
      layoutId: string;
      layoutKind: "generated" | "template" | "derived";
      /** How the layout was chosen. */
      layoutChoice?: PdfLayoutChoice;
      document?: PdfDocument;
      fill?: PdfFillPlan;
      warnings: PdfWarning[];
    }
  | { ok: true; op: "layout"; pages: PdfPageReport[]; warnings: PdfWarning[] }
  | { ok: true; op: "fill"; bytes: string; pageCount: number; fields: PdfFillReport[]; areas?: PdfAreaReport[]; warnings: PdfWarning[]; pdfa?: PdfAConformance; attachments?: string[]; signing?: PdfSigningHandoff }
  | { ok: true; op: "inspect"; info: PdfTemplateInfo }
  | { ok: true; op: "sign"; bytes: string; signing: PdfSigningHandoff; warnings: PdfWarning[] }
  | { ok: true; op: "complete"; bytes: string; field: string; cms: string; timestamped: boolean }
  | { ok: true; op: "timestampRequest"; request: string }
  | {
      ok: true;
      op: "verify";
      signatures: PdfSignatureReport[];
      attachments: PdfAttachmentReport[];
      warnings: PdfWarning[];
      /**
       * The first element of the last trailer `/ID`, lowercase hex, or `null` when the file has
       * none. A document the program rendered carries
       * the first 16 bytes of SHA-256 over the `env.documentId` it was rendered with. This is
       * the file's current claim and nothing authenticates it: any update appended after the
       * last signature can set it. The identity a signature vouches for is that signature's
       * `signedDocumentId`.
       */
      documentId?: string | null;
    }
  | PdfKernelFailure;

/** A failure the program reported, as an error a host can branch on. */
export class PdfKernelError extends Error {
  public readonly code: PdfKernelErrorCode;

  constructor(code: PdfKernelErrorCode, message: string) {
    super(message);
    this.name = "PdfKernelError";
    this.code = code;
  }
}

export function isPdfKernelFailure(response: PdfKernelResponse): response is PdfKernelFailure {
  return response.ok === false;
}

/**
 * Whether a host and a program speak the same PDF ABI: both plain `major.minor.patch` versions of
 * one major. Anything else (another major, a malformed version, no version) is refused.
 */
export function pdfAbiCompatible(hostVersion: unknown, programVersion: unknown): boolean {
  const host = typeof hostVersion === "string" ? /^(\d+)\.\d+\.\d+$/.exec(hostVersion) : null;
  const program = typeof programVersion === "string" ? /^(\d+)\.\d+\.\d+$/.exec(programVersion) : null;
  return host !== null && program !== null && host[1] === program[1];
}

/** Throws a `PdfKernelError` for a failure response, else returns the success. */
export function unwrapPdfResponse<T extends PdfKernelResponse>(response: T): Exclude<T, PdfKernelFailure> {
  if (isPdfKernelFailure(response)) {
    throw new PdfKernelError(response.error.code, response.error.message);
  }
  return response as Exclude<T, PdfKernelFailure>;
}
