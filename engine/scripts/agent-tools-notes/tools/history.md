Result:

```ts
interface HistoryResult extends AgentOk, WritePayload {
  action: "undo" | "redo";
  requested: number;
  done: number;
  stoppedBecause?: string;              // a step could not be taken; the steps beyond it are gone
}
```

`history` reaches the form controller's history only. It does not reach journey and PDF layout
list changes, a layout's own steps, Try it's settings or the form's identity: their results carry a
`reverse` call, and `end_session { undo: true }` and the person's Undo all take back the
assistant's own (see "Undo and what it reaches"). It reaches only the assistant's own steps
(`undo.ownSteps`) unless `beyondOwn: true`;
asking for more answers `beyond-own`. With `beyondOwn: true` a step that would change
`agentTools` is put back at once and history stops there (`protected-setting { by: "author" }`,
`details.applied` the steps before it, which stay applied and are shown and announced like any
others): the author's switch is never the assistant's, even when it is undoing the person's work.
With nothing to undo or redo it answers `ok: true` with `done: 0`. Any unsaved edit anywhere refuses it, because an undo would drop or reconcile that
edit.

Failure modes: `bad-input`, `beyond-own`, `protected-setting`, `undo-failed`, `stale`, `stopped`, `busy`, `unsaved-draft`, `wrong-mode`, `try-it-on`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, the duplicate above taken back:

```json
// call history
{"action": "undo"}
// result
{
  "ok": true,
  "tool": "history",
  "builder": "contact-request",
  "revision": 7,
  "action": "undo",
  "requested": 1,
  "done": 1,
  "undo": {"steps": 1, "ownSteps": 3, "canUndo": true, "canRedo": true}
}
```
