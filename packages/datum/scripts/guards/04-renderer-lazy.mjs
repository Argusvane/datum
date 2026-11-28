// Guards for the renderer's lazy splits: WebAuthn and the server
// validator are chunks beside the bundle, fetched on first use. Each is carried by exactly one
// datum-form-*.js chunk and one datum-builder-*.js chunk (the builder's preview copy of the
// renderer), and by neither bundle's entry. The classic scripts (datum-form.iife.js) cannot
// code-split: Vite inlines a dynamic import in an IIFE (as it does for the journey diagnostics
// and the PDF service), so they carry everything and stay out of the must-not-contain checks.

// A stable string of the signing provider and the registration ceremony (engine/form-engine/
// render/webauthn): their messages, spelled by no module that stays in the bundle.
const WEBAUTHN_SIGNING = "No passkey or security key is registered to sign with.";
const WEBAUTHN_CEREMONY = "The challenge or the user handle is not base64url.";
// The class and the error wording stay in the bundle (an instanceof target, a sync helper); the
// chunk imports them rather than carrying a second copy.
const WEBAUTHN_ERROR_CLASS = '"WebAuthnError"';
// server-validator.ts: the reply reader's message, which the bundle's wrapper never spells.
const VALIDATOR = "without an errors array";
// The error class the validator throws stays in the bundle too: `error instanceof
// JourneyValidationHttpError` must name one class on both sides of the chunk boundary.
const VALIDATOR_ERROR_CLASS = '"JourneyValidationHttpError"';

// Budgets: the two chunks split out of the entry are held below,
// with a tenth of room. datum-form.js (with its core chunk) is held to the gzip gate in check-bundles.mjs.

/**
 * Lazy chunk budgets in KB: measured 10.1 KB (WebAuthn, with the key-type policy and the verdicts of
 * unreadable signatures) and 1.5 KB (server validator), plus a tenth, rounded up.
 */
const CHUNK_BUDGETS_KB = [
  [/^datum-form-webauthn-.+\.js$/, 12],
  [/^datum-builder-webauthn-.+\.js$/, 12],
  [/^datum-form-server-validator-.+\.js$/, 2],
  [/^datum-builder-server-validator-.+\.js$/, 2]
];

export default function guard({ entryText, files, read, chunksOf, expect, sizeKb }) {
  const sentinels = [
    ["WebAuthn signing provider", WEBAUTHN_SIGNING],
    ["WebAuthn registration ceremony", WEBAUTHN_CEREMONY],
    ["server validator", VALIDATOR]
  ];
  for (const [entry, bundle] of [["datum-form.js", "datum-form"], ["datum-builder.js", "datum-builder"]]) {
    const text = entryText(entry);
    for (const [label, sentinel] of sentinels) {
      expect(!text.includes(sentinel), `${entry} (with its core chunk) carries the ${label}; it belongs in a lazy chunk`);
      expect(
        chunksOf(bundle).filter((name) => name.endsWith(".js") && read(name).includes(sentinel)).length === 1,
        `exactly one ${bundle}-*.js chunk should carry the ${label}`
      );
    }
    expect(text.includes(WEBAUTHN_ERROR_CLASS), `${entry} (with its core chunk) should keep WebAuthnError (an instanceof target) in the bundle`);
    for (const name of chunksOf(bundle).filter((name) => name.endsWith(".js") && read(name).includes(WEBAUTHN_SIGNING))) {
      expect(!read(name).includes(WEBAUTHN_ERROR_CLASS), `${name} carries a second WebAuthnError class; it imports the bundle's`);
    }
    expect(text.includes(VALIDATOR_ERROR_CLASS), `${entry} (with its core chunk) should keep JourneyValidationHttpError (an instanceof target) in the bundle`);
    for (const name of chunksOf(bundle).filter((name) => name.endsWith(".js") && read(name).includes(VALIDATOR))) {
      expect(!read(name).includes(VALIDATOR_ERROR_CLASS), `${name} carries a second JourneyValidationHttpError class; it imports the bundle's`);
    }
  }
  for (const [pattern, limit] of CHUNK_BUDGETS_KB) {
    for (const name of files.filter((name) => pattern.test(name))) {
      expect(sizeKb(name) <= limit, `${name} is over its ${limit} KB budget; the lazy chunk has grown`);
    }
  }
  // The chunks beside the form bundle exist under their own names, so a deploy copies them.
  expect(files.some((name) => /^datum-form-webauthn-.+\.js$/.test(name)), "datum-form-webauthn-*.js chunk is missing");
  expect(files.some((name) => /^datum-form-server-validator-.+\.js$/.test(name)), "datum-form-server-validator-*.js chunk is missing");
}
