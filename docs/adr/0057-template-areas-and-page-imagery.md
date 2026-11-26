# ADR 0057: Template layouts: areas, page imagery, encrypted templates and export values

## Status
Accepted.

## Context
A template layout fills an existing PDF through its AcroForm: a `pdfField` name per mapping,
`pdf-lib` setting the field. Many of the PDFs people need to populate *look* like forms but have
none — a scanned form, one laid out by hand, one exported from a page-layout tool. For those a
layout needs to say where on a page an answer goes, the kernel has to draw onto a page it loaded,
and the designer needs the real pages to aim at rather than an SVG schematic of field rectangles
(a blank sheet on a fieldless PDF). This has to work in the browser and in the Java / .NET hosts
that run the same program (ADR 0043 §10 to §13). Two constraints: every externally loaded file
must be configurable (air-gapped deployments), and the engine takes no PDF dependency (ADR 0043).

The guide, with worked examples, is [`docs/pdf-rendering.md`](../pdf-rendering.md#template-layouts).

Two conventions of published government forms shape how a template is filled.

**Encryption.** Most of them are encrypted with *owner permissions only*: the standard security
handler, an empty user password, and a permissions word that says "print and fill, do not modify,
copy or assemble". Anyone can open them; the encryption is a statement of what the owner wishes.
Service Canada's ISP-2500 and ISP-3550 (static XFA plus an AcroForm, AESV2, `P = -3100`) are two.
Loading a template with `ignoreEncryption: true` reads the file without decrypting it. `inspect`
then fails with "Expected instance of PDFDict, but got undefined" (the object streams are still
ciphertext) and `fill` with "/Crypt stream encoding not supported". Neither message names
encryption, so a form author could not tell that the template was the problem or what to do about
it. `@cantoo/pdf-lib` decrypts in pure JavaScript (`PDFDocument.load(bytes, { password: '' })`);
only `encrypt()` needs Web Crypto. Decryption therefore works in the QuickJS program, which has
none.

**Export values.** Most were built in Adobe Designer, which gives a radio group's options bare
export values: Service Canada's ISP-2500 names the three answers of "Since date of application,
the beneficiary's condition" `1`, `2`, `3`; the words beside them are page text, in no field. A
Datum radio with the options `improved`, `unchanged`, `worsened` fills nothing, because the engine
passes the stored answer through and the kernel selects the radio state of that name. The same
holds for the Yes/No pairs (radio groups `1` / `2`, fed by a boolean answer) and for the export
values of a dropdown or a list. The ways round it are both bad: name the Datum options `1`, `2`,
`3` (the PDF's internals leak into the stored data, and the form's other consumers see `2`), or
write a formula source per radio group. The first is worse the more forms share one question.

## Decision

### Areas and page imagery

1. **Areas extend the template layout; no new layout kind.** `PdfTemplateLayout.areas[]` sits
   beside `fields[]`, each area carrying the same source vocabulary a field mapping has
   (`PdfMappingBinding` is the shared shape). A PDF with no fields is `fields: []` plus areas; a
   PDF with some fields mixes the two. Coordinates are **points from the page's top-left**, the
   `PdfBoxAnchor` convention — the only flips are the schematic's (the kernel reports field
   rectangles from the bottom edge) and the writer's (into PDF space). `draw` is `text` (the
   default) or `check` (a tick when the value means *on*, no border — the paper prints its own
   box), and `resolvePdfAreaDraw` fills the defaults so the kernel and the designer agree on
   them.

2. **One text engine.** The engine resolves an area exactly as a field mapping (`resolveBinding`,
   one function for both) into `PdfFillPlan.areas[]`. In the kernel, `drawAreas`
   (`kernel/areas.ts`) turns each text area into a `paragraph` block, measures it with the layout
   module's scratch flow (`measureFragment`, the machinery anchored `pdf-box`es use) and draws it
   with the writer's own switch (`drawDrawables`) — no second layout or drawing path. What must
   fit is the glyphs, not the line boxes, and drawing is clipped to the rectangle, so a long
   answer stops at the box's edge and never runs over what the page prints; the fill reports
   `overflow` (and warns `area.overflow`) rather than failing.

3. **Areas draw after the fields, and a fieldless PDF gains no form.** `fillTemplate` fills,
   regenerates appearances and flattens, then draws the areas as page content, then stamps the
   metadata. The AcroForm block is skipped entirely when the PDF has no `/AcroForm` and no values
   were sent — `pdf-lib`'s `getForm()` would otherwise write an empty one into a document that
   only has areas. With `areas` empty the bytes are those of a fill without the key.

4. **Page imagery is a seam, and pdf.js is the builder's implementation of it.** The engine names
   `PdfPageRasterizer` (`open(bytes)` → `pageCount`, `pageSize(index)`, `render(index, { scale })`,
   `close()`), types only; `PdfBuilderModeSupport.pages` carries one. `@argusvane/datum`
   implements it with `pdfjs-dist` (the legacy build, for the browsers the bundles already serve)
   as `datum-pdf-pages.js` — a module only, never inside the classic scripts or the renderer,
   which `check-bundles` asserts by sentinel — reading its worker, standard fonts, CMaps, wasm
   decoders and ICC profiles from `pdfjs/` beside itself, every path overridable or switchable
   off, nothing from a CDN. The builder fetches it the way it fetches the executor, and a failure
   leaves `pages` out; a host may substitute its own rasteriser, pre-rendered page images from a
   server say. `pdfjs-dist` is a dependency of `packages/datum`, never of the engine.

5. **The area editor is the canvas surface of a populated-form layout.**
   `createTemplatePageViewer` (`builder/pdf-designer/template-pages.ts`) is the surface (ADR
   0099): one sheet per page, the page picture behind an SVG overlay in the page's own point space
   holding the field boxes and the areas, each area a `pdf-area` node edited in the inspector.
   Without page imagery the overlay works over blank sheets.

6. **An area may be a fillable AcroForm widget.** `PdfTemplateArea.field` present makes the area a
   widget — a text field for `draw.kind` `text`, a check box for `check` — so the PDF becomes
   fillable where the paper had a blank and the widget looks like part of the PDF's own style.
   `field` is orthogonal to `draw.kind`, and the value pipeline is unchanged. The widget is
   transparent by construction: the kernel creates it with pdf-lib's `addToPage` passing
   `backgroundColor` and `borderColor` as *present but undefined* and `borderWidth: 0`, because
   pdf-lib tests `'key' in options`, so the widget gets no `/MK` colours and its appearance
   paints nothing but the text. Widgets are created before the appearance/flatten tail of
   `fillTemplate`, so `readOnly`, `flatten` and `appearances: "viewer"` apply to them as to the
   template's own fields. A name the template already has is refused for that area rather than
   hijacking the template's field.

### Encrypted templates

7. **Decrypt with the empty user password on load.** `loadTemplate` (the one loader behind `fill`
   and `inspect`) reads the template as supplied, and when it is encrypted with the standard
   security handler reloads it with `password: ''`. A template that needs a real password, or has
   another handler, is refused with the `template` error saying it is encrypted with a password
   and to supply an unencrypted copy; any other failure of the decrypting load is the `template`
   error "The template is encrypted and could not be read: <cause>", since a password is not what
   is missing. The kernel never accepts or asks for a password: there is no option, and no path
   for one to travel.

8. **The owner's permissions are read from `/P`** (ISO 32000-1 Table 22). **Filling is allowed
   when bit 6 is set, or from revision 3 when bit 9 is.**

9. **`fill` refuses a template whose owner does not allow filling** (`template` error). It
    **warns, rather than refuses,** when the fill flattens or draws areas on a template that does
    not allow modifying (`template.permissions`): those change page content, so the output goes
    beyond what the owner granted, and the host that asked for it is the one who decides whether
    that is acceptable. Refusing would make the common request (flatten a government form for the
    record) fail for a restriction almost no reader enforces. A fill of any encrypted template
    warns `template.decrypted`: the document written is **unencrypted**, so the original's
    restrictions do not carry over.

10. **`inspect` stays truthful and adds the permissions.** `encrypted` is true for an encrypted
    original (what the file was as supplied, not what the decrypted document says of itself,
    which is false), and `permissions` is present only then. `inspect` does not refuse a template
    that forbids filling: reading the fields is what the designer needs to tell the author so.

11. **PDF/A refuses an encrypted template** (`conformance`): PDF/A forbids encryption, and the
    check keys on the recorded flag, since the decrypted document does not report it.

12. **Signature code refuses an encrypted document**: a signature covers bytes, and these are not
    the bytes the signer saw.

13. **Decrypting through the fork is repaired where the template is loaded.** pdf-lib's reader
    decrypts every stream, including streams the file stores in the clear (a `/Crypt` filter
    naming Identity; the metadata streams of a file with `/EncryptMetadata false`), and it keeps
    the cross-reference streams, which name the `/Encrypt` dictionary. The kernel restores those
    clear streams from the as-supplied read, so the output carries their real bytes, and drops
    the cross-reference streams and the `/Encrypt` dictionary, so the output does not read as
    encrypted. pdf-lib reports through `console`, which the QuickJS program lacks, so the program
    polyfills a silent one (ADR 0043 §2); the kernel's own `template.xfa_removed` is the report.

### Export values

14. **`values` on the binding.** `PdfMappingBinding`, shared by field mappings and areas, has an
    optional `values?: Record<string, string>`: answer value to the value written to the PDF (the
    export value of a radio, dropdown or list option, or any text). Keys are answers as strings; a
    boolean answer is keyed `"true"` / `"false"`.

15. **Where it applies.** A component source's *raw answer* is translated at the top of
    `componentValue`, after the visibility check, so `checkedValue`'s comparison and the checkbox,
    checkboxes, array and choice branches all see the translated value. Arrays and `checkboxes`
    answers are translated element by element (the picked keys, for the object form). Every
    other source (path, template text, expression, literal) is translated on its resolved value,
    before `format`.

16. **`checkedValue` compares the translated answer.** With `values`, `checkedValue` is the PDF's
    word (`"1"`), not the answer's. The alternative, comparing the raw answer and writing the
    translated value, would make one binding hold two vocabularies; a binding that needs the raw
    answer simply has no map.

17. **Unmapped answers pass through, with a warning.** An answer (or array element) no key names
    is written as it is, and the fill warns once per binding (`mapping.unmappedValue`). Empty
    answers say nothing; booleans never warn (a map with only a `"true"` key is a complete
    statement for a tick); a hidden component translates nothing. `readPdfValueMap` is the one
    reader, and the layout validator does not reject a layout for a bad `values`, as it does not
    for a bad `format`. The model builder is bundled into the PDF program, so a server host gets
    the map with the program.

18. **The designer offers the map where it can list the answers.** A widget for a radio group,
    dropdown or list filled from a component with answers to list (a checkbox, or inline options
    with no data source) gets a **Values** section, an inspector field type of its own
    (`value-map`) with one select per answer and **Match by order**. Because the rows depend on
    the node, a capability of the widget definition contributes the field per widget, and the
    section opts in to being hidden when no field of it applies; each change writes the whole
    object to the widget's draft, so Save lands it as one undo step. A note names the answers
    that neither equal an option nor are mapped; it is advisory and never holds Save back (ADR
    0111). A widget that is not filled from a component, or whose PDF field is not a radio group,
    dropdown or list, drops `values` when the layout is folded from the tree, so a saved layout
    never carries a map the inspector cannot show.

19. **Areas** carry `values` through the layout and the resolver but have no Values section: an
    area has no PDF field whose options to offer.

### Stale value-map entries

A map outlives the things it was written against: a Datum option is renamed or removed, a
different PDF is swapped in whose radio group has other export values. The
designer reports such entries and never deletes them unasked.

20. **Definitions.** `staleValueMapEntries(map, rows, targets)` returns the *stale keys* (the
    source component's answers are known and the key is not one of them; a component whose options
    come from a data source, or a text box, has answers unknown at design time and never has a
    stale key) and the *stale targets* (the PDF field's inspection is known and the target is not
    one of its export options). The designer lists both under the table, offers **Remove stale
    entries** and names the widgets with stale entries under the layout's status line. A
    component emptied of options still draws the section, with no rows and no Match by order,
    because the leftover entries must stay visible; without leftover entries it draws nothing.

21. **Entries are never pruned silently.** A rename looks like a removal plus an addition, so a
    prune could not tell "unchanged" renamed to "kept" from "unchanged" deleted, and deleting the
    entry would lose the author's `2` for the one they meant to carry across; data-source options
    are unknown at design time, so nothing there can be judged; a template swap may be temporary.

### The template layout in the builder

22. **A populated-form layout is a tree the ordinary panels edit.** `createPdfTemplateDesigner`
    mirrors `createPdfDesigner`: it hands the controller ordinary options and folds the tree back
    into the layout. The root `pdf-template` carries the PDF (a `file` property, uploaded or one of
    the host's, so choosing another is an ordinary edit that re-reads the fields), the fill options,
    the archival settings and the signature choice as its property sections. One `pdf-widget` per
    field the kernel lists carries what fills it, its checked value and its format; it is `fixed` (a
    `ComponentDefinition` flag: edited, never removed, never on the palette). One `pdf-area` per
    area carries its page, rectangle, mapping, drawing choices and fillable-field choices.
    Definitions declare their sections, and `layoutFrom(root)` drops unmapped widgets, a mapping
    that names a field the PDF does not list (once the PDF's fields are read: the tree has a
    widget for each listed field only), a value map the Values section cannot show, and drawing
    choices and settings that are back at their defaults, so the persisted shape stays minimal. Without an executor to read the PDF's fields the
    tree holds the root and the areas, and the mappings ride along untouched. A mapping kept in a
    table under a surface needs its own batch save and leave guard; in the tree it is edited the way
    everything else is, per node, with drafts and undo. The page viewer (decision 5) is the canvas
    surface: a box picked selects its node through the inspector's unsaved-edits guard, as a canvas
    click does (ADR 0111 decision 13); a rectangle drawn is one add carrying its page and rectangle (the controller's `add` takes an id and initial configuration, and its default target prefers a slot that accepts the type, so the area lands with its place and no second edit to undo);
    a move or a nudge joins the selected area's open draft or lands as one undoable edit; Delete
    removes. The layout is live: every commit reaches the catalog and the host, and a draft
    keystroke that changes nothing is not reported. There is no whole-layout "unsaved" state and no
    batch save; the inspector's own Apply, Discard and prompt cover a template as they cover a form.
    Swapping the PDF rebuilds the layout's tree over the new fields, with its history starting over
    for that layout, and the mappings are carried across by field name.

23. **A form change does not rebuild a template layout's controller.**
    `BuilderController.setComponentDefinitions` swaps the component definitions under the
    existing tree, so the layout keeps its history, drafts and selection while the pickers list
    the form's new components. *Create form fields* (ADR 0117) refuses while the layout itself
    has unapplied edits, as it does for the Form tab.

24. **Page space is the displayed page, and areas are checked against the PDF.** The page sizes
    and field boxes `inspect` reports, and the areas the kernel draws, use the crop box turned by
    `/Rotate`, as pdf.js shows the page (`kernel/page-space.ts`), so what an author sees and
    aims at is what the kernel writes into. An area's rectangle is clamped to its page on Apply,
    in the same undo entry (the controller's `normalizeCommit` option), and when the layout is
    opened. A page the PDF lacks is a problem while the area is being edited and a note once it is
    stored (the fill reports it `missing`).

25. **A fillable area's AcroForm name never comes from a raw label.** Each run of periods in a
    label becomes a space, since a period separates the parts of a field's path, and a name
    derived from a label or an id is made unique across the layout (`Date`, `Date_2`), so two
    labels never merge two fields. A typed name is kept as written, two areas typing one name
    share one field, and an invalid name (an empty part of the path) is a problem.

26. **A mapping to a component the form lacks counts as unmapped.** *Suggest mappings* and
    *Create form fields* offer the field again and the widget shows a note. Nothing fills such a field in a print, and
    an undo on the Form tab or a removed component is how a mapping comes to point at nothing. A literal source keeps
    its type (boolean, number) through the designer.

## Consequences
- A PDF of any provenance can be populated: the author uploads it or picks it from the host, sees
  its pages, draws where the answers go, and the same layout renders in the browser, in Node, and
  in the Java / .NET hosts running the program. An area with a `template` or `literal` source is
  a PDF field not tied to a form field.
- `dist/` carries `datum-pdf-pages.js` and `pdfjs/` (fetched only when a page needs a font, a CMap
  or a decoder); the builder bundle has a lazy chunk of the same size. The renderer bundle and
  `datum-pdf.js` carry none of it.
- The field boxes need the kernel to place each widget on a page. A form re-saved by macOS Preview
  lists a *copy* of every widget on its pages while the AcroForm keeps the originals, so the
  kernel places a widget by its copy too (same rectangle, same field name or parent), and `fill`
  reattaches such widgets to their pages — without that, the answers land on widgets no viewer
  draws.
- Government forms of this kind fill, in the browser, Node and the sandbox alike, and name
  encryption when they cannot. An unencrypted template renders with no new warnings (the
  `kernel-compat` hashes hold).
- **The output is unencrypted.** The template's owner restrictions are not reproduced, and the
  file loses the owner's statement that it must not be edited. The warning says so on every fill.
  Re-encrypting needs the fork's `encrypt()`, which needs Web Crypto randomness (key salts, IVs,
  the file id) that the sandbox does not have and that would break the determinism ADR 0043
  promises (same request, same bytes) unless the host supplied the entropy in `env`.
- No password option exists, deliberately: it would put a secret in the definition or the
  request.
- The form's usage rights (the `UR3` entry in `/Perms`, which lets Reader save a filled form) are
  kept as they were. They do not verify against the rewritten file, so Reader may report them as
  invalid, as it already may for any fill of a rights-enabled form.
- A form can fill ISP-2500's radios and Yes/No pairs from Datum options that mean something:
  `improved` writes `1` into the "Since date" group, a boolean writes `1` / `2` into a Yes/No
  group, an answer with no key is reported, and the read-back (`extractFromTemplateFields`, ADR
  0064) inverts the map, keeping the value as read and naming the field when two answers share a
  PDF value.
- An area draws text or a tick only: no image, no line height of its own and no comb or
  character-cell spacing. A value map matches an answer by its exact string, has no per-binding
  "otherwise" value and no case-insensitive key.
- A component whose options come from a data source has no answers to list at design time, so the
  Values section is not drawn for it; the map is typed in the layout's JSON.
