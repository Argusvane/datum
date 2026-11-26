// VAL-03: Enter in the one text box of a form is a browser's implicit submission. The form checks
// itself and takes the person to the errors; it never navigates (the page is not left or reloaded).
// `coverage-one-box` has one required box. With a form of several boxes and no submit button a
// browser submits nothing, so there is nothing for the renderer to take over.

export default {
  id: "implicit-submit",
  title: "Enter in a form's one text box checks the form, takes focus to the errors and never navigates",
  features: ["VAL-03"],
  async run(t) {
    await t.load("coverage-one-box");
    await t.page.evaluate(() => {
      window.__stayed = true;
    });
    const url = t.page.url();
    await t.click("#email");
    await t.key("Enter");
    t.equal((await t.errors()).map((e) => e.path), ["email"], "VAL-03: Enter checked the form: the required box is in error");
    await t.expectFocus({ region: "summary" }, "VAL-03: and focus is in the error summary");
    t.equal([t.page.url(), await t.page.evaluate(() => window.__stayed)], [url, true], "VAL-03: the page did not navigate");
    const link = await t.query("[data-datum-summary] a[href]");
    t.equal(link.length, 1, "VAL-03: the summary lists the error");
    await t.shared("implicit submission, summary focus");

    // With Datum's errorFocus "field" the box itself takes focus.
    await t.load("coverage-one-box", { binding: { controls: { errorFocus: "field" } } });
    await t.click("#email");
    await t.key("Enter");
    await t.expectFocus({ valuePath: "email", tag: "input" }, "VAL-03: with errorFocus field the box takes focus");

    // Answered, Enter checks again and finds nothing.
    await t.page.keyboard.type("ada@example.ca");
    await t.key("Enter");
    t.equal(await t.errors(), [], "VAL-03: with the box answered, Enter finds no error");
    t.equal(await t.query("[data-datum-summary] a[href]"), [], "VAL-03: and no summary is drawn");
  }
};
