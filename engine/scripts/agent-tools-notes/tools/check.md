Result:

```ts
interface CheckResult extends AgentOk {
  scope: "page" | "form";
  page?: PageRef;
  passes: boolean;                      // no blocking error
  refusedBy?: "validation" | "journey" | "wasm";
  errors: WordedError[];                // blocking, ≤ 100
  notices: WordedError[];               // warnings and information, not blocking
  missingRequired: { path: string; id: string; label: string; page?: string }[];
  byPage?: Record<string, number>;      // journey, scope "form": blocking errors per page
  byStep?: Record<string, number>;      // steps: per step
  moreErrors?: number;
  serverChecks: "none" | "on-continue" | "on-submit";
}
```

`check` stores nothing and shows nothing new to the person (the form repaints once; values,
shown errors and the revision stay as they were). `serverChecks` says when the journey's own
server checks run: `on-continue` when a page check is server-side, `on-submit` when the journey's
end check is; a form without a journey says `none`, and its `note` says that a server may run
more when you submit.

Failure modes: `bad-input`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `busy`, `timeout`, `cancelled`, `internal`.

Example, the whole journey:

```json
// call check
{"scope": "form"}
// result
{
  "ok": true,
  "tool": "check",
  "form": "form-1",
  "revision": 9,
  "scope": "form",
  "passes": true,
  "errors": [],
  "notices": [],
  "missingRequired": [],
  "serverChecks": "none",
  "note": ["These are the form's own checks; a server may run more when you submit."],
  "byPage": {"intro": 0, "contact": 0, "details": 0, "review": 0}
}
```
