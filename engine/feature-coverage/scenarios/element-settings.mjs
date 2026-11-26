// The element's own settings: what <datum-form-renderer> offers a host beyond
// the renderer it wraps. The live host has no element, so every scenario here is declared
// `hosts: ["element"]` and runs there only. One scenario per feature.
//
//   ELM-01  a binding named by an id nothing registered is reported, Datum's draws meanwhile,
//           and registering the id draws with it at once
//   ELM-02  extraStyles reach the drawn form as the last sheet, and follow every redraw and remount
//   ELM-03  colorScheme draws the binding's dark look in place, without mounting the form again
//   ELM-04  capabilitiesOf answers what the binding draws for a type, before and after a change of binding
//   ELM-05  a setting the form is built from mounts it again (mode, binding); an equal value does not,
//           and the host's answers survive the mount

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` (bounded) until `test` holds; the last reading either way. */
async function until(t, read, test, tries = 40) {
  let value = await read();
  for (let i = 0; i < tries && !test(value); i += 1) {
    await sleep(50);
    await t.drawn();
    value = await read();
  }
  return value;
}

const bindingErrors = async (t) => (await t.fc("takeBindingErrors")).map((event) => event.detail);

// ── ELM-01 ─────────────────────────────────────────────────────────────────────────────────

const lateBinding = {
  id: "element-binding-id",
  title: "A binding id nothing registered is reported once and Datum draws meanwhile; registering the id draws with it at once",
  hosts: ["element"],
  features: ["ELM-01"],
  async run(t) {
    await t.load("coverage-one-box");
    const marked = () => t.query("[data-drawn-by]");
    t.equal(await marked(), [], "ELM-01: Datum's binding draws the form to start");
    t.equal(await t.fc("adapterOf", "email"), { from: "binding", via: "text", name: "datum-text" }, "ELM-01: and its text adapter draws the box");

    // The element names a binding by id before the page has registered it.
    await bindingErrors(t);
    await t.fc("setElement", "binding", "fc-late");
    const reported = await bindingErrors(t);
    t.equal(
      reported.map((detail) => [detail.hook, detail.id]),
      [["binding", "fc-late"]],
      "ELM-01: an id nothing registered is reported as a datum-binding-error naming the id"
    );
    t.check("ELM-01: the report says which binding draws instead", /Datum's binding/.test(reported[0]?.message ?? ""), reported[0]);
    t.equal((await t.query('[data-value-path="email"] input')).length, 1, "ELM-01: the form is drawn by Datum's binding meanwhile");
    t.equal(await marked(), [], "ELM-01: and nothing of another binding is drawn");
    await t.shared("unregistered id");

    // Typed answers and later draws do not say it again.
    await t.type({ path: "email" }, "ada@example.com");
    await t.key("Tab");
    t.equal(await bindingErrors(t), [], "ELM-01: the report is made once for the id, however often the form draws");

    // The page registers the id: the element draws with it at once, and keeps what was typed.
    await t.fc("registerBinding", "fc-late", ["fc-registered"]);
    const drawn = await until(t, marked, (found) => found.length === 1);
    t.equal(drawn.length, 1, "ELM-01: registering the id draws the form with that binding at once");
    t.equal(await t.fc("adapterOf", "email"), { from: "binding", via: "text", name: "feature-coverage registered text" }, "ELM-01: its adapter now draws the box");
    t.equal((await t.values()).email, "ada@example.com", "ELM-01: the answer typed meanwhile is kept");
    t.equal((await t.query('[data-value-path="email"] input')).length, 1, "ELM-01: the box is still there");
    t.equal(await bindingErrors(t), [], "ELM-01: a registered id is reported no more");
    await t.shared("registered id");

    // Replacing the registration under the same id draws again with the new binding.
    await t.fc("registerBinding", "fc-late", []);
    const replaced = await until(t, marked, (found) => found.length === 0);
    t.equal(replaced.length, 0, "ELM-01: a binding registered again under the id replaces the first, which draws no more");
    await t.shared("registered again");
  }
};

// ── ELM-02 ─────────────────────────────────────────────────────────────────────────────────

const extraStyles = {
  id: "element-extra-styles",
  title: "extraStyles reach the drawn form as the last sheet and follow every redraw and remount",
  hosts: ["element"],
  features: ["ELM-02"],
  async run(t) {
    const RULE = '[data-component-id="email"] { outline: 3px solid rgb(1, 2, 3); }';
    const outline = () => t.fc("computed", '[data-component-id="email"]', "outline-color");
    await t.load("coverage-one-box");
    const before = await outline();
    t.check("ELM-02: nothing outlines the field to start", before !== "rgb(1, 2, 3)", before);

    await t.fc("setElement", "extraStyles", RULE);
    t.equal(await outline(), "rgb(1, 2, 3)", "ELM-02: a rule set on the element applies to the drawn form");
    // A second value replaces the first: the sheet is one, not a pile.
    await t.fc("setElement", "extraStyles", '[data-component-id="email"] { outline: 3px solid rgb(4, 5, 6); }');
    t.equal(await outline(), "rgb(4, 5, 6)", "ELM-02: a new value replaces the old rule");
    await t.fc("setElement", "extraStyles", RULE);

    // A redraw keeps it.
    await t.type({ path: "email" }, "ada@example.com");
    await t.key("Tab");
    t.equal(await outline(), "rgb(1, 2, 3)", "ELM-02: a redraw keeps the rule");

    // A remount (another mode, then another binding) keeps it too.
    await t.fc("setElement", "mode", "readonly");
    t.equal(await outline(), "rgb(1, 2, 3)", "ELM-02: the form mounted again for another mode still has the rule");
    await t.fc("registerBinding", "fc-styled", ["fc-registered"]);
    await t.fc("setElement", "binding", "fc-styled");
    t.equal((await until(t, () => t.query("[data-drawn-by]"), (found) => found.length === 1)).length, 1, "ELM-02: the form is drawn by the other binding");
    t.equal(await outline(), "rgb(1, 2, 3)", "ELM-02: and the rule still applies under it");

    // Cleared, it goes.
    await t.fc("setElement", "extraStyles", "");
    t.check("ELM-02: setting it to nothing takes the rule away", (await outline()) !== "rgb(1, 2, 3)", await outline());
    await t.shared("extra styles");
  }
};

// ── ELM-03 ─────────────────────────────────────────────────────────────────────────────────

const colorScheme = {
  id: "element-color-scheme",
  title: "colorScheme draws the binding's dark look in place, with the form, its focus and its answers kept",
  hosts: ["element"],
  features: ["ELM-03"],
  async run(t) {
    await t.load("coverage-one-box");
    const dark = () => t.page.evaluate(() => window.fc.query("form.datum-form--dark").length === 1);
    t.equal(await dark(), false, "ELM-03: the form is drawn light to start");
    await t.type({ path: "email" }, "ada@");
    await t.fc("markForm");
    const look = async () => JSON.stringify([await t.fc("computed", "form", "background-color"), await t.fc("computed", "form", "color")]);
    const before = await look();

    await t.fc("setElement", "colorScheme", "dark");
    t.equal(await dark(), true, "ELM-03: colorScheme dark draws the binding's dark look");
    t.check("ELM-03: and the form's colours change with it", (await look()) !== before, { before, after: await look() });
    t.equal(await t.fc("formMarked"), true, "ELM-03: the same form element is drawn again, not mounted anew");
    await t.expectFocus({ valuePath: "email" }, "ELM-03: focus stays in the box the person was typing in");
    t.equal((await t.values()).email, "ada@", "ELM-03: and so does what was typed");
    await t.shared("dark");

    await t.fc("setElement", "colorScheme", "light");
    t.equal(await dark(), false, "ELM-03: light draws it light again");
    await t.fc("setElement", "colorScheme", "dark");
    await t.fc("setElement", "colorScheme", undefined);
    t.equal(await dark(), false, "ELM-03: unset is light");
    t.equal(await t.fc("formMarked"), true, "ELM-03: no change of scheme mounted the form again");

    // A binding with no dark look shows as itself in either scheme.
    await t.load("coverage-one-box", { binding: { dark: false } });
    await t.fc("setElement", "colorScheme", "dark");
    t.equal(await dark(), false, "ELM-03: a binding with no dark look (dark: false) is drawn light under a dark scheme");
    await t.shared("no dark look");
  }
};

// ── ELM-04 ─────────────────────────────────────────────────────────────────────────────────

const capabilities = {
  id: "element-capabilities",
  title: "capabilitiesOf answers what the binding draws for a type, from the kind registry and the adapter, and follows a change of binding",
  hosts: ["element"],
  features: ["ELM-04"],
  async run(t) {
    await t.load("coverage-unknown");
    const text = await t.fc("capabilitiesOf", "text");
    t.check("ELM-04: a text field is a text kind drawn by Datum's adapter", text?.kind === "text" && ["binding", "datum", "datum-base"].includes(text.from), text);
    t.equal([text?.answers.placeholder, text?.answers.tooltip, text?.answers.characterCount, text?.answers.hideLabel], ["drawn", "drawn", "drawn", "drawn"], "ELM-04: Datum draws the placeholder, tooltip, count and hidden label of a text field");
    t.equal(text?.answers.rowNumbers, undefined, "ELM-04: a capability the registry does not ask of the kind is left out");
    const date = await t.fc("capabilitiesOf", "date");
    t.equal(date?.kind, "date", "ELM-04: a date field reads as the date kind");
    t.equal(date?.answers.characterCount, undefined, "ELM-04: and is not asked about a character count");
    t.equal(await t.fc("capabilitiesOf", "mystery-dial"), null, "ELM-04: a type nothing draws has no answers");
    t.equal((await t.fc("capabilitiesOf", "number"))?.kind, "number", "ELM-04: a number field reads as the number kind");

    // Another binding answers for the types it draws; Datum's stand behind it for the rest.
    await t.fc("registerBinding", "fc-answers", ["fc-registered"]);
    await t.fc("setElement", "binding", "fc-answers");
    const own = await until(t, () => t.fc("capabilitiesOf", "text"), (found) => found?.answers.placeholder === "none");
    t.equal(own?.answers.placeholder, "none", "ELM-04: a binding that does not draw a placeholder says so");
    t.equal(own?.from, "binding", "ELM-04: the answer is the binding's own adapter's");
    t.equal(own?.answers.tooltip, "drawn", "ELM-04: and keeps the rest of its adapter's answers");
    const number = await t.fc("capabilitiesOf", "number");
    t.check("ELM-04: a type the binding did not change keeps Datum's answers", number?.kind === "number" && number.answers.placeholder === "drawn", number);

    await t.fc("setElement", "binding", undefined);
    const back = await until(t, () => t.fc("capabilitiesOf", "text"), (found) => found?.answers.placeholder === "drawn");
    t.equal(back?.answers.placeholder, "drawn", "ELM-04: back on Datum's binding the placeholder is drawn again");
    await t.shared("capabilities");
  }
};

// ── ELM-05 ─────────────────────────────────────────────────────────────────────────────────

const remount = {
  id: "element-remount",
  title: "A setting the form is built from mounts it again; an equal value does not; the host's answers survive",
  hosts: ["element"],
  features: ["ELM-05"],
  async run(t) {
    await t.load("coverage-one-box");
    await t.type({ path: "email" }, "ada@example.com");
    await t.key("Tab");
    await t.fc("markForm");
    t.equal(await t.fc("formMarked"), true, "ELM-05: the drawn form is marked");

    // Setting what it already is mounts nothing.
    await t.fc("setElement", "mode", "interactive");
    t.equal(await t.fc("formMarked"), true, "ELM-05: setting the mode the element already holds draws the same form");

    // A draw for another reason keeps it.
    await t.fc("setValue", "email", "grace@example.com");
    await t.drawn();
    t.equal(await t.fc("formMarked"), true, "ELM-05: an answer written by the host is a draw, not a mount");

    // Another mode mounts a new form: read-only, with the answer in it.
    await t.fc("setElement", "mode", "readonly");
    t.equal(await t.fc("formMarked"), false, "ELM-05: another mode mounts the form anew");
    const box = await t.facts('[data-value-path="email"] input');
    t.check("ELM-05: the new form shows the answer read-only", box?.value === "grace@example.com" && box.readOnly === true, box);
    t.equal((await t.values()).email, "grace@example.com", "ELM-05: the runtime kept the answer through the mount");
    await t.shared("read-only");

    // And back; another binding mounts anew too.
    await t.fc("setElement", "mode", "interactive");
    const interactive = await t.facts('[data-value-path="email"] input');
    t.check("ELM-05: back in the interactive mode the box takes answers again", interactive?.readOnly === false && interactive.value === "grace@example.com", interactive);
    await t.fc("markForm");
    await t.fc("registerBinding", "fc-remount", ["fc-registered"]);
    await t.fc("setElement", "binding", "fc-remount");
    await until(t, () => t.query("[data-drawn-by]"), (found) => found.length === 1);
    t.equal(await t.fc("formMarked"), false, "ELM-05: another binding mounts the form anew");
    await t.fc("markForm");
    await t.fc("setElement", "binding", "fc-remount");
    t.equal(await t.fc("formMarked"), true, "ELM-05: naming the binding it already has draws the same form");
    t.equal((await t.values()).email, "grace@example.com", "ELM-05: and the answer survives that mount too");
    await t.type({ path: "email" }, "!");
    t.equal((await t.values()).email, "grace@example.com!", "ELM-05: the new form takes answers");
    await t.shared("remounted");
  }
};

export const ELEMENT_SCENARIOS = [lateBinding, extraStyles, colorScheme, capabilities, remount];
