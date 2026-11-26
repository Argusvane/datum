Result:

```ts
interface RemoveComponentsResult extends AgentOk, WritePayload {
  removed: string[];
  removedCount: number;                 // nested components included
  skipped: { id: string; reason: "nested" }[];   // listed ids inside another listed id
  referencesCleared: Dependent[];       // removeReferences: true
  testsAffected: TestAffected[];
  next: string[];
}
```

`remove_components` is consequential. Afterwards the selection moves to the previous sibling of
the first removed component, else to its parent. Components only: a language, a journey or a PDF
layout is removed with `remove_part`.

Failure modes: `bad-input`, `too-large`, `unknown-component`, `root-component`, `fixed-component`, `has-dependents`, `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `try-it-on`, `refused`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, a component another component's rule still reads:

```json
// call remove_components
{"componentIds": ["topic"]}
// result
{
  "ok": false,
  "tool": "remove_components",
  "code": "has-dependents",
  "message": "1 reference still reads \"topic\".",
  "hint": "Call again with removeReferences: true to clear those references too (one undo step per component), or fix them first with set_properties.",
  "retryable": false,
  "details": {"dependents": [{"componentId": "topic", "items": [{"kind": "rule", "componentId": "message", "name": "Message", "rule": "requiredWhen"}], "lines": ["Rule “requiredWhen” of Message"]}]},
  "builder": "contact-request",
  "revision": 5
}
```
