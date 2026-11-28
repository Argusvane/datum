# ADR 0117: Form fields from a fillable PDF

## Status

Accepted.

## Context

An organization moving to Datum usually has its forms as fillable PDFs, often hundreds of them. A
populated form (a template layout) already fills such a PDF from the form's answers, and "Suggest
mappings" matches the PDF's fields to the form's by name. But the form has to exist first. Building
it means adding and naming a field for every PDF field by hand, and then mapping each one. The PDF
designer can turn the PDF's own fields into the form's fields instead.

It builds on the Data model generator (ADR 0110) and its keys (ADR 0109), adds one action to the
populated form's template mode (ADR 0043 §9), and keeps one controller per layout (ADR 0044 decision 21). The
guide is [`docs/pdf-rendering.md`](../pdf-rendering.md#designing-a-layout).

## Decision

1. **A "Create form fields" button in a populated form's canvas toolbar**, beside "Suggest
   mappings" (`data-create-form-fields`). It shows only when the host gives the mode the form's own
   controller: the `form?()` option on `PdfBuilderModeOptions`. The mode's `createFormFields()`
   does the same from code and returns what it did.

2. **What is built is decided by `planTemplateFormFields`** (pure, in `template-mode.ts`), over the
   template fields nothing fills yet (unmapped, or filled from a component the form no longer
   has, ADR 0057 decision 26). A field whose name matches a form component, as "Suggest
   mappings" finds it, is filled from that component and nothing is built for it. Every other
   field that holds an answer becomes a component, placed as the Data model generator places one,
   with its kind, choices, required flag and length carried over, its tooltip as the label and
   its own name as the key (and the component's id). Fields go in reading order, where "Add
   missing fields" puts a root-level place (`rootInsertTarget`, which `planAddMissing` uses too).
   Signature, button, unreadable and read-only fields are left out, each with its reason.

3. **The kernel reads a field's tooltip (`/TU`)** into `PdfTemplateFieldInfo.tooltip` on `inspect`
   ([`docs/reference/pdf-abi.md`](../reference/pdf-abi.md)).
   In many fillable PDFs the tooltip is the only readable name a field has, and it is what a
   screen reader announces. A field without a tooltip is labelled from its field name.

4. **Two undo steps, one per controller.** The fields go into the form as one undoable insert
   (`requestInsertComponents`). The mappings land on the layout as one undoable edit through
   `BuilderController.setProperties`, which writes several values as one entry. The form and each
   layout keep their own history (ADR 0044 decision 21), so the two cannot share one undo step. The status
   line says which undo takes back what.

5. **Unsaved edits refuse, and do not prompt.** Edits on the Form tab refuse because their prompt
   would be drawn on a tab the author is not looking at. The layout's own unapplied edits refuse
   too: a source chosen and not saved is the author's answer for that field, which the fill must
   neither overwrite nor build a field beside. So the button says what is in the way, and it
   drops any hold it caused, so that no field can land unmapped later.

6. **A field repeated across pages is one question.** A field with the same own name, kind,
   tooltip, choices and export values, in the same box (within 2 points), on several pages is
   one form field filled from the one component: a name in every page's running header is asked
   once. Two such fields on one page are two, since two rows of a table are two answers. A name a
   form tool gives a field nobody named (`TextField1`, `Check Box2`) is never merged, as it is
   no evidence that two fields ask one thing. A field's own name is the last segment of its
   path without `[0]` indexes, except that a trailing number is a copy's index: Acrobat names
   copies `Text1.0`, `Text1.1`, so those keep their segments and the key made from `Text1.0` is
   `Text1_0`.

## Consequences

- A fillable PDF becomes a working form, and a layout that fills the original PDF, in one click on
  the PDF tab. The fields' kinds, choices, required flags, lengths and tooltips carry over.
- `BuilderController.setProperties` and `data-model/generate.ts`'s `rootInsertTarget` are general.
- The plan does not recognize dates (an AcroForm format action such as `AFDate_FormatEx`: the field
  becomes text), multi-select list boxes as checkbox groups (a select), calculated fields (an
  ordinary field) or grouping by PDF page, and it builds the planned fields without a review step.
