# Browser assistants

A browser that supports WebMCP lets an assistant call tools that a page registers. A Datum form can register tools to read its questions and answers, fill fields, check, move between pages and submit, so a person can ask an assistant to fill a form from a letter or an earlier application. The builder can register tools for building a form. The assistant works under the person's eye, through the same runtime calls the person's typing uses, so every rule, check and calculation runs as it would for them.

## Three switches

The tools are opt-in, and three parties each have a word.

1. The page. `agent` is a word of the `features` attribute. It is not part of `all` or of the absent attribute, so you add it.
2. The form's author. In the builder, Form settings has a Browser assistants section with three choices: Not set, Allowed, and Not on this form. The choice is stored on the form's root `configuration` as `agentTools`:
   - Allowed stores `"allowed"`.
   - Not on this form stores `"off"`.
   - Not set stores nothing: the `agentTools` key is left out of the form, and choosing it removes a key stored earlier.
3. The host. `agent-access` on the form element says whose word counts.

```html
<datum-form src="/forms/claim.json" features="all agent" agent-access="definition"></datum-form>
```

| `agent-access` | Who decides | Effect |
|---|---|---|
| `always` | The host | The tools run whatever the form's author set |
| `definition` (the default) | The form | The tools run only when the author set `allowed`. Otherwise they are sealed |
| `never` | The host | Nothing is registered for this element and nothing is loaded |

- A sealed form answers every call with `agent-off`, except `describe_form`, which tells the assistant the form is the person's to fill.
- For a legal attestation, `agentTools: "off"` on the form, or `agent-access="never"` on the page, keeps assistants out.
- The builder takes the same `agent` word, and its tools are registered on that word alone.

## The form's tools

| Family | Tools |
|---|---|
| Read | `describe_form`, `get_answers`, `get_options`, `check` |
| Fill | `set_answers`, `edit_rows`, `set_locale` |
| Move | `navigate` |
| Submit | `submit` |
| Put back | `undo_agent_changes` |
| Data that leaves the page | `drafts` (save, restore, clear), `download_pdf` |
| Sessions | `begin_session`, `end_session` |

A typical run starts with `describe_form`, writes with `set_answers`, calls `check`, moves with `navigate` and ends with `submit`.

## The builder's tools

| Family | Tools |
|---|---|
| Read | `describe_builder`, `get_form`, `get_component`, `list_component_types`, `get_definition`, `check_form` |
| Build | `add_components`, `set_properties`, `rename_component`, `move_component`, `duplicate_component`, `remove_components`, `replace_form` |
| Look | `open`, `try_it` |
| Undo | `history` |
| Tests | `list_tests`, `write_test`, `run_tests`, `remove_test` |
| Languages and parts | `languages`, `documents`, `remove_part` |
| Keep | `save` |
| Sessions | `begin_session`, `end_session` |

A builder's handle:

- It is the element's `id` when no other registered element uses it, else `builder-1`, `builder-2` in the order they connected.
- Every result carries it as `builder`.
- With one builder the `builder` argument can be left out. With two or more every tool but `describe_builder` needs it (the refusal `builder-required` lists them), and `describe_builder` without it lists the builders.
- `begin_session` and `end_session` take `target: "builder"` when a form is on the page too.

Each change is one step on the builder's Undo, as the author's own edits are. The assistant cannot change whether assistants may fill the form.

## Every tool

The form's tools. `describe_form`, `get_answers`, `get_options` and `check` only read.

| Tool | What it does |
|---|---|
| `describe_form` | Start here. The form's title, language, pages and the fields the person can fill now, each with its path, kind, label, whether it is required and writable, options and current value; whether `submit` will work; where drafts are kept; the PDF layouts. |
| `get_answers` | Each answered field with its raw value and display text, in page order, plus the required fields still empty and the errors shown. |
| `get_options` | The choices of a select, radio or checkbox group: the exact `value` to write and the label. `query` filters; results are paged. |
| `check` | Runs the form's checks without changing anything or showing new errors; lists every problem with its path and message. |
| `set_answers` | Fills fields: `answers` maps each path to a value (text as strings, dates as `YYYY-MM-DD`, a choice by value or exact label, a whole table as rows, `null` to clear). Fields that cannot be written are refused one by one. |
| `edit_rows` | Adds `count` rows to a table, or removes the row at `index`. |
| `navigate` | `to` is `next` (the page's checks must pass, as for Continue), `back`, or a page or step id. `reveal` opens the tab holding a field. |
| `set_locale` | Switches the form to one of its languages. Answers do not change. |
| `submit` | Sends the form as Submit would. Only when the person asked. Refused when the submission must be signed, when the form is not on its last page, when it was already submitted. |
| `undo_agent_changes` | Puts back what the assistant changed: `session`, `all` or `last`. A field the person edited since is kept as they set it. |
| `drafts` | Saves, restores or clears the saved draft. Only when the person asked. |
| `download_pdf` | Makes a PDF of the form and hands it to the person as a download. Only when asked. |
| `begin_session`, `end_session` | Tell the person the assistant is about to work for several steps (a banner with a Stop button, everything undoable at once), and hand the page back with a summary. A session also ends by itself after 45 seconds without a call. |

The builder's tools. `describe_builder`, `get_form`, `get_component`, `list_component_types`, `check_form`, `get_definition`, `list_tests` and `run_tests` only read.

| Tool | What it does |
|---|---|
| `describe_builder` | Start here. The form's identity, locales and binding, the workspace and selection, counts, enabled features, what would block a write now, and undo state. |
| `get_form` | The components as a flat outline in document order, with ids, types, labels, value paths and rules. |
| `get_component` | One component: its JSON, every property the inspector offers (the `propertyPath` for `set_properties`), its rules as formula text, problems and dependents. |
| `list_component_types` | The types the builder can add, with the child types each slot accepts and the starting configuration. |
| `add_components` | Adds components, nested under containers, in one undo step. |
| `replace_form` | Replaces everything under the form root, or rebuilds from a JSON sample or schema. |
| `set_properties` | Changes properties, or a rule such as `rules.visibleWhen` with formula text. Formulas are parsed first; nothing is written if one fails. |
| `rename_component` | Changes an id; rules, journeys, PDF layouts and tests that read it follow. |
| `move_component` | Moves a component into another container or position. |
| `remove_components` | Removes components and what is inside them. Refused with a list when something still reads them, unless `removeReferences` is true. |
| `duplicate_component` | Copies a component with fresh ids. |
| `open` | Points the person at something without changing the form: selects a component, switches workspace, opens a side panel, turns Try it on or off, or previews another binding. |
| `history` | Undoes or redoes the steps the assistant made. Reaching the person's own steps needs `beyondOwn`. |
| `check_form` | Every finding in the committed form, errors first, each with the tool and property that fix it. |
| `get_definition` | The definition as JSON, or one section of it. |
| `list_tests`, `write_test`, `remove_test`, `run_tests` | The form's test scenarios: read, add or replace, remove, and run (all, some, or one unsaved block). See [Testing a form](/testing). |
| `try_it` | Tries the form as a respondent would in Try it: read, fill, edit rows, navigate, check. Nothing is saved. |
| `languages` | Lists languages and translatable texts, adds languages, writes translations. |
| `documents` | Lists, opens and changes the form's journeys and PDF layouts. |
| `remove_part` | Removes a language, a journey or a PDF layout. Only when the person asked. |
| `save` | Saves the form where the site keeps it, as the File menu's Save does. Only when the person asked. |
| `begin_session`, `end_session` | As for the form. |

The complete inputs, results and refusal codes are generated from the catalogue the browser registers; the descriptions above are theirs, shortened.

## What has no tool

- Signing, whether a passkey, a hardware token, a certificate file or a PDF signature. `submit` on a signed form answers `signature-required`, and the assistant hands back to the person.
- Choosing a file.
- Printing.
- Buttons, images and fields the person cannot fill either: hidden, disabled, read-only and calculated ones.
- The page's own configuration, such as `features`, `agent-access`, data sources and the draft store.
- Hidden fields' values, and the draft key, never appear in a result.

## What the person sees

- Each change is outlined on the form and read out to a screen reader. It never moves the person's page or the field they are typing in. The assistant cannot overwrite a field while the person is typing in it.
- A longer piece of work runs in a session, shown as a banner with a **Stop** button, **Undo all** at the end, and **Allow again** after a stop.
- `undo_agent_changes` puts back the answers the assistant changed.
- A tool that sends something off the page or cannot be taken back is marked for the browser to ask the person first: `submit`, `drafts`, `download_pdf`, and in the builder `save`, `replace_form`, `remove_part` and `remove_components`.

## What the page learns

When an assistant's `submit` tool started a submission, `datum-submit` carries `detail.trigger` of `"agent"`. `detail.agent` says which answers the assistant's tools wrote.

```js
form.addEventListener("datum-submit", (event) => {
  if (event.detail.trigger === "agent") {
    showReviewBanner(event.detail.agent.paths.length);
  }
});
```

- Both are absent where the tools were never live on that element.
- `datum-pdf` carries the same two for `download_pdf`.
- This is the page's own account, worked out in the browser, so a server trusts it only as far as it trusts the submitted values.
- It covers the tools only: an assistant that types into the page like a person looks the same as the person.

The element also raises three events, each a `CustomEvent` with a `detail`:

| Event | When | `detail` |
|---|---|---|
| `datum-agent-action` | After every call. | `tool`, `target` (`form` or `builder`), `handle`, `readOnly`, `input` (validated, strings cut to 1 KB, files dropped), `outcome` (`{ ok, code? }`), `durationMs`, `revision`, `sessionId?`, `changed`, `trigger: "agent"`, `paths?` (value paths written) or `componentIds?`, `undoSteps?`, `consequential?` (true for a tool the browser asks the person to confirm). |
| `datum-agent-session` | At each session change. | `phase` (`begin`, `end`, `stop`, `idle`, `cancel`, `allow-again`), `sessionId`, `target`, `handle`, and when they apply `purpose`, `summary`, `reason`, `undone`. |
| `datum-agent-tools` | When the tools are registered, sealed or withdrawn. | `registered`, `reason?` (`no-api`, `not-allowed`, `duplicate`, `error`), `tools` (the names), `target`, `handle`, `access` (`live`, `sealed`, `off`) and, when sealed, `by` (`author` or `unset`). |

An audit log of what an assistant did listens to `datum-agent-action`.

Page script gets the same tools through two methods:

- `agentTools()` resolves to the tool list (name, title, description, input schema, annotations).
- `executeAgentTool(name, input)` runs one by the pipeline the browser uses and resolves to its result; a refusal is a result, not a rejection.

Both reject when `agent` is not in `features`, when `agent-access` is `never`, or when the tools' files cannot be loaded.

```js
const result = await form.executeAgentTool("get_answers", {});
if (result.ok) {
  console.log(result.revision, result);
} else {
  console.log(result.code, result.message, result.hint);   // for example "agent-off"
}
```

A result is one of:

- `{ ok: true, tool, form, revision, ...the tool's data, next?, note?, warnings? }`
- `{ ok: false, tool, code, message, hint, retryable, details? }`

## What the host page must send

The browser decides whether the tools exist.

- **A browser with WebMCP.**
  - Chrome has it behind a flag, `chrome://flags/#enable-webmcp-testing`.
  - Where Chrome offers an origin trial, a page joins it with `<meta http-equiv="origin-trial" content="...">` and the token issued for its origin.
- **A `Permissions-Policy` response header that allows the tools:** `Permissions-Policy: tools=(self)`.
  - With `tools=()` the browser keeps the API but refuses every call, whatever the attributes say.
  - A form in an iframe needs `allow="tools"` on the frame.
- **The tools' files beside the bundle:** `datum-form-agent-*.js` for the form and `datum-builder-agent-*.js` for the builder, each loaded on demand.
  - A missing file is reported once as `datum-error` while the form keeps working.
  - Load `datum-form.js` before `datum-builder.js`: the builder bundle carries the builder's tools only, and the first definition of `<datum-form>` on the page wins, so a page that loads the builder first gives its forms no tools.

Without the browser's API the tools still work from page script, and `datum-agent-tools` reports `registered: false` with the reason `no-api`.
