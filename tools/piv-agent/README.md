# datum-piv-agent

This tool lives in the repository only: it is not published to PyPI, and you run it from a checkout. It carries the
repository's 0.1.0 version.

Signs a Datum PDF with the certificate on a YubiKey's PIV applet, or with a
certificate file kept on this computer, for a page running on the same computer. A
browser cannot reach a smart card and must not hold a private key, so this small Python
process does the one thing the page cannot: it holds the PIV session or reads the file, asks
for the PIN or passphrase in the OS's own dialog, and signs the bytes the PDF kernel hands over
(`toBeSigned`). The page never sees the PIN, the passphrase or the key; the agent
never sees the PDF.

It runs on Yubico's own [`yubikey-manager`](https://pypi.org/project/yubikey-manager/) package
and the Python standard library — nothing else. A certificate file alone needs only PyCA
[`cryptography`](https://pypi.org/project/cryptography/), which `yubikey-manager` brings.

## Run it

Python 3.11 or later.

```sh
cd tools/piv-agent
python3 -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install --require-hashes -r requirements.txt    # yubikey-manager (pulls pyscard) and cryptography, pinned
python piv_agent.py --allow-origin https://forms.example.gov --verbose
```

`requirements.txt` pins every dependency, direct and transitive, to an exact version with its hashes, so `pip` refuses any
file that is not the one reviewed; `requirements.in` holds the ranges it is compiled from. To move to newer releases, edit the
ranges and run `uv pip compile requirements.in --universal --python-version 3.11 --generate-hashes -o requirements.txt`.

`--allow-origin` is required: the agent allows no page until you name its origin. While you work on a page served by
the Vite dev server, `--dev` allows its origins (`http://localhost:5173` and `http://127.0.0.1:5173`) as well.

Plug the YubiKey in; slot 9c (Digital Signature) needs a key and a certificate — for a test
key:

```sh
ykman piv keys generate --algorithm RSA2048 --pin-policy ALWAYS --touch-policy CACHED 9c pub.pem
ykman piv certificates generate --subject "CN=Ada Lovelace" 9c pub.pem
```

Then, in the page, `createAgentPdfSigner()` from `@argusvane/datum-engine` (or `datum-form.js`) turns the
agent into a `PdfSigner` for `<datum-form>`'s `pdfSigner` property. The docs site's
[Signing](../../site/docs/signing.md) page does that.

### With a certificate file instead of, or beside, the YubiKey

A certificate a CA issued as a `.p12` / `.pfx` bundle — or exported from Keychain, from the
Windows certificate store, or from Acrobat — signs the same way:

```sh
python piv_agent.py --p12 ~/Desktop/signer.p12 --allow-origin https://forms.example.gov --verbose
python piv_agent.py --key signer.key.pem --cert signer.cert.pem --allow-origin https://forms.example.gov
```

The file is listed under the slot `file` (the default slot when a file is given) beside any
YubiKey slots; a YubiKey that is unplugged does not hide it. The certificates are read once at
startup; the private key is read from the file, decrypted and dropped for **every** signature —
the agent never holds it between two. When the file is protected, the OS dialog asks the
passphrase each time (an encrypted PKCS#12 keeps its certificate behind the passphrase too, so
it is asked once more at startup, to read the certificate). When the file has no passphrase, the
dialog is a plain Sign / Cancel — nothing signs silently.

To make a `.p12` from a PEM key and certificate: `openssl pkcs12 -export -inkey signer.key.pem
-in signer.cert.pem -certfile issuers.pem -out signer.p12`.

| Flag | Meaning |
| --- | --- |
| `--port N` | TCP port on 127.0.0.1 (default 7391). The agent never listens on another interface. |
| `--allow-origin ORIGIN` | A web origin that may use the agent, `http(s)://host[:port]` with no path (not `null`, not empty); repeat for several. Required, unless `--dev` is given. |
| `--dev` | Also allow the Vite dev origins, `http://localhost:5173` and `http://127.0.0.1:5173`. For working on a page on this computer; leave it off otherwise. |
| `--slot 9c` | The slot a request without one signs with (default 9c; `file` when a certificate file is given). |
| `--serial N` | Which YubiKey, when several are plugged in. |
| `--chain issuers.pem` | Issuer certificates (PEM) to send after the leaf — the token holds only the leaf; a file's own issuers come first. |
| `--p12 FILE` | A PKCS#12 certificate file (`.p12` / `.pfx`) on this computer to sign with. |
| `--key PEM --cert PEM` | A PEM private key and its PEM certificate (the leaf first, issuers after it) to sign with. One file, one way: not with `--p12`. |
| `--terminal-pin` | Ask for the PIN or passphrase in this terminal instead of a native dialog. |
| `--allow-no-origin` | Answer requests without an `Origin` header (curl, scripts). |
| `--verbose` | Log every request to stderr — never the PIN, the passphrase, the bytes to sign, or the value. |

## The API

JSON in and out; bytes are base64. Every reply is `Cache-Control: no-store`.

| Route | Answers |
| --- | --- |
| `GET /health` | `{ agent, version, slot }` — no card access, the "is anything listening" probe. |
| `GET /certificates` | `{ agent, devices: [{ serial, name, version }], certificates: [entry…] }` |
| `POST /sign` | `{ slot, algorithm, keyType, value }` for `{ slot, algorithm, toBeSigned, context: { title?, documentId?, field?, reason? } }` — `slot` is a PIV slot or `file`; `reason` is what the person affirms (the signature's reason or commitment statement) and the dialog shows it as *You are signing: …* |

A certificate entry: `slot` (`9c`, … or `file`), `slotName` (`SIGNATURE`, … or `FILE`),
`source` (`yubikey` or `file`), `file` (the file's name, for a file entry), `subject`,
`subjectCommonName`, `issuer`, `serialNumber`, `notBefore`, `notAfter`, `keyType` (`RSA2048`,
`ECCP256`, …), `algorithm` (the kernel's id — `RSASSA-PKCS1-v1_5-SHA256`, `ECDSA-P256-SHA256`,
`ECDSA-P384-SHA256` — or `null`), `pinPolicy` / `touchPolicy` (`null` on firmware before 5.3;
for a file, `passphrase` or `never`, and `never`), `usable`, `unusableReason` (RSA-1024 and
Ed25519 keys are listed but refused before any PIN is asked), and `certificates` (DER base64,
leaf first, then the file's own issuers, then `--chain`). `devices` names each YubiKey by
serial and each file by name (`serial` null).

Errors are `{ "error": { "code", "message", "attemptsRemaining"? } }`:

| Code | Status | When |
| --- | --- | --- |
| `origin_denied` | 403 | The `Origin` is not allow-listed (every method, preflights included). |
| `no_device` | 503 | No YubiKey (or not the `--serial` one) is plugged in. |
| `no_certificate` | 404 | The slot holds no certificate. |
| `unusable_key` | 422 | The key cannot sign a PDF (RSA-1024, Ed25519, X25519). |
| `algorithm_mismatch` | 409 | The request's algorithm is not the slot's. |
| `pin_cancelled` | 409 | The dialog was dismissed (the PIN, the passphrase, or the Sign / Cancel confirmation). |
| `pin_invalid` | 401 | Wrong PIN; `attemptsRemaining` says how many are left. Wrong passphrase for a file: no counter, a file has no lockout. |
| `pin_blocked` | 401 | No attempts left — `ykman piv access unblock-pin`. |
| `touch_timeout` | 408 | The key wanted a touch and did not get one. |
| `busy` | 423 | Another signature is waiting on the PIN dialog. |
| `bad_request` / `too_large` | 400 / 413 | Malformed body, or over 64 KiB. |
| `device_error` | 500 | Anything the card or the reader refused. |

## How the PIN or passphrase is asked

The agent opens the operating system's own prompt, naming the requesting origin, the document,
the certificate (`slot 9c`, or `file signer.p12`) and a prefix of the digest, so the person
always knows what they are signing. The text reaches the dialog through environment variables
or argv — it is never spliced into a script. For a token the prompt asks the PIN; for an
encrypted file, its passphrase; for a file with no passphrase it is a Sign / Cancel
confirmation with nothing to type.

| Platform | PIN / passphrase | Confirmation | Banner |
| --- | --- | --- | --- |
| macOS | `osascript` `display dialog … with hidden answer` | `display dialog` with Sign / Cancel | `display notification` |
| Linux | `zenity --entry --hide-text`, else `kdialog --password`, else `pinentry GETPIN` | `zenity --question`, `kdialog --yesno`, `pinentry CONFIRM` | `notify-send` |
| Windows | PowerShell WinForms masked text box | the same form without the box | Windows toast (best effort) |
| Anything else, or `--terminal-pin` | `getpass` in the agent's terminal, after a banner | `Sign? [y/N]` in the terminal | — |

Slot 9c's PIN policy is *always*, so every signature prompts. When the slot's touch policy is
not *never*, a banner says "Touch your YubiKey if it blinks" before the card is asked.

## Security notes

- Loopback only; no flag opens another interface.
- The `Origin` allowlist is the consent boundary between web pages: an unlisted page gets 403
  before anything else happens. The PIN dialog is the consent boundary for each signature.
- One signature at a time. Reads (`/health`, `/certificates`) still answer while a signature
  waits on the dialog.
- A page served over `https` may call `http://127.0.0.1` (loopback is "potentially
  trustworthy"). The browser may put its own gate in front of that call. Chrome asks the person
  once per site whether the page may reach apps on this device (Local Network Access, the
  `loopback-network` permission): it asks only a page served over `https`, the first call
  should follow a click rather than the page's load, and a form inside a cross-origin iframe
  needs `allow="loopback-network"` on the frame. A denied permission looks to the page like
  no agent at all (`unreachable`). Safari may still block a public page from reaching
  loopback. The agent also answers the older Private Network Access preflight
  (`Access-Control-Allow-Private-Network: true`) for a browser that still sends one.
- The PIN is deleted right after the card has seen it; it is never logged. `--verbose` logs
  method, path, origin, status and timing.
- A certificate file's key is read, decrypted, used and deleted per signature; the process
  holds no key between two, and no passphrase at all. But a key in a file is only as safe as
  the file: the dialog and the origin allowlist bound *when* it is used, not who can copy it.
  Keep it out of shared folders, and prefer a passphrase-protected `.p12`.

## Tests

```sh
python -m unittest -v
```

No hardware: a fake backend built from self-signed certificates and a scripted prompter cover
the origin policy, the CORS/PNA preflight, the certificate listing (kernel algorithm ids,
unusable keys, chains), the signing flow (prompt text, value, wrong/blocked/cancelled PIN, one
at a time, refusals before the PIN) and error bodies. The file backend is tested against
PKCS#12 and PEM files minted on the fly (plain, encrypted, EC, mismatched key), alone and in
the composite beside the fake token, over HTTP. CI runs them on Ubuntu, on every supported
Python from 3.11, with `libpcsclite-dev` installed for `pyscard`.

## Troubleshooting

- **`No YubiKey is plugged in`** with one plugged in: on Linux start `pcscd`; on macOS the
  system's smart card service is built in; on Windows the Smart Card service must be running.
- **`ykman` works but the agent does not**: the agent needs the *library* (`pip install
  yubikey-manager`) in the interpreter that runs it; the `ykman` app bundle carries its own.
- **`origin_denied`**: add the page's origin with `--allow-origin`. The message names it.
- **The page says no agent answered, and the agent is running**: the browser's permission for
  the site to reach apps on this device was dismissed or denied. In Chrome, open the site's
  settings from the address bar and allow it, then detect again. With `--verbose`, a request
  the browser blocked never shows in the agent's log.
- **`--p12` refuses to start**: a wrong or cancelled startup passphrase; run again. **`is not the
  key of the certificate`**: the `--key` and `--cert` files are not a pair.
- **The dialog appears behind other windows** (macOS): click the agent's Python icon in the Dock,
  or run with `--terminal-pin`.
