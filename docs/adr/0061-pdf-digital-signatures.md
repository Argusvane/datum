# ADR 0061: PDF Digital Signatures — The Server's Seal on Its Own Record

## Status

Accepted.

## Context

A server that validates a submission and renders it as a PDF (ADR 0043) needs to sign that PDF. The
goal: the server seals the record it produced so that anyone — a PDF viewer's signature panel,
veraPDF or pyHanko, the server itself later — can validate the signature and know the file is the
server's unaltered output, an *authenticated submission*. The host owns the private key and
certificate; the signature must be what the standards ask (ISO 32000-2 §12.8, PAdES per ETSI EN 319
142-1) and must not break PDF/A.

Two facts about the kernel shape the design. The host boundary is string in, string out —
`__datum_pdf(requestJson)` — with no host imports: the servers run the official `qjs-wasi.wasm` as
a CLI per request (ADR 0043), and adding crypto to the WebAssembly would mean a custom QuickJS
build, which the project does not do. And the program has no `crypto`, `Date` or `Math.random`, by
design (ADR 0043 §3): the same request yields the same bytes on every host.

So the private-key operation could either run inside the sandbox in interpreted JavaScript — a
BigInt RSA, the key crossing into the request beside plugin renditions — or stay with the host,
which has platform crypto and, often, a key that is not exportable at all.

What a PDF signature needs, apart from the one modular exponentiation, is byte work: a field with
a `/V` dictionary whose `/ByteRange` and `/Contents` hold fixed-width placeholders, the file saved
with them, the range patched, the file hashed around the placeholder, a CMS `SignedData` with signed
attributes assembled in DER, and the value written back in hex. `@cantoo/pdf-lib` has what that
takes — incremental saves that append to the original bytes with a `/Prev` trailer,
`PDFInvalidObject` for a verbatim placeholder, `/Type /Sig` dictionaries kept out of object
streams — and no signing of its own. The monorepo's ASN.1, X.509 and CMS code is the kernel's own,
because the libraries that do it (pkijs, node-forge) need WebCrypto or `Date` and would not fit the
program's budget; the kernel carries a pure-TypeScript SHA-256 (and SHA-1, SHA-384, SHA-512 for
what `verify` must check).

The guide, with the profile, the certification rules, the report and the classifier in full, is
[`docs/pdf-rendering.md`](../pdf-rendering.md#signatures).

## Decision

1. **Two calls, the kernel doing everything but the signature primitive.** The shape the EU's
   Digital Signature Service uses (`getDataToSign` → external signing → `signDocument`), and the
   shape every serious PDF signing stack has for a key in an HSM, a PKCS#11 token or a cloud KMS.
   `sign` (or `document` / `render` / `fill` with a `signature`) takes the certificates and the
   settings, adds the field and the dictionary as an incremental update, patches the `/ByteRange`,
   hashes the file and answers with the prepared bytes and a `signing` handoff whose `toBeSigned`
   is the DER `SET OF` signed attributes. The host signs `toBeSigned` with its platform crypto —
   two to four lines in every language, no PDF or CMS code. `complete` takes the prepared bytes
   and the value, recomputes the digest and the attributes from the bytes (a changed input or
   certificate is refused before anything is embedded when `complete` carries the handoff's
   `toBeSignedDigest`, as `renderFormPdf` sends it; without it the changed attributes sign
   nothing the key saw and the signature does not verify), assembles the CMS and writes it into the
   placeholder. The private key never enters the sandbox, and never has to be exportable.

2. **PAdES-B-B by default, the older Adobe profile on request.** `/SubFilter
   /ETSI.CAdES.detached`, signed attributes contentType, messageDigest and signing-certificate-v2,
   no signingTime attribute — the claimed time is the dictionary's `/M`, from `env.createdAt` —
   and the ESIC extension declared on a 1.x file, as iText and pyHanko do. `adbe.pkcs7.detached`
   adds the signingTime attribute. SHA-256 only; RSASSA-PSS keys and other curves are refused with
   `signature`.

3. **An incremental update, never a rewrite.** `save()` appends only the objects touched with a
   `/Prev` trailer; the original bytes stay byte for byte, so an earlier signature's range still
   hashes. The field is reached through the catalog's AcroForm and the page's `/Annots` directly —
   never `getForm()` (it strips XFA) nor `addAnnot()` (its normalisation rewrites the page's
   content streams). A file with a prepared, uncompleted signature is refused until completed.

4. **A generic appearance by default.** It is drawn with an embedded font and DeviceRGB alone, the
   way the PDF/A pass expects one, and `appearance: false` makes an invisible signature. The
   widget carries `/TU` and `/Contents`, so a screen reader announces who signed and when.

5. **Certification through DocMDP.** `certify` writes the `/Reference` with `/TransformMethod
   /DocMDP` and `/P` 1, 2 or 3 and the catalog's `/Perms`, with no `DigestMethod`: ISO 32000-2
   deprecated it and PDF/A (19005-3 §6.1.12) forbids it under DocMDP. A certification must be the
   document's first signature; a file certified with no changes allowed refuses any further one;
   a file under P=2 or P=3, or with approval signatures, takes another approval signature. The
   server samples default to `noChanges`: the strongest "unaltered record" claim.

6. **`verify` splits the duties.** The kernel reports what it can read without a key, and the host
   verifies the value with its platform crypto and decides trust — for its own records, by
   comparing the certificate with its own. A host reads one report and carries no PDF, CMS or
   ASN.1 code of its own. The report covers the signature, the timestamp whole, the signed
   revision beside the file as it is now, the file's identity, where the signer certificate came
   from and which signatures were found, including those no field links; a signature the file
   merely mentions in its bytes is read from the revision it signed, so a later update cannot
   hide one by unlinking it.

7. **`laterRevisions`: what changed after the signature.** For a signature that does not cover
   the whole file the kernel lists every object the later updates added, changed or freed,
   classified by kind, and whether the certification's DocMDP level permits it (ISO 32000-1
   §12.8.2.2, with PAdES's DSS addition). P=1 allows nothing, so even a later DSS breaks it here
   (a host that treats LTV material under P=1 differently reads the kinds). `info` is deliberately
   never permitted: Acrobat reports an Info dictionary or XMP metadata changed after
   certification as a disallowed change under P=2 and P=3, and a host laxer than the viewer its
   users open the file in would tell them it is intact when the viewer says it is not. The kernel
   does not turn this into a verdict about the file; the host maps `permitted` and the signature
   check onto its own states. **A host fails closed**: a `verify` that throws, or a signature with
   `coversDocument: false` and no `laterRevisions`, is changes the host cannot judge, never a
   pass. A certification is intact only if every signature in `reliedOnSignatures` is itself
   valid as the host checks it; the program verifies none.

8. **The classifier reads as a reader does, and does not trust the attacker's structure.** Later
   revisions are classified against an adversary who plants decoys. It resolves objects as a
   reader does (the last `startxref`, the `/Prev` chain, the newest entry), and anything it cannot
   resolve that way — a loop, a bad offset, a parse failure, a cap, encryption — makes the
   analysis undecidable, never partial. Roles come from the signed revision, so an update cannot
   make an existing object pass for something form filling may change. A new signature field is
   permitted only when a new signature dictionary seals its update, and a later signature vouches
   only for objects its own update wrote. The file is loaded twice (the signed revision and the
   whole), which a large file pays for.

9. **Policy on the layout, the key with the host.** A `signature` block on a generated or template
   layout says how its documents are sealed, the way `conformance` says what they declare (ADR
   0059 §1); the certificates and the key are the host's. The model carries it as
   `PdfDocument.signature` and `PdfFillPlan.signature`; `document` merges it under the request's
   `signature`, key by key, the request winning and the certificates coming from the request
   alone. A layout that asks and a request that brings no certificates is produced unsigned with
   `signature.noCertificates` — or refused, under `required`.

10. **A `pdf-signature` layout component.** A block the layout places on its own: a named
    signature field with a caption, or `mode: "line"` for a ruled line to sign with a pen. It
    renders as a `widget` block of kind `signature` with no bound component; a signature widget
    also reaches a generated PDF through a form `signature` component bound by a `pdf-field`.

11. **The timestamp seam (PAdES-B-T).** `timestampRequest` builds the RFC 3161 `TimeStampReq` over
    a signature value (SHA-256 imprint, certificate requested, no nonce — the sandbox has no
    randomness, and a nonce is optional); the host posts it to its authority; `complete` takes
    the token as `signing.timestamp.token`, checks it vouches for this very value, and embeds it
    as the unsigned `signatureTimeStampToken` attribute.

12. **Hygiene, not policing.** `sign` warns — never refuses — about a certificate expired,
    expiring soon or not yet valid at `env.createdAt`, and about a chain that names no issuer for
    the leaf, because the host chose the certificate. The kernel's parsers carry hard limits
    against hostile input instead.

13. **The engine seam and the event.** `PdfRenderProvider` has the four signing operations.
    `PdfSigner` (certificates plus `sign(toBeSigned, algorithm)`) and `PdfTimestamper` are the
    host's two functions, `createWebCryptoPdfSigner` and `createFetchTimestamper` ready-made.
    `renderFormPdf(runtime, deps, { signature: { signer, settings?, timestamper? } })` does the two
    (or three) calls and publishes `PDF_SIGNED` on the runtime's event bus, carrying what was
    signed and how and never the bytes, the attributes or the value. A provider that lacks the
    operations, or `complete`, is refused rather than let deliver an unsigned file.

## Consequences

- A server seals its records with its own certificate, with two to four lines of platform crypto
  and no PDF or CMS code; the PDF is what ISO 32000-2 and PAdES describe and what viewers
  validate; a PDF/A record stays PDF/A.
- The submission attached under PDF/A-3 (ADR 0059 §8) lies inside the signed range: the
  signature binds the JSON the record was made from, the way the Factur-X hybrid invoice is
  built; `verify` reports its digest.
- Prepared bytes are byte-identical on every host; completed bytes are too under RSA PKCS#1
  v1.5, while ECDSA values differ per run by nature. The release gate probes `render` only;
  signing determinism is held by the kernel suite.
- A sealed PDF is immutable: a correction is a new sealed document naming the old `/ID`.
