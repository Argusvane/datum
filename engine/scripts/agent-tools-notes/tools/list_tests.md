Result:

```ts
interface ListTestsResult extends AgentOk {
  tests: { id: string; name?: string; line?: number; source?: string; skip?: string; steps: number;
           refs: string[];               // the component ids and paths the test reads
           valid: boolean; problems: WordedTestProblem[];
           lastRun?: { status: "passed" | "failed" | "skipped" | "error" | "invalid"; at: number } }[];
  total: number;
  count: number;
  featureOn: boolean;                   // false: the host hides tests; the definition still carries them
  syntaxHint: string;
  next?: string[];
}
```

`list_tests` works with the `tests` feature off (the definition carries its tests whatever the
host shows); `write_test`, `remove_test` and `run_tests` then answer `feature-off`.

Failure modes: `bad-input`, `too-large`, `unknown-test` (an id in `ids`), `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example:

```json
// call list_tests
{}
// result
{
  "ok": true,
  "tool": "list_tests",
  "builder": "contact-request",
  "revision": 7,
  "tests": [
    {"id": "test-1", "steps": 2, "refs": ["topic", "message"], "valid": true, "problems": [], "name": "Other topic needs a message", "line": 1, "source": "test \"Other topic needs a message\"\n  set topic = \"other\"\n  expect message required\n"}
  ],
  "total": 1,
  "count": 1,
  "featureOn": true,
  "syntaxHint": "One block: test \"name\" then lines: given <path> = <value> | given journey <id> | given today = \"YYYY-MM-DD\" | set <path> = <value> | click <buttonId> | go next|back | expect <path> visible|hidden|required|optional|enabled|disabled | expect <path> = <value> | expect <formula> | expect submit accepted|refused [with <code> on <path>] | skip \"reason\"."
}
```
