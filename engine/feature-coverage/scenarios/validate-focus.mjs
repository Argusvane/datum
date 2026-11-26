// VAL-01, VAL-02: where focus goes when a check finds errors. The `single` corpus form has two
// blocking errors on an empty submit: the required `name` and the required `amount` in the grid's
// first row.

export default {
  id: "validate-focus",
  title: "Validating a form with errors moves focus to the errors",
  features: ["VAL-01", "VAL-02"],
  async run(t) {
    // Datum's own setting: the summary takes focus.
    await t.load("single");
    const first = await t.validate();
    t.equal(first.errors, 2, "VAL-01: the empty form has two blocking errors");
    t.check("VAL-01: the renderer reports that it moved focus", first.focused === true, first);
    await t.expectFocus({ region: "summary" }, "VAL-01: focus is in the error summary");
    const active = await t.active();
    t.check("VAL-01: the focused summary element is the alert box", active?.role === "alert", active);
    const summary = await t.composedText("[data-datum-summary]");
    t.check("VAL-01: the summary names both fields", summary.includes("Full name") && summary.includes("Amount"), summary);
    const nameError = await t.facts(`[data-value-path="name"] input`);
    t.check("VAL-01: the field draws its error under it", (nameError?.describedText ?? []).join(" ").includes("This field is required"), nameError);
    await t.shared("validated (summary focus)");

    // The second check of the same form: focus goes to the summary again, not left where it was.
    await t.click({ path: "age" });
    await t.expectFocus({ valuePath: "age" }, "VAL-01: a click moved focus to Age");
    await t.validate();
    await t.expectFocus({ region: "summary" }, "VAL-01: a second check takes focus back to the summary");

    // The binding's errorFocus "field": the first field in error takes focus.
    await t.load("single", { binding: { controls: { errorFocus: "field" } } });
    const second = await t.validate();
    t.equal(second.errors, 2, "VAL-02: the same two errors");
    await t.expectFocus({ valuePath: "name", tag: "input" }, "VAL-02: focus is on the first field in error");
    await t.shared("validated (field focus)");

    // With the first error fixed, the first field in error is the grid row's amount.
    await t.type({ path: "name" }, "Ada Lovelace");
    await t.key("Tab");
    await t.validate();
    await t.expectFocus({ valuePath: "grid[0].amount", tag: "input" }, "VAL-02: with the name answered, focus goes to the grid row's amount");
    const errors = await t.errors();
    t.equal(errors.map((e) => e.path), ["grid[0].amount"], "VAL-02: one blocking error is left, on the row path");
  }
};
