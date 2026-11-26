/**
 * A record sealed on the server: the endpoint renders the sealed layout, has the PDF program prepare
 * a PAdES signature, signs the prepared bytes with its own key and has the program embed the value.
 * A second endpoint verifies a signed file.
 */
import { pdfPage } from "./server-pdf";
import {
  COUNTRIES,
  env,
  failed,
  fromBase64,
  json,
  pdfKernel,
  rejected,
  serverForm,
  toBase64,
  validate,
  warningLines,
  type Envelope,
  type PdfSignatureReport
} from "./server-stand-in";
import { SIGNER_COMMON_NAME, SIGNER_ORGANIZATION, throwawaySigner, type ThrowawaySigner } from "./throwaway-certificate";
import type { ExampleReply, ExampleRequest, ExampleSpec } from "./types";

const SIGN_ENDPOINT = "/api/submissions/sign";
const VERIFY_ENDPOINT = "/api/submissions/verify";
/** The server's copy of the form: the sample with its sealed layout. */
export const SEALED_FORM_PATH = "/forms/customer-intake-sealed.json";

/**
 * The server's key and certificate. A real server loads its own, as main.py does from keys/; this
 * stand-in makes a throwaway pair and a self-signed certificate in the page instead, once per load.
 */
async function serverIdentity(): Promise<{ key: CryptoKey; certificates: string[]; signer: ThrowawaySigner }> {
  const signer = await throwawaySigner();
  return { key: signer.key, certificates: [signer.certificateBase64], signer };
}

/** The value checked under the signer's public key, as main.py's verify_bytes does with its crypto library. */
async function signatureValid(report: PdfSignatureReport): Promise<boolean> {
  if (!report.signer) return false;
  const spki = fromBase64(report.signer.publicKey) as BufferSource;
  const data = fromBase64(report.toBeVerified) as BufferSource;
  if (report.signatureAlgorithm === "1.2.840.113549.1.1.11" || report.signatureAlgorithm === "1.2.840.113549.1.1.1") {
    const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, fromBase64(report.signature) as BufferSource, data);
  }
  for (const namedCurve of ["P-256", "P-384"]) {
    try {
      const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64(report.signatureP1363 ?? "") as BufferSource, data);
    } catch {
      // the other curve
    }
  }
  return false;
}

async function sign(body: string): Promise<ExampleReply> {
  const envelope = json<Envelope>(body);
  if (!envelope?.submission) return { status: 400, body: { errors: [{ field: null, code: "bad_document" }] } };
  const form = await serverForm(SEALED_FORM_PATH);
  const outcome = await validate(form, envelope);
  if (outcome.errors.length > 0) return rejected(outcome);
  const [{ provider, fonts }, { key, certificates, signer }] = await Promise.all([pdfKernel(), serverIdentity()]);
  try {
    // The record, rendered and prepared for signing in one call: the layout's signature settings
    // plus these certificates. The answer's bytes carry the placeholder; "signing" says what to sign.
    const prepared = await provider.document({
      abi: provider.abiVersion,
      op: "document",
      form: form.root,
      pdf: form.pdf,
      values: outcome.values ?? {},
      locale: envelope.submission.locale ?? "en",
      optionSnapshot: { country: COUNTRIES },
      fonts,
      signature: { certificates },
      env: env()
    });
    if (!prepared.signing) return failed(new Error("The program prepared no signature"));
    // The one cryptographic step the server keeps for itself: the prepared attributes, signed with its key.
    const value = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, fromBase64(prepared.signing.toBeSigned) as BufferSource));
    const completed = await provider.complete({
      abi: provider.abiVersion,
      op: "complete",
      pdf: { data: toBase64(prepared.bytes) },
      signing: { certificates, value: toBase64(value), toBeSignedDigest: prepared.signing.toBeSignedDigest }
    });
    return {
      status: 200,
      type: "application/pdf",
      body: completed.bytes,
      log: [
        `rendered ${prepared.pageCount} page(s) and signed field ${completed.field} (${prepared.signing.signatureAlgorithm})`,
        `signed as CN=${SIGNER_COMMON_NAME}, O=${SIGNER_ORGANIZATION}, serial ${signer.serialHex}: a key and self-signed certificate this page made when it loaded, which no viewer trusts`,
        `certificate SHA-256 ${signer.fingerprint}, valid ${signer.notBefore} to ${signer.notAfter}`,
        ...warningLines(prepared.warnings)
      ]
    };
  } catch (error) {
    return failed(error);
  }
}

async function verify(request: ExampleRequest): Promise<ExampleReply> {
  // The posted file's bytes, as they are: the page sends the PDF as application/pdf.
  if (!request.bytes || request.bytes.byteLength === 0) {
    return { status: 400, body: { error: { code: "bad_request", message: "Post the PDF itself, as application/pdf." } } };
  }
  const pdf = new Uint8Array(request.bytes);
  const [{ provider }, { certificates }] = await Promise.all([pdfKernel(), serverIdentity()]);
  try {
    const report = await provider.verify({ abi: provider.abiVersion, op: "verify", pdf: { data: toBase64(pdf) } });
    const signatures = [];
    for (const signature of report.signatures) {
      signatures.push({
        field: signature.field,
        signer: signature.signer?.subject ?? null,
        signingTime: signature.signingTime,
        digestMatches: signature.digestMatches,
        certificateMatches: signature.certificateMatches,
        signatureValid: await signatureValid(signature),
        coversDocument: signature.coversDocument,
        trusted: signature.signer?.certificate === certificates[0],
        certification: signature.certification,
        timestamp: signature.timestamp ?? null
      });
    }
    return {
      status: 200,
      body: { signatures, attachments: report.attachments },
      log: [`verified the ${pdf.length} bytes posted: ${signatures.length} signature(s)`]
    };
  } catch (error) {
    return { ...failed(error), status: 400 };
  }
}

export const serverSignExample: ExampleSpec = {
  title: "A page whose server signs the PDF",
  options: [],
  page() {
    // The stand-in's key and certificate, made as the example loads (in the browser only).
    if (typeof window !== "undefined") throwawaySigner().catch(() => undefined);
    return pdfPage({
      endpoint: SIGN_ENDPOINT,
      fileName: "customer-intake-signed.pdf",
      save: "Save the signed PDF",
      frameTitle: "The sealed record",
      answer: [
        `Deliver the envelope. What comes back is the record as a PDF, sealed with the server's own`,
        `certificate as the layout declares, which a PDF viewer's signature panel can check.`
      ],
      between: [`<pre id="verdict" hidden></pre>`],
      after: [
        `// Back to the server for its verdict: the signature checked, the signer known to be itself.`,
        `const verdict = await fetch("${VERIFY_ENDPOINT}", { method: "POST", headers: { "content-type": "application/pdf" }, body: pdf });`,
        `Object.assign(document.getElementById("verdict"), { textContent: JSON.stringify(await verdict.json(), null, 2), hidden: false });`
      ]
    });
  },
  // main.py's two endpoints, step for step.
  serve(request) {
    if (request.method !== "POST") return undefined;
    if (request.path === SIGN_ENDPOINT) return sign(request.body);
    if (request.path === VERIFY_ENDPOINT) return verify(request);
    return undefined;
  }
};
