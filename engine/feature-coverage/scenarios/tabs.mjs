// TAB-01, TAB-02, VAL-07: the tabs container. `coverage-tabs` has three tabs (General, Contact,
// Extra), a required field in the last two. Keys: arrows, Home, End; in a right-to-left form the
// arrows turn round. A check that finds an error in a shut tab opens it before focus lands, and a
// tab holding an error is marked.

const TAB = '[role="tab"]';
const selectedTab = async (t) => (await t.page.evaluate(() => window.fc.query('[role="tab"][aria-selected="true"]'))).map((d) => d.id);

export default {
  id: "tabs",
  title: "Tab keys move and select, a tab holding an error is marked and a check opens it",
  features: ["TAB-01", "TAB-02", "VAL-07"],
  async run(t) {
    await t.load("coverage-tabs");
    t.equal(await selectedTab(t), ["sections__tab-general"], "TAB-01: the first tab is selected to start");
    await t.page.locator(TAB).first().focus();
    await t.key("ArrowRight");
    t.equal(await selectedTab(t), ["sections__tab-contact"], "TAB-01: ArrowRight selects the next tab");
    await t.expectFocus({ id: "sections__tab-contact" }, "TAB-01: ArrowRight moves focus with the selection");
    const panels = await t.page.evaluate(() => window.fc.query('[role="tabpanel"]:not([hidden])').map((d) => d.id));
    t.equal(panels, ["sections__panel-contact"], "TAB-01: only the selected tab's panel shows");
    await t.key("End");
    t.equal(await selectedTab(t), ["sections__tab-extra"], "TAB-01: End selects the last tab");
    await t.key("ArrowRight");
    t.equal(await selectedTab(t), ["sections__tab-general"], "TAB-01: ArrowRight on the last tab wraps to the first");
    await t.key("ArrowLeft");
    t.equal(await selectedTab(t), ["sections__tab-extra"], "TAB-01: ArrowLeft on the first tab wraps to the last");
    await t.key("Home");
    t.equal(await selectedTab(t), ["sections__tab-general"], "TAB-01: Home selects the first tab");
    await t.expectFocus({ id: "sections__tab-general" }, "TAB-01: Home moves focus to the first tab");
    const stops = await t.page.evaluate(() => window.fc.query('[role="tab"][tabindex="0"]').map((d) => d.id));
    t.equal(stops, ["sections__tab-general"], "TAB-01: only the selected tab is in the tab order");
    await t.shared("after the keys");

    // A check that finds errors in the shut tabs: the first with one is opened and marked, the others marked.
    const checked = await t.validate();
    t.equal(checked.errors, 2, "VAL-07: two blocking errors, both in shut tabs");
    t.equal(await selectedTab(t), ["sections__tab-contact"], "VAL-07: the check opened the first tab holding an error");
    await t.expectFocus({ region: "summary" }, "VAL-07: focus is in the summary (Datum's errorFocus)");
    const marked = await t.page.evaluate(() => window.fc.query('[role="tab"][data-has-errors]').map((d) => d.id));
    t.equal(marked, ["sections__tab-contact", "sections__tab-extra"], "TAB-02: the tabs holding errors are marked, the other is not");
    await t.shared("validated (summary focus)");

    // A summary link to a field in a shut tab opens the tab, then focuses the field.
    const link = t.page.locator('[data-datum-summary] a[href]', { hasText: "Code" });
    await link.click();
    await t.drawn();
    t.equal(await selectedTab(t), ["sections__tab-extra"], "VAL-07: the summary link opened the tab holding its field");
    await t.expectFocus({ valuePath: "code", tag: "input" }, "VAL-07: and focused the field");

    // Fixing the field clears its tab's mark.
    await t.type({ path: "code" }, "X1");
    await t.key("Tab");
    await t.validate();
    const left = await t.page.evaluate(() => window.fc.query('[role="tab"][data-has-errors]').map((d) => d.id));
    t.equal(left, ["sections__tab-contact"], "TAB-02: answering the field cleared its tab's mark");

    // errorFocus "field": the first field in error takes focus, in a tab opened for it.
    await t.load("coverage-tabs", { binding: { controls: { errorFocus: "field" } } });
    await t.validate();
    t.equal(await selectedTab(t), ["sections__tab-contact"], "VAL-07: errorFocus field opened the tab of the first error");
    await t.expectFocus({ valuePath: "email", tag: "input" }, "VAL-07: and focused its field");
    await t.shared("validated (field focus)");

    // Right to left: the arrows turn round.
    await t.load("coverage-tabs", { locale: "ar" });
    const dir = await t.facts("form");
    t.equal(dir?.attributes?.dir, "rtl", "TAB-01: an Arabic form is right to left");
    await t.page.locator(TAB).first().focus();
    await t.key("ArrowLeft");
    t.equal(await selectedTab(t), ["sections__tab-contact"], "TAB-01: in a right-to-left form ArrowLeft selects the next tab");
    await t.key("ArrowRight");
    t.equal(await selectedTab(t), ["sections__tab-general"], "TAB-01: in a right-to-left form ArrowRight selects the previous tab");
    await t.key("ArrowRight");
    t.equal(await selectedTab(t), ["sections__tab-extra"], "TAB-01: in a right-to-left form ArrowRight on the first wraps to the last");
  }
};
