# Example: sign a PDF on the server

A record the server produced should say so in a way anyone can check. In this example the server's copy of the form carries a sealed layout: the form's components with a signature block at the foot, and signature settings that say how the record is sealed.

1. The page delivers the envelope.
2. The endpoint validates it with the sandbox program.
3. The endpoint has the PDF program render the layout and prepare a PAdES signature.
4. The program never sees the key: it hands back the bytes to sign, the server signs them with its own key, and the program embeds the value.
5. The page then sends the file back to a second endpoint for the server's verdict on it.

## The page

There is no server behind these docs. The result under the code is answered by a stand-in in the browser that runs the same programs, from the same built files, over the same form. The endpoint files further down are what a real server runs.

The stand-in signs for real. When the example loads, it makes its own throwaway key pair in the browser and a self-signed certificate for "Intake service (demo)", and signs with those.

- The key never leaves the page, and a reload makes a new pair.
- No PDF viewer trusts the certificate, so a viewer will say the signer is unknown.
- A real server signs with its own certificate and keeps its key to itself, in a file, a hardware token or a key service.

<LiveExample name="server-sign" />

Fill in a name and submit. The signed PDF appears under the form with a link to save it, and the verdict of `/api/submissions/verify` above it. The verdict shows:

- The signature field and the signer.
- Whether the digest, the certificate binding and the signature value check out.
- Whether the signature covers the whole file.
- Whether the signer is this server.

Save the file and open it in a PDF viewer to see the signature panel; the viewer reports the signer as unknown, which is right for a certificate made a moment ago in your browser.

## What the server keeps

The page loads the plain form. The server's copy of the definition is the same form with the sealed layout `sealed-record` added: [customer-intake-sealed.json](/forms/customer-intake-sealed.json){target="_blank"}. Its signature settings are:

```json
{ "signature": { "field": "server-signature", "certify": "noChanges", "reason": "Received and validated by the intake service", "location": "Ottawa" } }
```

The layout ends in a `pdf-signature` block named `server-signature`, which is where the visible signature goes. See [Signing](/signing) for every key of the signature block.

## The endpoint

Each file is complete. Its first lines say what to install, how to fetch the engine, a WASM build of a JavaScript engine (`qjs-wasi.wasm`), from its release page, and how to make a self-signed certificate to try with. Beside it the server keeps:

- Both programs from the bundle folder.
- Its copy of the form at `forms/customer-intake.json` (the one with the sealed layout).
- The fonts at `fonts/`.
- Its key and certificate chain at `keys/signer.key.pem` and `keys/signer.cert.pem`.

### Python (FastAPI)

::: code-group

<<< @/snippets/server/sign/main.py{python} [main.py]

:::

### Java (Spring Boot)

::: code-group

<<< @/snippets/server/sign/Application.java{java} [Application.java]

<<< @/snippets/server/shared/pom.xml{xml} [pom.xml]

:::

### C# (ASP.NET Core)

::: code-group

<<< @/snippets/server/sign/Program.cs{csharp} [Program.cs]

<<< @/snippets/server/shared/intake.csproj{xml} [intake.csproj]

:::

### Node.js (Express)

::: code-group

<<< @/snippets/server/sign/main.mjs{js} [main.mjs]

<<< @/snippets/server/shared/qjs.mjs{js} [qjs.mjs]

:::

## What to notice

- **Two calls to the program.** The `document` operation renders the record and prepares it in one call: the signature field, the `/ByteRange` placeholder, and the signed attributes in `signing.toBeSigned`. The `complete` operation embeds the signature value. Between them is the one step the server keeps for itself.
- **The key stays with the server.** The server signs `toBeSigned` with its platform's crypto. A hardware token or a key service can sign the same bytes, or `toBeSignedDigest`, their SHA-256, instead. Only the certificates go into the request.
- **The layout says how, the server may override.** `CERTIFY` left empty keeps the layout's certification, which allows no further change. Set it to `false` for an approval signature, or to `formFilling` to allow form filling after the seal.
- **A timestamp, if you want one.** With `TSA_URL` set, the program builds an RFC 3161 request, the server posts it to the authority, and the token goes into the signature. Give the layout `"timestamp": true` so the placeholder has room for it.
- **Verifying is the program's and the server's.** The `verify` operation checks each signature's structure, digest and certificate binding. The server checks the signature value under the signer's public key, and calls a signer it knows `trusted` only when the certificate is its own.

## Next

- Why these endpoints are short, and what they skip: [Example: validate on the server](/server-example-validate#simple-on-purpose).
- Signing in the browser, by the person, and signing the submission itself: [Signing](/signing).
- The record without a seal: [Example: render a PDF on the server](/server-example-pdf).
- The PDF operations a host can call: [Running the programs on your own server](/server-programs).
