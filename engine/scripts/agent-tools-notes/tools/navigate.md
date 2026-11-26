Result:

```ts
interface NavigateResult extends AgentOk {
  moved: boolean;                       // false when only `reveal` was asked, or `to` named the page shown
  from?: PageRef;
  page: PageRef;                        // the page or step now shown
  pages: Page[];
  fields: Field[];                      // outline of the page now shown (≤ 50; describe_form for more)
  revealed?: { path: string; id: string; onCurrentPage: boolean; page?: string; step?: string; opened?: { tab?: string } };
  final: boolean;                       // the page now shown is the last one
}
```

`next` runs the page's checks exactly as the person's Continue does, and a failure is shown to
the person as it would be for them. A page or step the person could not reach yet is
`unreachable`. `reveal` opens the tab that holds a field on the current page or step; a field
elsewhere is reported with its `page` or `step`, and only `to` moves.

Failure modes: `bad-input`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `feature-off`, `stopped`, `busy`, `stale`, `unknown-field`, `unknown-page`, `unreachable`, `blocked`, `at-end`, `at-start`, `exit-page`, `timeout`, `cancelled`, `internal`.

Example, `next` from the journey's first page:

```json
// call navigate
{"to": "next"}
// result
{
  "ok": true,
  "tool": "navigate",
  "form": "form-1",
  "revision": 7,
  "moved": true,
  "page": {"id": "contact", "title": "How to reach you", "number": 2, "total": 4},
  "pages": [
    {"id": "intro", "title": "Name", "kind": "questions", "index": 0, "current": false, "completed": true, "reachable": true, "onPath": true, "final": false, "number": 1},
    {"id": "contact", "title": "How to reach you", "kind": "questions", "index": 1, "current": true, "completed": false, "reachable": true, "onPath": true, "final": false, "number": 2},
    {"id": "details", "title": "Topics", "kind": "questions", "index": 2, "current": false, "completed": false, "reachable": false, "onPath": true, "final": false, "number": 3},
    {"id": "review", "title": "Items", "kind": "questions", "index": 3, "current": false, "completed": false, "reachable": false, "onPath": true, "final": true, "number": 4},
    {"id": "stop", "title": "Not eligible", "kind": "exit", "index": 4, "current": false, "completed": false, "reachable": false, "onPath": false, "final": false}
  ],
  "fields": [
    {"id": "contact_method", "path": "contact_method", "type": "select", "kind": "choice", "label": "How to reach you", "required": false, "visible": true, "writable": true, "page": "contact"},
    {"id": "email", "path": "email", "type": "text", "kind": "text", "label": "Email", "required": false, "visible": true, "writable": true, "page": "contact", "hasRules": ["requiredWhen"]},
    {"id": "confirm_email", "path": "confirm_email", "type": "text", "kind": "text", "label": "Confirm email", "required": false, "visible": true, "writable": true, "page": "contact", "hasRules": ["validWhen"]},
    {"id": "province", "path": "province", "type": "select", "kind": "choice", "label": "Province", "required": false, "visible": true, "writable": true, "page": "contact"},
    {"id": "stop_code", "path": "stop_code", "type": "text", "kind": "text", "label": "Code", "required": false, "visible": true, "writable": true, "page": "contact"}
  ],
  "final": false,
  "from": {"id": "intro", "title": "Name", "number": 1, "total": 4}
}
```
