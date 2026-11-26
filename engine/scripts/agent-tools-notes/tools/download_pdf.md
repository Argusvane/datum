Result:

```ts
interface DownloadPdfToolResult extends AgentOk {
  changed: true;
  undoable: false;
  delivered: "download" | "page";       // "page": a datum-pdf listener took the file (it cancelled the event)
  fileName: string;
  layoutId: string;                     // "" when the layout was derived from the form
  layoutLabel?: string;
  layoutChoice: "asked" | "condition" | "default" | "fallback" | "derived";
  pageCount: number;
  locale: string;
  pdfWarnings?: { code: string; componentId?: string }[];   // at most 20; the kernel's words are never returned
  morePdfWarnings?: number;
  next: string[];
}
```

`download_pdf` does what the form's PDF button does, with two differences: the checks run first and
their problems come back (`pdf-blocked`) instead of being painted on the form behind the person's
back, and the file never reaches the assistant. It goes to the person's device, or to the page when
a `datum-pdf` listener cancels the event (`delivered: "page"`); the listener hears
`trigger: "agent"` and the provenance account (see "Provenance"). `describe_form.pdf` lists the
layouts the form prints and whether the page signs its PDFs.

A page that signs its PDFs (it holds a `pdfSigner`) is refused `signature-required { because:
"pdf-signer" }` before anything renders, so a signer's PIN prompt or a timestamp request can never
start from a tool. The tool passes no `signature`, `hostContext`, `render` option, attachment or
file name: the seam admits `layoutId` and `locale` and nothing else.

A second call for the same layout and language at an unchanged revision is refused
`already-downloaded` unless `again: true` after the person asked for another copy. The call has a
budget of 60 s (support files, fonts and the render). A download the assistant starts carries no
user activation, so Chrome may ask the person to allow automatic downloads after the first one;
the tool cannot see that prompt, and `delivered: "download"` means the element did not cancel the
file, not that it landed.

Never in the result: the PDF's bytes, the fill reports (they quote the values), a signature, the
attachments or the document model. A `PdfWarning` contributes its `code` and `componentId` only.
The file name and the layout label are the form's own words.

Failure modes: `bad-input`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `stopped`, `busy` (`submission`, `pdf`), `stale`, `cancelled`, `timeout`, `feature-off`, `no-pdf`, `signature-required`, `unknown-layout`, `locale-unsupported`, `already-downloaded`, `pdf-blocked`, `pdf-failed`, `chunk-unavailable`, `internal`.

Example, the form's PDF, the layout its answers chose:

```json
// call download_pdf
{}
// result
{
  "ok": true,
  "tool": "download_pdf",
  "form": "form-1",
  "revision": 9,
  "changed": true,
  "undoable": false,
  "delivered": "download",
  "fileName": "travel-claim-claim-summary-en-20261025.pdf",
  "layoutId": "claim-summary",
  "layoutLabel": "Claim summary",
  "layoutChoice": "default",
  "pageCount": 3,
  "locale": "en",
  "next": ["Tell the person the PDF 'travel-claim-claim-summary-en-20261025.pdf' is downloading."]
}
```

Example, the same call again:

```json
// call download_pdf
{}
// result
{
  "ok": false,
  "tool": "download_pdf",
  "code": "already-downloaded",
  "message": "You downloaded this PDF already and nothing changed since.",
  "hint": "The person already has this PDF; call again with again: true only if they asked for another copy.",
  "retryable": false,
  "details": {"at": 1792897096186, "layoutId": "claim-summary"},
  "form": "form-1",
  "revision": 9
}
```

Example, required answers missing:

```json
// call download_pdf
{}
// result
{
  "ok": false,
  "tool": "download_pdf",
  "code": "pdf-blocked",
  "message": "The answers have 2 problems, so no PDF was made.",
  "hint": "Fix the listed problems with set_answers, then call download_pdf again.",
  "retryable": false,
  "details": {"errors": [{"code": "required", "message": "This field is required", "severity": "error", "source": "client", "path": "traveller", "id": "traveller", "label": "Traveller"}, {"code": "required", "message": "This field is required", "severity": "error", "source": "client", "path": "amount", "id": "amount", "label": "Amount"}]},
  "form": "form-1",
  "revision": 1
}
```

Example, a page that signs its PDFs:

```json
// call download_pdf
{}
// result
{
  "ok": false,
  "tool": "download_pdf",
  "code": "signature-required",
  "message": "This page signs every PDF it makes, so an assistant cannot make one.",
  "hint": "This page signs its PDFs, which is the person's act; tell them to use the form's PDF button themselves.",
  "retryable": false,
  "details": {"because": "pdf-signer"},
  "form": "form-1",
  "revision": 1
}
```
