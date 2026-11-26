# ADR 0055: Settled change events and answer writes

## Status
Accepted.

## Context
`datum-change` reports settled values, not keystrokes (decisions 1 to 5); the same write path also
fixes what a write may carry and what an unchanged one does (decisions 6 and 7). A page mirroring the form's values into its own state, or posting them somewhere, should not do
that per character. The runtime, though, must keep seeing every keystroke: rules, visibility and
calculations recompute on each write, and the renderer draws again from them. So the boundary to fix
is where the page is told, not what the store learns. Two facts shape it:

- A page wants one of two things: the value shortly after typing pauses (a live mirror), or the
  value once the person is done with the field (a form that posts each answer). Neither is a
  keystroke, and the two differ enough to be a choice, not a default.
- The binding draws the control, so the renderer cannot read "done with the field" off one DOM
  event of its own: the adapter knows which of its controls make up the field and reports when
  the person leaves it.

## Decision
1. **The engine distinguishes an interim write from a final one.** `FormRuntime.setValue(path,
   value, { interim: true })` publishes `COMPONENT_CHANGED` with `data.interim: true`; a write
   without the option publishes the plain payload. `FormRuntime.commitValue(path)` publishes
   `COMPONENT_COMMITTED` with the stored value, writing and recomputing nothing.
   `RenderHostRuntime` carries the option and an optional `commitValue`, so a runtime that does
   not commit (the builder's preview runtime) still draws.
2. **The adapter reports keystrokes and leaving; the renderer commits.** An adapter reports what
   was typed through `on.input(value, { interim: true })` (or `on.parts` for a date's boxes) and
   that the field was left through `on.commit()` (`FieldEvents`, `render/live/contract.ts`). A
   pick (a radio, a select, a checkbox, a file) writes final.

   Datum's adapters commit on a
   control's `change` and on the `blur` that follows when no `change` just did
   (`leaveListeners`, `render/live/datum/field-scaffold.ts`); a date commits only when focus
   leaves the whole group, so tabbing from day to month commits nothing.

   The renderer
   (`render/live/mount.ts`) keeps the set of paths written interim and calls
   `runtime.commitValue(path)` only for one of those, once; a final write takes the path out. So
   nothing is committed twice, and nothing that was never interim. The leave-field check
   (`validateOn`) runs on every `on.commit()` either way. `settleInput()` on the element
   commits every path still being typed in.
3. **`<datum-form>` reports on settle, under two attributes.** `change-on="input"` (the default)
   holds an interim write and reports it after `change-debounce` milliseconds without another
   write to that path (300 by default, the autosave's window), or on its commit, whichever comes
   first; `change-debounce="0"` reports every write. `change-on="commit"` holds it until its
   commit alone. A final write is reported as it lands in both modes. Pending changes are keyed
   by value path, so typing in two fields reports both; each event carries the values current
   when it is dispatched.
4. **Nothing pending is lost to a submit.** `submit()` reports every pending change, in the order
   the fields were typed in, before `datum-submit`, so a page tracking values through
   `datum-change` holds what the envelope holds. `validate()` reports nothing: values do not
   change. Replacing the runtime (a new definition) or detaching the element drops what is
   pending, the way the autosave timer is dropped.
5. **Autosave restarts on every write,** interim or not.
6. **Answers are scalars at write time.** `FormRuntime.setValue` throws a typed failure for an
   object, a list or a bigint (it has no JSON form) given to a field that takes a single answer;
   `setValues` lists it under `failed` and writes the rest. A draft that carries one restores the
   other answers and reports the dropped one, so a bad answer cannot reach the fold or a
   submission by a side door. Restoring a draft that holds an answer the form refuses emits a
   `datum-warning` with the code `draft.dropped` and resolves with the dropped paths.
7. **A write of the value already held is silent.** It publishes no `COMPONENT_CHANGED` and still
   returns ok, so a host or an assistant that repeats a write learns nothing went wrong and
   nothing downstream draws again.

## Consequences
- A page listening for `datum-change` sees one event per field per pause or per leave instead of
  one per character. `detail.values` in that event is complete and current either way.
- The two attributes are read per write; assigning either rebuilds nothing.
- `COMPONENT_CHANGED` consumers that do not care how a value was typed (the renderer's draw, the
  autosave) read the event as they would a final write: `interim` is absent from final writes.
  `COMPONENT_COMMITTED` is heard by `<datum-form>` and by the builder's Try it recorder.
