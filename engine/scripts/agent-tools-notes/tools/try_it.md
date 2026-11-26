`try_it` is the first folded tool (see "Folded tools" above): `action` is the first property and
the tool's `read` action answers at once, even while the person has pressed Stop. It acts on Try
it, the live preview the person sees on the canvas, never on the definition: the tried answers are
not undo steps, are not in Undo all, and move no revision. They end with Try it (`open { tryIt:
false }`). Try it also runs on an open journey's pages and on a PDF template's page viewer, where
`where.journey` names the page.

Result:

```ts
interface TryItResult extends AgentOk {
  action: "read" | "fill" | "edit_rows" | "navigate" | "check" | "submit" | "clear" | "settings";
  changed: boolean;
  trying: boolean;                      // Try it is on after the call
  started?: true;                       // this call turned Try it on: the person now sees the live form
  where?: {                             // present while trying
    workspace: "form" | "journeys" | "pdf";
    journey?: { journeyId: string; pageId: string; title: string; index: number; total: number; final: boolean;
                pages: { pageId: string; title: string; onPath: boolean }[] };   // at most 50
  };
  answered: { byPerson: number; byAssistant: number };   // non-empty tried answers; byAssistant = still holding what the assistant wrote
  // read
  fields?: TriedField[];
  fieldCount?: number;
  lastCheck?: { at: number; problemCount: number };
  lastSubmit?: { at: number; outcome: "accepted" | "invalid" | "refused" | "failed"; reference?: string };   // anyone's, while Try it is on
  recording?: boolean;
  showing?: boolean;
  settings?: {                          // read and settings
    trySubmission: TrySubmissionSettings | null;   // null with the try-it feature off
    sources: { sourceId: string; state: "simulated" | "host" | "missing"; usedBy: string[]; simulatedOptions?: number }[];
  };
  // fill, edit_rows
  written?: { path: string; value: unknown; display?: string; matched?: "label" }[];
  refused?: { path: string; code: string; message: string; hint: string; details?: Record<string, unknown> }[];
  revealed?: string[];                  // paths the answers made visible (at most 50)
  nowRequired?: string[];               // paths the answers made required (at most 50)
  rows?: { collection: string; count: number; added?: number; removed?: number };
  // fill (on the written paths), check (the form or the journey page), submit (when invalid)
  problems?: { path?: string; componentId?: string; label: string; message: string }[];   // at most 100
  problemCount?: number;
  serverChecks?: "off" | "on" | "failed";   // the person's WebAssembly checks; never turned on by a tool
  // submit
  submitted?: { outcome: "accepted" | "invalid" | "refused" | "failed"; standIn: true; reference?: string; message?: string; readOnlyNow?: true };
  // navigate
  moved?: boolean;
  // clear
  cleared?: { byPerson: number; byAssistant: number };
  // settings
  settingsChanged?: string[];           // "trySubmission.outcome", "source:provinces"
  undo?: UndoInfo & { journaled: true };   // settings only
  reverse?: { tool: "try_it"; input: Record<string, unknown> };   // settings only
}
interface TriedField { path: string; componentId: string; label: string; type: string; visible: boolean; required: boolean; enabled: boolean; readonly: boolean;
  value?: unknown; display?: string; typedBy?: "person" | "assistant"; errors?: string[] }
```

How each action behaves:

- `fill`, `edit_rows`, `navigate`, `check` and `submit` turn Try it on first when it is off (`started: true` and a note), so the person sees what is tried; `open { tryIt: false }` turns it off and clears the tried answers. Where Try it cannot run (the Logic, Data and Languages workspaces, a designer overview, the journey map, an empty designer) they answer `not-tryable`.
- `fill` types answers by value path with the same grammar and the same per-path refusals as the renderer's `set_answers`, one outcome per path: an answer the person is typing is `field-in-use`, a hidden, disabled, read-only, calculated or unfillable field is `not-writable`. It writes through the tried runtime, so every rule, calculation and check runs as it would for a respondent, and `revealed` and `nowRequired` say what the answers changed. An answer matched by its label says so (`matched: "label"`). A whole table is rewritten cell by cell; a table holding cells the person typed is refused `person-data`.
- `submit` presses Submit against the builder's stand-in server, which sends nothing anywhere. The stand-in answers as `settings` set it up (accept with a receipt, refuse with a message, or behave as a server that did not answer), after the delay set there. A submit whose outcome is `invalid`, `refused` or `failed` is still `ok: true`: Submit was pressed and the stand-in answered. When the person turned on Try it's server checks, those run first on the tried answers, as they do for them; the tool reads that switch (`serverChecks`) and never turns it on, loads it or retries it.
- `check` runs the form's checks (a journey page's, on a journey) and draws the problems in the Try panel for the person, exactly as their Check button does.
- `navigate` moves a journey preview to `next` (which runs the page's checks as Continue does), `back` or a page id; on a plain form it answers `not-a-journey`. It never moves focus the person has elsewhere.
- `clear` empties the tried answers; answers the person typed are cleared only with `discardTriedAnswers: true`, after telling them (`tried-answers`).
- `settings` sets how the stand-in answers Submit and stand-in option lists for data sources (the builder's preview and Try it only). It is journaled: the result carries `reverse`, and Undo all and `end_session { undo: true }` put the previous values back. A stand-in over a list the site provides is allowed with the warning `host-source: the site's list for <id> is replaced in the builder's preview only`.
- Answers the person typed are never overwritten silently: the catalogue records the paths it wrote, and a dirty path that does not hold the assistant's value is the person's. While the person is recording a test from Try it, or Try it is showing a test scenario, the writing actions answer `try-it-busy`.

Budgets: `check` and starting Try it 10 s, `submit` 20 s (`timeout { stillRunning: true }`). The input cap is 512 KB, with at most 200 answers, 10 000 characters per text, 500 rows, 20 sources of 2 000 options. `try_it` takes no `expectedRevision`: nothing it does moves the revision.

Failure modes: for the call, `bad-input`, `too-large`, `builder-required`, `builder-unknown`, `builder-not-ready`, `stopped` (write actions only), `busy` (`try-submit`), `cancelled`, `timeout`, `no-ui`, `feature-off`, `not-tryable`, `unsaved-draft`, `chunk-unavailable`, `try-it-busy`, `tried-answers`, `nothing-written`, `not-a-journey`, `unknown-page`, `blocked`, `at-end`, `at-start`, `unknown-source`, `internal`; per path (in `refused`), `unknown-field`, `not-writable`, `invalid-value`, `no-such-option`, `option-ambiguous`, `options-loading`, `options-failed`, `no-such-row`, `rows-locked`, `rows-limit`, `person-data`, `field-in-use`, `too-large`.

Example, a fill with Try it off while the person is typing in Email:

```json
// call try_it
{"action": "fill", "answers": {"full_name": "Ana Silva", "email": "ana@example.org", "topic": "Support"}}
// result
{
  "ok": true,
  "tool": "try_it",
  "builder": "contact-request",
  "revision": 1,
  "action": "fill",
  "changed": true,
  "trying": true,
  "started": true,
  "where": {"workspace": "form"},
  "answered": {"byPerson": 0, "byAssistant": 2},
  "written": [
    {"path": "full_name", "value": "Ana Silva"},
    {"path": "topic", "value": "support", "display": "Support", "matched": "label"}
  ],
  "problems": [],
  "problemCount": 0,
  "refused": [
    {"path": "email", "code": "field-in-use", "message": "The person is typing in Email.", "hint": "The person is typing there; fill the other fields now and retry this one.", "details": {"path": "email"}}
  ],
  "next": ["Call try_it { action: 'check' } to see what the form would refuse.", "try_it { action: 'submit' } presses Submit against the stand-in server; nothing is sent."],
  "note": ["Try it is now on: the person sees the live form. open { tryIt: false } goes back to editing and clears the tried answers."]
}
```

Example, reading the tried form (the first four fields):

```json
// call try_it
{"action": "read", "limit": 4}
// result
{
  "ok": true,
  "tool": "try_it",
  "builder": "contact-request",
  "revision": 1,
  "action": "read",
  "changed": false,
  "trying": true,
  "where": {"workspace": "form"},
  "answered": {"byPerson": 0, "byAssistant": 2},
  "fields": [
    {"path": "full_name", "componentId": "full_name", "label": "Full name", "type": "text", "visible": true, "required": true, "enabled": true, "readonly": false, "value": "Ana Silva", "typedBy": "assistant"},
    {"path": "email", "componentId": "email", "label": "Email", "type": "text", "visible": true, "required": true, "enabled": true, "readonly": false},
    {"path": "topic", "componentId": "topic", "label": "Topic", "type": "select", "visible": true, "required": false, "enabled": true, "readonly": false, "value": "support", "display": "Support", "typedBy": "assistant"},
    {"path": "message", "componentId": "message", "label": "Message", "type": "textarea", "visible": true, "required": false, "enabled": true, "readonly": false}
  ],
  "fieldCount": 5,
  "recording": false,
  "showing": false,
  "settings": {"trySubmission": {"outcome": "accept", "delayMs": 800, "statusPlacement": ["top"], "statusText": "", "receipt": {"kind": "success", "title": "Thank you", "message": "We have your answers.", "detailLabel": "Confirmation number", "referencePattern": "DT-{n}", "placement": ["top"]}, "refusalMessage": "The server refused the form.", "afterAccept": "editable"}, "sources": [{"sourceId": "provinces", "state": "host", "usedBy": []}]},
  "next": ["try_it { action: 'fill' } types answers; 'check' shows what the form would refuse."]
}
```

Example, the form's checks:

```json
// call try_it
{"action": "check"}
// result
{
  "ok": true,
  "tool": "try_it",
  "builder": "contact-request",
  "revision": 1,
  "action": "check",
  "changed": false,
  "trying": true,
  "where": {"workspace": "form"},
  "answered": {"byPerson": 0, "byAssistant": 2},
  "problems": [
    {"label": "Email", "message": "Enter an email address.", "path": "email", "componentId": "email"}
  ],
  "problemCount": 1,
  "serverChecks": "off",
  "next": ["Fix the answers with try_it { action: 'fill' }, or the rules with set_properties after open { tryIt: false }."]
}
```

Example, Submit against the stand-in:

```json
// call try_it
{"action": "submit"}
// result
{
  "ok": true,
  "tool": "try_it",
  "builder": "contact-request",
  "revision": 1,
  "action": "submit",
  "changed": true,
  "trying": true,
  "where": {"workspace": "form"},
  "answered": {"byPerson": 0, "byAssistant": 2},
  "submitted": {"outcome": "accepted", "standIn": true, "reference": "DT-000001", "message": "We have your answers."},
  "serverChecks": "off",
  "next": ["Tell the person what the stand-in answered; write_test can keep these answers as a test."]
}
```

Example, setting how the stand-in answers (journaled, with its reverse call):

```json
// call try_it
{"action": "settings", "trySubmission": {"outcome": "refuse", "refusalMessage": "Our office is closed."}}
// result
{
  "ok": true,
  "tool": "try_it",
  "builder": "contact-request",
  "revision": 1,
  "action": "settings",
  "changed": true,
  "trying": true,
  "where": {"workspace": "form"},
  "answered": {"byPerson": 0, "byAssistant": 2},
  "undo": {"steps": 0, "ownSteps": 0, "canUndo": false, "canRedo": false, "journaled": true},
  "reverse": {"tool": "try_it", "input": {"action": "settings", "trySubmission": {"outcome": "accept", "refusalMessage": "The server refused the form."}}},
  "settingsChanged": ["trySubmission.outcome", "trySubmission.refusalMessage"],
  "settings": {"trySubmission": {"outcome": "refuse", "delayMs": 800, "statusPlacement": ["top"], "statusText": "", "receipt": {"kind": "success", "title": "Thank you", "message": "We have your answers.", "detailLabel": "Confirmation number", "referencePattern": "DT-{n}", "placement": ["top"]}, "refusalMessage": "Our office is closed.", "afterAccept": "editable"}, "sources": [{"sourceId": "provinces", "state": "host", "usedBy": []}]},
  "next": ["Try it with try_it { action: 'submit' } or 'fill'."]
}
```

Example, clearing after the person typed an answer:

```json
// call try_it
{"action": "clear"}
// result
{
  "ok": false,
  "tool": "try_it",
  "code": "tried-answers",
  "message": "The person typed 1 answers in Try it; nothing was cleared.",
  "hint": "The person typed 1 answers in Try it; tell them they will be cleared, then call again with discardTriedAnswers: true.",
  "retryable": false,
  "details": {"byPerson": 1, "byAssistant": 2},
  "builder": "contact-request",
  "revision": 1
}
```
