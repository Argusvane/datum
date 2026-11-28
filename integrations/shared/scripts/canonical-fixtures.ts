// Writes integrations/shared/fixtures/canonical.json: inputs and what the engine's own
// serializeCanonicalSubmission makes of them, the digest contract every host's canonical JSON is held to.
// Each case also carries the UTF-16 code-unit ordering the sandbox program uses;
// where the two differ the case is marked "divergent". The engine sorts by code
// unit too, so none should be: a divergent case means the browser and the sandbox digest different bytes.
// Also writes webauthn-engine.json: passkeys registered and submissions signed by the engine's own
// registerCredential and WebAuthn signing provider over its software
// authenticator, which a host's passkey verifier is tested against. The keys are new on every run.
//   packages/datum/node_modules/.bin/vite-node --root packages/datum integrations/shared/scripts/canonical-fixtures.ts [--out <dir>] [--copy-to <dir> ...]
// --out writes the two generated files somewhere else (default integrations/shared/fixtures, the copy hosts read).
// --copy-to (repeatable) then copies, for a host whose tests read fixtures from its own tree, the two generated files,
// the hand-written RFC 8785 vectors (integrations/shared/fixtures/jcs-vectors.json) and the engine's shared vectors
// (engine/tests/fixtures/jcs-vectors.json, as jcs-vectors-engine.json).
// --check writes nothing: it fails (exit 1) when a --copy-to directory's copies are not byte for byte the shared
// ones, so a host's own copy cannot drift from the digests the other hosts are held to (the passkeys are new on
// every run, so regenerating is never a way to compare).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeCanonicalSubmission, signedCanonicalOf } from "../../../engine/form-engine/core/submission/canonical-submission.ts";
import type { SubmissionSigningScope } from "../../../engine/form-engine/core/submission/signing.ts";
import { bytesToBase64Url } from "../../../engine/form-engine/core/submission/webauthn-assertion.ts";
import { registerCredential } from "../../../engine/form-engine/render/webauthn/registration.ts";
import { createWebAuthnSigningProvider } from "../../../engine/form-engine/render/webauthn/signing-provider.ts";
import { createSoftwareAuthenticator } from "../../../engine/tests/webauthn-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const argv = process.argv.slice(2);
let outDir = join(here, "..", "fixtures");
const copyTo: string[] = [];
let check = false;
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === "--check") {
    check = true;
  } else if ((flag === "--out" || flag === "--copy-to") && value !== undefined) {
    if (flag === "--out") outDir = resolve(value);
    else copyTo.push(resolve(value));
    i += 1;
  } else {
    throw new Error(`canonical-fixtures: unknown argument ${flag} (use --out <dir>, --copy-to <dir> or --check)`);
  }
}
const engineVectors = join(repo, "engine", "tests", "fixtures", "jcs-vectors.json");
const rfcVectors = join(here, "..", "fixtures", "jcs-vectors.json");
/** Each copy a --copy-to directory holds, beside the file it is a copy of. */
const copies = (dir: string): Array<[source: string, copy: string]> => [
  [join(outDir, "canonical.json"), join(dir, "canonical.json")],
  [join(outDir, "webauthn-engine.json"), join(dir, "webauthn-engine.json")],
  [rfcVectors, join(dir, "jcs-vectors.json")],
  ...(existsSync(engineVectors) ? [[engineVectors, join(dir, "jcs-vectors-engine.json")] as [string, string]] : [])
];
if (check) {
  if (copyTo.length === 0) throw new Error("canonical-fixtures: --check needs at least one --copy-to <dir>");
  const drifted = copyTo.flatMap(copies).filter(([source, copy]) => !existsSync(copy) || !readFileSync(source).equals(readFileSync(copy)));
  for (const [source, copy] of drifted) console.error(`canonical-fixtures: ${copy} is not a copy of ${source}`);
  if (drifted.length > 0) {
    console.error("canonical-fixtures: run npm run shared:canonical-fixtures, which writes the shared fixtures and every copy");
    process.exit(1);
  }
  console.log(`canonical-fixtures: the copies in ${copyTo.length} director${copyTo.length === 1 ? "y are" : "ies are"} the shared fixtures, byte for byte`);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

const envelope = (values: Record<string, unknown>) => ({
  versionContext: { form: { id: "f", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
  submission: { locale: "en", values }
});

const cases: Array<{ name: string; input: unknown }> = [
  { name: "plain", input: envelope({ fullName: "Ada Lovelace", email: "ada@example.com" }) },
  { name: "nested and lists", input: envelope({ "items[0].sku": "A-1", "items[1].sku": "B-2", tags: ["b", "a"], address: { street: "1 Main", city: "Ottawa" } }) },
  { name: "empty object and array", input: envelope({ empty: {}, list: [], nothing: null }) },
  { name: "integer-like keys first", input: envelope({ "10": "ten", "2": "two", b: 1, "1": "one", a: 2, "01": "zero-one" }) },
  { name: "numbers", input: envelope({ int: 42, neg: -7, frac: 0.1, third: 1 / 3, big: 1e21, bigger: 1.5e300, small: 1e-7, smallish: 0.000001, e20: 123456789012345680000, zero: 0, negZero: -0, whole: 5.0 }) },
  { name: "strings", input: envelope({ quote: "say \"hi\"", slash: "a/b\\c", nl: "line\nbreak\ttab", ctl: "\u0001\u001f", unicode: "café 你好 🙂", sep: "a b c", html: "<b>&amp;</b>" }) },
  { name: "booleans", input: envelope({ yes: true, no: false }) },
  { name: "wrapper", input: { format: { scope: "envelope", placement: "wrapper" }, payload: envelope({ x: 1 }), signatures: [{ provider: "demo", value: "abc" }] } },
  { name: "case", input: envelope({ B: 1, a: 2, Ab: 3, aa: 4 }) },
  { name: "punctuation", input: envelope({ "a-b": 1, ab: 2, a_b: 3, "a.b": 4, "a b": 5 }) },
  { name: "astral", input: envelope({ "\u{1F600}": "emoji key", "�": "replacement", z: "z" }) }
];

const codeUnitSort = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(codeUnitSort);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, inner]) => [key, codeUnitSort(inner)]));
  }
  return value;
};

const out = cases.map(({ name, input }) => {
  const engine = serializeCanonicalSubmission(input as never);
  const codeUnit = JSON.stringify(codeUnitSort(input));
  return { name, input: JSON.stringify(input), engine, codeUnit, divergent: engine !== codeUnit };
});
const target = join(outDir, "canonical.json");
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`canonical-fixtures: ${out.length} cases, ${out.filter((c) => c.divergent).map((c) => c.name).join(", ") || "none"} divergent`);

// Passkeys and signatures made by the engine: what a browser running the bundle sends a host.
// The keys are new each run; a host's test checks the registrations against the challenge, and each
// signature against the text the host rebuilds from the delivered document.
const rpId = "localhost";
const origin = "http://localhost";
const challenge = bytesToBase64Url(new Uint8Array(32).fill(7));
const userHandle = bytesToBase64Url(new TextEncoder().encode("a random handle!"));
const signedEnvelope = {
  versionContext: { form: { id: "petition", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
  submission: {
    locale: "fr",
    values: { fullName: "Zoë Ångström", B: 1, a: 2, text_1: "x", text1: "y", "10": 10, "2": 2, ratio: 0.1, big: 1e21, items: [{ sku: "A-1", qty: 3 }], agreed: true, note: null, emoji: "\u{1F600}", quote: "say \"hi\" / \\" }
  }
};
const signingCases: Array<{ name: string; scope: SubmissionSigningScope; statement?: string }> = [
  { name: "envelope with a statement", scope: "envelope", statement: "I confirm these answers are true." },
  { name: "values, no statement", scope: "values" },
  { name: "submission, a statement with quotes and accents", scope: "submission", statement: "Je confirme « ces réponses » — \"vraies\"." }
];
const credentials = [];
for (const algorithm of ["ES256", "RS256"] as const) {
  const authenticator = await createSoftwareAuthenticator({ rpId, origin, algorithm, transports: ["internal", "hybrid"] });
  const container = authenticator.container();
  const registered = await registerCredential({
    rpId,
    rpName: "Petition",
    user: { id: userHandle, name: "Zoë", displayName: "Zoë" },
    name: "Zoë",
    challenge,
    residentKey: "required",
    userVerification: "preferred",
    credentials: container
  });
  const provider = createWebAuthnSigningProvider({ rpId, discoverable: true, credentialsContainer: container });
  const documents = [];
  for (const { name, scope, statement } of signingCases) {
    const format = { scope, placement: "embedded" as const, digest: "sha-256" as const, canonicalization: "jcs" as const };
    const canonical = signedCanonicalOf(signedEnvelope as never, scope, statement);
    const results = await provider.sign({ canonical, participants: [], modeId: "interactive", format, ...(statement !== undefined ? { statement } : {}) });
    documents.push({ name, scope, statement: statement ?? null, canonical, document: { ...signedEnvelope, signatures: results } });
  }
  credentials.push({
    algorithm: registered.algorithm,
    registration: { id: registered.id, publicKey: registered.publicKey, algorithm: registered.algorithm, transports: registered.transports, userHandle: registered.userHandle, response: registered.response },
    documents
  });
}
writeFileSync(join(dirname(target), "webauthn-engine.json"), `${JSON.stringify({ rpId, origin, challenge, userHandle, credentials }, null, 2)}\n`);
console.log(`canonical-fixtures: wrote webauthn-engine.json (${credentials.length} passkeys, ${signingCases.length} signed documents each)`);

// The copies a host's own test tree reads (its tests may run where only that tree is mounted).
for (const dir of copyTo) {
  mkdirSync(dir, { recursive: true });
  for (const [source, copy] of copies(dir)) copyFileSync(source, copy);
  console.log(`canonical-fixtures: copied the fixtures and both JCS vector files to ${dir}`);
}
