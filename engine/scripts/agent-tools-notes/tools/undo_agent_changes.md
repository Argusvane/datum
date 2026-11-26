Result:

```ts
interface UndoResult extends AgentOk {
  restored: { path: string; value: unknown; display: string }[];
  rowsRemoved: { collection: string; index: number }[];
  rowsRestored: { collection: string; index: number }[];
  kept: { path?: string; collection?: string; index?: number;
          reason: "person-edited" | "field-in-use" | "rows-not-addable" | "rows-not-removable" | "not-restorable" }[];
  undoneCalls: number;
  remaining: number;                    // records still undoable
  partial: boolean;                     // something was kept
}
```

A field is put back only while it still holds the assistant's value; one the person changed
afterwards is left as they set it and listed in `kept`. An added row is removed only while
nothing in it is the person's. `undo_agent_changes` keeps working after the person pressed Stop.
A value given back goes to whoever wrote it before (the person's value is the person's again). A
draft restored with `drafts { action: 'restore' }` starts a new record: until the assistant writes
again the call answers `draft-restored`, since changes from before the restore cannot be undone.

Failure modes: `bad-input`, `too-large`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `busy`, `submitted`, `draft-restored`, `nothing-to-undo`, `cancelled`, `internal`.

Example, everything the assistant did on the single-page form (three fields and a row):

```json
// call undo_agent_changes
{}
// result
{
  "ok": true,
  "tool": "undo_agent_changes",
  "form": "form-1",
  "revision": 11,
  "restored": [
    {"path": "name", "value": null, "display": ""},
    {"path": "topics", "value": null, "display": ""},
    {"path": "has_other", "value": null, "display": ""}
  ],
  "rowsRemoved": [{"collection": "grid", "index": 1}],
  "rowsRestored": [],
  "kept": [],
  "undoneCalls": 2,
  "remaining": 1,
  "partial": false
}
```

Example, after a draft restore:

```json
// call undo_agent_changes
{}
// result
{
  "ok": false,
  "tool": "undo_agent_changes",
  "code": "draft-restored",
  "message": "A saved draft replaced the answers after your last change; there is nothing of yours to put back.",
  "hint": "A saved draft replaced the answers; changes made before it cannot be undone.",
  "retryable": false,
  "details": {"restoredAt": 1792897096186},
  "form": "form-1",
  "revision": 9
}
```
