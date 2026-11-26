Result:

```ts
interface GetDefinitionResult extends AgentOk {
  section: string;
  value: unknown;                       // the section's JSON
  bytes: number;
  sizes?: Record<string, number>;       // section "summary": bytes per section
  hasDrafts: boolean;                   // the person has unsaved edits, which are not in the JSON
}
```

The `pdf` and `journey` sections answer `feature-off` when the host left those sides out.
Section `data-model` returns `{ dataModel: { schema, example, places, notes, draftsApplied } }`:
the JSON Schema and an example of the answers the form collects, from the Data workspace's own
model (the person's unapplied edits show there, and `draftsApplied` says so). It loads the planner
the Data workspace uses (`chunk-unavailable { what: "data-model" }` if it cannot) and is cut to the
64 KB result cap, the `example` first.

Failure modes: `bad-input`, `unknown-component`, `feature-off`, `chunk-unavailable`, `builder-required`, `builder-unknown`, `builder-not-ready`, `too-large`, `cancelled`, `internal`.

Example, the tests section:

```json
// call get_definition
{"section": "tests"}
// result
{
  "ok": true,
  "tool": "get_definition",
  "builder": "contact-request",
  "revision": 7,
  "section": "tests",
  "value": {"scenarios": [{"id": "test-1", "source": "test \"Other topic needs a message\"\n  set topic = \"other\"\n  expect message required\n"}]},
  "bytes": 133,
  "hasDrafts": false
}
```

Example, the data model of the form:

```json
// call get_definition
{"section": "data-model"}
// result
{
  "ok": true,
  "tool": "get_definition",
  "builder": "contact-request",
  "revision": 2,
  "section": "data-model",
  "value": {"dataModel": {"schema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Contact request", "type": "object", "properties": {"full_name": {"title": "Full name", "type": "string"}, "email": {"title": "Email", "type": "string"}, "topic": {"title": "Topic", "type": "string", "oneOf": [{"const": "sales", "title": "Sales"}, {"const": "support", "title": "Support"}, {"const": "other", "title": "Other"}]}, "message": {"title": "Message", "description": "Required when a rule of the form says so.", "type": "string"}, "subscribe": {"title": "Email me updates", "type": "boolean"}}, "required": ["full_name", "email"], "additionalProperties": false}, "example": {"full_name": "text", "email": "text", "topic": "sales", "message": "text", "subscribe": false}, "places": 5, "notes": [], "draftsApplied": false}},
  "bytes": 755,
  "hasDrafts": false
}
```
