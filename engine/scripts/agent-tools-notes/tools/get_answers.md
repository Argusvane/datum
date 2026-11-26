Result:

```ts
interface GetAnswersResult extends AgentOk {
  locale: string;
  answers: Answer[];                    // page order
  answerCount: number;                  // before paging
  missingRequired: { path: string; id: string; label: string; page?: string }[];
  errorsShown: WordedError[];
  outstanding: { errors: number; requiredEmpty: number; onPages: string[] };   // the whole form
  unknown?: string[];                   // refs in `paths` that matched nothing
  presentation?: { id: string; label: string; value: unknown; display: string; page?: string;
                   path?: string; writable?: boolean; lastWriter?: "agent" | "other" }[];   // path: the `@` key set_answers writes
}
interface Answer {
  path: string; id: string; label: string; kind: FieldKind;
  page?: string; pageTitle?: string; group?: string;
  value?: unknown;                      // files as { name, type, size }[], never their bytes
  display?: string;                     // what the person sees: option labels, formatted dates and numbers
  hidden?: true;                        // scope "all": a hidden field, listed without value or display
  calculated?: true;
  lastWriter?: "agent" | "other";
  errors?: WordedError[];
  valueTruncated?: true;
}
```

Failure modes: `bad-input`, `too-large`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `cancelled`, `internal`.

Example, after the first page was filled:

```json
// call get_answers
{}
// result
{
  "ok": true,
  "tool": "get_answers",
  "form": "form-1",
  "revision": 4,
  "locale": "en",
  "answers": [
    {"path": "applicant_name", "id": "applicant_name", "label": "Name", "kind": "text", "page": "intro", "pageTitle": "Name", "value": "Maria Lopez", "display": "Maria Lopez", "lastWriter": "agent"},
    {"path": "age", "id": "age", "label": "Age", "kind": "number", "page": "intro", "pageTitle": "Name", "value": 41, "display": "41", "lastWriter": "agent"},
    {"path": "age_next_year", "id": "age_next_year", "label": "Age next year", "kind": "number", "page": "intro", "pageTitle": "Name", "value": 42, "display": "42", "calculated": true},
    {"path": "wants_details", "id": "wants_details", "label": "Tell us more", "kind": "boolean", "page": "intro", "pageTitle": "Name", "value": true, "display": "Yes", "lastWriter": "agent"}
  ],
  "answerCount": 4,
  "missingRequired": [],
  "errorsShown": [],
  "outstanding": {"errors": 0, "requiredEmpty": 0, "onPages": []}
}
```
