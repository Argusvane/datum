Result:

```ts
interface SetPropertiesResult extends AgentOk, WritePayload {
  written: { componentId: string; propertyPath: string; target: "configuration" | "rules"; previous: unknown; value: unknown }[];
  skipped: ({ componentId: string; propertyPath: string; problem: FormulaProblem }
          | { componentId: string; propertyPath: string; code: "protected-setting"; details: { propertyPath: string; by: "host" | "author" } }
          | { componentId: string; propertyPath: string; code: "bad-input"; details: { problems: { key: string; expected: string }[] } })[];   // partial: true only
  lints: FormulaProblem[];
  problems: ComponentProblem[];
  next: string[];
  identity?: { before: { id: string; version: string; schemaVersion: string }; after: { id: string; version: string; schemaVersion: string } };   // target "identity"
  undo: UndoInfo & { journaled?: true };   // journaled with an identity change
  reverse?: { tool: "set_properties"; input: Record<string, unknown> };   // identity changes
}
```

A `propertyPath` is a configuration path (`label`, `messages.required`, `tabs.0.label`) or a rule
as `rules.<key>`; a leading `configuration.` is read without it (`configuration-prefix:`).
`id`, `type`, `children`, `collection` and the whole `rules` object are refused `bad-input` with
a hint naming the tool that changes them. A name the inspector does not list is written anyway
with an `unknown-property:` warning, and `"true"` / `"false"` or a numeral string sent to a
checkbox or number property is coerced (`coerced:`). Any other value of the wrong type for its
property (`"yes"` for a checkbox, a boolean or `"abc"` for a number, a non-object for the root's
`chrome`, `messages` or `print`) is refused `bad-input`, and in `partial` mode lands in `skipped`
with `code: "bad-input"`. A dotted path under a property that holds one plain value (`required.x`,
`min.x`, or `data.answersFree.x` where the property's own path is dotted) is refused `bad-input`
the same way (`required takes a checkbox; write it at required`),
so an object never replaces a boolean or a number. Values the inspector's Apply would refuse
(a bad pattern, a minimum over its maximum, a bad data key) are refused `blocked-property`. An
edit that changes nothing is written as nothing: `ok: true`, `written: []`, `undo.steps: 0`.

With `target: "identity"` on the root, `propertyPath` is `id`, `version` or `schemaVersion` of the
form itself (non-empty strings; the id at most 128 characters, the others 64). That change is
not on the undo history: the result says so (`undo.journaled: true`, a `reverse` call, and a note;
a changed `id` adds that sites store forms by id), and Undo all and `end_session { undo: true }`
put it back. A host that owns the identity refuses it (`protected-setting { by: "host" }`). The
same refusal covers any path the site manages (the builder's `managedSettings`), a write to a
parent that would change a managed descendant, and, in `partial` mode, lands in `skipped`. Values
for `chrome.header` and `chrome.footer` (or a write to `chrome` holding them) are read as the
renderer reads them, and a part it would drop is refused `blocked-property` instead of vanishing.

`agentTools` on the form root (a configuration path, `agentTools` or one under it) is refused
`protected-setting { by: "author" }`: whether assistants may fill the form is the form author's
choice, made in Form settings, Browser assistants, and the same refusal lands in `skipped` in
`partial` mode. A site that lists `agentTools` in `managed-settings` gets `by: "host"` instead.

Example, the path refused:

```json
// call set_properties
{"edits": [{"componentId": "root", "propertyPath": "agentTools", "value": "allowed"}]}
// result
{
  "ok": false,
  "tool": "set_properties",
  "code": "protected-setting",
  "message": "agentTools is the form author's switch for assistants; nothing was written.",
  "hint": "Whether assistants may fill this form is the author's choice in Form settings; tell the person.",
  "retryable": false,
  "details": {"propertyPath": "agentTools", "by": "author"},
  "builder": "contact-request",
  "revision": 1
}
```

Failure modes: `bad-input`, `too-large`, `unknown-component`, `formula-error`, `blocked-property`, `protected-setting`, `data-path-conflict`, `structure-limit`, `stale`, `stopped`, `busy`, `unsaved-draft`, `refused`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, a placeholder and a rule in one step:

```json
// call set_properties
{"edits": [{"componentId": "email", "propertyPath": "placeholder", "value": "name@example.com"}, {"componentId": "message", "propertyPath": "rules.requiredWhen", "value": "topic = \"other\" or topic = \"support\""}]}
// result
{
  "ok": true,
  "tool": "set_properties",
  "builder": "contact-request",
  "revision": 3,
  "written": [
    {"componentId": "email", "propertyPath": "placeholder", "target": "configuration", "previous": null, "value": "name@example.com"},
    {"componentId": "message", "propertyPath": "rules.requiredWhen", "target": "rules", "previous": "topic = \"other\"", "value": "topic = \"other\" or topic = \"support\""}
  ],
  "skipped": [],
  "lints": [],
  "problems": [],
  "next": ["Run check_form when you are done."],
  "undo": {"steps": 1, "ownSteps": 2, "canUndo": true, "canRedo": false},
  "shown": {"componentId": "email"}
}
```

Example, the form's version (on no undo history, so the result carries its reverse):

```json
// call set_properties
{"edits": [{"componentId": "root", "target": "identity", "propertyPath": "version", "value": "1.3.0"}]}
// result
{
  "ok": true,
  "tool": "set_properties",
  "builder": "contact-request",
  "revision": 2,
  "written": [],
  "skipped": [],
  "lints": [],
  "problems": [],
  "next": ["Run check_form when you are done."],
  "undo": {"steps": 0, "ownSteps": 0, "canUndo": false, "canRedo": false, "journaled": true},
  "identity": {"before": {"id": "contact-request", "version": "1.0.0", "schemaVersion": "1"}, "after": {"id": "contact-request", "version": "1.3.0", "schemaVersion": "1"}},
  "reverse": {"tool": "set_properties", "input": {"edits": [{"componentId": "root", "target": "identity", "propertyPath": "version", "value": "1.0.0"}]}},
  "note": ["The identity change is not on the undo history; Undo all restores it."]
}
```
