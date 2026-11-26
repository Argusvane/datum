Result:

```ts
interface ReplaceFormResult extends AddComponentsResult {
  removed: string[];                    // the top-level ids that left
  removedCount: number;                 // every component that left, nested ones included
  kept: string[];
  testsAffected: TestAffected[];        // tests that still mention removed ids; never edited
  outsideReferences: Dependent[];       // journey pages or PDF layouts that still name removed ids
}
```

`replace_form` is consequential: the browser may ask the person to confirm it. It never answers
`has-dependents`; what still reads the removed components is reported instead. A Submit button
stays only when its id is in `keep`.

Failure modes: as `add_components`, plus `unknown-component` for an id in `keep`.

Example, the form rebuilt with two fields, keeping Submit:

```json
// call replace_form
{"components": [{"type": "text", "id": "full_name", "label": "Full name", "required": true}, {"type": "textarea", "id": "message", "label": "Message", "required": true}], "keep": ["submit"]}
// result
{
  "ok": true,
  "tool": "replace_form",
  "builder": "contact-request",
  "revision": 9,
  "dryRun": false,
  "ids": ["full_name", "message"],
  "allIds": ["full_name", "message"],
  "generatedIds": {},
  "added": [
    {"id": "full_name", "type": "text", "label": "Full name", "parentId": "root", "slotId": "content", "index": 0, "path": "full_name"},
    {"id": "message", "type": "textarea", "label": "Message", "parentId": "root", "slotId": "content", "index": 1, "path": "message"}
  ],
  "lints": [],
  "problems": [],
  "removed": ["full_name", "email", "subscribe", "topic", "details", "driving"],
  "removedCount": 9,
  "kept": ["submit"],
  "testsAffected": [
    {"id": "test-1", "name": "Other topic needs a message", "refs": ["topic"]},
    {"id": "test-2", "name": "Support needs a message", "refs": ["topic"]}
  ],
  "outsideReferences": [],
  "next": ["Run check_form.", "test-1, test-2 still mention removed ids: rewrite them with write_test or remove them with remove_test."],
  "undo": {"steps": 1, "ownSteps": 5, "canUndo": true, "canRedo": false},
  "shown": {"componentId": "full_name"}
}
```
