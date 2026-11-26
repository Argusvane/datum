# PDFs

A PDF is a document made from the answers. It is drawn from a layout designed in the builder, or an existing fillable PDF is filled in. Either can:

- Be tagged.
- Be held to a PDF/A level.
- Carry the uploads and the record as attachments.
- Be signed.

With no layout at all, the PDF is drawn from the form's components as they appear on the page: tabs and steps run one after another, a grid becomes a table, buttons are left out. Set `pdf="auto"` and a PDF works with no layout work; design a layout when you want control.

## On the page

Set `pdf="auto"` and the element fetches `datum-pdf.js` beside the bundle on the first PDF. A form button with the PDF action, or `downloadPdf()` from the page, draws the PDF in the browser and hands it to the person.

```html
<datum-form src="/forms/intake.json" pdf="auto"></datum-form>
```

- The button checks the answers first, as Submit does. A form with an error shows the same summary and no PDF is made; warnings and notes do not stop it.
- `downloadPdf()` and `renderPdf()` do not check anything: they draw what the answers are.
- `submitAndDownload()` is not a PDF call. It submits, and saves the accepted submission as a JSON file.

The element has these PDF settings.

| Setting | Meaning |
|---|---|
| `pdf` attribute | `auto` for `datum-pdf.js` beside the bundle, or a URL for the module. Left out, there are no PDFs unless `pdfSupport` is assigned |
| `pdfSupport` property | The kernel, fonts and image fetcher, for a page that loads the module itself. See [Fonts](#fonts) |
| `pdf-theme` attribute, `pdfTheme` property | The PDF theme to draw with. See [Themes](#themes) |
| `pdf-unknown-components` attribute, `pdfUnknownComponents` property | What to do with a component that has no PDF drawing. See [Unknown components](#unknown-components) |
| `pdfTemplates` property | How a template layout's PDF is found when the definition does not carry it |
| `pdfSigner`, `pdfSignature` properties | Sign every PDF the form makes. See [Signing](/signing) |
| `features` attribute | A list without `pdf` leaves PDFs out: `renderPdf()` and `downloadPdf()` reject and `pdfLayouts()` is empty |

## From script

`renderPdf(options)` draws the PDF and resolves with the bytes and what the kernel said. `downloadPdf(options)` does the same, then announces the file and saves it. Both take the same options, all of them optional.

```js
const form = document.querySelector("datum-form");

// The same answers as an English and a French file
const en = await form.renderPdf({ locale: "en" });
const fr = await form.renderPdf({ locale: "fr", layoutId: "record" });
console.log(fr.fileName, fr.pageCount, fr.warnings);

await form.downloadPdf({ layoutId: "form-12", render: { pdfa: "2b" } });
```

| Option | Meaning |
|---|---|
| `layoutId` | The layout to draw, by id. It wins over every layout's `when`. See [How a layout is chosen](#how-a-layout-is-chosen) |
| `layout` | A layout object to draw instead of any the definition declares. No condition is tried, and `layoutChoice` reads `given` |
| `themeId` | A registered PDF theme to draw under, whatever the layout says. Wins over every other rung of [Themes](#themes) |
| `locale` | The locale to draw in, instead of the form's current one, without switching the live form. Every label, option, layout text, the document language and the text direction follow it. A form that declares its locales refuses one that is not among them |
| `fileName` | The file name. Left out, `<form id>-<layout id>-<stamp>.pdf`, with the locale after the layout id when one was asked for. The stamp is the date and time, such as `20261114-102030`, and anything outside letters, digits, dot, underscore and hyphen in the ids becomes an underscore |
| `render.compact` | Smaller files, slower to write. Default `false` |
| `render.tagged` | Overrides the layout's `accessibility.tagged` |
| `render.pdfa` | A PDF/A level to declare, or `false` for an ordinary PDF whatever the layout says |
| `hostContext` | An object the layout and the template mappings read as `host.<key>` |
| `unknownComponents` | `ignore`, `warn` or `fail`. Over the element's own setting |
| `attachments` | `{ budgetBytes, onExceeded }`: the budget for uploaded files the document embeds, in bytes, and `skip` or `fail`. Over the layout's own |
| `today` | The calendar day, `YYYY-MM-DD`, that `today()` reads in a layout's `when`, a visibility rule and an expression source. Left out, the form's own day |
| `formulaErrors` | `fail` (the default) or `warn`: what to do with a rule that cannot be read. `fail` rejects with the `formula_invalid` failure; `warn` drops the rule and warns `formula.invalid` |
| `riskyPatterns` | `refuse` (the default) or `allow`: a `matches` pattern of a catastrophic shape in a layout formula |
| `signature` | `{ signer, settings, timestamper }`: sign this PDF. Over `pdfSigner` and `pdfSignature`. See [Signing](/signing#the-person-signs) |

Both calls resolve with this.

| Key | Meaning |
|---|---|
| `bytes` | The PDF, a `Uint8Array` |
| `pageCount`, `pages` | The number of pages, and for each its `index`, `width` and `height` in points. A filled template reports no `pages` |
| `warnings` | What the kernel and the engine noted, each with a `code` and a `message`. A warning never stops the PDF. The codes are listed in the codes reference |
| `layoutId` | The layout that was drawn. A form with none gets a derived layout with the id `default` |
| `layoutKind` | `generated`, `template`, or `derived` when the form declared no usable layout |
| `layoutChoice` | How the layout was chosen: `given`, `asked`, `condition`, `default`, `fallback` or `derived` |
| `themeId` | The PDF theme the document was drawn under |
| `fileName` | The name the file would be saved as |
| `pdfa` | The PDF/A level the file declares, when it declares one |
| `attachments` | The names of the files embedded, after any suffix a name clash earned |
| `fields` | For a template layout, what became of each mapped field: `pdfField`, `status` (`filled`, `cleared`, `missing` or `unsupported`) and a `message` |
| `areas` | For a template layout with areas, the status of each: `filled`, `empty`, `overflow`, `missing` or `unsupported` |
| `document` | For a generated layout, the document model that was drawn, for a host that wants to inspect it |
| `signature` | When the PDF was signed: `field`, `algorithm`, `subFilter`, `certificates`, `timestamped` and `commitment` |
| `providerId` | The id of the PDF provider that drew it |

`downloadPdf()` resolves with the same details as the event below, plus `downloaded` and `cancelled`. It resolves with nothing when there is no form to draw or no PDF support.

### The datum-pdf event

Before the browser saves the file, the element raises a cancelable `datum-pdf` event on itself. It bubbles and crosses shadow boundaries. Call `preventDefault()` to take the bytes over, to upload them or show them in a viewer of your own; nothing is then saved.

```js
form.addEventListener("datum-pdf", (event) => {
  event.preventDefault();
  const { bytes, fileName, layoutId, warnings } = event.detail;
  uploadToArchive(new Blob([bytes], { type: "application/pdf" }), fileName);
});
```

| Detail key | Meaning |
|---|---|
| `bytes`, `fileName` | The file |
| `layoutId`, `layoutChoice` | The layout and how it was chosen |
| `pageCount` | The number of pages |
| `warnings` | The kernel's and the engine's warnings |
| `signature` | Present when the file was signed |
| `trigger`, `agent` | Present when the browser-assistant tools asked for the file. See [Assistants](/assistants) |

### Listing layouts

`pdfLayouts()` returns the form's layouts, named for the current locale, for a page that offers a choice.

```js
form.pdfLayouts();
// [{ id: "record", label: "Applicant copy", kind: "generated", isDefault: true, conditional: false },
//  { id: "form-12", label: "Form 12", kind: "template", isDefault: false, conditional: true }]
```

- `isDefault` marks what is drawn when no layout's condition holds.
- `conditional` says the layout has a `when`, so a download that names no layout may draw it from the answers; a picker offers an "automatic" choice once any layout is conditional.
- The list is empty when the form declares no usable layout (a PDF is still available, from the derived layout) and when `features` leaves `pdf` out.

## Layouts

A layout is the PDF workspace's page design: which components appear, in what order and grouping, with headings, text and the theme's geometry. A form may carry several. The [PDF layout reference](/pdf-layouts) lists every block, setting, rendition and placeholder.

| Block | What it is |
|---|---|
| Form field | One of the form's components, placed on the page, with its rendition (text, a fillable widget, ruled lines to write on, a check mark) |
| Text | A paragraph, heading or caption of the layout's own, with <code v-pre>{{fieldId}}</code> placeholders for answers |
| Image | A logo or picture, PNG or JPEG |
| Signature | A signature field the server or a viewer signs into, or a line to sign by hand |
| Section | A titled run of content |
| Table | Answers in rows and columns, with rows drawn once per entry of a collection |
| Repeat | A block drawn once per entry of a repeating section |
| Box | A framed or filled area, in the flow or pinned to a page |
| Rule, Spacer | A horizontal line; vertical space |
| Page break | A new page from here, with a page setup of its own if you want |

Every form component also carries its own PDF settings in the builder: a rendition, a switch to leave it out of PDFs altogether, and on file uploads whether the files ride inside the PDF as attachments.

### How a layout is chosen

The first of these that answers wins.

1. A layout passed whole as the `layout` option is drawn as given.
2. The layout named by `layoutId`. An id the form does not have, or has but cannot use, does not fall back to the default: a layout is derived from the form and `layout.notFound` warns. A typo here prints a plain generic PDF, so check the warnings.
3. The first layout, in list order, whose `when` holds on the answers.
4. The layout named by `defaultLayoutId`.
5. The first layout.
6. With no usable layout, one derived from the form.

A layout's `when` is a [formula](/formulas) over the answers as they would be submitted, by component id.

- It reads the form's own answers only, with no `row.`, `ancestor.` or `host.` names, and `today()` works.
- A condition that cannot be read or throws counts as not holding and warns `layout.conditionInvalid` or `layout.conditionFailed`.

```json
{ "id": "minor", "kind": "generated", "when": "age < 18", "root": { "…": "…" } }
```

The builder's Form settings and the layout list set the order and the default; a move never changes what is drawn when no condition holds.

## Themes

A PDF theme is the look of the paper: type, colours, the geometry of controls, headings, tables and boxes, spacing, and the words a document needs (Yes, No, "Page 1 of 3"). It has no stylesheet. A layout says what is on the page; a theme says how it looks. A PDF theme is a different object from the form's design-system look, and the form's look is never printed from.

The theme a document is drawn under is the first of these.

1. `themeId` in the call.
2. The layout's `theme`.
3. The theme set on the element with `pdf-theme` or `pdfTheme`: a registered id, or a theme object.
4. The PDF theme the form's binding suggests.
5. `datum-pdf`, Datum's own.

An id nothing supplies is skipped with `theme.notFound`, and a theme that is not a PDF theme with `theme.notPdf`; the next rung answers, so a layout written against one host's themes still prints on another.

Two themes ship:

- **`datum-pdf`.** The form look at print size: numbered section headings on bands, boxed answers, captions in capitals. On an element `default` is accepted as another name for it.
- **`datum-plain`.** The plainer record the kernel draws with no theme at all.

On a server, the program knows only the two shipped ids; send other themes as an object.

A theme is an object with an `id`, a `version`, `target: "pdf"` and a `pdf` block.

- Whatever the block leaves out takes Datum's own defaults.
- `extends` names a registered theme to build on, but the merge is shallow: a theme's `pdf` block replaces its base's whole.
- Register it once, and name it anywhere an id goes.

```js
import { pdfThemes } from "./datum-form.js";

pdfThemes.register({
  id: "acme",
  version: "1.0.0",
  target: "pdf",
  pdf: {
    colors: { accent: "#0b5a8f" },
    typography: { body: { size: 11 } },
    headings: { numbered: false }
  }
});
```

```html
<datum-form src="/forms/intake.json" pdf="auto" pdf-theme="acme"></datum-form>
```

What a `pdf` block may set:

| Key | Sets |
|---|---|
| `scale` | A number that multiplies every point size and gap the theme states: type, geometry, spacing. Margins, line-height ratios and counts are not scaled |
| `page` | Page defaults, as the layout's `page` setting |
| `typography` | Roles `body`, `label`, `heading`, `mono`, `hint`, `option`, `legend`, `required`, `small`, `affix`, `stepTag`, each with family, size, line height, weight, colour; and `fallbacks`, a family per script |
| `colors` | `text`, `muted`, `border`, `accent`, `surface`, and `controlBorder`, `controlFill`, `choiceMark`, `link`, `onAccent` |
| `controls`, `choice`, `fields`, `headings`, `table`, `box`, `panel`, `list`, `spacing` | The geometry of the paper form |
| `components` | Per component type, a `rendition` and a `style`; `*` is every type |
| `texts` | `yes`, `no`, `empty`, `pageOf`, `required`, `stepOf`, `attachmentDescription`, `signatureAlt` |
| `tagged`, `pdfa`, `outputIntent` | The defaults for documents under the theme that the layout does not set |

A value of `null` takes a setting away. A theme may ship font files under `assets.fonts`; see [Fonts](#fonts).

## Fonts

A PDF embeds the fonts it draws with.

- The browser module loads DejaVu Sans, regular and bold, from the `fonts/` folder beside `datum-pdf.js`. It covers Latin, Greek, Cyrillic, Arabic and Hebrew.
- `fonts/` also holds DejaVu Sans Oblique, Serif, Serif Bold, Sans Mono and Sans Mono Bold, which a page can ask for.

Chinese, Japanese, Korean, Devanagari, Thai and the other scripts have no glyphs in that pack. What happens to such text depends on the document.

- Under an ordinary PDF the character is drawn as the font's missing-glyph box, and the document warns `text.glyphMissing`.
- Under PDF/A, and when only the standard PDF fonts are available, the character is replaced by a question mark and the document warns `font.unencodable`.

The fix is a font that has the glyphs. A PDF theme names a font per script in `typography.fallbacks`, and the page supplies a font file of that family. The kernel splits text by script and draws only what the main font lacks in the fallback.

```js
import { createPdfSupport, loadFontPack, createFontProvider, composeFontProviders } from "./datum-pdf.js";
import { pdfThemes } from "./datum-form.js";

pdfThemes.register({
  id: "acme-cjk", version: "1.0.0", target: "pdf",
  pdf: { typography: { fallbacks: { Hani: "Noto Sans JP", Hira: "Noto Sans JP", Kana: "Noto Sans JP" } } }
});

const support = await createPdfSupport();
const noto = await loadFontPack({
  baseUrl: "/fonts/",
  entries: [{ id: "noto-sans-jp", family: "Noto Sans JP", weight: 400, style: "normal", file: "NotoSansJP-Regular.otf", coverage: ["Hani", "Hira", "Kana"] }]
});
support.fonts = composeFontProviders(createFontProvider(noto), support.fonts);

const form = document.querySelector("datum-form");
form.pdfSupport = support;
form.pdfTheme = "acme-cjk";
```

The scripts a theme can name are `Arab`, `Hebr`, `Cyrl`, `Grek`, `Hani`, `Hira`, `Kana`, `Hang`, `Deva`, `Thai` and `Cans`.

`datum-pdf.js` exports what the example uses.

| Name | What it does |
|---|---|
| `createPdfSupport(options)` | The kernel, the default fonts and an image fetcher, as one object for `pdfSupport`. Options: `fontsUrl` (where the font files are served, default `fonts/` beside the module), `fontIds` (which pack fonts to load, default `dejavu-sans` and `dejavu-sans-bold`), `bundleUrl` (what a theme's font files are relative to, a URL or a function from the theme id to one) |
| `DEFAULT_FONT_PACK` | The pack's entries: `id`, `family`, `weight`, `style`, `file`, `coverage` |
| `loadFontPack({ baseUrl, entries })` | Fetches the entries' files and returns font resources |
| `createFontProvider(resources)` | A font provider over a fixed set of resources |
| `createFaceFontProvider({ baseUrl })` | A provider for the files a theme ships under `assets.fonts`. Files may be WOFF, TrueType or OpenType. A file that cannot be loaded warns `font.faceFailed` and the default font stands in |
| `composeFontProviders(...providers)` | Several providers as one; the first to supply a resource id wins |
| `createInProcessPdfProvider()` | The kernel itself |

- A font family the document asks for that no resource covers is drawn in the pack's sans-serif face, with `font.fallback_default`.
- The standard PDF fonts, which encode a Western repertoire only, are the fallback when the host supplied no pack at all.
- Under PDF/A every font must be embedded, so a family with no resource fails the document with the `font` failure.

On a server, fonts travel in the request as base64 `fonts` resources. See [Running the PDF program](/pdf-program).

## Filling an existing PDF

Add a fillable PDF to the form as a template layout. Its fields appear in the designer.

- An uploaded template is embedded in the form, as base64, so the form can only grow to the limit a load accepts (`max-definition-bytes`, 2 MiB unless the page raises it). The builder refuses an upload that would take the form past it, saying the file's size, what the form would weigh and the limit, and changes nothing.
- A template kept in the host's own store leaves its bytes out of the form and is not limited this way ([Offering your own PDFs](/builder-element#offering-your-own-pdfs)).

On the bar of a template layout in the PDF workspace:

- **Suggest mappings** maps every unmapped field whose name matches a form component, comparing the field's last name segment with the component's id and then its label, ignoring case and punctuation. A checkbox takes its first export value as the checked value; a radio group takes none.
- **Create form fields** adds a form field for every template field nothing fills, and fills each from it, or from a component that already matches by name.
  - It carries over the kind: text, with its maximum length and whether it is multi-line; checkbox; radio group; dropdown or list as a select with the PDF's choices.
  - It carries over whether the field is required, and a label from the field's tooltip.
  - Signature, button, unreadable and read-only fields are left out, each with the reason.

More about filling:

- A value map turns an answer into what a field expects, such as a radio's export value.
- The filled PDF keeps the original's appearance; its fields can be shown or flattened.
- A PDF with no fields at all is filled with areas that draw the answers onto the page.

[PDF layout reference](/pdf-layouts#template-layouts) has mappings, sources, formats, value maps, areas, fill options, and how encrypted, XFA and PDF/A templates are handled.

## PDF/A

Levels 2b, 2u, 2a, 3b, 3u and 3a. Set the level in the layout's `conformance.pdfa`, or per call with `render.pdfa`. A PDF/A file:

- Embeds every font.
- Declares an output intent (sRGB unless the layout names a profile).
- Is tagged: level `a` forces tagging, and warns `pdfa.tagged` when the layout had turned it off.

More about the levels:

- A level `a` file promises a structure tree and a language. When the document cannot keep that, it declares level `u` instead and warns `pdfa.level`.
- A PDF/A file has no room for a CMYK JPEG under an RGB output intent, so the image is left out with `pdfa.image`.

## Attachments

Two kinds of file can ride inside a PDF.

- **The record.** The layout's **Attach the submission data** switch (`conformance.attachData`) embeds the answers as a JSON file named `submission.json` unless the layout names another. It works under PDF/A-3 only and is off by default. The file holds the form id, the layout id, the locale and the values.
- **Uploaded files.** A file upload's **Attach uploaded files to the PDF** switch (its `pdf.attach`) embeds what the person uploaded; a layout block can decide otherwise per use. Uploads can be embedded in any PDF but not under PDF/A parts 1 and 2, which warn `pdfa.attachments`.

Uploads share a budget, 4 MiB by default (4 × 1,048,576 bytes), charged by the larger of each file's declared size and its inline size. The layout sets it with `attachments.budgetMb`, a number of MiB, and `attachments.onExceeded`, and the call may override with the `attachments` option. When a file would pass the budget:

- `skip` leaves it out with `attachment.skipped` and keeps trying smaller ones.
- `fail` refuses the document with the `attachment_budget` failure.

Some files are never embedded:

- Programs and active content, such as executables, scripts and HTML, whatever their bytes (`attachment.refusedType`).
- A file whose inline data is larger than the size it declared (`file.sizeMismatch`).

File names are made safe: no path, no control or direction characters, at most 255 characters.

## Accessibility of the PDF

A PDF is tagged by default. Tagging writes a structure tree beside the page: headings, paragraphs, lists, tables with their rows and cells, figures and form fields, in reading order, which is the order of the layout.

- Decorations and the running header and footer are marked as artifacts so a reader skips them.
- Fillable fields carry a tooltip, the component's description or tooltip, which a screen reader announces.
- This is best-effort structure for assistive technology: no PDF/UA validator runs.

| What | How |
|---|---|
| Tagging | `accessibility.tagged` on the layout, default `true`; `render.tagged` per call; a theme's `tagged` below the layout |
| Language | `accessibility.lang`, else the locale the PDF is drawn in |
| Title | `accessibility.title`, else the layout's name, else the form's title; shown by the viewer unless `accessibility.displayDocTitle` is `false` |
| Images | A picture's `alt` text. Empty marks it decorative |
| Direction | Right-to-left locales draw right to left |

Set `alt` on every image and give fillable components a description or tooltip. The form's own accessibility is covered in [Accessibility](/accessibility).

## Unknown components

A component whose type has no PDF drawing at all, because it is not built in, not registered by a plugin and not read as a base type, is drawn generically. `pdf-unknown-components` (or the `unknownComponents` option) sets what else happens.

| Value | Effect |
|---|---|
| `warn` | The default. Drawn generically, and `component.unknown` warns |
| `ignore` | Drawn generically, and nothing is said |
| `fail` | The PDF is refused with the `unknown_component` failure |

The verdict is about the form and the layout, not the answers: a component hidden by a rule counts, and one the author excluded from PDFs does not. A type declared with a `base` is drawn as its base. A plugin gives a type its own PDF drawing with `pdfRenditions`.

## Signing

PDFs are signed with PAdES.

- A server signs with its own certificate, or the person signs through a small local agent with a certificate of their own: one on their machine as a file, or one on a YubiKey. A YubiKey is not required; with one, the PIN stays in the operating system's own dialog.
- A document-modification policy locks the signed PDF against later changes.
- An RFC 3161 timestamp can be added from your own timestamp server.

[Signing](/signing) has the whole flow.

A PDF signature proves the document has not changed since it was signed. A submission signature proves who sent exactly these answers. A form can use either, both or neither; see [Validation and the sandbox](/validation#signed-submissions).

## On the server

A host renders the same PDF from a stored submission with the same kernel, verifies a signed PDF, and reads a filled copy of a template back into a record, so a PDF someone filled in any viewer enters the same records as the web form. [Running the PDF program](/pdf-program) lists every request the program answers.
