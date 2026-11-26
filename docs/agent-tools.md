# Agent tools

A `<datum-form>` can hand a browser assistant a small set of tools for the form on the page: read
its structure and answers, fill fields, add table rows, move between pages, check, switch the
language, submit, and put back what it changed. The browser's agent API (WebMCP,
`document.modelContext`) lists them beside the page, and page script gets the same tools and the
same results through `agentTools()` and `executeAgentTool()`. The decision to build them is
ADR 0155.

A `<datum-form-builder>` hands the assistant the builder's own tools the same way: read the form
being built, add, change, move and remove its components and rules, check it, and write and run
its tests, each change one step on the builder's Undo like the author's own edits.

Both go further. A `<datum-form>` can also save, restore or delete the form's draft and hand
the person a PDF of it, and it tells the page which answers the assistant wrote (see
"Provenance"). A `<datum-form-builder>` can also try the form the way a respondent would, manage
its languages and translations, open and change its journeys and PDF layouts, and save it through
the site's own Save. Anything that leaves the page or cannot be taken back is a consequential
tool: the browser asks the person first (see "What leaves the page").

A form's author and the page's host each get a word. The author says, in the definition,
whether assistants may fill the form (`root.configuration.agentTools`, set in the builder's Form
settings, Browser assistants). The host sets `agent-access` on the `<datum-form>`: the host
enforces (`always`), the definition decides (`definition`, the default) or the host forbids
(`never`). A form that is not allowed registers sealed: every call but `describe_form` answers
`agent-off` (see "Turning assistants off for a form").

The reason is that people already paste letters, itineraries and earlier applications into an
assistant and ask it to fill a form for them. Without tools the assistant guesses at the page's
markup; with them it reads what the form itself knows (each field's path, kind, options, rules
and errors in the form's language) and writes through the same runtime calls the person's typing
uses, so every rule, check and calculation runs exactly as it would for them.

The person stays in charge. Every write is shown (the field is outlined and the change is read
out), can be undone, and never moves the person's page or the field they are typing in. When an assistant moves the page, restores a draft or submits and is refused, the form's own focus moves stay quiet (for a page move and a restored draft while the person's focus is outside the form, for a refused submit wherever it is): the page and the error summary still paint, nothing takes focus, and the quiet ends when the move settles. A longer piece of work runs in a session the person sees as a banner with a **Stop** button. What only the
person can do, such as signing, choosing a file or pressing Submit on a signed form, has no tool:
the assistant is told why and is asked to hand back to them.

## Turning it on

The tools are opt-in. `agent` is a word of the `features` attribute (ADR 0143), and it is the
first word that is **not** part of `all` or of the absent attribute: a page that says nothing, or
`features="all"`, gets no agent tools and never fetches their file.

```html
<datum-form id="travel-claim" src="/forms/travel-claim.json" features="all agent" agent-access="definition"></datum-form>
```

`features="minimal agent"` gives the tools to a single-page form with nothing else switched on.

The `agent` word loads the tools; on a `<datum-form>` the `agent-access` attribute says who decides
whether they run, in three words:

| `agent-access` | Who decides | What the element does |
|---|---|---|
| `always` | the host enforces | registers the tools live whatever the definition says, an author's `agentTools: "off"` included |
| `definition` (the default when the attribute is absent) | the definition decides | registers the tools live when the form's `root.configuration.agentTools` is `"allowed"`, sealed when it is `"off"` or absent |
| `never` | the host forbids | registers nothing and loads nothing for this element, whatever the page-wide `features` list says |

Without the `agent` word the attribute does nothing. Changing it on a connected element never
rebuilds the form and never drops an answer: between `always` and `definition` the registration
re-reads its access, and to or from `never` the tools are withdrawn or registered as an
`agent`-only `features` change does. The attribute is read on `<datum-form>` only:
`<datum-form-builder>` registers on the token alone, because the author's switch concerns the
people who fill a form, not the person building it.
On `<datum-form-builder>` the same word registers the builder's tools beside the session
pair (see "The builder's tools" below). Adding or removing `agent` on a connected element
never rebuilds the form and never drops an answer: the element only registers or withdraws its
tools. The engine's own `<datum-builder>` and `<datum-form-renderer>` elements, used bare (a host
page that uses either bare), register no tools. Leaving `agent` out of one element's `features`, or writing
`agent-access="never"` on it, is also how a host keeps assistants off that form (see "Turning
assistants off for a form").

What the host's page needs besides the attribute:

- **A browser with the agent API.** Chrome 155 ships WebMCP behind a flag:
  `chrome://flags/#enable-webmcp-testing` ("WebMCP for testing"), or the switch
  `--enable-features=WebMCP` on the command line. An origin trial, while Chrome offers one, is the
  host's to register: its `<meta http-equiv="origin-trial">` tag goes in the page like any other.
  Without the API the tools still work from page script (`executeAgentTool()`), and the element
  reports `registered: false, reason: "no-api"` in `datum-agent-tools`.
- **Permissions-Policy.** Chrome gates the API on the `tools` feature. A page served with
  `Permissions-Policy: tools=()` keeps `document.modelContext` but every call is refused, and the
  element reports `reason: "not-allowed"`. A host that sends a policy header names
  `tools=(self)`; a form in an iframe needs `allow="tools"` on the `<iframe>`.
- **The chunk.** The tools are a lazy chunk per bundle, `datum-form-agent-<hash>.js` and
  `datum-builder-agent-<hash>.js`, fetched the first time an element with `agent` (and an `agent-access` other than `never`) connects
  (the `.iife.js` bundles carry it inline). The builder also has three body chunks,
  `datum-builder-agentpart-{try,languages,documents}-<hash>.js`, each fetched on its tool's first
  call. Keep the files beside the bundle; `dist/feature-files.json` lists all five under `agent`,
  so a host that never uses the tools can leave them off the server. A
  missing file is reported once as `datum-error`, the form keeps working, and the next call asks
  again.
- **The form bundle for forms.** A page that loads only `datum-builder.js` gets the builder's
  agent chunk only: a `<datum-form features="all agent">` there reports `datum-error` and its
  `agentTools()` rejects with a message that says to load `datum-form.js` first. A page that loads
  `datum-form.js` before `datum-builder.js` gets both, under one set of tools.

The element never retries a refused registration on its own; changing `features` (removing
`agent` and adding it again) retries.

## Page script API

Both `<datum-form>` and `<datum-form-builder>` carry two methods:

- `agentTools(): Promise<readonly AgentTool[]>` lists every tool the page currently has (each
  form tool once however many forms there are, the session pair once), with the same names,
  titles, descriptions and schemas the browser holds.
- `executeAgentTool(name: string, input?: unknown): Promise<AgentToolResult>` runs one through
  the same pipeline the browser uses and resolves to the same envelope (below). It never rejects
  for a tool's refusal: a refusal is an envelope with `ok: false`.

Both reject with the ADR 0143 message (`agentTools() is not available: the features list of
this <datum-form> does not include "agent"`) when the token is absent, and with a `ChunkLoadError` (after one `datum-error`) when the
chunk could not be fetched. A `<datum-form>` whose `agent-access` is `"never"` rejects too, with
`agentTools() is not available: agent-access is "never" on this <datum-form>` (the method's name
first). A sealed form does not reject: it lists its tools and every call but `describe_form`
answers `agent-off`. `<datum-form>` also has the `agentAccess` property, `"always" | "definition" |
"never"`, the attribute `agent-access` as a property (`undefined` when the attribute is absent,
and then the default, `definition`, applies; a word outside the three throws a `TypeError`).

```js
const form = document.querySelector("datum-form");
const described = await form.executeAgentTool("describe_form", {});
const written = await form.executeAgentTool("set_answers", { answers: { applicant_name: "Maria Lopez" } });
```

The element dispatches three events (`bubbles`, `composed`):

| Event | `detail` | When |
|---|---|---|
| `datum-agent-action` | `{ tool, target: "form" \| "builder", handle, readOnly, input, outcome: { ok, code? }, durationMs, revision, sessionId?, changed, trigger: "agent", paths?, componentIds?, undoSteps?, consequential? }`. `input` is the validated input with strings cut to 1 KB and file-like values left out; `paths` are the value paths a form tool wrote during the call; `componentIds` the components a builder tool touched or created, and `undoSteps` the history entries a builder write pushed. `readOnly` is true for a read tool and for a read action of a folded tool (`try_it` `read`, `languages` `list` and `texts`, `documents` `list`). `consequential: true` is on every call of a tool whose annotations carry `consequentialHint`, whatever its outcome, so an audit log can flag the acts the browser was asked to confirm. | After every call, read or write, success or refusal. `submit` sends one more first, with `outcome: { ok: true, code: "started" }`, just before the form submits, so a `datum-submit` listener can tell the two apart. |
| `datum-agent-session` | `{ phase: "begin" \| "end" \| "stop" \| "idle" \| "cancel" \| "allow-again", sessionId, target, handle, purpose?, summary?, reason?, undone?, resumed? }` | Every session transition (below). `resumed: true` on a second `begin` that updated the purpose. |
| `datum-agent-tools` | `{ registered, reason?: "no-api" \| "not-allowed" \| "duplicate" \| "error", tools: string[], target, handle, access: "live" \| "sealed" \| "off", by?: "author" \| "unset" }` | When the element's tools are registered with the browser, on every `features` change, when an `agent-access` or definition change moves the access, and on withdrawal (`registered: false, tools: [], access: "off"`: `agent-access="never"`, the token removed, or the element off the page). `tools` names everything the browser holds for the page. `access` says what the tools do: `live`, they run; `sealed`, their names are registered and every call but `describe_form` answers `agent-off`, with `by` saying whether the form's author turned assistants off (`author`) or has not allowed them (`unset`). `registered` keeps its meaning (the browser holds the page's tools), so a sealed form reports `registered: true`. A form whose definition arrives later (`src`) may report `sealed, by: "unset"` once before its runtime lands, then the real access. A builder says `live` while registered. |

Some `datum-agent-action` events are not a tool's own result. One is submit's `started` event.
The others report a session's undo, and their shape depends on the target. On a form, the session
replay sends one each time it runs: the banner's **Undo all**, **Stop**, and `end_session { undo: true }`
(besides that call's own event) each report `tool: "undo_agent_changes"`, `input: { scope: "session" }`.
On a builder, only the banner's **Undo all** sends one, as `tool: "end_session"`,
`input: { undo: true }`; Stop and `end_session { undo: true }` send no extra action. All of them
carry `handle` and `revision` like every other, and all also reach the page registrar's
`subscribe()` stream (`@argusvane/datum-engine/agent`), as every call's event does.

A submission the assistant started reaches the host's `datum-submit` listener with
`detail.trigger === "agent"`. That word is never passed to the runtime or to a signing provider,
and it is never in a tool result.

## How a call runs

### The envelope

Every result is one plain JSON object. `ok: true` means what was asked for happened; `ok: false`
means it did not, and says why.

```ts
interface AgentOk {
  ok: true;
  tool: string;            // the tool's name, so a transcript reads without its calls
  form?: string;           // the handle of the form this result is about (always present but on the two-form listing)
  revision: number;        // the form's change counter after the call (absent on the two-form listing)
  next?: string[];         // at most two sentences naming the tool to call next
  note?: string[];         // state-dependent sentences to read
  warnings?: string[];     // non-fatal notes, e.g. "ignored unknown argument: expectedRevison"; at most 20 (see "Limits")
  alsoChanged?: string[];  // write tools: paths someone else changed since the assistant's previous call (≤ 20)
  sessionEnded?: { reason: "idle" | "stopped" | "cancelled" | "disconnected" | "features-changed" | "rebuilt"; undone: number };
  truncated?: true;        // a list in the result was cut
  nextOffset?: number;     // where the next page of that list starts
  // … the tool's own fields
}

interface AgentRefusal {
  ok: false;
  tool: string;
  code: string;            // one of the codes below
  message: string;         // one sentence: what did not happen
  hint: string;            // one sentence: what to do next, naming a tool when one applies
  retryable: boolean;      // true only when waiting and calling again can succeed
  details?: Record<string, unknown>;
  form?: string;
  revision?: number;
  warnings?: string[];
  sessionEnded?: AgentOk["sessionEnded"];
  truncated?: true;        // the refusal itself was cut to stay under 64 KB (code, hint, retryable, form and revision always stay)
}
```

A tool with an outcome per item (`set_answers`) is `ok: true` with a `refused` list when at least
one item was written, and `ok: false` (`nothing-written`) when none was. A refused move or submit
is always `ok: false`. Nothing is ever thrown to the browser: an unexpected error is the refusal
`internal`. Arguments a schema does not name are dropped and named in `warnings`, never refused.
Agents must tolerate result fields and codes they do not know (see "Stability").

### Codes every tool shares

| Code | Meaning | `details` | `hint` | `retryable` |
|---|---|---|---|---|
| `bad-input` | The input is not an object, misses a required key, has a wrong type, an unknown enum value, an integer out of range, a string over its cap, or a path, locale or id that breaks its pattern. All problems at once. | `{ problems: [{ key, expected }], truncated?: true, totalProblems?: number }` (past 50 problems the first 50 are listed, `truncated` is true and `totalProblems` counts them all) | "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes." | no |
| `too-large` | Input over a cap, or a result still over 64 KB after shrinking. | `{ what: "input" \| "result", limit, got, key? }` | input: "Send fewer items per call (at most {limit} for {key}) and call again for the rest." / result: "Use offset/limit, a narrower scope, or paths." | no |
| `form-required` | Two or more forms on the page and no `form` argument. | `{ forms: FormSummary[] }` | "Pass form with one of the listed handles; describe_form lists them." | no |
| `form-unknown` | The `form` argument names no form on the page. | `{ forms }` | "Use one of the listed handles." | no |
| `target-required` | A session tool on a page with both a form and a builder, and no `target`. | `{ targets }` | "Pass target: 'form' or 'builder'." | no |
| `form-not-ready` | The form is building or rebuilding, failed to build, or left the page. | `{ state: "loading" \| "failed" \| "removed", message? }` | loading: "Wait a moment and call describe_form again." / failed: "Tell the person the form could not load: {message}." / removed: "The form is gone; stop." | `loading` only |
| `agent-off` | The form does not accept assistants: its `agent-access` is `definition` and its author turned them off (`author`: "This form does not accept assistants: its author turned them off.") or has not allowed them (`unset`: "This form does not accept assistants: this site lets them fill only forms whose author allowed it, and this form's author has not."). Judged after `form-not-ready` and before the schema check, for every tool on that form but `describe_form` (which answers a minimal result), the session pair included; nothing is read from the form and no session starts. | `{ by: "author" \| "unset" }` | "Tell the person this form has to be filled in by them; do not fill it in any other way." | no |
| `busy` | A write is still queued behind the previous one after 10 s, a submission is in flight, a server page or journey check is out, a build is pending, or an act of the assistant's own is still running after its call timed out. | `{ because: "previous-call" \| "submission" \| "page-check" \| "journey-check" \| "building" \| "draft" \| "pdf" \| "try-submit" \| "saving" \| "pdf-preview" \| "run-tests", startedAt? }` | "Wait a moment and call describe_form before retrying." | yes |
| `stale` | `expectedRevision` was given and the form has changed since; nothing was applied. | `{ revision, changedPaths: [{ path, by: "agent" \| "other" }] }` (≤ 50) | "Re-read the changed fields with get_answers, then call again with the new revision." | no |
| `stopped` | The person pressed Stop on the session banner and has not allowed the assistant again. | `{ stoppedAt, undone }` | "Tell the person you have stopped and what was undone; they can allow you to continue from the banner." | no |
| `cancelled` | The caller cancelled the call. Nothing after that point was applied; a change already made stays (and is undoable). | `{ stillRunning?: true }` | "The call was cancelled. If stillRunning is set the action may still complete; call describe_form before retrying." | yes |
| `timeout` | The call's own time budget ran out (`check` and `navigate` 20 s, `submit` 30 s, `drafts` 15 s, `download_pdf` 60 s, `save` 30 s, and on a builder `try_it { submit }` 20 s, `try_it { check }` and starting Try it 10 s, `documents { open }` 10 s, `documents { new }` 20 s, `documents { preview_pdf }` 30 s); the form may still be working. | `{ afterMs, stillRunning }` | "The form is still working. Call describe_form to see where things stand." | yes |
| `feature-off` | The page's `features` leave out what the call needs (`translations`, `journeys`, `data-sources`, `drafts`, `pdf`, and on a builder `try-it`, `languages`, `journeys`, `pdf`, `data-model`, `tests`). | `{ feature }` | "This page does not allow that; tell the person instead of retrying." | no |
| `chunk-unavailable` | A lazy part of the page did not load or is still loading: the PDF support files, the builder's tests runner, data-model planner, Try it, journey preview or designers, or the body of a tool (ADR 0143). | `{ what, state?: "loading" \| "failed" }`; `what` is one of `pdf` (renderer) or `tests`, `try-it`, `journey-preview`, `journeys`, `journey-designer`, `pdf`, `pdf-designer`, `pdf-executor`, `pdf-template`, `data-model`, `agent-try`, `agent-languages`, `agent-documents` (builder) | loading: "That part of the builder is still loading; call again in a moment." / failed: "Try once more; if it fails again the host removed that file: tell the person." | yes |
| `internal` | Unexpected error. `message` is the error's message, never a stack. | `{ message }` | "Try once more; if it repeats, tell the person the form reported an error." | no |

`FormSummary` is `{ form, formId?, title, fields, pages, locale, session, state?, by? }`; a form still
building is listed as `{ form, title: "", fields: 0, pages: 0, locale: "", session: false,
state: "loading" }`, and a sealed form keeps its title and drops the rest: `{ form, title, fields: 0,
pages: 0, locale: "", session: false, state: "off", by }`, so the model knows which message to relay
without a second call.

### Codes of the form tools

| Code | Meaning | `details` | `hint` |
|---|---|---|---|
| `unknown-field` | No field has that path or id. | `{ ref, suggestions }` (≤ 5) | "Use a `path` from describe_form; did you mean {suggestions}?" |
| `not-a-table` | `edit_rows` on a field that is not a table. | `{ path, kind }` | "edit_rows takes a field of kind 'collection'; write this field with set_answers." |
| `no-options` | `get_options` on a field without choices. | `{ path, kind }` | "This field takes free text; write it with set_answers." |
| `not-writable` | The field cannot be written by an assistant. | `{ path, reason: "hidden" \| "disabled" \| "readonly" \| "calculated" \| "unfillable" \| "group" \| "presentation", unfillableKind? }` | hidden: "The form hides this field right now; another answer may reveal it (describe_form scope 'all' shows the hidden ones)." / disabled, readonly: "The form does not allow changing this field; tell the person." / calculated: "The form works this value out itself; write the fields it depends on." / unfillable: "Files, signatures, buttons and nested tables must be handled by the person; ask them." / group: "This is a container; write its fields' paths instead." / presentation: "This field belongs to the page's presentation and cannot be written by an assistant." (a journey presentation's own field is writable on the page that shows it; on another page the hint is "This field belongs to another page of the journey; move there with navigate, then write it.") |
| `invalid-value` | The value does not fit the field's kind. | `{ path, kind, expected, got }` | "Pass {expected} for `{path}`." |
| `no-such-option` | A choice matched no option value and no label. | `{ path, got, options (≤ 10), total, acceptsFreeText }` | "Pick one of the listed option values, or call get_options with a `query` to search all {total}." |
| `option-ambiguous` | Two or more options share the given label. | `{ path, got, candidates }` | "Send the option's `value` instead of its label." |
| `options-loading` | The field's data source has not answered yet. | `{ path, sourceId }` | "Call get_options for this field, then retry." |
| `options-failed` | The field's data source failed (its text is never returned). | `{ path, sourceId, what: "data-source" }` | "The field's choices did not load; tell the person and leave the field." |
| `no-such-row` | A row index beyond the rows that exist (no row is ever appended for it). | `{ collection, index, rows }` | "The table has {rows} rows; add one with edit_rows, or pass the whole table as an array to set_answers." |
| `rows-locked` | The table does not allow adding, removing or replacing rows. | `{ collection, operation: "add" \| "remove" \| "replace" }` | "Rows cannot be added here; tell the person." (or removed, replaced) |
| `rows-limit` | The table's row bounds would be broken. | `{ collection, min, max, rows, asked }` | "The table allows between {min} and {max} rows; it has {rows}." |
| `field-in-use` | The person is typing in that field right now (the window has focus and the field's text box is the focused element), outside a session. | `{ path }` | "Write the other fields now and retry this one, or call begin_session to pause the person's typing first." |
| `person-data` | The row holds entries the person typed, and `force` is not set. | `{ collection, index, paths }` | "Removing the person's own entries needs their say; ask them, then pass force: true." |
| `nothing-written` | Every path in `set_answers` was refused. | `{ refused }` | "See each refusal's hint." |
| `locale-unsupported` | Not one of the form's languages. | `{ locale, supported }` | "Use one of the listed locale codes." |
| `unknown-page` | `navigate.to` names no page or step. | `{ to, pages }` | "Use 'next', 'back', or one of the listed page ids." |
| `unreachable` | A page or step the person could not jump to yet. | `{ to, frontier }` | "Move with 'next' until {frontier}; later pages open as earlier pages pass their checks." |
| `blocked` | The move did not happen: the page's checks failed, a rule or hook refused, or the server refused. The errors are now shown to the person, as Continue shows them. | `{ reason, message?, errors }` | validation: "Fix the listed problems with set_answers, then call navigate again." / server: "The server refused or did not answer; tell the person: {message}." / a rule or hook: "The form does not allow this move yet: {message}." |
| `at-end` | Already on the last page. | `{ page }` | "This is the last page: call check {scope:'form'} and then submit." |
| `at-start` | Already on the first page. | `{ page }` | "There is no earlier page." |
| `exit-page` | The journey ended on an exit page. | `{ page, title }` | "The form has ended here; read the page's message to the person." |
| `not-at-end` | `submit` on a journey that is not on its last page. | `{ page, remaining }` | "Move through the remaining pages with navigate {to:'next'}, then submit." |
| `signature-required` | The submission, or the PDF, must be signed by the person. | `{ because: "host" \| "button" \| "participants" \| "pdf-signer" }` | "Fill the form and tell the person it is ready: they must press Submit themselves because the submission is signed." / pdf-signer: "This page signs its PDFs, which is the person's act; tell them to use the form's PDF button themselves." |
| `already-submitted` | The form was submitted and nothing changed since. | `{ submittedAt, submissionId? }` | "Do not submit twice; tell the person it went through." |
| `rejected` | `submit` ran and the form's checks refused it; the errors are now shown. | `{ refusedBy, errors, deliveryErrors? }` | "Fix the listed problems with set_answers and submit again when check {scope:'form'} passes." / `refusedBy: "host"` from a `beforeSubmit` hook: "The site refused the submission with the message in details.errors; tell the person what it says and let them act. Do not change answers to get past it unless the person asks." |
| `nothing-to-undo` | No assistant change on record in the asked scope. | `{}` | "Nothing to do." |
| `submitted` | The form was submitted; the assistant's changes are part of it. | `{ submittedAt }` | "The form was submitted; the submission cannot be undone from here." |
| `no-drafts` | The form keeps no drafts (no `draft` key, or drafts are off). | `{}` | "This form does not keep drafts; tell the person." |
| `no-draft` | Restore with nothing saved under the form's key. | `{ store }` | "There is no saved draft to restore; tell the person." |
| `answers-present` | Restore would replace answers already entered and `replaceAnswers` is not true. | `{ answered }` | "Restoring replaces the {answered} answers on screen and cannot be undone; ask the person, then call again with replaceAnswers: true." |
| `draft-incompatible` | The saved draft belongs to another form, is a version the form cannot read, or is damaged. | `{ reason: "other-form" \| "form-changed" \| "damaged" }` | "The saved draft cannot be restored into this version of the form; tell the person." |
| `draft-failed` | The store failed; its text is never returned. | `{ what: "save" \| "load" \| "delete", status?, by?: "host" }` | "The site did not {what} the draft; tell the person. Try once more only if they ask." |
| `draft-restored` | A saved draft replaced the answers after the assistant's last write; the record was reset. | `{ restoredAt }` | "A saved draft replaced the answers; changes made before it cannot be undone." |
| `no-pdf` | The page makes no PDF of this form (no `pdf` attribute, no `pdfSupport`). | `{}` | "This page does not make PDFs of the form; tell the person." |
| `unknown-layout` | `layoutId` is not one of the form's layouts (never derived silently). | `{ layoutId, layouts: [{ id, label }] }` | "Use one of the listed layout ids, or leave layoutId out to let the form choose." |
| `pdf-blocked` | The answers have blocking problems (the PDF button would refuse too); nothing is painted on the form. | `{ errors, moreErrors? }` | "Fix the listed problems with set_answers, then call download_pdf again." |
| `pdf-failed` | Rendering failed, or nothing could be delivered; kernel and template text are never returned. | `{ what: "rendering" \| "template" \| "delivery", code? }` | "The PDF could not be made; tell the person." |
| `already-downloaded` | The assistant downloaded this layout in this language at this revision already. | `{ at, layoutId }` | "The person already has this PDF; call again with again: true only if they asked for another copy." |

Every form code is `retryable: false`.

### Codes of the builder tools

On a builder the three target codes of the shared table read `builder-required`,
`builder-unknown` and `builder-not-ready`, with `{ builders: BuilderSummary[] }` and hints that
name `describe_builder` (`BuilderSummary` is `{ builder, title, dirty, workspace }`);
`builder-not-ready { state: "loading" }` covers a builder whose definition is still being applied.
The builder adds these:

| Code | Meaning | `details` | `hint` | Returned by |
|---|---|---|---|---|
| `unsaved-draft` | The person has an unsaved edit in the inspector, the Form panel, the Tests panel, a designer's document or the Languages workspace (`reason: "draft"`; `componentId: "tests-panel"` for the Tests panel's own editor, `"languages-texts"` for typed translations, `"<documentId>/<nodeId>"` for a designer document), or the builder's Save / Discard / Stay prompt is up (`"prompt"`), on the form or on the designer document the person is in. No prompt was raised and nothing was held: on a race the tool answered the prompt "Stay". | `{ reason: "draft" \| "prompt", componentId?, cells?, prompt?: { componentId, action, external? } }` | draft: "The person is editing {componentId}; ask them to apply or discard that edit, then call again. Do not retry on your own." / prompt: "The builder is asking the person to save or discard an edit; wait for them to answer, then call again." | every write, `open`, `history`, `begin_session`, and the writing actions of `languages`, `documents`, `remove_part`, `save` |
| `try-it-on` | The canvas is in Try it; a change to the components would land behind the person's back. | `{ triedPaths }` | "The person is trying the form. Call open { tryIt: false } (pass discardTriedAnswers: true only after telling them their {triedPaths} typed answers will be cleared), or ask them to go back to editing." | `add_components`, `replace_form`, `rename_component`, `move_component`, `remove_components`, `duplicate_component`, `history`, `documents { create_form_fields }` |
| `wrong-mode` | The person is in a designer (`pdf`, `journeys`) and would not see the change. | `{ mode }` | "The person is in the {mode} designer and would not see the change; call open { workspace: 'form' } first." | the tools of `try-it-on`, plus `write_test`, `remove_test` |
| `unknown-component` | An id names nothing in the form. | `{ componentId, closest? }` | "Call get_form to list the current ids; ids change after rename_component and history." and, when one is close, ` Closest: "{closest}".` | every tool that takes an id |
| `unknown-type` | The type is not one this builder can add. | `{ type, position?, known }` (≤ 50) | "Call list_component_types; the list differs per host." | `add_components`, `replace_form`, `list_component_types` |
| `invalid-id` | An id breaks `^[a-zA-Z][a-zA-Z0-9_-]*$` (a top-level id over 128 characters is `bad-input` first). | `{ id, position? }` | "Use a letter, then letters, digits, _ or -, at most 128 characters; or omit id to have one generated." | `add_components`, `replace_form`, `rename_component` |
| `duplicate-id` | The id is used in the form or earlier in the same call, or a journey page-only field owns it (`claimed: true`). | `{ id, position?, claimed? }` | "Pick another id or omit it." / claimed: "A journey page-only field owns this id; pick another." | `add_components`, `replace_form`, `rename_component` |
| `slot-refused` | A component cannot go where asked: the parent takes no children or not that type, the slot is full or does not exist, or `form` as a child. | `{ parentId, slotId?, childType, reason, accepting: MoveTargetRef[] }`; when the builder's own sentence names no component and the write was placing several (`add_components`, `replace_form`), `{ reason, accepting: [] }` | "Use one of details.accepting, or call list_component_types to see which slots take {childType}."; for the second shape, "Call list_component_types to see which slots take the component, or get_component for where it may go." | `add_components`, `replace_form`, `duplicate_component` |
| `data-path-conflict` | Two components would store their answers under one data path (ADR 0109). | `{ problems }` | "Change dataKey on one of the components named, or move it to another container." | `add_components`, `replace_form`, `set_properties` |
| `blocked-property` | The inspector's Apply would refuse the value too (a pattern that is not a valid expression, a minimum over its maximum, a data key that breaks its rule). | `{ componentId, propertyPath, message }` | "The inspector would refuse this value too: {message} Send a valid value." | `add_components`, `replace_form`, `set_properties` |
| `structure-limit` | The form would pass a structure limit the server enforces (depth, component count, options per component, name length). | `{ problem, limit?: { name, max } }` | "Send fewer or shallower components; the limit is {max} {name}." (without a known limit: "…; the form would pass a limit the server enforces.") | `add_components`, `replace_form`, `set_properties`, `duplicate_component` |
| `formula-error` | A rule's FEEL text does not parse. | `{ problems: FormulaProblem[] }` | "Fix the formula at start..end; nothing was written. FEEL: `and`/`or`/`not()`, `=` for equality (not `==`), strings in double quotes, field ids as bare names." (`set_properties` adds "Pass partial: true to write the edits that parse.") | `add_components`, `replace_form`, `set_properties` |
| `has-dependents` | Rules, journey pages or PDF layouts still read a component being removed, and `removeReferences` is not set. | `{ dependents: [{ componentId, items: Dependent[], lines }] }` | "Call again with removeReferences: true to clear those references too (one undo step per component), or fix them first with set_properties." | `remove_components` |
| `move-refused` | The destination is not one the component may go to. | `{ reason: "inside-itself" \| "slot" \| "missing" \| "data-path", message, targets: MoveTargetRef[] }` (≤ 50) | "Pick one of details.targets." | `move_component` |
| `root-component` | Remove, move, duplicate or rename of the form root. | `{}` | "The root is the form itself: replace_form changes its contents, set_properties { componentId: '{rootId}' } its settings." | `remove_components`, `move_component`, `duplicate_component`, `rename_component` |
| `fixed-component` | The component is fixed by the host (a PDF template field). | `{ componentId }` | "This component is fixed by the host (a PDF template field); change its properties instead." | the same four |
| `beyond-own` | `history` would reach past the assistant's own steps without `beyondOwn: true`. | `{ ownSteps, requested }` | "Resend with steps: {ownSteps}, or beyondOwn: true only if the person asked you to undo their own work." | `history` |
| `undo-failed` | The first step could not be undone or redone; nothing ran. | `{ done, message }` | "Call get_form before continuing; the steps beyond that one are gone." | `history` |
| `refused` | The builder refused for a reason not listed above; `message` is its own sentence. | `{ message }` | "Read message; it names the component and the reason. Call get_form if unsure." | writes |
| `unknown-test` | No test has that id. | `{ id, known }` | "Call list_tests." | `list_tests`, `write_test` (with `id`), `remove_test`, `run_tests` |
| `test-parse-error` | A test block does not parse (no block, or a second `test` header, included). | `{ problems: WordedTestProblem[] }` | "Fix the lines named; nothing was saved. list_tests.syntaxHint shows the statements." | `write_test`, `run_tests { source }` |
| `duplicate-test-name` | Another test has that name and no `id` was given. | `{ name, id }` | "Pass id: \"{id}\" to replace that test, or change the name." | `write_test` |
| `no-ui` | `open`, `try_it`, `documents`, `languages { preview }` or `save` on a builder that runs without its page (an engine test host). | `{}` | "This builder runs without its page; nothing can be shown." | `open`, `try_it`, `documents`, `languages { preview }`, `save` |
| `not-tryable` | Try it cannot run where the person is (Logic, Data, Languages, a designer overview, the journey map, an empty designer), or it ended while a check or submit was waiting. | `{ workspace, mode }` | "Try it runs on the form or an open journey or PDF template page; call open { workspace: 'form' } first, or tell the person." | `try_it` (starting actions) |
| `try-it-busy` | The person is recording a test from Try it, or Try it is showing a test scenario. | `{ because: "recording" \| "showing" }` | recording: "The person is recording a test; your answers would be written into it. Wait until they stop, then call again." / showing: "Try it is showing a test scenario; ask the person to close it first." | `try_it` writing actions |
| `tried-answers` | Clearing or leaving would drop answers the person typed in Try it and `discardTriedAnswers` is not true. | `{ byPerson, byAssistant }` | "The person typed {byPerson} answers in Try it; tell them they will be cleared, then call again with discardTriedAnswers: true." | `try_it { clear }`, `documents { open, new, duplicate }`, `remove_part` |
| `not-a-journey` | `navigate` while the tried form is not a journey preview. | `{ workspace }` | "navigate moves a journey's preview; open the journey with documents { action: 'open', kind: 'journey', id } and call try_it again." | `try_it { navigate }` |
| `unknown-source` | A stand-in list for a data-source id that no component reads and the host does not offer. | `{ sourceId, known }` (≤ 50) | "Use one of the listed data-source ids (describe_builder dataSourceIds)." | `try_it { settings }` |
| `invalid-language-code` | Not a language code, or declared already under another case or label. | `{ code, problem }` | "Use a code such as 'fr' or 'fr-CA' that the form does not have yet; relabel changes a declared language's name." | `languages { add, rename }` |
| `source-locale-needed` | `add` on a form that declares no languages and no `sourceLocale`. | `{ code }` | "Say which language the form's texts are written in now with sourceLocale (ask the person, or read the labels with get_form), so they are not taken for {code}." | `languages { add }` |
| `unknown-text` | No translatable text has that `textId` (per entry). | `{ textId, suggestions }` (≤ 5) | "Use a textId from languages { action: 'texts' }; ids change after renames and edits." | `languages { translate }` |
| `default-language` | The entry names the form's default language: its wording is the text itself, never a translation (ADR 0158), so there is nothing to write (per entry). | `{ language, source }` | "Change the source text with set_properties; translations are for the other languages." | `languages { translate }` |
| `unknown-document` | No journey or layout has that id. | `{ kind, id, known: [{ id, name }] }` (≤ 50) | "Use an id from documents { action: 'list', kind }." | `documents`, `remove_part` |
| `unknown-template` | `templateId` is not on the site's template list. | `{ templateId, known: [{ templateId, label }] }` (≤ 50) | "Use a templateId from documents { action: 'list', kind: 'pdf_layout' }; files cannot be uploaded by an assistant." | `documents { new }` |
| `document-not-open` | The action works on the template layout open in the PDF designer, and none (or another) is open. | `{ kind, id?, openId? }` | "Open it first with documents { action: 'open', kind: 'pdf_layout', id }." | `documents { map_fields, create_form_fields }` |
| `not-a-template` | The open layout is a generated one, or its PDF was read and has no fillable fields. | `{ id, fields }` | "These actions fill a fillable PDF's fields; this layout has none, so tell the person." | the same two |
| `nothing-to-restore` | No document the assistant removed is held for that id (or the page reloaded). | `{ kind, id }` | "Nothing you removed is held for that id; it cannot be brought back from here." | `documents { restore_removed }` |
| `data-unreadable` | The `fromData` text did not read (JSON error, not an object, over the reader's place cap). | `{ error, line?, column?, empty? }` | "Send a JSON object (a sample of the answers) or a JSON Schema whose top level is an object; fix the JSON at the line and column given." | `add_components`, `replace_form` |
| `protected-setting` | The edit touches a path the site manages or an identity the host owns (`by: "host"`), or `agentTools`, the form author's switch for assistants (`by: "author"`). `history` answers it too when a step it ran changed `agentTools`: that step was put back and history stopped there (`applied` counts the steps before it, which stayed). | `{ propertyPath, by: "host" \| "author", applied?, reversed?: false }` | host: "The site manages this setting; tell the person." / author: "Whether assistants may fill this form is the author's choice in Form settings; tell the person." | `set_properties`, `history` |
| `no-save` | The site gave the builder no Save. | `{}` | "This builder has no Save; the person keeps the form with Download or their site's own save." | `save` |
| `save-failed` | The site refused or failed the save; `details.message` quotes the site's text, cut to 300. | `{ message }` | "Tell the person the save failed and what the site said; do not retry unless they ask." | `save` |
| `already-saved` | The assistant saved this revision already. | `{ savedAt, revision }` | "Tell the person it is saved. Save again only if they ask, with again: true." | `save` |

The shared codes on a builder: `busy` is `{ because: "previous-call" }` for a write or session
tool that waited 10 s behind another, and `{ because: "run-tests" }` at once for a second
`run_tests` while one runs; `stale` carries `{ revision, outline: { rootId, nodes (≤ 50), total } }`
with the hint "Read the outline again and resend."; `feature-off` is `{ feature: "tests" }` on
`write_test`, `remove_test` and `run_tests`, the `pdf` or `journeys` feature on
`get_definition`'s matching sections, and the feature of the area on the `try_it`, `languages`, `documents`, `remove_part` and `save` tools
(`try-it`, `languages`, `journeys`, `pdf`, `data-model`). `chunk-unavailable` is in the shared
table: `run_tests` answers it for the tests runner, `get_definition { section: "data-model" }` and
`fromData` for the planner, `try_it`, `languages` and `documents` for their own part of the page
and designers. `end_session { undo: true }` is never refused for an undo
that stops early (see "Sessions").

Reserved ids and managed paths. `invalid-id` is also the answer for `component`, `host`, `row`,
`ancestor`, `constructor` and `prototype`, with a message that names the word (ADR 0111). The
`protected-setting` rule that `set_properties` applies binds `add_components` (a new component
carrying a managed path), `replace_form` (components and `fromData`) and `duplicate_component` (a
copy of a component that carries one) too, with the same message, and the inspector's JSON tab
refuses a change to a managed path in the same words (ADR 0155). `check_form` lists
`component.limits.inverted` (a minimum over its maximum) and the test lint
`tests.set.unknownPath` as warnings; neither blocks a write.

Every builder code is `retryable: false`; the retryable ones are the shared `busy`, `cancelled`, `timeout` and `chunk-unavailable`, and `builder-not-ready` while its state is `loading`.

### Handles and the `form` argument

Each form on the page has a **handle**: its element's `id` attribute when it has one that no
other registered element uses, else `form-1`, `form-2`, … in the order they connected. The handle
is fixed when the element connects and never changes, not when the form's definition loads or
changes, nor when another form leaves. An `id` longer than 128 characters is not used (a cut handle
could not be passed back): that element gets the auto handle. The definition's own id is reported as `formId` and is
never the handle. Every result about a form carries its handle as `form`.

With one form the `form` argument can be left out (a value that does not match is
`form-unknown`). With two or more, every tool but `describe_form` needs it (`form-required` lists
them), and `describe_form` without it returns the listing of forms instead of a description. The
`form` property is in every schema from the start, so a second form arriving never changes what
the browser holds.

### Sessions

Single calls need no session. For more than two or three writes the assistant calls
`begin_session` first and `end_session` last:

- **Begin.** The person's pending keystroke is committed, the form's body becomes inert (the
  person can still read the page), and a banner appears above the form: "An assistant is working
  on this form: {purpose}" with a **Stop** button. Focus moves to Stop. This is the one time an
  assistant moves focus on purpose: the inert body has already taken it from whatever field held
  it, and Stop is the one control that acts. The session's id, `revisionAtBegin` and
  `idleTimeoutMs: 45000` come back, with `pausedTyping: true` when the person was in a field.
  `begin_session` while a session is open updates the purpose and answers `resumed: true`.
- **Every call** on the form restarts the 45-second idle timer. When it runs out the session
  ends as `idle` ("The assistant paused"), nothing is undone, and the next result carries
  `sessionEnded: { reason: "idle", undone: 0 }` once.
- **End.** `end_session { summary }` lifts the inert body and replaces the banner with the
  summary, an **Undo all** button and **Dismiss**; the summary is read out. `undo: true` first
  puts back everything the session changed. The result counts `fieldsWritten`, `rowsAdded`,
  `rowsRemoved` and `pagesMoved` since `begin_session`, `undone`, and `undoable`.
- **Stop.** The person's Stop undoes everything the session changed and ends it. From then on
  every write and `begin_session` answer `stopped` until the person presses **Allow again** on
  the banner; reads and `undo_agent_changes` keep working. Only the person can lift it.
- **Other ends.** The element leaving the page (`disconnected`), `agent` leaving `features`
  (`features-changed`), the form being rebuilt with another definition (`rebuilt`) and a
  cancelled call (`cancelled`) end the session without undoing anything; the next result says so
  in `sessionEnded`.

A saved draft restored inside a session (`drafts { action: 'restore' }`, or the person's own)
moves the session's undo boundary to the restore: `end_session { undo: true }` and Stop then
undo only what was written after it, and the end result carries the warning `a saved draft
replaced the answers during the session; changes before it cannot be undone`. When nothing
written after the restore is left, the summary banner shows only Dismiss, with the line "A saved
draft replaced the answers; earlier changes cannot be undone."

`submit` needs no session; an accepted submit leaves the session open so `end_session` can
carry the summary. Navigation, the language and a submission are not undone by Stop or by
`undo_agent_changes`.

`purpose` and `summary` are shown as plain text, with control characters removed and cut at 200
and 500 characters; a longer value is cut, not refused.

On a builder (`<datum-form-builder>`) the pair works the same way, on the builder's terms:

- **Begin** is refused `unsaved-draft` while the builder's Save / Discard / Stay prompt is up
  (`reason: "prompt"`) or the person has any unsaved edit (`reason: "draft"`): a locked builder
  would trap them with an edit they cannot finish. Otherwise the whole builder (bar, strip,
  canvas, inspector and panels) becomes inert, a banner above it reads "An assistant is working
  on this form: {purpose}" with **Stop**, and focus moves to Stop when it was inside the builder
  or nowhere (a control outside it, such as the page's own chat box, keeps it). The result
  answers `locked: true` (`false` under the engine's test host, which has no page). A designer or
  Try it does not block a session; the first write says so. An unapplied edit in a designer's
  document counts as the person's edit, like the form's own.
- **Writes** inside the session update the banner's step count instead of showing a notice, and
  each result carries `session: { id, ownSteps }`.
- **End** lifts `inert` and leaves the summary with **Undo all ({n})** and **Dismiss**; Undo all
  takes the session's steps back, and the changes the assistant made outside the history (the
  journeys and PDF layouts lists, a layout's own steps, Try it's stand-in settings, the form's
  identity), in one order, newest first (see "Undo and what it reaches"). The result counts
  `steps`, `componentsAdded`, `componentsChanged`, `componentsRemoved`, `testsWritten`,
  `undoable` and `undone`. `end_session { undo: true }` is never refused for an undo: when a step
  cannot be undone the builder stops there, and `undone` and the remaining `undoable` say how far
  it got.
- **Stop** undoes the session's steps and shows "The assistant was stopped; {n} changes were
  undone" with **Allow the assistant again**; reads and `open` keep working until the person
  allows it. **Idle** lifts the lock, undoes nothing and shows "The assistant paused" with Undo
  all. A new definition loaded into the element ends the session as `rebuilt`.
- Neither Stop nor Undo all reverses what `open` showed or the selection. A rename is one
  history entry with everything it rewrote (the id, the rules, the translations, the journey and
  layout follow), so Undo all puts the id and what it rewrote back together. Try it's tried answers are not in Undo all either: they
  end with Try it.

### Revisions and `expectedRevision`

Every result about a form carries `revision`, the form's change counter. It starts at 1 when the
form registers and goes up whenever something the assistant could have read changes: an answer
(the person's typing included), a table row, a page or step move, the language, the errors
shown, a draft loaded, a submission, a rebuild. It never goes back. Compare it for equality or
copy it; do not compute with it.

Every write tool takes an optional `expectedRevision`. When it is given and the form has moved
on, the call is refused `stale` with the changed paths and who changed them, and nothing is
applied. It is optional because the person types between calls; the `field-in-use` guard and
`alsoChanged` cover the ordinary case. `submit` recommends it, so an assistant never submits
answers it has not seen.

Writes to one form run one at a time in the order they arrive; a write that has waited 10 s
behind another answers `busy { because: "previous-call" }` without running. Reads never wait.
Two forms on one page run independently.

### Caps and paging

- A result is at most 64 KB of JSON. Long lists are paged by the tools themselves
  (`offset` / `limit`; `truncated: true` and `nextOffset` when cut): `describe_form` 100 fields,
  `get_answers` 200 answers, `get_options` 50 options by default, 500 at most. Inline options
  per field stop at 25 (`moreOptions`), table rows at 20 (`moreRows`), error lists at 100
  (`moreErrors`). A value over 2 000 characters is cut with `valueTruncated: true`.
- `warnings` holds at most 20 entries, each up to 1 024 characters; past 20 the first 20 are kept,
  each cut to 200 characters, with one closing line counting the rest. A refusal is kept under the
  cap the same way: `details.problems` keeps its first 50 (`truncated: true`, `totalProblems`),
  then long strings are cut and the refusal carries `truncated: true`; its code, hint, `retryable`,
  handle and `revision` always stay. A refusal is never turned into `too-large`.
- When a result is still too large, strings over 1 024 characters are cut, then inline option
  lists drop to counts, and as a last resort the result becomes `too-large { what: "result" }`.
- Inputs: 256 KB in all (512 KB for the builder's `add_components`, `replace_form`, `try_it` and `languages`); `answers` at most 200 fields; a text value 10 000 characters; a table
  500 rows; an `edit_rows` row 100 columns; `paths` 200 entries; `query` 200 characters.

### Folded tools

The catalogues are capped (26 builder tools, 15 renderer tools; the renderer has 14 and keeps one slot
spare), so an area with several acts is one **folded tool** with an `action` argument: `drafts` on a form, and `try_it`, `languages`,
`documents` and `remove_part` (whose `kind` plays the part of `action`) on a builder. Every folded
tool follows one convention:

1. `action` is the first property, a string, a closed `enum`, and required. Its description lists every action in enum order.
2. Every other property's description starts with the actions that read it and a colon (`rename, duplicate: …`, or `restore only: …`; `pdf_layout only, new: …` for an argument of one kind).
3. The tool's description reads: one sentence for the area; each action in enum order, quoted with single quotes; then what the tool never does and which tool does it.
4. A missing argument an action needs is `bad-input { problems: [{ key, expected: "required for action '<action>'" }] }`, every problem at once. An action that does not exist for the given `kind` is `bad-input` with `expected: "an action for kind '<kind>': <list>"`.
5. An argument the action does not read is dropped and named in `warnings` (`ignored argument for action '<action>': <key>`), beside the registrar's `ignored unknown argument`.
6. Every result echoes `action` (and `kind` where there is one) and carries `changed: boolean`: false for reads and for writes that change nothing (renaming to the same name, setting the default that already is).
7. A tool whose read actions must answer at once declares them (`readActions`): `try_it` `read`, `languages` `list` and `texts`, `documents` `list`. A call to one of them runs as a read: it never queues behind a write, the Stop latch does not refuse it, it gets no `alsoChanged`, and its `datum-agent-action` says `readOnly: true`. The other actions of the same tool are writes.

Annotations are per tool. A tool carries `consequentialHint` if any of its actions is irreversible,
leaves the page or is a bulk removal, and `untrustedContentHint` if a result can carry author,
person, host or data-source text, which is why `drafts`, `download_pdf`, `try_it`, `languages`, `documents`, `remove_part` and `save` all do.

The results of those tools share a few fields beside the envelope:

| Field | When | Meaning |
|---|---|---|
| `action`, `changed` | every folded-tool result | rule 6 |
| `next` | every result of those tools, reads included | at most two static sentences naming the tool and action to call next |
| `undo` | builder writes | `{ steps, ownSteps, canUndo, canRedo }`, plus `journaled: true` when the change is in the outside journal (see "Undo and what it reaches") |
| `reverse: { tool, input }` | a builder change on no history that one call can put back | the call that reverses this call; a reverse through `remove_part` is consequential, so the browser asks |
| `elsewhere: { what, steps }` | a builder write that pushed steps onto a designer document's own history | `history` does not reach them; the note says where the person undoes them |
| `undoable: false` | `drafts`, `download_pdf`, `save` | nothing in the page takes it back |
| `restorable: "history" \| "until-reload"` | `remove_part` | how the removal comes back |

## The form's tools

The catalogue of the tools a `<datum-form>` registers, with each tool's title, annotations,
description, input schema, result type, failure modes and worked examples, is the generated
[agent tools reference](reference/agent-tools.md). The twelve form tools and the session pair:

- `describe_form`: start here; the form's pages, the fields the person can fill now with their paths, whether submit works, and where drafts and PDFs come from.
- `get_answers`: what is in the form now, with display text, the required fields still empty and the errors shown.
- `get_options`: the choices a select, radio or checkbox group accepts, filtered and paged.
- `check`: run the form's own checks for the page or the whole form without showing new errors.
- `set_answers`: fill one or more fields by path, with rules and calculations running as they do for typing.
- `edit_rows`: add rows to, or remove a row from, a table or repeating section.
- `navigate`: move between pages or steps, or reveal a field on another tab.
- `set_locale`: switch the language the form is shown in.
- `submit`: send the form as the person pressing Submit would; consequential, so the browser asks first.
- `undo_agent_changes`: put back the answers the assistant changed, for the last write, the session or everything.
- `drafts`: save, restore or delete the form's saved draft; consequential.
- `download_pdf`: make a PDF of the form with the current answers and hand it to the person; consequential.
- `begin_session`: open a session, the banner with a Stop button, so several writes undo in one go.
- `end_session`: close the session, replace the banner with a summary and offer Undo all.

A typical run: `describe_form`, `set_answers`, `check`, `navigate { to: "next" }`, and so on to
`check { scope: "form" }` and `submit`, inside `begin_session` / `end_session` when it takes more
than a couple of writes. `drafts` and `download_pdf` are for the person's explicit asks. The shared
`Field`, `Page` and `WordedError` shapes the results use are at the end of the form half of the
reference.

## What is never automatable, and never in a result

| Act | Why | What the agent gets |
|---|---|---|
| Signing (WebAuthn, PIV agent, certificate file, PDF signatures), `signWith`, `signing`, `pdfSigner`, `pdfSignature`, `signingProvider`, timestamp requests | Needs user activation; the person's legal act (ADR 0061-0063) | `submit` → `signature-required`; `download_pdf` → `signature-required { because: "pdf-signer" }` whenever the page holds a signer, before anything renders; no tool has the argument |
| Choosing a file | A user gesture; file bytes never flow through a tool | `set_answers` → `not-writable { unfillable, file }` |
| A `signature` component, buttons, `html`, images | Nothing to type | `not-writable { unfillable }` |
| Hidden, disabled, read-only, calculated fields | Invisible or locked for the person too | `not-writable { hidden / disabled / readonly / calculated }` |
| A collection nested in another's row | Drawn as a plain group; no row runtime | `not-writable { unfillable, nested-rows }` |
| Submitting past an exit page, before the last journey page, twice, or mid-flight | The person could not either | `exit-page`, `not-at-end`, `already-submitted`, `busy` |
| `goToPage(direction: "error")`, `startJourney`, `leaveJourney`, `setErrors`, `validate()` as a tool, `next()` without the step check | Host seams or guard-less runtime paths | No tool reaches them; `navigate` replicates the renderer's own sequence |
| Print (`print()`, the Try panel's Print) | The person's act | No tool, action or description mentions it |
| Saving, restoring or deleting a draft; making a PDF | Data leaves the page or cannot be taken back | `drafts` and `download_pdf`, both consequential (see "What leaves the page"); `drafts { restore }` never replaces answers the person entered without `replaceAnswers: true` |
| Anything but a layout and a language in a PDF render (`signature`, `hostContext`, `render` options, attachments, file name, theme, `today`, formula or risky-pattern policy) | Page configuration and the person's act | `download_pdf` takes `layoutId` and `locale` only |
| Changing `features` (the `agent` token included), `agent-access`, `dataSources`, `draft`, `draft-store`, `pdf`, `pdfSigner`, `signWith`, binding, `mode`, `journey` / `page` attributes, WASM options, server secrets, risky-pattern policy | Page configuration is the host's | No tool; `datum-agent-tools` reports the registration state only |
| Passing a query to a data source | Source-defined shape; a new input to a host service | `get_options.query` filters locally |
| Writing while the person types in that field, after Stop, or over a newer revision | The person's typing and the Stop latch | `field-in-use`, `stopped`, `stale` |
| Removing a row the person typed in | Destructive | `person-data` unless `force: true` after asking them |
| Clearing the Stop latch | The person's decision | Only "Allow again" on the banner |
| Filling a form the author turned off, or has not allowed under `agent-access="definition"` | The author's choice and the site's policy, not the assistant's | `agent-off { by }`; `describe_form` says the form is the person's to fill |

Never in a result: a file's `data`, raw `staticHtml`, option `meta`, node JSON, rules or formula text (`hasRules` names only), `canonicalSubmission`, `signatures`, `signed`, handler or data-source error text, anything from `pdfSigner` / `signingProvider`, WASM options, server secrets, the DOM. Hidden fields' **values** never appear: `get_answers { scope: "all" }` and `describe_form { scope: "all" }` list hidden paths with `hidden: true` / `visible: false` and no value (withheld on purpose: host prefills such as case ids stay out of the agent's view).

The same holds for the draft key (a host may build it from a user or case id), a draft's
values, a store's URL or origin or its error text, a PDF's bytes, the fill reports (they quote
values), kernel or template text, attachments, a `signature` and a `PdfWarning`'s message. Status
codes, kernel codes, component ids and counts only.

On a builder:

| Act | Why | What the agent gets |
|---|---|---|
| Loading or replacing the definition (`definition`, `src`, the New and Open file actions, Open's file chooser) | Drops the undo history and the selection on every side | No tool; `replace_form` is the bounded alternative |
| The builder's own Download, the host's New and Open | Files leaving the page, and the person's choices, are the host's | No tool; `describe_builder.ui.save` names Save alone |
| Saving | Leaves the page; on many sites the saved form is live at once | `save`, consequential, only when the person asked |
| Answering the Save / Discard / Stay prompt; applying, discarding or writing the person's unsaved edit; typed translations, a designer's draft | The person's edit | `unsaved-draft { reason }`; a tool only ever answers a prompt it raised by a race with "Stay" |
| Unrecorded writes, the builder's options, component definitions, `features` (the `agent` token included), `draft`, `draft-store`, `pdf`, `fileActions`, `plugins`, `hidden-*`, `managed-settings`, `set_properties` on `children` | Silent to the history, the page's configuration, or unchecked writes | No tool; a path the site manages is `protected-setting { by: "host" }` |
| The form's id, version and schema version | Not on the undo history | `set_properties { target: "identity" }`, journaled; `protected-setting` when the host owns the identity |
| The preview binding (design system) | A preview choice | `open { binding }`, not journaled |
| Try it's WebAssembly validator switch, `wasm`, `serverChecks`, `tryPdf`, server secrets, WASM options | The person's preview and their choices | `try_it { check }` reports the person's switch and never turns it on, loads it or retries it |
| Signing: WebAuthn, PDF signatures, `pdfSigner`, `signingProvider`, timestamp requests | The person's legal act | No tool; the builder's previews never pass `signature` |
| Print (the Try panel's Print) | The person's act | No tool, action or description mentions it |
| Uploading a PDF template or any file | A user gesture; file bytes never flow through a tool | `documents { new, from: "template" }` takes only a `templateId` from the site's own list (`unknown-template`) |
| The host's translation catalog (the page's `translations`) and the Languages workspace's file Export and Import | The site's data, and the person's file | No tool; `languages { texts }` names catalog-filled locales and never writes or returns them, and no tool exports or imports a translation file |
| Undoing past the assistant's own steps | The person's work | `beyond-own` unless `beyondOwn: true` |
| Whether assistants may fill the form (`root.configuration.agentTools`), by `set_properties` or by a `history` step that reaches it | The form author's own switch, which the form carries to every host (ADR 0155) | `protected-setting { by: "author" }`; `describe_builder.assistants` reads it and nothing writes it |
| Rewriting test sources after a rename | The builder does it a moment later | `testsFollow: "queued"` and the `tests-follow:` warning |
| Writing while an edit or the prompt is pending, in a designer, in Try it, after Stop, or over a newer revision | The person's state | `unsaved-draft`, `wrong-mode`, `try-it-on`, `stopped`, `stale` (`set_properties` alone writes in a designer or Try it) |
| Tried answers the person typed, a recording, a test scenario on show | The person's work | `tried-answers` unless `discardTriedAnswers: true`; `try-it-busy` |
| Clearing the Stop latch | The person's decision | Only "Allow the assistant again" on the banner |

Never in a builder result: the person's unsaved edit itself (only `hasUnsavedDraft`,
`draftComponentId` and `committedValue` say one exists), a host listener's error text,
`pdfSigner`, `signingProvider`, WASM options, server secrets, the DOM, a stack trace or a file
path (`internal.message` is the error's message only), kernel or template text
(a PDF warning is its code and component id), a PDF's bytes, and the body of a site's reply to a
save (a refusal quotes the site's own words, cut to 300 characters).

## What leaves the page

Every tool that sends something off the page, or that cannot be taken back, is **consequential**:
its `consequentialHint` annotation makes the browser ask the person before the call, and every
`datum-agent-action` for it says `consequential: true`, whatever the outcome. The rule is one
sentence: a tool is consequential if any of its actions is irreversible, leaves the page, or is a
bulk removal or replacement. Annotations are per tool, so an area whose actions differ is split by
consequence, not by action.

| Tool / action | What it touches | Leaves the page? | Undo |
|---|---|---|---|
| `drafts { save }` | the draft store: browser storage, a server (`PUT`) or a store the page assigned (destination unknown, assumed to leave); every value the form holds, hidden prefills and own answers included | browser: no; server or page: **yes** | none |
| `drafts { restore }` | every answer on screen and the language | a read comes in | none (the person agrees first) |
| `drafts { clear }` | the stored draft | the delete request | none |
| `download_pdf` | renders in the page, then a `datum-pdf` event with the bytes (a listener may send them anywhere) or a download | **yes** | none |
| `submit` | the form's submission | **yes** | none |
| `save` | the builder's Save (the host's `fileActions.save`, or the one the `save` attribute turns on); on many sites the saved definition becomes the live form and a new version | **yes** | none from the builder |
| `remove_part` | a language (bulk), a journey or a PDF layout | no | a language: one `history` undo; a journey or layout: restorable while the page stays open |
| `replace_form`, `remove_components` | bulk removals | no | one undo step |
| `try_it { submit, check }` | the stand-in server and the Try panel; the person's own server checks run first when they turned them on (host code, which the reference hosts run in the page as WebAssembly) | only if the host's validator sends the tried answers | `clear` |
| everything else that writes | the form, in the page | no | the renderer's `undo_agent_changes`; the builder's `history`, or the outside journal below |

**Autosave is disclosed, not gated.** A form that keeps its draft on a server (a `draft-store` that
starts with `server:`) or in a store the page assigned already sends the draft 300 ms after every
answer changes, the assistant's writes and any hidden prefill included, as it does for the
person's typing. Gating that would change the form's behaviour for the person. So `describe_form`
reports `drafts: { store, autosave: true }` with a guidance line when the store is `server` or
`page`, and the first `set_answers`, `edit_rows` or `undo_agent_changes` result on such a form
carries the note `This form saves the answers as a draft on the site as they change.` once.
`drafts` exists for the explicit acts only.

## Undo and what it reaches

**The renderer.** `undo_agent_changes` puts back what the assistant wrote, answer by answer, as in
its section. Each undone value gives the answer back to whoever wrote it before: a value restored
to the person's is the person's again, in the provenance account too. A restored draft (anyone's)
starts a new record, `draft-restored`. `drafts`, `download_pdf` and `submit` are `undoable: false`
and journal nothing.

**The builder's history.** Component, rule, test and language edits are steps on the builder's
Undo, and `history` reaches the assistant's own steps. So is every change to the journeys and PDF
layouts lists: a document made, copied, renamed or removed, the default and the order (`undo.steps`
counts them), and `restore_removed` when the document's translations come back with it. Some
changes are on no controller history: `restore_removed` with no translations to bring back, a PDF
layout's own steps (each layout has a history of its own, reached by the person in the PDF
designer), Try it's
stand-in settings, and the form's id, version and schema version. For these the catalogue keeps an **outside journal** and every result says so
(`undo.journaled: true`, a `reverse` call, `elsewhere`). A list change that is an undo step is
journaled too, with the steps it wrote: the history takes it back, and its entry has no inverse of
its own, so Undo all reverses it once.

| Entry | Written by | Undo all, Stop and `end_session { undo: true }` | Kept (not undone), with the reason |
|---|---|---|---|
| `catalog` | `documents { new, duplicate, rename, set_default, move, restore_removed }` | remove what it added; rename, default and order go back exactly; one that is an undo step is the history's Undo, never reversed twice | the document was edited by the person since: `person-edited` |
| `removed` | `remove_part { journey \| pdf_layout }` | put the document back at its index with its default (the history's Undo, as the removal is an undo step; the entry stays for `restore_removed`) | its id is taken again: `id-taken` |
| `layout-steps` | `documents { map_fields }` and the layout half of `create_form_fields` | undo the layout's own history once per step | the person stepped it since: `person-edited`; the designer was rebuilt: `history-gone` |
| `settings` | `try_it { settings }` | the previous stand-in settings | changed since: `person-edited` |
| `identity` | `set_properties { target: "identity" }` | the previous id, version and schema version | changed since: `person-edited` |
| `save` | `save` | nothing: a barrier marker | always; see below |

- The form's steps and the journal run in **one order, newest first, interleaved**, so a session
  that renamed a journey, edited a component and renamed it again unwinds in reverse. Anything
  kept comes back as a `kept: …` warning on the `end_session` result (and the ended banner), and the
  journal holds at most 100 entries (`journal-full: …` counts the oldest dropped).
- A `save` inside a session is a barrier: Undo all still runs, and the result and the banner say
  `The site keeps the version saved at {time}; save again to keep the undo.`
- The notice under a journaled write offers **Undo** (that call's entries), under a removed
  document **Restore**, and under `save` no button. The journal empties when the builder is
  reseeded (a new definition), which also ends the session.
- `history` stays the form controller's history only: it never runs journal entries, and its
  description says what it does not reach.
- Try it's answers are never in Undo all. They end with Try it, and Stop and Undo all leave them.

## Provenance

Provenance is **the page's account of which submitted answers the assistant's tools wrote**. It
exists so an honest host can do honest things: show "an assistant helped fill this; please
review" at confirmation, refuse an attestation answer the person did not give themselves, keep an
audit note beside a submission. It is **not proof**: it is computed in the browser by code a
modified client could change, so a server trusts it exactly as far as it trusts the submitted
values. It never rides in the canonical envelope, a signed payload, a draft or a signing request.

The type is `AgentProvenance`, exported as a type from `@argusvane/datum-engine`:

```ts
interface AgentProvenance {
  version: 1;
  involved: boolean;       // an agent write tool changed an answer on this form since it loaded (sticky)
  paths: string[];         // submitted value paths whose last writer is the agent tools; sorted; at most 2 000 (cells as items[0].sku)
  tables: string[];        // collections whose rows the agent tools added, removed or replaced last
  complete: boolean;       // false when some agent writes can no longer be traced
  submittedBy: "agent" | "page";   // who started this submission or download
  sessions: number;        // agent sessions opened on this form since it loaded
  sessionOpen: boolean;
  lastWriteAt?: number;    // ms since epoch; absent when never
  truncated?: true;        // more than 2 000 paths
}
```

It is offered in these places, each only on an element whose agent tools were live at least once:

| Surface | What a host gets |
|---|---|
| `beforeSubmit` and `afterSubmit` hook contexts | `context.agent`, a frozen deep copy, on every submit: the person's button, the host's `submit()` and the `submit` tool. Copy before sorting or changing it (`[...ctx.agent.paths].sort()`); a hook that pushes to it throws |
| `datum-submit` | `detail.agent` beside `detail.trigger`, accepted or not |
| `datum-pdf` | `detail.trigger: "agent"` and `detail.agent`, on the person's PDF button and on `download_pdf` |
| `datum-agent-action` | `paths` per call |

**What a host can rely on**, from an unmodified page (each guarantee has a test):

- **G1.** `agent` is **absent** from `datum-submit`, `datum-pdf` and the hook contexts exactly when the agent tools were never live for this form element since it loaded: no tool could have written. A form that has only ever been sealed (`agent-access="definition"` and an author who has not allowed assistants) adds no `agent` key, because no tool could write; a form that was live and is sealed now keeps its account.
- **G2.** `involved: true` exactly when at least one agent write call changed an answer on this element since it loaded. It is sticky: it survives the person overwriting every such answer, an accepted submission, a rebuild, a draft restore and the `agent` token being removed. A page move or a language switch alone does not involve the assistant.
- **G3.** Every submitted value path whose last writer is the agent tools is in `paths` (a table the assistant replaced or reshaped is in `tables`), unless `complete: false`. A hidden field that is not submitted is not listed.
- **G4.** A value the person changed after the assistant is **not** in `paths`; an assistant undo gives the writer back that the undone entry recorded.
- **G5.** `complete: false` whenever G3 could not be kept: the runtime was rebuilt or a draft restored after the assistant had written, or the tools were withdrawn after writing. Read it as "the assistant may have written anything".
- **G6.** `submittedBy: "agent"` exactly when the `submit` (or `download_pdf`) tool started this submission (or download): the same fact as `trigger: "agent"`.

**What it cannot see**, stated plainly:

- **N1.** An assistant that drives the page like a person (a browser extension typing into fields, computer use) is indistinguishable from the person. Provenance covers the agent **tools** only.
- **N2.** Values the form works out itself (calculations, `value` rules, defaults) are never attributed, even when they read an answer the assistant wrote. The one exception is a worked-out field fed by a journey presentation's own field the assistant wrote, a direct copy of the assistant's input (`set_answers` reports it as `workedOut`).
- **N3.** Values a host prefilled, a draft brought back, or a previous page load wrote carry no agent mark.
- **N4.** Nothing survives a reload or a draft round trip unless the host keeps it: the host receives the object at every submit and download.

**Recipes.**

An attestation answer must be the person's. A plugin `beforeSubmit` hook that throws refuses the
submission for the person's own Submit (the message shows on the form) and for the `submit` tool,
which answers `rejected { refusedBy: "host", errors: [{ code: "hook", message }] }` with a hint
telling the model to relay the site's words and let the person act, not to write the answer again:

```js
plugins.register({ id: "attest", version: "1", hooks: { beforeSubmit: [(ctx) => {
  if (ctx.agent?.paths.includes("declaration") || (ctx.agent?.complete === false && ctx.values.declaration === true)) {
    throw new Error("Please tick the declaration yourself.");
  }
}] } });
```

A review banner: a `datum-submit` listener shows "An assistant filled N of these answers" from
`detail.agent.paths.length` before it calls `waitUntil` with the delivery. An audit note: store
`{ involved, complete, submittedBy, paths.length }` beside the submission record as request
metadata, never inside the signed or canonical envelope.

The strong form is a switch, not provenance. For a legal attestation, set the form's own switch
(`agentTools: "off"`, Form settings, Browser assistants), which every page on the default
`agent-access="definition"` honours; or, on a page the host controls, `agent-access="never"` (or no
`agent` token) on that element, which holds even where the site allows assistants on every form.
Pair it with a signed submit (a WebAuthn button, ADR 0063): `submit` already refuses a signed
submission (`signature-required`), the server verifies the person's signature, and no account of
who typed is needed. A host's `always` overrides the author's `off`, so the author's switch alone
is a strong form only on pages that follow the form.

## Turning assistants off for a form

Whether a form's tools run is decided in three places, and each one says who has the word. The
`agent` token of `features` loads the tools: a form without it has none, and loads nothing. On a
`<datum-form>` the host's `agent-access` attribute then says what happens, and the form's author
has a say in the definition (`root.configuration.agentTools`). As with the other host
configurations (the form chrome, for one), the host can enforce a value, leave it to the
definition, or forbid it:

| `agent-access` | Who decides | The definition's `agentTools` | Chunk | Registered | Every call | `describe_form` | `datum-agent-tools.access` |
|---|---|---|---|---|---|---|---|
| `always` | the host enforces | anything | loads | yes, live | runs | the full result, `agentAccess: "on"` | `live` |
| `definition` (the default) | the definition decides | `"allowed"` | loads | yes, live | runs | the full result, `agentAccess: "on"` | `live` |
| `definition` | the definition decides | `"off"` | loads | yes, sealed | `agent-off { by: "author" }` | the minimal result | `sealed`, `by: "author"` |
| `definition` | the definition decides | absent, or any other word | loads | yes, sealed | `agent-off { by: "unset" }` | the minimal result | `sealed`, `by: "unset"` |
| `never` | the host forbids | not read | not loaded for this element | no | (no tools from this element) | (none) | `off`, on withdrawal only |

The host enforces with `always`, which bypasses the author's `off`: the host owns the page, and an
author's `off` is honoured only by hosts that follow the form. The definition decides with
`definition`, the default: use the form's `agentTools` if it has one, and never allow when it does
not. The host forbids with `never`, and a form on that page cannot be opened to assistants by its
definition or by the page-wide `features` list. Without the `agent` token every row is the last
one.

**The definition key.** `root.configuration.agentTools` is `"allowed"` or `"off"`, a string beside
`formulaErrors` in the form root's configuration. Absent, or any other word (`"maybe"`, `true`,
`"Off"`), is *not provided*: read as unset everywhere, with no `check_form` finding and no
structure warning. The builder draws it as a Form settings section, Browser assistants, with three
choices: Not set, Allowed and Not on this form (a site that lists `agentTools` in `managed-settings`
sees the row locked). The builder's own assistant reads it as `describe_builder.assistants` and
cannot write it: `set_properties` refuses the path (`protected-setting { by: "author" }`) and so
does a `history` step that reaches it. `get_component` lists the root's configuration as stored,
and `replace_form` and `add_components` (`fromData` included) never touch it.

**A sealed form** is registered, with its names on the page's tool list, but the registrar judges
access right after readiness (a form still building answers `form-not-ready { state: "loading" }`
first) and before the schema check. Every tool but `describe_form` then answers `agent-off` with
the form's `by`, the session pair included: no session starts, no banner is drawn and the page is
not made `inert`. Nothing is read from the form for a refused call, nothing is written, and no
journal entry or `agent` provenance mark exists for it. The refusal still reaches
`datum-agent-action`, so the host sees that an assistant tried. `describe_form` answers a minimal
result with the form's title and one line telling the model to leave the form to the person, and
the two-form listing keeps the title with `state: "off"`; `undo_agent_changes` on a form that was
live and is sealed now is refused too, and its journal is kept for when it is live again.

```json
// call describe_form
{}
// result
{
  "ok": true,
  "tool": "describe_form",
  "form": "statutory-declaration",
  "revision": 1,
  "toolset": "datum-form/1",
  "title": "Agent single",
  "locale": "en",
  "agentAccess": "off",
  "guidance": ["This form asks to be filled in by the person: this site lets assistants fill only forms whose author allowed it, and this form's author has not. Do not fill it or type into it for them; tell them it is theirs to complete."]
}
```

```json
// call set_answers
{"answers": {"full_name": "Ana Silva"}}
// result
{
  "ok": false,
  "tool": "set_answers",
  "code": "agent-off",
  "message": "This form does not accept assistants: its author turned them off.",
  "hint": "Tell the person this form has to be filled in by them; do not fill it in any other way.",
  "retryable": false,
  "details": {"by": "author"},
  "form": "statutory-declaration",
  "revision": 1
}
```

```json
// call begin_session
{"purpose": "Fill the declaration"}
// result
{
  "ok": false,
  "tool": "begin_session",
  "code": "agent-off",
  "message": "This form does not accept assistants: its author turned them off.",
  "hint": "Tell the person this form has to be filled in by them; do not fill it in any other way.",
  "retryable": false,
  "details": {"by": "author"},
  "form": "statutory-declaration",
  "revision": 1
}
```

The guidance line of the minimal result, by `by`: for `author`, "This form asks to be filled in by
the person, not by an assistant: its author turned assistants off. Do not fill it or type into it
for them; tell them it is theirs to complete."; for `unset`, "This form asks to be filled in by the
person: this site lets assistants fill only forms whose author allowed it, and this form's author
has not. Do not fill it or type into it for them; tell them it is theirs to complete."

**Changing it while the page runs.** A change to `agent-access` between `always` and `definition`
(or the attribute removed, which is `definition`) re-reads the access without unregistering or
rebuilding: a flip between live and sealed bumps the form's revision, ends an open session as
`rebuilt` and re-dispatches `datum-agent-tools` with the new `access`. To `never` the element
withdraws its tools (an open session ends as `features-changed`) and from `never` it registers them
again, loading the chunk the first time. A definition swap, through the `definition` property or
`src`, runs the runtime rebuild (the session ends `rebuilt`) and the access is read again from the
new `agentTools`. A form that was live, was sealed and is live again can still
`undo_agent_changes` its earlier writes.

**Where each host sets it.**

| Host | How |
|---|---|
| Any page | `features="all agent"` and `agent-access` on the elements that may have tools; leave `agent` out, or write `agent-access="never"`, on the others. Without the token nothing is loaded or registered for that element: no tools if it is the only form, and the form is absent from `describe_form`'s listing on a page with other registered forms. A sealed form is listed, with `state: "off"` |

A host that writes the token without `agent-access` gets the default, `definition`.

The default is one constant, `DEFAULT_AGENT_ACCESS`, and the node host a test or a server builds
with `runtimeAgentHost` defaults to `always`, so only a page needs the attribute. Making the `agent`
token default-on, or `agent-access` default to `always`, is a change to ADR 0155, which keeps both off by default.

The builder's assistant cannot change `features`, `agent-access`, `draft`, `pdf`, `fileActions`,
`plugins` or any `managed-settings` path (`protected-setting { by: "host" }`, or no tool), nor the
author's `agentTools` (`protected-setting { by: "author" }`).

## Stability

- `describe_form` reports `toolset: "datum-form/1"`, the version of the form tools' contract,
  and `describe_builder` reports `toolset: "datum-builder/1"`, the builder tools'. Each moves when
  one of its tools is removed or renamed, a required input is added, or a result field changes
  meaning; such a bump is a minor engine release at least and is listed here.
- A tool's description is at most 800 characters, and a folded tool's (`try_it`, `languages`,
  `documents`, `remove_part`, `drafts`), which names every action, at most 1,300 (ADR 0155).
- Adding a tool, an optional input, a result field or a refusal code is not a bump. An agent or
  a host script must tolerate fields and codes it does not know.
- The envelope (`ok`, `tool`, `form`, `revision`, `code`, `message`, `hint`, `retryable`,
  `details`) and the shared codes are frozen at version 1; new shared codes are added, never
  changed.
- `revision` is per page life, not a version.
- Tool names and schemas follow the engine's semver like the rest of its public surface. The
  engine side lives in its own `agent` subpath, never the engine's root, so a page without the
  `agent` word of `features` never loads it. A host imports no agent module: the tools load as a
  lazy chunk beside the form or builder bundle (`@argusvane/datum/form`, `@argusvane/datum/builder`)
  when an element's `features` names `agent`.
- The conformance suite pins the catalogue: `packages/conformance-suite/golden/agent-tools.json` holds
  every tool's name, title, description, schema and annotations and the two toolset strings, its
  tests compare the engine's catalogues and the generated reference to it, and `datum-host-check agent-tools
  --tools <dump.json>` compares a page's own tool dump to it without an engine. A reworded
  description is a conformance failure until the golden is regenerated on purpose (ADR 0155).

## The builder's tools

A `<datum-form-builder features="all agent">` registers these tools beside the session pair. The
catalogue, with each tool's schema, result type, failure modes and worked examples, and the rules
that hold for every builder tool (the handle, one undo step per write, the person's state coming
first, revisions, formulas, warnings), is the generated
[agent tools reference](reference/agent-tools.md).

- `describe_builder`: start here; the form's identity, the workspace and Try it state, counts, what would block a write now, and undo state.
- `get_form`: the form's components as a flat outline in document order.
- `get_component`: everything about one component: its JSON, inspector properties, rules, problems, dependents and where it may move.
- `list_component_types`: the component types this builder can add, with their slots, defaults and properties.
- `add_components`: add components, nested under containers, in one undo step.
- `replace_form`: replace the form's components, or build them from a JSON sample with `fromData`; consequential.
- `set_properties`: change component properties and rules in one undo step.
- `rename_component`: change a component's id, rewriting the rules, journey pages, PDF layouts and tests that follow it.
- `move_component`: move a component into another container or position.
- `remove_components`: remove components and what is inside them, refusing while something still reads them unless told to clear the references.
- `duplicate_component`: copy a component with fresh ids and re-pointed rules.
- `open`: point the person at a component, workspace, panel or Try it without changing the form.
- `history`: undo or redo the builder's most recent steps, by default only the assistant's own.
- `check_form`: check the committed form and return every finding, errors first.
- `get_definition`: the composed form definition as JSON, or one section of it, including the data model.
- `list_tests`: the form's test scenarios with their parse status and last result.
- `write_test`: add or replace a test scenario from a block in the form-test language.
- `remove_test`: remove one test scenario.
- `run_tests`: run the form's tests against a fresh headless copy of the committed form.
- `try_it`: fill, check and submit the form the way a respondent would in Try it, without changing the design.
- `languages`: list, add and remove languages and read, write and translate their texts.
- `documents`: list, open and change the form's journeys and PDF layouts.
- `remove_part`: remove one language, journey or PDF layout; consequential.
- `save`: save the form where the site keeps it, as the person's Save does; consequential.

A typical run: `describe_builder`, `get_form`, `begin_session`, `add_components` (a whole section
at once), `set_properties`, `check_form`, `write_test`, `run_tests`, `end_session`. To see the
form work, `try_it { fill }` then `try_it { check }`; to add a language, `languages { add }`,
`languages { texts }`, `languages { translate }`. `save` and `remove_part` are for when the person
asked.

## Testing your page

`@argusvane/datum-engine/testing` exports `createFakeModelContext()`, a stand-in for Chrome 155's
`document.modelContext` that behaves as the browser does (names checked, duplicates refused,
`toolchange` fired after a microtask, tools removed at once on abort, results stringified,
thrown errors turned into an opaque `UnknownError`). Install it before the element connects:

```js
import { createFakeModelContext } from "@argusvane/datum-engine/testing";

const modelContext = createFakeModelContext();
const restore = modelContext.install(document);       // defines document.modelContext
const registered = new Promise((resolve) => {         // listen before the element connects
  // The first report is the outcome of the registration, whichever it was.
  document.addEventListener("datum-agent-tools", (event) => resolve(event.detail), { once: true });
});
document.body.innerHTML = `<datum-form features="all agent" agent-access="always" src="/form.json"></datum-form>`;
const form = document.querySelector("datum-form");
await form.ready;                                     // the form is drawn
const detail = await registered;
if (!detail.registered) throw new Error(detail.reason); // "no-api", "not-allowed", "duplicate" or "error"
console.log(modelContext.names());                    // ["begin_session", "check", "describe_form", …]
const entry = (await modelContext.getTools()).find((tool) => tool.name === "describe_form");
const text = await modelContext.executeTool(entry, {}); // the JSON string the browser would return
form.remove();                                        // the tools are gone from getTools() at once
restore();
```

The recipe writes `agent-access="always"` so the tools are live whatever the test form's
definition says; a page on the default `definition` registers its tools sealed unless the form
has `agentTools: "allowed"` (the names are still listed, and every call but `describe_form`
answers `agent-off`).

`form.ready` covers the form, not the agent tools: their chunk is a separate download, and the
tools are registered with the browser after it arrives, so a test that reads `names()` or
`getTools()` right after `ready` can find nothing. Wait for the first `datum-agent-tools` (it
bubbles to the document), as above: it reports the registration's outcome either way, so a page
the browser refused fails at once with its `reason` instead of waiting for a success that never
comes, and the run with `Permissions-Policy: tools=()` below waits on the same event and asserts
`registered: false` instead.

`createFakeModelContext({ allowed: false })` behaves like a page served with
`Permissions-Policy: tools=()`, and every call is recorded in `modelContext.calls` with its real
error.

In a real browser (Chrome 155), launch with `--headless=new --enable-features=WebMCP,WebMCPTesting`
and drive the page either through page script (`document.modelContext.getTools()`, then
`executeTool(entry, input)` with an entry from that list, never a name or the registered object)
or through the DevTools protocol: `WebMCP.enable`, then `WebMCP.invokeTool { frameId, toolName,
input }` and read `WebMCP.toolResponded`, which carries the parsed output and the real exception.
Serve the page from `127.0.0.1` without a `Permissions-Policy: tools=()` header, and add a run
with the header to check that the form reports `datum-agent-tools { registered: false, reason:
"not-allowed" }`.
