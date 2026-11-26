Result:

```ts
interface WriteTestResult extends AgentOk, WritePayload {
  id: string;
  name: string;
  replaced: boolean;
  dryRun: boolean;
  refs: string[];
  unknownRefs: string[];                // names the test reads that are not in the form
}
```

The Tests panel is not opened for it; the notice says what was written.

Failure modes: `bad-input`, `too-large`, `feature-off`, `test-parse-error`, `duplicate-test-name`, `unknown-test` (with `id`), `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `refused`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, a test for the rule `set_properties` widened:

```json
// call write_test
{"source": "test \"Support needs a message\"\n  set topic = \"support\"\n  expect message required\n"}
// result
{
  "ok": true,
  "tool": "write_test",
  "builder": "contact-request",
  "revision": 8,
  "id": "test-2",
  "name": "Support needs a message",
  "replaced": false,
  "dryRun": false,
  "refs": ["topic", "message"],
  "unknownRefs": [],
  "undo": {"steps": 1, "ownSteps": 4, "canUndo": true, "canRedo": false},
  "next": ["run_tests { ids: [\"test-2\"] }"]
}
```
