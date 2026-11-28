# PDF rendering

How a form becomes a PDF, what an author decides, what a host wires, and how the same bytes
come out of a browser, a Node process, a Java or a .NET service. The decisions behind this are
in [ADR 0043](adr/0043-pdf-rendering-portable-kernel.md); this is the working guide.

## The shape of it

```
FormDefinition.pdf.layouts[]  +  the form tree  +  the answers  +  a PDF theme
        │
        ▼   engine (pure TypeScript, no PDF library)
buildPdfRenderModel()  →  PdfDocument (blocks, widgets, anchored boxes, metadata)   — a generated layout
                       →  PdfFillPlan (template bytes + field values)               — a template layout
        │
        ▼   PdfRenderProvider (the seam)
@argusvane/datum-pdf-kernel: one program, two providers
   createInProcessPdfProvider()   — imports the program's modules (browser, Node)
   createQuickJsPdfProvider()     — evaluates dist/datum-pdf.program.js in the QuickJS-WASM sandbox
   (a Java / .NET host embeds QuickJS and calls the same program)
        │
        ▼
%PDF- bytes, byte-identical whichever provider ran
```

The engine never touches PDF bytes. It resolves what each component should look like on paper,
evaluates `{{placeholders}}` and expressions, expands repeating sections, drops hidden fields,
and produces a JSON document the kernel lays out. Everything that needs a font, a page or a
byte lives in `packages/pdf-kernel`.

## Renditions: how a component appears on paper

Every component type offers a few *renditions* and a default. The engine's own types:

| Type | Renditions (default first) |
|---|---|
| `text`, `email`, `tel`, `url`, `number`, `date`, `time`, `textarea` | `text` (label and answer), `field` (fillable in a viewer), `ruled` (blank line) |
| `checkbox`, `boolean` | `checkmark`, `field`, `text` |
| `checkboxes` | `checklist` (every option, chosen ones ticked), `field`, `text` |
| `select`, `multiselect`, `radio` | `text`, `field`, `checklist`, `ruled` (a stored answer no option lists — one from before the list changed, or one whose data source failed — prints after the options as a chosen item labelled by its value, in `checklist` and `field` alike) |
| `password` (a host's or a plugin's type) | the generic set; its answer prints as `••••••••`, the review's mask, and a `field` widget is left empty |
| `file` | `text`, `field`, `image` — and, apart from the rendition, *Attach uploaded files to the PDF* embeds the files themselves (see [Attachments](#attachments-uploaded-files)) |
| `image` | `image` |
| `html` | `text` |
| `signature` | `line`, `field` (an unsigned signature widget — one the server may sign into, see [Signatures](#signatures)), `image` |
| `button` | `none` |
| `button-group` | `group` (its buttons print nothing, so neither does it; the default layout leaves it out) |
| `form` | `group`, `section` |
| `container`, `panel` | `group` (default), `section`, `panel` |
| `fieldset`, `step` | `section` (default), `group`, `panel` |
| `tabs` | `sections` (a section per tab, captioned with its label; an untitled tab with a lone `tab` component's label, else "Tab 2" by its place), `group` |
| `grid` | `table`, `group` |
| `dataGrid`, and any component with a `collection` | `table`, `sections` (a data grid, ADR 0153, defaults to `table`; its `layout: "stacked"` defaults to `sections`; each row is headed as on screen, the container's `rowLabel` with `{{n}}` filled, else "Row 2") |

The vocabulary is `PDF_RENDITION_CATALOG` in `core/schema/pdf-renditions.ts`; the renderers behind
it are in `render/pdf/standard-renditions.ts`, and a test holds the two equal. The catalog never
imports the render layer, so the form builder's **PDF** inspector section (`pdfOptionsCapability`,
which writes `configuration.pdf.rendition` and `configuration.pdf.exclude`) reads the catalog
alone. The `panel` rendition is a titled box (its geometry is the theme's `panel` block); no type
defaults to it, and a `panel` in the derived layout is bound as the component it is, so a theme's
choice draws it. A container rendition (`group`, `section`, `panel`) draws nothing at all, heading
included, when none of its children prints, as a layout section with *Skip when empty* does, so a
fieldset whose fields a rule hides leaves no orphan heading. A component definition adds or replaces renditions
through `ComponentDefinition.pdf`, and a plugin contributes them to existing types through
`FormPlugin.pdfRenditions`. Both reach the PDF through the runtime: `renderFormPdf` builds its
lookup from the runtime's component registry and the plugin platform's `pdfRenditions`
(`RenderableRuntime.pdfRenditionSources`), so a definition handed to `<datum-form
componentDefinitions>` or registered on a `FormRuntime` prints through its own renditions with
nothing else wired. A host that builds its own resolver passes it as
`PdfServiceDependencies.renditions`, which wins.

Which rendition wins, from the most specific:

1. the layout binding — `pdf-field.configuration.rendition`
2. the component instance — `configuration.pdf.rendition` (the form builder's **PDF** inspector section, which also has *Leave out of PDFs*)
3. the layout's `renditionDefaults[type]`, then `renditionDefaults["*"]`
4. the PDF theme's `pdf.components[type].rendition`, then `["*"]` (the engine's own form look
   picks `checklist` for a `radio`; a theme merges over that)
5. the component definition's `pdf.defaultRendition`
6. the engine's built-in default for the type
7. `text` for a leaf, `group` for a container

A named rendition the type does not offer falls through with a `rendition.unknown` warning; the
wildcard rungs are silent. A repeating component (a data grid, any component with a `collection`)
draws its rows as `table` or `sections` only: a named rung asking it for another (`checklist`) falls
through with `rendition.unknown` too. A binding's rendition a type lacks that the generic set draws
(`field` on a type nothing knows) is drawn, and is not reported as passed over. The same component bound twice as `field` draws two widgets of one
AcroForm field, which is what PDF means by it.

A file component's `attach` switch climbs the first two rungs of the same ladder: a `pdf-field`
binding's `attach` (a boolean either way, once set) beats the instance's `pdf.attach`; absent
on the binding, the instance decides.

### Unknown component types

A type that offers *no* rendition at all — not built in, not contributed by a plugin, not on a
definition the runtime holds — reaches rung 7 because nothing knows it. What happens then
is the `unknownComponents` policy (ADR 0043): `"warn"` (the default) draws it generically and
reports `component.unknown` once per component; `"ignore"` draws it and says nothing; `"fail"`
refuses the document with a `PdfKernelError` whose code is `unknown_component` (on the wire,
`{ ok: false, error: { code: "unknown_component" } }`). The verdict follows the schema and the
layout, not the answers: a component a rule hides still counts, one marked *Leave out of PDFs*
does not, and template layouts are never checked. The check runs on every bound form component
the layout reaches (a `pdf-field` binding, a container's children, a repeat's component, each
leaf of a bound collection's rows (the table formats those cells without a rendition, but the
policy asks whether the type is known at all)), before visibility is consulted, so a host that sets `fail`
gets the same verdict for every submission of the same form and layout. A type is *unknown* when
its rendition catalog is empty, which is exactly "this resolver, or this program, has never been
told about it"; a known type asked for a rendition it lacks is still `rendition.unknown`. `warn`
names the component, its type and the generic rendition used, once per component; `fail` names
the first offending component. A `PdfKernelError` raised inside a rendition passes through the
`rendition.failed` guard, which otherwise turns a rendition's exception into a warning.

Set it on the request (`unknownComponents` beside `form` and `values`), on the call
(`renderPdf({ unknownComponents: "fail" })`, `RenderFormPdfOptions`), or on the element
(`<datum-form pdf-unknown-components="fail">`, `pdfUnknownComponents` on the host and renderer
elements) for the toolbar's PDF button. To make a type known inside the sandboxed program,
register a module after evaluating it — `__datum_pdf_register({ pdfRenditions: [{ componentType,
id, render }] })`, the `modules` option of `createQuickJsPdfProvider` — and the first rendition
contributed becomes the type's default (on a built-in or defined type a contribution is one more
choice, never the default). In the engine the runtime says where renditions come from
(`RenderableRuntime.pdfRenditionSources()`: its component registry and the plugin platform's
`pdfRenditions`), so a definition-declared rendition prints on every host path with nothing
wired, and `renderFormPdf` builds its resolver from them unless `PdfServiceDependencies.renditions`
is given. A type the definition's `kinds` map names is read as its base engine type on every path
alike: `renderFormPdf` passes the runtime's definition's map (`pdf.kinds`) as the program's
`document` op passes its request's `kinds`, so a `gcds-checkbox` prints as the checkbox it is and is
never an unknown component.

## Themes

Paper is not styled with stylesheets. A PDF theme is a `PdfThemeDefinition` (`target: "pdf"`) with
a `pdf` block of numbers and colours — page defaults, typography (body, label, headings, mono,
per-script fallbacks), a palette (text, muted, border, accent, surface), per-type rendition and
style (spacing, stacked or inline labels, ruled line count, widget height), and the words no field
supplies (yes, no, the empty dash, "Page x of y"). The engine ships two: `DEFAULT_PDF_THEME`
(`datum-pdf`) and `PLAIN_PDF_THEME` (`datum-plain`). A host registers more in the page's PDF theme
registry (`pdfThemes.register` from `@argusvane/datum`, a `PdfThemeRegistry` in the engine).
The GC Design System binding's package exports one, `gcdsPdfTheme` from `@argusvane/datum-binding-gcds/pdf`
(id `gcds`), as the worked example of a design-system package that carries its own paper.

Which theme a document renders under, from the most specific:

1. the render call — `renderFormPdf(runtime, deps, { themeId })`, `renderPdf({ themeId })`
2. the layout — `PdfGeneratedLayout.theme`, the PDF side's **PDF theme** property on the document
   (a select of the host's registered themes, or a free id when the host lists none)
3. the host's default — `deps.theme`, `<datum-form-host>.pdfTheme`, `<datum-form pdf-theme>`
4. the PDF theme the form's binding suggests — `LiveBinding.pdfTheme`, an id the host's registry
   holds or a theme object. A suggestion, never a derivation: nothing about the binding's look is
   turned into paper. The GC Design System binding suggests `gcds`; the Datum binding suggests
   nothing. On a server host the suggestion is the host catalog's `pdfTheme` for the binding id
   the host serves the form with (the `bindings` settings of [Spring Boot](spring.md) and
   [FastAPI](fastapi.md)), and the PDF reply names it in `X-Datum-Pdf-Theme`
5. the engine default, `datum-pdf`

A theme of another target is refused at every rung (`theme.notPdf`), and nothing is derived from a
form look. An id is looked up through `deps.themes` (`<datum-form-host>.pdfThemes`): the host's
registry, or a `(id) => theme` function; `datum-pdf` and `datum-plain` answer without one. An id
nothing supplies is a `theme.notFound` warning and the next rung answers — a layout authored
against one host's registry still prints on another. The result's `themeId` says which theme
printed.

```ts
const pdfThemes = new PdfThemeRegistry();
pdfThemes.register(DEFAULT_PDF_THEME);
pdfThemes.register(GCDS_PDF_THEME);
const result = await renderFormPdf(runtime, { provider, fonts, themes: pdfThemes, theme: GCDS_PDF_THEME }, { layoutId: "record" });
// result.themeId → the layout's `theme` if it names one, else "gcds"
```

A theme names either the kernel's font pack — `sans-serif`, `serif`, `monospace` — or a face it
ships (ADR 0098): `assets.fonts` lists TrueType, OpenType or WOFF 1.0 files relative to the folder
the host serves for that theme. Each entry is a `ThemeFontFace`: `family` (the name the theme's
typography uses), `weight` (default 400), `style`, `file` (relative to the bundle's own URL, or
absolute) and `coverage` (the script tags it covers, default `["Latn"]`). The files are served from a folder per theme
(`createFaceFontProvider({ baseUrl })` in `@argusvane/datum-pdf-kernel`; `baseUrl` may be a
function of the theme id) and converted to sfnt on load, and the engine forwards
them in the font need. A face the host could not load is a `font.faceFailed` warning and the rest
still load. A family nothing supplies is drawn in the default pack's sans-serif face with a
`font.fallback_default` warning; Helvetica (`font.fallback_standard14`) is the fallback only for a
host that sends no default pack. The designer's canvas previews the layout's structure in Datum's
own look; the PDF theme shows in the rendered PDF.

Beyond type and colours a theme states the paper form's geometry (ADR 0098). Every block is
optional, a theme leaves unsaid what the engine states, and `null` on a field takes the base's
value (or nothing, for an optional field). The source of the types is
`render/pdf/pdf-theme-defaults.ts`:

| Block | Keys |
|---|---|
| `typography` | `weight` and `transform` (`uppercase`) on a font spec, `lineHeights` per heading level, and seven optional roles: `hint`, `option`, `legend`, `required`, `small`, `affix`, `stepTag`. A role a theme leaves out is drawn as the kernel derives it (a hint at body size in the muted colour, an option in body type, a legend in label type); `null` takes a role away |
| `colors` | `controlBorder`, `controlFill`, `choiceMark`, `link`, `onAccent`, falling back to the border, white, the text colour, the accent and white |
| `controls` | the box an answer is drawn in: `borderWidth`, `radius`, `padding`, `minHeight`, `textareaRows`, `fontSize` (the widget appearance's; absent, the viewer's automatic size), `maxWidth`, `valueFrame` (`none` or `box`), `selectMark` (`none` or `chevron`) |
| `choice` | the drawn mark and the AcroForm widget: `size`, `widgetSize`, `borderWidth`, `radius`, `markStroke`, `dotSize`, `labelGap`, `optionGap`, `legendGap`, `columns` |
| `fields` | the rhythm inside a field: `labelToValue`, `labelToControl`, `labelToHint`, `hintToControl`, `hints` (`hidden` or `shown`), `hintPosition` (`afterLabel` or `afterControl`), `inlineLabelWidth` (points or `{ fraction }`: a label column for the `inline` arrangement and a widget's `before` label) |
| `headings` | `numbered`, `band` (`none`, `surface` or `accent`), `bandPadding`, `titleRule`, `titleRuleWidth` |
| `table`, `box`, `panel`, `list` | cell padding, border width, row minimum, header fill and weight, a stripe fill; a `pdf-box`'s defaults with a radius; the `panel` rendition's border, radius, padding, fill, header fill and padding; indent, gap and bullet |
| `spacing` | `[before, after]` per block kind, over the kernel's own |
| `texts` | `yes`, `no`, `empty`, `pageOf`, `required` (`""` draws none, as the live form reads empty wording), `stepOf` (`""` draws none), `attachmentDescription`, `signatureAlt` |
| `components[type].style` | `spacingBefore`, `spacingAfter`, `labelArrangement`, `ruledLines`, `widgetHeight`, `width` (a narrower frame or widget for a type), `color`, `size`. A value of the wrong kind (`"12"`, a negative or infinite number, an arrangement other than `stacked` / `inline`) is dropped with a `style.invalid` warning, the rest kept (`readPdfComponentStyle`, which a `pdf-field` binding's `style` goes through too) |
| `scale` | a multiplier over every point size and gap, applied at resolve time; ratios, counts, fractions and page margins are not scaled. A host prints a screen-scale theme smaller with `{ ...GCDS_PDF_THEME, pdf: { ...GCDS_PDF_THEME.pdf, scale: 0.8 } }` |

The document model carries the resolved blocks beside `typography` and `colors`, and the blocks
gain what the renditions decide (`hint`, `labelSuffix`, `prefix`, `suffix`, `frame`, `control`,
`width` on a label/value; `hint`, `labelSuffix`, `prefix`, `suffix` on a widget; `marker` (`check`
or `radio`), `hint`, `labelSuffix` on a checklist; `tag`, `number`,
`band`, `rule` on a heading; a `list` block; `header` and `radius` on a box; `weight`, `link` and
`transform` on a run), all optional, so `PDF_DOCUMENT_MODEL_VERSION` stays `1`.

Two layers of defaults are kept apart. The kernel's fallbacks (`PDF_KERNEL_FALLBACKS`, read by
`kernel/settings.ts`) are the constants it draws with when a document carries no setting;
`tests/kernel-compat.test.ts` renders captured documents and holds their sha256. The engine's
defaults (`DEFAULT_PDF_*`, what `resolvePdfTheme` fills in) are the form look, which every
registered theme takes unless it says otherwise. `PLAIN_PDF_THEME` (`datum-plain`, registered
beside the default in the web components' PDF theme registry) states the fallbacks as a theme —
no frame, no bands, no numbering, no capitals, hints and markers left out — for a host that wants
the plain record, and a document carrying none of the settings renders as that record draws it.
Affixes print under every theme, plain included.

The form look, at print size: a 10 pt sans body on a 1.3 leading; 8 pt bold uppercase captions in
the muted colour; hints under the label; the answer inside a 22 pt box with a 0.75 pt border, 2 pt
corners and 4 pt padding, a textarea three rows deep, a chevron on a select; 11 pt check boxes and
radios with a 1.5 pt tick or a 5 pt dot; section headings on a surface band, numbered in reading
order ("1", "1.1"); a rule under the title; the running footer as the title at the start and "Page
x of y" at the end (the derived layout's footer is a borderless two-column table, sized to the
theme's small type); the required marker the live form words (`*`); the step line "Step 2 of 3"
above a wizard's step (a `steps` container's children become sections that know their place,
`step: { index, total }`); and a radio printing every option with the chosen one dotted
(`components.radio.rendition = "checklist"`, merged into every theme's choices). A `boolean`
prints as a check mark and a `localized-text` value in the document's language; authored HTML
keeps `strong`/`b`, `em`/`i` and `a` as runs, `br` as a break and `ul`/`ol` as lists.

What the kernel does with it: a frame wraps the answer and grows, never clips or shrinks; a box
that fits a page but not what is left of one moves whole to the next page with its label and hint;
one taller than a page flows without its frame with a `frame.overflow` warning, as a `pdf-box`
does. Rounded corners are pdf-lib's `rx` / `ry` and a radio is a circle; choice rows taller than a
line centre the caption beside the box, and `columns` lays options out row by row. Widgets take the
theme's border width, control colour and fill and, when the theme names `fontSize`, a sized
appearance unless a single-line value would overflow, where the viewer's automatic size stays;
pdf-lib pads a widget appearance 1 pt and grows its rectangle by half its border, so the theme's
padding reaches framed values, not AcroForm widgets. Uppercase is applied when a run is shaped, so
measurement and drawing agree (QuickJS has no locale-aware casing, so a Turkish dotless i is
`toUpperCase`'s). Lists are `L` > `LI` > `Lbl` + `LBody` in the structure tree, and bands and rules
are artifacts. Template areas draw with the plan's typography and colours when the area's own
`draw` says nothing. A running band and an anchored box hold a fixed height, so their overflow
checks measure what the content occupies (the spacing that trails the last block is not counted; a
flow box's height still includes it); a layout saved with bands sized for one theme's type can
still overflow under a larger one, the warning says by how much, and the designer is where the
band grows.

A design system's PDF theme is authored from its published tokens, as a standalone theme beside
the live binding (`bindings/gcds/pdf`, id `gcds`): the theme writes the `var()` the design
system's CSS uses, resolved against `tokens.generated.ts`, cut by `scripts/generate-tokens.mjs`
from the pinned `@gcds-core/tokens` release, at true-to-screen scale (1 rem = 12 pt; a length
converts from px, rem or pt only, any other unit throws), with answers inside the form's own
control box. The values the tokens do not state (the page size and margins, among others) are
listed in the package's `tokens.json` under `inferred`, with their source. The theme ships no font
files: `assets.fonts` names the WOFF files of `@gcds-core/fonts`, and `typography.fallbacks` sends
Greek, Cyrillic, Arabic and Hebrew to the DejaVu pack.

## Layouts

`FormDefinition.pdf` holds named layouts and which is the default:

```json
{
  "layouts": [
    { "id": "record", "kind": "generated", "root": { "id": "document", "type": "pdf-document", "children": { "body": [], "header": [], "footer": [] } } },
    { "id": "gov-form", "kind": "template", "template": { "storage": "base64", "name": "form.pdf", "type": "application/pdf", "size": 1234, "data": "…" }, "fields": [] }
  ],
  "defaultLayoutId": "record"
}
```

No layouts at all: the engine derives one from the form tree (`deriveDefaultPdfLayout`) — the
title, tabs and wizard steps as sections, grids as tables, collections and data grids as row
tables, buttons dropped, and fields a rule hides dropped at render time under the same
effective-state policy the submission applies. A container whose label the author hid
(`hideLabel`) heads no section; an untitled tab is captioned by its lone `tab` component's label,
else by its place ("Tab 2"), never its slot id; and the form's title prints as written, a
placeholder in it included (it is carried as a literal, never read as a template). A definition holds only the layouts the author
made: the builder derives nothing into it, and leaves `pdf` out when the configuration has no
layouts (`pdf: {}` and `pdf: { layouts: [] }` read back without it).

### Several layouts per form

One form usually needs more than one PDF — a client-facing copy, a back-office record, a paper
form filled in — so `layouts` is a list and every layout is named. The renderer's PDF button
offers a picker when there are several; `defaultLayoutId` is what a plain "Download PDF"
produces when no layout's condition holds (see the next section). The list itself is edited
through the catalog functions in `builder/pdf-designer/layout-catalog.ts` (ADR 0044):
`addPdfLayout`, `replacePdfLayout`, `removePdfLayout`, `duplicatePdfLayout`, `movePdfLayout`,
`setDefaultPdfLayout`, `newGeneratedPdfLayout` (derived from the form, or blank), with ids kept
unique (a duplicate id throws), `pdfLayoutIdFromName` / `uniquePdfLayoutId` for ids and
`effectivePdfDefaultLayoutId` for what `findPdfLayout` would fall back to. A rename through
`replacePdfLayout` carries the default along; `removePdfLayout` makes the first survivor the
default when the removed layout was; `duplicatePdfLayout` deep-copies under `<id>-copy` and
"<name> (copy)". Each function returns a new configuration and changes nothing on the runtime
side.

A layout has one name. The designer seeds it onto the document root, where the inspector's
*Layout name* box edits it; the panel refuses an id another layout holds, and a name typed over
an unchanged localized name keeps its translations. The name lives only at the top level of the
layout: the builder's tree carries it on its root, as it carries `when`, and `layoutFrom` takes it
off again. Opening a layout writes nothing (the mode pins it on the page with `keepShown`), and a
layout handed back as the catalog holds it is never rewritten, so a definition keeps its bytes
until the author edits. A rename, replace or new id made through the catalog by a host
(`renameLayout`, `replaceLayout`) reaches a designer that is built but not on the page: a name
alone is pushed into its tree as an unrecorded change, any other change drops it so that it is
built again from the catalog on its next visit, and a designer whose id left the catalog is
disposed. The catalog change is a step of the form's history (ADR 0180), never of a designer's
tree.

A form need not have a layout, and the last one can be removed (through `removeLayout` or the
documents menu); a mode that loses its last document hands the page back to the form, and the
panels then point at an idle controller with no palette. With no
layout the PDF side's canvas shows a card in the sheet's place (`data-pdf-empty`) that says what
a layout is, says a PDF still prints from the form, and offers *New layout…*; the add popover
leaves out *A copy of this layout*. *Preview PDF* and `renderPdf()` print the derived layout, and
*From the form* in the popover is how an author asks for it as a layout of their own, to arrange
or make the default.

### Layouts chosen by the answers

A layout may carry `when`, a condition in the rules language (ADR 0044), written as a formula
(`province = "QC"`, ADR 0139; [formulas.md](formulas.md)) or as an expression tree: a download that names
no layout prints the first layout, in the list's order, whose `when` holds on the person's
answers — a French copy for Quebec, a large-print copy for whoever asked for one — else the
declared default.

```json
{
  "layouts": [
    { "id": "standard", "kind": "generated", "root": { "id": "d1", "type": "pdf-document", "children": { "body": [] } } },
    { "id": "quebec", "kind": "generated",
      "when": "province = \"QC\"",
      "root": { "id": "d2", "type": "pdf-document", "children": { "body": [] } } },
    { "id": "paper", "kind": "template", "when": "wantsPaper", "template": { "storage": "url", "ref": "/templates/paper.pdf", "name": "paper.pdf", "type": "application/pdf", "size": 1234 }, "fields": [] }
  ],
  "defaultLayoutId": "standard"
}
```

**One order, everywhere.** Every path — the browser's `renderFormPdf`, the program's `document`
and `build` ops, the submissions server, the docs site's server examples — goes through one engine
function, `selectPdfLayout`, and reports how it chose as `layoutChoice`:

| `layoutChoice` | What printed |
|---|---|
| `given` | a whole layout the caller handed over (`layout`: the designer's preview, a server's inline template) |
| `asked` | the layout named by id (`layoutId`, matched exactly; an id the form lacks derives one, with `layout.notFound`) |
| `condition` | the first layout whose `when` held — the default is tried in its place in the list too |
| `default` | `defaultLayoutId`, when no condition held |
| `fallback` | the first layout, for a form that declares no default |
| `derived` | one derived from the form tree: the form declares no usable layout |

An explicit choice always wins over the conditions: a host's `layoutId`, a layout picked in
`<datum-form-host>`'s picker, an operator's layout in a submissions server's PDF settings (`PdfSettings.layoutId`), a
sample's `LAYOUT_ID`. What names nothing follows them: `<datum-form>`'s `pdf` button,
`renderPdf()` and `downloadPdf()` without options, `<datum-form-host>`'s picker on *Automatic
(by the answers)* — its first entry whenever a layout has a `when` — and the submissions server
when no layout is set. `renderFormPdf`'s result, the `datum-pdf` event's detail and a stored
PDF (`StoredPdf.layoutChoice`) all say which layout printed and why, as does the submissions
renderer's `SubmissionPdfRenderResult.layoutChoice`; the providers pass the reply's fields on
from `document`, and the file name follows the layout.

**What a condition reads.** The answers as they would be submitted, keyed by component id —
the view a server holds, so the browser and every server choose alike:

- in the browser, `FormRuntime.submittableValues()`: the runtime's own fold (ADR 0178 decision 2;
  `RenderableRuntime.submittableValues?()` is optional, and a runtime without it, the builder
  preview's, falls back to the state's values; `PdfRenderModelOptions.selectionValues` carries
  the view to the render model), so an answer on a journey branch the person left, or one hidden and excluded or cleared, chooses
  nothing, even while the page still holds it (a retained hidden answer chooses alike on both
  sides, and a download mid-journey reads the predicted path over the answers so far);
- on a server, the values the sandbox judged (`recordValuesOf(record)` in the submissions
  service, the sandbox's `values` in the samples), which come out of the same fold.

Each answer is read as the envelope's JSON carries it: a calculation that came out `NaN` (a
division by an empty or zero answer) or `Infinity` reads as `null`, and an entry holding
`undefined` is absent — so `ratio does not equal null` holds for an unanswered ratio but not for
one that could not be worked out, in the browser as on the server. Only the keys the form
defines are read — a data grid's cells among them (`orders[0].qty`) — so a value under a key no
component owns (a host's extra) chooses nothing directly, since a server that strips unknown
fields (the default) never sees it; a calculation that read it and is stored under a key the
form defines chooses alike on both sides (ADR 0178 decision 2). What prints reads the answers
the same way: a `NaN` prints as an unanswered value, in the browser's download as on the
server.

Form scope only: `row.`, `ancestor.` and `host.` read nothing, so a condition never depends on
what one host knows and another does not. A field inside a repeating section or a data grid is not one value,
and the section itself reads as nothing: its entries travel row by row (`items[0].sku`), so
`len()` of the section is 0 here as it is in every rule and calculation, and a condition
cannot count them. Which journey the person took is not an answer and cannot be read; an
answer or a calculated field the journey sets can. A host's `transformValues` hook runs at
submit only, so a condition over a field it rewrites can choose differently before and after
the submit.

**Formulas in a condition.** A `when` string is parsed before the choice, with the whole function
library (`age(dateOfBirth) >= 18`, `if … then … else …`; see [formulas.md](formulas.md)). The tree
form is still read. A layout's `when` runs in the program or the browser that renders; `run` may be
`both` or `browser` only. `today()` and `age()` read the day the call supplies
(`PdfDocumentInputs.today`, the sandbox-judged day on a server), else the runtime's, else the local
date; a server should send the day it validated the submission under. A condition that reads the
clock where none is given never holds. `formulaErrors` (`fail`, the default, or `warn`) decides what a
formula that does not parse does: under `fail` the program refuses the request with
`formula_invalid`, and under `warn` (an opt-in for authoring and preview) the condition is absent
and never holds and the warning `formula.invalid` is added (ADR 0139 decision 6). Functions a plugin contributes reach the program through the
plugin's `functions` key; a program without it treats such a call as no result, so the condition
never holds.

**When a condition cannot run.** A `when` that is not a condition the evaluator can run all the
way down (a misspelt operator, a missing operand, a formula that does not parse) never holds and
warns `layout.conditionInvalid`; one that throws counts as not holding and warns
`layout.conditionFailed`. Neither makes the layout unusable: it still prints by id, as the
default, or as the fallback, and the definition still loads. `validatePdfLayout` does not check
`when`, so Open never refuses a file over it and the builder never drops it; `when: null` is no
condition. The one canonical place is the layout's top level: the generated designer lifts a
`when` edited on the document root back there.

**Declare the default.** With no `defaultLayoutId`, the first layout prints when no condition
holds — even a conditional one. The builder writes `defaultLayoutId` down as soon as any layout has a `when`, so
every reader agrees on the default (on add, replace — the Rules tab's save goes through it —
duplicate and remove, never on opening a layout; `removePdfLayout` and `movePdfLayout` keep a
declared default); a hand-written definition should do the same.

**Knowing the layout ahead.** `selectPdfLayoutForValues(definition, values, { layoutId })`
(render layer) is the render model's own choice for a set of value-path-keyed answers — what a
host asks to resolve a template's bytes, have a signer ready or name a file before rendering.
`pdfLayoutCandidates(definition)` lists every layout a download naming none can print (the
conditional ones in order, then the one printed when none holds): a host that must resolve
templates, fonts or signers before it knows the answers prepares for all of them — a
conditional template whose source is not inline prints only where a resolver exists, so only
the people whose answers choose it would otherwise find out. The submissions server names the
layout when it cannot (`pdf.failed: Template layout "x" (its condition held on the answers) has
no PDF this server can resolve: …`) and still accepts the record; the same preparation covers
what else depends on the layout (`signature.required`, the PDF/A-1/2 attachment drop). The
builder says so ahead as the advisory `pdf-layout.condition.template-source`. `findPdfLayout`
stays condition-blind: it answers "what prints when no condition holds". A submissions server
renders with the definition it registered, not the live one.

**The program.** `when` travels inside `pdf.layouts[]`, with no request key of its own. A `document` or `build` that names neither `layoutId` nor `layout` chooses by the request's
`values` — send the sandbox's validated `values`, so the choice is the browser's. The `build`
reply adds `layoutChoice`; the `document` reply names the layout that printed (`layoutId`,
`layoutKind`, `layoutChoice`) where `render`, handed a document already built, names none. A
host that keeps template PDFs outside the definition calls `build` first and sends its
`layoutId` back on `document` with that layout's bytes: `document` refuses, with the `template`
code, bytes sent without a layout id when a condition chose a template layout other than the
one printed when none holds — they were resolved for another layout, and its fill plan would
fill the wrong PDF. Bytes sent for the very layout a condition chose, and bytes beside a
generated layout a condition chose (which takes none), are not refused.

**Formulas in the program.** The program reads a layout's `when` and a field or area
`expression` written as formula strings, calls the plugin functions it was
registered with, and accepts the `if` node. The request may carry `today` and `formulaErrors` (default `fail`, `warn` is the opt-in, ADR 0139 decision 6).

### Conditions in the builder

The PDF mode lists a form's layouts as the documents of the bar (the label names the one on the page; the PDF overview lists them), and the
builder is where `when` is written and the order is kept. The default pill marks the declared
default; `effectivePdfDefaultLayoutId` and the model keep "the declared default, else the first"
and pin the layout actually shown once a designer is built on it, so saving a `when` on an
implicitly opened layout, or setting another default, never swaps the controller, the panels
and the canvas out from under the author.

**The Rules tab.** A layout's root (`pdf-document`, and a populated form's `pdf-template`) has a
Rules tab with one targeted rule, "Print this layout when" (`pdfLayoutRuleDescriptors`,
`builder/pdf-designer/layout-conditions.ts`); every other layout node has no Rules tab, because
a layout node carries no rules the PDF reads. The designers carry the root's `when` and lift it
to the layout's top level, so a save lands there through `replaceQuietly`, which writes the
default down. Opening a layout is not an edit: it is handed back with `declareDefault: false`,
so a definition with conditions and no declared default keeps its shape, and says so
(`pdf-layout.no-default`), until the author saves, duplicates or copies. The rule's field
options (`pdfConditionFieldOptions`) are the form's answer-holding components outside every
repeating section, in the outline's order, labelled "Label (id)" (the id alone when a component
has no label) in the builder's locale; a data-scoping container is left out and its fields
listed, because answers are keyed by component id and the container's own id reads as nothing.

**The opening line.** Above the rule the panel says what a condition reads — the answers as they
would be submitted, by component id, not which journey was taken; no `row.`, `ancestor.` or
`host.`; ids, not the layout's `{{…}}` placeholders — and the layout's place: "Its condition is
tried 2nd of 3; when none holds, Standard prints", that it is the default, or that with no
condition it prints only when a host asks for it by id. It reads the Rules tab's unsaved
condition too (`withPdfLayoutCondition`), so it follows the typing, and a catalog action that
changed the conditions, the order, a name or the default repaints the layout on the page.

**Findings.** Advisory notes, one per code and layout, shown under the condition and above the
Properties sections; none holds Save back, and the condition's boxes name them in
`aria-describedby`.

| Code | Says |
|---|---|
| `pdf-layout.condition.invalid` | the condition is not one the evaluator can run |
| `pdf-layout.condition.scope` | it reads `row.`, `ancestor.` or `host.`, which read nothing here |
| `pdf-layout.condition.unknown-field` | it reads a path no component owns |
| `pdf-layout.condition.entry-field` | it reads a field of each entry of a repeating section, or the section itself (`len(applicants)`): entries travel as instance keys, so the section has none and `len()` of it is 0 here |
| `pdf-layout.condition.shadowed` | an earlier layout's condition is literally true, or the same JSON (after a Duplicate), so this one never prints by its condition |
| `pdf-layout.condition.template-source` | a conditional or fallback template layout whose storage is not inline |
| `pdf-layout.default-conditional` | the declared default has a condition |
| `pdf-layout.no-default` | a definition with conditions and no declared default |

The findings reach the layout root as the controller's `notes` hook (target `rules:when`), with
the draft laid over the catalog; `.shadowed` and `.no-default` are also said in the Form panel's
words.

**Order, badge and the Form panel.** Moving a layout up or down is the builder's way to set
priority. The documents menu offers *Move up* and *Move down* after Duplicate, off at the ends
of the list, and comes back open on the same item so a layout can go several places in a row;
both are described by a note of the layout's place ("Letter is layout 3 of 3"). The mode's
`moveLayout(id, toIndex)` goes through `movePdfLayout`, which writes an undeclared default down
first and keeps the same layout on the page, so nothing is rebuilt and its undo history,
drafts and selection stay; a move to the place the layout already has writes nothing. A layout
with a `when` (a malformed one included) carries a **Conditional** badge beside the Default
pill. With two layouts or more, the Form panel's PDF group shows one read-only row, *Which
layout prints* (`BuilderFormSettings.readOnlyRows()`), worded from the order ("Chosen by the
answers: 1. Quebec copy, when Province equals “QC”. 2. Large print, a custom condition.
Otherwise: Standard.") with an *Open the PDF layouts* button. Setting the default stays in the
documents menu, so a pending Form-panel draft cannot silently override it.

**Renames.** A form rename rewrites every layout's `when` (`renamePdfLayoutConditions`), a
pending Rules-tab draft's too rather than overwriting it, and the layouts' own bindings
(`pdf-field.componentId`, collection paths, template component bindings). The mode learns of it
through `BuilderMode.formRenamed({ from, to })`, which the shell calls for every mode right
after the form's change that carries `renamed`, with no host wiring. Catalog layouts are
rewritten, and each built designer is rewritten in place (`followRenameInLayoutTree`: the root's
committed `when` through `setProperty`, then the Rules tab's unsaved condition renamed rather
than overwritten); each layout rewritten is reported as a `"layouts"` change. A designer still
being built when the rename lands is built from the catalog as it stands once its reads are
over, so it does not put the old id back. The inspector forgets a rule's working copy once the
draft stops holding what it wrote, so the Build rows and a parsed JSON box show the new id and
the next edit keeps it. The rewrite is one step of the form's history (ADR 0180 decision 4),
so one Undo points every condition and binding at the old id again. A rename that arrives while
the Rules tab's JSON box holds text that does not parse yet leaves that text as typed.

**What a mode offers the shell.** The seams the PDF mode uses are the Journeys mode's too, and
nothing in the shell is PDF-specific.

- `BuilderDocuments.move?(id, -1 | 1)` is the order verb. At an end of the list focus takes the
  other move item rather than *Rename…*.
- `BuilderDocument.badge?: string` is a word the document label and the menu draw beside the
  name, as their own element, so the document's text stays its name alone; the badge is part of
  the label's repaint signature. The PDF mode sets "Conditional".
- The Rules tab's `note` is `string | ((nodeId) => string | undefined)`, asked on every paint,
  so the opening line follows the order and the typing. Re-assigning the mode's rule source
  instead would throw the panel's rule edits in progress away, which is why a catalog action
  that moved a condition, the order, a name or the default repaints the layout on the page
  (`repaintPreview`).
- `BuilderFormSettings.readOnlyRows()` returns `{ id, label, note, open }` rows with no `get` or
  `set`, so Save, Cancel and *Unsaved* never count them; `note` is read on every paint (the
  layout order's words come from `pdfLayoutOrderInWords`), and the mode tells the shell through
  `subscribe` when the conditions, the order, the names or the default move.

### Generated layouts

A layout tree of PDF-only components, edited in the designer:

| Type | Slots | Role |
|---|---|---|
| `pdf-document` | `body`, `header`, `footer` | the root: page size, orientation, margins, header and footer band heights, accessibility, conformance, attachments, the signature settings |
| `pdf-section` | `content` | a heading and a group; `keepTogether` moves it whole to the next page; `skipWhenEmpty` leaves it out, heading included, when nothing in it prints |
| `pdf-field` | — | binds a form component by id, with an optional rendition, label override, PDF field name (the AcroForm name the `field` rendition writes; empty uses the component's value path — its data key (else its id, ADR 0109), container-prefixed, and inside a repeat the entry's path and the field's key within the entry, e.g. `items[0].email`; a checkboxes component names one field per option, `<path>.<option>`, the option's value written with `.` as `%2E` and `%` as `%25` so it stays one part of the name (`pets.U%2ES%2E`), its checked state exported as the option's value, and no option's box marked required (the component's required means one ticked); names must be unique per layout, and a name set here gets no row prefix) |
| `pdf-text` | — | static text with `{{path}}` (a field's value path), `{{row.key}}` inside a repeat (the field's key within the entry: its data key, else its id), `{{page}}` / `{{pages}}`, `{{host.key}}`; or an expression |
| `pdf-table` | `r{i}c{j}` | rows × columns of cells; `collectionPath` repeats the first non-header row per entry; `skipWhenEmpty` leaves it out when no body cell prints |
| `pdf-repeat` | `row` | draws its row once per entry of a collection (a repeating section's or a data grid's collection path alike) |
| `pdf-box` | `content` | a bordered / filled box; with `anchor` it is pinned to a page position instead of flowing; `skipWhenEmpty` leaves it out when nothing in it prints |
| `pdf-rule`, `pdf-spacer`, `pdf-image`, `pdf-page-break` | — | a line, vertical space, a PNG/JPEG by URL or data URI, a break (optionally changing the page setup after it: what the break's `page` sets, field by field and margin by margin, over the document's page, so its margins and header and footer bands carry on) |
| `pdf-signature` | — | a signature block the layout places on its own (ADR 0061): a named signature field (`fieldName`) with a caption that takes `{{path}}` templates, a `width` (the column's when empty) and `height` (40 pt) — what the server signs into when the layout's signature settings name it, or what a person signs in a viewer; or, as `mode: "line"`, a ruled line for a pen |

The document's page is the layout's `page` over the PDF theme's over the defaults, field by field
(the margins side by side): a layout that sets only a footer band, as the derived one does, keeps
the theme's paper size, orientation and margins.

Content flows through `body`; explicit breaks and keep-together control pagination; the header
and footer bands repeat on every page; anchored boxes are drawn last on the page they name.
Pages are an output of measurement, not an input: there are no page slots, and the designer's
page edges come from the kernel's `layout` operation (a page report, no bytes).

**Skip when empty.** `pdf-section`, `pdf-box` and `pdf-table` take `skipWhenEmpty`, so a container
can follow its fields. A node is empty when its rendered content has no blocks, or only artifacts
(a rule, a spacer); containers are looked through, so a grid's artifact table with fields in its
cells counts as content, and a page break alone counts for nothing. An empty section prints
neither heading nor group; an empty box neither border nor fill, and an anchored one is not
pinned (an anchored box inside a section is pinned on its own, so it takes its own flag); a table
prints nothing when no body cell prints — a collection with no rows, or a fixed grid whose fields
are all hidden — header captions notwithstanding. The derived layout sets the flag on every
section and grid table it makes, so a container a rule hides leaves no orphan heading. Layout
nodes carry no rules of their own: what prints follows the bound components' effective state.

### Template layouts

An existing AcroForm PDF plus a mapping per field:

```json
{ "pdfField": "topmostSubform[0].Page1[0].Name[0]", "source": { "kind": "component", "componentId": "fullName" } }
{ "pdfField": "Agree", "source": { "kind": "component", "componentId": "subscribe" }, "checkedValue": "Yes" }
{ "pdfField": "Summary", "source": { "kind": "template", "text": "{{firstName}} {{lastName}}" } }
```

Sources: a component, a value path, template text, an expression, or a literal. The designer's
inspector authors every kind. *Value path* is a saved path typed freely, with the paths the Data
workspace lists offered as suggestions and a note under the box for one the form saves nothing at
(the note never holds Save back). *Formula* is the Rules tab's formula editor in the Field tab
(its text box without the editor until the chunk lands): a keystroke reaches the draft without
repainting the panel, "Reads as" and the lint follow, a formula that does not read holds Save back,
and the stored `expression` is the formula string (or the `{ formula, run }` or tree shape a
definition already holds). Choosing a kind never clears the others' fields. `checkedValue`
names the answer that means *on*: the field then takes that value — a checkbox is ticked by
it, a radio group selects the option of that name — and is off (unticked, cleared) otherwise.
A radio group filled from a radio answer needs none: the answer is the option — when the
PDF's option is named like the answer; otherwise see *value maps* below. `options`
choose `flatten`, `readOnly`, and whether appearances are regenerated by the kernel (the default,
so every viewer shows the same thing) or left to the viewer. The kernel's `inspect` op lists a
template's fields (name, kind, page, rectangle, options, export values and the
tooltip a reader announces) — that is what the
designer's template mode builds its widgets from, and its page viewer draws a box per
field from the page and rectangle. With `attachments: "digest"` or `"data"` on the request it also lists the PDF's embedded files — name, digest, type, description and, for `data`,
the bytes — which is how a submissions server takes the record back out of a PDF it rendered
(ADR 0064, `record.json`). A field's page is the one whose `/Annots` lists its widget,
or the one its `/P` names; failing both, a page widget with the same rectangle that names the
same field (its `/T`, or `/Parent` for a kid) counts as that widget's copy — macOS Preview
re-saves a form with two copies of every widget, the page listing one and the field keeping
the other — and a one-page document places every widget. On fill such a detached widget takes
its copy's place on the page (the copy goes), or joins the page it names, so the answers show
where a viewer looks; `template.widgets_relinked` says so, and counts any that could not be
placed. A template with XFA has the XFA removed and says so in the warnings.

`fill` reports each mapped field in the `fields` report as `filled`, `cleared` (an empty answer, or
a value that unticks), `missing` (the PDF has no such field) or `unsupported` (with a message,
for example a choice the field does not list, or a field kind that cannot be filled).

A **value map** (`values`, ADR 0057) on a mapping or an area translates the answer to
the value the PDF holds for it. Government forms built in Adobe Designer name a radio group's
options by bare export values — `1`, `2`, `3` — while the words beside them are page text, so an
answer `improved` selects nothing. The map is keyed by the answer as a string and holds the
value written to the PDF: the export value of a radio, dropdown or list option, or any text.

```json
{ "pdfField": "…rb_List1[0]", "source": { "kind": "component", "componentId": "change" },
  "values": { "improved": "1", "unchanged": "2", "worsened": "3" } }
{ "pdfField": "…rb_List1[1]", "source": { "kind": "component", "componentId": "timeLost" },
  "values": { "true": "1", "false": "2" } }
```

A boolean answer is keyed `"true"` / `"false"` — that is how a checkbox component feeds a Yes/No
radio group — and with neither key it is left as it is. The map applies to a component source's
raw answer before anything else: a *multi-select* or *checkboxes* answer is translated element by
element (only the picked keys are carried, so an unpicked key renamed onto a picked one cannot
clear it), `checkedValue` then compares the **translated** answer (so with `values` the checked
value is the PDF's word, `"1"`, not `"improved"`), and `format` shapes the result. Any other source
(path, template text, expression, literal) is translated on its resolved value, before `format`.
Keys match the answer exactly, with no case folding, and there is no catch-all entry for an answer
the map does not name. An answer with no key passes through unchanged and the fill says so once per mapping with the
`mapping.unmappedValue` warning, naming the subject and the values; an empty answer says nothing,
booleans never warn (a map with only a `"true"` key is a complete statement for a tick), and
neither does a map on a field the form hides. A map with no usable entry (`values` that is not an object of
strings, or an entry that is not a string) reads as none (`readPdfValueMap` is the one reader; the
layout validator does not reject a layout for a bad `values`, as it does not for a bad `format`),
and a layout without `values` writes each answer as it is.

In the designer, a widget for a radio group, dropdown or list that is filled from a component with
answers to list — a checkbox (Yes / No) or one with inline options — gets a **Values** section
after Mapping: a row per answer with a select of "Same value" (no entry) and the PDF field's
export options, written to `values` with the widget's other properties (one Save, one undo step;
the key goes when the map empties). **Match by order** pairs the first answer with the field's
first option, the second with the second, and so on, in one edit. A note under the section names
the answers that match no option and have no value yet (advisory: Save is never held back). A
component whose options come from a data source has no answers to list at design time, and areas
have no Values section; both carry a hand-written `values` through. The field is contributed
per widget by a capability of the widget definition, because the rows depend on the node, and
the Values section is declared with `PropertyEditorSection.hideWhenEmpty`, so it is not drawn
as an empty heading when nothing applies and the panel repaints when the source component
changes. A component whose options were all removed is still a list, so the section is drawn
with no rows and no Match by order while entries are left over: they must stay visible, and
**Remove stale entries** takes them out. A widget that is no longer
filled from a component, or whose PDF field is not a radio group, dropdown or list, drops its
`values` when the layout is saved, so the layout never carries a map the inspector cannot show.

**Stale entries.** An entry goes stale when the form or the PDF moves on: its *key* is an answer the
source component no longer offers (an option renamed or removed; known for inline options and a
checkbox, never for a data-source component), or its *target* is not an export value of the PDF field
(a different PDF swapped in). The Values section says so under its table (`Entries for options this
form no longer has: ...`, `... is not an export value of this PDF field`), shows **Remove stale
entries** beside Match by order while there are any (one edit, one undo step; `values` goes when it
empties; once pressed the button is gone, and focus moves to the section's next control, Match by
order where it is drawn), and a line under the layout's status names the widgets with stale entries, so they are
found without opening each one (the line follows the tree with drafts laid over, on every edit, selection, form refresh and template rebuild, and counts only widgets whose Values section is drawn: a component with a data source has neither the note nor the button, so its hand-written map is not called stale). Nothing is removed unasked: a rename looks like a removal and an
addition, and a swapped template may be temporary. The designer re-reads the form when the PDF
workspace is entered, when a layout is selected, on `reseed`, on Back to editing from Try it and when the
executor arrives (it compares the form's JSON and, when it moved, swaps the component definitions
under the tree and redraws the stale line); it does not run on form edits, because the form's
components cannot be edited while the PDF designer is on the page (the form is edited in the Form
workspace, and *Create form fields*, the one PDF-side edit of the form, refreshes the designer
itself). A target counts as stale only once the PDF field's inspection is known.

Reading a filled PDF back (`@argusvane/datum-submissions`, ADR 0064) reverses the map: the field's value is
looked up in the inverted map (PDF value to answer), for a string and for each element of a list,
so a radio group's `1` comes back as `improved`; for a checkbox component the `"true"` / `"false"`
keys come back as booleans, before `format` is applied. A map in which two answers share a PDF
value cannot be inverted: the value is kept as the PDF holds it and the extraction notes that the
field's map is ambiguous.

An **encrypted template** is read decrypted when it is encrypted with the standard security
handler and an empty user password (ADR 0057): the "owner permissions only" form most
published government forms use. A template that needs a real password, or another security
handler, is refused with the `template` error, which says it is encrypted with a password and to
supply an unencrypted copy; the kernel never takes or asks for a password. Any other failure to
read it decrypted (a missing `/ID`, a truncated file) is the `template` error "The template is
encrypted and could not be read" with the cause. The owner's
permissions (`/P`, ISO 32000-1 Table 22, bits numbered from 1: print 3, modify 4, copy 5,
annotate 6, fill forms 9, assemble 11 and print at high quality 12, the last three from revision 3;
below that one print bit) rule the fill: a template that does not allow filling (bit 6, or from
revision 3 bit 9) is refused with the `template` error ("the owner's permissions do not allow
filling its form fields"); one that allows filling but not
modifying (bit 4) is filled, and a fill that flattens or draws areas, which change page content,
warns `template.permissions` that the output goes beyond them (a refusal would fail the common
request, flattening a government form for the record, for a restriction almost no reader
enforces). Every fill of an encrypted template warns `template.decrypted`: **the filled document
is written unencrypted**, the original's restrictions are not carried over; the output is not
re-encrypted. PDF/A still refuses an encrypted template (`conformance`, keyed on the recorded
flag, since the decrypted document does not report it), and so does the signing code (a
signature covers bytes, and these are not the bytes the signer saw). `inspect` reports
`encrypted: true` for the original, as supplied, and adds `permissions` (`print`,
`printHighQuality`, `modify`, `copy`, `annotate`, `fillForms`, `assemble`), only then; it does not
refuse a template that forbids filling, so the designer can tell the author. Decrypting leaves
streams stored in the clear alone (a stream whose filters name `/Crypt` with the Identity
filter, and every `/Type /Metadata` stream of a file with `/EncryptMetadata false` unless it
names a real crypt filter); the
cross-reference streams and the `/Encrypt` dictionary are dropped, so the output does not read as
encrypted.

A template is refused with the `template` error when it is larger than 25 MiB
(`MAX_PDF_TEMPLATE_BYTES`, the same cap "Load a PDF" holds; the message names the size and the
cap) or when its bytes are not a readable PDF. `renderFormPdf` checks the size after the
resolver returns the bytes, and the kernel checks it again on `fill` and `inspect`.

A text field whose single-line text is wider than its widget at the size the appearance chose
is clipped at the widget; the fill says so with a `field.overflow` warning naming the field
(areas report `area.overflow` the same way). A multiline field wraps and is not measured, and
`appearances: "viewer"` leaves the size to the viewer, so nothing is measured there.

A mapping source of `component` names one component's value. A repeating section or a data grid,
or a component inside one, has no single value: it prints blank and warns `mapping.collection`, naming the
field and the component. Rows map one `path` source per cell (`items[0].sku`,
`items[1].sku`, ...), one field for each cell the paper form has. A `path` source that names a
file field (`applicant.doc`, `items[0].receipt`) writes the files' names and sizes, never the
upload's envelope; a placeholder in a `template` source, as in a `pdf-text` block, reads a path
through the component it names — by id, by value path, or as an entry's field at its indexed path
(`{{items[0].pick}}`) — so it prints an option's label and a file's name, a `password`'s answer as
the same `••••••••` mask its rendition prints, and a generated document cuts it to
`limits.answerChars` as it cuts that field's answer.

A template that carries JavaScript keeps it: a document `/OpenAction`, `/AA` additional actions
on the document, its pages or its fields, and the `/Names` JavaScript tree pass through a fill
unchanged, so the output bytes are the template's own on that point. The kernel says so once per
kind, with a count, on inspect and on fill (`template.javascript_open_action`,
`template.javascript_additional_actions`, `template.javascript_names`), and the PDF designer
shows "This PDF carries scripts; they are kept and run only in the viewer" under the loaded
file. The scripts run only in a viewer that runs them; the kernel never does.

The PDF itself is either uploaded by the author — inline `base64`, travelling with the
definition — or provided by the host: a `PdfTemplateResolver` resolves any other `storage`
kind (`url`, an asset id) to bytes at render time, and may `list()` the PDFs it offers
(`PdfTemplateOption`: `{ id, label, source }`, set through
`createPdfTemplateResolver(byStorage, { templates })`) so the designer lets the author pick
one instead of uploading. A layout that picks one carries the reference, never the bytes, and
the bytes are never asked about. An uploaded file stays inline `base64`, so it counts against the
definition's load limit (`max-definition-bytes` on `<datum-form-builder>`, 2 MiB unless a host
raises it): the mode is given `definitionBytes(pdf)`, what the whole definition would weigh with
that block and the limit in force, and refuses an upload, a copy of an uploaded template or a
replacement template that would push the form past it — a form that saved but could never be
opened again would be worse. The refusal names the file's size, the form's weight with it and
the limit, and changes nothing; a file picked into the inspector's file controls (an ICC profile)
is weighed the same way.

#### Areas: a PDF with no fields

A PDF that *looks* like a form — scanned, or laid out by hand — has no AcroForm to fill. A
template layout populates one through `areas` (ADR 0057): rectangles on its pages, in points
from the page's top-left, each bound the way a field mapping is, with the answer drawn into
the rectangle. `fields` may be empty, or the two may mix on a PDF that has some fields:

```json
{
  "id": "paper", "kind": "template",
  "template": { "storage": "url", "name": "intake.pdf", "type": "application/pdf", "size": 2299, "ref": "/templates/intake.pdf" },
  "fields": [],
  "areas": [
    { "id": "name", "label": "Full name", "page": 1, "rect": { "x": 252, "y": 114, "width": 296, "height": 22 },
      "source": { "kind": "component", "componentId": "fullName" }, "draw": { "valign": "bottom" } },
    { "id": "email", "page": 1, "rect": { "x": 250, "y": 202, "width": 14, "height": 14 },
      "source": { "kind": "component", "componentId": "contactMethod" }, "checkedValue": "email", "draw": { "kind": "check" } },
    { "id": "stamp", "page": 1, "rect": { "x": 180, "y": 726, "width": 120, "height": 18 },
      "source": { "kind": "literal", "value": "RECEIVED" }, "draw": { "align": "center", "valign": "middle", "bold": true } }
  ]
}
```

`draw` says how the value lands, every key optional: `kind` — `text` (the default) or
`check`, a tick drawn centred in the rectangle when the value means *on* (`checkedValue` as
for a field; a box the paper already prints gets no border); `fontSize` (10), `align`
(`start` | `center` | `end`), `valign` (`top` | `middle` | `bottom`), `padding` (2), `wrap`
(on: long text runs onto further lines; off: one line), `bold`, `color` (`#rrggbb`). An area draws text or a tick only: no image, no line height of its
own (wrapped lines take the plan's body line height, below) and no comb or character-cell spacing.
Text is
laid out by the same measurer and drawn by the same writer as a generated document, with the
first font resource the host supplied (Helvetica when there is none), and is *clipped* to the
rectangle: a value longer than its box stops at the edge rather than running over what the
page prints. What must fit is the glyphs, from the first line's top to the last line's bottom:
the leading outside them is set aside for the fit and the placement both, and wrapped lines are
spaced at the body line height of the plan's typography (1.35 times the font size when it
carries none). The font need of a fill is computed from the values, so an Arabic or CJK answer
asks the font provider for a face that has it, and names the families of the theme's typography
the plan carries, so a theme's own faces load for the areas as they do for a generated document. The fill reports one entry per area — `filled`, `empty` (nothing to draw),
`overflow` (drawn, but clipped; also a warning), `missing` (a page the PDF does not have) — as
`areas` beside the `fields` report. Areas are page content, drawn after the fields are filled
and flattened; a PDF with neither fields nor values gains no AcroForm.

**Page space.** Coordinates are in the page as a reader sees it: the crop box turned by `/Rotate`,
as pdf.js lays it out. The page sizes and field boxes `inspect` reports and the areas the kernel
draws all use that space, and the kernel turns them into the page's own coordinates where it
writes. The designer keeps an area's rectangle on its page: it is clamped to the page when applied,
in the same undo entry, and when the layout is opened. A page the PDF lacks is a problem while the
area is being edited and a note once it is stored (the fill reports it `missing`).

**Fillable areas.** An area with a `field` block is an AcroForm widget instead of drawn
content: a text field for `draw.kind` `text` (multiline when `wrap` is on), a check box for
`check` — created at the rectangle with **no border and no background**, so nothing but its
text shows over the page and the PDF becomes fillable where the paper had a blank. The value,
if any, fills the field; an empty one stays blank for the reader to fill. `field.name` is
the AcroForm name (absent: the area's label with each run of periods turned into a space, since
a period separates the parts of a field's path, else its id); a name taken from a label or an id
is made unique across the layout (`Date`, `Date_2`), so labels alone never merge two fields, a
typed name is kept as written, and a typed name with an empty part of its path (`Policy No.`) is a
problem in the designer; `required`, `readOnly` and
`tooltip` (absent: the label) are the field's own. Two areas typing one name share it — the
second gets another widget showing the same value; a name the *template* already has is
refused for that area (`unsupported`, warning `area.field`) rather than taken over. A fieldless
PDF with a fillable area gains an AcroForm (that is the point); one with only content areas
still does not.

```json
{ "id": "name", "label": "Full name", "page": 1, "rect": { "x": 252, "y": 114, "width": 296, "height": 22 },
  "source": { "kind": "component", "componentId": "fullName" },
  "draw": { "fontSize": 11, "align": "start" },
  "field": { "name": "applicant_name", "required": true } }
```

What carries over from `draw`: `fontSize`, `align`, `bold` and `color` (the appearance is
regenerated by the kernel at that size and face), `wrap` as multiline; the widget is
transparent by construction — no `/MK` background or border colour, border width 0 — so its
appearance paints nothing but the text and the widget looks like part of the PDF's own style
(`field` is orthogonal to `draw.kind`); what does not carry over:
`valign` and `padding` — a viewer places a field's text itself (a single line centred, a
multiline field from the top). The fill options apply to these fields as to the template's
own: `readOnly` locks the filled ones and leaves empty ones fillable, `flatten` burns them all
in, `appearances: "viewer"` leaves their look to the viewer (and `bold` with it). The report
for a fillable area names the field (`field`) beside its status.

In the designer, template mode shows the pages themselves — through pdf.js when the host
provides the page imagery module (below), blank sheets of the right size otherwise — and the
areas over them: drag on empty paper to draw one, drag it to move it, its handles to resize
it, the arrow keys to nudge it (Shift for 10 pt), Delete to remove it. Each area is a node of the
layout's tree (see *Designing a layout*): the inspector holds its page, rectangle, source and
drawing choices — *Drawn as* picks text, a check mark, a fillable text field or a fillable check
box, the last two with the field's name, required flag and tooltip — and a click on a field box
selects its widget. A choice back at its default is dropped from the layout. Each edit lands with
the inspector's Apply and is one undo step.

## Accessibility

`accessibility.tagged` (layout, then theme, default `true`) writes a tagged PDF: a structure tree
(`Document`, `Sect`, `H1`…`H6`, `P`, `Table`/`TR`/`TH`/`TD`, `Figure`, `Form`), marked content
around every block, running regions and rules as artifacts, widgets as `Form` elements with
`StructParent`, `/MarkInfo`, `/Tabs /S`. `lang` comes from the render locale, the title from the
layout or the form, `displayDocTitle` from the layout. Untagged output still carries `/Lang`,
the title and the viewer preference. How the structure tree is built, block by block, what a
reader does with it and what is not claimed (no PDF/UA) is in
[`pdf-tagging.md`](pdf-tagging.md). PDF/A is the next section.

## Conformance (PDF/A)

A layout declares an archival level with `conformance.pdfa` ([ADR 0059](adr/0059-pdf-a-conformance.md)),
and the kernel produces — or, for a template, keeps — a file that veraPDF accepts at that level.
The block sits beside `accessibility` on a generated or template layout (own key, or the
`pdf-document` root's configuration where the designer writes it):

```jsonc
"conformance": {
  "pdfa": "2b",                        // 2b | 2u | 2a | 3b | 3u | 3a; absent: an ordinary PDF
  "outputIntent": {                    // absent: sRGB IEC61966-2.1, pdf-lib's bundled profile
    "profile": { "storage": "builtin", "ref": "cmyk" },   // one the kernel carries: srgb | gray | cmyk …
    // … or an ICC file of your own, inline or host-stored:
    // "profile": { "storage": "base64", "name": "org.icc", "type": "application/vnd.iccprofile", "size": 3144, "data": "…" },
    "identifier": "Org RGB",           // /OutputConditionIdentifier; absent: the built-in's, else the profile's file name
    "info": "The organisation's press", // /Info; absent: the built-in's, else the identifier
    "registry": "http://www.color.org" // /RegistryName; absent: the built-in's, else none written
  },
  "attachData": true,                  // part 3 only: the answers as an associated file
  "attachment": { "name": "answers.json", "description": "Answers" }
}
```

| Level | Where | Meaning |
|---|---|---|
| layout | `conformance.pdfa` / `.outputIntent` — `core/schema/pdf-layout.ts` (`PdfConformanceConfiguration`, `resolvePdfConformance`) | the author's choice for this layout |
| theme | `pdfa` and `outputIntent` on a PDF theme — `render/pdf/pdf-theme-defaults.ts` (`PdfThemeSettings`) | the default for every layout under that theme, each tier on its own: a layout may set the level and inherit the theme's profile |
| render call | `options.pdfa` in `PdfRenderOptions` — a level, or `false` | a host overrides the layout per render; a fill honours it the same way |

What the kernel does under a claim (`packages/pdf-kernel/src/kernel/pdfa.ts`, run after the last
drawing and appearance operation and before `save`, which is when fonts are frozen): declares the
output intent (the configured profile, its colour components read from the ICC header, else
sRGB; under a Gray or CMYK intent every page and appearance gets a `DefaultRGB` colour space,
since the kernel draws in RGB); associates the files; embeds the fonts and completes each with
`CIDSet` (and `Length1` for a TrueType program; a CFF/OpenType face travels as `FontFile3` /
`CIDFontType0C` and is completed with a `CIDSet` from the CFF's `CharStrings` count, or from `maxp`
for an OpenType-wrapped program, and no `Length1`; the `CIDToGIDMap` pdf-lib writes beside it is
deleted, because the subset is a bare CFF whose CIDs are its glyph ids and the map means nothing there); leaves every widget an appearance with `/N`
alone (pdf-lib's *down* appearance for check boxes loses its `/D` and `/R`; a widget with none,
the signature widget, gets an empty one) and nothing to the viewer (`NeedAppearances` goes);
writes the XMP packet — an unfiltered `/Metadata` stream mirroring the Info dictionary key for
key, dates converted from the `D:` strings, keywords the single-space join `setKeywords` uses,
foreign `rdf:Description` blocks a template carried kept as they were — with `pdfaid:part` and
`pdfaid:conformance`. `@cantoo/pdf-lib` ships a `convertToPDFA()`, but its metadata sync runs on
every save through `new Date()`, which the sandbox forbids, so the pass is the kernel's own and
is strings and bytes from `env`. Fonts are strict: a family with no resource is a `font`
error rather than Helvetica, and a character no supplied font covers becomes `?`
(`font.unencodable`) rather than a `.notdef` glyph, a glyph with no Unicode mapping, which the
"u" levels forbid. The fill path's appearance fonts follow the same rule: always the resource,
never Helvetica, a missing bold face falling back to the regular one with `pdfa.boldFallback`,
and `flatten` runs without regenerating field appearances so pdf-lib does not bring Helvetica
back. Where a fallen-back text segment is mixed, the runs are split by coverage — what the main
font has stays with it — since letters have no script range and one unlisted character would
otherwise send the whole line to the fallback face. A CMYK JPEG is left out under an RGB intent
(`pdfa.image`). The reply echoes the level as `pdfa`.

**Level "a"** (`2a`, `3a`) is "u" plus the promise that the document is tagged. A generated
document is tagged whatever the layout's `accessibility.tagged` says (`pdfa.tagged` when that
overrode an explicit off), Private Use Area characters become `?` too (`font.privateUse`: a PUA
code point carries no text a reader can use), and the catalog's `/Lang` must be empty or a language tag as veraPDF tests it
(`^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$`).
Where the kernel cannot keep the promise it declares the "u" level instead — which the file
then is by construction — and `pdfa.level` says why: a language that is no tag; a fill that
flattens (the field appearances become page content no structure element owns); a template
whose structure tree this kernel cannot extend (none, or a parent tree with `Kids`). Otherwise a
fill under "a" tags what it adds into the template's own tree (`ExistingTagging` in
`kernel/tagging.ts`, which takes the root's first kid as the document element, making one when the
root has none): each drawn area is a `P` element with its marked content (`BDC /P <</MCID n>>`,
enclosing the clip's `q…Q`) at the next MCID of the page's parent-tree entry (found through the
page's `StructParents`, or allocated under a new key), each fillable area's widget a `Form` element reached through an
`OBJR` under a fresh `StructParent` key, all under the document element (the root's first kid),
with `ParentTreeNextKey` rewritten and `MarkInfo` confirmed. A fill that adds nothing untagged
keeps the template's level rather than being demoted, and asking "a" of a "b" or "u" template
warns `pdfa.level`. Nothing here claims PDF/UA: the tree is the kernel's best structure, and veraPDF checks what
ISO 19005 asks of it.

A **template** keeps its own claim: `fill` reads the level in the template's XMP, raises part 2
to 3 when the layout asks for 3 (attachments; a part-1 template stays part 1), keeps the
template's level letter (asking "u" or "a" of a "b" template warns `pdfa.level`: "u" is a
promise about text the template already has) and its output intent (a configured one is
reported with `pdfa.outputIntent`, not applied), regenerates appearances whatever the layout
says (`pdfa.appearances`), and refuses an encrypted template, or one whose appearances it
cannot regenerate, with the `conformance` error, since either would break the claim. A template
that declares nothing is filled as any PDF with `pdfa.template`: the kernel cannot vouch for
what it did not draw, and everything a template already contained is trusted as the template
declares it. `inspect` reports the template's level, which the
designer's template panel shows beside the field count.

The **output intent's profile** travels as the attachment envelope a template does
(`PdfAssetSource`). Three kinds:

| `storage` | Who has the bytes | When |
|---|---|---|
| `builtin` (`ref`: `srgb`, `gray`, `cmyk`) | the kernel — the same bytes on every host, nothing fetched (`PDF_BUILTIN_PROFILES` in `core/schema/pdf-layout.ts`, `kernel/profiles.ts`) | the usual choice: sRGB IEC61966-2.1 (the default anyway), a gamma-2.2 grey the kernel builds for monochrome archives, or a compact SWOP-compatible CMYK (CGATS TR 001; pdf.js's CC0 profile, 8 KB) |
| `base64` | the definition, inline | an organisation's own profile, uploaded in the designer |
| anything else (`asset`, `url`, …) with a `ref` | the host — `PdfServiceDependencies.templates` resolves it before the request (`resolvePdfOutputIntent` in `pdf-service.ts`); the resolver's `listProfiles()` is what the designer lists under "From the host" (`createPdfTemplateResolver(byStorage, { profiles })`) | press-grade profiles (ECI / FOGRA, 1–2 MB) an organisation keeps in an asset store |

A built-in profile brings its identifier, description and registry with it unless the layout
names the condition itself. Inside the program only inline and built-in profiles resolve;
anything unresolved or not an ICC profile falls back to sRGB with `pdfa.outputIntent` — a
conformant file under a different condition, never a false claim. The designer offers all
three kinds on the `pdf-document` root's properties ("Output intent profile (ICC)": a select
of the built-ins and the host's list, its last entry an upload; a picked `.icc` / `.icm` is
read into the inline envelope and refused, in place, when its bytes are not an ICC profile —
`readIccColorSpace`, the same reader the layout check and the kernel use; the field is the
property editor's `file` type, `PropertyEditorFieldType` with `accept` on the field and
`InspectorControl` `"file"`, a row that says what is set with Remove beside it, and Choose…
in place of the select when the host offers no profiles; a pick is checked by `accept`, then
by the bytes, and a refused one leaves the draft alone), with the
identifier, description and registry as text beside it; the template panel has no control,
since a template keeps its own intent. A theme's profile still applies when the layout sets none.

The **submission attachment** (`attachData` under `3b` / `3u`) is `{ form, layout, locale,
values }` as stable-key JSON, `application/json`, `/AFRelationship /Data`, under the configured
name and localized description (defaults `submission.json`, "Submission data"). Under part 2
nothing is attached and `pdfa.attachments` says so. Uploaded files are attached the same way,
in any PDF — see [Attachments](#attachments-uploaded-files).

Validation: `packages/pdf-kernel/tests/verapdf.test.ts` runs veraPDF on every fixture — every
level including `2a` / `3a`, fills under "a" with areas and fillable areas, a CFF face (Noto Sans
Canadian Aboriginal, OFL, under `tests/fixtures/`) beside the TrueType pack — when it is installed
(`VERAPDF=/path/to/verapdf`, the PATH, or `~/verapdf` — the installer at verapdf.org puts it
there) and is skipped otherwise. The parity suite holds a PDF/A render and fill byte-identical in
QuickJS, and the bundle test makes one where `Date` throws. Part 1 is only ever kept from a
template, never produced.

## Attachments (uploaded files)

A `file` component's uploads can travel inside the PDF as embedded files (ADR 0060) — what a
reader lists in its attachment pane, and what an archive keeps beside the pages. The switch is
the component's **Attach uploaded files to the PDF** (`configuration.pdf.attach`, the PDF
inspector section, offered to the file component alone) or a generated layout's `pdf-field`
binding (**Attach uploaded files**, `attach`; a boolean either way once set, the instance's
choice when left alone). A template layout has no bindings, so the instance switch decides
there. The switch is offered by a capability of its own (`pdfAttachmentsCapability`, id
`pdf-attach`, opted into with `standardFieldCapabilities({ attachFiles: true })`), because only a
file component holds files. The rendition is a separate choice: a file drawn as `image` and attached is both a
picture on the page and a file in the pane.

The render model gathers the files (`render/pdf/pdf-attachments.ts`) after the exclusion and
visibility checks, from the row value inside a repeat, once per distinct file (the same name,
size and whole content: every inline byte, or the same storage reference) however many
bindings draw it. Executable, script and HTML content is never embedded (`attachment.refusedType`,
`refusedAttachmentType`, checked by the collector and again by the kernel): by the claimed type,
by the file name's extension (`.exe`, `.msi`, `.bat`, `.cmd`, `.com`, `.scr`, `.ps1`, `.vbs`, `.js`,
`.wsf`, `.hta`, `.jar`, `.sh`, `.html`, `.htm`, `.xhtml`, `.svgz` and their kin; an `.svg` is judged
by its content) and by the bytes: an executable header, a shebang, a document opening with an HTML
element, markup in the XHTML namespace under any prefix or root, XML whose internal DTD subset
declares entities, an SVG carrying script — prose that merely mentions tags is kept; a collection drawn as a table formats its rows without rendering the fields in
them, so a collection's descendants are walked when the collection itself is rendered, and the
template path walks the form tree the same way. Each file becomes an `EmbeddedFile` stream with
its MIME type, lower-cased, as `/Subtype` (`application/octet-stream` when the browser gave none
or something that is not `type/subtype`, since PDF/A-3 requires a valid one), `/Params` with
`/Size` and `/ModDate`, a `Filespec` with the file name (`/F`, `/UF`: sanitised and stripped of
any path, `file` when it has none), the component's label as `/Desc` and `/AFRelationship
/Supplement` (supporting material, where the submission is `/Data`), an entry in the catalog's
`/AF` and in the flat, sorted `EmbeddedFiles` name tree; a name already taken gets `-2`, `-3`.
Small text-shaped uploads (`text/*`, JSON, XML, up to 1 MiB) are deflated; everything else — a
PDF, a picture, an archive, anything larger — is stored as it is, since deflating costs a
sandboxed program seconds per megabyte for nothing. The modification date is the host's
`env.createdAt`, so the bytes are the same on every host.

**PDF/A**: part 3 allows any embedded file, so a `3b` / `3u` / `3a` document carries the uploads
beside the submission attachment; parts 1 and 2 forbid them, so a `2b` / `2u` / `2a` document
(or a template kept at part 2) leaves them out with one `pdfa.attachments` warning naming them
(ISO 19005-2 admits only PDF/A files as embedded files, and the kernel does not inspect
uploads). A part-2 template raised to part 3 takes them. An ordinary PDF carries them, and so
does a template that declares nothing. Rendering with `render: { pdfa: false }` keeps the uploads and
drops the submission attachment, which is a conformance feature.

**Where the bytes come from**: a `base64` upload (ADR 0034) travels in the value. A file a host
storage keeps reaches the render model as its envelope and `renderFormPdf` resolves it through
`PdfServiceDependencies.templates` — the same resolver that serves templates and ICC profiles,
keyed by storage kind (`createPdfTemplateResolver({ s3: fetchIt })`) — before the request; one
the resolver cannot supply is dropped with `attachment.unresolved` (the component named). The
program cannot fetch, so an unresolved envelope reaching it through the `document` op warns the
same way.

**Budget**: each layout has one, over the sum of the envelopes' declared sizes, applied before
any bytes are copied:

```jsonc
"attachments": { "budgetMb": 4, "onExceeded": "skip" }   // on the layout, or the pdf-document root's configuration
```

Default 4 MiB (`budgetMb` counts MiB) and `skip`: a file that would take the document past the budget is left out with
`attachment.skipped` (the component named) and a smaller one after it may still fit;
`onExceeded: "fail"` refuses the document with a `PdfKernelError` whose code is
`attachment_budget`, thrown past the rendition catch the way `unknown_component` is. A host
overrides both per call, call over layout over default, each field on its own
(`resolvePdfAttachmentPolicy`) — `renderFormPdf(runtime, deps, { attachments: { budgetBytes,
onExceeded } })`, or `attachments` on the `document` / `build` inputs — and the designer offers
them on the `pdf-document` root ("Attachment budget (MB)", "Past the attachment budget"); a
template layout's budget is set in the layout JSON. The default is set by the sandbox: a QuickJS host renders four
megabytes of uploads in a few seconds of its fifteen (`quickjs-limits.test.ts` renders a full
default budget of incompressible files and disposes the runtime); an in-process host is not
held to those fifteen seconds and may raise the budget freely, and a QuickJS host that raises it
spends more of them in proportion.

The kernel echoes the names it embedded as `attachments` on the `document`, `render` and
`fill` replies, absent when nothing was asked for. The page carries no link from a printed file
name to its attachment (no `FileAttachment` annotation). A plugin rendition attaches what it draws through
`context.addAttachment(file, { description?, relationship? })`, budget and dedupe applied.

## Signatures

A record the server produced can carry the server's own signature — ISO 32000-2 §12.8, in the
PAdES baseline profile (ETSI EN 319 142-1, B-B: `ETSI.CAdES.detached`, an ESS
signing-certificate attribute, the time in the dictionary's `/M`) — which any PDF viewer's
signature panel validates ([ADR 0061](adr/0061-pdf-digital-signatures.md)). The kernel does
everything the standard asks except the one step that needs a private key: it places the
signature field (as an incremental update, so the original bytes and any earlier signature stay
as they are), writes the `/ByteRange` and `/Contents` placeholders, hashes the file, builds the
DER signed attributes and hands them back as `signing.toBeSigned`; the host signs those with
its platform crypto — a PEM key, a hardware token, a cloud KMS (`toBeSignedDigest` for one that
signs a hash) — and the kernel assembles the CMS and embeds it (`complete`). Two calls, the
shape the EU's DSS uses, so the key never enters the sandbox and never has to be exportable.

**The two calls.** `sign` (or `document` / `render` / `fill` with a `signature`) takes the
certificates and the settings, adds the field and the signature dictionary, patches the
`/ByteRange`, hashes the file and answers with the prepared bytes and a `signing` handoff: the
field, the range, the digest, `toBeSigned` (the DER `SET OF` signed attributes, RFC 5652 §5.4),
`toBeSignedDigest` (its SHA-256, for a signer that takes a hash) and the algorithm the
certificate's key dictates. The host signs `toBeSigned` — RSA PKCS#1 v1.5 or ECDSA on P-256 or
P-384, SHA-256 — in two to four lines of platform crypto with no PDF or CMS code. `complete`
takes the prepared bytes and the value, recomputes the digest and the attributes from the bytes
(a changed input or certificate is refused before anything is embedded when `complete` carries
`toBeSignedDigest`, as `renderFormPdf` sends it; without it the changed attributes sign nothing
the key saw and the signature does not verify), assembles the CMS and
writes it into the placeholder. A file with a prepared, uncompleted signature is refused until
it is completed.

**The profile.** PAdES-B-B: `/Filter /Adobe.PPKLite`, `/SubFilter /ETSI.CAdES.detached`, signed
attributes contentType, messageDigest and signing-certificate-v2 (the leaf's SHA-256 with its
issuer and serial), no signingTime attribute — the claimed time is the dictionary's `/M`, from
`env.createdAt` — and the ESIC extension declared on a 1.x file, as iText and pyHanko do.
`adbe.pkcs7.detached` adds the signingTime attribute. SHA-256 only; algorithm identifiers as RFC
5754 and RFC 5758 want them (absent parameters for SHA-2 and ECDSA, `NULL` for RSA); certificates
and attributes in DER `SET OF` order by encoding. An ECDSA value arrives as DER or as `r‖s` and is
normalised. RSASSA-PSS keys and other curves are refused with the `signature` code.

**The update and the field.** The signature is an incremental update, never a rewrite: only the
objects touched are appended with a `/Prev` trailer, so the original bytes stay byte for byte, an
earlier signature's range still hashes, and the update's cross-reference is the file's kind (a
table cannot follow an xref stream). The field is reached through the catalog's AcroForm and the
page's `/Annots` directly, never `getForm()` (it strips XFA) nor `addAnnot()` (it rewrites the
page's content streams), and `/SigFlags` is 3. `field` names an existing unsigned signature
field; absent, a field of its own is added, `Signature1`, `Signature2`, … (the first name no
field has), at the bottom of the last page. The default appearance is drawn with an embedded font
and DeviceRGB alone (under a Gray or CMYK intent with `DefaultRGB`), the way the PDF/A pass
expects one: "Digitally signed by …", the date, the reason and the certification, clipped to the
box; `appearance: false` makes an invisible signature with an empty appearance. The widget
carries `/TU` and `/Contents`, so a screen reader announces who signed and when.

**Certification.** `certify` writes the `/Reference` with `/TransformMethod /DocMDP` and `/P` 1,
2 or 3 and the catalog's `/Perms`, with no `DigestMethod`: ISO 32000-2 deprecated it and PDF/A
(19005-3 §6.1.12) forbids it under DocMDP. A certification must be the document's first
signature; a file certified with no changes allowed refuses any further one; a file under P=2 or
P=3, or with approval signatures, takes another approval signature. The server samples default to
`noChanges`, the strongest "unaltered record" claim.

**Timestamps (PAdES-B-T).** `timestamp: true` at `sign` reserves room. `timestampRequest` builds
the RFC 3161 `TimeStampReq` over a signature value (SHA-256 imprint, certificate requested, no
nonce: the sandbox has no randomness and a nonce is optional); the host posts it to its
authority (`createFetchTimestamper` is the ready-made `PdfTimestamper`), and `complete` takes the
token, or the whole response, as `signing.timestamp.token`, checks that it vouches for this very
value and embeds it as the unsigned `signatureTimeStampToken` attribute. The samples carry the
hook behind an empty `TSA_URL`.

**Hygiene and limits.** `sign` warns, and never refuses, about a certificate that is expired
(`signature.certificateExpired`), expires within thirty days (`signature.certificateExpiring`) or
is not yet valid (`signature.certificateNotYetValid`) at `env.createdAt` (dates are compared as
strings and day numbers; there is no `Date`), and about a chain that names no issuer for the leaf
(`signature.chainIncomplete`). The placeholder is at most 64 KiB (`placeholderBytes` beyond that
is refused), the DER reader refuses nesting past 32 and lengths past the buffer, and `verify`
reads at most 64 signatures.

**On the layout.** A `signature` block on a generated or template layout says how its documents
are sealed — the policy is authoring; the certificates and the key are the host's:

```json
{
  "signature": {
    "field": "server-signature",
    "certify": "noChanges",
    "reason": "Received and validated by the intake service",
    "location": "Ottawa",
    "timestamp": false,
    "required": true
  }
}
```

| Key | Meaning |
|---|---|
| `field` | the `pdf-signature` block's field name (or a template's own signature field) the signature lands in; empty: a field of its own, at the bottom of the last page |
| `certify` | `"noChanges"` (DocMDP P=1: any later change breaks it — the server's record), `"formFilling"` (P=2: fields may still be filled and further signatures added), `"annotations"` (P=3), or `false` / absent for an approval signature. A certification must be the document's first signature |
| `reason`, `location`, `contactInfo`, `name` | what the signature says about itself (the reason localized in the document's language; the name defaults to the certificate's common name) — in the signature dictionary, covered by the byte range |
| `commitment` | what the signer *means* by signing (ADR 0062): `type` is a CAdES commitment type (`id-aa-ets-commitmentType`) — `approval`, `origin`, `receipt`, `delivery`, `sender`, `creation` — and `statement` free text the signer supplied, carried as a qualifier under a Datum OID; both are signed attributes the key itself covers (`reason` sits in the signature dictionary, covered by the byte range, and is not a signed attribute); `complete` recomputes the attributes with its own `commitment`, so a statement or type changed between `sign` and `complete` is caught by `toBeSignedDigest` when `complete` carries it; `verify` reports them back as `commitment`. |
| `subFilter` | `ETSI.CAdES.detached` (default) or `adbe.pkcs7.detached`, the older Adobe profile with a signingTime attribute |
| `appearance` | `false` for an invisible signature; otherwise `page`, `rect` (points from the top-left, like areas), `lines`, `fontId`, `fontSize`. The default draws "Digitally signed by …", the date and the reason with the first font resource, into the field's box |
| `timestamp` | reserve room for an RFC 3161 token the host fetches (PAdES-B-T) |
| `required` | a document rendered without certificates is refused rather than produced unsigned; otherwise it is produced unsigned with `signature.noCertificates` |
| `placeholderBytes` | the `/Contents` capacity, when the certificate chain is unusual |

The designer offers the block on the `pdf-document` root; template mode marks a template's
signature field as "Sealed by the server". The request may override any key, and adds the
certificates: `renderFormPdf(runtime, deps, { signature: { signer, settings?, timestamper? } })`
with a `PdfSigner` (`createWebCryptoPdfSigner` for WebCrypto; two lines over `node:crypto` or a
KMS otherwise) does the two calls and publishes `PDF_SIGNED`; a provider that cannot sign is
refused rather than let deliver an unsigned file. A server host does the same over the program's
`document` / `sign`, `complete`, `timestampRequest` and `verify` ops (`packages/pdf-kernel/README.md`
has the recipe, and the docs site's server examples show it in four languages).

**Signing in the browser with a hardware token, or a certificate file (ADR 0062).**
When the *person* signs — with the certificate on their own YubiKey, or one they keep as a
`.p12` / PEM file on their computer — the page cannot reach the smart card and must not hold
the key, so a small agent on their computer does: `tools/piv-agent/piv_agent.py` (Python, on
Yubico's `yubikey-manager`, loopback only, an `Origin` allowlist, the PIN or passphrase asked in
the operating system's own dialog and never in the page; `--p12 signer.p12` or `--key`/`--cert`
serve a file under the pseudo-slot `file`, the key read and dropped per signature). The
engine's client turns it into a `PdfSigner`:

```ts
import { createAgentPdfSigner, listAgentCertificates, agentPdfSignerFor } from "@argusvane/datum-engine"; // or datum-form.js

form.pdfSigner = await createAgentPdfSigner({ url: "http://127.0.0.1:7391", slot: "9c", context: { title } });
const { signature } = await form.downloadPdf();   // the kernel prepares, the agent asks for the PIN and signs, the kernel embeds
form.pdfSigner = undefined;                        // one signed download
```

`listAgentCertificates` lists every slot holding a certificate, and the file — subject, the
kernel's algorithm id, PIN and touch policies (`passphrase` / `never` for a file), `source`,
`usable` with a reason when the kernel could not sign with it (RSA-1024, Ed25519) — and
`agentPdfSignerFor(entry)` is the signer for one of them; `createAgentPdfSigner` without a
`slot` takes 9c, or the one usable certificate when there is no 9c (an agent run for a file), and
refuses with `no_certificate` when several would do.
`pdfSigner` / `pdfSignature` (settings over the layout's `signature` block, and a timestamper) are
properties on `<datum-form>`, `datum-form-host` and the renderer element, never attributes: a key
does not belong in markup. Set, every PDF that names no `signature` of its own is signed (the
toolbar button and a button's `pdf` action included) and is refused rather than delivered
unsigned when the provider cannot complete a signature; the `datum-pdf` detail carries what was
signed. `datum-form.js` exports the agent client, so a page with the bundle alone can use it.

The agent holds the PIV session and signs; the page renders the PDF as before, only
`toBeSigned` goes to the agent and only the value comes back, so the agent never sees the PDF and
the page never sees the PIN or the key. It listens on `127.0.0.1` only (no flag opens another
interface) and answers only the origins it was started with (`--allow-origin`, defaulting to the
Vite dev origins): every request, preflights included, without an allowed `Origin` is refused with
`origin_denied` before anything else happens; it echoes the origin with `Vary: Origin`, marks every
reply `Cache-Control: no-store` and answers the Private Network Access preflight. A page served
over `https` may call `http://127.0.0.1` (loopback is "potentially trustworthy"); whether a public
page may reach loopback at all is the browser's decision (Chrome asks once per site), so a page
makes its first call to the agent from a click, never on load. One signature at a time (`busy`
for a second one while the first waits on the dialog); reads still answer meanwhile.

The PIN or passphrase is asked in the operating system's own dialog, which names the requesting
origin as read from the request header, the document's title, id and field when the page gave
them, the reason the page supplied (the request context's `reason`: the signature's reason or
commitment statement, shown as *You are signing: …*), the certificate's subject and slot (`(file signer.p12)` for a file) and a prefix of the
digest being signed: the consent step for each signature. The text reaches the dialog through
environment variables or argv, never spliced into a script. With no graphical prompt the agent
falls back to `getpass` in its own terminal (`--terminal-pin` forces that). The secret is deleted
right after use and never logged. A key with no passphrase does not sign silently once the origin
passes: the dialog is a plain Sign / Cancel. The default slot is 9c, the Digital Signature slot,
whose PIN policy is *always*, so every signature prompts. Every slot holding a certificate is
listed (9a, 9c, 9d, 9e, the retired 82–95) with its PIN and touch policies where the firmware
reports them; RSA-1024 (the kernel refuses values under 128 bytes), Ed25519 and X25519 are listed
`usable: false` with the reason, and a request for one is refused with `unusable_key` before any
prompt; a blocked PIN is reported without a prompt too.

A certificate file is a second backend of the same agent (`FileBackend`), listed under the
pseudo-slot `file` (a PIV slot is two hex digits), `slotName` `FILE`, `pinPolicy` `passphrase` or
`never`, `touchPolicy` `never`; every entry carries `source` (`yubikey` | `file`) and a file entry
`file`, its base name. At startup it reads only the certificates (an encrypted PKCS#12 keeps its
certificate behind the passphrase, so that one is asked once, then discarded; a PEM pair needs no
startup prompt); for each `/sign` it reads the file again, decrypts the key with the passphrase
the dialog just asked for, signs (`SHA256` + `PKCS1v15` for RSA, `SHA256` ECDSA for EC) and deletes
the key and the passphrase, so the process holds no private key between two signatures. With both
a YubiKey and a file configured a `CompositeBackend` serves one inventory and routes each slot to
its owner; a token unplugged does not hide the file. With a file given the default slot becomes
`file` unless `--slot` says otherwise. The agent runs a certificate file alone when
`yubikey-manager` is not installed (`pip install cryptography` suffices then). A key in a file is
only as safe as the file: the agent never caches it, but the dialog and the origin allowlist bound
*when* it is used, not *who* can copy it.

Refusals arrive as `PdfSigningAgentError` with a code a page words: from the agent, with their
HTTP status, `bad_request` (400), `origin_denied` (403), `no_certificate` (404), `not_found` (404),
`unusable_key` (422), `algorithm_mismatch` (409), `pin_invalid` (401, with `attemptsRemaining`
for a token; a wrong file passphrase has none, a file having no lockout counter), `pin_blocked`
(401), `pin_cancelled` (409), `touch_timeout` (408), `busy` (423), `no_device` (503),
`device_error` (500) and `too_large` (413); from the client, `unreachable` (nothing answered)
and `protocol` (something else did). The docs site's [Signing](../site/docs/signing.md) page shows the agent; `tools/piv-agent/README.md` has the
API, the flags, the platform prompt matrix and the browser caveats (Safari, Chrome's Local
Network Access prompt).

**The engine's seam.** `PdfRenderProvider` has the four signing operations. A `PdfSigner`
(certificates plus `sign(toBeSigned, algorithm)`) and a `PdfTimestamper` are the host's two
functions; `createWebCryptoPdfSigner` and `createFetchTimestamper` are ready-made. `renderFormPdf`
does the two (or three) calls and publishes `PDF_SIGNED` on the runtime's event bus with what was
signed and how — the layout, the field, the algorithm, the sub-filter, the certification, the
certificate count, the digest, whether it was timestamped, the commitment type and the byte
length, never the bytes, the attributes or the value — which the telemetry bridge counts as
`pdf.signed.count`. A provider that lacks the operations, or `complete`, is refused rather than
let deliver an unsigned file, as is a program that returns no `signing`.

**Verifying.** `verify` reads every signature back with everything but the value checked, so a
host reads one report and carries no PDF, CMS or ASN.1 code of its own. The kernel reports what
it can read without a key; the host verifies the value over `toBeVerified` with its platform
crypto and decides trust — for its own records, by comparing `signer.certificate` with its own.
A PDF/A file stays PDF/A through a signature (the widget gets an appearance with an embedded
font, the DocMDP reference carries no `DigestMethod`), which veraPDF confirms in
`tests/verapdf.test.ts`. The pieces of the report follow; the wire is in
[pdf-abi.md](reference/pdf-abi.md).

**The signature.** The kernel checks that the range is the ISO / PAdES shape and frames the
`/Contents` it names (else the warning `signature.byteRange`), `coversDocument` (the range reaches
the end of the file), the digest against the CMS's `messageDigest` (`digestMatches`; SHA-256 only,
another algorithm is the warning `signature.digestAlgorithm`), the signing-certificate attribute
against the certificate carried (`certificateMatches`; a signature without the attribute warns
`signature.noSigningCertificate`, one whose signer no certificate holds `signature.signerMissing`),
the certification level and a timestamp's imprint. It hands back the signer's certificate and
SubjectPublicKeyInfo, `toBeVerified` and the value (and `signatureP1363`, the `r‖s` form for
WebCrypto, for P-256, P-384 and P-521 only), the certificates the signature carries, and every
embedded file's name and SHA-256 — what a record's attached `submission.json` must hash to. A
signature prepared and never completed is the warning `signature.unfinished`.

**The timestamp, whole.** `timestamp` carries the token (`token`, the `TimeStampToken` as DER
base64), `time` and `tsa`, `imprintAlgorithm` and `imprint`, `serial`, `nonce` and `accuracy`,
`digestAlgorithm`, `toBeVerified` (the token's signed attributes as a DER `SET OF`),
`signatureAlgorithm` and `signature`, `signer` and `certificates` (the TSA's certificate, found by
issuer and serial or by subject key identifier) and four checks the program makes itself:
`messageDigestMatches` (the TSTInfo against the messageDigest attribute), `contentTypeMatches`,
`certificateMatches` (the ESSCertID or ESSCertIDv2 names the signer certificate; a token with no
signing-certificate attribute gives `false`, RFC 3161 §2.4.2) and `coversSignature` (the imprint
is the signature value's SHA-256, SHA-384 or SHA-512; a SHA-1 imprint is reported but never counts
as covering it). The host verifies the token's signature over `toBeVerified` with the `signer`
certificate, `digestAlgorithm` and `signatureAlgorithm`, and decides whether it trusts the TSA. An
ESSCertID (v1) names the certificate by SHA-1, and TSAs imprint and sign with SHA-384 and SHA-512,
so the program carries those hashes.

**The signed revision, beside the file as it is now.** A later incremental update may define the
signature dictionary again with other values while keeping `/ByteRange` and `/Contents`, so the
top-level `reason`, `location`, `name`, `contactInfo`, `signingTime` and `certification` mean the
file as it is now. Per signature, `signedRevision` (the same entries, `PdfSignatureDetails`) is
read from the revision the range ends with, `changedAfter` lists each key whose latest value
differs (`null` when the latest has none), and `details` says `signed` when `signedRevision` was
read or the signature covers the whole file (then the top-level fields are what was signed and
`signedRevision` is absent), `current` when it could not be. The dictionary is found by loading the
file up to the end of the range and taking the signature field of the same name whose `/ByteRange`
matches and whose `/Contents` equals the hex in the gap, else any field that matches so (a later
update may have renamed the field), else any dictionary in that revision that does. Failure is
the warning `signature.revision`, never an error.

**Identity.** The reply carries `documentId`, the first element of the trailer `/ID` as the file
now holds it, lowercase hex, `null` for a file without one. `env.documentId` is the render input
from which the program derives a file's `/ID` (the first 32 hex digits of its SHA-256), so a host
that kept `env.documentId` computes that digest and compares. Nothing authenticates the top-level
`documentId`: it is the file's current claim. Per signature, `signedDocumentId` is the `/ID` the
signed revision's trailer has, which the signature does cover.

**Where the signer certificate came from.** `verify` takes `knownCertificates` (DER base64, at
most 64 entries of 16 KiB each, more is `invalid_request`), searched after the certificates the
signature or token carries. Per signature, `signerSource` is `signature`, `known` or `null`; on
the timestamp, `token`, `known` or `null`. Knowing a certificate is not trusting it, and
`certificateMatches` still gates the binding. `signature.certificateMismatch` warns when a carried
certificate shares issuer and serial with a known one but differs.

**Which signatures are found.** Four places, one report per `/Contents` and `/ByteRange` together
(so a later copy of a certification with the same `/Contents` is reported beside the first, not
instead of it): the field tree, the catalog's `/Perms` DocMDP entry, any indirect dictionary with
a `/ByteRange` and a hex `/Contents`, and every `/ByteRange` array written in the file's bytes
whose range frames hex, ends a revision and whose signed revision still holds the dictionary. A
signature not reached from a field is `signature.unlinked`; one that cannot be read,
`signature.malformed`. A DocMDP transform with unreadable parameters reads as P=1. A file holding
more than 64 signatures, or an encrypted document, is refused (`signature`). A revision prefix is
loaded only where the bytes end in `%%EOF`, once per end, at most 64 ends per `verify` (beyond that
the warning `signature.revision` and no `laterRevisions`); field-tree and `/Perms` signatures
reserve their loads before ranges found only in the bytes, so decoys cannot take a real
signature's slot.

**What changed after the signature (`laterRevisions`).** For a signature that does not cover the
whole file and whose signed revision was read, the report lists how many revisions follow
(cross-reference sections resolved, not `%%EOF` markers), every object the later updates added,
changed or freed (`ref`, `kind`, a short `detail`), `permitted` and `reliedOnSignatures`. Objects
are compared by a canonical form (sorted keys, strings as bytes, streams as their dictionary and a
SHA-256), only where the final document still reaches them. The kinds are `signature-dictionary`,
`signature-field`, `field-value`, `annotation`, `acroform`, `page-annots`, `info`, `dss` and
`other`, and `permitted` follows ISO 32000-1 §12.8.2.2 with PAdES's DSS addition:

| Kind | P=1 | P=2 | P=3 |
|---|---|---|---|
| `field-value`, `signature-field`, `acroform`, `page-annots`, `dss` | no | yes | yes |
| `annotation` | no | no | yes |
| `signature-dictionary`, `info`, `other` | no | no | no |

`permitted` is `null` for an approval signature, which permits and forbids nothing by itself. P=1
allows nothing, so even a later DSS breaks it here (a host that treats LTV material under P=1
differently reads the kinds). `signature-dictionary` is never permitted because the signed
definition may not be replaced. `info` is deliberately never permitted: Acrobat reports an Info
dictionary or XMP metadata changed after certification as a disallowed change under P=2 and P=3,
and a host laxer than the viewer its users open the file in would tell them it is intact when the
viewer says it is not. The `info` kind covers the trailer's `/Info` (a trailer that drops it
included), the catalog's `/Metadata` and the stream it names. What lands in each kind:

- `field-value`: a field's `/V`, `/DV` or `/I`, and `/AS`, `/AP` or `/MK` only together with a new
  value; a read-only field's value, a locked field's value (FieldMDP `/Lock` and `/Reference`
  transforms are honoured), a changed appearance without a new value, an action (`/A`, `/AA`) on a
  field or widget, any other key, and a field added are `other`.
- `acroform`: `/Fields`, `/SigFlags`, `/DA`, `/DR` and `/NeedAppearances`; any other key (`/XFA`,
  say) is `other`. A catalog key other than `/AcroForm`, `/DSS` and `/Metadata` (the catalog's
  `/Extensions` among them), a replaced `/Root` and a page added or removed are `other`.
- `annotation`: a non-widget annotation added, removed or changed; one carrying an action is
  `other`. A widget removed from a page is `other`.
- A failure to read the later revisions is the warning `signature.revisions`, and the signature
  then has no `laterRevisions`.

The kernel does not turn this into a verdict about the file. The host maps `permitted` and the
signature check onto its own states: kept (nothing follows), allowed (changes follow and
`permitted` is true), broken (`permitted` is false, or the signature does not verify) and changed
(an approval signature with later revisions). **A host fails closed**: a `verify` that throws, or a
signature with `coversDocument: false` and no `laterRevisions`, is changes the host cannot judge,
never a pass. A certification is intact only if every signature in
`laterRevisions.reliedOnSignatures` is itself valid (digest, binding, value) as the host checks it;
the program verifies none.

**How the classifier reads.** Later revisions are classified against an adversary who plants
decoys, so the classifier reads as a reader does and does not trust the attacker's structure:

- It resolves objects as a reader does: the last `startxref` in the final kilobyte, the section at
  that offset (a table, a cross-reference stream, or a hybrid `/XRefStm`), the `/Prev` chain,
  objects at their offsets or object-stream slots, the newest entry for an object number, the
  newest trailer for `/Root` and `/Info`. Any loop, bad offset, parse failure, size cap or
  encryption makes the analysis undecidable (the signature's `laterRevisions` is absent and a
  warning says why), never partial; so does a wrong stream `/Length`, no `startxref` in the last
  kilobyte, a TIFF predictor (2) or a partial predictor row.
- Roles (page, annotation, field, widget, the lists that hold them) come from the signed revision
  for every object that existed there; only objects new in an update take a role from the later
  structure, and a stream never has one, so page content cannot pass for a form field.
- A new signature field is permitted only when a new signature dictionary seals its update: its
  `/ByteRange` starts at 0 and frames its `/Contents`; the CMS parses with SHA-256, SHA-384 or
  SHA-512 (a SHA-1 CMS seals nothing) and its messageDigest equals the digest over the ranged
  bytes; the range ends exactly where that revision ends; every object the revision lists lies
  inside the range; exactly one field or widget names the dictionary, with its widgets and
  appearances written in the same revision. A dictionary that fails is `other` ("a signature
  dictionary that seals nothing"), and a document timestamp with no widget is never relied on.
  The kernel cannot check the signature value, so `reliedOnSignatures` lists each one relied on
  (`{ field, byteRange }`; `field` is "" when no signature report matches, which a host treats as
  invalid).
- A later signature vouches only for objects its own update wrote: an object classified as
  signing on the strength of a seal must be unchanged since the signed revision or have its newest
  entry in the section that seal closes, otherwise it is `other`; a new widget attached to a field
  only through `/Parent`, and not listed in that field's `/Kids` in the sealing section, is
  `other`.
- Moved objects are found to a fixpoint (an object stream whose indirect `/Length` moved, and every
  slot in it). Indirect `/Filter` and `/DecodeParms` are resolved, parameters paired with their
  filter, and a predictor (an indirect `/Predictor` too) honoured only on the last filter.
- The file is loaded twice (the signed revision and the whole), which a large file pays for;
  nothing is computed for a signature that covers the whole file.

## Hosting

### Browser / Node, in process

```ts
import { createInProcessPdfProvider, createDefaultFontProvider } from "@argusvane/datum-pdf-kernel";
import { renderFormPdf } from "@argusvane/datum-engine";

const { bytes, pageCount, warnings } = await renderFormPdf(runtime, {
  provider: createInProcessPdfProvider(),
  fonts: createDefaultFontProvider({ baseUrl: "/fonts/" })   // DejaVu pack, fetched on first use
}, { layoutId: "record" });
```

A host that edits a layout keeps it behind a ref: `FormRuntimeDependencies.pdfConfiguration` may
be a function read on every render, so the runtime is never rebuilt (which would wipe what has
been typed into the rendered form). `ButtonAction` `"pdf"` asks the host's provider for the
form as a PDF with no submit; a host without a provider reports it unhandled like any action it
does not serve.

The PDF is rendered in the form's current locale unless `locale` names another: one loaded
submission becomes an English and a French PDF without switching the live form.

```ts
const english = await renderFormPdf(runtime, deps, { layoutId: "record", locale: "en" });
const french = await renderFormPdf(runtime, deps, { layoutId: "record", locale: "fr" });
// english.fileName → "intake-record-en-20260908-101112.pdf", french.fileName → "…-fr-…"
```

Every label, option caption, layout text, the document's `/Lang` and its text direction follow
the locale asked for, through the same translation catalog the HTML form uses. A locale the form
does not declare is refused, as `FormRuntime.setLocale` refuses it; a form that declares none
renders in whatever is asked. `<datum-form-renderer>.renderPdf()` / `downloadPdf()`,
`<datum-form-host>.downloadPdf()` and `<datum-form>.renderPdf()` take the same options.

`<datum-form-host>` takes `pdfProvider`, `pdfFonts`, `pdfTemplates`, `pdfImages`, `pdfTheme`
(the default theme) and `pdfThemes` (where a theme named by id is looked up — see *Themes*)
and shows a PDF button (with a layout picker when there are several; the picker is filled when
the runtime or the provider is set, and `refreshPdfLayouts()` re-reads it for a host whose
layouts change while the form runs, such as a designer beside it). `<datum-form-renderer>`
has `renderPdf()` / `downloadPdf()`; the latter dispatches a cancelable `datum-pdf` event with
the bytes before saving. A `button` component with `action: "pdf"` asks the host for the same.

The embeddable `<datum-form>` carries no PDF layer by default (ADR 0045): `datum-form.js` is the
form renderer alone, and `mode: "pdf"` in the render core is served by an adapter the pipeline
registers when it loads (`registerPdfRenderMode()`, called by `renderFormPdf`). With
`pdf="auto"` the element fetches the pipeline as a chunk of its own bundle and `datum-pdf.js`
(the kernel and fonts) from beside it on the first PDF; `pdf="/assets/datum-pdf.js"` names
another kernel location, and a page that imports the module itself assigns `pdfSupport`.
Without the attribute nothing PDF is ever fetched.

The builder alone has one more module: `datum-pdf-pages.js` (ADR 0057), pdf.js drawing a
template's pages for the area editor, with its worker, standard fonts, CMaps and wasm decoders
under `pdfjs/` beside it — all copied into `dist/` by the build, none fetched from a CDN. With
`pdf="auto"` `<datum-form-builder>` fetches it as a chunk of the builder
bundle with the executor; with a `pdf` URL, from `datum-pdf-pages.js` beside that module.
`pdf-pages="/assets/datum-pdf-pages.js"` names another location, `pdf-pages="off"` leaves it
out (the area editor then draws on blank sheets of the right size, as it does whenever the
module fails to load), and a page that builds its own support hands `pages` in `pdfSupport`:

```ts
import { createPdfPageRasterizer } from "@argusvane/datum/pdf-pages";
builder.pdfSupport = {
  ...support,
  pages: createPdfPageRasterizer({ workerUrl: "/assets/pdfjs/pdf.worker.min.mjs", standardFontsUrl: "/assets/pdfjs/standard_fonts/", cmapsUrl: null, wasmUrl: null })
};
```

Any `PdfPageRasterizer` does — `open(bytes)` to a page set with `pageCount`, `pageSize(index)`
in points and `render(index, { scale })` to a canvas, bitmap or blob — so a host may serve
pre-rendered page images from a server instead of running pdf.js in the page.

### Browser / Node, in the sandbox

```ts
import { createQuickJsPdfProvider } from "@argusvane/datum-pdf-kernel/quickjs";
const provider = await createQuickJsPdfProvider();   // evaluates dist/datum-pdf.program.js once
```

Same requests, same bytes (`packages/pdf-kernel/tests/quickjs-parity.test.ts` holds them equal).
The document profile allows 15 s and 256 MiB per call.

### Java / .NET

Embed any QuickJS build, evaluate `dist/datum-pdf.program.js` once, and per document call
`__datum_pdf(json)` with a `{ "op": "document", … }` request carrying the form tree, the layout
(or the whole `pdf` block and a layout id), the answers, a `locale` of the host's choosing, the
option snapshot the host resolved for data-source-backed fields (the program never fetches), the
fonts as base64, `options` (`compact`, `tagged`, `pdfa`) and an `env` with `createdAt` and
`documentId` — the only time and identity the program sees; drain pending jobs; decode the base64
`bytes` of the response. A rendering server uses the document profile (256 MiB and a 15 s budget
per call) and reads the font files from disk once, not per request. A server that validates a submission first re-runs the sandbox program
over the envelope and sends its judged `values`, so the PDF prints what the form defines and
nothing else, and a bad submission is refused with its codes before any PDF; the reply is the
bytes with a file name and the page count. A strict deployment sends `"unknownComponents":
"fail"` and treats `unknown_component` as a configuration error. The recipe with the exact
sequence is in `packages/pdf-kernel/README.md`. The model builder is inside the program,
so a non-JS host needs no TypeScript engine, and it chooses among the form's layouts by their
conditions as the browser does; the reply names the layout that printed (*Layouts
chosen by the answers*). A layout's `conformance` rides inside the layout:
a server gets PDF/A by rendering a layout that declares it (with fonts in the request), and
`options.pdfa` overrides per call; the reply's `pdfa` says what the file declares.

### Determinism

Two calls with the same request produce the same bytes: no clock, no randomness, dates from
`env.createdAt`, the trailer id from `env.documentId`, fonts subset in a fixed order, requests
canonicalised before dispatch. It is reached with library options rather than patched globals:
`updateMetadata: false` on create and load, a `customName` on every embedded font (no random
suffix), `save({ useObjectStreams: false, objectsPerTick: Infinity })` so no timer is ever
scheduled (`options.compact` turns object streams on; deflate is deterministic), glyph subsets in
encounter order from one traversal, no `Intl`, `localeCompare` or `toLocale*`, and the kernel's
own base64. The sandbox prelude still throws on `Date` and `Math.random`, so an accidental use
fails the parity suite instead of silently differing. The release gates include `pdf-render-determinism`
(`collectReleaseGateInputs({ pdfProvider })`), "not applicable" when no provider is wired.

## Designing a layout

The builder is the PDF builder too (ADR 0045, ADR 0099): the bar's document label names what is on
the page — the form, or one of its PDF layouts — and opening a layout moves the same palette,
canvas and properties panels onto that layout's tree. The mode keeps one controller per layout,
created when the layout is first selected and dropped when it is removed, so each layout keeps its
own undo history, drafts and selection between visits; a layout visited again is rebuilt only when
the form, its PDF or the catalog changed under it, and the kernel's reading of a template PDF is
cached per template source, so the PDF is not read again. A change to the layout list tells a
rename (the name alone changed under the same id, pushed into the open tree) from a structural
change (a rebuild of the designer), for both kinds of layout. On a custom
layout the palette offers the PDF components, the canvas is a page sheet with page edges, and
each bound field is previewed with its own read-only markup over the answers the rendered form holds.
Edits are saved into `pdf.layouts`; **Preview PDF** renders real bytes through the kernel. The
designer is the builder pointed at the layout tree, not a second builder: a `BuilderController`
over the PDF component definitions, with the same commands, undo history, drafts,
unsaved-changes guard, drop pipeline and inspector composition, and a canvas that mounts
`<datum-form-renderer>` over a preview runtime whose root is the layout tree. The sheet is the
page's width, not the author's: the canvas lays the form out at the root's page setup, size and
orientation, at 96 CSS px per 72 pt (Letter 816 px, A4 794 px, landscape turned; `pdfSheetWidth`),
inside its sheet padding, and puts the builder's preview-width picker and sheet grips away. It
reads the previewed tree, so an unsaved "Landscape" in the inspector already turns the sheet.
`PDF_DESIGNER_CSS` draws the page sheet with container units, so page edges and margins keep the
page's proportions at any canvas width.
Engine hosts register the side with `builder.addMode(createPdfBuilderMode({ formRoot, values,
runtime, templates, pdf, onChange, … }))`; the embeddable `<datum-form-builder>` does that on
connect, fetching the mode itself as a lazy chunk (ADR 0143) and the executor as another on the
first preview (`pdf="off"`, or a `features` list without `pdf`, leaves the PDF side out and
fetches neither). The bundle has no synchronous `createPdfBuilderMode`; it exports
`loadPdfBuilderMode()` (`(await DatumBuilder.loadPdfBuilderMode()).createPdfBuilderMode(...)`),
and `@argusvane/datum-engine` keeps the synchronous factory. `createPdfDesigner()` is there for a host that
wants the raw `builderOptions` for its own `BuilderController`.

A layout's own text — its name, the document title, section headings, static text — is
authored in the form's locales like the form's own: the mode reads the form's `localization`
(`createPdfBuilderMode({ localization })`, wired from the builder's committed value in
`<datum-form-builder>`) and the inspector offers a box per locale. The list of locales is
edited on the Form side only, so the PDF side shows no Localization section and no locale
switcher. At render time the PDF resolves every text — a layout's own, a bound field's label
and option captions, a tab's caption — in the runtime's locale, or in the one
`renderPdf({ locale })` names, with the same translation catalog the HTML form uses.

The PDF side's properties panel has no Rules tab. A layout node carries no rules the PDF reads:
what prints follows the form's own rules through each bound field, a field a rule hides leaving
the page with it, and conditional static text is an HTML component with a rule on the Form side,
bound with a `pdf-field`. A section, box or table that should vanish with its hidden fields sets
**Skip when empty** instead; the layout derived from the form sets it on every section it makes.

A text block prints its Text, placeholders resolved, unless its **Expression** is set: the same
expression AST the Rules tab's Expression mode takes, typed as JSON in the properties panel (a
`concat` of two answers, a `sum`, an arithmetic total) and evaluated against the form's values,
the current row inside a repeat, and `host.` values. JSON that does not parse is flagged under
the box and never reaches the layout; clearing the box prints the text again.

The strip's **Variables** panel (ADR 0103) lists what a text block, a caption or a mapped
field's text may hold, in the placeholder syntax this side reads: every field by its value
path (`{{applicant.email}}` for a field inside a data-scoping container), each repeating
section's fields as an entry sees them (`{{row.qty}}`, with `{{rowNumber}}`, `{{rowIndex}}`,
`{{rowCount}}`, and `{{ancestor.items.qty}}` from a section nested in another), `{{page}}` and
`{{pages}}` for a header or footer, and `{{host.key}}`. A click copies the reference. On the
Form side the same panel lists the Rules tab's paths instead. A field with a data key (ADR 0109)
is listed by it: `{{billing.street}}` for a field `billing_street` keyed `street` inside a
container keyed `billing`, and `{{row.name}}` for an entry's field keyed `name`. The PDF program
reads an entry's cells, names its AcroForm fields and attaches its files by the same keys.

A populated-form layout (ADR 0057): the PDF's pages are the canvas, and the layout is a tree
the ordinary panels edit. The root holds the PDF (uploaded, or one the host provides — choosing
another re-reads its fields), the fill options, the archival settings and the signature choice;
one `pdf-widget` per field the kernel's `inspect` lists holds what fills it — a component, text
with placeholders, a fixed value (`source.kind`), its checked value and its format. A widget is
`fixed` (a `ComponentDefinition` flag: edited, never removed, never on the palette), has the id
`widget_<field>` (the field's name lowercased, runs of anything but letters and digits one
underscore) and is labelled with the field's name; one `pdf-area` per area
drawn on a page (see *Areas* above) holds its page, rectangle, mapping, drawing and fillable-field
choices. `layoutFrom(root)` folds the tree back and drops unmapped widgets, a mapping that
names a field the PDF does not list (once the PDF's fields are read: the tree has a widget for each
listed field only, so a mapping kept from another PDF is left behind at the first fold), a value map the
Values section cannot show, drawing choices back at their defaults and settings back at theirs, so the persisted
shape stays minimal; a literal source keeps its type (boolean, number) through the designer. With
no PDF executor the tree holds the root and the areas, and the mappings ride along untouched.
The designer's status line counts any field that still has no page (`pdf.summary.unplaced`):
the field boxes need the kernel to place each widget, and a field without a page has no box to
pick.
Pick a field's box on a page to select its widget (through the inspector's unsaved-edits guard,
like a canvas click), edit it in the inspector and Apply; draw a rectangle on empty paper for an
area (one add carrying its page and rectangle: the controller's `add(type, parentId?, slotId?, init?)` takes an id and initial configuration, and without a parent its target prefers a slot that accepts the type), drag or nudge it (the move joins the selected
area's open draft, or lands as one undoable edit), Delete it. Every edit is undone like any other,
and the layout in `pdf.layouts` follows each commit; a draft keystroke that changes nothing is not
reported. There is no whole-layout unsaved state and no batch save: the inspector's own Apply,
Discard and leave prompt cover a template as they cover a form. A change to the form swaps the
component definitions under the existing tree (`BuilderController.setComponentDefinitions`), so
the layout keeps its history, drafts and selection; swapping the PDF rebuilds the tree over the
new fields, with its history starting over for that layout and the mappings carried by field
name. A mapping to a component the form no longer has counts as unmapped: *Suggest mappings* and
*Create form fields* offer the field again, and the widget shows a note. *Suggest mappings* on the
bar fills every unmapped field whose name matches a component's id or label (a checkbox field
takes its first export value as `checkedValue`; a radio group gets none, so it selects the option
named like the answer rather than being cleared by a boolean); *Create form
fields* (ADR 0117, when the host hands the mode the form's controller) goes further: every
unmapped field that holds an answer gets a form field of its own — its kind, choices, required
flag and maximum length carried over, its tooltip as the label, keyed by its own name — in the
PDF's reading order, and is filled from it, as one undo on the Form tab and one on the layout;
*Preview PDF* renders the result through the kernel and lists what filled each field and area.
What *Create form fields* builds is decided by `planTemplateFormFields` (pure, in
`template-mode.ts`) over the template fields nothing fills yet. A field whose name matches a form
component, as *Suggest mappings* finds it, is filled from that component and nothing is built for
it. Every other field that holds an answer becomes a component placed as the Data model generator
places one: text, a text area when the field is multi-line or its maximum length is 256 or more
(the maximum length kept); a checkbox, filled with its first export value; a PDF radio group stays
a radio group, and a dropdown or list box becomes a select, whatever their number of choices;
required where the PDF says so, except a checkbox, where false is an answer. The label is the
field's tooltip; a tooltip longer than 80 characters becomes the description, and its first
sentence or clause the label when that fits; a field with no usable tooltip is labelled from its
name (`topmostSubform[0].Page1[0].FirstName[0]` → "First name"). The key is the field's own name
made usable (the last path segment, without `[0]`), unique against every key and id on the form
and each other (`f1_01_2`), and the component takes the key as its id. A field repeated on
another page in the same box (within 2 points), with the same own name, kind, tooltip, choices
and export values (a name in every page's running header), is one question and is filled from the
one component; two such fields on one page are two, and a default name a form tool gave (`Text1`,
`TextField3`, `Check Box2`) is never merged. A field's own name keeps the segments of an Acrobat
copy's index (`Text1.0`, `Text1.1`), so its key is `Text1_0`, not `Text1`. Fields go in reading order — page by page,
rows top to bottom (tops within 4 points share a row), then left to right, with fields the kernel
could not place last — where *Add missing fields* puts a root-level place (`rootInsertTarget`):
before the root's closing buttons, or into the last step of a multi-step form. Signature, button,
unreadable and read-only fields are left out, each with its reason. The plan reads no date
format (a field formatted with an AcroForm action such as `AFDate_FormatEx` becomes a text
field), makes a multi-select list box a single-choice select, treats a calculated field as an
ordinary one and does not group the fields into steps or sections by PDF page; the fields are
built without a review step. The kernel reads a field's
tooltip (`/TU`) into `PdfTemplateFieldInfo.tooltip` on `inspect`, since
in many fillable PDFs it is the only readable name a field has; a field without one is labelled
from its field name. The button shows once the template's fields have been
read, and only when the host gives the mode the form's own controller (the `form?()` option of
`PdfBuilderModeOptions`; `<datum-form-builder>` passes `builder.controller`, and the Journeys mode
is handed it the same way); the mode's `createFormFields()` does the same from code and returns
what it did. The fields go into the form as one undoable insert (`requestInsertComponents`) and
the mappings land on the layout as one undoable edit (`BuilderController.setProperties`); the form
and each layout keep their own history, so the two cannot share one undo step, and the status line
says which undo takes back what. Unsaved edits on the Form tab refuse rather than prompt, since
their prompt would be drawn on a tab the author is not looking at, and so do the layout's own
unapplied edits (a source chosen and not applied is the author's answer for that field, which
the fill must neither overwrite nor build a field beside): the button says what is in the way,
and drops any hold it caused, so no field can land unmapped later.

`createPdfTemplateDesigner()` in `builder/pdf-designer/pdf-template-designer.ts` builds the tree
and folds it back; `createTemplateMappingEditor()` in `template-mode.ts` remains the DOM-free
model for a host drawing its own table, and `templateSchematicHtml()` in the same file draws one
SVG sheet per inspected page with a box per field (`data-field` carries the name, so a host can
select a row from a box). Page indices are 1-based on both sides of the join: the inspection's
`pages[].index` and each field's `page`.

The layouts are the documents of the bar. The document label's menu
renames the layout in place, duplicates it, makes it the default, moves it up or down or deletes
it; the PDF overview's New adds one — a custom layout from the form, a blank page or a copy of the current one, or
a populated form over a PDF loaded from a file or picked from the host's list. Every kind is
added the same way: the popover offers a name (from the file, the host's option or the kind),
the author confirms it, and the layout is then put on the page. Moving between layouts, through
the documents menu or the PDF overview, goes through the inspector's unsaved-edits guard like
leaving the page. `definition.pdf` on
`<datum-form-builder>` reads back every layout as edited. Its `pdfTemplates` property is the
host's template resolver — the storages a populated form's PDF comes from, and, through
`list()`, the PDFs offered beside uploading one; `<datum-form>` takes the same property to
render such layouts. Every change is one `datum-builder-change` (with `mode: "pdf"`) and one
`datum-pdf-layout-change` event carrying the layout concerned, the `pdf` block and the
definition; moving between layouts is `datum-pdf-layout-select`; moving between the sides is
`datum-builder-mode-change`. The list is also driven programmatically through the mode
(`builder.pdfMode`, or the `PdfBuilderMode` a host registered): `layouts`, `newLayout()`,
`addLayout()`, `replaceLayout()`, `duplicateLayout()`, `removeLayout()`, `setDefaultLayout()`,
`selectLayout()`, `openLayouts()`, `openTemplate()`, `previewPdf()`, `renderPdf({ layoutId })`.

**Preview PDF** opens the builder's shared dialog frame (`dialog-frame.ts`: drag, resize, maximize,
Escape) over the rendered bytes, with Download and Open in a new tab. A side column holds the
pages, the answers tried, the layout line (which layout printed and how it was chosen, from
`layoutChoice`) and the warnings, with the fill report of each field and area for a populated
form. The dialog sizes from the builder's own box, never the window's, and takes a full sheet on a
phone.

`<datum-form-builder workspaces="pdf">` is the same builder opened on its PDF side with the
switch hidden, for a page that designs the layouts alone; `layout-id` names the layout to open on.

## Fonts

The kernel embeds and subsets TrueType/OpenType fonts (`fontkit`); the default pack is DejaVu
(Sans, Serif, Mono; Latin, Greek, Cyrillic, Arabic, Hebrew coverage on the Sans). The embeddable
elements' executor module (`createPdfSupport` in `@argusvane/datum`) loads the Sans regular and
bold pair by default (`fontIds` names others, `fontsUrl` where they are served); with
`createFaceFontProvider` and a theme's `assets.fonts` in front of it, the pack answers the
families a theme's own faces do not, and `createPdfSupport` composes the two with the bundle's
URL as the base (`bundleUrl` names another place, or answers per theme), so `datum-pdf.js`
imports no binding package. A server host sends a theme's faces as resources in the request's
`fonts[]`, and a failed face read is not cached. Text is itemised by script
and falls back per `typography.fallbacks[script]`, then to any loaded font with a glyph. With no
fonts at all the standard 14 are used, and text they cannot encode is reported as
`font.unencodable` — except under a PDF/A claim, where a missing resource is a `font` error and
a missing glyph becomes `?` (see [Conformance](#conformance-pdfa)). CJK is not in the default pack.

## Where things are

| Concern | Location |
|---|---|
| schema, readers, page setup, rendition vocabulary | `engine/form-engine/core/schema/pdf-layout.ts`, `pdf-renditions.ts` |
| render model, renditions, templates, default layout | `engine/form-engine/render/pdf/` |
| provider seam, ABI types, service, download | `render/pdf/pdf-provider.ts`, `pdf-abi.ts`, `pdf-service.ts`, `web-component/pdf-download.ts` |
| render-mode adapter registry, the pipeline's registration | `render/core/render-orchestrator.ts`, `render/pdf/pdf-render-mode.ts` |
| designer: builder options, the builder mode, its model and dialogs, template mode, the page viewer for areas | `engine/form-engine/builder/pdf-designer/` (`pdf-designer.ts`, `pdf-builder-mode.ts`, `pdf-mode-model.ts`, `pdf-designer-panels.ts`, `template-mode.ts`, `template-pages.ts`) |
| template areas: the seam for page imagery, the kernel's drawing | `render/pdf/pdf-pages.ts`; `packages/pdf-kernel/src/kernel/areas.ts` |
| builder modes (the PDF-agnostic facility) | `engine/form-engine/builder/web-component/builder-modes.ts`, `default-builder-element.ts` |
| kernel, program, providers, fonts | `packages/pdf-kernel/` |
| tagging: structure tree, marked content, artifacts, widget `OBJR`s (guide: [`pdf-tagging.md`](pdf-tagging.md)) | `packages/pdf-kernel/src/kernel/tagging.ts`, `writer.ts`; roles set in `render/pdf/pdf-render-model.ts` |
| PDF/A: the setting, the conformance pass, strict fonts, the fill's claim, veraPDF ([ADR 0059](adr/0059-pdf-a-conformance.md)) | `core/schema/pdf-layout.ts` (`resolvePdfConformance`); `packages/pdf-kernel/src/kernel/pdfa.ts`, `fonts.ts` (`strict`), `template.ts` (`fillClaim`); `tests/kernel-pdfa.test.ts`, `tests/verapdf.test.ts` |
| attachments: the switch, the collector and budget, host resolution, the kernel's writer ([ADR 0060](adr/0060-uploaded-files-as-pdf-attachments.md)) | `core/schema/pdf-layout.ts` (`ComponentPdfOptions.attach`, `resolvePdfAttachmentPolicy`); `render/pdf/pdf-attachments.ts`; `pdf-service.ts` (`resolvePdfAttachments`); `packages/pdf-kernel/src/kernel/attachments.ts`; `tests/kernel-attachments.test.ts`, `tests/quickjs-limits.test.ts` (the budget measurement) |
| signatures: the layout block and the `pdf-signature` component, the seam, the kernel's signing pass, verification ([ADR 0061](adr/0061-pdf-digital-signatures.md)) | `core/schema/pdf-layout.ts` (`resolvePdfSignatureConfiguration`); `render/pdf/pdf-abi.ts` (`PdfSignatureSpec`, `PdfSigningHandoff`, `PdfSignatureReport`), `pdf-provider.ts` (`PdfSigner`, `PdfTimestamper`), `pdf-signer.ts` (WebCrypto), `pdf-service.ts`; `packages/pdf-kernel/src/kernel/signature/` (`der.ts`, `x509.ts`, `cms.ts`, `placeholder.ts`, `field.ts`, `appearance.ts`, `sign.ts`, `verify.ts`); `tests/kernel-signature.test.ts`, `tests/signing-fixtures.ts` |
| embeddables | `packages/datum/src/pdf.ts` (the executor module and the builder's lazy chunk), `pdf-pages.ts` (pdf.js page imagery, the builder's other lazy chunk), `builder-element.ts`; `scripts/check-bundles.mjs` |
