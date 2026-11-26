# Signing

Datum signs two different things, and a form can use either, both or neither. A PDF signature proves the document has not changed since it was signed. A submission signature proves who sent exactly these answers.

| | PDF signature | Submission signature |
|---|---|---|
| Standard | PAdES, in the PDF itself | WebAuthn, over the canonical JSON bytes |
| Who signs | The server with its certificate, or the person with a YubiKey or a certificate file | The person with a passkey or security key |
| What it covers | The PDF's bytes | The answers (the envelope, the submission or the values) |
| Checked by | Any PDF viewer, or the host's verify route | The host that receives the submission |

Choose by what you need to prove.

- The record must be provable as issued, and any viewer should show it: sign the PDF on the server (`signature` block, a certificate on the host).
- A person must sign a PDF with their own certificate: the signing agent, with a YubiKey or a certificate file.
- The answers must be provably those the person sent: a passkey signs the submission. The button option for this is called the passkey option (`signature: "webauthn"`).

The `signature` block of a PDF layout and the `signature` option of a button are unrelated: the first seals a PDF, the second asks for a passkey on submit.

## PDF signatures

### The server signs

A host with its own certificate can seal every PDF it issues. Turn the seal on and give the host a key (a PKCS#12 file or a PEM key and certificate chain). Any PDF viewer's signature panel then validates the record. A layout's `signature` block says how its documents are sealed.

| Key | Meaning | Default |
|---|---|---|
| `field` | The name of the `pdf-signature` block, or a template's signature field, the signature lands in | A new field of its own |
| `certify` | `noChanges`, `formFilling` or `annotations` to certify the document, or `false` for an approval signature | `false` |
| `reason`, `location`, `contactInfo`, `name` | What the signature says about itself. `reason` is translated per locale; `name` defaults to the certificate's common name | None |
| `subFilter` | `ETSI.CAdES.detached` (PAdES) or `adbe.pkcs7.detached` (the older Adobe profile) | `ETSI.CAdES.detached` |
| `appearance` | `false` for an invisible signature, or where and how it is drawn: `page` (from 1), `rect` as `[x, y, width, height]` in points from the page's top left, `lines` (the text), `fontId`, `fontSize` | Visible, 180 by 48 points at the bottom left of the last page, saying who signed, when and why. A named `field` takes the field's place |
| `commitment` | What the signer means by signing: `type` (`approval`, `origin`, `receipt`, `delivery`, `sender` or `creation`) and a `statement`. Unlike `reason`, it is a signed attribute, which `verify` reads back | None |
| `timestamp` | Reserve room for an RFC 3161 timestamp token | `false` |
| `placeholderBytes` | The room reserved for the signature, in bytes, up to 65,536. It must leave 1 KiB beside the certificates | Worked out from the certificates, at least 8 KiB |
| `required` | Refuse to produce a PDF that cannot be signed, instead of producing it unsigned | `false` |

The digest is always SHA-256. The builder's PDF workspace sets all of these but `appearance` and `placeholderBytes`, which are written in the definition.

A certificate may hold an RSA key (PKCS#1 v1.5), or an EC key on the P-256 or P-384 curve.

- RSASSA-PSS keys, other curves and other key types are refused with the `signature` failure when the PDF is prepared.
- RSA-1024 and Ed25519 keys are listed by the signing agent but refused before any PIN is asked.
- A certificate that has expired, is not yet valid, is about to expire, or whose issuer is not among the certificates sent warns instead of failing.

```json
{ "signature": { "field": "server-signature", "certify": "noChanges", "reason": "Received and validated by the intake service", "timestamp": true, "required": true } }
```

The `pdf-signature` component places a named signature field in a layout, with a caption and a width and height, so you choose where the visible signature goes. Without one the signature takes a field of its own at the bottom of the last page.

### The document-modification policy

`certify` is the document-modification policy. `noChanges` is the server's record: any later change breaks the signature. `formFilling` still allows fields to be filled and further signatures added, and `annotations` also allows annotations. A certifying signature must be the document's first.

### Timestamps

A timestamp is an RFC 3161 token from a timestamp authority, which proves the PDF existed at that time. It is optional. [Timestamp server](/timestamps) says where a token comes from, how to ask for one, and how to run the server both built hosts carry.

### The person signs

When the person signs with their own certificate, the page cannot reach a YubiKey or a key file on the computer, and must not hold a key. A small local agent does that, `tools/piv-agent` in the repository, a Python program (3.11 or later) that listens on the loopback address only.

- It asks for the PIN or passphrase in the operating system's own dialog, so the page never sees it.
- It never sees the PDF.

```sh
pip install -r requirements.txt
python piv_agent.py --allow-origin https://forms.example.org
python piv_agent.py --p12 ~/signer.p12 --allow-origin https://forms.example.org
python piv_agent.py --key signer.key.pem --cert signer.cert.pem --allow-origin https://forms.example.org
```

A YubiKey is not required:

- With no flag the agent signs with the certificate on a YubiKey's PIV applet.
- `--p12` serves a `.p12` or `.pfx` file, and `--key` with `--cert` serves a PEM pair.
- A file is listed under the slot `file`, its key is read and dropped for every signature, and the dialog is a plain Sign or Cancel when the file has no passphrase.
- A key in a file is only as safe as the file, so keep it out of shared folders and prefer a passphrase.

| Flag | Meaning | Default |
|---|---|---|
| `--allow-origin ORIGIN` | A web origin that may use the agent. Repeat for several | Required, unless `--dev` is given |
| `--dev` | Also allow the development server's two local addresses on port 5173 | Off |
| `--port N` | The port on 127.0.0.1. The agent listens on no other interface | 7391 |
| `--slot SLOT` | The slot a request that names none signs with. A PIV slot such as `9c` (Digital Signature), `9a`, `9d`, `9e` or a retired slot, or `file` | `9c`; `file` when a certificate file is given |
| `--serial N` | Which YubiKey, when several are plugged in | The one plugged in |
| `--chain PEM` | Issuer certificates to send after the signer's. A token holds only its own certificate, so without a chain a viewer may not be able to build the signer's chain | None |
| `--p12 FILE` | A PKCS#12 certificate file to sign with | None |
| `--key PEM`, `--cert PEM` | A PEM private key and its certificate (the signer's first, then issuers). Given together, and not with `--p12` | None |
| `--terminal-pin` | Ask for the PIN or passphrase in the agent's terminal, for a headless or SSH session | A native dialog |
| `--allow-no-origin` | Also answer requests without an `Origin` header, such as curl | Refused |
| `--verbose`, `-v` | Log each request to stderr, never the PIN, the bytes or the value | Off |

The origin list is the consent between web pages: a page that is not listed is refused before anything else happens. The dialog is the consent for each signature.

The agent has three routes:

- `GET /health`.
- `GET /certificates`: the certificates it can sign with, their key types, whether each is usable, and the PIN policy.
- `POST /sign`: one signature at a time.

In the page, `createAgentPdfSigner` turns the agent into a signer, and `pdfSigner` makes every PDF the form downloads a signed one. Import it from the bundle you serve; with a bundler, import from `@argusvane/datum`.

```js
import { createAgentPdfSigner } from "./datum-form.js";

form.pdfSigner = await createAgentPdfSigner({
  url: "http://127.0.0.1:7391",
  slot: "9c",
  context: { title: "Intake form", reason: "I confirm these answers" }
});
await form.downloadPdf();
form.pdfSigner = undefined;
```

| Option | Meaning | Default |
|---|---|---|
| `url` | Where the agent listens | `http://127.0.0.1:7391` |
| `slot` | The slot to sign with | `9c` when the agent lists it, else the only usable certificate; several and no `9c` is a `no_certificate` error |
| `context` | What the PIN dialog says about the document: `title`, `documentId`, `field`, `reason` (what the person affirms) | Nothing |
| `fetch` | A `fetch` to use | The page's |

`listAgentCertificates(url)` returns what the agent can sign with, for a page that lets the person choose. `agentPdfSignerFor(entry, options)` makes a signer for one of the entries it listed. A signer is any object with `certificates` (base64 DER, the signer's first) and `sign(toBeSigned, algorithm)`, which returns the signature bytes, so a key service can sign instead of the agent.

`pdfSignature` carries the settings, over the layout's own, and a timestamper. A timestamper is an object with `timestamp(request)`, which posts the request bytes to a timestamp authority and returns its answer. Set `timestamp: true` so room is reserved. [Timestamp server](/timestamps#in-the-page) has more.

```js
form.pdfSignature = {
  settings: { certify: "noChanges", reason: "Issued by the intake service", timestamp: true },
  timestamper: {
    async timestamp(request) {
      const response = await fetch("/tsa", { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body: request });
      return new Uint8Array(await response.arrayBuffer());
    }
  }
};
```

An agent that cannot sign rejects with a `PdfSigningAgentError` whose `code` a page words for the person. The page's own codes are:

- `unreachable`: no agent answered, or the browser blocked the call.
- `protocol`: something answered that is not the agent.

`pin_invalid` carries `attemptsRemaining`. The codes are listed in the codes reference.

The example is a page with the form and two buttons:

- **Draw the PDF** draws the unsigned PDF in the browser.
- **Sign with my certificate** asks the agent for the certificate and signs into the layout's signature field, exactly as the code above does.

What you will see:

- Unless the agent is running on your computer with this page's origin in `--allow-origin`, the page cannot reach it, and the button reports `unreachable` in the status line and in the log.
- The agent refuses an origin it does not allow with `origin_denied` and sends no CORS headers on that reply, so the browser hides it from the page: the page sees `unreachable`, and the code shows only in the agent's own log.
- Nothing is simulated: the request goes to `http://127.0.0.1:7391` for real.
- With the agent running (`tools/piv-agent`) and a token or `--p12` file, the same button asks for the PIN in your system's dialog and downloads a PDF signed by your certificate.
- Your browser may first ask whether the page may reach apps on your device.

<LiveExample name="yubikey-sign" />

The form is [signed-intake.json](/forms/signed-intake.json){target="_blank"}: its layout ends in a `pdf-signature` block named `applicant-signature`.

### Two calls

Signing is done in two calls, so a private key never enters the sandbox and never has to be exportable.

1. The first call prepares the PDF and returns the exact bytes to be signed.
2. The signer, a server key, a hardware token or a key service, signs them.
3. The second call embeds the signature in the file.

A server host offers the same through its PDF routes: render, fill, sign and verify. The operations are in [Running the PDF program](/pdf-program#sign-complete-and-timestamprequest).

### Verifying

`POST /api/pdf/verify` on a built host takes the PDF's bytes and reports each signature:

- That the byte range frames the file.
- That nothing was appended after it (`coversDocument`).
- The digest.
- The certification level.
- Any timestamp.
- Whether the signer's certificate is trusted.

The host decides trust from the anchors you configure. For a record certified with `noChanges`, `coversDocument: true` is the check that nothing changed. The report's fields are in [Running the PDF program](/pdf-program#verify).

What the program checks, and what you must check:

- The program checks the structure, that the signed range hashes to the digest, and that the signature names its certificate. It does not check the signature value and does not decide trust. Check the value with the signer's public key over `toBeVerified`, and judge the certificate against your own anchors. Treating `digestMatches` as valid skips both.
- A signature with `coversDocument: false` has later updates. Read `laterRevisions`: for a certified document, `permitted` says whether the certification allows what changed, such as form filling or another signature. It holds only when every signature in `reliedOnSignatures` is itself valid by your checks. When `laterRevisions` is missing on such a signature, the changes could not be judged; treat the document as changed.
- Pass the certificates you already know, such as your timestamp authority's, as `knownCertificates` (at most 64, each at most 16 KiB), so a token that carries none can still name its signer. Knowing a certificate is not trusting it.

## Submission signatures

A submission is the answers as canonical JSON, so the same answers always give the same bytes. A passkey or security key signs a hash of those bytes before the form sends them, and the server recomputes the bytes and checks the signature.

[Signing a form with a passkey](/passkey-signing) has all of it: the form's settings, registering a passkey, the signed document, what the server checks, and the Spring Boot host that does the server side for you.
