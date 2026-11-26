A `<datum-form-builder features="all agent">` registers twenty-four tools of its own beside the
session pair: they read the form being built, change it through the builder's own undoable
commands, check it, write and run its tests, try it the way a respondent would, manage its
languages, journeys and PDF layouts, and save it. The descriptions and schemas below are
rendered from the tool catalogue the browser registers. The examples are real results from the engine's
fixture builder (`engine/tests/fixtures/agent-builder.ts`): the form `contact-request` (Full
name, Email, a Topic dropdown with the options `sales`, `support` and `other`, a Details group
holding Message, whose `requiredWhen` reads Topic, and Email me updates, then the untouched
Submit button the builder seeds) with one test, `test-1`, registered under the handle
`contact-request` (the element's `id`) with the builder's page around it. The examples are one
run of calls on that builder; the `revision` in each result shows where it falls. The examples of
`try_it`, `languages`, `documents`, `remove_part` and `save`, and of any other result that
needs those seams, run on a second builder over the same fixture whose page seams (Try it, the two designers, the site's templates and Save) are the
fixtures' fakes (`engine/tests/fixtures/agent-builder-adapters.ts`), so the page around it answers
as a real one would; the tool results are the catalogue's own.

A typical run: `describe_builder` → `get_form` → (`list_component_types`) → `begin_session` →
`add_components` (a whole section at once) → `set_properties` → `check_form` → `write_test` →
`run_tests` → `end_session`. To see the form work, `try_it { fill }` → `try_it { check }`; to add
a language, `languages { add }` → `languages { texts }` → `languages { translate }`. `save` and
`remove_part` are for when the person asked.

What holds for every builder tool:

- **The handle.** A builder's handle is its element's `id` attribute when no other registered
  element uses it, else `builder-1`, `builder-2`, … in the order they connected, fixed at
  registration. Every result about a builder carries it as `builder`; the form definition's own
  id is reported in `describe_builder.identity` and is never the handle. With one builder the
  `builder` argument can be left out; with two or more every tool but `describe_builder` needs it
  (`builder-required` lists them), and `describe_builder` without it returns the listing
  `{ ok: true, tool: "describe_builder", builders: [{ builder, title, dirty, workspace }] }`,
  with no `revision` and no `guidance`.
- **One undo step per write.** Every write goes through the builder controller, the way the
  person's own edits do, and is one step on the builder's Undo; `remove_components` with
  `removeReferences: true` takes one step per component, and a rename is one step: the id change
  and every rewrite it makes undo together. Every write result carries the `WritePayload` below:
  `undo.steps` is the number of history entries the call pushed, and `undo.ownSteps` the
  assistant's steps on top of the history since the person's last own edit, which bounds
  `history`.
- **The person's state comes first.** Before any write, in this order: the builder's Save /
  Discard / Stay prompt, an unsaved edit in the inspector or in the Form or Tests panel
  (`unsaved-draft`: no prompt is raised and nothing is held), a designer (`wrong-mode`), Try it
  (`try-it-on`). The prompt and the drafts are read on the designer document the person is in as
  well as on the form, and the folded tools' `languages`, `documents`, `remove_part`, `save` and
  `try_it` apply the same rule to the acts that would walk past them. `describe_builder.blockedBy` reports them ahead of time; reads never refuse for
  them. `set_properties` is the one write a designer or Try it does not block (the prompt and
  the unsaved edits still do).
- **Every write is shown.** The first component it touched is selected (only when the person's
  selection holds no unsaved edit) and scrolled to, every touched component is outlined in the
  canvas for 1.5 s with the studio's focus colour, the change is read out ("Assistant added 3
  components"), and outside a session a notice row offers it back with **Undo** until the
  person's next own edit, the next notice or 20 s. The scroll and the outline are skipped while
  the person is typing in a text box of the builder, and focus never moves.
- **Revisions.** The builder's counter starts at 1 and goes up on every committed change: a write,
  an undo or a redo (the person's as much as the assistant's), the tests, the languages, a new
  definition loaded into the element, a change of the form's identity, and a designer's document
  changing. A selection, a keystroke in an unsaved edit and the preview never move it.
  `expectedRevision` is optional on every write; `stale` then carries the first 50 rows of the
  outline (`{ revision, outline: { rootId, nodes, total } }`) instead of changed paths.
- **Formulas** are FEEL text (`topic = "other"`, `and` / `or` / `not()`, `=` for equality,
  strings in double quotes, field ids as bare names). They are parsed before anything is
  written: one that does not parse refuses the call with `formula-error` and its span, and a
  name that is not a field is an `unknown-field:` warning. Lint warnings run only when the
  builder's formula editor is already loaded. No read tool fetches a lazy file, with these
  exceptions: `run_tests` loads the tests runner, `get_definition { section: "data-model" }` and
  `fromData` load the planner the Data workspace uses, and `try_it`, `languages` and `documents`
  are lazy parts of the agent chunk itself, loaded the first time one of them is called
  (`chunk-unavailable` if the file is missing, and a later call asks again). `check_form` fetches
  nothing.
- **Reads run at once; writes one at a time** per builder (10 s in the queue, then
  `busy { because: "previous-call" }`). `run_tests` is a read: it never waits behind a write,
  and a second run while one is going answers `busy { because: "run-tests" }` at once.
- **Warnings** are strings that begin with a code and a colon, so an agent can branch on them:
  `kept-submit-last:`, `second-submit:`, `derived-option-values:`, `required-not-offered:`,
  `unknown-property:`, `configuration-prefix:`, `coerced:`, `unknown-field:`, `lint:`,
  `tests-follow:` and `drafts-excluded:`; and, from `try_it`, `languages`, `documents`, `remove_part` and `save`, `host-source:`,
  `templates-unanswered:`, `no-tried-answers:`, `default-kept:`, `outside-not-pruned:`,
  `outside-not-swapped:`, `outside-not-renamed:`, `ignored-keep:`, `kept:`, `journal-full:` and `problems:`. The
  registrar's `ignored unknown argument: <key>` and the folded tools' `ignored argument for
  action '<action>': <key>` are the ones without a colon after the code.
