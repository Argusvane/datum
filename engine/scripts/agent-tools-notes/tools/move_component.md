Result:

```ts
interface MoveComponentResult extends AgentOk, WritePayload {
  componentId: string;
  from: { parentId: string; slotId: string; index: number };
  to: { parentId: string; slotId: string; index: number };
  leftEmpty: string[];                  // containers the move left with nothing in them
}
```

A move to where the component already is answers `ok: true` with `undo.steps: 0`. A destination
the builder would not take is refused `move-refused` with `details.targets`, the places it may go.

Failure modes: `bad-input`, `unknown-component` (the component, `parentId` or `after`), `root-component`, `fixed-component`, `move-refused`, `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `try-it-on`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, Email me updates out of the Details group to right after Email:

```json
// call move_component
{"componentId": "subscribe", "parentId": "root", "after": "email"}
// result
{
  "ok": true,
  "tool": "move_component",
  "builder": "contact-request",
  "revision": 5,
  "componentId": "subscribe",
  "from": {"parentId": "details", "slotId": "content", "index": 1},
  "to": {"parentId": "root", "slotId": "content", "index": 2},
  "leftEmpty": [],
  "undo": {"steps": 1, "ownSteps": 3, "canUndo": true, "canRedo": false},
  "shown": {"componentId": "subscribe"}
}
```
