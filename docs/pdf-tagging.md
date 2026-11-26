# PDF tagging

How a generated PDF gets its structure tree: what the "Tagged PDF (accessible)" switch in the
designer turns on, where each block's role comes from, how the kernel writes the tree beside
the page content, what a screen reader does with it, and what is *not* claimed. The decision is
§7 of [ADR 0043](adr/0043-pdf-rendering-portable-kernel.md); the wider pipeline is in
[`pdf-rendering.md`](pdf-rendering.md). This is the working guide to one part of it.

## What the switch is, and is not

A PDF is a list of drawing instructions. On its own it says nothing about which text is a
heading, which lines make a table, which annotation is the field for which label, or what order
any of it should be read in. A **tagged PDF** (PDF 32000-1 §14.8) adds that: a *structure tree*
of elements with roles (`H1`, `P`, `Table`, `Figure`, `Form`…) and *marked content* in the page
streams tying every drawn piece to its element. Screen readers navigate the tree; the page
stream is only what gets printed.

That is what `accessibility.tagged` writes. It is on by default and is the field labelled
**Tagged PDF (accessible)** on the `pdf-document` root in the designer's property editor
(`render/pdf/pdf-components.ts`), beside the document language, the document title and the
"show the title in the viewer" preference.

It is **not PDF/A**. PDF/A is the archival profile: XMP metadata declaring the conformance
level, an output intent with an ICC profile, every font embedded, no external references. That
is its own switch — `conformance.pdfa` on the layout, beside `accessibility`, described in
[pdf-rendering.md → Conformance](pdf-rendering.md#conformance-pdfa) and
[ADR 0059](adr/0059-pdf-a-conformance.md) — and the two combine: a tagged PDF/A-2b document is
the usual archival form. Tagging is **not a PDF/UA conformance claim** either: the tree is
best-effort structure and no validator runs on it (veraPDF does run on the PDF/A side). The
[known gaps](#known-gaps-and-what-is-not-claimed) at the end list what the tree does not
cover.

## Where the decision is made

| Level | Where | Meaning |
|---|---|---|
| layout | `pdf.layouts[i].accessibility.tagged` — `core/schema/pdf-layout.ts` (`PdfAccessibilityConfiguration`, `resolvePdfAccessibility`) | the author's choice for this layout |
| theme | `tagged` on a PDF theme — `render/pdf/pdf-theme.ts` | the default for every layout under that theme |
| default | `DEFAULT_PDF_ACCESSIBILITY` — tagged `true`, `displayDocTitle` `true` | |
| render call | `options.tagged` in the kernel's `PdfRenderOptions` — `render/pdf/pdf-abi.ts`, honoured in `kernel/render.ts` | a host overrides the document per render; the server-host request carries the same option ([ADR 0043](adr/0043-pdf-rendering-portable-kernel.md)) |

The render model resolves layout → theme → default (`pdf-render-model.ts`, look for
`taggedDeclared`) and the resulting `PdfDocument.accessibility` travels to the kernel. A layout
that says nothing inherits the theme; a layout that says `false` wins over a theme that says
`true`.

Whatever the flag, the kernel always writes the document language (`/Lang`, from
`accessibility.lang` or the render locale), the title (`/Title`, from the layout or the form),
the `DisplayDocTitle` viewer preference and `/Tabs /S` on every page. Untagged output is a plain
PDF with good metadata; tagged output adds the tree.

## Two halves: the engine decides roles, the kernel writes the tree

```
engine   buildPdfRenderModel()      →  PdfBlock { id, role?, alt?, artifact?, … }        render/pdf/pdf-document.ts
                                       roles chosen by the renditions and layout components
         ─────────────────────────── PdfRenderProvider ───────────────────────────
kernel   layout.ts                  →  Drawable { …, blockId?, artifact? }               every drawn piece remembers its block
kernel   writer.ts + tagging.ts     →  BDC … EMC around drawables, StructElem tree,
                                       ParentTree, /StructParents, /MarkInfo
```

The engine never touches PDF syntax; it only annotates its JSON document with `role`, `alt` and
`artifact` per block. The kernel never interprets the form; it maps blocks to structure elements
by id. The seam is the same `PdfDocument` everything else in the pipeline crosses, so tagging is
part of the byte-identical guarantee: the in-process and sandboxed providers write the same
tree, and two renders of the same document produce the same bytes (`kernel-tagging.test.ts`,
`pdf-release-gates.test.ts`).

## Roles: what each block becomes

`PdfBlockBase` carries three optional fields (`pdf-document.ts`): `role` (a `PdfStructureRole`),
`alt` (alternative text) and `artifact` (decoration a reader skips). A rendition or layout
component may set them; when `role` is absent the kernel picks a default from the block kind
(`tagging.ts`, `defaultRole`). The mapping:

| What the author placed | `PdfBlock.kind` | Structure role | Set by |
|---|---|---|---|
| a section with a label | `heading` + `group` | `H1`…`H6` for the label (level = nesting depth, capped at 6), then `Sect` around the content | `pdf-render-model.ts` `renderSection` |
| a section without a label, a box, a repeat row | `group` / `box` | `Div` | render model |
| text, a label/value pair, a single checkmark, a checklist | `paragraph`, `labelValue`, `checkmark`, `checklist` | `P` | render model / kernel default |
| a field (any widget) | `widget` | `Form`; the label text and the widget annotation live in the same element | kernel default |
| a bulleted or numbered list in rich text | `list` | `L`, with an `LI` per item holding an `Lbl` (the bullet) and an `LBody` (`collectList`) | `standard-renditions.ts` + kernel |
| a `pdf-table`, a collection table | `table` | `Table`, with `TR` rows and `TH` / `TD` cells synthesised by the kernel (`collectTable`); a borderless table without a header is `Div` | render model + kernel |
| the grid rendition's layout table | `table` | artifact — the cells' fields are content, the grid itself is not | `standard-renditions.ts` |
| an image | `image` | `Figure`, `/Alt` from the component's localized `alt` | `renderImage` |
| a rule, a spacer | `rule`, `spacer` | artifact | render model |
| anything in the header or footer slot | any | artifact, whatever it says about itself (`structureOf`) | kernel |
| an anchored box | `box` | `Div`, content like any other block | kernel |
| borders, fills, table rules | drawables `rect`, `line` | artifact | `writer.ts` |

Two consequences worth knowing. Artifact-ness inherits downward: a `P` inside an artifact
container is an artifact. And a block with no role and no kernel default (a `pageBreak`, a
kind the kernel does not know) is treated as an artifact rather than given a made-up role.

`PdfStructureRole` also allows `Span`, which no rendition sets (a checklist is a `P`, not a
list).

## How the tree is written

Follow `writePages` in `kernel/writer.ts` and the `Tagging` class in `kernel/tagging.ts`. When
the document is untagged, `tagging` is `undefined` and every `tagging?.` call below is a no-op:
no `BDC`, no tree, nothing else changes.

1. **Flatten the structure.** `structureOf(document)` walks the blocks once and builds
   `blockId → { role, parent, alt, artifact }`. Body blocks and anchored boxes hang off a
   synthetic document element; header and footer blocks are collected with `artifact: true`;
   table rows and cells get synthetic ids (`<tableId> r<n>c<m>`) so the cell's blocks can
   parent to them. This map is the whole plan; nothing about structure is decided later.

2. **Per page.** `beginPage` sets `/StructParents n` on the page (n = page index) and resets
   the MCID counter. The writer also sets `/Tabs /S` so widget tab order follows structure,
   which is reading order, which is drawing order.

3. **Per drawable.** Every drawable the layout produced remembers its `blockId` (and, for
   running regions, `artifact: true`). `markFor(page, blockId, isDecoration)` decides what
   the drawable belongs to:
   - a decoration (`rect`, `line`), a drawable flagged artifact, or a drawable of an artifact
     block → `/Artifact BMC`;
   - anything else → `/<Role> << /MCID n >> BDC`, where the role is the block's.

   Consecutive drawables of the same block share one sequence (one paragraph broken into
   lines is one `P … MCID`, not one per line); consecutive artifacts share one `/Artifact`
   sequence. When the block changes, or the page ends, `EMC` closes it. For each content
   MCID two records are kept: an `MCR` kid (`{ Type: MCR, Pg, MCID }`) on the block's element,
   and the element's reference at slot `n` of this page's parent array.

4. **Elements are created lazily.** `elementFor(blockId)` builds the `StructElem`
   (`{ Type: StructElem, S: role, P: parent, K: [], Alt? }`) the first time a block draws,
   creating its ancestors on the way up and pushing it onto its parent's `K`. So the tree
   contains exactly the blocks that put ink on a page: a section whose fields were all hidden
   leaves no empty `Sect`, and sibling order is drawing order.

5. **Widgets.** Before a widget is drawn the open content sequence is closed (an annotation is
   not page content). The annotation is placed, then `attachWidget` adds an `OBJR` kid
   (`{ Type: OBJR, Obj: <widget ref>, Pg }`) to the block's `Form` element and sets
   `/StructParent k` on the widget, with `k` counted from `100000` so widget keys never collide
   with page indices. The label text drawn just before is an `MCR` in the same element, which
   is how a reader pairs "Name" with the field.

6. **Finish.** After the last page, `finish()` writes the root:

   ```
   /StructTreeRoot << /K [ <Document element> ]
                      /ParentTree << /Nums [ 0 [ <elem for MCID 0> <elem for MCID 1> … ]
                                             1 [ … ]
                                             100000 <Form element of the first widget> … ] >>
                      /ParentTreeNextKey 100000 + <widget count> >>
   /MarkInfo << /Marked true >>
   ```

   `ParentTree` is the reverse index: given a page and an MCID, or a widget's `StructParent`,
   a reader finds the element. `/Marked true` is the flag viewers check before looking for a
   tree at all.

For the fixture in `packages/pdf-kernel/tests/kernel-tagging.test.ts` (a heading, a paragraph,
an image, a text field, a two-row table, a rule, a section, and a footer) the result is:

```
Document
├─ H1        ← MCR (MCID 0)          page stream:  /H1 << /MCID 0 >> BDC … EMC
├─ P         ← MCR (MCID 1)                        /P  << /MCID 1 >> BDC … EMC
├─ Figure    /Alt (Company logo)                   /Figure << /MCID 2 >> BDC … EMC
├─ Form      ← MCR (label "Name"), OBJR (widget /StructParent 100000)
├─ Table
│  ├─ TR ── TH ── P,  TH ── P
│  └─ TR ── TD ── P,  TD ── P                      (cell rules: /Artifact BMC … EMC)
└─ Sect ── P
                                                   rule + footer: /Artifact BMC … EMC
/ParentTreeNextKey 100001
```

## What a reader does with it

- **Acrobat / Reader** shows the tree under *View → Show/Hide → Navigation panes → Tags*; the
  order there is the reading order. Preflight's "PDF/UA" or "Tagged PDF" checks run against it
  and list the gaps below.
- **A screen reader** (NVDA or JAWS with Reader, VoiceOver with Preview) offers heading
  navigation from the `H` elements, announces table cells with their row and column position
  from `TR`/`TH`/`TD`, reads a `Figure`'s `/Alt`, and when focus lands on a field announces the
  text in the same `Form` element as its label. Header, footer, rules and borders are never
  read: they are artifacts.
- **Reflow and text extraction** follow the marked content order as well, which is why
  `extractText` in the tests returns body then footer, in flow order.

To inspect a file by hand, `qpdf --qdf --object-streams=disable in.pdf out.pdf` decompresses
the page streams so the `BDC`/`EMC` pairs are readable, and the catalog shows the
`/StructTreeRoot`. The repo's own assertions are in `kernel-tagging.test.ts`: roles at the top
level (`H1, P, Figure, Form, Table, Sect`), the table nesting, `/Alt`, the `MCR` + `OBJR` kids of
the `Form` element, `/StructParents 0`, the `BDC` operators with their MCIDs, and
`ParentTreeNextKey` = 100001 for one widget. The untagged case asserts the tree, `MarkInfo` and
`BDC` are all absent while `/Lang` and the title remain.

## Known gaps, and what is not claimed

The tree is enough for a reader to navigate a form; it is not a conformance claim. What it
leaves out:

- **No PDF/UA validation.** Nothing runs PAC or Acrobat Preflight against the tree; the tests
  check the tree the kernel meant to write, not that a standard accepts it. (PDF/A is
  validated: `packages/pdf-kernel/tests/verapdf.test.ts` runs veraPDF on every level the
  kernel declares, tagged and untagged.)
- **Level "a" is what ISO 19005 asks, not PDF/UA.** `conformance.pdfa: "2a"` / `"3a"` claims
  the document is tagged and every glyph maps to text; veraPDF checks that (a structure tree,
  `MarkInfo`, a valid `/Lang`, no Private Use Area glyph without replacement text). It does
  not check that the tree is *good* — heading order, table headers, alt text — which is what
  PDF/UA would ask. Under "a" the kernel tags whatever the layout's switch says (`pdfa.tagged`),
  replaces PUA characters with `?` (`font.privateUse`), and drops to the "u" level with
  `pdfa.level` where it cannot keep the promise (a language that is no tag, a flattened fill).
- **Template layouts are tagged only for what the fill adds.** `kernel/template.ts` fills an
  existing PDF and leaves its structure alone; the output has whatever tags the source had.
  Under level "a" (a template that declares `2a` / `3a`), `ExistingTagging` extends the
  template's own tree: each drawn area becomes a `P` element whose marked content takes the
  next MCID of the page's parent-tree entry (`StructParents` → `ParentTree` → `Nums`), each
  fillable area's widget a `Form` element with an `OBJR` under a fresh `StructParent` key,
  all appended to the document element (the root's first kid). A tree with a `ParentTree`
  that has `Kids` is not rebalanced: the fill declares "u" instead, and says so.
- **One language per document.** `PdfTextRun.lang` is declared on the model but the kernel
  only writes the document `/Lang`; no `/Lang` is put in a `BDC` property list.
- **Roles are not authorable.** Only an image's `alt` is exposed in the designer; there is no
  way to mark a block decorative, promote a `Div` to `Sect`, or set a heading level by hand.
- **Thin vocabulary.** Checklists are `P` rather than `L`/`LI`; no `Link`, `Caption`, `Note`
  or `Span`; tables carry no `Scope`, `Headers` or `Summary` attributes; sections are `Sect`
  with no `Part`/`Art`; no `RoleMap` (every role is standard, so none is needed).
- **Alt text is figures only.** Checkmarks, rules and other glyph-like marks carry no
  `/ActualText`.

## Where things are

| Concern | Location |
|---|---|
| the setting, its defaults and validation | `engine/form-engine/core/schema/pdf-layout.ts` (`PdfAccessibilityConfiguration`, `resolvePdfAccessibility`) |
| the designer fields | `engine/form-engine/render/pdf/pdf-components.ts` (`pdf-document` property editor) |
| layout → theme → default resolution | `engine/form-engine/render/pdf/pdf-render-model.ts`, `pdf-theme.ts` |
| roles chosen per block | `pdf-render-model.ts` (`renderSection`, `renderBox`, `renderRepeat`, `renderImage`), `standard-renditions.ts` |
| the block fields (`role`, `alt`, `artifact`) and the role vocabulary | `engine/form-engine/render/pdf/pdf-document.ts` |
| per-render override | `engine/form-engine/render/pdf/pdf-abi.ts` (`PdfRenderOptions.tagged`), `packages/pdf-kernel/src/kernel/render.ts` |
| drawables remembering their block; running regions as artifacts | `packages/pdf-kernel/src/kernel/layout.ts` |
| marked content, elements, parent tree, widgets, `MarkInfo` | `packages/pdf-kernel/src/kernel/tagging.ts`, driven from `writer.ts` (`writePages`) |
| `/Lang`, title, `DisplayDocTitle` | `writer.ts` (`writeMetadata`) |
| tests | `packages/pdf-kernel/tests/kernel-tagging.test.ts`; `engine/tests/pdf-layout-schema.test.ts`, `pdf-render-model.test.ts` for the setting |
