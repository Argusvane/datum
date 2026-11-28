Result:

```ts
interface RenameComponentResult extends AgentOk, WritePayload {
  from: string;
  to: string;
  rulesRewritten: string[];             // the components whose rules now read the new id
  unparsed: { componentId: string; rule: string; from: string; to: string; formula: string }[];   // formulas that name the old id but do not parse, left as written
  collectionPathFollowed: boolean;
  testsFollow: "queued" | "none" | "unavailable";   // tests are rewritten a moment later ("tests-follow:")
}
```

Failure modes: `bad-input`, `unknown-component`, `root-component`, `fixed-component`, `invalid-id`, `duplicate-id`, `data-path-conflict`, `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `try-it-on`, `refused`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, the generated id of the section added above:

```json
// call rename_component
{"componentId": "fieldset_1", "newId": "driving"}
// result
{
  "ok": true,
  "tool": "rename_component",
  "builder": "contact-request",
  "revision": 4,
  "from": "fieldset_1",
  "to": "driving",
  "rulesRewritten": [],
  "unparsed": [],
  "collectionPathFollowed": false,
  "testsFollow": "none",
  "undo": {"steps": 0, "ownSteps": 2, "canUndo": true, "canRedo": false},
  "shown": {"componentId": "driving"}
}
```
