Result:

```ts
interface GetComponentResult extends AgentOk {
  node: FullNode;
  location: { parentId?: string; slotId?: string; index?: number };
  children?: { slotId: string; ids: string[]; allowedTypes?: string[]; multiple: boolean }[];
  properties: PropertyInfo[];           // what set_properties takes, with the person's unsaved edit applied
  rules: Record<string, { formula: string; run?: string; parses: boolean; problem?: FormulaProblem }>;
  ruleKeys: string[];                   // the rule keys this component may carry
  problems: { target: string; message: string }[];           // the builder's own findings on it
  notes: { target?: string; message: string; severity?: "error" | "warning"; code?: string }[];   // code: set when the note is one a check also reports, so a caller can tell the two apart
  cssClassWarning?: string;
  dependents: { items: Dependent[]; lines: string[] };       // what reads this component, worded
  moveTargets: MoveTargetRef[];         // where move_component may put it (≤ 50)
  hasUnsavedDraft: boolean;
}
```

A property whose unsaved edit differs from the form carries `committedValue` beside `value`.

Failure modes: `bad-input`, `unknown-component`, `builder-required`, `builder-unknown`, `builder-not-ready`, `too-large`, `cancelled`, `internal`.

Example, the Topic dropdown (Message's rule reads it):

```json
// call get_component
{"componentId": "topic"}
// result
{
  "ok": true,
  "tool": "get_component",
  "builder": "contact-request",
  "revision": 1,
  "node": {"id": "topic", "type": "select", "label": "Topic", "index": 2, "depth": 1, "parentId": "root", "slotId": "content", "path": "topic", "options": 3, "configuration": {"label": "Topic", "options": [{"value": "sales", "label": "Sales"}, {"value": "support", "label": "Support"}, {"value": "other", "label": "Other"}]}},
  "location": {"parentId": "root", "slotId": "content", "index": 2},
  "properties": [
    {"propertyPath": "label", "label": "Label", "section": "content", "kind": "localized-text", "value": "Topic", "shape": "string, in the form's default language (translations: languages { action: 'translate' })"},
    {"propertyPath": "description", "label": "Description", "section": "content", "kind": "localized-text", "value": null, "shape": "string, in the form's default language (translations: languages { action: 'translate' })"},
    {"propertyPath": "placeholder", "label": "Placeholder", "section": "content", "kind": "localized-text", "value": null, "shape": "string, in the form's default language (translations: languages { action: 'translate' })"},
    {"propertyPath": "tooltip", "label": "Tooltip", "section": "content", "kind": "localized-text", "value": null, "description": "Shown on hover, and as the control's accessible description.", "shape": "string, in the form's default language (translations: languages { action: 'translate' })"},
    {"propertyPath": "dataKey", "label": "Data key", "section": "data", "kind": "text", "value": null, "description": "The name this answer is stored under in the submitted data. Blank uses the ID. Two answers in one object cannot share a name. Letters, digits, _ and - only.", "placeholder": "topic"},
    {"propertyPath": "options", "label": "Options", "section": "data", "kind": "options", "value": [{"value": "sales", "label": "Sales"}, {"value": "support", "label": "Support"}, {"value": "other", "label": "Other"}], "description": "The choices this field offers. A data source, when one is set, takes precedence.", "options": [{"value": "sales", "label": "Sales"}, {"value": "support", "label": "Support"}, {"value": "other", "label": "Other"}], "shape": "[{ value, label }], or set configuration.data.sourceId for a data source"},
    {"propertyPath": "data.sourceId", "label": "Data source", "section": "data", "kind": "select", "value": null, "description": "Options come from this source; it takes precedence over inline options.", "choices": [{"value": "", "label": "— none —"}, {"value": "provinces", "label": "provinces"}]},
    {"propertyPath": "data.answersFree", "label": "Answers may be free text", "section": "data", "kind": "checkbox", "value": null, "description": "Suggestions are not the only answers allowed: the answer is not checked against the data source's list (it still keeps the field's own limits). Leave off to refuse an answer the list does not hold."},
    {"propertyPath": "required", "label": "Required", "section": "validation", "kind": "checkbox", "value": null},
    {"propertyPath": "messages", "label": "Validation messages", "section": "validation", "kind": "messages", "value": null, "description": "This field's own text per validation code, over the form's and the page's.", "shape": "{ <code>: text }"},
    {"propertyPath": "disabled", "label": "Disabled", "section": "behavior", "kind": "checkbox", "value": null, "description": "Always disabled. Use a rule's “Enabled when” for a conditional one."},
    {"propertyPath": "hideLabel", "label": "Hide label", "section": "presentation", "kind": "checkbox", "value": null, "description": "Still announced by screen readers."},
    {"propertyPath": "cssClass", "label": "CSS classes", "section": "presentation", "kind": "text", "value": null, "description": "Space-separated class names, added to this component's element."},
    {"propertyPath": "print.on", "label": "Shown", "section": "print", "kind": "select", "value": null, "description": "On screen only leaves it off every printed copy, its contents with it. On paper only is not offered here: this holds an answer, or holds something that does, and a person filling the form must see it.", "choices": [{"value": "", "label": "On screen and on paper"}, {"value": "screen", "label": "On screen only"}, {"value": "paper", "label": "On paper only"}]},
    {"propertyPath": "print.breakBefore", "label": "Start on a new page", "section": "print", "kind": "checkbox", "value": null, "description": "A printed copy begins a new sheet at this component."},
    {"propertyPath": "print.show", "label": "When a rule hides it", "section": "print", "kind": "select", "value": null, "description": "How it prints from the live form. A read-only form prints what it shows.", "choices": [{"value": "", "label": "As on screen"}, {"value": "always", "label": "Always, with a note while a rule hides it"}, {"value": "answered", "label": "Only when it has an answer"}]},
    {"propertyPath": "print.note", "label": "Note on paper", "section": "print", "kind": "localized-text", "value": null, "description": "Printed beside it when it prints while a rule hides it. Empty: \"Complete only if it applies to you.\"", "shape": "string, in the form's default language (translations: languages { action: 'translate' })"},
    {"propertyPath": "pdf.rendition", "label": "PDF rendition", "section": "pdf", "kind": "select", "value": null, "description": "How this appears in a generated PDF. A layout's binding may still override it.", "choices": [{"value": "", "label": "Default — the PDF theme's choice, else the component's"}, {"value": "text", "label": "Text — the label and the answer"}, {"value": "field", "label": "Field — fillable in a PDF viewer"}, {"value": "checklist", "label": "Checklist — every option, the chosen ones ticked"}, {"value": "ruled", "label": "Ruled — a blank line to write on"}]},
    {"propertyPath": "pdf.exclude", "label": "Leave out of PDFs", "section": "pdf", "kind": "checkbox", "value": null, "description": "Never printed, even where a layout binds it."}
  ],
  "rules": {},
  "ruleKeys": ["visibleWhen", "requiredWhen", "enabledWhen", "readonlyWhen", "validWhen", "value", "defaultValue"],
  "problems": [],
  "notes": [],
  "dependents": {"items": [{"kind": "rule", "componentId": "message", "name": "Message", "rule": "requiredWhen"}], "lines": ["Rule “requiredWhen” of Message"]},
  "moveTargets": [
    {"parentId": "root", "slotId": "content", "label": "root", "depth": 0, "siblings": 4, "current": 2},
    {"parentId": "details", "slotId": "content", "label": "Details", "depth": 1, "siblings": 2}
  ],
  "hasUnsavedDraft": false
}
```
