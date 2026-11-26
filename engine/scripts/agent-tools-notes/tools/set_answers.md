Result:

```ts
interface SetAnswersResult extends AgentOk {
  written: { path: string; id: string; value: unknown; previous: unknown; display: string;
             matched?: "value" | "label" | "free"; coerced?: true; rows?: { replaced: number } }[];
  refused: { path: string; code: string; message: string; hint: string; details?: Record<string, unknown> }[];
  errors: WordedError[];                // problems now on the written fields (not shown to the person)
  revealed: Field[];                    // fields the answers made visible
  nowRequired: string[];                // paths the answers made required
  nowHidden: string[];                  // paths the answers hid
  page: PageRef & { changed: false };   // the page or step still shown: a write never moves it
  elsewhere?: { path: string; id: string; page?: string; step?: string }[];   // written on another page or step
  workedOut?: { path: string; display: string; from: string }[];   // form fields a presentation's own field fed (from = the own field's path)
  undoable: true;
}
```

How values are read: text as a string (a number or boolean is turned into text and reported
`coerced`); a number as a JSON number or a numeral in the form's language; a date as
`YYYY-MM-DD`; a checkbox as `true` / `false` (or `"yes"` / `"no"`); a choice by its option
`value`, or by its exact label in the current language (`matched: "label"`); several choices as
an array; a table as an array of row objects keyed by column; `null` or `""` clears. A row cell
is written as `items[0].amount` and its row must exist. Files, signatures, buttons, static
content, calculated fields and tables inside another table's rows are refused `not-writable`.
A journey presentation's own fields (paths that start with `@`, listed by `describe_form` and
`get_answers`) are written the same way while their page is shown; the form fields they feed are
reported as `workedOut` and put back together with them by `undo_agent_changes`. On a form that
keeps its draft on the site, the first write result carries a note that the answers are saved there
as they change (see "What leaves the page").

What the person sees: each written field on the current page or step is outlined for a moment
and the change is read out ("An assistant filled 3 fields"); a field on another page or step is
written in place, listed under `elsewhere` and not shown. The person's page or step never moves,
and a field the person is typing in is refused `field-in-use` rather than written under them.

Failure modes: for the call, `bad-input`, `too-large`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `stopped`, `busy`, `stale`, `nothing-written`, `cancelled`, `internal`; per field (in `refused`), `unknown-field`, `not-writable`, `invalid-value`, `no-such-option`, `option-ambiguous`, `options-loading`, `options-failed`, `no-such-row`, `rows-locked`, `rows-limit`, `field-in-use`, `too-large`, `feature-off`, `bad-input`.

Example, a typo, a label matched to its value and a numeral turned into a number; the checkbox
reveals a later page's fields:

```json
// call set_answers
{"answers": {"applicant_name": "Maria Lopez", "age": "41", "wants_details": true, "nicknme": "M"}}
// result
{
  "ok": true,
  "tool": "set_answers",
  "form": "form-1",
  "revision": 4,
  "written": [
    {"path": "applicant_name", "id": "applicant_name", "value": "Maria Lopez", "previous": null, "display": "Maria Lopez"},
    {"path": "age", "id": "age", "value": 41, "previous": null, "display": "41", "coerced": true},
    {"path": "wants_details", "id": "wants_details", "value": true, "previous": null, "display": "Yes"}
  ],
  "refused": [
    {"path": "nicknme", "code": "unknown-field", "message": "No field has the path or id 'nicknme'.", "hint": "Use a `path` from describe_form; did you mean nickname?", "details": {"ref": "nicknme", "suggestions": ["nickname"]}}
  ],
  "errors": [],
  "revealed": [
    {"id": "topics", "path": "topics", "type": "checkboxes", "kind": "multichoice", "label": "Topics", "required": false, "visible": true, "writable": true, "page": "details"},
    {"id": "has_pet", "path": "has_pet", "type": "checkbox", "kind": "boolean", "label": "I have a pet", "required": false, "visible": true, "writable": true, "page": "details"}
  ],
  "nowRequired": [],
  "nowHidden": [],
  "page": {"id": "intro", "title": "Name", "number": 1, "total": 4, "changed": false},
  "undoable": true
}
```

Example, an ambiguous label and a file on the single-page form:

```json
// call set_answers
{"answers": {"name": "Ada Lovelace", "colour": "Green", "topics": ["News"], "has_other": true, "receipt": "x"}}
// result
{
  "ok": true,
  "tool": "set_answers",
  "form": "form-1",
  "revision": 4,
  "written": [
    {"path": "name", "id": "name", "value": "Ada Lovelace", "previous": null, "display": "Ada Lovelace"},
    {"path": "topics", "id": "topics", "value": {"news": true, "offers": false}, "previous": null, "display": "News", "matched": "label"},
    {"path": "has_other", "id": "has_other", "value": true, "previous": null, "display": "Yes"}
  ],
  "refused": [
    {"path": "colour", "code": "option-ambiguous", "message": "2 options of 'colour' share the label 'Green'.", "hint": "Send the option's `value` instead of its label.", "details": {"path": "colour", "got": "Green", "candidates": [{"value": "g1", "label": "Green"}, {"value": "g2", "label": "Green"}]}},
    {"path": "receipt", "code": "not-writable", "message": "The field 'receipt' cannot be filled by an assistant (file).", "hint": "Files, signatures, buttons and nested tables must be handled by the person; ask them.", "details": {"path": "receipt", "reason": "unfillable", "unfillableKind": "file"}}
  ],
  "errors": [],
  "revealed": [
    {"id": "other", "path": "other", "type": "text", "kind": "text", "label": "What else", "required": false, "visible": true, "writable": true, "hasRules": ["visibleWhen"]}
  ],
  "nowRequired": ["detail"],
  "nowHidden": [],
  "page": {"id": "form", "title": "Agent single", "changed": false},
  "undoable": true
}
```

Example, the first write on a form whose draft the site keeps:

```json
// call set_answers
{"answers": {"traveller": "Ana Lopez", "amount": 120, "items": [{"sku": "Taxi", "cost": 30}]}}
// result
{
  "ok": true,
  "tool": "set_answers",
  "form": "form-1",
  "revision": 5,
  "written": [
    {"path": "traveller", "id": "traveller", "value": "Ana Lopez", "previous": null, "display": "Ana Lopez"},
    {"path": "amount", "id": "amount", "value": 120, "previous": null, "display": "120"},
    {"path": "items", "id": "items", "value": [{"sku": "Taxi", "cost": 30}], "previous": [], "display": "1 row", "rows": {"replaced": 1}}
  ],
  "refused": [],
  "errors": [],
  "revealed": [],
  "nowRequired": [],
  "nowHidden": [],
  "page": {"id": "form", "title": "Agent travel-claim", "changed": false},
  "undoable": true,
  "note": ["This form saves the answers as a draft on the site as they change."]
}
```
