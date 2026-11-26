// DAT-01 to DAT-05: the date in part boxes. `coverage-dates` has a required date (`due`), an
// optional one (`start`) and a date in a grid row; `coverage-chrome` has one beside a language
// switcher, for the part order that follows the locale.

const parts = (t, path) =>
  t.page.evaluate(
    (p) => Array.from(window.fc.hostElement().shadowRoot.querySelectorAll(`[data-value-path="${p}"] [data-value-part]`)).map((el) => ({ part: el.dataset.valuePart, id: el.id, value: el.value })),
    path
  );
const boxes = async (t, path) => Object.fromEntries((await parts(t, path)).map((p) => [p.part, p.value]));
const order = async (t, path) => (await parts(t, path)).map((p) => p.part);
const answer = async (t, path) => (await t.values())[path];

export default {
  id: "dates",
  title: "Dates: parts compose one answer, an incomplete date is reported and focused, a month by name is read, order, IME",
  features: ["DAT-01", "DAT-02", "DAT-03", "DAT-04", "DAT-05"],
  async run(t) {
    await t.load("coverage-dates");
    t.equal(await order(t, "due"), ["day", "month", "year"], "DAT-04: the parts are drawn day, month, year by default");

    // Compose: nothing is stored until all three parts are in.
    await t.type("#due__day", "7");
    t.equal(await answer(t, "due"), undefined, "DAT-01: with only the day typed nothing is stored");
    await t.key("Tab");
    await t.page.keyboard.type("3");
    await t.drawn();
    t.equal(await answer(t, "due"), undefined, "DAT-01: with day and month typed nothing is stored");
    await t.key("Tab");
    await t.page.keyboard.type("1990");
    await t.drawn();
    t.equal(await answer(t, "due"), "1990-03-07", "DAT-01: the three parts compose one stored date");
    t.equal(await boxes(t, "due"), { day: "7", month: "3", year: "1990" }, "DAT-01: the boxes keep what was typed");
    // The answer written by the runtime reaches the boxes.
    await t.fc("setValue", "start", "2021-12-25");
    await t.drawn();
    t.equal(await boxes(t, "start"), { day: "25", month: "12", year: "2021" }, "DAT-01: a stored date is drawn in its parts");
    // A date in a grid row composes on the row's path.
    await t.type({ path: "trips[0].leaves" }, "1");
    await t.key("Tab");
    await t.page.keyboard.type("2");
    await t.key("Tab");
    await t.page.keyboard.type("2030");
    await t.drawn();
    t.equal((await t.fc("rows", "trips")).rows, [{ leaves: "2030-02-01" }], "DAT-01: a date in a grid row composes into the row");
    await t.shared("dates composed");

    // Moving between the parts checks nothing; leaving the group does not either before a submit.
    t.equal(await t.errors(), [], "DAT-01: no error shows for a date still being typed");

    // Incomplete: reported once checked, and focus goes to the first part still missing.
    await t.load("coverage-dates", { preset: { due: "2026-01-02" } });
    await t.type("#start__year", "2020");
    await t.key("Tab");
    t.equal(await answer(t, "start"), undefined, "DAT-02: a date typed in part and left incomplete stores nothing");
    t.equal(await t.errors(), [], "DAT-02: and shows no error before a check");
    const checked = await t.validate();
    t.equal(checked.errors, 1, "DAT-02: the check reports the incomplete date");
    const errors = await t.errors();
    t.equal(errors.map((e) => [e.code, e.path]), [["dateIncomplete", "start"]], "DAT-02: as dateIncomplete on the date");
    const described = await t.facts("#start__day");
    t.check("DAT-02: the part is invalid and described by the error", described?.attributes?.["aria-invalid"] === "true" && (described?.describedText ?? []).join(" ").includes("Enter a complete date"), described);
    await t.expectFocus({ region: "summary" }, "DAT-02: focus goes to the summary (Datum's errorFocus)");
    await t.page.locator("[data-datum-summary] a[href]").first().click();
    await t.drawn();
    await t.expectFocus({ id: "start__day" }, "DAT-02: the summary line goes to the first missing part (the day; the year is typed)");
    await t.shared("incomplete date");
    await t.page.keyboard.type("5");
    await t.key("Tab");
    await t.validate();
    await t.page.locator("[data-datum-summary] a[href]").first().click();
    await t.drawn();
    await t.expectFocus({ id: "start__month" }, "DAT-02: with the day typed too, the first missing part is the month");

    // errorFocus "field": focus goes straight to the first missing part.
    await t.load("coverage-dates", { preset: { due: "2026-01-02" }, binding: { controls: { errorFocus: "field" } } });
    await t.type("#start__month", "6");
    await t.key("Tab");
    await t.validate();
    await t.expectFocus({ id: "start__day" }, "DAT-02: errorFocus field lands on the first missing part");
    // An impossible date is not "incomplete": the first part takes focus.
    await t.type("#start__day", "31");
    await t.key("Tab");
    await t.key("Tab");
    await t.page.keyboard.type("2024");
    await t.drawn();
    await t.validate();
    const impossible = await t.errors();
    t.equal(impossible.map((e) => [e.code, e.path]), [["date", "start"]], "DAT-02: 31 June is a date error, not an incomplete one");

    // A month typed by name is read, and stays as typed.
    await t.load("coverage-dates");
    await t.type("#due__day", "7");
    await t.key("Tab");
    await t.page.keyboard.type("March");
    await t.key("Tab");
    await t.page.keyboard.type("1990");
    await t.drawn();
    t.equal(await answer(t, "due"), "1990-03-07", "DAT-03: a month typed as a name is read");
    t.equal((await boxes(t, "due")).month, "March", "DAT-03: the box keeps the word typed");
    await t.page.locator("#due__month").fill("sep");
    await t.page.locator("#due__month").dispatchEvent("change");
    await t.drawn();
    t.equal(await answer(t, "due"), "1990-09-07", "DAT-03: an abbreviation is read");
    await t.page.locator("#due__month").fill("Smarch");
    await t.page.locator("#due__month").dispatchEvent("change");
    await t.drawn();
    t.equal(await answer(t, "due"), "1990-Smarch-07", "DAT-03: a word that is no month is kept as typed ...");
    await t.validate();
    t.equal((await t.errors()).map((e) => [e.code, e.path]), [["date", "due"]], "DAT-03: ... for the check to call it not a real date");

    // Part order: fixed, or by the locale.
    await t.load("coverage-dates", { dateOrder: ["year", "month", "day"] });
    t.equal(await order(t, "due"), ["year", "month", "day"], "DAT-04: a fixed order is drawn as given");
    await t.type("#due__year", "2000");
    await t.validate();
    await t.page.locator("[data-datum-summary] a[href]").first().click();
    await t.drawn();
    await t.expectFocus({ id: "due__month" }, "DAT-04: the first missing part follows the drawn order (year typed, so the month)");

    await t.load("coverage-chrome", { dateOrder: { en: ["month", "day", "year"], default: ["day", "month", "year"] } });
    t.equal(await order(t, "born"), ["month", "day", "year"], "DAT-04: English draws month, day, year");
    const labels = await t.page.evaluate(() => Array.from(window.fc.hostElement().shadowRoot.querySelectorAll('[data-value-path="born"] .datum-form__date-part-label')).map((l) => l.textContent.trim()));
    t.equal(labels, ["Month", "Day", "Year"], "DAT-04: and names them in that order");
    await t.page.locator("select[data-locale-switch]").selectOption("fr");
    await t.drawn();
    t.equal(await order(t, "born"), ["day", "month", "year"], "DAT-04: switching to French redraws day, month, year");
    const frLabels = await t.page.evaluate(() => Array.from(window.fc.hostElement().shadowRoot.querySelectorAll('[data-value-path="born"] .datum-form__date-part-label')).map((l) => l.textContent.trim()));
    t.equal(frLabels, ["Jour", "Mois", "Année"], "DAT-04: with the part names in French");
    await t.type("#born__day", "9");
    await t.key("Tab");
    await t.page.keyboard.type("mars");
    await t.key("Tab");
    await t.page.keyboard.type("1985");
    await t.drawn();
    t.equal(await answer(t, "born"), "1985-03-09", "DAT-03: in French a month named in French is read");
    await t.shared("French dates");

    // IME: nothing is written into the box an input method is composing in; the draws held meanwhile land at the end.
    await t.load("coverage-dates");
    await t.type("#due__day", "7");
    await t.key("Tab");
    await t.page.keyboard.type("3");
    await t.key("Tab");
    await t.page.locator("#due__year").focus();
    await t.cdp.send("Input.imeSetComposition", { text: "199", selectionStart: 3, selectionEnd: 3 });
    await t.cdp.send("Input.imeSetComposition", { text: "1990", selectionStart: 4, selectionEnd: 4 });
    const during = await t.page.evaluate(() => ({ box: window.fc.hostElement().shadowRoot.querySelector("#due__year").value }));
    t.equal(during.box, "1990", "DAT-05: the box shows what is being composed");
    // The runtime writes the same answer, and another date's, while the composition is open.
    await t.fc("setValue", "due", "2001-04-05");
    await t.fc("setValue", "start", "2022-08-09");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const meanwhile = await t.page.evaluate(() => ({
      year: window.fc.hostElement().shadowRoot.querySelector("#due__year").value,
      startYear: window.fc.hostElement().shadowRoot.querySelector("#start__year").value,
      composing: document.activeElement?.shadowRoot?.activeElement?.id
    }));
    t.equal(meanwhile.year, "1990", "DAT-05: a runtime write does not replace the text being composed");
    t.equal(meanwhile.composing, "due__year", "DAT-05: focus stays in the composing box");
    t.equal(meanwhile.startYear, "", "DAT-05: the draw is held until the composition ends");
    await t.cdp.send("Input.insertText", { text: "1990" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await t.drawn();
    t.equal((await boxes(t, "due")).year, "1990", "DAT-05: the composed year stands when the composition ends");
    t.equal(await boxes(t, "start"), { day: "09", month: "08", year: "2022" }, "DAT-05: the held draw landed after the composition");
    await t.expectFocus({ id: "due__year" }, "DAT-05: and focus is still in the box");
    await t.shared("after composition");

    // A runtime write to the very date being composed: the boxes left alone take the written
    // parts, the composing box keeps what was composed.
    await t.load("coverage-dates");
    await t.page.locator("#due__day").focus();
    await t.cdp.send("Input.imeSetComposition", { text: "1", selectionStart: 1, selectionEnd: 1 });
    await t.cdp.send("Input.imeSetComposition", { text: "12", selectionStart: 2, selectionEnd: 2 });
    await t.fc("setValue", "due", "2026-05-06");
    await new Promise((resolve) => setTimeout(resolve, 150));
    t.equal((await boxes(t, "due")).day, "12", "DAT-05: a write to the composing date does not replace the text being composed");
    await t.cdp.send("Input.insertText", { text: "12" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await t.drawn();
    t.equal(await boxes(t, "due"), { day: "12", month: "05", year: "2026" }, "DAT-05: the written month and year survive the composition in the day box");
    t.equal(await answer(t, "due"), "2026-05-12", "DAT-05: the stored date is the written one with the composed day");
    await t.expectFocus({ id: "due__day" }, "DAT-05: focus is still in the composed box");
    await t.shared("write to the composing date");
  }
};
