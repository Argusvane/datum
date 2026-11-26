Result:

```ts
interface ListComponentTypesResult extends AgentOk {
  types: ComponentTypeInfo[];
  total: number;
  count: number;
  notPlaceable: string[];               // registered but never added by hand ("form")
  rootSlots: string[];
  rules: { id: string; dataKey: string; slots: string };     // the id grammar, the data key rule, how slots work
}
```

The list is the builder's registry, so it differs per host; palette labels come from the host or
its plugins, which is why this tool alone among the reads is not marked as echoing author text.

Failure modes: `bad-input`, `unknown-type` (with `type`), `builder-required`, `builder-unknown`, `builder-not-ready`, `too-large`, `cancelled`, `internal`.

Example, the palette's Layout group:

```json
// call list_component_types
{"group": "Layout"}
// result
{
  "ok": true,
  "tool": "list_component_types",
  "builder": "contact-request",
  "revision": 1,
  "types": [
    {"type": "fieldset", "label": "Group", "onPalette": true, "container": true, "storesValue": false, "offersDataKey": false, "offersRequired": false, "group": "Layout", "slots": [{"id": "content", "multiple": true}]},
    {"type": "panel", "label": "Panel", "onPalette": true, "container": true, "storesValue": false, "offersDataKey": false, "offersRequired": false, "group": "Layout", "slots": [{"id": "content", "multiple": true}]},
    {"type": "tabs", "label": "Tabs", "onPalette": true, "container": true, "storesValue": false, "offersDataKey": false, "offersRequired": false, "group": "Layout", "slots": [{"id": "tab_1", "multiple": true}, {"id": "tab_2", "multiple": true}], "configuredSlots": "tabs", "hint": "slot ids are the ids in configuration.tabs; use `slots` in a component spec"},
    {"type": "steps", "label": "Steps", "onPalette": true, "container": true, "storesValue": false, "offersDataKey": false, "offersRequired": false, "group": "Layout", "slots": [{"id": "content", "multiple": true, "allowedTypes": ["step"]}], "hint": "takes only step children; give each step its own children"},
    {"type": "grid", "label": "Grid", "onPalette": true, "container": true, "storesValue": false, "offersDataKey": false, "offersRequired": false, "group": "Layout", "slots": [{"id": "column_1", "multiple": true}, {"id": "column_2", "multiple": true}], "configuredSlots": "grid", "hint": "slot ids are column_1..column_N from configuration.columns; use `slots` in a component spec"},
    {"type": "dataGrid", "label": "Table", "onPalette": true, "container": true, "storesValue": false, "offersDataKey": false, "offersRequired": false, "group": "Layout", "slots": [{"id": "content", "multiple": true, "allowedTypes": ["text", "number", "select", "date", "checkbox"]}], "hint": "its children are the columns: leaf fields only"}
  ],
  "total": 6,
  "count": 6,
  "notPlaceable": ["form"],
  "rootSlots": ["content"],
  "rules": {"id": "A letter, then letters, digits, _ or -; at most 128 characters; unique across the form.", "dataKey": "Letters, digits, _ or -; not digits only; at most 128; unique within its data scope.", "slots": "Containers hold children by slot id; most have one slot named content. tabs: one slot per entry of configuration.tabs (its id). grid: column_1..column_N. steps takes only step children; button-group only button; data-grid only leaf fields."}
}
```
