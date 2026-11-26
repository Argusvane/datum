# The PDF program

`datum-pdf-program.js` is the program a server runs to make, fill, sign and read PDFs. It is the same program the browser runs, so a request gives the same bytes on every host. [Running the programs on your own server](/server-programs) says how to run it inside a WebAssembly runtime and what limits to set; this page is the list of what it answers.

## Calling it

A host calls `__datum_pdf` with one JSON request as text and reads one JSON reply as text. The call returns a promise: let it settle before the module exits. A host that runs the program in process imports its `handlePdfRequest` instead and skips the text.

Every request has an `abi`, the interface version the host speaks, and an `op`. The program answers a request of its own major version (currently 4) and refuses any other with the `abi_mismatch` failure. The reply is either `{ "ok": true, "op": "…" }` with the keys of that operation, or a failure.

```json
{ "ok": false, "error": { "code": "template", "message": "The template is encrypted with a password; supply an unencrypted copy of the template." } }
```

The failure codes and the warnings that come back in `warnings` are listed in the codes reference. A failure is the whole answer; a warning never stops a file being made.

Bytes travel as base64. The program reads no clock and no random source: the host says when it is and what to call the document in `env`, which is what makes the output repeatable.

Two more globals exist:

- `__datum_pdf_abi` is the version string.
- `__datum_pdf_register(module)` takes a plugin module's `pdfRenditions` and `functions` (a function name must be a plain identifier that no built-in or earlier module took).

## The operations

| Op | What it does |
|---|---|
| `capabilities` | Names the version and the features |
| `document` | Chooses a layout from the form and the answers and makes the PDF in one step |
| `build` | Chooses the layout and builds what would be drawn, without drawing it |
| `render` | Draws a document that `build` returned |
| `layout` | Measures a document: the pages it would run to, with no file |
| `fill` | Fills a PDF with values, and draws into areas |
| `inspect` | Reads a PDF: its pages, fields, encryption and embedded files |
| `sign` | Prepares a signature over a PDF and says what to sign |
| `complete` | Embeds the signature value the host made |
| `timestampRequest` | Builds the RFC 3161 request for a timestamp authority |
| `verify` | Reads every signature in a PDF |

Anything else is an `invalid_request` failure.

### capabilities

Request: `{ "abi": "4.0.0", "op": "capabilities" }`. Reply: `abi`, `features` and `kernelVersion`.

Probe the program at start and refuse one that:

- Reports another major version.
- Reports a version below the floor you built against.
- Lacks a feature you need.

| Feature | What it means |
|---|---|
| `document`, `build`, `render`, `layout`, `fill`, `inspect` | The operation of that name |
| `signature` | `sign`, `complete`, `timestampRequest` and `verify`, and `signature` on `document`, `render` and `fill` |
| `tagged` | Tagged PDFs |
| `acroform` | Fillable fields, in drawn documents and in templates |
| `areas`, `area-fields` | Areas drawn onto a template's pages, and areas that become fillable fields |
| `bidi` | Right-to-left and mixed-direction text |
| `unknown-components` | The `unknownComponents` policy |
| `pdfa` | PDF/A conformance |
| `attachments`, `attachment-data` | Uploaded files embedded, and `inspect` returning embedded files' bytes |
| `attachment-types` | Executables, scripts and HTML refused as attachments, and a file whose bytes are larger than its declared size |
| `theme-controls` | A PDF theme's geometry: controls, choice marks, fields, headings, tables, boxes, panels, lists, spacing |
| `data-keys` | A field's `dataKey` places its answer, in tables, repeats and fillable field names |
| `layout-conditions` | A layout's `when` chooses it from the answers |
| `field-tooltips` | `inspect` lists each field's tooltip |
| `conditional-expressions`, `formulas`, `formula-functions` | `if` in expressions, formula strings, and the function library with plugin functions |
| `verify-detail` | The full signature report: the signed revision, later updates, timestamps, `knownCertificates` |
| `template-decryption` | Templates encrypted with an empty user password are read |
| `mapping-values` | A mapping's `values` map from answers to PDF values |
| `output-safety` | Safe attachment names, bidi controls stripped from answers, field values clamped to their maximum length, risky patterns refused |
| `render-caps` | A layout's `limits` for pages and answer length |
| `default-font-fallback` | A family no font covers is drawn in the supplied default sans-serif face |

Require at least `document`. Then add by need:

- **Templates.** `fill` and `inspect`.
- **Signing.** `signature`.
- **Verify reports.** `verify-detail`, before you rely on one.
- **Layouts with conditions.** `layout-conditions` and `formulas`.
- **Archival files.** `pdfa`.
- **Answers from the public.** `output-safety` and `render-caps`.

### document

The request carries the form, the answers and the host's time. Keys marked optional can be left out.

| Key | Meaning |
|---|---|
| `form` | The form's root component |
| `values` | The answers, keyed by value path as a submission carries them. They are what prints and what a layout's `when` reads. Send the sandbox's validated `values` |
| `locale` | The language to draw in |
| `pdf` | Optional. The definition's `pdf` block: `layouts` and `defaultLayoutId` |
| `layoutId` | Optional. The layout to draw. Wins over every `when` |
| `layout` | Optional. A layout to draw whole instead of any in `pdf` |
| `fonts` | The font resources: `id`, `family`, `weight`, `style`, `data` (base64) and `coverage` (script tags) |
| `env` | `createdAt` (ISO 8601), `documentId` (hashed into the file's trailer id), and optional `producer` and `creator` |
| `options` | Optional. `compact`, `tagged` and `pdfa` as the render options of [PDFs](/pdf#from-script) |
| `template` | Optional. `{ "data": "…" }`: the bytes of a template layout whose PDF is not inline in the definition |
| `signature` | Optional. Prepares a signature over the result: the settings of [Signing](/signing#the-server-signs) over the layout's own, and `certificates`, base64 DER, the signer's first |
| `translations` | Optional. The host's translation catalogue. An entry here wins over the definition's |
| `formTranslations` | Optional. The definition's own `translations` map |
| `kinds` | Optional. The definition's `kinds` map, so a plugin's or a design system's component type is drawn as its base type |
| `optionSnapshot` | Optional. Options of data-source-backed components, per component id, already resolved. The program never fetches |
| `effectiveStates` | Optional. Visibility per component id. Left out, rules run inside the program |
| `theme` | Optional. A PDF theme object. The program knows only `datum-pdf` and `datum-plain` by id |
| `title` | Optional. The document title, overriding the form's |
| `hostContext` | Optional. An object read as `host.<key>` |
| `unknownComponents` | Optional. `ignore`, `warn` (the default) or `fail` |
| `attachments` | Optional. `{ budgetBytes, onExceeded }`. Default 4 MiB and `skip` |
| `today` | Optional. `YYYY-MM-DD`. Left out, a rule that reads the clock never holds. A server sends its own day |
| `formulaErrors` | Optional. `fail` (the default) or `warn` |
| `riskyPatterns` | Optional. `refuse` (the default) or `allow` |

The reply has:

- `bytes` (base64), `pageCount`, `pages` (empty for a filled template) and `warnings`.
- The layout it printed: `layoutId`, `layoutKind` (`generated`, `template` or `derived`) and `layoutChoice` (`given`, `asked`, `condition`, `default`, `fallback` or `derived`).
- `fields` and `areas` for a template.
- `pdfa` when the file declares a level.
- `attachments` (the embedded names).
- `signing`, when the request asked for a signature.

#### Template layouts

A template layout needs its bytes. If the layout's source is inline, the program has them. Otherwise send `template`.

Because the answers can choose the layout, the program refuses template bytes sent without a `layoutId` when a condition chose a template other than the one printed when no condition holds, so it never fills the wrong PDF. To send them:

1. Call `build` to learn which layout the answers choose.
2. Resolve that layout's bytes.
3. Send `document` with that `layoutId`.

```json
{
  "abi": "4.0.0",
  "op": "document",
  "form": { "…": "the form's root component" },
  "values": { "fullName": "Ada Lovelace", "age": 36 },
  "locale": "en",
  "pdf": { "layouts": [ { "…": "…" } ] },
  "fonts": [ { "id": "sans", "family": "sans-serif", "weight": 400, "data": "…base64…", "coverage": ["Latn"] } ],
  "env": { "createdAt": "2026-11-14T12:00:00.000Z", "documentId": "intake-1042" },
  "options": { "pdfa": "2b" }
}
```

### build and render

`build` takes the same inputs as `document` (keys from `form` to `riskyPatterns`, but not `fonts`, `env`, `options`, `template` or `signature`). It replies with `layoutId`, `layoutKind`, `layoutChoice`, `warnings` and either `document`, the model of a generated layout, or `fill`, the plan of a template (the values and areas already worked out). Use it to learn which layout the answers choose, to cache a document, or to inspect one.

`render` takes the `document` from a `build`, plus `fonts`, `env`, and optional `options` and `signature`. The reply is the same as `document`'s without the layout keys.

### layout

Takes `document`, `fonts`. Replies with `pages` (each page's `index`, `width`, `height` and the `blockIds` that landed on it) and `warnings`, and no file. It is a cheap way to count pages.

### fill

Fills a PDF with values you resolved yourself.

| Key | Meaning |
|---|---|
| `template` | `{ "data": "…" }`, the PDF in base64 |
| `values` | AcroForm field name to value: text, `true` or `false`, a list of option values, or `null` to clear |
| `areas` | Optional. Areas with their values already resolved |
| `fonts`, `env` | As for `document` |
| `options` | The three fill options of [Template layouts](/pdf-layouts#fill-options): `flatten`, `readOnly` and `appearances`. Send all three |
| `conformance` | Optional. The archival level to keep through the fill |
| `attachments` | Optional. Uploaded files to embed |
| `signature` | Optional. Prepares a signature over the filled PDF |
| `typography`, `colors` | Optional. What a content area draws with when its own `draw` says nothing |

Reply: `bytes`, `pageCount`, `fields` (one per value: `pdfField`, `status` of `filled`, `cleared`, `missing` or `unsupported`, `kind`, `message`), `areas`, `warnings`, and `pdfa`, `attachments` and `signing` when they apply.

### inspect

Request: `template` (`{ "data": "…" }`) and optionally `attachments`, which lists the embedded files:

- `none` (the default).
- `digest`: with their SHA-256.
- `data`: with their SHA-256 and their bytes.

Reply: `info`.

| `info` key | Meaning |
|---|---|
| `pageCount`, `pages` | The page count, and each page's `index`, `width` and `height` |
| `fields` | Each field's `name`, `kind` (`text`, `checkbox`, `radio`, `dropdown`, `listbox`, `signature`, `button` or `unknown`), `page`, `rect`, `options`, `exportValues` (what means on, for a checkbox or radio), `maxLength`, `multiline`, `readOnly`, `required`, `value`, `signed` (for a signature field) and `tooltip` |
| `hasXfa` | The PDF carries XFA, which a fill removes |
| `encrypted`, `permissions` | Whether it was encrypted. The owner's permissions: `print`, `printHighQuality`, `modify`, `copy`, `annotate`, `fillForms`, `assemble` |
| `pdfa` | The PDF/A level it declares |
| `signatures` | How many signature fields are signed |
| `attachments`, `warnings` | The embedded files when asked for, and what could not be read |

A listing is capped at 500 pages and 5,000 fields, with `template.truncated`. A template that needs a password to open is refused as a `template` failure.

### sign, complete and timestampRequest

Signing takes two calls so that a private key never enters the program. [Signing](/signing#two-calls) describes the flow.

`sign` takes `pdf` (`{ "data": "…" }`), `signature` (the settings and `certificates`), `env` (`createdAt` at least) and optionally `fonts`. It replies with `bytes`, the prepared file, `signing` and `warnings`. `signing` is what the host must sign.

| `signing` key | Meaning |
|---|---|
| `field` | The signature field the signature will land in |
| `byteRange` | The four numbers that frame the signed bytes |
| `digest` | SHA-256 over the byte range, base64 |
| `toBeSigned` | The signed attributes, base64: sign these bytes |
| `toBeSignedDigest` | SHA-256 of `toBeSigned`, for a key service that takes a digest |
| `signatureAlgorithm` | `RSASSA-PKCS1-v1_5-SHA256`, `ECDSA-P256-SHA256` or `ECDSA-P384-SHA256`, from the signer's certificate |
| `subFilter` | `ETSI.CAdES.detached` or `adbe.pkcs7.detached` |

`timestampRequest` takes `signature`, the signature value in base64, and replies with `request`, the base64 request to post to a timestamp authority with content type `application/timestamp-query`.

`complete` takes the prepared `pdf` and `signing`: the same `certificates` and settings that `sign` had, plus:

- `value`: the raw signature over `toBeSigned`, base64; ECDSA as DER or as `r` followed by `s`.
- `toBeSignedDigest`: echoed so a changed input is caught.
- `timestamp: { "token": "…" }`: optional, the authority's answer in base64.

It replies with `bytes`, the signed file, `field`, `cms` (the signature container) and `timestamped`.

### verify

Request: `pdf`, and optionally `knownCertificates`, a list of at most 64 base64 certificates of at most 16 KiB each, such as your timestamp authority's. More is an `invalid_request`.

Reply:

- `signatures`.
- `attachments`: each embedded file's `name`, `sha256`, `relationship` and `size`.
- `warnings`.
- `documentId`: the file's trailer id, which nothing authenticates by itself.

Each entry of `signatures` reports one signature.

| Key | Meaning |
|---|---|
| `field`, `subFilter`, `byteRange` | Where the signature is and how it was made |
| `coversDocument` | The signed range reaches the end of the file: nothing was added after it |
| `digestMatches` | The signed range hashes to the digest in the signature |
| `certificateMatches` | The signature names the certificate that signed it |
| `signer`, `signerSource` | The signing certificate (`certificate`, `publicKey`, `subject`, `issuer`, `serialNumber`, `notBefore`, `notAfter`) and where it was found: `signature`, `known` or none |
| `certificates` | Every certificate the signature carries |
| `toBeVerified`, `signature`, `signatureP1363`, `signatureAlgorithm` | What the host checks the signature value over, with the signer's key |
| `signingTime`, `reason`, `location`, `name`, `contactInfo` | What the signature says about itself |
| `certification` | `{ permissions }` of `noChanges`, `formFilling` or `annotations`, or `null` for an approval signature |
| `commitment` | The commitment type and statement signed with the attributes |
| `timestamp` | A timestamp token in the signature: `time`, `tsa`, `coversSignature`, the imprint, and the token's own signature, signer and checks |
| `details`, `signedRevision`, `changedAfter`, `signedDocumentId` | What the signature dictionary said in the revision that was signed, and how the file's latest definition differs |
| `laterRevisions` | What updates after this signature added, changed or freed (`revisions`, `changes`), whether the certification permits all of it (`permitted`), and the later signatures that decision relied on (`reliedOnSignatures`) |

The program checks structure, digests and certificate binding. It does not check the signature value and does not decide trust; that is the host's. [Signing](/signing#verifying) says what to check.

## Fonts

`document`, `render`, `layout` and `fill` draw with the `fonts` in the request. A font is `{ id, family, weight, style, data, coverage }`, where `data` is a TrueType or OpenType file in base64. Send what the document needs: the host works that out from the document, or sends the whole pack.

When a family has no font:

- The program uses a resource whose family is `sans-serif` in its place.
- With none at all, it falls back to the standard PDF fonts, which have a Western repertoire only.

See [Fonts](/pdf#fonts).
