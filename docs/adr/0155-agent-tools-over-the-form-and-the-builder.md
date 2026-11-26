# ADR 0155: Agent tools over the form and the builder

## Status

Accepted.

## Context

The guide is [docs/agent-tools.md](../agent-tools.md) and the catalogue (every tool, argument,
code and example) is [docs/reference/agent-tools.md](../reference/agent-tools.md). This ADR keeps
the decisions and their reasoning. The `agent` features token is the first opt-in token of ADR
0143's model; the work relies on ADR 0055 (settled change events), ADR 0142 (the fail-closed gate)
and ADR 0109 (data keys as value paths).

Chrome's WebMCP lets a page register tools (a name, a title, a description, a JSON Schema and an
`execute` function) on `document.modelContext`, and the browser's assistant lists and calls them.
The flag-gated WebMCP behaves in ways a binding has to cope with:

- `document.modelContext` is the registration point and `navigator.modelContext` is absent (the
  binding looks at `document` first and falls back to `navigator` for older previews); the
  registry is page-wide across same-origin frames and a duplicate name in one document is
  refused.
- No input validation: `execute` receives a parsed object that may break its own schema; the
  schema is stored verbatim and never checked.
- Opaque errors: a throw or rejection in `execute` reaches the caller as `UnknownError` only, and
  `executeTool` always resolves to a string (the result stringified, uncapped).
- Aborting the registration signal removes a tool synchronously; in-flight calls keep running;
  `toolcancel` and `toolactivated` never fire.
- `Permissions-Policy: tools=()` (or `allow="tools 'none'"` on an iframe) leaves the object in
  place and makes every method reject with `NotAllowedError`.
- Only `readOnlyHint`, `consequentialHint` and `untrustedContentHint` survive as annotations.

Without tools an assistant fills a form by guessing at its markup. A Datum form knows each
field's value path, kind, options, rules and errors in the form's language, and its runtime
already runs every rule, calculation and check for the person's own typing, so the tools can write
through exactly those calls and report what the form itself reports. The builder likewise has a
controller whose commands are guarded and undoable.

## Decision

### 1. An opt-in `agent` token, one catalogue per page

`agent` is a word of `features` on `<datum-form>` and on `<datum-form-builder>`; it is not in
`all` and not in the absent-attribute default (`features="all agent"` turns it on). The feature
models answer `featureOn(undefined, "agent") === false` (builder) and `formFeatureOn(undefined,
"agent") === false` (form), so no absent list reads as "agent on". A `features` change whose only
difference is `agent` does not rebuild anything (the runtime on `<datum-form>`, the sides on
`<datum-form-builder>`) and only registers or withdraws the agent tools. A page
registrar registers each kind's tools once, unprefixed; a `form` argument is needed only when two
or more forms are registered. The imperative WebMCP API only (`document.modelContext`, falling
back to `navigator.modelContext`); no declarative forms. The engine code lives under
`engine/form-engine/agent/` and is exported only through the `@argusvane/datum-engine/agent`
subpath, never from the engine root.

Each bundle loads the tools as a lazy chunk (`datum-form-agent-*`, `datum-builder-agent-*`) listed
under `agent` in the feature-files manifest, with a guard and a budget; the entries name no agent
source but the loader. The builder bundle carries the builder's chunk only, so a page that loads
only `datum-builder.js` has no agent tools for its forms (`datum-error` with a message to load
`datum-form.js` first). The tools are wired on `<datum-form-builder>` only; the engine's bare
`<datum-builder>` and `<datum-form-renderer>` register no tools (the builder loads no agent chunk).

### 2. The registrar: one envelope, one code table, no throws

Every result is `{ ok, tool, form, revision, … }` or a refusal `{ ok: false, code, message, hint,
retryable, details }`. The registrar stamps `retryable` from one closed table (true only for `busy`, `cancelled`, `timeout`,
`chunk-unavailable` and a loading `form-not-ready` or `builder-not-ready`), checks each call's
arguments against the tool's schema (the platform does not), drops unknown arguments and names them
in `warnings`, caps a result at 64 KB after the tools page their own lists, and catches
everything: nothing is thrown to the browser.

Only writes serialise: write tools and the session pair run one at a time per target (10 s in the
queue, then `busy`); reads run at once against a consistent snapshot. A tool declares `readActions`
(the actions of a folded tool that are reads); a call to one never queues behind a write, the Stop
latch does not refuse it, and its event says `readOnly: true`.

Tool names, descriptions and schemas are public surface under the engine's semver, with
`toolset: "datum-form/1"` and `"datum-builder/1"` as the catalogues' contract versions. A
description is capped at 1,300 characters for a folded tool and 800 for every other, checked by a
schema-sanity test; the texts are the contract's, byte for byte.

The handle is the element's `id`, else `form-<n>` (`builder-<n>` on a builder), fixed when the
element connects. The definition's id is reported as `formId` and is never the handle, because it
arrives after registration and may change under the assistant. Revisions guard writes
(`expectedRevision`); a write against a stale revision is refused `stale`.

### 3. The surface

The catalogues are in the reference. The choices behind them: adding and removing rows are one
tool (`edit_rows { action }`), and reading an answer returns its value and its display text
together. The session pair is the registrar's: registered once per page, whatever it holds, with
one neutral title, description and schema, and `target: "form" | "builder"` needed only when both
kinds are on the page (duplicate names are refused per document).

**Folded tools.** `drafts` on a form and `try_it`, `languages`, `documents` and `remove_part` on a
builder carry a closed, required `action` first (`remove_part`'s `kind` plays that role), under one convention (the guide, "Folded tools").
Folding keeps the tool count under the caps a page can carry. `set_answers` may match an option by
its label (exact, in the current locale) and reports that it did. `check.serverChecks` comes from
the journey view only: `on-continue` when a page check is server-side, `on-submit` when the
journey's end check is, `none` otherwise and on every form without a journey; never inferred from
`validate-url`.

### 4. Annotations: consequence decides, not area

Annotations are per tool, so every action of a tool shares one class, and the rule is one
sentence: a tool carries `consequentialHint` if any of its actions is irreversible, leaves the
page, or is a bulk removal or replacement. The browser asks the person before each such tool, and
every `datum-agent-action` for one says `consequential: true`. A tool that echoes author text
(test names, as `replace_form` and `remove_components` do) also carries `untrustedContentHint`.
The tools that carry them are in the guide, "What leaves the page".

Nothing leaves the page without a consequential tool, with one disclosed exit: a server draft store
already autosaves every answer, the assistant's included, shortly after it changes;
`describe_form.drafts` and a one-time note on the first write say so.

### 5. Writes are visible, and never take the person's place

Agent writes are visible (reveal, highlight with the existing focus token, a live-region
announcement) with no off switch. A write never steals focus from a focused field and never changes
the person's step or page: a field written on another journey page or step is written in place and
named in the result (`elsewhere`). Hidden fields' values are withheld: `describe_form` and
`get_answers` list a hidden field's path with `hidden: true` and never its value, so host prefills
such as case ids stay out of the assistant's view. The person's screen is not changed behind their
back: `download_pdf` runs the dry check first and returns the problems instead of painting them on
the form, `drafts { restore }` never replaces entered answers without the person's say, and a
repeated consequential act at an unchanged revision answers "already done" unless the person asked
for another. The renderer's own focus moves are quieted for an assistant's page move and a restored
draft while the person's focus is outside the form, and for a refused submit wherever focus is (the
person may be typing in a field of the form): the page and the error summary still paint, nothing
takes focus, and the quiet ends when the move settles.

### 6. Sessions are cooperative

`begin_session` / `end_session` bracket a stretch of assistant work. The body goes inert, a banner
outside the inert subtree carries Stop, a session expires after about 45 s of idle, and an undo-all
boundary lets the person take back everything the assistant did. Focus moves to Stop at
`begin_session`: this is the one exception to "never steal focus", and `begin_session` is never
refused because a field has focus. A session is not required for `submit` or `replace_form`. On the
builder, `begin_session` is refused `unsaved-draft` while the builder's prompt is up or the person
has any unsaved edit, since an inert builder would trap them with an edit they cannot finish, and
`end_session { undo: true }` is never refused for an undo: the undo-all stops at the first step that
cannot be undone, and `undone` and the remaining `undoable` say how far it got.

### 7. Builder writes go through the controller

Builder writes go through the controller's `request*` methods, each one undo step; there is no
`load_definition`. The writes that have no `request*` form (`set_properties`, `rename_component`,
`history`, `write_test`, `remove_test`) reproduce the guard's visible behaviour themselves: the
same pre-checks, an `unsaved-draft` refusal, no prompt raised, nothing held; when a `request*`
still returns `false` (a race the pre-checks could not see) the tool answers the prompt "stay" and
refuses `unsaved-draft`, so no tool leaves a held action behind. The person's unsaved edit, the
prompt, a designer and Try it always win: the changes to components and `history` are refused
`wrong-mode` in a designer and `try-it-on` in Try it, named ahead by `describe_builder.blockedBy`.
`history` is bounded by the assistant's own steps (the steps on top of the history since the
person's last own edit), for redo as for undo, unless `beyondOwn: true`.

**The protected-setting rule binds every write route.** A path the site manages, and a host-owned
identity, is refused `protected-setting` by `set_properties`, `add_components`, `replace_form`,
`duplicate_component` and the inspector's JSON tab alike, with the same message; a whole-form
replace or a copied component cannot write a setting a site has locked.

**The outside journal.** Some builder changes are on no controller history: a PDF
layout's own steps, a journey or layout restored with no wording to bring back (ADR 0180
decision 5), Try it's stand-in settings, the form's identity. The catalogue journals them
(at most 100 entries), every result says so, and Undo all, Stop and `end_session { undo: true }`
run the journal and the form's steps in one order, newest first. What the person changed since is
kept and reported. `save` is a barrier. A change that is a step of the form's history is journaled
with the steps it wrote and reported as those steps, so the form's Undo takes it back and its
entry has no inverse of its own; an inverse the journal runs goes through the catalog seam, never
the mode's own removal. Layout steps are one step each on the layout's own history, reached by the
person in the PDF designer and by Undo all, never by `history`.

**Lazy bodies and gating.** The tests tools `write_test`, `remove_test` and `run_tests` are gated on
the `tests` feature; `list_tests` is not, since the definition carries its tests whatever the host
shows. The bodies of `try_it`, `languages` and `documents` are lazy chunks of the agent bundle
(`lazyTool`), fetched on the first call (a missing file is a retryable `chunk-unavailable`).
`get_definition { section: "data-model" }` and `fromData` load the planner the Data workspace loads,
`run_tests` the tests runner the Tests panel uses (with the data-model section, the only reads that fetch a chunk), and
`describe_builder` and `check_form` fetch nothing. Shared
pieces (the data-model planner, the languages model, the test parser) stay in chunks the agent and
the workspaces both import, so a body never duplicates code the page holds.

### 8. Signing and what is never automatable

`submit` refuses when signing is forced (a `sign-with`, a WebAuthn submit button, a signature
participant). No tool passes `signWith` or `signing`, and nothing touches `pdfSigner` or
`signingProvider`; `download_pdf` is refused `signature-required { because: "pdf-signer" }`
whenever the page holds a signer, before anything renders. What only the person can do has no
tool: print, signing a PDF, uploading a file, the host's translation catalog, the page's
configuration (`features`, the `agent` token included, `draft`, `draft-store`, `pdf`,
`fileActions`, `plugins`, every managed setting) and clearing the Stop latch. The refusal says why
and names the hand-back. The full list, and what never appears in a result (the draft key, a
draft's values, a store's URL or error text, a PDF's bytes or fill reports, kernel text), is in the
guide, "What is never automatable, and never in a result".

### 9. Provenance is the page's honest account, not proof

`trigger: "agent"` on submit reaches host events only, never the envelope. `AgentProvenance` (in
core, no import from `agent/`) says which submitted answers the agent tools wrote last, and is
offered, frozen, on both submit hooks, on `datum-submit` and on `datum-pdf`. It is absent exactly
when the element's tools were never live (a form that has only ever been sealed adds none), never in
the canonical envelope, a signed payload, a draft or a signing request, and a server trusts it as far
as it trusts the values. A `beforeSubmit` hook that throws refuses the submission for the person and
for the `submit` tool alike (the attestation recipe). The guide's "Provenance" lists what it does
and does not cover.

### 10. The per-form switch: the host enforces, the definition decides, or the host forbids

The `agent` token per element loads the tools. Two more inputs decide whether they run. The host's
is `agent-access` on `<datum-form>` (property `agentAccess`): `always`, the host enforces (live
whatever the definition says, the author's `off` included); `definition`, the definition decides
(the default when the attribute is absent, held in one constant, `DEFAULT_AGENT_ACCESS`); `never`,
the host forbids (nothing registered, the chunk not loaded for that element). The author's is
`root.configuration.agentTools`, `"allowed"` or `"off"`, with absent (or any other word) meaning not
provided. Under `definition`, `"allowed"` registers the tools live; `"off"` and not provided
register them sealed: a separate access gate in the registrar, after readiness and before the
schema check, answers `agent-off { by: "author" | "unset" }` on every call but a minimal
`describe_form`, and reads nothing from the form. The builder's Form settings row "Browser
assistants" writes the key, and `set_properties`, or a `history` step that reaches it, refuses it
with `protected-setting { by: "author" }`. `<datum-form-builder>` is not affected by the author's
switch: it registers on the token alone, because the switch concerns the people who fill a form, not
the person building it. The `agent` token and `agent-access: "always"` are never on by default.

### 11. Hosts

The site's live demo turns the tools on; the demo feature-detects `"modelContext" in document`
before loading any bundle, so a visitor without WebMCP downloads nothing extra. Other hosts get
documentation only. The conformance suite holds the catalogues to a golden
(`packages/conformance-suite/golden/agent-tools.json`), a test compares the engine's catalogues and
`docs/reference/agent-tools.md` to it, and `datum-host-check agent-tools --tools <dump.json>` checks
a host's dump without the engine. An evaluation harness (`npm run agent:eval` in `packages/datum`,
not CI) drives real Chrome with WebMCP through a scripted and a model driver.

## Reasoning

- **Opt-in and sealed by default.** A page opts in with one word; a page that does not is what it
  was. `definition` as the default access lets the form's author decide for sites that follow the
  form; `always` exists so a host can enforce.
- **Sealed is not a readiness state.** Readiness refuses `describe_form` and blanks the listing's
  title for any non-ready state, and a sealed form must answer `describe_form` and keep its
  title, so the access gate is separate and sits after readiness.
- **Provenance is absent for a sealed form.** A sealed registration counted as registered would
  stamp `{ involved: false }` on most forms that carry the token; the rule is that provenance
  exists exactly when the tools were live.
- **Through the runtime's own calls.** The assistant reads and writes with the calls the person's
  typing uses, so every rule, calculation, journey route and check behaves for it as for the
  person, and it can never reach a path the person could not (`goToPage("error")`, `setErrors`, a
  step jump past its checks).
- **Consequence decides the annotation, not the area:** annotations are per tool, so a tool
  carries the class of its worst action.
- **Journaling outside the history:** the catalog changes the modes make no step of the form's
  history are on no history at all, so the catalogue journals them for Undo all; one that is a step
  keeps one record, the form's, so Undo all, the counts and the person's Redo afterwards see it once.
- **The renderer catalogue is not in the builder bundle,** so the renderer's tool bodies never land
  in a `datum-builder-*` file; the cost is that a builder-only page has no tools for its forms.

## Consequences

- A page opts in with one word; a page that does not is byte-for-byte what it was, apart from the
  few kilobytes of loader and element methods in each entry.
- `agent` is the first token outside `all`, so `all` does not equal the token list, and every place
  that spells the lists (the docs site's examples, the attribute reference, the integration
  recipes) names the word.
- Under the default `definition`, a page that writes `features="… agent"` with no flag on its form
  gets sealed tools (`agent-off { by: "unset" }`) until the form's author allows assistants
  (`agentTools: "allowed"`) or the page writes `agent-access="always"`.
