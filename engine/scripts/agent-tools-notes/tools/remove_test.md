Result: `{ id, name?, remaining }` beside the envelope and the `WritePayload`.

Failure modes: `bad-input`, `feature-off`, `unknown-test`, `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, an id no test has:

```json
// call remove_test
{"id": "test-9"}
// result
{
  "ok": false,
  "tool": "remove_test",
  "code": "unknown-test",
  "message": "No test has the id \"test-9\".",
  "hint": "Call list_tests.",
  "retryable": false,
  "details": {"id": "test-9", "known": ["test-1", "test-2"]},
  "builder": "contact-request",
  "revision": 8
}
```
