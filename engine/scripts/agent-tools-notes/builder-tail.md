### The session pair on a builder

`begin_session` and `end_session` are the page's (see "Sessions" above); on a builder page they
take `target: "builder"` when a form is on the page too, and `builder` when there are two
builders. `begin_session` answers the shape shown for a form with `locked: true` and no
`pausedTyping`; inside the session every write result carries `session: { id, ownSteps }`, and
`end_session` counts the builder's work instead of fields and rows:

```ts
interface BuilderEndSessionResult extends AgentOk {
  wasOpen: boolean;
  session?: { id: string; durationMs: number; calls: number; steps: number;
              componentsAdded: number; componentsChanged: number; componentsRemoved: number; testsWritten: number;
              undoable: number; undone: number };
}
```

`end_session` also returns the outside journal's account: an entry it could not undo comes back as
a `warnings` line (`kept: …`), the entries dropped past the journal's 100 as `journal-full: …`, and
a `save` inside the session as a `note` (see "Undo and what it reaches").

Example, a session around one write:

```json
// call begin_session
{"purpose": "Adding a consent question"}
// result
{
  "ok": true,
  "tool": "begin_session",
  "builder": "contact-request",
  "revision": 9,
  "session": {"id": "session-1", "purpose": "Adding a consent question", "startedAt": 1792897091986, "idleTimeoutMs": 45000, "revisionAtBegin": 9},
  "locked": true
}
```

```json
// call add_components
{"components": [{"type": "checkbox", "id": "consent", "label": "I agree to be contacted", "required": true}]}
// result
{
  "ok": true,
  "tool": "add_components",
  "builder": "contact-request",
  "revision": 10,
  "dryRun": false,
  "ids": ["consent"],
  "allIds": ["consent"],
  "generatedIds": {},
  "added": [
    {"id": "consent", "type": "checkbox", "label": "I agree to be contacted", "parentId": "root", "slotId": "content", "index": 2, "path": "consent"}
  ],
  "lints": [],
  "problems": [],
  "next": ["Set more properties or rules with set_properties using these ids.", "Run check_form when you are done."],
  "undo": {"steps": 1, "ownSteps": 6, "canUndo": true, "canRedo": false},
  "shown": {"componentId": "consent"},
  "session": {"id": "session-1", "ownSteps": 6},
  "warnings": ["kept-submit-last: placed before the Submit button so it stays last."]
}
```

```json
// call end_session
{"summary": "Added the consent question before Submit."}
// result
{
  "ok": true,
  "tool": "end_session",
  "builder": "contact-request",
  "revision": 10,
  "wasOpen": true,
  "session": {"id": "session-1", "durationMs": 4200, "calls": 1, "undone": 0, "steps": 1, "componentsAdded": 1, "componentsChanged": 0, "componentsRemoved": 0, "testsWritten": 0, "undoable": 1}
}
```

Example, a session around changes that are on no undo history, taken back by `end_session { undo:
true }`:

```json
// call begin_session
{"purpose": "Renaming the intake journey and bumping the version"}
// result
{
  "ok": true,
  "tool": "begin_session",
  "builder": "contact-request",
  "revision": 4,
  "session": {"id": "session-1", "purpose": "Renaming the intake journey and bumping the version", "startedAt": 1792897096186, "idleTimeoutMs": 45000, "revisionAtBegin": 4},
  "locked": true
}
```

```json
// call documents
{"action": "rename", "kind": "journey", "id": "intake", "name": "Intake (short)"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 4,
  "kind": "journey",
  "action": "rename",
  "documents": [{"id": "intake", "name": "Intake (short)", "isDefault": true, "open": false, "pages": 2}],
  "opensAs": "journey",
  "designer": {"state": "ready", "workspace": "journeys"},
  "changed": true,
  "document": {"id": "intake", "name": "Intake (short)", "isDefault": true},
  "reverse": {"tool": "documents", "input": {"action": "rename", "kind": "journey", "id": "intake", "name": "Intake"}},
  "undo": {"steps": 0, "ownSteps": 2, "canUndo": true, "canRedo": false, "journaled": true},
  "session": {"id": "session-1", "ownSteps": 2},
  "next": ["documents { action: 'list', kind } shows the list as it is now."]
}
```

```json
// call set_properties
{"edits": [{"componentId": "root", "target": "identity", "propertyPath": "version", "value": "1.4.0"}]}
// result
{
  "ok": true,
  "tool": "set_properties",
  "builder": "contact-request",
  "revision": 5,
  "written": [],
  "skipped": [],
  "lints": [],
  "problems": [],
  "next": ["Run check_form when you are done."],
  "undo": {"steps": 0, "ownSteps": 2, "canUndo": true, "canRedo": false, "journaled": true},
  "session": {"id": "session-1", "ownSteps": 2},
  "identity": {"before": {"id": "contact-request", "version": "1.3.0", "schemaVersion": "1"}, "after": {"id": "contact-request", "version": "1.4.0", "schemaVersion": "1"}},
  "reverse": {"tool": "set_properties", "input": {"edits": [{"componentId": "root", "target": "identity", "propertyPath": "version", "value": "1.3.0"}]}},
  "note": ["The identity change is not on the undo history; Undo all restores it."]
}
```

```json
// call end_session
{"summary": "Renamed the journey and set version 1.4.0.", "undo": true}
// result
{
  "ok": true,
  "tool": "end_session",
  "builder": "contact-request",
  "revision": 6,
  "wasOpen": true,
  "session": {"id": "session-1", "durationMs": 0, "calls": 2, "undone": 2, "steps": 0, "componentsAdded": 0, "componentsChanged": 0, "componentsRemoved": 0, "testsWritten": 0, "undoable": 0}
}
```

### Builder shared shapes

```ts
interface UndoInfo { steps: number; ownSteps: number; canUndo: boolean; canRedo: boolean;
                   journaled?: true }   // the change is in the outside journal: on no controller history

interface WritePayload {                // on every write result
  undo: UndoInfo;                       // steps: the history entries this call pushed
  shown?: { componentId?: string };     // what the person now sees selected
  session?: { id: string; ownSteps: number };   // while a session is open on this builder
}

interface ComponentSpec {               // add_components and replace_form, per component
  type: string;                         // from list_component_types
  id?: string;                          // omitted: "<type>_<n>"
  label?: string;
  description?: string;
  required?: boolean;                   // dropped with "required-not-offered:" where the type has none
  dataKey?: string;                     // the stored name, when not the id
  placeholder?: string;
  options?: (string | { value: string; label: string })[];
  configuration?: Record<string, unknown>;   // any other property, by get_component's names
  rules?: Record<string, string | { formula: string; run?: string }>;   // FEEL text per rule key
  collection?: Record<string, unknown>; // repeating containers
  children?: ComponentSpec[];           // into "content", else the type's first slot
  slots?: Record<string, ComponentSpec[]>;   // slot id → children (tabs, grid columns)
  parentId?: string; slotId?: string; index?: number;   // top-level entries only
}

interface OutlineNode {
  id: string; type: string;
  label: string;                        // the builder's wording, ≤ 200 characters
  parentId?: string; slotId?: string; index: number; depth: number;
  path?: string;                        // the value path; none on containers and buttons
  dataKey?: string; required?: true; hidden?: true;
  rules?: string[];                     // the rule keys set
  options?: number; source?: string;    // inline option count, data source id
  collection?: string;
  slots?: { id: string; count: number; allowedTypes?: string[]; multiple: boolean }[];
  fixed?: true;
  problems?: number;
}

interface FullNode extends OutlineNode {
  configuration: Record<string, unknown>;   // inline options capped at 25
  moreOptions?: number;
  rulesText?: Record<string, string>;
  collectionBinding?: Record<string, unknown>;
}

interface PropertyInfo {
  propertyPath: string;                 // what set_properties takes
  label: string; description?: string; section: string;
  kind: string;                         // the inspector's control: "text", "localized-text", "checkbox", "number", "options", …
  value: unknown;
  committedValue?: unknown;             // only when the person's unsaved edit differs
  choices?: { value: string; label: string }[];   // ≤ 25
  min?: number; max?: number; step?: number; placeholder?: string;
  options?: { value: string; label: string }[]; sourceId?: string;
  shape?: string;                       // what value shape to send
}

interface ComponentTypeInfo {
  type: string; label: string; group?: string; icon?: string;
  onPalette: boolean; container: boolean; fixed?: true;
  slots?: { id: string; multiple: boolean; min?: number; max?: number; allowedTypes?: string[] }[];
  configuredSlots?: "tabs" | "grid";    // slot ids come from the configuration
  onlyInside?: string[];                // e.g. step: ["steps"]
  storesValue: boolean; offersDataKey: boolean; offersRequired: boolean;
  defaults?: Record<string, unknown>;   // detail "full"
  properties?: PropertyInfo[];          // detail "full"
  hint?: string;
}

interface MoveTargetRef { parentId: string; slotId: string; pageId?: string; label: string; slotLabel?: string; depth: number; siblings: number; current?: number }

interface FormulaProblem {              // start/end: 0-based UTF-16 offsets into formula, end exclusive
  componentId?: string; propertyPath: string; formula: string;
  code: string; message: string; start: number; end: number; suggestion?: string;
}

interface ComponentProblem { componentId: string; target: string; message: string; severity: "error" | "warning";
                             source: "builder" | "data-key" | "formula" | "definition" | "note" }

type Area = "id" | "dataKey" | "formula" | "lint" | "structure" | "content" | "rows" | "pdf" | "journey" | "tests";

interface Finding {
  severity: "error" | "warning"; area: Area; code: string;
  componentId?: string; label?: string; propertyPath?: string;
  message: string;                      // ≤ 500 characters
  span?: { start: number; end: number; text: string };
  fix?: string;                         // one sentence naming the tool and property that fix it
  layoutId?: string; journeyId?: string; pageId?: string; testId?: string;
}

interface WordedTestProblem { code: string; line: number; start: number; end: number; message: string }

interface TestAffected { id: string; name: string; refs: string[] }

type Dependent =                       // what reads a component
  | { kind: "rule"; componentId: string; name: string; rule: string }
  | { kind: "journey"; journeyId: string; journeyName: string; pageId: string; pageName: string;
      where: "question" | "fills" | "value" | "rule" | "when" | "route" }
  | { kind: "pdf"; layoutId: string; layoutName: string; where: "when" | "node" | "field" | "area" | "text"; detail?: string };
```
