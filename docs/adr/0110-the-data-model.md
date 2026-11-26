# ADR 0110: The data model: reading a form's data, and building a form from a sample or a schema

## Status

Accepted.

## Context

Authors often know the data before the form: a sample of what a system expects, or the JSON Schema
of an API. Turning that into a form means adding and naming components one by one, and nothing
shows what data an existing form actually produces (its keys, their nesting, which are required)
except reading the definition or submitting a test answer and reading the renderer's Data
Structure view.

The builder needs a data model view: paste or open a JSON sample or schema, generate the form from
it, and review an existing form's data model.

## Decision

1. **Where it lives.** The model and the build are pure, DOM-free modules (`builder/data-model/`).
   The studio shows them in the Data workspace (ADR 0127): the form's model as a table, a JSON
   Schema or an example, and an Import… dialog the Data surface owns, offered under the
   `data-model` feature (ADR 0143). The import's logic is `builder/data/data-model-import.ts`
   (`DataModelImporter`); the dialog draws it and reports each build to the page.

2. **The model is the nested document the answers describe.** Three readers build it:
   - `dataModelFromForm` reads it from a form: every place keyed by data key (ADR 0109), nested
     under data-scoping containers, a repeating section's fields inside its entries at the
     section's collection path, each with its kind, requiredness, label, choices and the
     component that holds it, and every ADR 0109 problem as a note.
   - `dataModelFromSample` reads a JSON sample and never marks anything required.
   - `dataModelFromJsonSchema` reads the draft-07 and 2020-12 subset a form can hold and names
     every keyword it does not read in one note.

   Keys a form cannot store are made usable and noted. `readDataModelInput` parses pasted text,
   detects a schema from a sample, and reports a JSON error with its line and column. The
   submission itself stays a flat map keyed by path (ADR 0109). What each reader accepts is in
   `docs/data-model.md`, section 4.

3. **Reviewing.** The Data workspace (ADR 0127) shows the form's places as a table, or the same
   model as a JSON Schema or as an example document, in the read-only JSON viewer with a Copy
   button. The exported schema closes its objects with `additionalProperties: false`, because
   the sandbox strips keys the form does not define, and writes a file as `$defs/attachment`, so
   a schema read back in compares as the same model.

4. **Importing builds.** The incoming model is laid over the form's (`compareDataModels`): each
   place is New, On the form, or Held as something else, with how well a component would hold
   it, and the form's own places the model leaves out are folded under "On the form only". Three
   builds follow (`docs/data-model.md`, section 3):
   - **Build form** on a form with no data yet;
   - **Add missing fields**, each new place under what holds its parent. A place whose parent the
     form holds as something else, or that has no container, is left out with the reason;
   - **Replace form contents**, after an inline confirm that says what stays (the root's
     settings and its closing buttons) and what goes. The rebuilt form may reuse the ids it
     replaces.

   Each build is **one undo step**, through the controller's `insertComponents` /
   `replaceContent` (a `CompositeCommand` or a `ReplaceChildrenCommand`), which check every id in
   every subtree, every child's slot and every place in the data before placing anything, and
   whose `request*` forms wait behind unsaved edits like a palette click (held action `replace`).
   A build leaves the selection where it was, and builds only on the form's tab. A composed
   `builder-data-model-apply` event reports it (`action`, `source`, the top-level `ids` placed
   and the `skipped` places with the reason).

5. **The mapping is fixed and says when it is approximate** (`mappingFor`). Each place becomes
   the component that holds it exactly, or a nearby one that the row marks approximate: a
   date-time as text, a whole number as a number that does not refuse decimals, a list of choices
   as checkboxes stored one boolean per choice. A boolean is never required, since false is an
   answer. Up to five choices make a radio group and more a select; an object is a
   data-scoping container; a list of objects is a data grid (ADR 0153). A list inside a list's
   entry, a list of lists, and an empty or mixed list are not built, with the reason. The
   table is in `docs/data-model.md`, section 5.

   Only types the builder registers are used, each wish falling back to the next and saying so.
   Ids are the keys where free, else the parents' keys in front (`billing_street`), else
   numbered, and the key is kept as the data key. `required` is never set inside an entry or on
   a container. Labels come from the schema's titles, else the keys in words.

6. **It never repaints the text box.** The import's frame is written once; a controller change
   repaints only the results region, and only when what it shows changed. The text and the
   read-as choice live on the importer, survive repaints, and are not remembered across
   sessions. Typing reads the text after a pause; a change, a file or a read-as switch reads it
   at once. A read is announced in a live region; a build's message is shown until the form next
   changes.

7. **No new token, no new dependency.** The import reads only the `--db-*` tokens every builder
   theme sets. Its code rides the Data surface's chunk, not `datum-form.js`.

## Consequences

- An author can go from a sample or a schema to a working form in one step and one undo, and see
  an existing form's data as a table, a JSON Schema or an example.
- The import lives in one module, so a fix to it lands everywhere the Data workspace imports.
