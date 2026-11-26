Result:

```ts
interface RunTestsResult extends AgentOk {
  summary: { total: number; passed: number; failed: number; skipped: number; error: number; invalid: number; notRun: number; durationMs: number };
  results: { id?: string; name?: string;
             status: "passed" | "failed" | "skipped" | "error" | "invalid" | "not-run";
             reason?: string;
             steps: { total: number; passed: number; failed: number; skipped: number };
             firstFailure?: TestFailure; failures: TestFailure[]; problems?: WordedTestProblem[] }[];
  pending: string[];                    // ids not reached within timeBudgetMs
  partial: boolean;
  draftsExcluded: string[];
  next?: string[];
}
interface TestFailure { line: number; text: string; code: string; message: string; expected?: unknown; actual?: unknown }
```

Each scenario runs against a fresh headless copy of the committed form; the canvas, Try it and the
person's answers there are never touched. The tests runner is a lazy file: the first run loads
it, and a run whose file is missing answers `chunk-unavailable` (retryable) while `list_tests`,
`write_test` and `remove_test` keep working. A run that reaches `timeBudgetMs`, or whose call is
cancelled after the first scenario, answers `ok: true, partial: true` with the rest `pending`
(never `timeout`).

Failure modes: `bad-input`, `too-large`, `feature-off`, `chunk-unavailable`, `unknown-test`, `test-parse-error` (`source` with no block), `busy`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, both tests after `write_test`:

```json
// call run_tests
{}
// result
{
  "ok": true,
  "tool": "run_tests",
  "builder": "contact-request",
  "revision": 8,
  "summary": {"total": 2, "passed": 2, "failed": 0, "skipped": 0, "error": 0, "invalid": 0, "notRun": 0, "durationMs": 0},
  "results": [
    {"id": "test-1", "name": "Other topic needs a message", "status": "passed", "steps": {"total": 2, "passed": 2, "failed": 0, "skipped": 0}, "failures": []},
    {"id": "test-2", "name": "Support needs a message", "status": "passed", "steps": {"total": 2, "passed": 2, "failed": 0, "skipped": 0}, "failures": []}
  ],
  "pending": [],
  "partial": false,
  "draftsExcluded": []
}
```
