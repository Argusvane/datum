Result:

```ts
interface EditRowsResult extends AgentOk {
  collection: { path: string; id: string; label: string };
  action: "add" | "remove";
  indexes: number[];                    // the rows added, or the one removed
  rows: { count: number; min: number; max: number | null; canAdd: boolean; canRemove: boolean };
  rowPaths?: Record<string, string>[];  // add: per new row, column key → path
  refusedValues?: { path: string; code: string; message: string; hint: string; details?: Record<string, unknown> }[];
  removed?: Record<string, unknown>;    // remove: the row's values
  errors: WordedError[];                // problems now on the touched rows
  elsewhere?: { page?: string; step?: string };   // the table is on another page or step
  undoable: true;
}
```

A cell value that does not fit is listed in `refusedValues` and the row is still added with the
cell empty. A row the person typed in is removed only with `force: true`, after asking them.

Failure modes: `bad-input`, `too-large`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `stopped`, `busy`, `stale`, `unknown-field`, `not-a-table`, `not-writable`, `field-in-use`, `rows-locked`, `rows-limit`, `no-such-row`, `person-data`, `cancelled`, `internal`.

Example, a row added and filled by labels; the problem listed is on the row that was already
there:

```json
// call edit_rows
{"collection": "grid", "action": "add", "values": {"when": "2026-10-02", "amount": 18.5, "category": "Meal"}}
// result
{
  "ok": true,
  "tool": "edit_rows",
  "form": "form-1",
  "revision": 6,
  "collection": {"path": "grid", "id": "grid", "label": "Expenses"},
  "action": "add",
  "indexes": [1],
  "rowPaths": [{"when": "grid[1].when", "amount": "grid[1].amount", "category": "grid[1].category"}],
  "rows": {"count": 2, "min": 1, "max": 3, "canAdd": true, "canRemove": true},
  "errors": [
    {"code": "required", "message": "This field is required", "severity": "error", "source": "client", "path": "grid[0].amount", "id": "amount", "label": "Amount"}
  ],
  "undoable": true
}
```

Example, a row that does not exist:

```json
// call edit_rows
{"collection": "grid", "action": "remove", "index": 5}
// result
{
  "ok": false,
  "tool": "edit_rows",
  "code": "no-such-row",
  "message": "'grid' has 2 rows; there is no row 5.",
  "hint": "The table has 2 rows; add one with edit_rows, or pass the whole table as an array to set_answers.",
  "retryable": false,
  "details": {"collection": "grid", "index": 5, "rows": 2},
  "form": "form-1",
  "revision": 6
}
```
