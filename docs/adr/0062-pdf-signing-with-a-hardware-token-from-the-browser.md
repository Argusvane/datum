# ADR 0062: The local signing agent: hardware tokens and certificate files

## Status

Accepted.

## Context

ADR 0061 leaves the one operation a host keeps for itself — signing the DER attributes the kernel
prepares — to "platform crypto, a hardware token, a cloud KMS", and ships one signer,
`createWebCryptoPdfSigner`, over a PEM key. That covers a server sealing its own records. It does
not cover the person in front of the form signing with a certificate *they* hold — on a YubiKey's
PIV applet or in a certificate file. Nothing in the kernel, its ABI or its CMS changes for it.

A web page cannot reach that applet. WebAuthn speaks only to the FIDO applet and signs only
its own challenge format, never arbitrary bytes; WebUSB cannot claim a CCID interface the
operating system's smart card service already holds; there is no smart card API in browsers.
Every serious browser signing product — Fortify, the EU's DSS NexU, the national eID
middlewares — solves this the same way: a small native process on the person's computer,
bound to the loopback interface, that the page talks to over HTTP. That is the shape here.

Two constraints from the project: only official artifacts (Yubico's own `yubikey-manager`;
no OpenSC, no third-party PKCS#11 bindings), and the PIN must never enter the browser.

Many people who sign do not hold a token: they hold a certificate a CA issued them as a `.p12` /
`.pfx` bundle, a Keychain or Windows export of one, or a PEM key beside a PEM certificate — a
file on their desktop. The same agent can sign with that, and nothing in the kernel, its ABI, its
CMS or the engine's HTTP client protocol changes for it: the agent's `/certificates` and `/sign`
routes carry one pseudo-slot and two descriptive fields. Three ways are open.

- The browser could read the file itself and sign with `createWebCryptoPdfSigner`: no install, but
  the private key enters the page — the very thing this agent exists to avoid — and WebCrypto
  parses neither PKCS#12 nor an encrypted PKCS#8 key, so the common desktop formats would not
  work.
- A separate agent could serve files: a second process, a second port, a second allowlist for the
  same job.
- Or the existing agent could take a second backend beside the YubiKey.

The agent already hides the token behind a three-method `Backend` protocol that its tests satisfy
with a fake, and its certificate description takes any `cryptography` certificate; the engine's
client treats the slot id as an opaque string. The third way is the small one.

The guide, with the error codes and the file backend's behaviour, is
[`docs/pdf-rendering.md`](../pdf-rendering.md#signatures); the agent's own README holds the flags
and the platform prompt matrix.

## Decision

**1. A loopback agent, not a browser API.** `tools/piv-agent/piv_agent.py` runs on the person's
computer, listens on `127.0.0.1` (no flag opens another interface), and does the one thing the
page cannot: it holds the PIV session and signs. The page renders the PDF exactly as before; only
`toBeSigned` goes to the agent and only the value comes back. The agent never sees the PDF; the
page never sees the PIN or the key.

**2. Python over yubikey-manager and PyCA `cryptography`, the standard library, nothing else.**
`yubikit.piv`'s `PivSession` over PC/SC, which macOS, Windows and Linux (`pcscd`) provide. The
HTTP server is `http.server`; the one other library is PyCA `cryptography`, which
`yubikey-manager` already brings. RSA keys sign `toBeSigned` under `SHA256` + `PKCS1v15`; EC keys
under `SHA256` (the card's DER value, which the kernel accepts as it is). The module imports
without a YubiKey stack so its tests run anywhere.

**3. The same `PdfSigner`; the engine gains an HTTP client, not a dependency.**
`engine/form-engine/render/pdf/pdf-agent-signer.ts` adds `listAgentCertificates`,
`agentPdfSignerFor(entry)` and `createAgentPdfSigner({ url, slot })` beside
`createWebCryptoPdfSigner`, all over `fetch`, all returning the two-member `PdfSigner` the kernel
already consumes. The listed certificate carries its chain (DER base64, leaf first), so the
kernel derives the algorithm from it as ADR 0061 §1 says; the client refuses a slot the kernel
could not use before anything is asked of the token.

**4. Origin allowlist, one signature at a time, the browser's own loopback gate.** The agent
answers only origins it was started with (`--allow-origin`, defaulting to the Vite dev origins);
every request — preflights included — without an allowed `Origin` is refused with
`origin_denied` before anything else happens. Whether a public page may reach loopback at all is
the browser's decision, not the agent's: Chrome asks the person once per site, so a page makes
its first call to the agent from a click, never on load, and words a denied permission as an
agent that did not answer. One signature at a time (`busy` for a second one while the first waits
on the dialog); reads still answer meanwhile.

**5. The PIN in a native dialog that names origin, document and certificate — never stored,
never in the page.** The agent opens the operating system's own password prompt, naming the
requesting origin as read from the request header, the document's title / id / field when the
page gave them, the certificate's subject and slot, and a prefix of the digest of what is being
signed — the consent step for each signature. The text reaches the dialog through environment
variables or argv, never spliced into a script. Without a graphical prompt the agent falls back
to `getpass` in its own terminal. The PIN is deleted right after the card has seen it and never
logged.

**6. Slot 9c by default; unusable keys refused before the PIN.** The Digital Signature slot's PIN
policy is *always*, so every signature prompts — the right default for a signature that stands
for the person. Every slot holding a certificate is listed with its PIN and touch policies where
the firmware reports them; RSA-1024 (the kernel refuses values under 128 bytes), Ed25519 and
X25519 are listed `usable: false` with the reason, and a request for one is refused with
`unusable_key` before any prompt. A blocked PIN is reported without a prompt too.

**7. Errors as codes the page words.** The agent answers `{ error: { code, message,
attemptsRemaining? } }` with a matching HTTP status, and the client adds `unreachable` and
`protocol` for when nothing, or something else, answered. `PdfSigningAgentError` carries them;
the guide lists them all.

**8. The web component seam.** `DatumFormRendererElement`, `datum-form-host` and `<datum-form>`
gain `pdfSigner` (a `PdfSigner`) and `pdfSignature` (settings over the layout's `signature`
block, and a timestamper) as properties — never attributes; a key does not belong in markup. Set,
every `renderPdf` / `downloadPdf` that names no `signature` of its own is signed, the toolbar's
PDF button and a button's `pdf` action included, and refused rather than delivered unsigned when
the provider cannot complete a signature (ADR 0061 §13). The `datum-pdf` event's detail carries
`signature` when the file was signed, and `datum-form.js` exports the agent client so a page with
the bundle alone can use it.

**9. The key is used inside the agent, never in the page.** A certificate file is a second
backend of the same agent: `FileBackend`, given `--p12 FILE` for PKCS#12 or `--key PEM --cert
PEM` for a PEM pair. The page keeps talking to the same loopback URL, under the same origin
allowlist, and keeps receiving only the signature value. Nothing about the page changes because
the key sits in a file rather than on a token.

**10. The key is read, used and dropped for every signature.** At startup the backend reads only
the certificates; for each `/sign` it reads the file again, decrypts the key with the passphrase
the dialog just asked for, signs (the same algorithms and the same DER shape as the token path),
and deletes the key and the passphrase. The process holds no private key between two signatures.
An encrypted PKCS#12 keeps its certificate behind the passphrase too, so that one is asked once
at startup to read the certificate, then discarded; the PEM pair needs no startup prompt.

**11. The dialog is the consent boundary for every signature, file or token.** The same native
dialog names the origin, the document, the reason and the certificate — `(file signer.p12)` in
place of `(slot 9c)` — and its digest prefix. When the key is encrypted the dialog asks the
passphrase; when it is not, the dialog is a plain Sign / Cancel: a file with no passphrase does
not sign silently once the origin passes. The `Prompter` protocol gains `confirm(text, title)`
beside `ask_pin(text, title)`.

**12. One listing, one pseudo-slot.** A file is listed under the slot `file` (a PIV slot is two
hex digits, so nothing clashes), with `pinPolicy` `passphrase` or `never`; every entry — token or
file — carries `source` (`yubikey` | `file`) and a file entry carries `file`, the file's base
name. `KERNEL_ALGORITHMS` and `UNUSABLE` apply as they are: a P-521 or Ed25519 file is listed
unusable and refused before any prompt, exactly like a token slot. When both a YubiKey and a file
are configured a `CompositeBackend` serves one inventory and routes each slot to its owner; a
token unplugged does not hide the file. With a file given, the default slot becomes `file` unless
`--slot` says otherwise. A wrong passphrase answers `pin_invalid` with no `attemptsRemaining` — a
file has no lockout counter.

**13. No new dependency.** The file backend uses PyCA `cryptography`, which `yubikey-manager`
already brings; the agent runs a certificate file alone when `yubikey-manager` is not installed.
No PKCS#11, no OpenSC, no OS keychain access.

**14. The engine follows the listing.** `PdfSigningAgentCertificate` has the optional `source` and
`file` fields; `createAgentPdfSigner` without a slot still takes 9c, and when there is no 9c takes
the single usable certificate the agent lists (an agent run for a file alone), refusing with
`no_certificate` when several would do.

**15. A PIV signature carries two statements from the signer: a reason and a commitment type.**
The *reason* is a text the signing page supplies. It is written into the signature dictionary's
`/Reason` (covered by the byte range, shown in every viewer's panel) and shown by the agent's PIN
dialog as *You are signing: …* through the request context's `reason`, so the person reads what
the page will have them affirm at the moment they consent with the PIN. A **CAdES commitment
type** (`id-aa-ets-commitmentType`, ETSI EN 319 122-1) is `signature.commitment.type`
(`approval`, `origin`, `receipt`, `delivery`, `sender`, `creation`), with `statement` as a
qualifier under a Datum OID. It is appended to the signed attributes, so the key itself signs it,
and `verify` reads it back as `commitment`. The reason is words for the person and the viewer's
panel; the commitment is a machine-readable statement in the CMS that a verifier reads back. A
statement changed between `sign` and `complete` is refused when `complete` carries the handoff's
`toBeSignedDigest`, as `renderFormPdf` sends it, as is any change to the signed attributes;
without it the value no longer verifies. The layout's `signature` block and the PDF designer carry both
settings.

## Consequences

- The person's signature is a real PAdES signature under their own certificate, made on the
  token or from the file, with the kernel's structure and the host's verification unchanged from
  ADR 0061, the same page code, the same origin gate and the same dialog.
- Trust is the verifier's: the token holds only the leaf, so `--chain` is how the agent sends the
  issuers along.
- The agent is a program the person installs and runs, with Python on their machine. The browser
  caveats (Safari, Chrome's permission prompt) are in the agent's README, and the dialog's
  `unreachable` copy tells the person what to check.
- A key in a file is only as safe as the file: the agent never caches it, but it cannot make a
  file a token. The dialog and the origin allowlist bound *when* it is used, not *who* can copy
  it. The README says so.
- The agent's `unittest` suite runs with no hardware — a fake backend built from self-signed
  certificates and a scripted prompter — on the `piv-agent` CI job.
