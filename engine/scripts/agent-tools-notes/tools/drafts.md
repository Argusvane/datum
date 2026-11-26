Result:

```ts
interface DraftsResult extends AgentOk {
  action: "save" | "restore" | "clear";
  changed: true;
  store: "browser" | "server" | "page";   // where the form keeps its draft; "page" is a store the page assigned, destination unknown (assumed to leave)
  undoable: false;
  savedAt?: number;                       // save: the new draft's time; restore: the restored draft's
  answered?: number;                      // save, restore: visible fields holding an answer after the call
  locale?: string;                        // restore: the language the draft put the form in
  page?: { id: string; title: string; number?: number };   // restore on a journey or steps form: where the draft put the person
  next: string[];
}
```

`drafts` exists for the explicit acts. The form already saves a draft by itself as the answers
change, the assistant's included (see "What leaves the page"); `describe_form.drafts` says where
it is kept and is absent when the form keeps none. A draft's existence is never probed, because a
probe would download the whole draft.

All three actions are consequential and none can be undone. `save` writes every value the form
holds (hidden prefills too) to the draft store, which leaves the page on a `server` or `page`
store. `restore` replaces every answer on screen and the language, and is refused `answers-present`
while the person has entered answers, unless `replaceAnswers: true` after they agreed. It is also
refused `field-in-use` while the person is typing, and it never moves the focus the person has
elsewhere (a journey resumes quietly). `clear` deletes the saved draft; the form saves a new one
as soon as an answer changes.

A restore, by anyone, starts a new record: `undo_agent_changes` answers `draft-restored` until the
assistant writes again, and the provenance account turns `complete: false` if the assistant had
written (see "Provenance"). A restore inside a session moves the session's undo boundary to the
restore, so `end_session { undo: true }` and Stop undo only what was written after it, and the end
result carries the warning `a saved draft replaced the answers during the session; changes before
it cannot be undone`.

Never in the result: the draft key (a host may build it from a user or case id), the draft's
values, a store's URL or origin, or a store's own error text. A failure is worded by the tool:
`draft-failed` carries the HTTP status when the store reported one, and `by: "host"` when a
`beforeDraftSave` hook or a page-assigned store refused. The call has a budget of 15 s
(`timeout { stillRunning: true }`). Only a restore moves the revision.

Failure modes: `bad-input`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `stopped`, `busy` (`submission`, `draft`), `stale`, `cancelled`, `timeout`, `feature-off`, `no-drafts`, `no-draft`, `answers-present`, `draft-incompatible`, `draft-failed`, `field-in-use`, `internal`.

Example, the draft saved on a form whose draft the site keeps:

```json
// call drafts
{"action": "save"}
// result
{
  "ok": true,
  "tool": "drafts",
  "form": "form-1",
  "revision": 5,
  "action": "save",
  "changed": true,
  "store": "server",
  "undoable": false,
  "savedAt": 1792897096186,
  "answered": 3,
  "next": ["Tell the person the draft is saved on the site."]
}
```

Example, a restore while the person has already entered answers:

```json
// call drafts
{"action": "restore"}
// result
{
  "ok": false,
  "tool": "drafts",
  "code": "answers-present",
  "message": "The form already holds 3 answers; nothing was restored.",
  "hint": "Restoring replaces the 3 answers on screen and cannot be undone; ask the person, then call again with replaceAnswers: true.",
  "retryable": false,
  "details": {"answered": 3},
  "form": "form-1",
  "revision": 6
}
```

Example, the restore after the person agreed:

```json
// call drafts
{"action": "restore", "replaceAnswers": true}
// result
{
  "ok": true,
  "tool": "drafts",
  "form": "form-1",
  "revision": 9,
  "action": "restore",
  "changed": true,
  "store": "server",
  "undoable": false,
  "savedAt": 1792897096186,
  "answered": 3,
  "locale": "en",
  "next": ["Call describe_form to see the restored answers before changing any.", "check { scope: 'form' } shows what is still missing."]
}
```

Example, deleting it:

```json
// call drafts
{"action": "clear"}
// result
{
  "ok": true,
  "tool": "drafts",
  "form": "form-1",
  "revision": 9,
  "action": "clear",
  "changed": true,
  "store": "server",
  "undoable": false,
  "next": ["Tell the person the saved draft is deleted; the form saves a new one as soon as an answer changes."]
}
```

Example, a form that keeps no draft:

```json
// call drafts
{"action": "save"}
// result
{
  "ok": false,
  "tool": "drafts",
  "code": "no-drafts",
  "message": "This form keeps no saved draft.",
  "hint": "This form does not keep drafts; tell the person.",
  "retryable": false,
  "details": {},
  "form": "form-1",
  "revision": 1
}
```
