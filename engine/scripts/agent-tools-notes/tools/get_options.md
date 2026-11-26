Result:

```ts
interface GetOptionsResult extends AgentOk {
  field: { path: string; id: string; label: string; kind: "choice" | "multichoice" };
  options: { value: string; label: string; description?: string; selected: boolean }[];
  total: number;                        // after the query filter
  source: "static" | "data-source";
  sourceId?: string;
  status: "ready" | "loading" | "error";
  acceptsFreeText: boolean;
  listTruncatedBySource?: { total: number };
  current: string[];                    // the values picked now
}
```

A field whose data source has not answered yet is listed with `status: "loading"` and a warning;
one whose source failed with `status: "error"` and no text from the source.

Failure modes: `bad-input`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `unknown-field`, `no-options`, `feature-off`, `timeout`, `cancelled`, `internal`.

Example, a data-source field filtered by `query`:

```json
// call get_options
{"field": "province", "query": "on"}
// result
{
  "ok": true,
  "tool": "get_options",
  "form": "form-1",
  "revision": 7,
  "field": {"path": "province", "id": "province", "label": "Province", "kind": "choice"},
  "options": [{"value": "ON", "label": "Ontario", "selected": false}],
  "total": 1,
  "source": "data-source",
  "status": "ready",
  "acceptsFreeText": false,
  "current": [],
  "sourceId": "provinces"
}
```
