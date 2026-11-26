// JNY-01 to JNY-04: a journey through the runtime. The corpus `journey` form has pages intro (a
// required name), contact (a way to be reached, an email required when it is the way, a code that
// routes to the exit page on "STOP"), details (only when asked for) and review (the last page).
// Continue and Back go through the runtime's page moves; a page with errors stays and shows them;
// a new page's heading takes focus; the last page's button reports the journey's final submit.

const view = (t) => t.fc("journey");
const nextButton = "[data-journey-continue]";
const backButton = "[data-journey-back]";
const actionEvents = async (t) => (await t.events()).filter((e) => e.type === "datum-form-action");

async function goForward(t) {
  await t.page.locator(nextButton).click();
  await t.drawn();
}

export default {
  id: "journey",
  title: "Journey: Continue, Back, blocked pages, heading focus and the final submit",
  features: ["JNY-01", "JNY-02", "JNY-03", "JNY-04"],
  async run(t) {
    await t.load("journey");
    t.equal((await view(t))?.pageId, "intro", "JNY-01: the journey starts on its first page");
    t.equal(await t.query(backButton), [], "JNY-02: the first page has no Back");

    // Continue with the required name empty: stays, the error is drawn, the summary takes focus.
    await goForward(t);
    t.equal((await view(t))?.pageId, "intro", "JNY-03: Continue on a page with an error stays on it");
    await t.expectFocus({ region: "summary" }, "JNY-03: and focuses the error summary");
    t.equal((await t.errors()).map((e) => e.path), ["applicant_name"], "JNY-03: the error is the page's required name");
    const inline = await t.facts("#applicant_name");
    t.check("JNY-03: the field draws its error", inline?.attributes?.["aria-invalid"] === "true" && (inline.describedText ?? []).join(" ").includes("This field is required"), inline);
    await t.shared("blocked on the first page");

    // Enter in a text box is Continue, and is blocked the same way.
    await t.click("#applicant_name");
    await t.key("Enter");
    t.equal((await view(t))?.pageId, "intro", "JNY-03: Enter in a text box stays too while the page has an error");
    await t.expectFocus({ region: "summary" }, "JNY-03: and focuses the summary");

    // Answered: on to the next page, heading focused.
    await t.type("#applicant_name", "Ada Lovelace");
    await t.key("Tab");
    await t.page.keyboard.type("30");
    await t.drawn();
    await goForward(t);
    t.equal((await view(t))?.pageId, "contact", "JNY-01: Continue went to the next page");
    await t.expectFocus({ tag: "h1", id: "contact__page-heading" }, "JNY-01: focus is on the new page's heading");
    t.equal(await t.query("[data-journey-heading]"), await t.query("#contact__page-heading"), "JNY-01: that heading is the page's only heading");
    t.check("JNY-01: the first page's fields are gone", (await t.query("#applicant_name")).length === 0);
    t.equal(await t.query(`${backButton}`).then((l) => l.length), 1, "JNY-02: the second page has Back");
    await t.shared("second page");

    // A rule-made requirement blocks the move; Back is never blocked.
    await t.page.locator("#contact_method").selectOption("email");
    await t.drawn();
    await goForward(t);
    t.equal((await view(t))?.pageId, "contact", "JNY-03: an email required by the chosen way blocks Continue");
    t.equal((await t.errors()).map((e) => e.path), ["email"], "JNY-03: the error is the email");
    await t.expectFocus({ region: "summary" }, "JNY-03: the summary takes focus");
    await t.page.locator(backButton).click();
    await t.drawn();
    t.equal((await view(t))?.pageId, "intro", "JNY-02: Back went to the previous page despite the error");
    await t.expectFocus({ tag: "h1", id: "intro__page-heading" }, "JNY-02: focus is on its heading");
    t.equal((await t.facts("#applicant_name"))?.value, "Ada Lovelace", "JNY-02: the earlier answers are drawn again");
    await t.shared("back on the first page");

    // The path follows the answers: a box on page one brings a page into it.
    t.equal((await view(t))?.path, ["intro", "contact", "review"], "JNY-01: the path to start");
    await t.click("#wants_details");
    t.equal((await view(t))?.path, ["intro", "contact", "details", "review"], "JNY-01: asking for details brought the details page in");
    await t.click("#wants_details");

    // A route to an exit page.
    await goForward(t);
    await t.page.locator("#contact_method").selectOption("phone");
    await t.drawn();
    await t.type("#stop_code", "STOP");
    await goForward(t);
    t.equal((await view(t))?.pageId, "stop", "JNY-01: a route sent Continue to the exit page");
    await t.expectFocus({ tag: "h1", id: "stop__page-heading" }, "JNY-01: and its heading took focus");
    t.equal(await t.query(nextButton), [], "JNY-04: an exit page has no Continue or Submit");
    await t.page.locator(backButton).click();
    await t.drawn();
    t.equal((await view(t))?.pageId, "contact", "JNY-02: Back from the exit page went to the page before it");

    // The last page: its button is the journey's final submit.
    await t.page.locator("#stop_code").fill("");
    await t.page.locator("#stop_code").dispatchEvent("change");
    await t.drawn();
    await goForward(t);
    t.equal((await view(t))?.pageId, "review", "JNY-01: with the way phone and no stop code, Continue went to the last page");
    const submit = await t.query(nextButton);
    t.equal(submit.map((b) => b.text), ["Submit"], "JNY-04: the last page's button says Submit");
    t.equal((await actionEvents(t)).length, 0, "JNY-04: nothing was submitted by getting there");
    await t.page.locator(nextButton).click();
    await t.drawn();
    const actions = await actionEvents(t);
    t.equal(actions.map((e) => e.detail), [{ componentId: "form", action: "submit", journey: { journeyId: "main", pageId: "review" } }], "JNY-04: the last page's button reported the journey's final submit once");
    t.equal((await view(t))?.pageId, "review", "JNY-04: and stays on the page for the host to answer");
    await t.shared("last page");
  }
};
