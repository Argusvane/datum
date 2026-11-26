// SUM-01, SUM-02: the error summary's lines and links. On the `single` corpus form an empty
// submit gives two blocking errors, in form order: `name`, then `amount` in the grid's first row.

const LINKS = "[data-datum-summary] a[href]";

export default {
  id: "summary-links",
  title: "The error summary lists the blocking errors and each link focuses its field",
  features: ["SUM-01", "SUM-02"],
  async run(t) {
    await t.load("single");
    await t.validate();
    const errors = await t.errors();
    const blocking = errors.filter((e) => e.severity === undefined || e.severity === "error");
    const links = await t.query(LINKS);
    t.equal(links.length, blocking.length, "SUM-01: one link per blocking error");
    const heading = await t.composedText("[data-datum-summary] h2, [data-datum-summary] [role=heading]");
    t.check("SUM-01: the heading gives the count", heading.includes(String(blocking.length)), heading);
    const texts = links.map((l) => l.text ?? "");
    t.check("SUM-01: lines in form order, each with its label and message", /Full name/.test(texts[0] ?? "") && /Amount/.test(texts[1] ?? "") && texts.every((x) => x.includes("This field is required")), texts);
    t.check("SUM-01: a row field's line names its row", /Row 1/.test(texts[1] ?? ""), texts[1]);

    // Each link goes to its field's control: the href names an id in the same root, a click focuses it.
    const expected = blocking.map((e) => e.path);
    t.equal(expected, ["name", "grid[0].amount"], "SUM-02: the errors' value paths");
    for (let i = 0; i < links.length; i += 1) {
      const href = await t.page.locator(LINKS).nth(i).getAttribute("href");
      const id = (href ?? "").replace(/^#/, "");
      const target = await t.query(`[id="${id}"]`);
      t.check(`SUM-02: link ${i + 1}'s href ${href} names one element`, target.length === 1, target);
      await t.page.locator(LINKS).nth(i).click();
      await t.drawn();
      await t.expectFocus({ valuePath: expected[i], id }, `SUM-02: link ${i + 1} focuses ${expected[i]}'s control`);
      const active = await t.active();
      t.check(`SUM-02: link ${i + 1} lands on a control, not the wrapper`, ["input", "select", "textarea", "button"].includes(active?.tag ?? ""), active);
      // Back to the summary for the next link, as a keyboard user would go.
      await t.page.locator("[data-datum-summary] [tabindex]").first().focus();
    }
    await t.shared("after following every link");

    // A link still works once the summary was drawn again: answer the first, check again, follow the one left.
    await t.type({ path: "name" }, "Ada Lovelace");
    await t.key("Tab");
    await t.validate();
    const left = await t.query(LINKS);
    t.equal(left.length, 1, "SUM-02: one line left after answering the name");
    await t.page.locator(LINKS).first().click();
    await t.drawn();
    await t.expectFocus({ valuePath: "grid[0].amount" }, "SUM-02: the redrawn summary's link focuses the grid row's amount");
  }
};
