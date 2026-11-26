// The assertions every scenario runs, after it loads a form and at every state it marks with
// `t.shared(label)` (and once more when it ends). Each one is about what Datum writes, whatever
// the feature under test:
//
//   names       every control in Chromium's AX tree has an accessible name; no control has more
//               than one <label>
//   references  every id an aria-describedby / -labelledby / -controls / -errormessage / -owns /
//               -activedescendant or a label's for names resolves in the same root; ids are
//               unique per root
//   invalid     aria-invalid (and data-invalid) iff the field has a blocking error, and the
//               aria-invalid element is described by that error's text
//   contract    data-component-id + data-value-path on every drawn field's wrapper (a grid row's
//               field: its row path), data-container-id on every container holding a drawn field
//   unsupported Datum draws every engine type: `unsupported()` lists nothing beyond what the
//               fixture is made to hold that nothing draws (its `unsupported` entries)
//   structure   the form root and a tab's own container are drawn as no group
//   runtime     no uncaught page error, no datum-binding-error since the last check

/** AX roles of controls a person operates. */
export const CONTROL_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "spinbutton",
  "slider",
  "button",
  "link",
  "tab",
  "menuitemcheckbox",
  "menuitemradio",
  "date",
  "datetime",
  "inputtime"
]);

async function named(t) {
  const problems = [];
  const nodes = await t.ax();
  const controls = nodes.filter((node) => !node.ignored && CONTROL_ROLES.has(node.role));
  for (const node of controls) {
    if (node.name.trim() === "") problems.push({ rule: "names", message: `a ${node.role} with no accessible name`, at: await t.describeBackend(node.backendId) });
  }
  problems.push(...(await t.fc("labels")));
  return { name: "names", ok: problems.length === 0, controls: controls.length, problems };
}

async function runtime(t) {
  const problems = t.takePageErrors().map((message) => ({ rule: "runtime", message: `uncaught: ${message}` }));
  // The binding errors the mounted form raised since the last check, drained from its list: each
  // load starts a new list, so an index kept across loads would skip the next form's first ones.
  const events = await t.fc("takeBindingErrors");
  for (const event of events) {
    if (event.type === "datum-binding-error") problems.push({ rule: "runtime", message: `datum-binding-error ${JSON.stringify(event.detail)}` });
  }
  return { name: "runtime", ok: problems.length === 0, problems };
}

export async function sharedAssertions(t) {
  const out = [await named(t)];
  for (const [name, call] of [
    ["references", "references"],
    ["invalid", "invalidity"],
    ["contract", "contract"],
    ["unsupported", "unsupportedProblems"],
    ["structure", "structureProblems"]
  ]) {
    const problems = await t.fc(call);
    out.push({ name, ok: problems.length === 0, problems });
  }
  out.push(await runtime(t));
  return out;
}
