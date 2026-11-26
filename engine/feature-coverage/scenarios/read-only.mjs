// RO-01, RO-02: a read-only form and a disabled form. The `single` corpus form is mounted with
// answers in every kind it has (text, number, date parts, checkbox, select, checkboxes, a grid
// row, a field in a tab), then each control is tried the ways a person would.

const ANSWERS = {
  name: "Ada Lovelace",
  age: 36,
  start: "2026-03-04",
  has_other: true,
  other: "Chess",
  colour: "blue",
  topics: { news: true },
  grid: [{ when: "2026-02-01", amount: 12.5, category: "taxi" }],
  tabbed: "Tabbed answer"
};

/** The field controls (inside a field wrapper), with what they hold. */
async function fieldControls(t) {
  return t.page.evaluate(() => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.matches("[data-component-id] :is(input:not([type=hidden]),select,textarea)")) {
          out.push({
            id: el.id,
            valuePath: el.closest("[data-value-path]")?.getAttribute("data-value-path"),
            type: el.type,
            value: el.value,
            checked: el.checked,
            disabled: el.disabled,
            readOnly: el.readOnly === true || el.getAttribute("aria-readonly") === "true",
            inert: el.closest("[inert]") !== null
          });
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(window.fc.hostElement().shadowRoot);
    return out;
  });
}

/** What a script or an extension does: write a value and fire input + change, bypassing readonly. */
async function forceWrite(t, selector, value) {
  await t.page.evaluate(
    ([sel, v]) => {
      const find = (root) => {
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const el of root.querySelectorAll("*")) {
          const inner = el.shadowRoot && find(el.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const el = find(window.fc.hostElement().shadowRoot);
      if (el.type === "checkbox") el.checked = !el.checked;
      else el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    },
    [selector, value]
  );
  await t.drawn();
}

function shows(controls, path, check) {
  return controls.filter((c) => c.valuePath === path).some(check);
}

export default {
  id: "read-only",
  title: "Read-only and disabled forms show the answers and take no write",
  features: ["RO-01", "RO-02"],
  async run(t) {
    // ── RO-01 read-only ───────────────────────────────────────────────────────────────────
    await t.load("single", { mode: "readonly", preset: ANSWERS });
    const before = await t.values();
    let controls = await fieldControls(t);
    t.check("RO-01: field controls drawn", controls.length >= 10, controls.length);
    t.check("RO-01: the text answer shows", shows(controls, "name", (c) => c.value === "Ada Lovelace"), controls.filter((c) => c.valuePath === "name"));
    t.check("RO-01: the number answer shows", shows(controls, "age", (c) => c.value === "36"));
    t.check("RO-01: the date answer shows in its parts", ["4", "3", "2026"].every((v) => shows(controls, "start", (c) => c.value.replace(/^0/, "") === v)), controls.filter((c) => c.valuePath === "start"));
    t.check("RO-01: the checkbox answer shows", shows(controls, "has_other", (c) => c.checked));
    t.check("RO-01: the select answer shows", shows(controls, "colour", (c) => c.value === "blue"));
    t.check("RO-01: the checkboxes answer shows", shows(controls, "topics", (c) => c.checked) && controls.filter((c) => c.valuePath === "topics" && c.checked).length === 1);
    t.check("RO-01: the grid row's answer shows", shows(controls, "grid[0].amount", (c) => c.value === "12.5"));
    t.check("RO-01: the tabbed answer shows", shows(controls, "tabbed", (c) => c.value === "Tabbed answer"));
    const blocked = controls.filter((c) => c.disabled || c.inert);
    t.check("RO-01: no field control is disabled or inert (they stay focusable)", blocked.length === 0, blocked);
    const writable = controls.filter((c) => !c.readOnly);
    t.check("RO-01: every field control is read-only (readonly or aria-readonly)", writable.length === 0, writable);
    const wrappers = await t.page.evaluate(() => [...window.fc.hostElement().shadowRoot.querySelectorAll("[data-component-id]")].map((w) => ({ id: w.getAttribute("data-component-id"), readonly: w.hasAttribute("data-readonly"), disabled: w.hasAttribute("data-disabled") })));
    t.check("RO-01: every field wrapper carries data-readonly and not data-disabled", wrappers.length > 0 && wrappers.every((w) => w.readonly && !w.disabled), wrappers.filter((w) => !w.readonly || w.disabled));

    // A person tries every control: focus lands, nothing is written.
    await t.click({ path: "name" });
    await t.expectFocus({ valuePath: "name", tag: "input" }, "RO-01: a read-only text box takes focus");
    await t.page.keyboard.type("XYZ");
    await t.key("Backspace");
    await t.click({ path: "has_other" });
    await t.expectFocus({ valuePath: "has_other" }, "RO-01: a read-only checkbox takes focus");
    await t.key("Space");
    await t.click({ path: "topics", nth: 1 });
    await t.page.locator(`[data-value-path="colour"] select`).selectOption("red");
    await t.drawn();
    await t.click({ path: "grid[0].amount" });
    await t.page.keyboard.type("99");
    await t.key("Tab");
    t.equal(await t.values(), before, "RO-01: typing, clicking, Space and a select pick write nothing");
    controls = await fieldControls(t);
    t.check("RO-01: the controls still show the answers after the attempts", shows(controls, "name", (c) => c.value === "Ada Lovelace") && shows(controls, "has_other", (c) => c.checked) && shows(controls, "colour", (c) => c.value === "blue") && controls.filter((c) => c.valuePath === "topics" && c.checked).length === 1, controls.filter((c) => ["name", "has_other", "colour", "topics"].includes(c.valuePath)));

    // A script writing past readonly (input + change events) reaches nothing either.
    await forceWrite(t, `[data-value-path="name"] input`, "Forced");
    await forceWrite(t, `[data-value-path="start"] input`, "9");
    await forceWrite(t, `[data-value-path="has_other"] input`, "");
    t.equal(await t.values(), before, "RO-01: forced input/change events write nothing");
    await t.shared("read-only after the attempts");

    // ── RO-02 disabled ────────────────────────────────────────────────────────────────────
    await t.load("single", { mode: "disabled", preset: ANSWERS });
    const disabledBefore = await t.values();
    controls = await fieldControls(t);
    const enabled = controls.filter((c) => !c.disabled);
    t.check("RO-02: every field control is disabled", controls.length >= 10 && enabled.length === 0, enabled);
    t.check("RO-02: the answers still show", shows(controls, "name", (c) => c.value === "Ada Lovelace") && shows(controls, "colour", (c) => c.value === "blue") && shows(controls, "grid[0].amount", (c) => c.value === "12.5"));
    const disabledWrappers = await t.page.evaluate(() => [...window.fc.hostElement().shadowRoot.querySelectorAll("[data-component-id]")].map((w) => ({ id: w.getAttribute("data-component-id"), readonly: w.hasAttribute("data-readonly"), disabled: w.hasAttribute("data-disabled") })));
    // data-readonly stays only where the field is read-only by itself: `double` is worked out by a rule.
    t.check("RO-02: every field wrapper carries data-disabled", disabledWrappers.length > 0 && disabledWrappers.every((w) => w.disabled), disabledWrappers.filter((w) => !w.disabled));
    t.equal(disabledWrappers.filter((w) => w.readonly).map((w) => w.id), ["double"], "RO-02: data-readonly only on the calculated field, read-only by itself");
    await forceWrite(t, `[data-value-path="name"] input`, "Forced");
    await forceWrite(t, `[data-value-path="has_other"] input`, "");
    t.equal(await t.values(), disabledBefore, "RO-02: forced input/change events write nothing");
    await t.shared("disabled after the attempts");
  }
};
