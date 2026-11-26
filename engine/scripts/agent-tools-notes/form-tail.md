### Shared shapes

```ts
type FieldKind = "text" | "number" | "date" | "boolean" | "choice" | "multichoice" | "collection" | "file" | "signature" | "group";

interface Field {
  id: string;
  path: string;                         // the key set_answers takes (the value path)
  type: string;                         // the component type as authored
  kind: FieldKind;
  label: string;
  description?: string;
  required: boolean;
  visible: boolean;
  writable: boolean;
  whyNotWritable?: "hidden" | "disabled" | "readonly" | "calculated" | "unfillable" | "group" | "presentation";
  unfillableKind?: "file" | "signature" | "nested-rows";
  page?: string;                        // journey page id or step id
  parent?: string;                      // the parent component's id
  hasRules?: ("visibleWhen" | "requiredWhen" | "enabledWhen" | "readonlyWhen" | "validWhen" | "value")[];   // names only
  lastWriter?: "agent" | "other";
  // detail "full" and visible fields only:
  value?: unknown;
  display?: string;
  constraints?: { min?: number | string; max?: number | string; step?: number; minLength?: number; maxLength?: number; pattern?: string;
                  accept?: string[]; maxFileSize?: number; maxFiles?: number; multiple?: boolean };
  options?: { value: string; label: string; description?: string }[];   // the first 25
  moreOptions?: number;
  optionsSource?: "static" | "data-source";
  optionsStatus?: "ready" | "loading" | "error";
  acceptsFreeText?: boolean;
  rows?: { collection: string; count: number; min: number; max: number | null; canAdd: boolean; canRemove: boolean;
           columns: { key: string; id: string; label: string; kind: FieldKind; required: boolean }[];
           entries?: { index: number; values: Record<string, unknown>; display: Record<string, string> }[]; moreRows?: number };
  errors?: WordedError[];
  valueTruncated?: true;
}

interface Page {
  id: string; title: string; kind: "questions" | "exit" | "step";
  index: number; number?: number;
  current: boolean; completed: boolean; reachable: boolean; onPath: boolean; final: boolean;
  container?: string;                   // steps: the steps container's id
  errors?: number;                      // steps: errors on the step
}
interface PageRef { id: string; title: string; number?: number; total?: number }

interface WordedError {
  path?: string; id?: string; label?: string;
  code: string;                         // "required", "pattern", a rule's own code, …
  message: string;                      // in the form's current language
  severity: "error" | "warning" | "info";
  source: "client" | "wasm" | "server" | "custom";
  page?: string;
}
```

Every bad argument is reported at once. For example, `get_options` with `{ "field": 3, "limit": 0 }`:

```json
// call get_options
{"field": 3, "limit": 0}
// result
{
  "ok": false,
  "tool": "get_options",
  "code": "bad-input",
  "message": "The arguments do not fit get_options's schema.",
  "hint": "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
  "retryable": false,
  "details": {"problems": [{"key": "field", "expected": "a string"}, {"key": "limit", "expected": "at least 1"}]},
  "form": "form-1",
  "revision": 11
}
```
