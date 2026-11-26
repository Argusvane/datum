`documents` is a folded tool with two kinds, `journey` (multi-page flows) and `pdf_layout`; its `list` action answers at once, even while the person has pressed Stop. It reaches the Journeys and PDF designers through the page, so the designers must be on the page: a designer that is still loading answers `chunk-unavailable { what: "journeys" | "pdf" }` (retryable), and one the host left out `feature-off`. It works from any workspace; it is not refused by `wrong-mode`.

Result:

```ts
interface DocumentsResult extends AgentOk, Partial<WritePayload> {
  action: "list" | "open" | "new" | "duplicate" | "rename" | "set_default" | "move" | "map_fields" | "create_form_fields" | "preview_pdf" | "restore_removed";
  kind: "journey" | "pdf_layout";
  changed: boolean;
  documents: { id: string; name: string; isDefault: boolean; open: boolean;
               pages?: number; layoutKind?: "generated" | "template"; conditional?: boolean }[];   // at most 50; for layouts, in the order conditions are tried
  opensAs?: "journey" | "form";         // journeys: whether the form opens as its default journey or whole
  templates?: { templateId: string; label: string }[];   // pdf_layout list: the fillable PDFs the site offers
  designer: { state: "ready" | "loading" | "failed" | "off" | "hidden"; workspace: string; openId?: string };
  findings?: { errors: number; warnings: number } | { checked: false };   // list: counted only when the designer's checks are already loaded
  document?: { id: string; name: string; isDefault: boolean };   // writes
  opened?: boolean;                     // open, new, duplicate: the person sees it now
  mapped?: number;                      // map_fields
  formFields?: { added: string[]; mapped: number; matched: number; skipped: { pdfField: string; reason: string }[] };   // create_form_fields
  preview?: { layoutId: string; layoutChoice: "given" | "condition" | "default" | "fallback" | "derived"; layoutKind: "generated" | "template" | "derived";
              pageCount: number; answers: "tried" | "host" | "none"; warnings: { code: string; componentId?: string }[]; fields?: { filled: number; empty: number } };
  elsewhere?: { what: string; steps: number };   // map_fields, create_form_fields: steps pushed onto the layout's own history
  reverse?: { tool: "documents" | "remove_part"; input: Record<string, unknown> };
  undo?: UndoInfo & { journaled?: true };
}
```

How each action behaves:

- `list` returns the documents with ids, names and the default; for layouts also the try order, which ones a condition picks, and the site's fillable PDFs as `templates` (a template list that does not answer within 5 s is left out with the warning `templates-unanswered`).
- `open` shows one to the person in its designer, through the shell's own document change, never around its guards. Opening ends Try it: answers the person typed there are cleared only with `discardTriedAnswers: true`. It is refused `unsaved-draft` while the person has an unapplied edit in a designer document or the builder asks them about one.
- `new` makes a document and opens it: a journey `from` the form's sections or questions (`shape`), a PDF layout drawn from the form, blank, a copy of the open one, or from a site template by `templateId` (files cannot be uploaded: an unknown id is `unknown-template`). A name left out takes the builder's own default. When a new journey is the form's first, it becomes the one the form opens as, and the result says so. When the document was made but could not be opened (the person's prompt, a draft, typed Try it answers), the result says `opened: false` and why.
- `duplicate` copies one and opens the copy. `rename` and `set_default` change the list (for journeys, id `form` makes the form open on one page instead); a name is a string in the form's default language, so a rename leaves its translations (the definition's map) as they are, flagged "Source changed".
- For PDF layouts only: `move` changes the order conditions are tried in; `map_fields` fills the open template layout's PDF fields from form fields with a matching name, as one step on the layout's own history; `create_form_fields` adds a form field for each PDF field left unmapped (one step on the form's history and one on the layout's); `preview_pdf` shows the person the PDF as it would print in the builder's preview dialog, and returns metadata only, never the file. `map_fields` and `create_form_fields` work on the template layout open in the PDF designer (`document-not-open`, `not-a-template`), and wait up to 10 s for a template still being read (`chunk-unavailable { what: "pdf-template" }` past that).
- `restore_removed` brings back a journey or layout removed with `remove_part`, while the page stays open.

Every change to the list (a document made, copied, renamed or removed, the default, the order) is a step of the builder's undo history: the result's `undo.steps` counts it, `history` reaches it, and no journal entry reverses it a second time. `restore_removed` is one step when the document's translations come back with it; with none to bring back it goes through the outside journal, and the result says so: `undo.journaled: true`. Every result gives a `reverse` call that undoes it, and (for `map_fields` and `create_form_fields`, steps on a layout's own history) `elsewhere`. Undo all, Stop and the notice's Undo take back what the assistant did while its entry is still the latest change to that document ("Undo and what it reaches"). `documents` never removes anything: use `remove_part`. Names and template labels are the author's and the site's content.

Failure modes: `bad-input`, `builder-required`, `builder-unknown`, `builder-not-ready`, `stopped` (write actions only), `busy` (`pdf-preview`), `stale`, `cancelled`, `timeout`, `no-ui`, `feature-off`, `chunk-unavailable`, `unsaved-draft`, `tried-answers`, `try-it-on` (`create_form_fields`), `unknown-document`, `unknown-template`, `document-not-open`, `not-a-template`, `nothing-to-restore`, `invalid-id`, `duplicate-id`, `refused`, `internal`.

Example, the journeys:

```json
// call documents
{"action": "list", "kind": "journey"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 6,
  "kind": "journey",
  "action": "list",
  "documents": [{"id": "intake", "name": "Intake", "isDefault": true, "open": false, "pages": 2}],
  "opensAs": "journey",
  "designer": {"state": "ready", "workspace": "journeys"},
  "changed": false,
  "findings": {"checked": false},
  "next": ["documents { action: 'open', kind, id } shows one to the person."]
}
```

Example, the PDF layouts and the site's templates:

```json
// call documents
{"action": "list", "kind": "pdf_layout"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 6,
  "kind": "pdf_layout",
  "action": "list",
  "documents": [
    {"id": "summary", "name": "Summary", "isDefault": true, "open": false, "layoutKind": "generated", "conditional": false},
    {"id": "cra-t2125", "name": "CRA T2125", "isDefault": false, "open": false, "layoutKind": "template", "conditional": false}
  ],
  "designer": {"state": "ready", "workspace": "pdf"},
  "changed": false,
  "findings": {"checked": false},
  "templates": [{"templateId": "t2125-2026", "label": "T2125 Statement of business activities (2026)"}],
  "next": ["documents { action: 'open', kind, id } shows one to the person."]
}
```

Example, a rename: the result carries the call that reverses it:

```json
// call documents
{"action": "rename", "kind": "journey", "id": "intake", "name": "Intake form"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 6,
  "kind": "journey",
  "action": "rename",
  "documents": [{"id": "intake", "name": "Intake form", "isDefault": true, "open": false, "pages": 2}],
  "opensAs": "journey",
  "designer": {"state": "ready", "workspace": "journeys"},
  "changed": true,
  "document": {"id": "intake", "name": "Intake form", "isDefault": true},
  "reverse": {"tool": "documents", "input": {"action": "rename", "kind": "journey", "id": "intake", "name": "Intake"}},
  "undo": {"steps": 1, "ownSteps": 3, "canUndo": true, "canRedo": false},
  "next": ["documents { action: 'list', kind } shows the list as it is now."]
}
```

Example, an action the kind does not have:

```json
// call documents
{"action": "move", "kind": "journey", "id": "intake", "toIndex": 0}
// result
{
  "ok": false,
  "tool": "documents",
  "code": "bad-input",
  "message": "The arguments do not fit documents for kind 'journey'.",
  "hint": "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
  "retryable": false,
  "details": {"problems": [{"key": "action", "expected": "an action for kind 'journey': list, open, new, duplicate, rename, set_default, restore_removed"}, {"key": "toIndex", "expected": "kind 'pdf_layout' only"}]},
  "builder": "contact-request",
  "revision": 6
}
```

Example, a PDF layout made from a site template, opened in the designer:

```json
// call documents
{"action": "new", "kind": "pdf_layout", "from": "template", "templateId": "t2125-2026", "name": "T2125 (fillable)"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 6,
  "kind": "pdf_layout",
  "action": "new",
  "documents": [
    {"id": "summary", "name": "Summary", "isDefault": true, "open": false, "layoutKind": "generated", "conditional": false},
    {"id": "cra-t2125", "name": "CRA T2125", "isDefault": false, "open": false, "layoutKind": "template", "conditional": false},
    {"id": "template-1", "name": "T2125 (fillable)", "isDefault": false, "open": true, "layoutKind": "template", "conditional": false}
  ],
  "designer": {"state": "ready", "workspace": "pdf", "openId": "template-1"},
  "changed": true,
  "document": {"id": "template-1", "name": "T2125 (fillable)", "isDefault": false},
  "opened": true,
  "reverse": {"tool": "remove_part", "input": {"kind": "pdf_layout", "id": "template-1"}},
  "undo": {"steps": 1, "ownSteps": 3, "canUndo": true, "canRedo": false},
  "next": ["documents { action: 'map_fields', kind: 'pdf_layout' } fills its PDF fields from matching form fields."]
}
```

Example, filling its PDF fields from the form's fields:

```json
// call documents
{"action": "map_fields", "kind": "pdf_layout"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 6,
  "kind": "pdf_layout",
  "action": "map_fields",
  "documents": [
    {"id": "summary", "name": "Summary", "isDefault": true, "open": false, "layoutKind": "generated", "conditional": false},
    {"id": "cra-t2125", "name": "CRA T2125", "isDefault": false, "open": false, "layoutKind": "template", "conditional": false},
    {"id": "template-1", "name": "T2125 (fillable)", "isDefault": false, "open": true, "layoutKind": "template", "conditional": false}
  ],
  "designer": {"state": "ready", "workspace": "pdf", "openId": "template-1"},
  "changed": true,
  "mapped": 14,
  "elsewhere": {"what": "PDF layout template-1", "steps": 1},
  "note": ["The 14 mappings are one step on the PDF layout's own undo history: the person undoes it in the PDF designer; end_session { undo: true } takes it back while it is the latest there."],
  "undo": {"steps": 0, "ownSteps": 2, "canUndo": true, "canRedo": false, "journaled": true},
  "next": ["documents { action: 'create_form_fields', kind: 'pdf_layout' } adds form fields for the PDF fields left unmapped."]
}
```

Example, showing the person the PDF it would print:

```json
// call documents
{"action": "preview_pdf", "kind": "pdf_layout", "id": "template-1"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 6,
  "kind": "pdf_layout",
  "action": "preview_pdf",
  "documents": [
    {"id": "summary", "name": "Summary", "isDefault": true, "open": false, "layoutKind": "generated", "conditional": false},
    {"id": "cra-t2125", "name": "CRA T2125", "isDefault": false, "open": false, "layoutKind": "template", "conditional": false},
    {"id": "template-1", "name": "T2125 (fillable)", "isDefault": false, "open": true, "layoutKind": "template", "conditional": false}
  ],
  "designer": {"state": "ready", "workspace": "pdf", "openId": "template-1"},
  "changed": false,
  "preview": {"layoutId": "template-1", "layoutChoice": "given", "layoutKind": "template", "pageCount": 2, "answers": "host", "warnings": [], "fields": {"filled": 9, "empty": 5}},
  "next": ["Tell the person the preview is open; downloading it from there is theirs."]
}
```
