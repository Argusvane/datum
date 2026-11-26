# ADR 0098: PDF theme geometry, hints, fonts and the form look

## Status

Accepted.

## Context

A form and its generated PDF should look alike, under Datum's own look and under a design system's.
A PDF theme vocabulary of five colours, four type roles with a binary weight, a rendition per type
and two spacings leaves everything else on paper to a kernel constant — check boxes, borders, grey
labels, widget heights, cell padding, a fixed spacing table.

If every PDF theme names the generic `sans-serif` family, all print in DejaVu: design systems ship
their faces as WOFF and WOFF2, and the kernel program embeds TrueType or OpenType only (it carries
no brotli, `packages/pdf-kernel/src/woff-to-sfnt.ts`).

A form drawn by a binding (ADR 0162) still has to render to PDF, and the live drawing is a poor
source for it. A PDF is drawn by the portable kernel (ADR 0043), which can run on a server that has
never seen the binding; that path runs no design system's script and takes no answer into markup
unescaped.

Hints, the required marker and a field's prefix and suffix (ADR 0079) have to reach paper; a
`boolean` has to print as a mark and a `localized-text` in the document's language; the areas of a
filled template have to follow the theme.

So the engine and kernel have a real vocabulary. The engine's own PDF theme takes the **PDF form
look** at print size; a design system's PDF theme is authored from its published tokens at
true-to-screen scale (1 rem = 12pt), answers inside the form's own control box; and `datum-plain`
is the plain record as a theme. A PDF theme is a standalone `target: "pdf"` theme, never derived
from how the live form is drawn (decision 7 has the theme ladder and how a binding suggests one).
The designer canvas previews the layout's structure in Datum's own look; the PDF theme is seen in
the rendered PDF. The guide is [`docs/pdf-rendering.md`](../pdf-rendering.md#themes).

## Decision

### 1. The vocabulary

`PdfThemeSettings` (`render/pdf/pdf-theme-defaults.ts`) states the geometry of the paper form
beside type and colours: the box an answer is drawn in (`controls`), the drawn and AcroForm
choice marks (`choice`), the rhythm inside a field (`fields`), headings, tables, boxes, panels,
lists, spacing per block kind, two texts, seven optional type roles and a `scale`. Every block is
optional. A role a theme leaves out is drawn as the kernel derives it, `null` takes a role away,
and `scale` multiplies point sizes and gaps at resolve time, so a host prints a screen-scale
theme smaller without redrawing it. The document model carries the resolved blocks, and every
addition is optional, so `PDF_DOCUMENT_MODEL_VERSION` stays `1`; the program's `theme-controls`
feature tells a host it reads them ([`docs/reference/pdf-abi.md`](../reference/pdf-abi.md)). The
keys are listed in the guide.

### 2. Two layers of defaults, kept apart

- **The kernel's fallbacks** (`PDF_KERNEL_FALLBACKS`, read by `kernel/settings.ts`): the constants
  the kernel draws with. A document that carries no setting renders with exactly these.
  `tests/kernel-compat.test.ts` renders captured documents and holds their sha256.
- **The engine's defaults** (`DEFAULT_PDF_*`, what `resolvePdfTheme` fills in): the PDF form
  look. Every registered theme takes it unless it says otherwise.

`DEFAULT_PDF_THEME` (`datum-pdf`, "Datum (default)") is the `datum` binding's look on paper and
the theme ladder's last rung: what a form prints under when nothing names another.

`PLAIN_PDF_THEME` (`datum-plain`, "Datum (plain)") states the fallbacks as a theme — no frame, no
bands, no numbering, no capitals, hints and markers left out — for a host that wants the plain
record. It is registered beside the default in the web components' PDF theme registry. Affixes
print under every theme, plain included.

### 3. The PDF form look

The engine default at print size is a label above a boxed answer, hints under the label,
numbered sections on bands, a rule under the title, uppercase captions, a running footer with
the page count, the step line above a wizard's step, and a radio printing every option with the
chosen one marked (`components.radio.rendition = "checklist"`, merged into every theme's
choices). The values are `DEFAULT_PDF_*` in `pdf-theme-defaults.ts`, and the guide lists them.

### 4. A design system's theme, true to screen

`bindings/gcds/pdf/` is the worked example of a design system's PDF theme, a standalone theme (id
`gcds`) beside the live binding rather than part of Datum. Every value is read from the design
system's published tokens, so the theme tracks the pinned release; the token contract is in
`docs/binding-authoring.md`, section 10, and the values the tokens do not state are listed in the package with their source. The
theme ships no font files: it names the WOFF files of the design system's font package relative
to the folder the host serves for the live form, and sends the scripts the face lacks to the
DejaVu pack.

### 5. How faces reach the kernel

The kernel never reads `assets.fonts`. The render model lists the selected theme's faces on
`PdfRenderModel.fontFaces`, `renderFormPdf` forwards them in the font need (`PdfFontNeed.faces`,
with the theme's id), and a provider that can load files — `createFaceFontProvider({ baseUrl,
read })` in `@argusvane/datum-pdf-kernel` — loads the ones whose family the document names, once,
and answers ahead of the DejaVu pack (`composeFontProviders`). Each file is converted to sfnt as
it loads when it is WOFF 1.0 (`woffToSfnt`, lossless, in the browser and in Node alike).

The kernel embeds TrueType and OpenType only and design systems ship WOFF, so the host's font
reader is what turns the one into the other; Datum itself ships no design-system font files.
A face that cannot be read or converted is one `font.faceFailed` warning, never a failed
document: the family is drawn in the default pack (DejaVu). `createPdfSupport()` in
`@argusvane/datum` composes the two with the bundle's URL as the base, so `datum-pdf.js` imports
no binding package, and a server host sends a theme's faces as resources in the request's
`fonts[]`.

### 6. What the kernel draws

Frames wrap the answer and grow, never clip or shrink; a box taller than a page flows without its
frame with a `frame.overflow` warning, as a `pdf-box` does. Uppercase is applied when a run is
shaped, so measurement and drawing agree.

### 7. The PDF theme ladder

`selectPdfTheme` (`render/pdf/pdf-theme.ts`) picks the theme a document renders under, taking the
first rung that answers: the render call's `themeId`, the layout's `theme`, the host's default
PDF theme, the theme the form's binding suggests, then `datum-pdf`, the engine default
(`datum-plain` is the other built-in). An id nothing supplies gets a `theme.notFound` warning, and
the next rung answers. That includes a layout naming a PDF theme the host does not register, so a
layout authored on one host still prints on another. A theme whose target is not `pdf` is refused
at every rung (`theme.notPdf`). Nothing is derived from the form's look, and choosing a binding
writes nothing into the layout.

In the browser, the binding rung is the drawing binding's `pdfTheme` (`docs/binding-authoring.md`, PDF themes): an id the host
registered with `pdfThemes.register`, or the theme object itself. A binding without one leaves
the form on `datum-pdf`.

On a server host (ADR 0043 §12), the definition carries no binding: forms stay
design-system-neutral. The host's own configuration says which binding each form route is drawn
by, and the host catalog maps a binding id to the PDF theme it suggests, starting from
`builtinBindings` (`integrations/shared/catalog.ts`: `datum` → `datum-pdf`). A route's suggested
theme rides in the request as the host's theme, below the call's and the layout's own. A setting
that cannot work (an unknown binding, or a suggested theme no one supplies) is a configuration
error at start, and a `datum-host-check` case (PDF-06, run with `--pdf-bindings`) checks that two
routes on one host each get their own route's catalog theme.

## Consequences

- Every PDF prints in the PDF form look under `datum-pdf`; `datum-plain` is the plain record.
- A design system's PDF theme is authored on the same vocabulary from its own tokens, with its
  fonts served by the host; `bindings/gcds/pdf` shows the pattern, and nothing in Datum ships a
  design system's font files.
- A design system without a PDF theme renders under `datum-pdf`.
- A server picks the same PDF theme the browser would only when its catalog maps the route's
  binding as the page does. The host configuration keeps the two in step.
