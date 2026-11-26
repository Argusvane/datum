# Feature-coverage checklist

The Datum features the new renderer (`render/live`, Datum binding) must carry, one id per feature. Built from the old element's behaviour list as a list of features only, not of how the old element did them. A scenario in `scenarios/` names the ids it covers; `npm run test:features -- --list` shows which ids have one. An id no scenario covers is reported as uncovered and fails the run; `pending` is only for a scenario that declares itself pending.

Every scenario runs in two hosts: `live` (the renderer mounted directly) and `element` (the real `<datum-form-renderer>`, driven through its public properties and methods); a feature passes only when both pass. A scenario that declares `hosts: ["element"]` (the last group) runs in the element host alone.

Every scenario also runs the shared assertions (`lib/shared.mjs`) at each state it marks: accessible names, references that resolve, aria-invalid only with a described blocking error, and the DOM contract. They are not listed here as features.

## Validation and focus

| ID | Feature |
|---|---|
| VAL-01 | Validating a form with errors moves focus to the error summary (Datum's `errorFocus: "summary"`) |
| VAL-02 | With `errorFocus: "field"`, validating moves focus to the first field in error |
| VAL-03 | Enter in a form's text box checks the form (implicit submission) without navigating, then focuses the errors |
| VAL-04 | A field already showing an error is checked again when its answer is committed (`validateOn: "commitAfterError"`) |
| VAL-05 | A field is not checked on its first blur before any submit attempt |
| VAL-06 | A typed answer is interim while typing and committed on leaving the field |
| VAL-07 | A first error hidden in another tab or step is opened before it takes focus |
| VAL-08 | A server error stands until the first commit that changes its answer |

## Error summary

| ID | Feature |
|---|---|
| SUM-01 | The summary lists every blocking error, in form order, under a heading with the count |
| SUM-02 | Each summary link moves focus to its field's focus target (checked option, else first control; a date's first missing part) |
| SUM-03 | A data-grid cell error links to that row's field; a cell error no row owns links to the grid's Add button |
| SUM-04 | Form-level errors are listed without a field link |
| SUM-05 | The summary updates as errors are corrected and goes once none are left |
| SUM-06 | Warnings and info never appear in the summary |

## Tabs

| ID | Feature |
|---|---|
| TAB-01 | Arrow Left/Right, Home and End move between tabs and select them |
| TAB-02 | A tab holding an error is marked |
| TAB-03 | At narrow widths tabs are drawn as contents (the narrow view) |

## Data grids

| ID | Feature |
|---|---|
| GRD-01 | Adding a row moves focus to the new row's first field |
| GRD-02 | Removing a row moves focus to a neighbouring row, else the Add button |
| GRD-03 | Moving a row up or down keeps focus on the moved row's control |
| GRD-04 | Rows keep their identity: answers stay with their row across add, remove and move |
| GRD-05 | Row bounds (min/max rows) govern Add and Remove |
| GRD-06 | Each row is labelled ("Row 2", the author's row label) for its fields and summary lines |

## Journeys

| ID | Feature |
|---|---|
| JNY-01 | Continue goes to the next page and moves focus to its heading |
| JNY-02 | Back goes to the previous page |
| JNY-03 | Continue on a page with errors stays, draws the errors and focuses them |
| JNY-04 | The last page's submit runs the runtime's journey final submit |
| JNY-05 | A page change can be made quiet (no focus move) for an agent |

## Dates

| ID | Feature |
|---|---|
| DAT-01 | Day, month and year parts compose into one stored date |
| DAT-02 | A date typed in part reports incomplete and focus goes to its first missing part |
| DAT-03 | A month typed by name is read |
| DAT-04 | Part order follows the binding's order (fixed or by locale) |
| DAT-05 | Nothing is written into a part box while an input method is composing in it; the draws held meanwhile land when the composition ends |

## Character count

| ID | Feature |
|---|---|
| CNT-01 | A field with a length limit shows the count and announces it once, politely |
| CNT-02 | Going over the limit marks the field (`data-over-limit`) and raises its error |

## Files

| ID | Feature |
|---|---|
| FIL-01 | Picking a file stores it and announces it |
| FIL-02 | Removing a file clears it, announces it and keeps focus in the field |
| FIL-03 | Dropping a file on the field stores it |
| FIL-04 | A stored file can be downloaded |

## Languages

| ID | Feature |
|---|---|
| LOC-01 | The language switcher changes the form's locale and re-words it |
| LOC-02 | Translations reach labels, hints, options and the renderer's own words |
| LOC-03 | The form carries `lang` and `dir` for its locale |

## Read-only and disabled

| ID | Feature |
|---|---|
| RO-01 | A read-only form shows every answer, its controls stay focusable and no write reaches the runtime |
| RO-02 | A disabled form disables its controls and no write reaches the runtime |
| RO-03 | A field marked read-only or disabled in an interactive form behaves so on its own |
| RO-04 | A read-only long answer is sized to show in full |

## Busy and pending

| ID | Feature |
|---|---|
| BSY-01 | The form is marked busy (aria-busy) while submitting, validating or navigating |
| BSY-02 | A field whose async check is running is marked pending (`data-pending`, aria-busy) |
| BSY-03 | Buttons are drawn aria-disabled while the form is busy |

## Notices

| ID | Feature |
|---|---|
| NOT-01 | Field warnings and info are drawn as notices, described by the field, never as errors |
| NOT-02 | A form notice (receipt, submitted, failed) is drawn and takes focus |

## Data sources

| ID | Feature |
|---|---|
| SRC-01 | A field whose data source has not answered is drawn as loading, then with its options |
| SRC-02 | A data source that fails marks the field and reports it |
| SRC-03 | `dataSourceWait: "all"` holds the first draw for the sources |

## Steps

| ID | Feature |
|---|---|
| STP-01 | Next and Back move between steps |
| STP-02 | Step entries let a person go to a step |
| STP-03 | The current step is marked and its panel alone shown |

## Chrome

| ID | Feature |
|---|---|
| CHR-01 | Header and footer chrome parts are drawn |
| CHR-02 | The chrome frame preset applies |
| CHR-03 | The language switcher sits in the chrome |

## Other behaviour

| ID | Feature |
|---|---|
| TIP-01 | A tooltip opens on hover and focus and Escape dismisses it |
| MED-01 | Media-dependent labels follow the viewport |
| UNK-01 | A component type nothing draws is reported once and drawn as a note |
| BTN-01 | Button groups and form buttons run their actions |
| SIG-01 | A signature field is drawn and takes a signature |

## Agent DOM contract

| ID | Feature |
|---|---|
| AGT-01 | Every field wrapper carries `data-component-id` and `data-value-path` (a grid row's field: its row path) |
| AGT-02 | Every container carries `data-container-id` |
| AGT-03 | Answers being typed can be committed at once (settleInput) |
| AGT-04 | A field can be revealed and focused by id (what hides it opened first) |
| AGT-05 | State hooks on every field wrapper: `data-kind`, `data-required`, `data-invalid`, `data-readonly`, `data-disabled`, `data-over-limit`, `data-source`, `data-pending` |
| AGT-06 | An agent's refused submit draws its errors and leaves focus where the person left it, a field of the form included |

## The element's own settings

Run in the `element` host only: the live host has no element, so these features have no counterpart there and are left off its list.

| ID | Feature |
|---|---|
| ELM-01 | A binding named by an id nothing registered is reported once and Datum's draws meanwhile; registering the id draws with it at once |
| ELM-02 | `extraStyles` reach the drawn form as the last sheet and follow every redraw and remount |
| ELM-03 | `colorScheme` draws the binding's dark look in place, keeping the form element, its focus and its answers |
| ELM-04 | `capabilitiesOf` answers what the binding draws for a type and follows a change of binding |
| ELM-05 | A setting the form is built from (mode, binding) mounts it again, an equal value does not, and the host's answers survive the mount |
