`remove_part` is the one place a language, a journey or a PDF layout is removed, and it is
consequential: the browser asks the person before each call. `kind` plays the part of `action` in
the folded tools; `id` is a language code or a document id.

Result:

```ts
interface RemovePartResult extends AgentOk, WritePayload {
  kind: "language" | "journey" | "pdf_layout";
  id: string;
  name?: string;
  changed: true;
  language?: { translationsRemoved: number; newDefault?: string; nowSingleLanguage?: true; notReached?: ("journeys" | "pdf")[] };
  journey?: { pages: number; opensAs: "journey" | "form"; newDefault?: string };
  layout?: { layoutsLeft: number; newDefault?: string };
  restorable: "history" | "until-reload";
  reverse?: { tool: "documents"; input: Record<string, unknown> };   // journey, layout: restore_removed
  undo: UndoInfo & { journaled?: true };
}
```

- A **language** goes with every translation in it across the form, its journeys and its PDF layouts, as one undo step: `history { action: 'undo' }` brings it back (`restorable: "history"`). When the language was the default another takes its place (`newDefault`). The translations are one map, so a journey's or a layout's go with the rest whether or not its designer is loaded. Removing the default language makes the next one the default first, and the designers' strings are rewritten with it: a designer that is still loading refuses that removal (`chunk-unavailable`), because the commit would miss its texts; one that is off or hidden is skipped and named in `notReached` with the warning `outside-not-swapped`.
- A **journey** or a **PDF layout** is removed with its designer's undo history. It comes back only while the page stays open, through `documents { action: 'restore_removed' }`, the person's Undo all or the notice's Restore button (`restorable: "until-reload"`; the catalogue holds the committed JSON until the page reloads or the builder is reseeded). Removing the document the person has open, with answers they typed in Try it, is refused `tried-answers`; removal ends Try it.

Failure modes: `bad-input`, `builder-required`, `builder-unknown`, `builder-not-ready`, `stopped`, `busy`, `stale`, `cancelled`, `feature-off`, `chunk-unavailable`, `unsaved-draft`, `tried-answers`, `locale-unsupported`, `unknown-document`, `refused`, `internal`.

Example, a language and its translations:

```json
// call remove_part
{"kind": "language", "id": "fr-CA"}
// result
{
  "ok": true,
  "tool": "remove_part",
  "builder": "contact-request",
  "revision": 7,
  "kind": "language",
  "id": "fr-CA",
  "name": "Français (Canada)",
  "changed": true,
  "language": {"translationsRemoved": 1},
  "restorable": "history",
  "undo": {"steps": 1, "ownSteps": 3, "canUndo": true, "canRedo": false},
  "next": ["history { action: 'undo' } puts the language and its translations back if the person changes their mind."]
}
```

Example, a PDF layout, with the call that brings it back:

```json
// call remove_part
{"kind": "pdf_layout", "id": "template-1"}
// result
{
  "ok": true,
  "tool": "remove_part",
  "builder": "contact-request",
  "revision": 7,
  "kind": "pdf_layout",
  "id": "template-1",
  "name": "T2125 (fillable)",
  "changed": true,
  "layout": {"layoutsLeft": 2},
  "restorable": "until-reload",
  "reverse": {"tool": "documents", "input": {"action": "restore_removed", "kind": "pdf_layout", "id": "template-1"}},
  "undo": {"steps": 0, "ownSteps": 3, "canUndo": true, "canRedo": false, "journaled": true},
  "next": ["Tell the person it is gone; documents { action: 'restore_removed' } brings it back while this page stays open."]
}
```

Example, bringing it back:

```json
// call documents
{"action": "restore_removed", "kind": "pdf_layout", "id": "template-1"}
// result
{
  "ok": true,
  "tool": "documents",
  "builder": "contact-request",
  "revision": 7,
  "kind": "pdf_layout",
  "action": "restore_removed",
  "documents": [
    {"id": "summary", "name": "Summary", "isDefault": true, "open": false, "layoutKind": "generated", "conditional": false},
    {"id": "cra-t2125", "name": "CRA T2125", "isDefault": false, "open": false, "layoutKind": "template", "conditional": false},
    {"id": "template-1", "name": "T2125 (fillable)", "isDefault": false, "open": true, "layoutKind": "template", "conditional": false}
  ],
  "designer": {"state": "ready", "workspace": "pdf", "openId": "template-1"},
  "changed": true,
  "document": {"id": "template-1", "name": "T2125 (fillable)", "isDefault": false},
  "reverse": {"tool": "remove_part", "input": {"kind": "pdf_layout", "id": "template-1"}},
  "undo": {"steps": 0, "ownSteps": 3, "canUndo": true, "canRedo": false, "journaled": true},
  "next": ["documents { action: 'list', kind } shows the list as it is now."]
}
```
