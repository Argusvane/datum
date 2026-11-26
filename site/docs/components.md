# Components

A form is a tree of components. Each one has a type name, written as `type` in the definition, and a `configuration` object for its settings. The builder's palette offers the types below. A person fills in the fields, reads the display types, presses the actions, and the containers arrange the rest.

```json
{ "id": "email", "type": "text", "configuration": { "label": "Email", "maxLength": 80, "characterCount": true } }
```

Every component also carries:

- an id
- optional CSS classes
- `rules` that show, require or calculate it (see [Rules and formulas](/formulas))

## Fields

| Palette name | Type | What it is | Notable settings |
|---|---|---|---|
| Text | `text` | One line of free text. | `placeholder`, `pattern` with its own message, `minLength`, `maxLength`, `characterCount` (shows the count against `maxLength`), `prefix` and `suffix`, `autocomplete`, `inputmode`. |
| Text area | `textarea` | Several lines of text. | `rows`, plus the text settings above except `prefix` and `suffix`. |
| Number | `number` | A quantity or an amount. The value stays a number in the record and in formulas. | `min` and `max` (inclusive; see below), `placeholder`, `prefix` and `suffix` for a currency sign or a unit, `autocomplete`, `inputmode`. |
| Date | `date` | A calendar day, kept as `YYYY-MM-DD`. | `min` and `max` as `YYYY-MM-DD` (inclusive; see below), `autocomplete`. A design-system binding may draw it as month, day and year parts. |
| Checkbox | `checkbox` | One yes-or-no answer. | Required means ticked. |
| File upload | `file` | A document or image from the person's device. | `accept`, `maxFileSizeMb` per file, `multiple`, `storage`, and whether the files ride into a PDF as attachments. |

### Settings every field takes

These are keys of the component's `configuration`. The inspector offers the ones that apply to the type.

| Key | Type | Default | Effect |
|---|---|---|---|
| `label` | text | none | The label. A new field starts as "Untitled field". |
| `description` | text | none | Help text under the label. |
| `tooltip` | text | none | Short help on hover and focus. |
| `placeholder` | text | none | Ghost text in an empty box. Text, text area, number and select. |
| `required` | yes or no | off | The field must have an answer. For a checkbox, ticked. |
| `hideLabel` | yes or no | off | Hides the label visually. It stays the field's accessible name. |
| `disabled` | yes or no | off | Always disabled. A rule's `enabledWhen` does it conditionally. |
| `minLength`, `maxLength` | number | none | Fewest and most characters of text and text area. A character is a code point, so an emoji counts one. A minimum above the maximum is ignored. |
| `characterCount` | yes or no | off | Shows the characters left. Needs `maxLength`. |
| `pattern`, `patternMessage` | text | none | A regular expression the whole answer must match, and the message when it does not. |
| `rows` | number | 4 | Lines a text area opens with. |
| `prefix`, `suffix` | text | none | Text before and after the box of a text or number field. Decorative: say the unit in the label too. |
| `autocomplete` | text | none | An HTML autocomplete token (`name`, `email`, `bday-day`, `off`). |
| `inputmode` | text | none | The phone keyboard: `numeric`, `decimal`, `tel`, `email`, `url`, `search`, `text` or `none`. |
| `spellcheck` | `"true"` or `"false"` | browser's | Whether the browser spell-checks the box. |
| `cssClass` | text | none | Space-separated classes added to the component's element. |
| `messages` | object | none | The field's own wording per validation code: `{ "required": "Enter your email." }`. |
| `dataKey` | text | the id | The name the answer is stored under (see [Data model and data sources](/data)). |
| `hiddenValueBehavior` | `exclude-from-submission`, `retain`, `clear` | `exclude-from-submission` | What is sent for the answer while the field is hidden: nothing, the answer, or no answer (see [Answers of hidden fields](/data#answers-of-hidden-fields)). |
| `pdf.rendition`, `pdf.exclude`, `pdf.attach` | text, yes or no, yes or no | theme's choice, off, off | How the field appears in a PDF, whether it is left out, and for a file field whether its uploads ride in as attachments. |
| `print.on`, `print.show`, `print.note` | `screen` or `paper`; `always` or `answered`; text | on screen and paper, as on screen | Where the field is drawn, how it prints from the live form while a rule hides it, and the note printed beside it. Page breaks too: see [Print](/print#what-each-component-does-on-paper). |

A rule can also set a field's visibility, requiredness, enabled state and read-only state; see [Rules and formulas](/formulas).

### Number and date bounds

`min` and `max` on a `number` or `date` component are inclusive.

- A number's are numbers (or numerals as text); a date's are `YYYY-MM-DD`.
- A bound that is not readable is ignored, and if `min` is above `max` both are ignored.
- The browser and the sandbox check them and raise these codes:

| Code | When |
|---|---|
| `number.min`, `number.max` | The number is below `min` or above `max`. |
| `date.min`, `date.max` | The date is before `min` or after `max`. |

```json
{ "id": "age", "type": "number", "configuration": { "label": "Age", "min": 0, "max": 120 } }
```

### When errors appear

The form's `validateOn` setting, on the root's `configuration`, says when a field is checked as its answer is committed. It takes two values:

- **`commitAfterError`** (the default) never checks a field on its first blur. Once the field shows an error, or the person has tried to go on, it is checked again on each commit.
- **`submit`** judges answers only when the person tries to go on.

### File upload storage

`storage` names where a picked file's bytes go. The built-in kind is `base64`: the bytes travel inside the form's values, so a submission is self-contained.

- An answer is an object `{ "storage": "base64", "name": "cv.pdf", "type": "application/pdf", "size": 48213, "data": "JVBERi0..." }`, and a list of them when `multiple` is on.
- `accept` takes extensions, `type/*` or full MIME types, separated by commas.
- `maxFileSizeMb` is per file; left out, zero or unreadable means no limit.
- The browser and the sandbox both enforce `accept` and the size.
- A host that keeps files elsewhere supplies its own storage kind under another name, and the same field moves to it by changing that one setting.

## Choices

| Palette name | Type | What it is | Notable settings |
|---|---|---|---|
| Select | `select` | One choice in a drop-down. | `options`, or a data source. |
| Radio | `radio` | One choice from a few, all visible, in a fieldset with a legend. | The same. |
| Checkboxes | `checkboxes` | Several choices. Stored as one object of booleans keyed by option. | The same. |

A new choice field starts with two options. Each option has a `value` (what is stored), a `label` and an optional `description`. A field that names a source in `data.sourceId` takes its options from it instead; see [Data model and data sources](/data#options-inline-or-from-a-source).

## Containers

| Palette name | Type | What it does |
|---|---|---|
| Fieldset | `fieldset` | A titled group of related fields with one legend. `legendMark` can mark the legend required or optional. |
| Panel | `panel` | A framed section with a heading. |
| Grid | `grid` | Fields side by side. `columns` is a count (default 2, at most 12) or widths on a 12-track row. Every other container stacks its children one per row. |
| Tabs | `tabs` | Long forms split into named tabs, one entry in `tabs` each. The tab holding the first error opens on submit. |
| Steps | `steps` | A multi-step form: `step` children shown one at a time, with a step indicator, Back and Continue. Rules can gate moving between steps. |
| Step | `step` | One page of a `steps` container. It belongs inside `steps`. |
| Container | `container` | A group whose id becomes a level in the data: `email` inside `applicant` is stored as `applicant.email`. `scopeData` set to false switches the nesting off. |
| Data grid | `dataGrid` | A repeating section: the fields inside it are the columns of one row, and the person adds, removes and reorders rows. |
| Button group | `button-group` | Buttons laid out together in a row. It holds buttons only and adds nothing to the data. |

Fieldsets, panels, grids, tabs, steps and button groups are for layout and add no level to the data. Tabs, steps and panels differ in what the person sees:

- **Tabs** let them move freely between sections.
- **Steps** walk them through in order.
- **A panel** is a frame that is always open.

### Children by container

A component's `children` is an object of named slots, each a list of components. The names depend on the container.

| Container | Slots |
|---|---|
| `form`, `fieldset`, `panel`, `container`, `step`, `dataGrid` | One slot, `content`. For a data grid it holds the fields of one row. |
| `grid` | `column_1` to `column_N`, one per column. |
| `tabs` | One slot per tab, named by the tab's `id`. |
| `steps` | `content`, holding `step` components only. |
| `button-group` | `content`, holding buttons only. |

A grid's `columns` is a count (`3`, equal columns) or widths out of 12 tracks: `"8/4"`, `"3 / 6 / 3"` or `[8, 4]`.

- Equal widths read as equal columns.
- More than 12 columns are cut.
- A value that cannot be read falls back to two equal columns.

```json
{ "id": "name_row", "type": "grid", "configuration": { "columns": "8/4" },
  "children": { "column_1": [{ "id": "street", "type": "text", "configuration": { "label": "Street" } }],
                "column_2": [{ "id": "unit", "type": "text", "configuration": { "label": "Unit" } }] } }
```

Tabs are `"tabs": [{ "id": "tab_1", "label": "First" }, { "id": "tab_2", "label": "Second" }]` in the configuration, with a slot of the same id for each. The builder's inspector edits the first two tab labels only; add a third in the JSON tab by writing its entry and its slot.

### Data grid settings

| Setting | Meaning |
|---|---|
| `layout` | `auto` (a table where the form is wide enough, stacked rows where it is not), `table` or `stacked`. |
| `minRows`, `maxRows` | Fixed bounds. `minRows` defaults to 0; a `maxRows` below `minRows` reads as `minRows`. A grid with no `maxRows` holds at most 500 rows. A formula under `rules.minRows` or `rules.maxRows` can work either out from other answers. |
| `initialRows` | Empty rows the form opens with when the grid has no entries yet. Default 1, held between `minRows` and `maxRows`. |
| `canAdd`, `canRemove`, `canReorder` | Which row buttons exist. Add and remove default to on, reorder to off. |
| `showHeader`, `showRowNumbers`, `rowLabel` | The column headings, the row numbers, and the row heading (`Applicant {{n}}`). |
| `addLabel`, `removeLabel`, `emptyText` | The words on the buttons and the empty state. |

## Display

| Palette name | Type | What it is | Notable settings |
|---|---|---|---|
| HTML | `html` | Instructions, a consent notice or a heading between sections. | `tag` (`div`, `section`, `article`, `aside`, `p`, `span`, `h1` to `h6`, `blockquote` or `pre`; anything else reads as `div`) and `content`, localised and sanitised on every render: scripts, styles and event handlers are stripped, and a link or image address must be relative, `http`, `https` (or `mailto` and `tel` for a link), or an image `data:` URL. |
| Image | `image` | A picture: a logo or a diagram. | `src` (an `http(s)` URL, a relative path or a small `data:image` URL), localised `alt` (empty means decorative), `width`, `height`. |

## Actions

| Palette name | Type | What it does | Notable settings |
|---|---|---|---|
| Button | `button` | Acts on the form when pressed. | `action`, `variant`, `size`, `signature`. |

A button's `action` is one of:

| Action | Does |
|---|---|
| `submit` | Validates and, when accepted, raises `datum-submit` with the canonical submission. |
| `download` | Submits, then hands the person the canonical submission as a JSON file. A rejected submit downloads nothing. |
| `pdf` | Checks the answers as Submit does, then draws the form as a PDF through the page's PDF module and hands over the file. It does not submit. An error stops it and shows the summary; warnings and notes do not. See [PDFs](/pdf). |

`variant` is one of `primary`, `start`, `secondary`, `success`, `danger`, `warning`, `info`, `light`, `dark` or `link`, and `size` one of `sm`, `md` or `lg`. The theme decides what each looks like. `signature: "webauthn"` on a submit button has the person's passkey or security key sign the submission (see [Validation and the sandbox](/validation#signed-submissions)).

## In PDF layouts

A PDF layout has its own palette: form field, text, image, signature, section, table, repeat, box, rule, spacer and page break. The signature block is the type `pdf-signature`: a real signature field the server or a viewer signs into, or a line to sign by hand. [PDFs](/pdf) covers layouts.

## Adding types and limiting the palette

The builder's palette holds the standard types plus anything a host adds. There are two routes:

- **`plugins.register(plugin)`** is the way to add types: it reaches every form and builder on the page and carries each type's palette entry.
- **`componentDefinitions`** on one element and the builder's **`componentTypes`** are shorter routes for one element. `componentTypes` holds palette entries only; a type from `componentDefinitions` needs one to appear on the palette.

[Components of your own](/custom-components) covers what a definition holds and has a live example.

A type that is not one of the standard types needs a `base`, the standard type it reads as (a `gcds-date` reads as `date`).

- The builder writes it into the saved definition's `kinds` map, so validation and the PDF read the type correctly without the plugin's code.
- A type with no definition and no renderer shows a note naming it.

`component-types` on `<datum-form-builder>` restricts the palette. It takes a list of types separated by spaces or commas.

- A bare name keeps a type.
- A leading `-` drops one.
- A trailing `*` matches a prefix.
- Exclusions win.

```html
<datum-form-builder component-types="text select radio checkboxes button"></datum-form-builder>
<datum-form-builder component-types="-acme-* -image"></datum-form-builder>
```

Icons come from an icon set. The builder draws its own, and `@argusvane/datum-icons-fontawesome` registers Font Awesome Free solid glyphs as inline SVG when a page loads `datum-icons-fontawesome.js` before `datum-builder.js`.
