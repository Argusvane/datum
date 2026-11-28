# Signing a form with a passkey

A form can have the person sign their answers with a passkey or a security key when they submit. The signature is made with WebAuthn, the browser's own standard, so there is nothing to install and no certificate to issue. It proves that the holder of that passkey sent exactly these answers: change one answer afterwards and the signature no longer verifies.

This is a signature over the submission, not over a PDF. To sign a PDF, with the server's certificate or the person's own, see [Signing](/signing).

## How it works

1. **Register, once.** The person makes a passkey for your site. The browser keeps the private key, and your server keeps the public key.
2. **Sign, at submit.** A submission is the answers as canonical JSON, so the same answers always give the same bytes. The passkey signs a hash of those bytes before the form sends them. The person sees the browser's own prompt: a fingerprint, a face, a PIN or a touch of the key.
3. **Verify, on the server.** The server recomputes the bytes from what arrived and checks the signature against the public key it registered.

Nothing is delivered unsigned: a submit that should be signed and cannot be is refused in the page.

There are two ways to set it up.

| Way | Registration, storage and verification | Read |
|---|---|---|
| The Spring Boot host | The host's: passkey routes, stores, and a check of every signed submission as it arrives | [With the Spring Boot host](#with-the-spring-boot-host) |
| Your own page and server | Yours, with the functions `datum-form.js` exports | [On your own page](#on-your-own-page) onward |

## With the Spring Boot host

Add `datum-spring-boot-starter-webauthn`, set the site's relying party and origins, and say which forms sign.

```yaml
datum:
  webauthn:
    enabled: true
    rp-id: example.org
    origins: [https://forms.example.org]
    secret: "${DATUM_WEBAUTHN_SECRET}"
    forms:
      intake:
        mode: required
```

| Property | Does |
|---|---|
| `datum.webauthn.rp-id`, `origins` | The registrable domain passkeys are bound to, and the exact origins a page may sign from. Until both are set the routes answer 503 `signing.not_set_up` |
| `datum.webauthn.secret` | The key of registration challenges: at least 32 bytes, and the same on every instance |
| `mode` | `off`, `optional` (a person may sign) or `required` (a person must) |
| `unavailable` | What a required form does with a browser that has no passkeys: `refuse` it, or `accept` it unsigned. With `accept` the browser's own request says it has no passkeys, and the server cannot verify that claim: anyone can send it, so a form that must always be signed uses `refuse` |
| `scope`, `placement`, `user-verification`, `statement` | What is signed and how, as in [the form's settings](#on-your-own-page) below |
| `verify` | Whether a signature that cannot be verified refuses the submission. An invalid one always does |
| `datum.webauthn.anonymous` | Let people who are not signed in make passkeys and sign |
| `datum.webauthn.passkeys` | `site`: a passkey signs for every form. `form`: only for the form it was made on |

The rows from `mode` to `verify` are set for every form under `datum.webauthn.*` and per form under `datum.webauthn.forms.<key>.*`. Every property is on [Spring Boot properties](/spring-boot-properties#passkeys).

In the page, one call wires the form to the host:

```html
<datum-form id="f" src="/api/forms/intake/definition"></datum-form>
<script type="module" src="/datum/assets/datum-host.js"></script>
<script type="module">
  await DatumHost.load({ bundle: "form" });
  const form = document.getElementById("f");
  const passkeys = await DatumHost.passkeys(form, { formKey: "intake" });
  DatumHost.submit(form, { headers: passkeys.headers });
</script>
```

`DatumHost.passkeys` reads which passkeys the person has and what the form signs, gives the element its signing provider, and offers to make a passkey when the person has none. Passing its `headers` to `submit` lets a browser without passkeys say so to a form that accepts that. The browser asserts it and the server cannot verify it, so a client that wants to skip the signature can send the same header on a form set to `accept`. [Server hosts](/server-hosts#the-page-glue) lists the call's options and what it resolves with.

When a signed submission arrives, the host verifies it and records the result on the submission. It also refuses:

- A replayed signature.
- A counter that went backwards.
- A signature that arrived outside its time window (`datum.webauthn.window`, ten minutes by default).

Beyond that:

- **The routes** a page can call itself, to register, list, remove and test passkeys, are on [the wire](/wire#passkeys).
- **More than one instance** needs shared stores for the passkeys, the replay guard and the challenges. Without them the start is refused unless `datum.webauthn.allow-memory-stores` says there is one instance. See [Server hosts](/server-hosts#running-more-than-one-instance).
- **Hooks**: `RegistrationCustomizer`, `RegistrationValidator` and `SignatureCheckCustomizer`, which can only tighten a form's signature check. See [Spring Boot](/spring-boot).

The FastAPI host serves no passkey routes and does not verify submission signatures, so a form cannot require a passkey there. Use the functions below with your own storage.

## On your own page

The form signs with a provider the page gives it. Three settings on the element say what is signed and with which provider.

| Setting | Values | Effect |
|---|---|---|
| `signing-scope` | `envelope` (default), `submission`, `values` | What is signed: the whole envelope, its submission block, or the answers alone |
| `signing-placement` | `embedded` (default), `wrapper` | Whether the signatures sit inside the envelope or beside it |
| `sign-with` | a provider id | The provider every submit signs with. An id with no provider refuses the submit |

The `signing` property sets the same and one more thing, `statement`: the words the signer agrees to, signed with the answers and recorded on each signature.

- `submit({ signWith, signing })` sets them for one call.
- These need `signing` in the `features` list when one is given.

The page supplies the provider in script. Its code loads as a separate file, `datum-form-webauthn-*.js`, only when a provider is set; keep it beside `datum-form.js`.

```html
<datum-form id="consent" src="/forms/consent.json" signing-scope="submission" sign-with="webauthn"></datum-form>
<script type="module">
  import { createWebAuthnSigningProvider } from "./datum-form.js";
  document.getElementById("consent").signingProviders = [
    createWebAuthnSigningProvider({ rpId: "forms.example.org", discoverable: true })
  ];
</script>
```

With a bundler, import the same names from `@argusvane/datum`. A button component can also ask for the signature itself: set its `signature` to the passkey option, which signs with the provider whose id is `webauthn`.

A submit is refused in two cases:

- It names a provider nobody registered: `signing.providerMissing`.
- Its provider fails: `signing.failed`, with the provider's own code in `errorCode`.

Nothing is delivered unsigned.

## Provider options

`createWebAuthnSigningProvider(options)`:

| Option | Meaning | Default |
|---|---|---|
| `rpId` | The relying party id: the page's host, or a registrable suffix of it. Required | None |
| `id` | The provider id that `sign-with` and a button name | `webauthn` |
| `credentials` | A function returning the person's registered credentials, each `{ id, transports?, algorithm?, publicKey? }` with `id` in base64url. Read at each submit. Required unless `discoverable` | None |
| `discoverable` | With no credentials listed, let the browser offer any passkey the person has for the site. The server then finds the key by the credential id in the signature | `false` |
| `userVerification` | `required`, `preferred` or `discouraged` | `preferred` |
| `timeout` | Milliseconds the prompt waits | 120000 |
| `participantId` | Who the signature is attributed to | The first declared participant, else `submitter` |
| `onSigned` | Called with what the authenticator returned, so a store can record the use and the counter | None |

## Registering a passkey

A passkey is registered once, and the server keeps its public key. `registerCredential` creates it in the browser and returns the record to keep.

```js
import { registerCredential } from "./datum-form.js";

const record = await registerCredential({
  rpId: "forms.example.org",
  rpName: "Example forms",
  user: { id: "dXNlci0xMjM", name: "ada@example.org", displayName: "Ada" },   // id: a handle of 1 to 64 bytes, base64url, never an email
  name: "Ada's laptop",
  challenge: serverChallenge,       // base64url, at least 16 bytes; left out, a random one
  residentKey: "required"           // so a discoverable provider can find it
});
// Keep { id, publicKey, algorithm, signCount, transports, … } for this user.
await fetch("/passkeys", { method: "POST", body: JSON.stringify(record) });
```

| Option | Meaning | Default |
|---|---|---|
| `rpId`, `rpName`, `user`, `name` | The relying party, the person (`id`, `name`, `displayName`) and what the person calls this token | Required |
| `challenge` | The server's challenge, so it can check the registration | 32 random bytes |
| `userVerification` | `required`, `preferred` or `discouraged` | `preferred` |
| `authenticatorAttachment` | `platform` or `cross-platform` | Either |
| `residentKey` | `required`, `preferred` or `discouraged`. Use `required` for signing with `discoverable` | `preferred` |
| `excludeCredentials` | Credentials already registered, `{ id, transports? }`, so one authenticator is not registered twice | None |
| `timeout` | Milliseconds | 120000 |

It resolves with the record:

- `id` (base64url), `name` and `publicKey` (SPKI, base64).
- `algorithm`: -7 ES256 or -257 RS256.
- `transports`, `attachment` and `signCount`.
- `flags`: `userVerified`, `backupEligible`, `backedUp`.
- `createdAt`.
- For the server's checks, `userHandle` and `response` (`clientDataJSON`, `authenticatorData`, `attestationObject`, `transports`).

A server that handed out the challenge checks the registration with `verifyRegistration(result, { expectedChallenge, expectedOrigins, rpId, requireUserVerification })`, where `result` carries the `id`, the `publicKey` (and the `algorithm`, when known) and the `response`. It returns:

- `valid`.
- Per-check `checks`: `type`, `challenge`, `origin`, `crossOrigin` (not made in a cross-origin frame), `rpId`, `userPresent`, `userVerified`, `backupState` (not backed up without being backup eligible), `attestedCredential`, `credentialId`, `publicKey` (ES256 on P-256, or RS256 of at least 2048 bits, matching `algorithm`).
- A `reason`.

The attestation itself is not judged. A page that is its own relying party stores the record without `response` and `userHandle`.

Then sign. The `credentials` option reads the stored list:

```js
const credentials = () => [{ id: record.id, transports: record.transports, algorithm: record.algorithm, publicKey: record.publicKey }];
consent.signingProviders = [createWebAuthnSigningProvider({ rpId: "forms.example.org", credentials })];
```

## The signed document

Under `embedded` placement the signatures ride on the envelope the form delivers.

```json
{
  "versionContext": { "form": { "id": "consent", "version": "1" }, "client": { "runtimeVersion": "…", "rendererVersion": "…", "schemaVersion": "…" } },
  "submission": { "locale": "en", "values": { "agree": true } },
  "signatures": [
    {
      "participantId": "submitter",
      "algorithm": "webauthn-es256",
      "signature": "MEUCIQ…",
      "signedAt": 1794998400000,
      "format": { "scope": "submission", "placement": "embedded", "digest": "sha-256", "canonicalization": "jcs" },
      "statement": "I confirm these answers.",
      "webauthn": {
        "credentialId": "AbC…", "authenticatorData": "SZYN…", "clientDataJSON": "eyJ0…", "signature": "MEUCIQ…",
        "userHandle": null, "algorithm": -7, "rpId": "forms.example.org", "origin": "https://forms.example.org", "signedAt": "2026-11-14T12:00:00.000Z"
      }
    }
  ]
}
```

Under `wrapper` placement the envelope is untouched and the page delivers `detail.signed` from the `datum-submit` event instead: `{ "format": { … }, "payload": <the envelope>, "signatures": [ … ] }`. Send `detail.signed ?? detail.submission`.

- `algorithm` is `webauthn-es256` or `webauthn-rs256`; the inner `algorithm` is the COSE number, -7 or -257. A listed credential with a `publicKey` but no `algorithm` is labelled by its key's type. A discoverable signature from a credential the page did not know is labelled ES256, and the verifier takes the algorithm from the key it registered.
- `publicKey` appears inside `webauthn` when the page knew the credential's key.

What is hashed depends on `format.scope`, and each is written as RFC 8785 canonical JSON:

- The envelope without its `signatures`.
- Its `submission` block.
- Its `values`.

With a statement, the text is `{ "document": <that part>, "statement": <the words> }`. The SHA-256 of that text is the challenge the authenticator signed.

## What the server checks

The server rebuilds the signed bytes from the document, hashes them and checks, one by one:

- The type.
- The challenge.
- The origin, and that the signature was not made in a cross-origin frame (`crossOrigin: true` or a `topOrigin` is refused).
- The relying party id.
- That the person was present.
- That the person was verified, when it requires that.
- That the backup flags agree: a credential is not backed up without being backup eligible.
- The key: ES256 on P-256, or RS256 of at least 2048 bits.
- The signature against the registered key.

A host also refuses a replayed assertion, a counter that went backwards and a signature that arrived outside its time window. `verifyWebAuthnSubmission` runs the checks in your own code, in a browser or wherever WebCrypto exists, and returns one verdict per WebAuthn signature on the document.

```js
const verdicts = await verifyWebAuthnSubmission(document, {
  expectedOrigins: ["https://forms.example.org"],
  rpId: "forms.example.org",
  publicKeyFor: (credentialId) => keys.get(credentialId),   // { publicKey, algorithm? } the user registered; undefined: not registered, so invalid
  requireUserVerification: true
});
if (!verdicts.length || !verdicts.every((verdict) => verdict.valid)) reject();
```

| Verdict field | Meaning |
|---|---|
| `valid` | Every check passed |
| `checks` | `type`, `challenge`, `origin`, `crossOrigin`, `rpId`, `userPresent`, `userVerified`, `backupState`, `publicKey`, `signature`: each true or false, so a failure says why |
| `reason` | The first check that failed, in words |
| `key` | The key the signature was checked with: `registered` (from `publicKeyFor`) or `archived` (the one in the signature, only without `publicKeyFor`). Absent when there was none |
| `flags`, `signCount` | The authenticator's flags and counter. A counter that went backwards is yours to refuse |
| `participantId`, `credentialId`, `algorithm` | Who signed, with which credential |
| `format`, `statement` | The scope and placement the signature was made under, and the words it covers |

A signature whose format is missing or unreadable is invalid. So is one whose credential `publicKeyFor` returns nothing for: the credential is not registered, and the key archived in the signature does not stand in. When `publicKeyFor` gives a key without an `algorithm`, the key's type says it (RSA RS256, EC ES256). Without `publicKeyFor`, the key archived in the signature is used (`key: "archived"`), which proves only that the signer holds that key, not that it is the person's registered one; a host that trusts only its own keys requires `key: "registered"`.

A signature that cannot be read, or that has no key to check it with, gets an invalid verdict with its reason, and the other signatures are still checked. `verifyWebAuthnSubmission` throws only when there is no WebCrypto.

## Errors

A ceremony that fails throws a `WebAuthnError` with a `code`, and `describeWebAuthnError(error)` words it for the person.

| Code | Meaning |
|---|---|
| `cancelled` | The prompt was dismissed, timed out, or could not open. WebAuthn does not say whether the person had no passkey or closed the prompt, so offer to create one |
| `unsupported` | The browser or device has no WebAuthn, or not the feature asked for |
| `security` | The `rpId` does not match the page's origin, or the page is not on HTTPS. The most common first failure |
| `in_use` | The authenticator already holds a credential for this user (registration) |
| `aborted` | The ceremony was aborted |
| `no_credentials` | No credential is registered to sign with, and `discoverable` is off |
| `protocol` | The answer could not be read as WebAuthn's |
| `invalid` | An assertion did not verify |

## In an iframe

Signing from inside a cross-origin frame needs `allow="publickey-credentials-get"` on the `<iframe>`. See [In an iframe](/iframe). The browser then writes `crossOrigin: true` into the signature, and `verifyWebAuthnSubmission`, `verifyRegistration` and the Spring Boot host refuse it: a signature that must verify is made in a top-level page, or in a frame of the same origin as every page around it.

## Leaving it out

The passkey code is a separate file, `datum-form-webauthn-*.js`, loaded only when a provider is set. A page that lists `features` must include `signing` to use it. See [Leaving parts out](/leaving-parts-out).
