# PDF layout reference

Every setting a PDF layout has, as the definition stores it. The [PDF workspace](/builder-element#one-workspace-alone) in the builder writes all of it for you; read this page when you write a layout by hand, generate one, or want to know what a switch in the inspector does. How a layout is chosen, themes, fonts and the options of `renderPdf()` are on [PDFs](/pdf).

## Where layouts live

A form definition holds its layouts in a `pdf` block.

```json
{
  "pdf": {
    "defaultLayoutId": "record",
    "layouts": [
      { "id": "record", "kind": "generated", "name": "Applicant copy", "root": { "id": "document", "type": "pdf-document", "configuration": {}, "children": { "body": [] } } },
      { "id": "form-12", "kind": "template", "name": "Form 12", "when": "country = \"CA\"", "template": { "storage": "base64", "name": "form-12.pdf", "type": "application/pdf", "size": 48211, "data": "…" }, "fields": [] }
    ]
  }
}
```

| Key | Meaning |
|---|---|
| `defaultLayoutId` | The layout drawn when none is asked for and no `when` holds. Left out, the first layout. The builder writes it as soon as a layout has a `when`. |
| `layouts` | The layouts, in the order their conditions are tried. A layout that fails its checks (no id, no root, a template without a source) is left out of the list. |

Every layout has these keys.

| Key | Meaning |
|---|---|
| `id` | Required. Names the layout in `renderPdf({ layoutId })`, `defaultLayoutId` and the translations. |
| `kind` | `generated`, a tree of PDF blocks that is paginated, or `template`, an existing PDF that is filled. |
| `name` | What a picker calls the layout. A string in the form's default language, translated per locale. Left out, the id. |
| `when` | A condition over the answers. See [how a layout is chosen](/pdf#how-a-layout-is-chosen). Left out, the layout is drawn only when asked for by id, or as the default. |

A generated layout also has `root`, a `pdf-document` node whose slots `body`, `header` and `footer` hold the blocks below, and the document settings in the next section. A template layout has `template`, `fields`, `areas` and `options`, described under [Template layouts](#template-layouts).

## Document settings

These apply to the whole generated document. Write them on the layout, or on the `configuration` of its `pdf-document` root; the builder writes them on the root. A template layout takes `accessibility`, `conformance`, `attachments` and `signature` from the same keys.

| Setting | Values | Default |
|---|---|---|
| `page.size` | `Letter`, `A4`, `Legal`, or `{ "width": 600, "height": 800 }` in points (each at least 36) | The PDF theme's page, else `Letter` |
| `page.orientation` | `portrait`, `landscape` | The PDF theme's, else `portrait` |
| `page.margins` | `top`, `right`, `bottom`, `left`, in points, zero or more | The PDF theme's, side by side, else 54 each (three quarters of an inch) |
| `page.header.height`, `page.footer.height` | Points reserved on every page for the `header` and `footer` slots | None: no band |
| `accessibility.tagged` | Write a structure tree. See [Accessibility of the PDF](/pdf#accessibility-of-the-pdf) | The theme's `tagged`, else `true` |
| `accessibility.displayDocTitle` | Ask the viewer to show the title rather than the file name | `true` |
| `accessibility.lang` | A language tag for the document | The locale the PDF is drawn in |
| `accessibility.title` | The document title (translated) | The layout's `name`, else the form's title |
| `conformance.pdfa` | `2b`, `2u`, `2a`, `3b`, `3u`, `3a`. See [PDF/A](/pdf#pdf-a) | None, or the theme's |
| `conformance.outputIntent` | `profile` (an ICC profile), `identifier`, `info`, `registry` | sRGB IEC61966-2.1 |
| `conformance.attachData` | Embed the answers as a JSON file. Part 3 only | `false` |
| `conformance.attachment` | `name`, `description` of that file | `submission.json`, "Submission data" |
| `attachments.budgetMb` | Total size of uploaded files one document may embed, in MiB (1,048,576 bytes each) | 4 |
| `attachments.onExceeded` | `skip`, `fail` | `skip` |
| `signature` | How the document is sealed. See [Signing](/signing#the-server-signs) | None |
| `theme` | The id of a PDF theme. See [themes](/pdf#themes) | The host's, then the form's binding's, then `datum-pdf` |
| `renditionDefaults` | Type to rendition id, with `*` for every type. See [Renditions](#renditions) | None |
| `limits.pages`, `limits.answerChars` | The most pages a document may run to, and the most characters of one answer drawn | 200 and 20,000; held to 1,000 and 200,000 |

`limits` is read on generated layouts and has no field in the builder.

- A document that runs past `limits.pages` is refused with the `render_limit` failure.
- An answer past `limits.answerChars` is cut with a marker and a `render.truncated` warning, once per component.
- A larger value than the ceiling is held to it and warns `render.limitsCapped`.

### Output intent

PDF/A files declare the colour condition they were made for. The kernel carries three profiles, so a layout can name one without any file being fetched.

| Profile | `ref` in the envelope | Identifier it declares |
|---|---|---|
| sRGB, the default | `srgb` | `sRGB IEC61966-2.1` |
| Grey, gamma 2.2 | `gray` | `Gray gamma 2.2` |
| CMYK, SWOP-compatible | `cmyk` | `CGATS TR 001` |

```json
{ "conformance": { "pdfa": "2b", "outputIntent": { "profile": { "storage": "builtin", "ref": "cmyk", "name": "CGATS TR 001 compatible.icc", "type": "application/vnd.iccprofile", "size": 8464 } } } }
```

Any other profile is an ICC file in the same envelope: inline (`storage: "base64"` with `data`), or a storage the host resolves through its `pdfTemplates` resolver.

- `identifier` defaults to the profile's file name without its extension and `info` to the identifier.
- A profile the host cannot supply is dropped with `pdfa.outputIntent`, and the file declares sRGB.
- A Grey or CMYK profile is declared with an RGB default for what the kernel draws.
- A template keeps the output intent it already declares.

## Blocks

A generated layout is a tree. Each node has an `id`, a `type`, a `configuration` and, for containers, `children` keyed by slot. Twelve types exist; the root is one of them.

### pdf-document

The root. Slots `body` (the flow), `header` and `footer` (drawn on every page, inside the bands set by `page.header.height` and `page.footer.height`). Its settings are the [document settings](#document-settings). A `pdf-document` inside another is skipped with `layout.nestedDocument`.

### pdf-section

A heading with blocks under it. Slot `content`.

| Setting | Meaning | Default |
|---|---|---|
| `label` | The heading, translated | None |
| `hideLabel` | Draw the content without the heading | `false` |
| `keepTogether` | Move the whole section to the next page rather than split it | `false` |
| `skipWhenEmpty` | Leave the section out, heading included, when nothing in it prints | `false` |

### pdf-field

One of the form's components, placed on the page.

| Setting | Meaning | Default |
|---|---|---|
| `componentId` | The component to print. One the form does not have prints nothing and the designer says so | None |
| `rendition` | How it is drawn here. See [Renditions](#renditions) | The ladder below |
| `label` | A label to draw instead of the component's own | The component's label |
| `hideLabel` | Draw no label | `false` |
| `attach` | For a file upload: embed its files in the PDF. Set, it decides either way; left out, the component's own `pdf.attach` does | Left out |
| `widgetName` | The AcroForm field name, for the `field` rendition. Left out, the component's value path, prefixed inside a repeat by the collection path and row (`items[0].email`). A name set here is used as written, so leave it empty inside a repeat | Left out |

A checkboxes component drawn as `field` gets one widget per option, named after the field and the option. Names must be unique across the layout, signature blocks' `fieldName` included; a name a second component or block takes warns `layout.duplicateWidgetName`, and only the first is that field.

### pdf-text

A paragraph or heading of the layout's own.

| Setting | Meaning | Default |
|---|---|---|
| `text` | The words, translated, with placeholders. See [Placeholders](#placeholders) | None |
| `variant` | `body`, `h1`, `h2`, `h3`, `muted`, `label`. Hand-written layouts may also use `h4` to `h6` | `body` |
| `align` | `start`, `center`, `end` | `start` |
| `expression` | A computed value that replaces the text: a sum, a formula, answers joined together | None |

A text block that comes out empty is not drawn.

### pdf-table

Rows and columns of blocks. Each cell is a slot named `r1c1` for the top left, `r1c2` for the cell to its right, and so on.

| Setting | Meaning | Default |
|---|---|---|
| `rows` | 1 to 50 | 2 |
| `columns` | 1 to 12 | 2 |
| `header` | The first row is a header: bold, and repeated when the table continues on another page | `true` |
| `borders` | `all`, `horizontal` (between rows), `none` | `all` |
| `collectionPath` | The id of a repeating section or data grid. The first non-header row is drawn once per entry, with <code v-pre>{{row.fieldId}}</code> in its cells; the other rows are ignored | None: every row is drawn once |
| `widths` | Column widths as fractions of the table, one number per column. Hand-written layouts only | Equal |
| `skipWhenEmpty` | Leave the table out when no cell prints | `false` |

Shrinking a table moves what was in the removed cells into the last cell.

### pdf-repeat

A block drawn once per entry of a repeating section or data grid. Slot `row`.

| Setting | Meaning | Default |
|---|---|---|
| `collectionPath` | The id of the repeating section or data grid. A repeat naming none warns `repeat.unbound` | None |
| `emptyText` | Text to draw when there are no entries | Nothing |
| `keepRowTogether` | Keep each entry on one page | `false` |
| `maxRows` | Draw at most this many entries | All |

### pdf-box

A framed or filled area. Slot `content`.

| Setting | Meaning | Default |
|---|---|---|
| `border` | Draw a border | `true` |
| `borderWidth` | Points | The theme's box, 0.75 |
| `borderColor`, `fill` | A colour, such as `#1a4480` | The theme's border colour, and no fill |
| `padding` | Points inside the border | The theme's box, 6 |
| `radius` | Corner radius in points. Hand-written layouts only | The theme's box |
| `skipWhenEmpty` | Leave the box out, border and fill included, when nothing in it prints | `false` |
| `anchor` | Pins the box instead of flowing it: `page` (`first`, `last`, `every`, or a page number from 1), `x` and `y` in points from the page's left and top edges, `width` and `height` in points (both above zero) | Flows with the content |

A pinned box takes no room in the flow.

### pdf-rule and pdf-spacer

A rule is a horizontal line: `thickness` in points (at least 0.25, default 0.75) and `color`. A spacer is vertical space: `height` in points (at least 1, default 12).

### pdf-image

A logo or picture.

| Setting | Meaning | Default |
|---|---|---|
| `src` | A PNG or JPEG: a `data:image/png;base64,` or `data:image/jpeg;base64,` URL, which embeds the bytes in the layout, or an `http(s)`, protocol-relative, `/` or `./` URL the page fetches. Any other URL is refused with `image.unsafeUrl` | None: nothing is drawn |
| `alt` | Alternative text, translated. Empty marks the image as decorative | Empty |
| `width`, `height` | Points | Left out, the kernel sizes the picture |

A picture the page cannot fetch is left out with `image.unresolved`.

### pdf-signature

Where the document is signed.

| Setting | Meaning | Default |
|---|---|---|
| `fieldName` | The AcroForm signature field this block makes. Unique in the layout. The layout's `signature.field` names it for the server to sign into | The node's id |
| `label` | A caption printed above the box. <code v-pre>{{path}}</code> placeholders work as in a text block | None |
| `mode` | `field`, a real signature field signed by a server or in a viewer, or `line`, a ruled line to sign by hand | `field` |
| `width`, `height` | Points | The column's width, 40 |

### pdf-page-break

A new page from here. With `changePage` set, the `page` setting (`size`, `orientation`, and margins as in the document settings) applies from the new page on. What it leaves out stays the document's: a break that sets only `orientation` keeps the document's size, margins and header and footer bands.

## Renditions

A rendition is how a component appears on paper. Each component type offers some of the following.

| Id | What it draws | Offered by |
|---|---|---|
| `text` | The label and the answer as text. The filled-record look | Text-like fields (`text`, `email`, `tel`, `url`, `number`, `date`, `time`, `textarea`), choices, checkboxes, `file`, `html`; the default for all of those except the ones below |
| `field` | An AcroForm widget carrying the answer, fillable in a viewer. A choice becomes a dropdown, list or radio group; a checkboxes component one box per option; a file upload a text widget listing the file names | The same types, and `signature` |
| `ruled` | The label and blank lines to write on. The print-and-fill-by-hand look | Text-like fields and choices |
| `checkmark` | A box ticked when true | `checkbox`, `boolean`. The default |
| `checklist` | Every option as a box or circle, the chosen ones marked | `select`, `multiselect`, `radio`, `checkboxes`. The default for `checkboxes` |
| `image` | The picture itself | `image`; `file` and `signature` when the answer carries PNG or JPEG bytes. The default for `image` |
| `line` | A signature line | `signature`. The default |
| `none` | Nothing | `button`. The default; not offered in the picker |
| `group` | The children, no heading | Every container. The default for `form`, `container`, `panel`, `button-group` |
| `section` | A heading, then the children | `fieldset`, `step` (the default), and the other containers |
| `sections` | One section per tab or entry | `tabs` (the default) and anything bound to a collection |
| `table` | One column per cell or field, one row per entry | `grid`, `row`, `columns`, `table` and anything bound to a collection (the default). A data grid whose layout is stacked defaults to `sections` |
| `panel` | A titled box around the children | `container`, `panel`, `fieldset`, `section`, `step` |

A type the engine does not know is drawn with the text rendition, or as a group when it has children, so every component prints something. A plugin may add renditions to its own types.

Which rendition a component takes is the first of these that names one the type offers:

1. The `rendition` on the `pdf-field` block.
2. The component's own `configuration.pdf.rendition`.
3. The layout's `renditionDefaults` entry for the component's type.
4. The layout's `renditionDefaults["*"]`.
5. The PDF theme's choice for the type, then for `*`. The default theme draws a radio as a `checklist`.
6. The type's own default, in the table above.

- A rendition named for a type that does not offer it is skipped with `rendition.unknown`.
- A `*` that does not fit the type, such as `field` on a container, is skipped quietly. So `"renditionDefaults": { "*": "field" }` turns a filled-record layout into a blank fillable one.

A form component carries its own PDF settings in `configuration.pdf`.

| Key | Meaning |
|---|---|
| `rendition` | The rendition this component takes unless a layout says otherwise |
| `exclude` | Leave the component out of every PDF |
| `attach` | For a file upload: embed its files in the PDF. See [Attachments](/pdf#attachments) |

## Placeholders

Text in a layout, a signature caption, a template mapping and a template area can write answers into itself with double braces.

| Placeholder | Reads |
|---|---|
| <code v-pre>{{fieldId}}</code> | The answer of a component, as printed: an option's label rather than its value, the names of uploaded files |
| <code v-pre>{{row.fieldId}}</code> | The same inside a repeat or a table bound to a collection |
| <code v-pre>{{ancestor.fieldId}}</code> | A field of the enclosing entry, in nested repeats |
| <code v-pre>{{host.key}}</code> | A value from the host context the call supplied |
| <code v-pre>{{rowNumber}}</code>, <code v-pre>{{rowIndex}}</code>, <code v-pre>{{rowCount}}</code> | Inside a repeat: the entry's number from 1, its index from 0, the number of entries |
| <code v-pre>{{page}}</code>, <code v-pre>{{pages}}</code> | The page number and the page count, in a header or footer |

A placeholder that finds no answer prints nothing. The Variables panel on the builder's strip lists every placeholder a layout can use.

## Template layouts

A template layout fills an existing PDF with the form's answers. The PDF can be a fillable form, in which case its fields are mapped, or a flat page, in which case areas draw the answers onto it.

| Key | Meaning |
|---|---|
| `template` | Where the PDF is: `storage`, `name`, `type`, `size`, and for `base64` storage the file as `data`. Any other `storage` names a kind the host resolves through its `pdfTemplates` resolver, with `ref` for whatever the host needs to find it |
| `fields` | One mapping per AcroForm field. Empty when the PDF has none |
| `areas` | Rectangles on the pages that answers are drawn into |
| `options` | Fill options |
| `accessibility`, `conformance`, `attachments`, `signature`, `when`, `name` | As for a generated layout |

### Mappings

```json
{
  "pdfField": "topmostSubform[0].Page1[0].Province[0]",
  "source": { "kind": "component", "componentId": "province" },
  "values": { "ON": "1", "BC": "2" }
}
```

`pdfField` is the field's fully qualified name. Every mapping has a `source` and may have `checkedValue`, `values` and `format`.

| Source kind | Reads |
|---|---|
| `component`, with `componentId` | The answer of one component, as the PDF field expects it: text for a text field, the stored option value for a choice, a tick for a checkbox. A component hidden by a rule fills blank. A repeating section or data grid has no single value: it fills blank with `mapping.collection`, so map each cell with a `path` source |
| `path`, with `path` | A value by its path in the submitted values, such as `items[0].sku` |
| `template`, with `text` | Text with placeholders, translated per locale |
| `expression`, with `expression` | A formula. One that cannot be read fills blank with `formula.invalid` |
| `literal`, with `value` | A fixed string, number, boolean or `null` |

A source of any other kind is skipped with `mapping.unknownSource`, a component the form lacks with `mapping.unresolved`. One bad mapping never stops the others.

**`checkedValue`** is the value that means on, for a checkbox or a radio group.

- When the answer is on, the field takes the checked value itself: a checkbox is ticked, the radio option of that name is selected.
- A ticked checkbox answer is on; any other answer is on when it is or contains the checked value.
- When off, the box is unticked or the group cleared.

**`values`** turns answers into what the PDF stores. Many forms store radio options as `1`, `2`, `3` while the page shows words.

- Keys are answers as text; a boolean is keyed `true` or `false`.
- The map applies first, before `checkedValue` compares and before `format` shapes.
- An answer with no key passes through unchanged and warns `mapping.unmappedValue`.
- A `checkboxes` answer is translated key by key.

**`format`** shapes the value after that.

| Format | `pattern` | Result |
|---|---|---|
| `text` | None | The value as it is |
| `date` | None | The value as it is: dates are written in ISO form, `2026-11-14` |
| `number` | The number of decimals, 0 to 20 | `1250` with pattern `2` is `1250.00`. A value that is not a number is left as it is, and an empty one stays empty |
| `boolean` | Two words joined with a vertical bar, such as `Oui` and `Non` | The first when the answer is on, the second when it is off. Left out, the PDF theme's yes and no |

### Areas

An area draws an answer into a rectangle on a page, for a PDF with no form fields: a scanned or hand-laid form. An area has the same `source`, `checkedValue`, `values` and `format` as a mapping.

| Key | Meaning | Default |
|---|---|---|
| `id` | Unique among the layout's areas | Required |
| `label` | What the designer calls the area | The id |
| `page` | A page number from 1 | Required |
| `rect` | `x`, `y`, `width`, `height` in points from the page's left and top edges. Width and height above zero | Required |
| `draw.kind` | `text` for wrapped text, `check` for a tick when the value means checked | `text` |
| `draw.fontSize` | Points, at least 1 | 10 |
| `draw.align` | `start`, `center`, `end` | `start` |
| `draw.valign` | `top`, `middle`, `bottom` | `top` |
| `draw.padding` | Points between the box and the text | 2 |
| `draw.wrap` | Wrap long text. Off, one line clipped at the box's edge | `true` |
| `draw.bold` | Bold text | `false` |
| `draw.color` | `#rrggbb` | The theme's text colour |
| `field` | Makes the area a transparent AcroForm widget instead of page content, so the PDF becomes fillable where the paper had a blank. `name`, `required`, `readOnly`, `tooltip` | Not a field |

When an area is a field:

- Its `name` is kept as typed, and two areas that type one name share one field.
- Without a name it is the area's label made usable (periods become spaces, because a period would start a path of fields), else its id, made unique among the areas (`Date`, `Date_2`).
- The tooltip defaults to the label.
- A widget carries size, alignment, bold, colour and wrapping from `draw`; `valign` and `padding` do not carry over, since viewers place a field's text themselves.

Each area is reported as one of:

- `filled`.
- `empty`: nothing to draw.
- `overflow`: the text was clipped; warns `area.overflow`.
- `missing`: the PDF has no such page; warns `area.page`.
- `unsupported`.

### Fill options

| Option | Meaning | Default |
|---|---|---|
| `flatten` | Burn the values into the page and drop the fields | `false` |
| `readOnly` | Keep the fields, and lock the ones the layout fills. A fillable area locks only when it has an answer | `false` |
| `appearances` | `regenerate`: the kernel draws each field's appearance so every viewer shows the same. `viewer`: leave it to the viewer, which keeps the template's own look for scripts and fonts the kernel cannot reproduce | `regenerate` |

- Under PDF/A the appearances are always regenerated, and `viewer` warns `pdfa.appearances`.
- A form that cannot be flattened warns `template.flatten`.
- A value longer than a field's maximum length is clamped to it and warns `field.overflow`.

### What a template can be

- **Encrypted templates.**
  - A PDF encrypted only with an owner password, which needs no password to open, is read decrypted and the filled file is written unencrypted, with `template.decrypted`. The owner's restrictions are not carried over.
  - When the owner's permissions forbid filling, the fill is refused with the `template` failure.
  - When they forbid modifying and the fill flattens or draws areas, it goes ahead and warns `template.permissions`.
  - A PDF that needs a password to open, or uses another security handler, is refused with the `template` failure: supply an unencrypted copy.
  - An encrypted template under PDF/A is refused with the `conformance` failure.
- **XFA forms.** The XFA part is removed and the AcroForm fields fill, with `template.xfa_removed`. A form that has only XFA content has no fields to fill.
- **PDF/A templates.** A template that declares a PDF/A level stays PDF/A through the fill. Asking a template that declares none for a PDF/A level warns `pdfa.template` and the file claims none.
- **Widgets.** Duplicate widgets and widgets with no page, as some PDF re-savers leave behind, are re-linked to their page with `template.widgets_relinked`, or reported with `template.widgets_detached` when they cannot be placed.

The designer lists at most 500 pages and 5,000 fields of a template and warns `template.truncated` past that.
