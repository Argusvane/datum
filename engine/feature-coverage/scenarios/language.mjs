// LOC-01, LOC-02, LOC-03: the language switch. `coverage-chrome` offers English and French; French
// words its labels, a hint, the options, the placeholder, the date parts, the heading and footer,
// the switcher's label, the summary heading and the required message. `coverage-tabs` is Arabic
// for the right-to-left case.

const SWITCH = "select[data-locale-switch]";

/** The words a person meets in the form, by where they are drawn. */
const words = (t) =>
  t.page.evaluate(() => {
    const root = window.fc.hostElement().shadowRoot;
    const text = (selector) => root.querySelector(selector)?.innerText.trim().replace(/\s+/g, " ");
    return {
      heading: text(".datum-form__header [data-chrome-part=heading]"),
      switcher: text(".datum-form__language-switcher-label"),
      label: text("#given__label").replace(/\s*\*$/, ""),
      hint: text("#given__description"),
      colour: text("#colour__label"),
      options: Array.from(root.querySelectorAll("#colour option")).map((o) => o.textContent.trim()),
      dateParts: Array.from(root.querySelectorAll("#born .datum-form__date-part-label")).map((l) => l.textContent.trim()),
      born: text("#born__label"),
      footer: text(".datum-form__footer [data-chrome-part]"),
      summary: text("[data-datum-summary]")
    };
  });

const lang = (t) => t.page.evaluate(() => {
  const form = window.fc.hostElement().shadowRoot.querySelector("form");
  return { lang: form.lang, dir: form.dir };
});

export default {
  id: "language",
  title: "Language: the switcher changes the locale and re-words the form; lang and dir follow",
  features: ["LOC-01", "LOC-02", "LOC-03"],
  async run(t) {
    await t.load("coverage-chrome");
    const en = await words(t);
    t.equal(
      [en.heading, en.switcher, en.label, en.hint, en.colour, en.options, en.dateParts, en.born, en.footer],
      ["Welcome", "Language", "Given name", "As on your passport", "Colour", ["Select…", "Red", "Blue"], ["Day", "Month", "Year"], "Born", "Thank you for your time."],
      "LOC-02: English to start"
    );
    t.equal(await lang(t), { lang: "en", dir: "ltr" }, "LOC-03: the form carries lang en and dir ltr");

    // An answer typed in English, then the switch by keyboard: the select keeps focus.
    await t.type({ path: "given" }, "Ada");
    await t.key("Tab");
    await t.page.locator(SWITCH).focus();
    await t.page.keyboard.press("F");
    await t.drawn();
    t.equal(await t.fc("locale"), "fr", "LOC-01: choosing Français changed the runtime's locale");
    t.equal((await t.events()).filter((e) => e.type === "datum-locale-applied").map((e) => e.detail), [{ locale: "fr" }], "LOC-01: and the host heard it once");
    await t.expectFocus({ tag: "select", id: "datum-form-language-header" }, "LOC-01: the switcher keeps focus");
    const fr = await words(t);
    t.equal(fr.heading, "Bienvenue", "LOC-02: a chrome heading is translated");
    t.equal(fr.footer, "Merci de votre temps.", "LOC-02: a chrome paragraph is translated");
    t.equal(fr.switcher, "Langue", "LOC-02: the switcher's own label is translated");
    t.equal([fr.label, fr.hint, fr.colour, fr.born], ["Prénom", "Comme sur votre passeport", "Couleur", "Né le"], "LOC-02: labels and hints are translated");
    t.equal(fr.options, ["Choisir…", "Rouge", "Bleu"], "LOC-02: options and the placeholder are translated");
    t.equal(fr.dateParts, ["Jour", "Mois", "Année"], "LOC-02: the renderer's own words (the date's parts) are translated");
    t.equal(await lang(t), { lang: "fr", dir: "ltr" }, "LOC-03: lang follows the locale");
    t.equal((await t.values()).given, "Ada", "LOC-01: the answer stayed through the switch");
    const names = (await t.ax()).filter((n) => n.role === "textbox" || n.role === "combobox").map((n) => n.name);
    t.check("LOC-02: the AX tree names the controls in French", names.includes("Prénom") && names.includes("Couleur") && names.includes("Langue"), names);
    const selected = await t.page.evaluate((s) => window.fc.hostElement().shadowRoot.querySelector(s).value, SWITCH);
    t.equal(selected, "fr", "LOC-01: the switcher shows the language in use");
    await t.shared("French");

    // Errors are worded in the language in use, and re-worded by a switch.
    await t.load("coverage-chrome");
    await t.validate();
    t.equal((await words(t)).summary, "1 error Given name: This field is required", "LOC-02: an error in English");
    await t.page.locator(SWITCH).focus();
    await t.page.keyboard.press("F");
    await t.drawn();
    t.equal((await words(t)).summary, "1 erreur Prénom: Ce champ est obligatoire", "LOC-01: switching re-words the errors already showing, the summary's heading included");
    const field = await t.facts("#given");
    t.check("LOC-02: and the field's own message", (field?.describedText ?? []).join(" ").includes("Ce champ est obligatoire"), field);
    await t.shared("French errors");
    await t.page.locator(SWITCH).selectOption("en");
    await t.drawn();
    t.equal(await t.fc("locale"), "en", "LOC-01: switching back changed the locale back");
    t.equal((await words(t)).summary, "1 error Given name: This field is required", "LOC-01: and re-worded in English");
    t.equal((await lang(t)).lang, "en", "LOC-03: lang followed back");

    // A form that starts in French draws French at once.
    await t.load("coverage-chrome", { locale: "fr" });
    t.equal((await words(t)).label, "Prénom", "LOC-02: a form opened in French draws French from the first draw");
    t.equal(await t.page.evaluate((s) => window.fc.hostElement().shadowRoot.querySelector(s).value, SWITCH), "fr", "LOC-01: the switcher starts on the language in use");

    // Right to left.
    await t.load("coverage-tabs", { locale: "ar" });
    t.equal(await lang(t), { lang: "ar", dir: "rtl" }, "LOC-03: an Arabic form carries lang ar and dir rtl");
    await t.shared("Arabic");
  }
};
