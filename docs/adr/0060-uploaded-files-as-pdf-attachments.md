# ADR 0060: Uploaded Files as Embedded Files in the Rendered PDF

## Status
Accepted.

## Context
A `file` component's value is the attachment envelope of ADR 0034 — the bytes inline as base64 for
the one storage kind that ships, a reference the host resolves for any other. On paper it has three
renditions: `text` (names and sizes), `field` (a read-only widget of the names) and `image` (a PNG
or JPEG drawn as a figure). The file itself would not travel with the PDF, which for a claim form
with a receipt, a scan or a photo attached is the half of the record that matters.

The kernel already knows how to embed a file. ADR 0059 §8 writes the submission's answers as an
associated file — an `EmbeddedFile` stream, a `Filespec` with `/AFRelationship`, the
`EmbeddedFiles` name tree and the catalog's `/AF`, all from `env` so the bytes are the same on
every host, and veraPDF-validated under PDF/A-3. Embedding the uploads is the same machinery
outside the PDF/A pass.

Three things have to be decided: where the switch lives, what a file a host storage keeps does at
render time, and how much a document may embed — a base64 upload is paid for in interpreted code
on the sandboxed hosts (ADR 0046, ADR 0043 §10 to §13), and the browser's QuickJS runtime has a
wall clock of fifteen seconds and a ceiling on how large a reply it frees cleanly. The guide is
[`docs/pdf-rendering.md`](../pdf-rendering.md#attachments-uploaded-files).

## Decision

### The switch is on the component, and a binding may override it
`configuration.pdf.attach` on the file component — **Attach uploaded files to the PDF**, in the
inspector's PDF section beside the rendition and *Leave out of PDFs* — is the instance rung. It is
offered by a capability of its own (`pdfAttachmentsCapability`), because only a file component
holds files and the switch would be authored and then ignored on any other. A generated layout's
`pdf-field` binding carries `attach` too: absent, the instance decides; a boolean either way is the
binding's decision, as `rendition` is — so an archival layout embeds what a print layout leaves
out. A template layout has no bindings, so the instance switch decides there alone. Attaching is
orthogonal to the rendition: a file drawn as `image` and attached is both a picture on the page and
a file in the pane.

### The render model collects; the service resolves; the kernel embeds
`buildPdfRenderModel` gathers the files into a top-level `attachments[]` on the `PdfDocument` or
the `PdfFillPlan`, through a `PdfAttachmentCollector` (`render/pdf/pdf-attachments.ts`): once per
distinct file (the same name, size and whole content) however many bindings draw it, each with the component's resolved label as its
description and `/AFRelationship /Supplement` — supporting material, where the submission is
`/Data`. A plugin rendition attaches what it draws through `context.addAttachment`, the sibling of
`addImage`.

A `base64` upload carries its bytes. A file a host storage keeps becomes a `PdfPendingAttachment`
— the envelope and the component id, no bytes — and `renderFormPdf` swaps it for its bytes before
the request through `PdfServiceDependencies.templates`, the resolver that already serves templates
and ICC profiles from the same envelope (`resolvePdfAttachments`, the shape of
`resolvePdfOutputIntent`); one it cannot supply is dropped with `attachment.unresolved`, the
component named. The program cannot fetch, so an envelope reaching the kernel through the
`document` op warns the same way.

`conformance.attachments` keeps carrying the submission JSON, and `PdfDocumentConformance.pdfa`
stays required: "conformance" means "this is PDF/A", and `render: { pdfa: false }` drops the
submission attachment, which is a conformance feature, while keeping the uploads, which are
document content.

The kernel merges the two lists in one place, `kernel/attachments.ts`, called from
`renderDocument` and `fillTemplate` after the metadata and before the PDF/A pass flushes the
fonts. With no claim or part 3 the files embed; under part 1 or 2 one `pdfa.attachments` warning
names them and nothing is embedded — ISO 19005-2 admits only PDF/A files as embedded files, and
the kernel does not inspect uploads to find out. A part-2 template raised to 3 takes them; a
template that declares nothing takes them as any PDF.

### A budget, with a policy of ADR 0043 §14's shape
Each layout has an `attachments: { budgetMb?, onExceeded?: "skip" | "fail" }` block; a host
overrides both per call, call over layout over default, each field on its own
(`resolvePdfAttachmentPolicy`). The budget is the sum of the envelopes' declared sizes, applied in
the render model before any bytes are copied. `skip` (the default) leaves a file past it out with
`attachment.skipped`, the component named, and a smaller one after it may still fit; `fail`
refuses the document with a `PdfKernelError` whose code is `attachment_budget`, thrown past the
rendition catch the way `unknown_component` is.

The default is **4 MiB**, and it comes from measurement (`quickjs-limits.test.ts` renders a
document carrying a full default budget of incompressible files and disposes the runtime): the
QuickJS host pays for raw bytes and far more for deflate, so small text-shaped uploads are
deflated and everything else is stored as it is, and at four megabytes a render finishes well
inside the fifteen seconds. An in-process host (the browser and Node without the sandbox, the JVM
and .NET running the WASI binary one process per request) is not held to the QuickJS host's fifteen seconds
and may raise the budget freely; a QuickJS host that raises it spends more of them in proportion.

## Consequences
- A form's uploads reach the PDF, in the browser, in Node and on every host running the program,
  with the same bytes everywhere; an archive under PDF/A-3 carries them as associated files
  veraPDF accepts.
- Bytes for a document with no uploads to attach are unchanged; the submission attachment is
  unchanged.
- The printed file name carries no link to the attachment: the page has no `FileAttachment`
  annotation.
- The default budget is the sandbox's, not the format's. A host that renders in-process and wants
  a 50 MB scan attached raises it; a QuickJS host that raises it renders slower, against the same
  fifteen-second budget.
- `fillClaim` returns no claim when the layout asks for none, even if the template's XMP says 2b,
  and the filled file then still says 2b with uploads inside it — the same is true of areas drawn
  into such a template.
