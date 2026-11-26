Result:

```ts
interface OpenResult extends AgentOk {
  shown: { componentId?: string; workspace: string; panel: string | null; trying: boolean; binding?: string };   // what the person sees now; binding only when the call set one
  notDone?: { what: "componentId" | "workspace" | "panel" | "tryIt" | "binding";
              reason: "feature-off" | "hidden" | "not-available" | "not-tryable" | "tried-answers" | "no-ui" | "stopped";
              message: string; triedPaths?: number }[];
  triedAnswersCleared?: number;
  queued?: "workspace"[];
}
```

`open` changes only what the person sees: it is not a history step, Stop does not reverse it, and
it keeps working after the person pressed Stop. Leaving Try it after the person typed answers
there needs `discardTriedAnswers: true` (tell them first); without it that part comes back under
`notDone` with `tried-answers`. Answers the assistant wrote itself with `try_it` are cleared
without the flag (`triedAnswersCleared` counts them). `binding` previews the form in a design-system binding from
`describe_builder.bindings` (`""` for the default look) by the same path as the View panel, so
the host hears `datum-builder-binding-change`; only the builder's preview changes, an unknown id
is `notDone` `not-available`, with the `binding-picker` feature off it is `feature-off`, and it is not journaled. Journeys and PDF layouts are opened with
`documents`, and the tried form is filled with `try_it`. Under the engine's test host, with no page, it answers `no-ui`.

Failure modes: `bad-input` (nothing asked), `unknown-component`, `no-ui`, `unsaved-draft`, `builder-required`, `builder-unknown`, `builder-not-ready`, `cancelled`, `internal`.

Example, Message selected and the Tests panel opened:

```json
// call open
{"componentId": "message", "panel": "tests"}
// result
{
  "ok": true,
  "tool": "open",
  "builder": "contact-request",
  "revision": 7,
  "shown": {"componentId": "message", "workspace": "form", "panel": "tests", "trying": false}
}
```

Example, previewing the form in a binding:

```json
// call open
{"binding": "datum"}
// result
{
  "ok": true,
  "tool": "open",
  "builder": "contact-request",
  "revision": 2,
  "shown": {"workspace": "form", "panel": "components", "trying": true, "binding": "datum"}
}
```
