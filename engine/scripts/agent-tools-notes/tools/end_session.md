Result on a form:

```ts
interface EndSessionResult extends AgentOk {
  wasOpen: boolean;                     // false: no session was open (not an error)
  session?: { id: string; durationMs: number; calls: number; undone: number;
              fieldsWritten: number; rowsAdded: number; rowsRemoved: number; pagesMoved: number; undoable: number };
}
```

`warnings` on the result carry what the session could not do: `a saved draft replaced the answers
during the session; changes before it cannot be undone`, and the registrar's `undo stopped early`.

Failure modes: `bad-input`, `target-required`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `cancelled`, `internal`.

Example:

```json
// call end_session
{"summary": "Filled your name and age; please check the contact page."}
// result
{
  "ok": true,
  "tool": "end_session",
  "form": "form-1",
  "revision": 11,
  "wasOpen": true,
  "session": {"id": "session-1", "durationMs": 1, "calls": 0, "undone": 0, "fieldsWritten": 0, "rowsAdded": 0, "rowsRemoved": 0, "pagesMoved": 0, "undoable": 0}
}
```

Example, with no session open:

```json
// call end_session
{"summary": "Done."}
// result
{
  "ok": true,
  "tool": "end_session",
  "form": "form-1",
  "revision": 11,
  "wasOpen": false,
  "note": ["No session was open; nothing to end."]
}
```
