# ADR 0063: WebAuthn-Signed Submissions: Passkeys and Security Keys as Signers, and What a Signer Says

## Status
Accepted.

## Context

ADR 0001 leaves the signing of a submission to an injected provider. A person's own credential
lives in a passkey or a FIDO security key, reached through WebAuthn, the one signing capability
every browser has. The canonical submission JSON should be signable with it, triggered from a
submit button or forced by the host for every submission.

What WebAuthn signs is fixed by the platform: an assertion covers `authenticatorData ||
SHA-256(clientDataJSON)` and nothing else, so it can never sign bytes of the page's choosing.

Yubico's guidance for signing with WebAuthn is to put the **hash of the document in the challenge**
and archive everything the ceremony returned: the public key from registration, the client data, the
authenticator data, the signature, a timestamp.

A verifier recomputes the hash, checks the archived challenge equals it, and verifies the assertion
with the registered key. What that proves: the holder of a registered authenticator approved exactly
this digest, with user presence, and with user verification when the flags say so. The W3C `sign`
extension for arbitrary data is a draft and is not relied on.

Two constraints from the project: only official artifacts, and a signature must never be
delivered unsigned by accident.

## Decision

**1. The archived assertion is the signature.** `WebAuthnAssertion` (core) keeps the credential id,
`authenticatorData`, `clientDataJSON`, the signature, the credential's user handle, the registered
public key (SPKI), the COSE algorithm, the relying party id, the origin and a timestamp, all
base64url as WebAuthn's JSON spells them.

- A `SignatureResult` made by the WebAuthn provider carries it as `webauthn`, with `algorithm:
  "webauthn-es256" | "webauthn-rs256"` and `signature` the assertion's own value.
- The challenge is SHA-256 of the signed canonical string (the engine core has a pure-TypeScript
  SHA-256, which the PDF kernel imports).

**2. A provider chosen per submission, and a button option.** `FormRuntimeDependencies` has
`signingProviders` beside the default `signingProvider`; `SubmitOptions.signWith` names one by id,
and a submission so named signs whether or not the mode's `sign` says so.

The `button` component has a `signature` option (`"webauthn"`; the builder offers *None* /
*Passkey*), emitted as `data-button-signature`, carried on `datum-form-action`, and passed by both
dispatchers (the host's own and `<datum-form>`'s) as `signWith`.

An id no provider carries is refused as `signing.providerMissing`; a provider that cannot sign (a
dismissed prompt, no token registered) fails the submission as `signing.failed` with the provider's
code, never an unsigned delivery.

**3. The host forces signing through the mode.** A submission mode with `sign: true` signs with
the default `signingProvider`; the host chooses which provider that is. A button naming another
provider still wins for its own submit.

**4. The signing format: scope, placement and canonicalization.** `SubmissionSigningFormat` says:

- what the signed bytes cover, `scope: "envelope"` (the canonical envelope without `signatures`, the
  default), `"submission"` (`{ locale, values }`) or `"values"`
- where the signatures land, `placement: "embedded"` (inside the envelope as `signatures[]`) or
  `"wrapper"` (the envelope untouched as the `payload` of a `SignedSubmissionDocument`)
- how the text is written, `canonicalization: "jcs"`, the only value.

`normalizeSigningFormat` builds the format to sign under from a host's options, and always writes
`digest: "sha-256"` and `canonicalization: "jcs"`, whatever the options say.

`signedCanonicalOf(document, scope, statement?)` is the one function signers and verifiers use;
`signatureFormatOf` / `signedCanonicalForSignature(document, signature)` rebuild one delivered
signature's text from its own format (else the wrapper's) and statement.

Every result is stamped with its `format`, so a verifier never guesses.

A delivered format is read strictly (`readSigningFormat`): a known scope and placement, `digest:
"sha-256"` and `canonicalization: "jcs"`. A signature whose format is anything else, or which has
none, is invalid, whatever its provider: no verifier can rebuild the text it covers, and calling it
merely unverifiable would let a forgery be stored as one.

Under `"wrapper"`, `SubmitResult.signed` is the document to deliver, `datum-submit` carries it as
`signed`, `download` saves it, and submission handlers get it beside the envelope. The runtime
resolves the format as the call's `signing` over the dependencies' `signing` over the default.

**5. The signed text is RFC 8785 (JCS).** `core/submission/jcs.ts` `canonicalizeJcs(value)` writes it: members sorted by UTF-16 code units and written one by one, never through a JavaScript object (an engine puts integer-like names such as `"2"` and `"10"` first whatever the sort said), numbers as ECMAScript writes them, strings escaped as `JSON.stringify` does, no whitespace; what JSON cannot hold is refused. A text any server can rebuild is the point: an order sorted with `localeCompare` is one no other language reproduces (`"a"` before `"B"`, `"text_1"` before `"text1"`), so it is never used for signed text. The rules and the shared vectors (`engine/tests/fixtures/jcs-vectors.json`) are in [docs/integration-recipes.md](../integration-recipes.md) ("Verifying a passkey signature in your own server"). The envelope's own serialization (`serializeCanonicalSubmission`, digests, files) is separate.

**6. The signing statement is signed with the answers.** The words the signer agrees to ("I confirm
these answers are true") travel as `SubmissionSigningOptions` (the format's parts plus `statement?:
string`), which `FormRuntimeDependencies.signing`, `SubmitOptions.signing` and `<datum-form>`'s
`signing` take; a call's statement replaces the host's, an empty string is none. With a statement
the signed text is `canonicalizeJcs({ "document": <the scoped part>, "statement": <the statement>
})`.

`SigningRequest.canonical` is that exact text and `SigningRequest.statement` the words (a provider
shows them, the WebAuthn provider records them); `SignatureResult.statement` carries them on every
signature, and the verifiers rebuild with each signature's own.

A changed or dropped statement fails the challenge check. The statement is not part of the format.

**7. User verification is configurable, recorded, and enforced only when required.**
Registration and signing each take `required | preferred | discouraged`. The verifier records the
UP and UV flags and the counter, and refuses only a missing UV when the policy in force is
`required`.

**8. A registration a server can verify.** `registerCredential` takes the server's challenge (else 32 random bytes) and a user handle of 1 to 64 bytes (a string is base64url, not UTF-8 text), and returns the credential record plus the `userHandle` and the `response` (`clientDataJSON`, `authenticatorData`, `attestationObject`, `transports`; base64url, with `authenticatorData` from `getAuthenticatorData()` and empty where the browser has none, which `verifyRegistration` refuses) a server needs; a page that is its own relying party stores the record without them. `verifyRegistration(result, { expectedChallenge, expectedOrigins, rpId, requireUserVerification })` checks the type, the challenge, the origin, that the ceremony did not run in a cross-origin frame (no `crossOrigin: true`, no `topOrigin`), the rpId hash, user presence (and verification when required), that the backup flags agree (no BS without BE), the attested-credential flag, that the attested credential id equals the record's `id`, and that the record's `publicKey` is ES256 on P-256 or RS256 of at least 2048 bits (matching its `algorithm`), the JVM host's policy, and returns a `RegistrationVerdict` (`valid`, `checks`, `flags`, `signCount`, `reason`).

There is no attestation judgement: attestation stays `none`, so the SPKI from `getPublicKey()` is trusted on first use, bound to the server's challenge and to the relying party.

**9. Discoverable signing.** `createWebAuthnSigningProvider({ discoverable: true, … })` signs with an empty `allowCredentials` when no credentials are listed, and the browser offers any passkey the visitor has for the rpId. The archived assertion then names the chosen `credentialId` and its `userHandle` but has no `publicKey` and assumes ES256 when the page did not know the credential, so a verifier uses the key and the algorithm it registered for that id (`publicKeyFor`), not the archived `algorithm`; a registered key given without an algorithm is read for its type (RSA RS256, EC ES256), and a listed credential with a key but no algorithm is labelled the same way at signing. A listed credential still narrows the prompt; without `discoverable` an empty list is `no_credentials`. WebAuthn does not tell "no passkey here" from "the prompt was closed" (a privacy rule): both are `NotAllowedError`, mapped to `cancelled`, after which a host offers to create a passkey and signs again.

**10. Signature required.** `<datum-form>` has `signWith` (`string | null`) and the `sign-with`
attribute: every submit (any submit button, Enter, a journey's last page, `submit()`,
`submitAndDownload()`) signs with that provider; a button's own `signature` option or an
explicit `submit({ signWith })` still wins. A missing provider refuses the submit as
`signing.providerMissing`, a provider that cannot sign fails it as `signing.failed`: never
delivered unsigned. The runtime has the same default: `FormRuntimeDependencies.signWith`.

**11. The server recipe is a guide, not a library.** A server rebuilds the signed text from the delivered document with RFC 8785, hashes it, compares it to the challenge and verifies the assertion with the registered key; the engine's `verifyWebAuthnSubmission` is the reference.

It holds the JVM host's policy: a signature made in a cross-origin frame, a BS flag without BE, or a key other than ES256 on P-256 or RS256 of at least 2048 bits is invalid, each with its own check (`crossOrigin`, `backupState`, `publicKey`). A credential `publicKeyFor` returns nothing for is not registered, and its signature is invalid whatever key the assertion carries; only without `publicKeyFor` does the archived key stand in, which proves possession of that key and no more. Each verdict says which key it used (`key: "registered" | "archived"`). A signature that cannot be read, or has no key, is an invalid verdict with its reason, and the other signatures are still checked; the verifier throws only without WebCrypto. The steps, with the library for each language, are in [docs/integration-recipes.md](../integration-recipes.md) ("Verifying a passkey signature in your own server").

**12. What the signature does not cover.** `WebAuthnAssertion.signedAt` and
`SignatureResult.signedAt` are when the page received the assertion.

They sit outside the canonical string whose SHA-256 is the challenge, so the signer's device vouches
for neither; a verifier treats them as the page's claim.

A host refuses a signature outside its signing window, or whose two copies of the time disagree by
more than a set skew, and for a time a third party vouches for it timestamps the receipt (RFC 3161) once
the submission is stored.

Nothing in the signed string is per submission: the same answers, statement and format give the same
canonical string and so the same challenge, so a server that refuses replays by digest also refuses
an honest second submission with identical answers (ADR 0064 keys a submission on a per-attempt key
for that reason).

**13. What a signer says on a PIV signature** (the reason and the CAdES commitment type) is decided with the signing agent: ADR 0062, decision 15, holds it.

**14. The relying party is the host's.** The engine registers no tokens and holds no relying-party
settings. A host that verifies a signed submission checks each WebAuthn property (type, challenge,
origin, relying party, presence, verification, signature) itself, or through
`@argusvane/datum-submissions`, which reports them one by one (ADR 0064).

**15. Gesture timing.** `navigator.credentials.get()` needs transient activation in some
browsers, and signing runs after validation, the sandbox and any server stage. A `NotAllowedError`
is worded as "try again right after clicking".

## Consequences

- A submission can be signed by the person with a credential they hold, verified by anyone
  holding the registered public key, in a format the host chooses and every signature names.
- The signature is not a CMS/CAdES signature and no PDF viewer or JWS library reads it; the
  recipe above, or the engine's verifier, does.
- A deployment keeps the credential records and the verification on its server.
- Attestation, AAGUID policy and counter policy are not judged: the record keeps the counter and
  the flags for a host that wants to.
