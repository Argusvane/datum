// main.mjs — the endpoint the page delivers to: the submission validated, rendered as a PDF, and signed.
//   qjs.mjs beside it: the engine, one process per run — Node 22 or later, nothing to install for it.
//   npm install express
//   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
//   node main.mjs
//
//   the signing key, a self-signed certificate to try with (production uses the organisation's):
//   mkdir -p keys
//   openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -subj "/CN=Intake service/O=Datum" \
//       -keyout keys/signer.key.pem -out keys/signer.cert.pem
// The PDF is signed the way ISO 32000 and PAdES ask — a signature field, /ByteRange, a CMS
// SignedData — by datum-pdf-program.js, the kernel behind the browser's PDF button, in a QuickJS of
// this process's own. The kernel never sees the key: it prepares the bytes to sign, this process
// signs them with node:crypto, the kernel embeds the value. Any viewer validates the result; the
// verify endpoint below is how this server tells its own sealed records apart.
import { spawn } from "node:child_process";
import { X509Certificate, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

const FORM = JSON.parse(readFileSync("forms/customer-intake.json", "utf8"));

// The journey the answers were given through, from this server's own copy of the form: the
// envelope names it (submission.journey.id) and nothing more. Handed to the sandbox, it has the
// kernel work the path out again from the values, as the browser did: an answer on a page the
// path skipped is judged hidden, and a form field one of the journey's own fields fills or works
// out counts as asked on that page. None named, or one the form does not have: null, and the
// answers are judged as the whole form, which asks for every required field.
const journeyOf = (submission) => FORM.journey?.journeys?.find((journey) => journey.id === submission.journey?.id) ?? null;

// The engine: qjs-wasi.wasm, QuickJS-ng's own WebAssembly build from its release page, on V8 with
// node:wasi (qjs.mjs) — nothing to install. Every request runs it in a process of its own, so requests
// need no lock and share nothing: V8 has no store to hang a limit on, as wasmtime has, so the
// operating system draws the line instead, and the flag and the timeout below are that process's.
const RUNNER = fileURLToPath(new URL("qjs.mjs", import.meta.url));

// What a run can reach: one directory holding the two programs, and nothing else — not this
// directory, not the disk. Node's WASI mounts a directory read-write and does not promise the
// sandbox wasmtime's does, so a run is started in a directory of its own with nothing else in it.
const APP = programs();

function programs() {
  const app = mkdtempSync(join(tmpdir(), "datum-"));
  for (const name of ["datum-sandbox-program.js", "datum-pdf-program.js"]) {
    copyFileSync(name, join(app, name));
  }
  // Gone with the process: at its exit, and on the signals that would otherwise end it without one.
  process.on("exit", () => rmSync(app, { recursive: true, force: true }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit());
  return app;
}

/** A run that ended without an outcome: a limit cut it off, or a program or rule module would not load. */
class SandboxError extends Error {}

function qjs(argv, request, seconds, memory) {
  // One run: a process started in the programs' directory, which it mounts as /app, the request on
  // its stdin, the answer on its stdout — all the run can reach; the runner hands it nothing else.
  // The limits are the process's, at the browser's profile: the memory in bytes, as the pages V8
  // lets the module's memory grow to, and the budget in seconds, a timeout that ends the process —
  // this run's alone, so a run past it interrupts no other: there is no engine-wide clock here, as
  // there is under wasmtime (see main.py). The budget counts the process's own start and the
  // module's compilation, a fifth of a second: it is a bound on a runaway rule, not a latency to
  // meet. Runaway recursion ends the run too: QuickJS's own stack check throws, and V8 traps the
  // instance's stack if it does not.
  return new Promise((resolve, reject) => {
    const flags = ["--wasm-max-mem-pages=" + memory / 65536, "--disable-warning=ExperimentalWarning"];
    const run = spawn(process.execPath, [...flags, RUNNER, ...argv], { cwd: APP, timeout: seconds * 1000 });
    const out = [];
    const err = [];
    run.stdout.on("data", (chunk) => out.push(chunk));
    run.stderr.on("data", (chunk) => err.push(chunk));
    run.stdin.on("error", () => {});  // a run that ended before reading its request: what ended it is on stderr
    run.stdin.end(request);
    run.on("error", reject);
    run.on("close", (code, signal) => {
      if (signal !== null) {  // the budget: the timeout ended the process
        reject(new SandboxError("interrupt"));
      } else if (code !== 0) {  // a throw: qjs printed it to stderr and exited 1
        reject(new SandboxError(Buffer.concat(err).toString().trim()));
      } else {
        resolve(Buffer.concat(out).toString().trimEnd());
      }
    });
  });
}

// Validation first, so the PDF prints the sanitized values: what the form defines, nothing else.
const VALIDATE = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"];

// The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
// Signing needs a program that lists "signature" in its capabilities.
const RENDER = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"];

// The fonts to embed: the signature's appearance is drawn with the first of them.
function font(id, family, weight, file) {
  return { id, family, weight, style: "normal", data: readFileSync(join("fonts", file)).toString("base64") };
}

const FONTS = [font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")];

// What the Country select shows, resolved here: the program never fetches a data source.
const COUNTRIES = [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }, { value: "MX", label: "Mexico" }];

// The server's key and certificate chain. The key stays in this process; the chain rides with the
// request (DER, base64, the signer's certificate first) and ends up in the PDF for any viewer to check.
const KEY = createPrivateKey(readFileSync("keys/signer.key.pem"));
const CHAIN = readFileSync("keys/signer.cert.pem", "utf8").split(/(?<=-----END CERTIFICATE-----)/).map((pem) => pem.trim()).filter(Boolean).map((pem) => new X509Certificate(pem));
const CERTIFICATES = CHAIN.map((certificate) => certificate.raw.toString("base64"));

// The layout says how the record is sealed — which signature block, certified or not, the reason —
// and the request may override any of it. Undefined keeps the layout's say (certify, no changes).
const CERTIFY = undefined;

// A timestamp authority (RFC 3161), for a signature that proves when it was made by a third party's
// clock (PAdES-B-T). Empty: none. With a URL, the kernel builds the request, this process posts it,
// and the token goes into the signature; give the layout "timestamp": true so the placeholder has room.
const TSA_URL = "";

const app = express();
app.use(express.json());

app.post("/api/submissions/sign", async (req, res) => {
  const { submission } = req.body;
  const locale = submission.locale ?? "en";
  // The journey, if the answers came through one: the path is worked out again from the values (see journeyOf).
  const context = { formId: FORM.id, form: FORM.root, values: submission.values, locale, journey: journeyOf(submission), optionSnapshot: { countries: COUNTRIES } };
  const outcome = JSON.parse(await qjs(VALIDATE, JSON.stringify(context), 5, 32 * 1024 * 1024));
  if (outcome.errors.length > 0) {  // 422 with codes and fields, never text; the page's messages word them
    const errors = outcome.errors.map((e) => ({ field: e.componentId ?? null, code: e.code }));
    return res.status(422).json({ errors });
  }
  // The record, rendered and prepared for signing in one call: the layout's signature settings
  // plus these certificates. The answer's "bytes" carry the placeholder; "signing" says what to sign.
  const prepared = await render({
    abi: "4.0.0",
    op: "document",
    form: FORM.root,
    pdf: FORM.pdf,  // the sealed layout, as designed in the builder's PDF mode
    values: outcome.values,
    locale,
    optionSnapshot: { country: COUNTRIES },
    fonts: FONTS,
    signature: { certificates: CERTIFICATES, ...(CERTIFY === undefined ? {} : { certify: CERTIFY }) },
    // The only time and identity the program ever sees; the signature's /M is this instant.
    env: { createdAt: new Date().toISOString(), documentId: randomUUID() }
  });
  if (!prepared.ok) {  // {"code": "signature" | "font" | "layout" | "internal", "message": ...}
    return res.status(500).json({ error: prepared.error });
  }
  const handoff = prepared.signing;
  const value = signBytes(Buffer.from(handoff.toBeSigned, "base64"));
  const signing = { certificates: CERTIFICATES, value: value.toString("base64"), toBeSignedDigest: handoff.toBeSignedDigest };
  if (TSA_URL) {
    signing.timestamp = { token: await timestamp(value) };
  }
  const completed = await render({ abi: "4.0.0", op: "complete", pdf: { data: prepared.bytes }, signing });
  if (!completed.ok) {
    return res.status(500).json({ error: completed.error });
  }
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="customer-intake-signed.pdf"',
    "X-Page-Count": String(prepared.pageCount),
    "X-Signed-By": CHAIN[0].subject.replace(/\n/g, ", "),
    "X-Signature-Field": completed.field,
    "X-Timestamped": String(completed.timestamped)
  });
  res.send(Buffer.from(completed.bytes, "base64"));
});

// A signed PDF back for a verdict: which signatures it carries, whether each still matches the
// bytes, whether the value checks out under the signer's key, and whether the signer is this server.
app.post("/api/submissions/verify", express.raw({ type: "application/pdf", limit: "64mb" }), async (req, res) => {
  const report = await render({ abi: "4.0.0", op: "verify", pdf: { data: req.body.toString("base64") } });
  if (!report.ok) {
    return res.status(400).json({ error: report.error });
  }
  const verdicts = report.signatures.map((sig) => ({
    field: sig.field,
    signer: sig.signer?.subject ?? null,
    signingTime: sig.signingTime,
    digestMatches: sig.digestMatches,  // the file still hashes to what was signed
    certificateMatches: sig.certificateMatches,  // the signed attributes name this certificate
    signatureValid: Boolean(sig.signer) && verifyBytes(Buffer.from(sig.signer.publicKey, "base64"), Buffer.from(sig.toBeVerified, "base64"), Buffer.from(sig.signature, "base64")),  // the value checks out under the signer's public key
    coversDocument: sig.coversDocument,  // nothing was appended after this signature
    trusted: sig.signer?.certificate === CERTIFICATES[0],  // the signer is this server
    certification: sig.certification,
    timestamp: sig.timestamp ?? null
  }));
  // The files the signature sealed, by digest: what a record's JSON must hash to.
  res.json({ signatures: verdicts, attachments: report.attachments });
});

app.listen(8000);

// The one cryptographic step this server keeps for itself: the DER attributes the kernel prepared,
// signed with the key. An HSM or a cloud KMS signs the same bytes (or "toBeSignedDigest", their SHA-256).
function signBytes(data) {
  return sign("sha256", data, KEY);  // RSA PKCS#1 v1.5, or ECDSA as DER — both as the kernel takes them
}

function verifyBytes(spki, data, value) {
  return verify("sha256", data, createPublicKey({ key: spki, format: "der", type: "spki" }), value);
}

async function timestamp(value) {
  const tsq = await render({ abi: "4.0.0", op: "timestampRequest", signature: value.toString("base64") });
  const response = await fetch(TSA_URL, { method: "POST", headers: { "content-type": "application/timestamp-query" }, body: Buffer.from(tsq.request, "base64") });
  if (!response.ok) throw new Error(`the timestamp authority answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

async function render(request) {
  return JSON.parse(await qjs(RENDER, JSON.stringify(request), 15, 256 * 1024 * 1024));
}
