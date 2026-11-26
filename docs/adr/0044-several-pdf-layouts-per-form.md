# ADR 0044: PDF layouts: several per form, chosen by the answers, and where a template's PDF comes from

## Status
Accepted.

## Context

One form serves several readers: the applicant gets a client-facing copy, the back office a
record with internal fields, the registry a paper form filled in. ADR 0043 makes room for this
on the definition: `pdf.layouts[]` is a list, `defaultLayoutId` names one, `findPdfLayout`
picks by id and the renderer's picker lists them all. An author needs a model of that list to
make it, add to it and take from it. `createPdfDesigner()` edits one generated layout at a time
by design.

Populating an existing PDF form is a kind of PDF an author chooses when adding one, not a mode
of the designer. And the PDF behind a template layout may be uploaded (inline `base64`,
travelling with the definition) or offered by the host: the `PdfTemplateResolver` that resolves
host storages (`url`, an asset id) needs a way to say which PDFs the host offers.

A form also does not have to have a layout at all. A definition holds only the PDF layouts the
author made, and none if the author made none.

Choosing among the declared layouts by the answers — a French copy for Quebec, a large-print copy
for whoever asked, a paper form for one programme and not another — would otherwise need the
host to pick an id, so each host would re-implement the same `if` over the answers, and a
Python, Java or .NET server that renders through the program would have to do it in its own
language.

Four facts shape the design:

- **One call site.** Every path to a PDF — the browser's `renderFormPdf`, the program's
  `document` and `build` ops, the submissions server, every server example on the docs site —
  reaches `buildPdfRenderModel`, which picks the layout. The program bundles the rules evaluator
  already (template text uses it). So the choice lives in one engine function, and no host needs
  an evaluator of its own.
- **Two views of the answers.** The browser builds PDFs from the raw state, the server from the
  judged submittable values. Journeys (ADR 0112) make the difference matter: an answer on a
  branch the person left stays in the page's state but is not submitted. Both sides compute the
  submittable view through one fold (`kernelFoldSubmittable`, ADR 0178 decision 2).
- **Template bytes travel beside the request.** A host whose template PDFs are not inline sends
  the bytes on `document`, and has to know which layout they are for.
- **Readers that know only "the declared default, else the first".** The builder's Default pill
  and vendored bundles all read it.

ADR 0112 decision 10 stands: what prints is the stored answers, laid out as the layout says. Only
the *choice* of layout reads the submittable view. The guide is
[`docs/pdf-rendering.md`](../pdf-rendering.md#layouts) (the list, the choice, and the builder's
side of it under "Conditions in the builder").

## Decision

### The list of layouts and where a template's PDF comes from

1. **The list is a model in the engine; a host draws it.** `builder/pdf-designer/layout-catalog.ts`
   holds pure functions over `PdfConfiguration` (add, replace, remove, duplicate, set default,
   move, new generated layout, the id helpers), each returning a new configuration with ids kept
   unique. Nothing on the runtime side changes.

2. **Adding a PDF starts with its kind.** The builder's PDF mode lists the layouts as the
   documents of the bar (the label names the one on the page and carries its menu, ADR 0099 decision 2; the PDF overview lists them, ADR 0125), and New opens a popover that
   asks what kind of PDF to add: a *custom layout* designed on the page (from the form, a blank
   page, or a copy of the current one), or *populate an existing PDF form* over a PDF loaded from
   a file or picked from the host's list, edited as a tree in the ordinary panels with the PDF's
   pages on the canvas (ADR 0057 decision 22). Every kind is named before it is made: the popover
   offers a name (from the file, the host's option or the kind), the author confirms it, and the
   layout is then put on the page. A layout has one name, seeded onto the document root where the
   inspector edits it.

3. **A template's PDF is uploaded or host-provided, and the resolver says which it offers.**
   `PdfTemplateResolver` has an optional `list(): Promise<PdfTemplateOption[]>`, filled by
   `createPdfTemplateResolver(byStorage, { templates })`. A layout that picks one carries the
   option's `source` (a host storage kind and its reference, never the bytes), so the file lives
   in the host's wiring and the definition stays small. An uploaded file stays inline `base64`,
   so it counts against the definition's load limit (`max-definition-bytes`, 2 MiB unless a host
   raises it): the mode refuses an upload, a copy of an uploaded template or a replacement
   template that would push the form past it, naming the sizes and changing nothing. A form that
   saved but could never be opened again would be worse than a refused upload. A template from
   the host's store keeps its bytes out of the definition and is never asked about.

4. **A form need not have a layout.** The PDF side derives nothing into the definition:
   `seededPdfConfiguration` returns the declared, valid layouts and nothing else, and the
   builder's `definition` leaves `pdf` out when the configuration has no layouts. The last layout
   can be removed, and a mode that loses its last document hands the page back to the form (ADR
   0115). Preview PDF and `renderPdf()` print the pipeline's derived layout, which is what a
   download of the form prints; "From the form" in the add popover is how an author asks for it
   as a layout of their own, to arrange or make the default. Every layout counts as someone's
   work: a form is empty only with no PDF layout at all.

### The author's choices

5. **An explicit choice wins.** An inline `layout`, a host's `layoutId`, a layout picked in
   `<datum-form-host>`'s picker, an operator's `PdfSettings.layoutId`, a sample's `LAYOUT_ID` and
   the designer's inline preview all bypass conditions. Only a download that names no layout
   follows them.

6. **The condition lives on each layout**, as a top-level `when` (a rules `Expression`, as a
   journey route has; formula text or the object form, ADR 0139), on generated and template
   layouts alike. Layouts are tried in `pdf.layouts` order, the default in its place. Moving a
   layout up or down is the builder's way to set priority.

7. **Conditions read answers only**: the submittable view, keyed by component id, in form scope.
   The journey taken is not readable — it is chosen by the host or `opensAs`, not by an answer,
   and a route's condition is tried first-match over a partial view, so reusing one does not
   identify the route taken. The workaround is an answer or a calculated field the journey sets.

8. **An explicit default is required.** What prints when no condition holds is the declared
   `defaultLayoutId`. For a hand-written definition without one, the engine keeps the rule that
   already held — the first layout — so a reader that knows nothing of conditions and one that
   does print the same when no condition holds. (A rule "the first layout without a `when`" was
   rejected: a conditional first layout would then print for everyone under every old reader.)
   The builder writes `defaultLayoutId` down as soon as any layout has a `when`, never on opening
   a layout, and the advisory `pdf-layout.no-default` flags a definition with conditions and no
   declared default.

### How a layout is chosen

9. **The order, everywhere** (`selectPdfLayout`, core; `layoutChoice` reports the step): an inline
   `layout` (`given`); a `layoutId`, matched exactly (`asked`; an unknown or unusable id derives a
   layout and warns `layout.notFound`); the first layout in list order whose `when` holds
   (`condition`); the declared default (`default`); the first layout (`fallback`); a layout
   derived from the form (`derived`). A definition with no `when` anywhere chooses as a form
   without conditions does.

   **`when` is not validated as a schema problem.** `validatePdfLayout` does not check it, so a
   malformed condition never makes its layout unusable, Open never refuses a file over it, and
   the builder never drops it. At selection a `when` the evaluator cannot run all the way down
   (`isEvaluableExpression`, in `core/expressions/condition-shape.ts`) never holds and warns
   `layout.conditionInvalid`; one that throws counts as not holding and warns
   `layout.conditionFailed`. The layout stays usable by id, as the default and as the fallback.
   There is one canonical place, the top level; the generated designer lifts a `when` edited on
   the document root back there.

10. **The program refuses template bytes a condition would misapply.** In `document`, when the
    request carries `template.data`, a condition chose (so no `layoutId` or `layout` was given),
    and it chose a template layout other than the one printed when no condition holds, the
    program answers with the `template` error code, naming the chosen layout and asking for its
    `layoutId`. Those bytes were resolved for another layout, and its fill plan — field names,
    areas, pages — would fill the wrong PDF with nothing but "missing" field reports to show for
    it. Bytes sent for the very layout a condition chose, and bytes beside a generated layout a
    condition chose (which takes none), are not refused.

11. **The designer's page does not move.** `effectivePdfDefaultLayoutId` and
    `PdfModeModel.selected()` keep "the declared default, else the first", and the model pins the
    layout actually shown once a designer is built on it (`PdfModeModel.pinShown()`), so saving a
    `when` on the implicitly opened layout — or setting another default — never swaps the
    controller, the panels and `currentLayout()` out from under the canvas.

12. **The host picker.** `<datum-form-host>` records whether the person changed its select and
    restores only a choice the person made. Otherwise it shows *Automatic (by the answers)* —
    first, sending no id — whenever any layout has a `when`, else the declared default, else the
    first.

13. **Where the answers come from.** In the browser, `FormRuntime.submittableValues()`, the
    runtime's own fold output (journey placement, the hidden-value policy, calculations); a
    runtime without it (the builder preview's) falls back to the state. On a server and in the
    program, the request's `values` as sent, which on every server path are the judged answers
    already. Both are re-keyed by component id in one place (`valuesByComponentId`) and evaluated
    with `evaluateExpression(when, { values })` read as `Boolean`, exactly as journeys evaluate —
    no `hostContext`, so `host.` reads nothing anywhere, and `row.`/`ancestor.` are unanswered.

    **As the envelope carries them, and only keys the schema defines.** Before re-keying,
    `selectPdfLayoutForValues` keeps `kernelPartitionValues(values, root).known` — the sandbox's
    allowlist — and reads it through `kernelJsonAnswers`: a non-finite number is `null`, an
    `undefined` entry absent. Without the first, a key no component owns (`campaign`, set by a
    host) would choose in the browser and in a program over the envelope but not on a server that
    strips unknown fields; without the second, a calculation that came out `NaN` would hold
    `neq(ratio, null)` in the browser while the server, holding JSON's `null`, printed another
    layout. A `when` never reads a key no component owns directly, but it can read a calculation
    that did, alike on both sides (ADR 0178 decision 2). What the chosen layout prints reads the same way,
    through `kernelJsonAnswers`.

    An answer on a branch the person left, or one hidden and excluded or cleared, therefore
    chooses nothing in the browser *or* on the server, while the page may still hold it; a
    retained hidden answer chooses alike on both. A host `transformValues` hook runs only at
    submit, so a condition over a field it rewrites can choose differently before and after.

### Hosts and tools

14. **Template sources.** Which template prints depends on the answers, so a host must be able to
    resolve every template in `pdfLayoutCandidates(definition)` — the conditional layouts in
    order, then the one printed when none holds — exported for a preflight. The submissions
    server names the layout when it cannot, and the record is still accepted. The builder
    advisory `pdf-layout.condition.template-source` flags a conditional or fallback template
    layout whose storage is not inline. The same holds for what else depends on the layout:
    `signature.required`, and the PDF/A-1/2 attachment drop.

15. **A public, condition-aware predictor.** `selectPdfLayoutForValues(definition, values, {
    layoutId })` (render layer) is the render model's own choice for value-path-keyed answers:
    the same view and evaluator, for a host that must know the layout before rendering.
    `findPdfLayout` is condition-blind — what prints when no condition holds.

16. **The submissions service.** The server renders with the definition it registered, not the
    live one. A stored PDF names how its layout was chosen (`StoredPdf.layoutChoice`).

17. **Renames.** A form rename rewrites every layout's `when` with `renamePdfLayoutConditions`,
    and a pending Rules-tab draft's `when` too rather than overwriting it, as it rewrites the
    layouts' own bindings. The mode learns of it through `BuilderMode.formRenamed`, which the
    shell calls for every mode with no host wiring. The rename and every layout's follow-up, in
    the catalog and in each built tree, are one step of the form's history (ADR 0180 decision
    4), so one Undo points every condition and binding at the old id again and the layout's own
    Undo never meets the rename. Built designers are rewritten in place and each layout rewritten
    is reported as a `"layouts"` change. A designer still being built when the rename lands is
    built from the catalog as it stands once its reads are over, because built from the layout it
    started with it would put the old id back. The inspector forgets a rule's working copy once
    the draft stops holding what it wrote, so the Build rows and a parsed JSON box show the new
    id and the next edit keeps it.

18. **Reply fields.** `layoutId`, `layoutKind` and `layoutChoice` are on the `document` reply
    only (`PdfLayoutReply`); `render`, handed a document already built, names none, and the reply
    union is split so its type says so. `build` carries `layoutChoice`. `when` travels inside
    `pdf.layouts[]`, so there are no new request keys; the `layout-conditions` feature tells a
    host the program chooses ([`docs/reference/pdf-abi.md`](../reference/pdf-abi.md)).

### Builder authoring

19. **The Rules tab is on a layout's root only.** `pdfLayoutRuleDescriptors`
    (`builder/pdf-designer/layout-conditions.ts`) offers one targeted rule, "Print this layout
    when" (`target: { propertyPath: "when" }`), on `pdf-document` and `pdf-template` roots; every
    other layout node has no Rules tab, because a layout node carries no rules the PDF reads
    (ADR 0043 §4). The designers carry the root's `when` and lift it to the layout's top level,
    so a save lands there and writes the default down (decision 8). Opening a layout is not an
    edit: it is handed back with `declareDefault: false`, so a definition with conditions and no
    default keeps its shape, and says so in `.no-default`, until the author saves, duplicates or
    copies. The mode's `inspector.rules` object is built once, since the inspector drops its rule
    edits in progress when it changes, and the inspector's working copies are dropped when the
    panel is pointed at another controller, because every layout's root is `document` (every
    populated form's `template`) and the node id alone would carry one layout's half-written rule
    onto the next.

20. **Findings are advisory.** `pdfLayoutConditionFindings` reports `pdf-layout.condition.invalid`,
    `.scope`, `.unknown-field`, `.entry-field`, `.shadowed` and `.template-source`,
    `pdf-layout.default-conditional` and `pdf-layout.no-default`, one per code and layout. They
    reach the layout root as the controller's `notes` hook (ADR 0115's seam, target
    `rules:when`). None is a `problem`; Save is never held. What each says is in the guide.

### The PDF mode

21. **One controller per layout.** `createPdfBuilderMode` keeps a `BuilderController` for each
    layout document, created on the layout's first selection and dropped when the layout is
    removed, so undo history, drafts and selection survive a move between layouts as the form's
    do across a mode switch. `ensureFresh` and the built signature are per layout, so a layout
    visited again is rebuilt only when the form, its PDF or the catalog changed under it.
    Inspections are cached per template source, so a layout visited again does not read its PDF
    again. The mode implements `documents` over `PdfModeModel` and `layout-catalog.ts`
    (decision 1), and `PdfModeModel.apply()` tells a rename (the name alone changed under the same
    id) from a structural change (anything else, which rebuilds the designer), for both kinds of
    layout. Adding a layout (decision 2) puts it on the page under a name the popover offers from
    the file or the option and the author confirms. *Preview PDF* and, over a populated form,
    *Suggest mappings* are the mode's actions, in the canvas's toolbar (ADR 0141).

22. **A layout's name lives only at the top level of the layout.** The builder's tree carries it
    on its root for the inspector's *Layout name* box, as it carries `when`, and `layoutFrom`
    takes it off again. Opening a layout writes nothing (`keepShown`), and a layout handed back
    as the catalog holds it is never rewritten, so a definition keeps its bytes until the author
    edits.

23. **A host's change to a layout reaches a built designer that is not on the page.** A rename,
    replace or new id made through the catalog (`renameLayout`, `replaceLayout`) must not be
    written back over by the next edit of a designer built over the old layout. A name alone is
    pushed into the tree as an unrecorded change; any other change drops the built designer, which
    is built again from the catalog on its next visit; a designer whose id left the catalog is
    disposed, so a layout given that id later is built afresh. The change is a step of the
    form's history, never of a designer's tree (ADR 0180), so the tree's own Undo never takes it
    back, nor twice.

24. **The preview dialog is a shell dialog.** It is the builder's shared dialog frame
    (`builder/web-component/dialog-frame.ts`: drag, resize, maximize, Escape), with Download and
    Open in a new tab. A side column holds the pages, the answers tried, the layout line from
    `layoutChoice` (decision 9) and the warnings, with the fill report for a populated form.
    The dialog sizes from the shell's box and takes a full sheet on a phone (ADR 0141 decision
    2.6).

25. **The mode reaches the shell through seams, not code of its own.** The shell holds nothing
    PDF-specific, and the Journeys mode uses the same seams: `BuilderDocuments.move` for the
    order, `BuilderDocument.badge` for a word beside a layout's name ("Conditional"), a callable
    `note` on the Rules tab, read-only rows in the Form panel (`readOnlyRows`, `{ id, label,
    note, open }`, no `get` or `set`) and `BuilderMode.formRenamed` (decision 17). The badge is
    drawn as an element of its own, so the document's text stays its name alone and a screen
    reader hears the name without the word. The note is a function because the layout's place in the
    order changes as others move, and re-assigning the rule source to refresh it would throw the
    panel's rule edits in progress away; a catalog action repaints the page instead. The Form
    panel's PDF group shows the order as one read-only row rather than a drafted "Default
    layout" row, because that row would duplicate *Set as default* and let a pending Form-panel
    draft silently override it. The seams' shapes and the menu's behaviour are in
    [`docs/pdf-rendering.md`](../pdf-rendering.md#conditions-in-the-builder).

## Reasoning

Seeding a derived layout into the definition would give a new form a "default" layout and every
saved or downloaded file a `pdf` block the author never asked for, and would make the last layout
irremovable. Runtime behaviour needs nothing from it: every host (the kernel,
`<datum-form pdf="auto">`, the data server) already prints a form with no layouts from the
derived layout, as it does for hand-written schemas. Turning a form's PDF off is a separate
question.

## Consequences

- One form carries as many PDFs as it needs, each named, one the default, all offered by the
  renderer's picker. `FormDefinition.pdf` has one shape for one layout or several, and none for
  a form with no layout; new forms and forms with no `pdf` block round-trip without it.
- Hosts that provide PDF forms list them once, in the resolver, and authors pick rather than
  upload; the layout stays a reference. Hosts that provide none see no picker.
- The builder's PDF mode (`createPdfBuilderMode`, ADR 0045) carries the whole of it: the
  documents, the add popover, *Preview PDF* and a catalog API, with a `templates` accessor /
  `pdfTemplates` property for the host's resolver. `datum-pdf-layout-change` reports every
  definition change with the layout concerned, the `pdf` block and the definition; `layout-id`
  on `<datum-form-builder>` chooses what is on the page. `<datum-form>` takes `pdfTemplates` too,
  so a populated form renders from a host storage.
- One `when` per layout picks the same layout in the browser, in the program under QuickJS on any
  host, and on the submissions server, from the same answers — and survives the designers, a
  calculation that comes out `NaN`, a key no component owns, and a data grid's cells.
- Hosts that named no layout print what the answers choose; a host that relied on the default
  printing is unaffected until an author adds a condition, and a template host that sent unasked
  bytes is refused rather than silently mis-filled.
- A form rename and its layouts' follow-up are undone in one step, from the Form workspace or,
  for a rename made while a layout is on the page, from the PDF designer; the layout's own Undo
  holds none of it.
