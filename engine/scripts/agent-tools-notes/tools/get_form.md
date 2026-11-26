Result:

```ts
interface GetFormResult extends AgentOk {
  rootId: string;
  total: number;                        // nodes under the start, before paging
  count: number;
  nodes: OutlineNode[] | FullNode[];    // document order; FullNode with detail "full"
  problems: number;
}
```

The outline is the committed tree: the person's unsaved edits are theirs and are not shown
(`describe_builder.draftComponentId` says one exists).

Failure modes: `bad-input`, `unknown-component`, `builder-required`, `builder-unknown`, `builder-not-ready`, `too-large`, `cancelled`, `internal`.

Example, the whole fixture form:

```json
// call get_form
{}
// result
{
  "ok": true,
  "tool": "get_form",
  "builder": "contact-request",
  "revision": 1,
  "rootId": "root",
  "total": 8,
  "count": 8,
  "nodes": [
    {"id": "root", "type": "form", "label": "Contact request", "index": 0, "depth": 0, "slots": [{"id": "content", "count": 5, "multiple": true}]},
    {"id": "full_name", "type": "text", "label": "Full name", "index": 0, "depth": 1, "parentId": "root", "slotId": "content", "path": "full_name", "required": true},
    {"id": "email", "type": "text", "label": "Email", "index": 1, "depth": 1, "parentId": "root", "slotId": "content", "path": "email", "required": true},
    {"id": "topic", "type": "select", "label": "Topic", "index": 2, "depth": 1, "parentId": "root", "slotId": "content", "path": "topic", "options": 3},
    {"id": "details", "type": "fieldset", "label": "Details", "index": 3, "depth": 1, "parentId": "root", "slotId": "content", "slots": [{"id": "content", "count": 2, "multiple": true}]},
    {"id": "message", "type": "textarea", "label": "Message", "index": 0, "depth": 2, "parentId": "details", "slotId": "content", "path": "message", "rules": ["requiredWhen"]},
    {"id": "subscribe", "type": "checkbox", "label": "Email me updates", "index": 1, "depth": 2, "parentId": "details", "slotId": "content", "path": "subscribe"},
    {"id": "submit", "type": "button", "label": "Submit", "index": 4, "depth": 1, "parentId": "root", "slotId": "content"}
  ],
  "problems": 0
}
```
