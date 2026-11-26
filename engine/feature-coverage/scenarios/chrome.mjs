// CHR-01, CHR-02, CHR-03: the form's chrome. `coverage-chrome` carries a header (a heading and a
// language switcher), a footer (a paragraph) and the `outlined` frame; the corpus `single` form
// carries none of them and must draw none (no empty boxes).

const regions = (t) =>
  t.page.evaluate(() => {
    const root = window.fc.hostElement().shadowRoot;
    const form = root.querySelector("form");
    const kids = Array.from(form.children).map((el) => el.className.split(" ")[0]);
    const part = (selector) =>
      Array.from(root.querySelectorAll(selector)).map((el) => ({ part: el.getAttribute("data-chrome-part"), tag: el.localName, text: el.textContent.trim().replace(/\s+/g, " ") }));
    return {
      kids,
      header: part(".datum-form__header [data-chrome-part]"),
      footer: part(".datum-form__footer [data-chrome-part]"),
      frameClass: form.classList.contains("datum-form--frame-outlined"),
      frame: form.getAttribute("data-frame")
    };
  });

export default {
  id: "chrome",
  title: "Chrome: header and footer parts, the frame and the language switcher in it",
  features: ["CHR-01", "CHR-02", "CHR-03"],
  async run(t) {
    await t.load("coverage-chrome");
    const drawn = await regions(t);
    t.equal(drawn.header.map((p) => [p.part, p.tag]), [["heading", "h2"], ["language-switcher", "div"]], "CHR-01: the header draws its two parts, in order");
    t.equal(drawn.header[0]?.text, "Welcome", "CHR-01: the heading says what the author wrote");
    t.equal(drawn.footer.map((p) => [p.part, p.tag, p.text]), [["text", "p", "Thank you for your time."]], "CHR-01: the footer draws its paragraph");
    const order = drawn.kids.filter((k) => k === "datum-form__header" || k === "datum-live-container" || k === "datum-form__footer");
    t.equal(order, ["datum-form__header", "datum-live-container", "datum-form__footer"], "CHR-01: the header comes before the fields and the footer after them");
    t.check("CHR-02: the frame preset puts its class on the form", drawn.frameClass === true, drawn);
    t.equal(drawn.frame, "outlined", "CHR-02: and its id in data-frame");

    // The switcher: in the header, one label, a combobox named by it, an option per language in its own words.
    const switcher = await t.page.evaluate(() => {
      const select = window.fc.hostElement().shadowRoot.querySelector(".datum-form__header select[data-locale-switch]");
      if (!select) return null;
      return {
        labels: Array.from(select.labels ?? []).map((l) => l.textContent.trim()),
        options: Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent.trim(), lang: o.lang, selected: o.selected }))
      };
    });
    t.check("CHR-03: the language switcher is in the header", switcher !== null);
    t.equal(switcher?.labels, ["Language"], "CHR-03: the switcher has one label");
    t.equal(switcher?.options, [
      { value: "en", text: "English", lang: "en", selected: true },
      { value: "fr", text: "Français", lang: "fr", selected: false }
    ], "CHR-03: one option per language the form offers, each in its own, marked with its language");
    const ax = (await t.ax()).filter((n) => n.role === "combobox" && n.name === "Language");
    t.equal(ax.length, 1, "CHR-03: the switcher is a combobox named Language in the AX tree");
    await t.shared("chrome drawn");

    // A form with none draws none: no header or footer box, no frame.
    await t.load("single");
    const bare = await regions(t);
    t.equal([bare.header, bare.footer], [[], []], "CHR-01: a form without chrome draws no chrome parts");
    t.equal(bare.kids.filter((k) => k === "datum-form__header" || k === "datum-form__footer"), [], "CHR-01: and no empty header or footer box");
    t.equal([bare.frameClass, bare.frame], [false, null], "CHR-02: and no frame");
  }
};
