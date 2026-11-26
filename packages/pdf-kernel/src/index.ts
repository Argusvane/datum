// The byte libraries ship no types; a consumer compiling this package's sources (a file: link)
// needs the declarations too, so they are referenced from the entry rather than left to tsconfig.
/// <reference path="./types/modules.d.ts" />
export {
  createInProcessPdfProvider,
  IN_PROCESS_PDF_PROVIDER_ID,
  type InProcessPdfProviderOptions
} from "./in-process-provider.js";
export {
  handlePdfRequest,
  handlePdfRequestJson,
  installProgramGlobals,
  registerPdfProgramModule,
  PDF_PROGRAM_FEATURES,
  PDF_PROGRAM_VERSION
} from "./program/entry.js";
export { installPdfProgramPolyfills } from "./program/polyfills.js";
export { buildFromInputs, computeEffectiveStates } from "./model/build-document.js";
export { renderDocument, layoutOnly, type RenderedDocument } from "./kernel/render.js";
export { fillTemplate, inspectTemplate, type FilledTemplate } from "./kernel/template.js";
export { completeSignature, prepareSignature, timestampRequestFor, type CompletedSignature, type PreparedSignature } from "./kernel/signature/sign.js";
export { verifySignatures, type VerifiedSignatures } from "./kernel/signature/verify.js";
export { parseCertificate, type ParsedCertificate } from "./kernel/signature/x509.js";
export { ecdsaSignatureToDer, mintSelfSignedCertificate, type MintSelfSignedCertificateOptions, type SelfSignedCertificateSubject } from "./kernel/signature/self-signed.js";
export {
  DEFAULT_FONT_PACK,
  composeFontProviders,
  createDefaultFontProvider,
  createFaceFontProvider,
  createFontProvider,
  loadFontPack,
  type FaceFontProviderOptions,
  type FontPackEntry,
  type LoadFontPackOptions
} from "./fonts.js";
export { isSfnt, isTtc, isWoff, isWoff2, toSfnt, woffToSfnt } from "./woff-to-sfnt.js";
