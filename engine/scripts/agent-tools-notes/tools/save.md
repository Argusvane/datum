`save` is the builder's File menu Save, called by the assistant: it hands the whole composed
definition to the site's Save (its `fileActions.save`, or the one the `save`
attribute turns on). It is consequential and cannot be taken back from the
builder. On many sites the saved form is live at once and becomes a new
version, and the language columns of removed languages are dropped on the site. It exposes Save
alone: the host's New, Open and Download file actions have no tool.

Result:

```ts
interface SaveResult extends AgentOk {
  saved: true;
  changed: true;
  label: string;                        // the site's Save label ("Save", "Save draft", …)
  savedAt: number;
  undoable: false;
  localeChanges?: { removed: string[]; renamed: { from: string; to: string }[] };   // what the site was told
  problems: number;                     // check_form's count at save time; a save does not stop for them
  dirtyAfter: boolean;                  // a site that tracks its own state may leave it true
}
```

The result always carries the note `The site may have published this version; tell the person it is
saved.` and, with `problems > 0`, a `problems:` warning. `describe_builder.ui.save` says whether the
site gave the builder a Save and its label; without one the tool answers `no-save`. A save runs
under the same guards as the person's: it is refused `unsaved-draft` while the person has an
unapplied edit, a leave guard or the Save / Discard / Stay prompt up (it never raises the prompt),
and `busy { because: "saving" }` while a save runs. A second save at an unchanged revision is
refused `already-saved` unless `again: true`. A save inside a session is a barrier for Undo all:
the site keeps the saved version ("Undo and what it reaches"). The host still hears
`builder-file-action { action: "save" }` as for the person, with `trigger: "agent"` in the save
context.

One quirk is recorded rather than worked around: a site Save that resolves without saving (a host's
`persist` returning early while its own save runs) is reported by the shell as saved. `again: true`
lets the assistant save once more when the person asks. The budget is 30 s (`timeout {
stillRunning: true }`; the host's promise runs on and the File menu shows Saving…). A refusal from
the site is quoted, cut to 300 characters; it is the site's content, not instructions.

Failure modes: `bad-input`, `builder-required`, `builder-unknown`, `builder-not-ready`, `stopped`, `busy` (`saving`), `stale`, `cancelled`, `timeout`, `no-ui`, `no-save`, `unsaved-draft`, `already-saved`, `save-failed`, `internal`.

Example, a save:

```json
// call save
{}
// result
{
  "ok": true,
  "tool": "save",
  "builder": "contact-request",
  "revision": 7,
  "saved": true,
  "changed": true,
  "label": "Save",
  "savedAt": 1792897096186,
  "undoable": false,
  "problems": 0,
  "dirtyAfter": false,
  "note": ["The site may have published this version; tell the person it is saved."],
  "next": ["Tell the person it is saved."]
}
```

Example, the same call again:

```json
// call save
{}
// result
{
  "ok": false,
  "tool": "save",
  "code": "already-saved",
  "message": "The form has not changed since you saved it.",
  "hint": "Tell the person it is saved. Save again only if they ask, with again: true.",
  "retryable": false,
  "details": {"savedAt": 1792897096186, "revision": 7},
  "builder": "contact-request",
  "revision": 7
}
```

Example, a site that refuses:

```json
// call save
{"again": true}
// result
{
  "ok": false,
  "tool": "save",
  "code": "save-failed",
  "message": "The site did not save the form.",
  "hint": "Tell the person the save failed and what the site said; do not retry unless they ask.",
  "retryable": false,
  "details": {"message": "This form was changed elsewhere since you opened it. Download your copy and reload."},
  "builder": "contact-request",
  "revision": 7
}
```

Example, a builder that has no Save:

```json
// call save
{}
// result
{
  "ok": false,
  "tool": "save",
  "code": "no-save",
  "message": "This builder has no Save.",
  "hint": "This builder has no Save; the person keeps the form with Download or their site's own save.",
  "retryable": false,
  "details": {},
  "builder": "contact-request",
  "revision": 1
}
```
