// The WebAuthn entry, datum-webauthn.js (src/webauthn.ts): the ceremony and verifier functions with
// no element, for a host's own code in a page, a worker or plain Node. What the guard holds:
//   - it is one file: no chunk of its own, no static or dynamic import of another file;
//   - its text names no DOM global (document, window, customElements, HTMLElement) at all, so
//     nothing reads one when the module loads (tests/webauthn-entry.test.ts imports it in plain Node);
//   - it exports the real functions (not the form bundle's lazy wrappers);
//   - it carries neither the validation sandbox nor the PDF kernel.
// The page-side lazy chunks (datum-form-webauthn-*.js, datum-builder-webauthn-*.js) are the form and
// builder bundles' own and are not this file. The other bundles are built apart from it, so adding
// it moves none of their bytes.

const NAME = "datum-webauthn.js";
const DOM_GLOBALS = ["document", "window", "customElements", "HTMLElement"];
const SANDBOX = "__datum_register"; // the QuickJS sandbox program (check-bundles.mjs SANDBOX)
const KERNEL = "PDFAcroForm"; // pdf-lib (check-bundles.mjs KERNEL)
const EXPORTS = ["createWebAuthnSigningProvider", "verifyWebAuthnSubmission", "verifyAssertion", "verifyRegistration", "registerCredential", "requestAssertion", "WebAuthnError"];

// Measured 22.3 KB (the engine's ceremony and verifier code, with the SPKI reader behind the key-type
// policy), plus 3 KB, rounded up.
export const budgets = { [NAME]: 26 };

export default function guard({ files, read, expect }) {
  expect(files.includes(NAME), `dist/${NAME} is missing; scripts/build-bundles.mjs builds it (--mode webauthn)`);
  if (!files.includes(NAME)) {
    return;
  }
  expect(!files.some((file) => /^datum-webauthn-/.test(file)), "datum-webauthn.js has chunks beside it; the entry is one file (vite.config.ts codeSplitting: false)");
  const text = read(NAME);
  expect(!/\bimport\s*\(/.test(text), "datum-webauthn.js imports a file at run time; the entry is one file");
  expect(!/(?:from|import)\s*["'`]\.{0,2}\//.test(text), "datum-webauthn.js imports another file statically; the entry is one file");
  for (const global of DOM_GLOBALS) {
    expect(!new RegExp(`(?<![A-Za-z0-9_$."'])${global}(?![A-Za-z0-9_$"':])`).test(text), `datum-webauthn.js names the DOM global ${global}; the entry must load with no DOM`);
  }
  expect(!text.includes(SANDBOX), "datum-webauthn.js carries the validation sandbox; it is datum-wasm.js's alone");
  expect(!text.includes(KERNEL), "datum-webauthn.js carries the PDF kernel; it is datum-pdf.js's");
  const exported = /export\s*\{([^}]*)\}\s*;?\s*(?:\/\/# sourceMappingURL=\S+\s*)?$/.exec(text.trimEnd());
  const names = new Set((exported?.[1] ?? "").split(",").map((part) => part.trim().split(/\s+as\s+/).pop()));
  for (const name of EXPORTS) {
    expect(names.has(name), `datum-webauthn.js does not export ${name}`);
  }
}
