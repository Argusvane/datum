Result:

```ts
interface CheckFormResult extends AgentOk {
  clean: boolean;                       // no finding at all
  counts: { errors: number; warnings: number; byArea: Record<string, number> };
  findings: Finding[];                  // errors first
  total: number;
  count: number;
  ran: Area[];
  skipped: { area: Area; check?: string; reason: "feature-off" | "chunk-unavailable" | "not-applicable" }[];
  definitionProblem?: string;
  draftsExcluded: string[];             // components whose unsaved edits were not checked
}
```

`check_form` reads the committed form, in any workspace, and never fails because one area could
not run: the area is listed under `skipped` with its reason (`chunk-unavailable` for lint until
the formula editor is loaded and for journeys until the journey checks are, `not-applicable` for
the PDF and journey areas when the form has none, `feature-off` when the host hides them).

Failure modes: `bad-input`, `unknown-component`, `builder-required`, `builder-unknown`, `builder-not-ready`, `too-large`, `cancelled`, `internal`.

Example, after the edits above:

```json
// call check_form
{}
// result
{
  "ok": true,
  "tool": "check_form",
  "builder": "contact-request",
  "revision": 7,
  "clean": true,
  "counts": {"errors": 0, "warnings": 0, "byArea": {}},
  "findings": [],
  "total": 0,
  "count": 0,
  "ran": ["id", "dataKey", "formula", "structure", "content", "rows", "tests"],
  "skipped": [
    {"area": "lint", "reason": "chunk-unavailable"},
    {"area": "structure", "check": "formDefinitionProblem", "reason": "not-applicable"},
    {"area": "pdf", "reason": "not-applicable"},
    {"area": "journey", "reason": "not-applicable"}
  ],
  "draftsExcluded": []
}
```
