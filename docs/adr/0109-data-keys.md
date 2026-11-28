# ADR 0109: Data keys — where an answer is stored, apart from the component's id

## Status

Accepted.

## Context

A component id is what an author addresses: a rule's `visibleWhen`, an error's `componentId`,
the builder's selection, the input's DOM id. It is unique across the form: `ComponentTree.insert`
refuses a duplicate anywhere, and so does the builder's rename (`core/tree/component-id.ts`). The
id is also the component's own segment in the data by default: a value is stored under the ids of
the data-scoping containers above it plus its own id (`applicant.email`). A data key sets that
segment apart from the id and changes only where the answer is stored.

With ids alone, a form cannot store two answers under the same key in two objects. `shipping.street`
next to `billing.street`, or a top-level `name` next to each entry's `name`, would need two
components with the id `street` or `name`, which the form cannot hold. A data-scoping container
nests the path, never the id. Keys like these are the ordinary shape of JSON, and the Data
workspace's import (ADR 0110) builds forms from JSON, so the builder has to be able to store them.

Three places have to read paths the same way, and the decisions below make them: the sandbox
kernel, the server-built PDF (`packages/pdf-kernel`, `computeEffectiveStates`) and the runtime's
mirroring of a row write into its collection.

## Decision

1. **A data key sets a component's own segment in the data.** It is `configuration.dataKey`, a
   configuration key like `scopeData`, so drafts, the preview, undo and the kernel's
   configuration reader carry it with no plumbing of their own. Unset, the segment is the id. A value path is the keys of the
   data-scoping containers above plus the component's own key. Value-bearing fields and
   data-scoping containers take a key; a repeating section keeps `collection.collectionPath` as
   its own override.

2. **The key's grammar is the path segment's, and not digits alone**: letters, digits, `_` and
   `-` (`/^[A-Za-z0-9_-]+$/`); an all-digit key would read as a list position. A key set but
   unusable falls back to the id, the same way in the engine and in the kernel, and the builder
   says why.

3. **The component id keeps everything else.** Rules, errors, selection, the DOM id, focus,
   `ancestor.` and PDF bindings still address the component by id. Only where the answer is
   stored moves. The orchestrator re-keys stored answers by component id for rules
   (`valuesByComponentId`), as it does for containers.

4. **Every place is claimed once.** `findDataKeyProblems` lists, for any tree:
   - `invalid-key` (a key set but unusable);
   - `duplicate-path` (two components storing at one place);
   - `path-conflict` (a place nested under one that cannot hold it: under a single
     answer, `a.b` under a list `a`, `a[]` under an object `a`).

   Two data-scoping containers may
   share an object, so an object can be split across tabs; their fields may not clash. A clash
   in a hand-written definition never throws at runtime: the path maps to every component
   storing there, and both see the value.

5. **The builder refuses a clash where it is made.** The inspector's Data key box is checked
   while typing, and Apply does not apply while its key is unusable or clashes: it leads to the
   box instead (ADR 0111). That holds for a key the draft changes only, so a form that already
   has a clash never holds up an edit to anything else. A rename, a palette add and a drop are
   checked on a scratch copy of the tree and refused through `dropError` or `idError` when they
   would add a clash. On the form's own tree the inspector always shows where the answer is
   stored ("Saves to `billing.street`") under the type, even when the place is the id itself; a
   PDF layout's components store no answers and have no such line. The notes behind the "?" on
   the ID and the Saves to line are described in `docs/data-model.md`, section 1.

6. **A repeating section's entries live at its collection path as written**, whatever container
   sits above it, and the runtime, the PDF and the kernel all read them there (the kernel does
   not prefix the containers above, which would strip the entries of a section inside a
   container or with a custom path).

   A data grid's collection path follows its id as any
   repeating section's does (`collection.collectionPath`, else the id; a rename carries it along,
   and the inspector shows it read-only under "Saves to"), and each cell is keyed in the row by
   its field's data key (`items[0].sku`).

   A field's key within an entry (`buildRowKeys`) is its data key, under any data-scoping
   container inside the entry (`address.city`); the PDF reads an entry's cell, names an entry's
   AcroForm field and resolves `{{row.<key>}}` by it, and the rule evaluator's `row.` and
   `ancestor.` scopes read dotted keys whole before walking into objects. `buildValuePaths`
   does not start treating a section as a level: it is the path a field's own control reads and
   writes, and the browser has no entries to write into.

7. **The runtime mirrors a write into the collection the path names**, a dotted collection path
   included: the first segment that carries an index closes the collection path.

8. **Both ABIs carry it.** The validation kernel reads keys and places entries as in decision 6
   (`docs/reference/sandbox-abi.md`); the payload is unchanged.
   The PDF program reads entries by row key and evaluates rules by component id.

9. **The submission stays a flat map keyed by path.** `submission.values` carries
   `{ "billing.street": "…" }`. The nested document `{ applicant: { email } }` is what the map
   describes, and what the Data workspace shows.

10. **Editing a key rewrites what reads the path.** Changing a component's `dataKey`, or a
    container's scope key, moves the value paths under it, so it rewrites what reads them the way
    a rename does (ADR 0140, decision 9): rules, form tests, PDF template sources and PDF layout
    conditions follow the new path, all in the same undo step as the edit. Undo puts the key and
    every reader back together.

    An Apply that changes a field's id and its data key together makes one history entry. Rules
    inside a repeating section follow the moved data key (the path the answer now has), never the
    id, and the change reports the rename and, for the moves the new id alone does not explain,
    each further move from where the answer was before the Apply to where it is now.

## Consequences

- JSON whose keys repeat across objects can be reproduced exactly; the Data workspace's
  import gives such a component a unique id (`billing_street`) and the JSON's key as its data
  key.
- A form without keys has the paths of decision 1 with the id as every segment.
- A host deploys a sandbox program that knows data keys before forms with keys reach a server.
- A key cannot start with `@`: in the browser a value path whose first segment starts with `@`
  and that the form does not define is a journey's own answer, kept in the browser and never
  sent (ADR 0121). A hand-written collection path that starts with `@`
  still works as form data, and the builder warns about it (`data-key.reserved-prefix`), because
  an own field whose key it would take is dropped on both sides.
- A host's own PDF rendition that reads `row[field.id]` prints a keyed row field blank; it
  must read `row[field.rowKey ?? field.id]`, as the standard renditions do.
- Changing a key moves where stored drafts and records find the answer, exactly as moving a
  field into a container does.
- A data key on a repeating section itself is not offered: its `collectionPath` does that job.
