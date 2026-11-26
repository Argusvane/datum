# Timestamp server

A timestamp is an RFC 3161 token from a timestamp authority. Placed in a PDF signature, it proves the PDF existed, signed, at that time, by a clock that is not the signer's own.

Timestamps are optional. They belong to [signed PDFs](/signing#pdf-signatures), and a signed PDF is valid without one. A host that renders, fills and signs PDFs can leave the whole of this page switched off. The one other use is a [timestamped receipt](#timestamping-a-receipt) for a submission, which is also yours to switch on.

There are two halves, and you can use either without the other:

| Half | What it does |
|---|---|
| Asking for a token | A PDF signature is being made, and whoever makes it asks a timestamp authority for a token over it. The authority can be one you already have, a public one, or the host's own. |
| Issuing tokens | The Spring Boot and FastAPI hosts each carry an RFC 3161 server. It answers the host's own seals and any other client you allow. |

## Asking for a timestamp

A signature says it wants a token, so that room is reserved for it, and something has to fetch the token.

| Who signs | Say it wants a token | What fetches the token |
|---|---|---|
| A built host sealing the PDFs it issues | `datum.pdf.seal.timestamp` | The timestamp source of the host, below |
| A layout's own signature | `"timestamp": true` in the layout's [`signature` settings](/signing#the-server-signs) | Whoever signs: the host, the page or your own server |
| The page, with the person's certificate | `timestamp: true` in `pdfSignature.settings` | The `timestamper` you give `pdfSignature` |
| Your own server, running the PDF program | `"timestamp": true` in the layout | Your server posts the request the program builds |

A timestamp that cannot be fetched produces a warning, never a failed PDF: the PDF is signed and carries no token. On a built host the sealed PDF carries the `sealing.timestamp` warning.

### On a built host

The host's seal takes its tokens from the first of these that is set up:

1. Your own timestamper: a `Timestamper` bean on Spring Boot, `Datum(timestamper=...)` on FastAPI.
2. A timestamp server you name, with `datum.pdf.signing.tsa.url`.
3. The host's own timestamp server, when it is on.

With none of them and `datum.pdf.seal.timestamp` on, the start warns (`datum.W011` on FastAPI).

A named server takes these settings. Spring Boot writes them with hyphens, FastAPI with underscores.

| Setting | Does |
|---|---|
| `datum.pdf.signing.tsa.url` | The address of the timestamp authority, `http` or `https` |
| `datum.pdf.signing.tsa.bearer-token` | A bearer token sent in the `Authorization` header. Never logged |
| `datum.pdf.signing.tsa.basic-user`, `.basic-password` | HTTP Basic credentials, set together or not at all |
| `datum.pdf.signing.tsa.policy` | The policy object identifier every request asks for, for a server that issues under several |
| `datum.pdf.signing.tsa.timeout` | How long one request may take, 10 seconds by default |
| `datum.pdf.signing.tsa.ssl-bundle` | Spring Boot only. The SSL bundle for the TLS connection: its trust store checks the server, and its key store, when it has one, presents a client certificate |

Two cases to know:

- **FastAPI, plain `http`.** A bearer token, Basic credentials or user-info in the address are refused for an `http` address that is not loopback.
- **Your own `timestamper`.** Setting an address or a policy while also passing it raises `datum.I002` or `datum.W012`, because the timestamper issues the tokens and the settings go unused.

### In the page

When the person signs in the page, `pdfSignature` carries a timestamper: an object with `timestamp(request)`, which posts the request bytes to a timestamp authority and returns its answer.

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

The host's own server refuses a request that carries a session cookie, so a page that asks it has to reach it without one. See [the routes](#post-tsa) below.

### On your own server

The PDF program builds the request and your server posts it. The `timestampRequest` operation takes the signature value and replies with the request bytes; post them with content type `application/timestamp-query` and hand the token to `complete`. [The PDF program](/pdf-program#sign-complete-and-timestamprequest) has the operation, and [Example: sign a PDF](/server-example-sign) does it end to end with `TSA_URL`.

## The host's own server

Both built hosts carry an RFC 3161 server. It is off by default, and while it is off its routes answer 404.

| | Spring Boot | FastAPI |
|---|---|---|
| Install | `datum-spring-boot-starter-timestamp` | The `timestamp` extra, `argusvane-datum-core[timestamp]` |
| Switch on | `datum.tsa.enabled=true` | `datum.tsa.enabled` and `datum.tsa.policy`, with `routers.tsa` included in the application |
| Signing key | `datum.tsa.signer.ssl-bundle`, a Spring Boot SSL bundle | `datum.tsa.signer.*`: a PKCS#12 file, or a PEM key and certificate chain |
| Policy | `datum.tsa.policy`, the Datum default when unset | `datum.tsa.policy`, required |
| Path | `datum.tsa.path`, `/tsa` by default | The `prefix=` of `routers.tsa` |

The Spring Boot starter is standalone: it can serve timestamps in an application that uses no other part of Datum.

### The signing key

The timestamp server signs with a key of its own, never the PDF seal's.

- **No key on Spring Boot.** With neither a bundle nor `self-signed`, every request is answered `systemFailure` and health is DOWN.
- **Self-signed.** `datum.tsa.signer.self-signed` (`self_signed` on FastAPI) makes a throwaway certificate at start. It is for development only: its tokens verify against no one.

When the key is replaced, list the certificates it replaced in `datum.tsa.retired-certificates`. They are served beside the current chain, so tokens issued under the old key can still name their signer.

### Who may ask

`datum.tsa.access` decides.

| Value | Who gets a token |
|---|---|
| `clients` (the default) | A caller that presents a registered client key, as a bearer token or as the password of HTTP Basic with any user name |
| `open` | Anyone, within the flood limits, which then count per address |

Client keys are kept as their SHA-256, never as the key.

- **Spring Boot.** They are the `datum.tsa.clients` list, or the `datum_tsa_client` table with `datum.tsa.client-store=jdbc`.
- **FastAPI.** They are the `datum.tsa.clients` list, or your own `tsa_client_store` with `datum.tsa.client_store = sql`.

Two limits apply whatever the access:

- `datum.tsa.flood.limit` is the number of tokens one client may have per `flood.window` (1,000 an hour by default).
- `datum.tsa.flood.failed-keys` is the number of wrong keys one address may present before it is answered 429 (10 by default).

### Policies and accuracy

Every token names the policy it was issued under, `datum.tsa.policy`. A request may ask for another policy with `reqPolicy` when that policy is in `datum.tsa.accepted-policies`, and the token then names the one asked for. Any other policy is refused with `unacceptedPolicy`.

`datum.tsa.accuracy` is the accuracy each token states, one second by default.

### Hooks

| Host | Hook | Does |
|---|---|---|
| Spring Boot | `TimestampRequestCustomizer` | Refuse a client, choose a policy among the accepted ones, state another accuracy |
| Spring Boot | `TsaKeyMaterial`, `TsaSerialAllocator`, `TsaClientStore` | The signing key, the serial numbers and the clients allowed to ask |
| FastAPI | `timestamp_request_customizers` | The policy hooks, run in order |
| FastAPI | `tsa_key_material`, `tsa_serial_allocator`, `tsa_log`, `tsa_client_store`, `tsa_time_source`, `tsa_transport` | The signing key, the serial numbers, the issue log, the clients, the clock and the transport of the client |

- **Spring Security.** `DatumRequestMatchers.tsa()` (`DatumExchangeMatchers` on WebFlux) matches the timestamp routes in your filter chain.
- **FastAPI.** The `tsa` router is the one factory that takes no `dependencies=`: its access is `datum.tsa.access`.

### More than one instance

Every token carries a serial number, and no two tokens may share one. The serials that ship are in memory, so the start is refused unless the stores are shared or you say there is one instance.

| | Spring Boot | FastAPI |
|---|---|---|
| Shared stores | A `DataSource` with the timestamp migration and `datum.tsa.client-store=jdbc`, or your own `TsaSerialAllocator` and `TsaClientStore` beans | `tsa_serial_allocator=`, `tsa_log=` and `tsa_client_store=` |
| One instance, acknowledged | `datum.tsa.allow-memory-stores=true` | `datum.tsa.allow_memory_stores`: without it the start stops (`datum.E001`), with it the start warns (`datum.W009`) |

[Server hosts](/server-hosts#running-more-than-one-instance) lists everything else that has to be shared.

## The routes

Both hosts answer the same routes with the same statuses. The refusals before the work are plain text, never the JSON error body the [other routes](/wire) use.

### POST /tsa

The body is a DER timestamp query, `Content-Type: application/timestamp-query` (`application/timestamp-request` is also accepted). The checks run in this order:

1. A request that carries a session cookie is 403, so a browser's ambient credentials can never ask. The cookies that count are `datum.tsa.session-cookies` or `datum.tsa.session_cookies` (FastAPI). Both default to `*`, which refuses any cookie. Name cookies instead to refuse only those.
2. A `Content-Type` other than the two above is 415.
3. With `access=clients`, the client key must come as a bearer token or as the password of HTTP Basic with any user name. A missing, unknown or revoked key is 401 with `WWW-Authenticate`. Past `flood.failed-keys` wrong keys from one address, the next attempt is 429.
4. More requests than `flood.limit` in the window is 429 with `Retry-After`.
5. A body over `max-request-size` (16 KiB by default) is 413.

| Status | Body |
|---|---|
| 200 | `application/timestamp-reply`: a DER `TimeStampResp` carrying the token. |
| 400 | A DER `TimeStampResp` that rejects the request (for example `badDataFormat` or `unacceptedPolicy`). |
| 401, 403, 413, 415, 429 | Plain text. 429 carries `Retry-After`. |
| 503 | A DER rejection (`systemFailure`) with `Retry-After`. |

### GET /tsa/certificate, GET /tsa/certificates

- `/certificate` is the signing chain, signer first, as PEM (`application/x-pem-file`). With `?format=der` it is the signer's certificate alone as `application/pkix-cert`.
- `/certificates` is the current chain followed by the retired certificates, all PEM.
- Both are public and `Cache-Control: no-cache`. 503 while the signing key is not set up.

## Timestamping a receipt

A submission can be timestamped too: a token over the accepted answers proves the server held exactly those answers at that time.

Neither host does this by itself. Your submission handler asks for the token and keeps it, with a helper each host ships, `ReceiptStatement`. The two helpers differ in what the token is taken over.

| | Spring Boot | FastAPI |
|---|---|---|
| The token is over | A statement of the submission: `digest`, `form`, `received`, `reference`, `serial` and `signature` (the passkey signature, or null), as canonical JSON (RFC 8785) | The submission's digest, the SHA-256 of the canonical answers |
| Make it | `new ReceiptStatement(form, reference, serial, received, digest, signature)` | `ReceiptStatement.of(accepted)` |
| Ask for the token | `timestamper.stamp(statement.bytes(), "receipt")`, which returns the DER reply | `statement.stamp(timestamper)`, which returns a `timestamp` member for the receipt |

On Spring Boot, keep `statement.canonical()` beside the token. The token's imprint is the SHA-256 of that text, so `openssl ts -verify -data statement.json` checks it with no Datum code.

On FastAPI, `stamp` returns the member to put in `SubmissionReceipt.receipt`:

```python
from datum_core.timestamp import ReceiptStatement


def keep(accepted: AcceptedSubmission) -> SubmissionReceipt:
    stamped = ReceiptStatement.of(accepted).stamp(timestamper)
    return SubmissionReceipt(id="...", reference="...", receipt=stamped)
```

```json
{ "timestamp": { "algorithm": "sha256", "imprint": "<hex>", "token": "<base64 DER>", "genTime": "<ISO 8601>", "serial": "<decimal>" } }
```

The timestamper is any of the three sources a seal can use:

- The host's own server: the `TimestampAuthority` bean on Spring Boot, `datum.timestamp_authority` on FastAPI.
- A client of a server you name.
- Your own.

A refusal reaches your handler as it was raised, and the handler decides whether the submission is then answered without a token or not at all.

- A retried submission is answered with the first receipt, so it carries the same token and the timestamper is not asked again.
- The host's own server records these requests under the `receipt` channel, apart from PDF seals and requests over HTTP.

## Verifying a timestamp

A token is checked when the PDF is verified, never taken on trust. The [verify report](/signing#verifying) gives each token's time, its authority, whether it covers the signature, and the token's own signature and signer.

- Pass your timestamp authority's certificates as `knownCertificates`, so a token that carries none can still name its signer. `GET /tsa/certificates` serves them for the host's own server. Knowing a certificate is not trusting it.
- An authority is `trusted` only when its certificate chains to one of the host's trust anchors (`datum.pdf.signing.trust-anchors`).
- A token that cannot be read, uses an unchecked digest algorithm, names a signer whose certificate is not held, or carries no signing-certificate attribute is reported as `signature.timestamp`.

## On an isolated network

A named public timestamp server cannot be reached from an isolated network. Leave `datum.pdf.signing.tsa.url` unset and switch the host's own server on, or name a timestamp server inside the network. [Air-gapped deployments](/air-gapped) covers the rest.

## Checking a host

The `tsa` group of [`datum-host-check`](/conformance#datum-host-check) holds a host's timestamp server to this page: a granted token, a rejection for unreadable bytes, 403 for a session cookie then 415, and the certificates in PEM and DER. `--tsa-path` says where the routes are.

## Every setting

| Host | The timestamp server | The client of a PDF signature |
|---|---|---|
| Spring Boot | [`datum.tsa.*`](/spring-boot-properties#timestamp-server) | [`datum.pdf.signing.tsa.*`](/spring-boot-properties#pdf) |
| FastAPI | [`datum.tsa`](/fastapi-settings#datum-tsa), [`.flood`](/fastapi-settings#datum-tsa-flood), [`.signer`](/fastapi-settings#datum-tsa-signer) | [`datum.pdf.signing.tsa`](/fastapi-settings#datum-pdf-signing-tsa) |
