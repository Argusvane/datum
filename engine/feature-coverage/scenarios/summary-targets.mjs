// SUM-02 (radios, a date), SUM-03, SUM-04, SUM-05: where each kind of summary line goes. On
// `coverage-summary` an empty check gives name, contact (radios), birth (a date) and a grid
// cell. A line goes to its field's focus target: a radio group's checked option else its first,
// a date's first missing part, a grid row's own field; a cell error no row owns goes to the
// grid's Add button; a form-level error is listed with no link.

const LINKS = "[data-datum-summary] a[href]";
const ids = (list) => list.map((d) => d.id);

async function follow(t, hasText) {
  await t.page.locator(LINKS, { hasText }).first().click();
  await t.drawn();
}

export default {
  id: "summary-targets",
  title: "Summary lines go to their field's focus target: radios, a date's missing part, a grid row, the grid's Add button",
  features: ["SUM-02", "SUM-03", "SUM-04", "SUM-05"],
  async run(t) {
    await t.load("coverage-summary");
    await t.validate();
    const first = await t.query(LINKS);
    t.equal(first.map((l) => l.text), [
      "Full name: This field is required",
      "Contact by: This field is required",
      "Date of birth: This field is required",
      "Row 1: Cost: This field is required"
    ], "SUM-01: the lines, in form order, with the row's name on the grid's");

    // Radios with nothing checked: the group's first option.
    await follow(t, "Contact by");
    await t.expectFocus({ tag: "input", type: "radio", id: "contact__0" }, "SUM-02: a radio group with nothing checked goes to its first option");
    // A date with nothing typed: its first part, in the drawn order (day, month, year).
    await follow(t, "Date of birth");
    await t.expectFocus({ id: "birth__day", valuePath: "birth" }, "SUM-02: an empty date goes to its first part");
    // A grid row's cell: that row's field.
    await follow(t, "Row 1");
    await t.expectFocus({ valuePath: "rows[0].cost", tag: "input" }, "SUM-03: a grid cell's line goes to that row's field");
    await t.shared("after the first links");

    // A date typed in part: the line goes to the first part still missing.
    await t.type({ path: "birth" }, "7");
    await t.validate();
    const incomplete = await t.query(LINKS);
    t.check("DAT-02: the date's line says what is wrong", incomplete.some((l) => /Date of birth/.test(l.text ?? "") && !/This field is required/.test(l.text ?? "")), incomplete.map((l) => l.text));
    await follow(t, "Date of birth");
    await t.expectFocus({ id: "birth__month", valuePath: "birth" }, "SUM-02: a date with only the day typed goes to its month part");
    await t.page.keyboard.type("3");
    await t.drawn();
    await t.validate();
    await follow(t, "Date of birth");
    await t.expectFocus({ id: "birth__year", valuePath: "birth" }, "SUM-02: with day and month typed the line goes to the year part");
    await t.shared("a date typed in part");

    // Radios: a checked option is the target, not the first.
    await t.load("coverage-summary", { preset: { contact: "phone" } });
    await t.fc("setErrors", [{ code: "unavailable", message: "Phone is not available", componentId: "contact", path: "contact" }]);
    await t.drawn();
    await follow(t, "Contact by");
    await t.expectFocus({ tag: "input", type: "radio", id: "contact__1" }, "SUM-02: a radio group with an option checked goes to the checked option");
    const checked = await t.facts("#contact__1");
    t.equal(checked?.checked, true, "SUM-02: that option is the checked one");
    await t.shared("a checked radio in error");

    // Grid: a cell error on a row that is not there goes to the grid's Add button; a row's own goes to its field;
    // an error for no field is listed with no link.
    await t.load("coverage-summary");
    await t.fc("setErrors", [
      { code: "far", message: "Cost is wrong", componentId: "cost", path: "rows[3].cost" },
      { code: "pair", message: "Left is wrong", componentId: "left", path: "pair[0].left" },
      { code: "form", message: "The form could not be sent" }
    ]);
    await t.drawn();
    const lines = await t.page.evaluate(() => {
      const box = window.fc.hostElement().shadowRoot.querySelector("[data-datum-summary]");
      return Array.from(box.querySelectorAll("li")).map((li) => ({ text: li.textContent.trim().replace(/\s+/g, " "), link: li.querySelector("a[href]") !== null }));
    });
    t.equal(lines.filter((l) => !l.link).map((l) => l.text), ["The form could not be sent"], "SUM-04: a form-level error is listed with no link");
    t.equal(lines.filter((l) => l.link).length, 2, "SUM-04: the field errors keep their links");
    await follow(t, "Cost is wrong");
    await t.expectFocus({ id: "rows__add", tag: "button" }, "SUM-03: a cell error no row owns goes to the grid's Add button");
    await follow(t, "Left is wrong");
    await t.expectFocus({ valuePath: "pair[0].left", tag: "input" }, "SUM-03: a cell error on a row that exists goes to its field");

    // The summary follows the errors: answering takes the line away, and the last one takes the summary with it.
    await t.load("coverage-summary");
    await t.validate();
    t.equal((await t.query(LINKS)).length, 4, "SUM-05: four lines to start");
    await t.type({ path: "name" }, "Ada Lovelace");
    await t.key("Tab");
    await t.validate();
    t.equal((await t.query(LINKS)).length, 3, "SUM-05: answering the name took its line away");
    await t.page.locator("#contact__2").check();
    await t.drawn();
    await t.type({ path: "birth" }, "7");
    await t.page.keyboard.press("Tab");
    await t.page.keyboard.type("3");
    await t.page.keyboard.press("Tab");
    await t.page.keyboard.type("1990");
    await t.drawn();
    await t.type({ path: "rows[0].cost" }, "12");
    await t.key("Tab");
    await t.validate();
    t.equal(await t.errors(), [], "SUM-05: no errors are left");
    t.equal(await t.query("[data-datum-summary]"), [], "SUM-05: the summary is gone with the last error");
    await t.shared("all answered");
  }
};
