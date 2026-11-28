# @argusvane/datum-pdf-kernel

The Datum PDF program: the engine's PDF model builder plus a layout and AcroForm
kernel over `@cantoo/pdf-lib`, bundled into **one import-free ES2020 file** that runs

- in-process in any JavaScript host (`createInProcessPdfProvider()`),
- inside QuickJS-WASM in the same host (`createQuickJsPdfProvider()`, from `@argusvane/datum-pdf-kernel/quickjs`),
- inside any QuickJS embedding elsewhere — a JVM, a .NET process, a Go service — through one
  string-in / string-out global.

The three produce **byte-identical PDFs** for the same request. The parity suite
(`tests/quickjs-parity.test.ts`) holds the first two to it on every run; the third runs the very
same program text, so it inherits the guarantee.

## Build

```
npm install
npm run build:program        # → dist/datum-pdf.program.js (+ .meta.json size report)
npm test                     # rebuilds the program, then runs every suite
```

## Using it from JavaScript

```ts
import { createInProcessPdfProvider, createDefaultFontProvider } from "@argusvane/datum-pdf-kernel";

// On <datum-form-host> / <datum-form-renderer>:
host.pdfProvider = createInProcessPdfProvider();
host.pdfFonts = createDefaultFontProvider();          // DejaVu Sans from the package
// The toolbar now has a PDF button; the renderer's renderPdf() / downloadPdf() work too.

// Or, without a running form — from a definition and the answers:
const provider = createInProcessPdfProvider();
const result = await provider.document({
  abi: PDF_ABI_VERSION, op: "document",
  form: definition.root, pdf: definition.pdf, layoutId: "applicant-copy",
  values: submission.submission.values, locale: "en",
  optionSnapshot: { country: [{ value: "CA", label: "Canada" }] },
  fonts: await loadFontPack(), env: { createdAt: new Date().toISOString(), documentId: crypto.randomUUID() }
});
// result.bytes is the PDF
```

## Using it from Java, .NET, Node.js, or any QuickJS embedding

The program is `dist/datum-pdf.program.js`. Evaluate it **once** per runtime, then call
`globalThis.__datum_pdf(requestJson)`; it returns a promise of the response JSON.

1. Create a QuickJS runtime with the **document profile**: memory limit 256 MiB, max stack size
   1 MiB (larger stack settings break the singlefile WASM build), an interrupt handler with a
   15 s budget.
2. Evaluate the hardening prelude (`HARDENING_PRELUDE` in `@argusvane/datum-quickjs-wasm-host`, or any
   equivalent that disables `Date` and `Math.random`), then the program text.
3. For each request: `stableStringify(request)` (keys in code-unit order — `JSON.stringify` of
   a sorted object is fine), call `__datum_pdf`, then **drain the runtime's pending jobs** until
   the returned promise settles (`JS_ExecutePendingJob` in a loop). The program's only timers
   are microtasks, so the loop always terminates.
4. Parse the response. `ok: true` carries `bytes` as base64; `ok: false` carries
   `{ code, message }` (`abi_mismatch`, `invalid_request`, `font`, `template`, `layout`,
   `unknown_component`, `conformance`, `attachment_budget`, `signature`, `internal`).

Which layout a `document` prints when the request names neither `layoutId` nor `layout`: the
first in `pdf.layouts` whose `when` holds on the request's `values`, else `defaultLayoutId`, else
the first (ADR 0044). Send the sandbox's validated
`values`, and the choice is the browser's. The reply names it — `layoutId`, `layoutKind`,
`layoutChoice` — so the file can be named and filed. A host that keeps template PDFs outside
the definition calls `build` first (same inputs; its reply names the layout and carries the fill
plan's template source), resolves that layout's bytes, and sends `document` with `layoutId` and
`template.data`: bytes sent without a `layoutId`, when a condition chose a template layout other
than the one printed when none holds, are refused with the `template` code rather than filled
under the wrong plan.

Java (verified; the docs site's server examples in Java are Spring Boot endpoints written
this way): no QuickJS binding, but QuickJS-ng's own `qjs-wasi.wasm` compiled at build time by
[Endive](https://endive.run)'s Maven plugin — native code through Redline where the platform has
it, JVM bytecode elsewhere — and run once per request over the WASI imports, the program in an
in-memory `/app`, the request on stdin, the answer on stdout. `__datum_pdf`'s promise settles
before `qjs` exits, so the printed line is the response:

```java
var argv = List.of("qjs", "--std", "-I", "/app/datum-pdf-program.js", "-e",
        "__datum_pdf(std.in.readAsString()).then((json) => print(json));");
var options = WasiOptions.builder().withArguments(argv).withDirectory("/app", APP)
        .withStdin(new ByteArrayInputStream(requestJson.getBytes(UTF_8))).withStdout(out).withStderr(err).build();
try (var wasi = WasiPreview1.builder().withOptions(options).build()) {
    var imports = ImportValues.builder().addFunction(wasi.toHostFunctions()).build();
    try (var instance = Qjs.builder().withImportValues(imports)            // the document profile: 256 MiB;
            .withMemoryLimits(new MemoryLimits(QJS_PAGES, 256 * 1024 * 1024 / 65536)).build()) {}  // 15 s on the Future
}
String responseJson = out.toString(UTF_8).stripTrailing();
```

C# (verified; the docs site's server examples in C# are ASP.NET Core endpoints written
this way): the same `qjs-wasi.wasm` under the `Wasmtime` NuGet package, the Bytecode Alliance's
.NET embedding of wasmtime, run once per request in a store of its own — this directory read-only
as `/app`, the request and the answer through files, since this embedding's WASI takes paths for
its standard streams — with the memory a limit on the store and the budget an epoch deadline
against a clock the process shares:

```csharp
string[] args = ["qjs", "--std", "-I", "/app/datum-pdf-program.js", "-e",
    "__datum_pdf(std.in.readAsString()).then((json) => print(json));"];
using var store = new Store(engine);                                        // the document profile:
store.SetLimits(memorySize: 256 * 1024 * 1024);                             // 256 MiB, and 15 s of
store.SetEpochDeadline((ulong)Math.Ceiling(15 / tick.TotalSeconds) + 1);   // the shared clock's ticks
store.SetWasiConfiguration(new WasiConfiguration().WithArgs(args)
    .WithPreopenedDirectory(".", "/app", WasiDirectoryPermissions.Read, WasiFilePermissions.Read)
    .WithStandardInput(requestPath).WithStandardOutput(responsePath).WithStandardError(errorPath));
try { linker.Instantiate(store, qjs).GetFunction("_start")!.Invoke(); }   // returns once the promise has printed
catch (WasmtimeException exit) when (exit.ExitCode is int code) { if (code != 0) throw; }  // exit 1: the program threw
string responseJson = File.ReadAllText(responsePath).TrimEnd('\n');       // a TrapException is the budget (Interrupt)
```

Node.js (verified; the docs site's server examples in Node.js are Express endpoints written
this way): the same `qjs-wasi.wasm` on V8 with `node:wasi`, nothing to install — run once per
request in a process of its own, since V8 caps a module's memory per process
(`--wasm-max-mem-pages`) and interrupts a running instance by nothing short of ending what runs
it: the request on the process's stdin, the answer on its stdout, the budget a timeout on the
process, and the program in a directory the process is started in, mounted as `/app`:

```js
// qjs.mjs — the runner, one process of it per request:
//   node --wasm-max-mem-pages=4096 --disable-warning=ExperimentalWarning qjs.mjs -I /app/datum-pdf-program.js -e "…"
const wasi = new WASI({ version: "preview1", args: ["qjs", "--std", ...process.argv.slice(2)], preopens: { "/app": "." }, returnOnExit: true });
const instance = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync("qjs-wasi.wasm")), wasi.getImportObject());
process.exitCode = wasi.start(instance);                   // returns once the promise has printed; 1 if the program threw

// the endpoint — the document profile: 256 MiB as pages on the flag, 15 s as the timeout
const run = spawn(process.execPath, ["--wasm-max-mem-pages=4096", "--disable-warning=ExperimentalWarning", "qjs.mjs",
    "-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"],
    { cwd: APP, timeout: 15000 });                         // APP: a directory holding the program and nothing else
run.stdin.end(requestJson);   // responseJson is run.stdout, trimmed; at "close", a signal is the budget, exit 1 a throw with stderr
```

Python: the docs site's "Render a PDF on the server" example is a FastAPI endpoint that runs
the program in `qjs-wasi.wasm` under wasmtime; `docs/reference/server-runs.md` shows how a server
host runs it.

An older QuickJS binding embeds the QuickJS of 2021-03-27, and the program runs on it: the build guards the
one place the byte libraries would trip an engine that old (a base64 decoder that writes past its
buffer, which QuickJS before 2023 refuses in strict code and every later engine ignores) and the
program reaches for no API it lacks. `dist/datum-pdf.program.meta.json` records the guard.
`@argusvane/datum` copies the program beside its bundles as `dist/datum-pdf-program.js`, with
the DejaVu fonts in `dist/fonts/` (ADR 0043).

Operations (`op`): `capabilities`, `document` (form + layout + values → bytes; what a non-JS host
uses), `build` (→ the `PdfDocument` model), `render` (`PdfDocument` → bytes), `layout` (page
report, no bytes), `fill` (template + values → bytes), `inspect` (template → its fields),
`sign` (any PDF → the file with a signature placeholder, and what to sign), `complete` (the
host's signature value → the signed file), `timestampRequest` (an RFC 3161 request over a
signature value), `verify` (a PDF → its signatures, checked). The full message types are in
`@argusvane/datum-engine` (`render/pdf/pdf-abi.ts`, `PDF_ABI_VERSION`).

### Signing (ADR 0061)

The kernel signs the way ISO 32000-2 §12.8 and PAdES (ETSI EN 319 142-1, level B-B) ask — a
signature field, `/ByteRange`, a CMS `SignedData` with `ETSI.CAdES.detached` — and does
everything but the one step that needs a private key. Two calls, the shape the EU's DSS uses
(`getDataToSign` / `signDocument`), so a key in an HSM or a cloud KMS works as well as a PEM file:

```python
# 1. Render and prepare in one call: the layout's signature settings, the host's certificates.
prepared = render({**request, "signature": {"certificates": CERTIFICATES}})   # DER, base64, signer first
handoff = prepared["signing"]          # field, byteRange, digest, toBeSigned, toBeSignedDigest, signatureAlgorithm
# 2. The host signs the DER attributes with its key — RSA PKCS#1 v1.5 or ECDSA (P-256/P-384), SHA-256.
value = key.sign(base64.b64decode(handoff["toBeSigned"]), padding.PKCS1v15(), hashes.SHA256())
# 3. The kernel rebuilds the attributes from the bytes (a changed input is refused), assembles the CMS and embeds it.
signed = render({"abi": "1.0.0", "op": "complete", "pdf": {"data": prepared["bytes"]},
                 "signing": {"certificates": CERTIFICATES, "value": b64(value), "toBeSignedDigest": handoff["toBeSignedDigest"]}})
```

`sign` does the same over any PDF (`pdf.data`, `signature`, `env`, optional `fonts` for the
appearance) — a fill, a file the host has, a signed file for a further signature. The signature
is an incremental update: the original bytes stay as they are, so earlier signatures stay valid.
Settings, on the layout's `signature` block or the request (the request wins, key by key):
`field` (a `pdf-signature` block's field name, or a template's own signature field; absent, a
field of its own at the bottom of the last page), `certify` (`"noChanges"` — DocMDP P=1 —,
`"formFilling"`, `"annotations"`, or `false` for an approval signature), `reason`, `location`,
`contactInfo`, `name`, `subFilter` (`adbe.pkcs7.detached` for the older Adobe profile, which adds
a signingTime attribute), `appearance` (`false` for invisible; a `page`, `rect`, `lines`,
`fontId`, `fontSize` otherwise — the default draws "Digitally signed by…", the date, the reason
with the first font resource), `timestamp: true` to reserve room for a token, `required`
(a `document` without certificates is refused, not produced unsigned), `placeholderBytes`.
A certification must be the document's first signature; a file certified with no changes
allowed refuses any further one. A PDF/A file stays PDF/A through a signature (veraPDF-tested).

**Digest-only signers.** `toBeSignedDigest` is SHA-256 of `toBeSigned`, for a KMS that signs a
hash: AWS KMS `Sign` with `MessageType: "DIGEST"` and `SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256"`
(or `ECDSA_SHA_256`) returns exactly the value `complete` takes; Azure Key Vault's `sign` with
`RS256` / `ES256` likewise. A raw RSA primitive that does not add the PKCS#1 `DigestInfo` wrapper
itself is not enough — sign `toBeSigned` with a hashing API instead.

**What the signer says (ADR 0062).** `signature.commitment` — `{ type: "approval" | "origin" |
"receipt" | "delivery" | "sender" | "creation", statement?: string }` — adds a CAdES
`commitment-type-indication` to the signed attributes (ETSI EN 319 122-1), the statement as a
qualifier under a Datum OID, so the key signs what the person affirmed; the same setting must
go to `complete`, or the attribute digest refuses it. `verify` reports it as `commitment`.
`reason` stays in the signature dictionary, covered by the byte range but not by the key.

**Hardware tokens in the browser (ADR 0062).** The kernel contract is the same when the
*person* signs with the certificate on their YubiKey: a local agent on their computer
(`tools/piv-agent`, Python on Yubico's `yubikey-manager`) signs `toBeSigned` on the PIV applet
after asking for the PIN in the OS's own dialog, and the engine's `createAgentPdfSigner` is the
`PdfSigner` over it — see `docs/pdf-rendering.md` → Signatures.

**Timestamps (PAdES-B-T).** `timestampRequest` with the signature value (base64) returns a DER
`TimeStampReq` (SHA-256 imprint, certificate requested, no nonce). POST it to an RFC 3161
authority as `application/timestamp-query`; the reply (the whole `TimeStampResp`, or its token)
goes to `complete` as `signing.timestamp.token`, and the kernel embeds it as the unsigned
`signatureTimeStampToken` attribute after checking it vouches for this very value. Ask for
`timestamp: true` at `sign` so the placeholder has room.

**Verifying.** `verify` reads every signature back: `byteRange`, `coversDocument` (nothing was
appended after it), `digestMatches` (the file still hashes to the CMS's `messageDigest`),
`certificateMatches` (the ESS signing-certificate attribute names the certificate carried),
the signer's certificate and its SubjectPublicKeyInfo (`signer.publicKey`, what a host imports
as an "spki" key), `toBeVerified` and `signature` (and `signatureP1363` for ECDSA under
WebCrypto), `signingTime` (`/M`), reason, location, the certification level, a timestamp's time
and whether it covers the value, and `attachments` — every embedded file with its SHA-256, so a
host can check the JSON it stored is the JSON the signature sealed. What the kernel does not do
is verify the signature value or the chain: the host checks the value over `toBeVerified` with
its platform crypto (three lines in every language) and decides trust — for its own records, by
comparing `signer.certificate` with its certificate. Nor does it judge what changed after a
certified revision (DocMDP diff analysis, a full validator's job); for a server's record,
`certify: "noChanges"` with `coversDocument: true` is the check.

### What the request must carry

- **Fonts** as base64 TTF/OTF (`fonts[]`), because the program has no file system. With none,
  the standard 14 fonts are used and characters outside WinAnsi become `?` (warning
  `font.unencodable`). The package ships DejaVu Sans (`loadFontPack()`), which covers Latin,
  Greek, Cyrillic, Arabic and Hebrew. A named family (a design system's `Lato`, `Noto Sans`) that
  no resource covers is drawn in the pack's sans-serif face, embedded, with one
  `font.fallback_default` warning; the standard 14 are the fallback only when no
  default pack was sent. A design system's own faces come from the PDF theme (`assets.fonts`):
  `createFaceFontProvider({ baseUrl })` loads them (`baseUrl` may be a function of the theme id,
  since each design system serves its fonts from a place of its own), converts WOFF 1.0 to the
  sfnt the program embeds (`woffToSfnt`, in the browser and in Node), and reports one face it
  could not load as a `font.faceFailed` warning on the result instead of failing the document.
- **Images** as bytes (`resources.images`), never URLs: the program does not fetch.
- **Data-source options** already resolved (`optionSnapshot`), the way ADR 0029 injects external
  data into the validation sandbox.
- **`env.createdAt`** (ISO instant) and **`env.documentId`**: the only time and identity the
  program ever sees. Same request, same bytes.
- **`unknownComponents`** (`"ignore" | "warn" | "fail"`, default `"warn"`, ADR 0043):
  what to do with a component whose type the program has no rendition for — a custom component
  no module registered. `warn` draws it generically and reports `component.unknown` in
  `warnings`; `fail` answers `{ "ok": false, "error": { "code": "unknown_component", … } }`. To
  teach the program the type, evaluate a module after the program:
  `__datum_pdf_register({ pdfRenditions: [{ componentType: "rating", id: "stars", render: (node, context) => [...] }] })`
  — a plain ES2020 expression, no imports; the first rendition contributed is the type's
  default.
- **PDF/A** (ADR 0059) needs nothing more than the layout: a layout whose
  `conformance.pdfa` is `2b`, `2u`, `2a`, `3b`, `3u` or `3a` renders as a file veraPDF accepts
  at that level, provided every family the document uses has a font resource in the request —
  under a claim a missing one is a `font` error, not Helvetica. TrueType and CFF/OpenType
  resources both embed. The "a" levels tag the document whatever the layout says and declare
  the "u" level instead (`pdfa.level`) where the promise cannot be kept — a `/Lang` that is no
  language tag, a fill that flattens or whose template's structure tree cannot be extended.
  `options.pdfa` (a level, or `false`) overrides the layout per call. The output condition
  (`conformance.outputIntent`) is one the program carries — `profile: { storage: "builtin", ref }`
  with `srgb`, `gray` or `cmyk` (SWOP-compatible), resolved inside the program — or an ICC
  profile inline (`profile.data`, base64); any other host-storage reference cannot be resolved
  inside the program and falls back to sRGB with `pdfa.outputIntent`. `attachData` under part 3 embeds the answers as
  an associated JSON file. The reply's `pdfa` says what the file declares; `fill` keeps a PDF/A
  template's own level (raised to part 3 when asked; under "a", the areas drawn and the widgets
  made join the template's structure tree) and returns none for a template that declares
  nothing (`pdfa.template`).
- **A signature** (ADR 0061): `signature.certificates` — the signer's certificate and
  its issuers, DER base64 — on `document`, `render`, `fill` or `sign`, with the settings above
  or on the layout. The private key never: the reply's `signing.toBeSigned` is what the host
  signs. The appearance is drawn with the first font resource (under PDF/A one is required).
  `renderFormPdf` refuses a reply that carries no `signing` rather than delivering an unsigned
  file.
- **Uploaded files as attachments** (ADR 0060): a `file` component whose
  `configuration.pdf.attach` is on (or whose `pdf-field` binding says `attach`) has its uploads
  embedded as associated files — `/AFRelationship /Supplement`, the component's label as the
  description, the file's MIME type as the stream's `/Subtype` — in any PDF, and beside the
  submission attachment under PDF/A-3; parts 1 and 2 leave them out with `pdfa.attachments`.
  The model carries them as `attachments[]` on the document (or the `fill` request); a
  `base64` upload travels in the value, while a file a host storage keeps reaches the program as
  its envelope and is left out with `attachment.unresolved` — the host resolves such files
  before the request (`renderFormPdf` does, through its template resolver). A budget over the
  files' declared sizes — `attachments: { budgetBytes, onExceeded: "skip" | "fail" }` on the
  `document` / `build` inputs, else the layout's `attachments: { budgetMb, onExceeded }`,
  else 4 MiB and `skip` — leaves a file past it out with `attachment.skipped`, or refuses the
  document with `attachment_budget`. The reply's `attachments` lists the names as embedded (a
  clash earns `-2`).
  In the sandbox, count on about a second and a half per megabyte of upload on top of the
  document, and keep a QuickJS host's reply under six megabytes (see the limits test).

## Sizes and timings

| | |
|---|---|
| Program, minified | ~1.1 MB (`dist/datum-pdf.program.meta.json` lists the largest inputs; 1,125 KB with signing, of a 1,200 KB budget) |
| Default font pack | 7 DejaVu files, ~2.5 MB; a host may ship two |
| Evaluate the program in QuickJS | ~0.5 s |
| 4-page form with fonts, widgets, a table (QuickJS) | ~3.4 s, ~2.2 s with `options.compact` |
| 150-row table, 9 pages (QuickJS) | ~7.6 s |
| One-page record rendered and prepared for signing (QuickJS) | ~1.8 s; `complete` and `verify` re-read the file, well under a second each |

In-process the same documents take well under a second. The document profile's 15 s budget
is the bound; a host that needs more raises `maxEvalMs`.

## Determinism

No `Date`, no `Math.random`, no `Intl`, no `localeCompare`; creation dates from
`env.createdAt`; a fixed name on every embedded font; `objectsPerTick: Infinity` so no timer is
scheduled; the trailer `/ID` from SHA-256 of `env.documentId`. The QuickJS hardening prelude
throws on any accidental use of the clock or randomness, so a regression fails the parity
suite rather than differing quietly.
