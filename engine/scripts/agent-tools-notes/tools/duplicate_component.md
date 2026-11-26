Result:

```ts
interface DuplicateComponentResult extends AgentOk, WritePayload {
  from: string;
  id: string;                           // the copy's id
  ids: Record<string, string>;          // old id → new id for every component in the copy
  dataKeysDropped: string[];            // the copy's ids whose data key was dropped (a copy never keeps one)
}
```

Failure modes: `bad-input`, `unknown-component`, `root-component`, `fixed-component`, `slot-refused`, `structure-limit`, `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `try-it-on`, `refused`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example:

```json
// call duplicate_component
{"componentId": "email"}
// result
{
  "ok": true,
  "tool": "duplicate_component",
  "builder": "contact-request",
  "revision": 6,
  "from": "email",
  "id": "email_2",
  "ids": {"email": "email_2"},
  "dataKeysDropped": [],
  "undo": {"steps": 1, "ownSteps": 4, "canUndo": true, "canRedo": false},
  "shown": {"componentId": "email_2"}
}
```
