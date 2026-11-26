Result:

```ts
interface SubmitResult extends AgentOk {
  status: "accepted";
  submissionId?: string;
  submittedAt: number;
  locale: string;
  message?: { title?: string; text?: string };   // the form's confirmation notice
  deliveryErrors?: number;              // a count; the handlers' text is never returned
}
```

`submit` does what the person's Submit button does: the form's checks run first, then the
host's submission. It is refused, before anything runs, when the submission must be signed by
the person (a `sign-with` on the page, a submit button that signs with a passkey, or a signature
component with participants), when a journey is not on its last page or ended on an exit page,
when the same answers were already submitted, and while another submission is in flight. The
submitted values, signatures and anything a host put on the submission are never in the result;
`get_answers` reads the answers. An accepted submit clears the record `undo_agent_changes`
works from. The page is told which answers the assistant wrote last (see "Provenance"): the
`beforeSubmit` and `afterSubmit` hooks and `datum-submit` carry the account, and a hook that
throws refuses the submission as `rejected { refusedBy: "host" }`.

Failure modes: `bad-input`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `stopped`, `busy`, `signature-required`, `exit-page`, `not-at-end`, `already-submitted`, `stale`, `rejected`, `timeout`, `cancelled`, `internal`.

Example, on a form whose submit button signs with a passkey:

```json
// call submit
{}
// result
{
  "ok": false,
  "tool": "submit",
  "code": "signature-required",
  "message": "This form's submission is signed by the person, so an assistant cannot submit it.",
  "hint": "Fill the form and tell the person it is ready: they must press Submit themselves because the submission is signed.",
  "retryable": false,
  "details": {"because": "button"},
  "form": "form-1",
  "revision": 1
}
```

Example, on the journey's second page:

```json
// call submit
{}
// result
{
  "ok": false,
  "tool": "submit",
  "code": "not-at-end",
  "message": "The form is on page 2 of 4; submit is on the last one.",
  "hint": "Move through the remaining pages with navigate {to:'next'}, then submit.",
  "retryable": false,
  "details": {"page": "contact", "remaining": 2},
  "form": "form-1",
  "revision": 9
}
```

Example, a site whose `beforeSubmit` hook refuses an answer the assistant wrote (the attestation
recipe under "Provenance"):

```json
// call submit
{}
// result
{
  "ok": false,
  "tool": "submit",
  "code": "rejected",
  "message": "The form's checks refused the submission.",
  "hint": "The site refused the submission with the message in details.errors; tell the person what it says and let them act. Do not change answers to get past it unless the person asks.",
  "retryable": false,
  "details": {"refusedBy": "host", "errors": [{"code": "hook", "message": "Please tick the declaration yourself.", "severity": "error", "source": "custom"}]},
  "form": "form-1",
  "revision": 5
}
```
