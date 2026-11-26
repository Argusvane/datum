Result on a form:

```ts
interface BeginSessionResult extends AgentOk {
  session: { id: string; purpose: string; startedAt: number; idleTimeoutMs: 45000; revisionAtBegin: number };
  resumed?: true;                       // a session was already open; the purpose was updated
  locked: boolean;                      // true on <datum-form>; false where there is no page to lock (an engine test host)
  pausedTyping: boolean;                // the person was in a field; their keystroke was kept and focus is on Stop
}
```

On a builder page the result has the same shape with `locked: true` and no `pausedTyping`;
see "Sessions" and "The session pair on a builder". `begin_session` is not refused because the
person is in a field: the field is blurred by the inert body and its pending keystroke is kept.

Failure modes: `bad-input`, `target-required`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `stopped`, `busy`, `cancelled`, `internal`.

Example, under the engine's test host (no page to lock):

```json
// call begin_session
{"purpose": "Filling in your application from the letter you pasted"}
// result
{
  "ok": true,
  "tool": "begin_session",
  "form": "form-1",
  "revision": 11,
  "session": {"id": "session-1", "purpose": "Filling in your application from the letter you pasted", "startedAt": 1792897091985, "idleTimeoutMs": 45000, "revisionAtBegin": 11},
  "locked": false,
  "pausedTyping": false
}
```
