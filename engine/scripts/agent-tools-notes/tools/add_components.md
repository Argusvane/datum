Result:

```ts
interface AddComponentsResult extends AgentOk, WritePayload {
  dryRun: boolean;
  ids: string[];                        // the top-level components added, in order
  allIds: string[];                     // every component added, nested ones included
  generatedIds: Record<string, string>; // input position ("0", "0.children.2", "1.slots.tab_1.0") → generated id
  added: { id: string; type: string; label: string; path?: string; parentId: string; slotId: string; index: number }[];
  lints: FormulaProblem[];
  problems: ComponentProblem[];         // findings on the new components after the write
  next: string[];
  changed?: boolean;                    // with fromData: false when the form already had a field for every place
  dataModel?: DataModelReport;          // with fromData
}
interface DataModelReport {
  readAs: "sample" | "schema"; detected: "sample" | "schema";
  places: number;                       // places the input describes
  added: { path: string; componentId: string; type: string; fit: "exact" | "approximate"; notes?: string[] }[];   // at most 200; with dryRun, what would be added
  alreadyInForm: number;                // add: places the form has
  kindDiffers: { path: string; form: string; incoming: string }[];   // at most 50, left alone
  skipped: { path: string; reason: string }[];   // at most 50, the planner's own sentences
  notes: string[];                      // at most 20: ignored keywords, unusable or risky patterns
}
```

Each entry is a `ComponentSpec` (below). Instead of `components`, give **`fromData`**: a JSON sample
of the answers (an object, as an object or as JSON text) or a JSON Schema, and a field is added for
every place the form does not have yet, as the Data workspace's Import does, in one undo step
(`replace_form { fromData }` rebuilds the form with one field per place, keeping the closing
buttons). Exactly one of `components` and `fromData` (`bad-input` otherwise); `readAs` forces
`sample` or `schema` (default: decided by the `$schema`, `type` or `properties` keywords). The
planner is the Data workspace's own, loaded the same way (`chunk-unavailable { what: "data-model" }`
if it cannot be); the `data-model` feature must be on. A generated `pattern` that the risky-pattern
check refuses is dropped, with a warning and a `notes` entry; a plan over the component caps is
`too-large` or `structure-limit`. When the plan is empty, `ok: true, changed: false` with a note. Without `parentId` a component goes to the end of the
form, before an untouched Submit button (`kept-submit-last:`); choice options given as strings
get values derived from their labels (`derived-option-values:`). A checkbox or number property
in a spec's `configuration` is read as `set_properties` reads it (`"true"` or a numeral is coerced
with `coerced:`; `"yes"`, a boolean for a number or `"abc"` is `bad-input`), and `replace_form`
reads its specs the same way. The checks run in one pass
before anything is placed (type, ids, slots, the inspector's own blockers, formulas, data paths,
the structure limits), and a refusal's `hint` also names what else that pass found, so one more
call fixes everything. `dryRun: true` stops there and answers what would be added.

Failure modes: `bad-input`, `too-large`, `unknown-component` (`parentId`), `unknown-type`, `invalid-id`, `duplicate-id`, `slot-refused`, `blocked-property`, `formula-error`, `data-path-conflict`, `structure-limit`, `data-unreadable`, `feature-off`, `chunk-unavailable`, `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `try-it-on`, `refused`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, a section with a choice and a field it shows and requires:

```json
// call add_components
{"components": [{"type": "fieldset", "label": "Driving", "children": [{"type": "radio", "id": "has_licence", "label": "Do you have a driving licence?", "required": true, "options": ["Yes", "No"]}, {"type": "text", "id": "licence_no", "label": "Licence number", "rules": {"visibleWhen": "has_licence = \"yes\"", "requiredWhen": "has_licence = \"yes\""}}]}], "expectedRevision": 1}
// result
{
  "ok": true,
  "tool": "add_components",
  "builder": "contact-request",
  "revision": 2,
  "dryRun": false,
  "ids": ["fieldset_1"],
  "allIds": ["fieldset_1", "has_licence", "licence_no"],
  "generatedIds": {"0": "fieldset_1"},
  "added": [
    {"id": "fieldset_1", "type": "fieldset", "label": "Driving", "parentId": "root", "slotId": "content", "index": 4},
    {"id": "has_licence", "type": "radio", "label": "Do you have a driving licence?", "parentId": "fieldset_1", "slotId": "content", "index": 0, "path": "has_licence"},
    {"id": "licence_no", "type": "text", "label": "Licence number", "parentId": "fieldset_1", "slotId": "content", "index": 1, "path": "licence_no"}
  ],
  "lints": [],
  "problems": [],
  "next": ["Set more properties or rules with set_properties using these ids.", "Run check_form when you are done."],
  "undo": {"steps": 1, "ownSteps": 1, "canUndo": true, "canRedo": false},
  "shown": {"componentId": "fieldset_1"},
  "warnings": ["derived-option-values: has_licence option values were derived from their labels: yes, no.", "kept-submit-last: placed before the Submit button so it stays last."]
}
```

Example, a dry run whose rule does not parse:

```json
// call add_components
{"components": [{"type": "text", "label": "Licence number", "rules": {"visibleWhen": "has_licence = ("}}], "dryRun": true}
// result
{
  "ok": false,
  "tool": "add_components",
  "code": "formula-error",
  "message": "The formula for text_1.rules.visibleWhen did not parse; nothing was written.",
  "hint": "Fix the formula at start..end; nothing was written. FEEL: `and`/`or`/`not()`, `=` for equality (not `==`), strings in double quotes, field ids as bare names.",
  "retryable": false,
  "details": {"problems": [{"propertyPath": "rules.visibleWhen", "formula": "has_licence = (", "code": "expectedValue", "message": "A value is missing at the end of the formula.", "start": 15, "end": 15, "componentId": "text_1"}]},
  "builder": "contact-request",
  "revision": 1
}
```

Example, a dry run from a JSON sample of the answers (`fromData`):

```json
// call add_components
{"fromData": {"full_name": "Ana", "phone": "613-555-0100", "visits": 3}, "dryRun": true}
// result
{
  "ok": true,
  "tool": "add_components",
  "builder": "contact-request",
  "revision": 2,
  "dryRun": true,
  "ids": ["phone", "visits"],
  "allIds": ["phone", "visits"],
  "generatedIds": {},
  "added": [
    {"id": "phone", "type": "text", "label": "Phone", "parentId": "root", "slotId": "content", "index": 4},
    {"id": "visits", "type": "number", "label": "Visits", "parentId": "root", "slotId": "content", "index": 5}
  ],
  "lints": [],
  "problems": [],
  "changed": false,
  "dataModel": {"readAs": "sample", "detected": "sample", "places": 3, "added": [{"path": "phone", "componentId": "phone", "type": "text", "fit": "exact"}, {"path": "visits", "componentId": "visits", "type": "number", "fit": "exact"}], "alreadyInForm": 1, "kindDiffers": [], "skipped": [], "notes": []},
  "next": ["Review the generated labels, required flags and options with get_form, then adjust with set_properties.", "Run check_form before you say the form is done."],
  "undo": {"steps": 0, "ownSteps": 0, "canUndo": false, "canRedo": false}
}
```

Example, JSON that does not read:

```json
// call add_components
{"fromData": "{ not json"}
// result
{
  "ok": false,
  "tool": "add_components",
  "code": "data-unreadable",
  "message": "This is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
  "hint": "Send a JSON object (a sample of the answers) or a JSON Schema whose top level is an object; fix the JSON at the line and column given.",
  "retryable": false,
  "details": {"error": "This is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)", "line": 1, "column": 3},
  "builder": "contact-request",
  "revision": 2
}
```
