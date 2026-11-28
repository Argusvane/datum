# Data Model

What data a form's answers make up, how a component decides where its answer is stored, and
how the builder's Data workspace shows that shape and builds a form from a JSON sample or a
JSON Schema. The design decisions are recorded in
[ADR 0109](adr/0109-data-keys.md) (data keys) and
[ADR 0110](adr/0110-the-data-model.md) (the data model).

This guide is written for form authors (sections 1 and 3), host developers (sections 2 and 4)
and anyone generating forms programmatically (section 5).

---

## 1. Where an answer is stored

Every component that holds an answer stores it at a **value path**:

- its own segment, which is its **data key** if it has one, otherwise its **id**;
- prefixed by the segment of every data-scoping `container` above it.

| Form | Value path |
|---|---|
| a text field `email` at the top | `email` |
| a field `email` inside a container `applicant` | `applicant.email` |
| a field `billing_street` with data key `street` inside a container with data key `billing` | `billing.street` |
| a `fieldset`, `panel`, `grid`, `tabs`, `steps`, `button-group` or `dataGrid` around a field | adds nothing (a data grid's rows are a collection, below) |
| a container with *Nest data under this id* turned off | adds nothing |

The **id** stays what everything else uses: a rule's `visibleWhen`, an error, the builder's
selection, the input's DOM id. Ids are unique across the form. The data key is what lets two
components store under the same name in two different objects, which ids alone cannot:
`shipping.street` and `billing.street` can both exist, held by components with the ids
`street` and `billing_street`.

A rule written as a formula (`country = "CA" and age(dateOfBirth) >= 18`, see
[formulas.md](formulas.md)) names a component by the same path an answer is stored under, so a
formula reads `applicant.email` where the form stores it there. A repeating section's entries
are read with the `row.` prefix from inside the entry, and a whole column with
`pluck(items, "amount")`. The Data workspace and the JSON Schema it exports are unaffected by
how a rule is stored: a rule is a string, a tree or `{ formula, run }`, and none of them changes
where an answer lives.

A data key uses letters, digits, `_` and `-`, and cannot be digits alone. The builder shows it
in the inspector's **Data** section, with the id as the placeholder, and a "Saves to" line under
the type that always shows where the answer is stored, even when the path is the id itself. It refuses a key, a rename, an add or a move
that would put two answers in one place.

The ID and the Saves to line each have a "?" in the inspector. The ID's note says the id is
unique across the form, containers included, and where the component's data goes relative to
it, worded for what the component stores: an answer, the answers nested inside a container, a
repeating section's entries, or nothing. The answer is stored under the id unless a data key,
a container that nests data or a repeating section moves it. The Saves to note says
how the path is made and what `[]` stands for. A PDF layout's components store no answers, so
on a layout's tab there is no Saves to line and the ID's note says so.

### What a checkbox stores

A lone `checkbox` stores `true` when it is ticked and `false` when it is not. Only `true` is a
tick: the live form, the printout, the PDF and validation all read every other value as
unticked, and `required` (on the browser and on the server) refuses it, so a required consent box
is met by `true` alone. A `checkboxes` group stores one boolean per option,
`{ "cat": true, "dog": false }`, and an option is picked only when its entry is `true`; anything
other than such a record (a list, a text) picks nothing.

`setValue`, `setValues`, `addRow`, `addRows` and `hydrateFromDraft` store these shapes when
given another spelling of them:

| Written | Stored |
|---|---|
| `"true"` on a checkbox | `true` |
| `"false"` on a checkbox | `false` |
| `["cat"]` on a checkboxes group with options `cat` and `dog` | `{ "cat": true, "dog": false }`: `true` for each value in the list (a number picks its text), `false` for each inline option it leaves out |

Any other value for a checkbox (`0`, `1`, `"yes"`) is neither refused nor guessed at: it is kept
as written, as a number box keeps text that is no number, and it reads as unticked everywhere.
A host that holds consent as `1` or `"yes"` turns it into `true` before writing it. An object or
a list for a lone checkbox is refused (`NonScalarAnswerError`, `value.notScalar`), as for every
field that holds one value. A list holding anything but text and numbers is kept as written on a
checkboxes group, and picks nothing.

### Repeating sections

A **repeating section** is not a component. It is the name for any container that carries a
`collection` binding, whatever its type: its entries are a list, and the form holds a list of
objects at that place in the data. The builder offers one kind, the data grid (next section).
A definition written by hand, by a host, or by an importer such as a form-builder converter
may bind any container type; `repeatingSection` is the conventional type name for a plain one,
and the engine treats it as an ordinary container. Every repeating section works the same way:
its entries live at its **collection path** as written (`collection.collectionPath`, else its
id), whatever container sits above it. A field inside an entry is keyed by its data key (else
its id): `items[0].sku`. A data-scoping container inside an entry adds its level:
`items[0].address.city`.

The browser form fills every repeating section (ADR 0153): each entry is drawn as a row with
the section's fields in it, with Add and Remove buttons (Move up and Move down when the
section's `collection.operations` allows reordering). A data grid chooses its layout; any other
repeating section is drawn in the grid's stacked layout. A section that sets no
`collection.operations` offers add and remove, not reorder. The runtime's row API (`addRow`,
`removeRow`, `reorderRow`, `setValue` with an indexed path), PDFs and a host's own code read
and write the same entries.

### Data grids

A **data grid** (`dataGrid`, ADR 0153) is the repeating section the builder offers, as "Data
grid" on the palette. The fields dropped into it are the columns of one row; its rows are the
entries. It is a collection-bound container like any other: its collection path follows its id
(a rename carries it along, as for any repeating section, ADR 0109), and the inspector shows it
under "Saves to".
Its Rows section sets the settings below. They live in the grid's `configuration`, and every one is
optional:

| Setting | Default | What it does |
| --- | --- | --- |
| `layout` | `auto` | `table`, `stacked`, or `auto` (the table where the grid is wide enough, stacked below the width its column count needs: 40rem up to four columns, then 45, 54, 63 and 72rem for 5, 6, 7 and 8 or more, measured on the grid's own width). |
| `showHeader` | on | The column headings row. Off, the headings are not drawn and the cells' own labels do the naming. |
| `showRowNumbers` | on | Each row's "Row n" heading. Off, no row header cell is drawn, and the row's name is a visually hidden span in its first cell, still naming the row's buttons for assistive technology. |
| `canAdd`, `canRemove` | on | The Add button and each row's Remove button. |
| `canReorder` | off | Each row's Move up and Move down buttons. |
| `minRows` | 0 | The fewest rows a submission may carry. |
| `maxRows` | none | The most rows a submission may carry. With none set, a grid holds at most 500 rows. |
| `initialRows` | 1 | The rows the form opens with when the grid has no entries yet. |
| `addLabel`, `removeLabel`, `emptyText` | form texts | Translatable captions of the Add button, each Remove button and the empty grid; each falls back to a form text. |
| `rowLabel` | "Row {{n}}" | Each row's heading and its "Row n: Label" entry in the error summary; `{{n}}` is the row's number (a heading such as "Applicant {{n}}" may be given). |

The minimum and maximum may also be formulas under `rules.minRows` / `rules.maxRows` that read the form
and not a row. `dataGridSettingsOf` applies the defaults and clamps what an author typed: a bound below 0
or not a number reads as its default, one above 500 reads as 500, `maxRows` below `minRows` reads as
`minRows`, and `initialRows` is kept within the bounds. The 500-row cap is
`DATA_GRID_ROWS_CAP`: a grid with no `maxRows` is held to it in the browser, the kernel and the field
constraints alike, so a client cannot post more rows than a person could add, and a hidden grid with no
`maxRows` is held to the same cap in the kernel.

A grid's `collection.operations` is derived from the settings above (`rowOperationsOf`) and never
authored. For any other collection-bound container it is read as written, and an absent flag defaults to
add and remove on, reorder off: a host calling `reorderRow` on such a section must set the flag.

A grid with one field is a one-column grid; its rows are still objects.

**What the browser draws.** A `<fieldset class="datum-form__group datum-form__datagrid"
data-layout="...">` with its legend and description, holding a scroll region (`part="datagrid-scroll"`,
`overflow-x: auto`) around a table (`part="datagrid-table"`). Every element carries a part, the host's
`::part` seams: `datagrid` (the fieldset), `datagrid-scroll`, `datagrid-table`, `datagrid-head`,
`datagrid-row`, `datagrid-rownum`, `datagrid-cell`, `datagrid-actions`, `datagrid-action` (each row button),
`datagrid-add` and `datagrid-empty`. The table has a heading row with one `<th scope="col">` per template field (its label and
required mark) and an actions column when a row operation is offered. Each entry is a `<tr>`: a
`<th scope="row">` with the row number, one cell per field holding that field rendered at
`collectionPath[i].rowKey` as it renders anywhere else (ids made unique per row; its label stays in the
cell, visually hidden under the table layout), and an actions cell with Remove, Move up and Move down as
the settings allow. An Add button follows the table, and an empty grid shows `emptyText` in a `<p part="datagrid-empty">` in place of the
scroll region and table. Buttons at a bound are disabled: Add at `maxRows`, Remove at `minRows`, Move up on the first row,
Move down on the last. Each row's buttons carry `aria-describedby` pointing at the row's name (the
row-number header cell, or the visually hidden `datum-form__datagrid-rowname` span). The stacked layout is
the same DOM restyled; under `auto` a container query switches to it below the width of the layout row above, and a collection-bound
container that is not a grid is drawn the same way in the stacked layout. The captions are the form texts
listed in [translation-support.md](translation-support.md) ("Data grids").

A submission carries a collection-bound container's entries as **one list at the collection
path**, a row the person left empty included as `{}`, so the server counts the rows the person
saw:

```json
{ "items": [{ "sku": "A-1" }, {}] }
```

The kernel flattens the list to the canonical keys (`items[0].sku`), so a host reads the
row cells at those paths. An empty grid posts an empty list. The row count is checked as `rows.min` and
`rows.max` against the grid, at its collection path.

---

## 2. The flat map and the nested document

The runtime's state and a submission's `values` are a **flat map keyed by value path**:

```json
{ "fullName": "Ada", "billing.street": "1 Main St", "items[0].sku": "A-1" }
```

That map describes a nested document, which is what the Data workspace, its JSON Schema and
its example show, and what is rebuilt from the map:

```json
{ "fullName": "Ada", "billing": { "street": "1 Main St" }, "items": [{ "sku": "A-1" }] }
```

To validate a submission against a JSON Schema exported from the Data workspace, nest the map first:
split each key on `.`, and read `[n]` as a list index.

---

## 3. The Data workspace

**Data** is a workspace of the builder (ADR 0127), drawn where the canvas is. It shows the
form's own model in three views:

- as a **table**: one row per answer the form stores, with where it is saved (`business.legal_name`,
  `owners[].name`), its kind in words ("Text, 2 to 120 characters", "One of 3", "Date", "Text,
  repeating") and whether it is required: Yes, No, "When Number of employees > 0" while a rule
  says so (ADR 0120), or "—" for a calculated answer. A checkboxes group is one row, and a
  repeating section's fields are rows inside its entries. Marks beside a row say it is shown by
  a rule (its own or its container's), is calculated, or has a data-key warning. Chips narrow the
  rows by step, and a menu by a journey's page, grouped by journey: a page takes in every answer
  inside a component it draws.
- as a **JSON Schema** (draft 2020-12), with a Copy button. Objects are closed with
  `additionalProperties: false`, because the sandbox strips keys the form does not define, and a
  file is `$defs/attachment`; a schema exported and read back in compares as the same model.
- as an **example** document, with a Copy button.

Selecting a row opens the answer's storage settings, which edit the selection's draft as the
inspector does (Apply is one undo step, refused while a check holds it back; Discard drops the
draft; leaving Data or choosing another row asks first). They show the answer's name, type and
step; its Data key where the type offers one, with a problem under it for an unusable key or an
answer two places would share; "Saves to", following the draft live; what happens to the answer
while a rule hides it (left out of the submission, which is the default; sent empty; or kept and
sent); whether generated PDF layouts carry it; and what the server checks, in words.

**Import…** opens a dialog that reads a JSON sample or a JSON Schema, pasted or opened from a file (*Open file…*; *Clear* empties the box). *Read as* is
*Auto* (which says what it detected), *Sample* or *JSON Schema*. A JSON syntax error is shown
under the box with its line and column. Then each place of the incoming model is marked:

| Mark | Meaning |
|---|---|
| **New** | The form has nothing there. |
| **On the form** | The form holds it, in a kind that can hold what comes in. |
| **Held as …** | The form holds something else there; what is below it is not compared. |
| **≈ approximate** | A component can hold it in a nearby shape, which the row's note explains. |
| **Not built** | No component can hold it; the note says why. |

The form's own places the model does not name are listed under *On the form only*.

- **Build form** appears on a form with no fields yet.
- **Add missing fields** adds each new place under what already holds its parent: at the
  form's top level (before its closing buttons, or into the last step of a multi-step form),
  inside the container that stands for the parent object, or inside the repeating section
  whose entries are the parent. A place whose parent the form holds as something else, or that
  has no container, is left out, and the reason is shown.
- **Replace form contents** replaces everything except the form's own settings (title, header,
  footer) and its closing buttons, after a confirm.

Each build is one undo step, leaves the selection where it was, and is offered on the form's own
tab only; the builder reports it with the composed `builder-data-model-apply` event (`action`,
`source`, the top-level `ids` placed and the `skipped` places with the reason). The pasted text
stays in the box while the dialog is closed and opened again, but not across sessions.

---

## 4. Reading a sample or a schema

### A JSON sample

A sample shows what values look like, never what is required:

- The top level must be an object.
- Every entry of a list is read and merged, so a key any entry has is found.
- `null` next to a value makes that kind nullable; different kinds in one place are unknown.
- A string's format is kept only when every non-empty value agrees: a date (`2026-01-31`), a
  date and time, an email address, or a web address. Text with a line break or over 80
  characters reads as long text.
- An object shaped like a file attachment (`storage`, `name`, `type`, `size`) is a file.
- A key a component cannot store under is made usable (`first name` becomes `first_name`) and
  noted; the original is kept as its source key.

### A JSON Schema

The subset a form can hold, from draft-07 and 2020-12:

| Keyword | Read as |
|---|---|
| `type`, including a list with `"null"` | The kind, and whether `null` is allowed |
| `properties` (in order), `required` | An object's keys, and which are required |
| `items` (one schema) | A list's entries; a tuple (`prefixItems`, or `items` as a list) is noted and not built |
| `enum`, `const`, a `oneOf` or `anyOf` of `const`s | Choices, with each branch's `title` as its label |
| a `oneOf` or `anyOf` of one schema and `null` | That schema, nullable |
| `allOf` of objects | Their properties and requirements merged |
| `$ref` to `#`, `#/$defs/…` or `#/definitions/…` | Followed, siblings applied; a reference back to itself stops with a note |
| `title`, `description`, `default`, `format` | Label, description, default, format |
| `pattern`, `minLength`, `maxLength` | Kept; the pattern is converted to the whole-answer match a form uses. A pattern that repeats a repeat (`(x+)+`) is not run unless the host allows risky patterns (see the formulas guide) |
| `minimum`, `maximum` | Kept as the number field's bounds, enforced on submit (`number.min`, `number.max`; a date's are `date.min` and `date.max`), as is the answer being a number and a date's being a real date (ADR 0122, ADR 0142). A field inside a repeating section is held at each entry (`items[0].sku`); a required one errors only for entries that lack it |
| `minItems` of 1 or more on a list of choices | The checkboxes are required |
| `contentEncoding: base64` | A file, approximately |

Every other keyword is named in one note ("Not read, as a form has nothing to hold them: …").
References outside the schema are not followed.

---

## 5. What each place becomes

| Place | Component | Fit |
|---|---|---|
| text | Text | exact |
| long text | Text area | exact |
| email, web address | Text, with the matching keyboard hint (the hint validates nothing; choose Email under Validation > Check the answer as to store an email pattern) | exact |
| date | Date | exact |
| date and time, time | Text | approximate: there is no such field |
| a choice of up to 5 | Radio | exact |
| a choice of 6 or more | Select | exact |
| a number choice | Radio or Select | approximate: the option is stored as text |
| true / false | Checkbox | exact; never required, since false is an answer |
| number | Number | exact |
| whole number | Number | approximate: decimals are not refused |
| a list of choices | Checkboxes | approximate: stored as one true or false per choice |
| a list of plain values | Text area | approximate: one entry per line |
| an object | Container (data-scoping) | exact |
| a list of objects | Data grid | exact; a registry without the type falls back to a Panel with a repeating-section binding |
| a file, a list of files | File (with *Allow several files*) | exact |
| unknown, several kinds | Text | approximate |
| a list inside a list's entry, a list of lists, an empty or mixed list | nothing | not built |

Only component types the builder registers are used; when one is missing the next one stands
in, and the row says so. Each component's id is its key when that id is free, otherwise its
parents' keys joined in front (`billing_street`), otherwise the key numbered (`street_2`). The
key is kept as the data key whenever the id differs, so the answer lands exactly where the
sample or schema put it. Labels come from the schema's titles, otherwise from the keys in words
(`firstName` becomes "First name"). `required` is never set inside a repeating section's entry
or on a container.

### Doing it from code

Everything the Data workspace's import does is exported from `@argusvane/datum-engine`, pure and DOM-free:

```ts
import {
  readDataModelInput,
  dataModelFromForm,
  compareDataModels,
  planAddMissing,
  dataModelToJsonSchema
} from "@argusvane/datum-engine";

const read = readDataModelInput(text, "auto");
if (read.ok) {
  const root = controller.snapshot();
  const formModel = dataModelFromForm(root);
  const hasType = (type: string) => controller.hasComponentType(type);
  const plan = planAddMissing(root, formModel, compareDataModels(formModel, read.model, { hasType }), {
    hasType,
    template: (type) => controller.componentTemplate(type)
  });
  controller.insertComponents(plan.entries); // one undo step
}

const schema = dataModelToJsonSchema(dataModelFromForm(controller.snapshot()));
```

`BuilderController.insertComponents` and `replaceContent` check every id in every subtree,
every child's slot and every place in the data before placing anything, and refuse through
`dropError` otherwise. Their `request*` forms wait behind unsaved edits like a palette click.
