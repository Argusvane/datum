// CNT-01, CNT-02: a field with a length limit shows its count, says it once the typing pauses
// (politely, for the field being typed in only), and past the limit is marked and raises its
// error. The `counts` form has three fields with a limit of 10, 10 and 20 characters.

const PAUSE = 1400; // the announcer waits 1000 ms after the last keystroke
const SHORT = 500; // less than the wait: a keystroke every SHORT ms keeps restarting it

const wait = (t, ms) => t.page.waitForTimeout(ms);
const visibleCount = (t, path) => t.composedText(`[data-count-for="${path}"] [aria-hidden="true"]`);

export default {
  id: "count-announce",
  title: "A field's count is shown, and said once after a pause, for the focused field only",
  features: ["CNT-01", "CNT-02"],
  async run(t) {
    await t.load("counts");
    t.equal(await visibleCount(t, "bio"), "10 characters left", "CNT-01: an empty field shows the whole limit left");
    const facts = await t.facts(`[data-value-path="bio"] input`);
    t.check("CNT-01: the control is described by the limit sentence", (facts?.describedText ?? []).includes("You can enter up to 10 characters"), facts);
    const regions = await t.query("[data-count-announcer]");
    t.check("CNT-01: the form has one polite status region for counts", regions.length === 1 && regions[0].role === "status", regions);
    t.equal((await t.liveText()).filter((r) => r.at?.role === "status" && r.text !== "").length, 0, "CNT-01: the region says nothing before anyone types");

    // Typing: the visible count follows every keystroke, nothing is said while typing.
    await t.type({ path: "bio" }, "abc");
    t.equal(await visibleCount(t, "bio"), "7 characters left", "CNT-01: the count follows the typing");
    t.equal(await t.announcements(), [], "CNT-01: nothing is said while the person types");

    // Typing pauses: said once, politely.
    await wait(t, PAUSE);
    const said = await t.announcements();
    t.equal(said.map((a) => a.text), ["7 characters left"], "CNT-01: the count is said once typing pauses");
    t.check("CNT-01: said politely", said.length === 1 && said[0].politeness === "polite", said);
    await wait(t, PAUSE);
    t.equal(await t.announcements(), [], "CNT-01: nothing more is said while nobody types");
    // A keystroke and its undo inside one wait end on the words already said: not said again.
    await t.key("x");
    await t.key("Backspace");
    t.equal(await visibleCount(t, "bio"), "7 characters left", "CNT-01: the count is back where it was said");
    await wait(t, PAUSE);
    t.equal(await t.announcements(), [], "CNT-01: a count already said is not said again (typed and undone within the pause)");

    // A burst with pauses shorter than the wait: each keystroke restarts it, one announcement at the end.
    await t.key("d");
    await wait(t, SHORT);
    await t.key("e");
    await wait(t, SHORT);
    t.equal(await t.announcements(), [], "CNT-01: each keystroke restarts the wait (nothing said 500 ms after the last)");
    await wait(t, PAUSE);
    t.equal((await t.announcements()).map((a) => a.text), ["5 characters left"], "CNT-01: one announcement for the whole burst, with the words as they stand at the end");

    // Only the field being typed in speaks: a value set from outside is shown, not said.
    await t.fc("setValue", "other", "xyz");
    await t.drawn();
    t.equal(await visibleCount(t, "other"), "7 characters left", "CNT-01: another field's count is shown when its answer is set from outside");
    await wait(t, PAUSE);
    t.equal(await t.announcements(), [], "CNT-01: an answer set from outside is not said, whichever field has focus");

    // Moving to the other field and typing: it speaks for itself.
    await t.type({ path: "other" }, "w");
    await wait(t, PAUSE);
    t.equal((await t.announcements()).map((a) => a.text), ["6 characters left"], "CNT-01: the field being typed in is the one said");
    await t.shared("counts said");

    // ── CNT-02: past the limit ────────────────────────────────────────────────────────────
    await t.click({ path: "bio" });
    await t.page.keyboard.press("End");
    await t.page.keyboard.type("fghijk");
    await t.drawn();
    t.equal(await t.facts(`[data-value-path="bio"]`).then((f) => "data-over-limit" in (f?.attributes ?? {})), true, "CNT-02: the field is marked over its limit while typing");
    t.check("CNT-02: the visible count says how far over", (await visibleCount(t, "bio")).includes("over"), await visibleCount(t, "bio"));
    t.equal(await t.errors(), [], "CNT-02: no error before a check is due (nothing was checked yet)");
    await wait(t, PAUSE);
    const over = await t.announcements();
    t.check("CNT-02: the count past the limit is said politely too", over.length === 1 && over[0].politeness === "polite" && over[0].text.includes("over"), over);
    const checked = await t.validate();
    t.equal(checked.errors, 1, "CNT-02: checking the form raises the limit's error");
    t.equal((await t.errors()).map((e) => [e.code, e.path]), [["maxLength", "bio"]], "CNT-02: it is the length error on the field");
    const wrapper = await t.facts(`[data-value-path="bio"]`);
    t.check("CNT-02: the wrapper is marked over-limit and invalid", "data-over-limit" in wrapper.attributes && "data-invalid" in wrapper.attributes, wrapper.attributes);
    const control = await t.facts(`[data-value-path="bio"] input`);
    t.check("CNT-02: the control is aria-invalid and described by the count and the error", control.attributes["aria-invalid"] === "true" && control.describedText.includes("Enter no more than 10 characters"), control);
    t.check("CNT-02: the summary lists it", (await t.composedText("[data-datum-summary]")).includes("Enter no more than 10 characters"));
    await t.shared("over the limit");

    // Back under the limit: the mark goes with the extra characters, the error once the answer is left.
    await t.click({ path: "bio" });
    await t.page.keyboard.press("End");
    for (let i = 0; i < 6; i += 1) await t.key("Backspace");
    t.equal(await t.facts(`[data-value-path="bio"]`).then((f) => "data-over-limit" in (f?.attributes ?? {})), false, "CNT-02: the mark goes as soon as the answer is back under the limit");
    await t.key("Tab");
    t.equal(await t.errors(), [], "CNT-02: the error goes when the shortened answer is left");
    await t.shared("back under the limit");
  }
};
