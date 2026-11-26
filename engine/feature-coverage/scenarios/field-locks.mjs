// RO-03, RO-04: a field marked read-only or disabled in an interactive form behaves so on its own
// (the rest of the form stays writable), and a read-only long answer is sized to show in full.
// The `locks` form has a free text, a read-only text, textarea, checkbox and select, a disabled
// text, and an editable textarea to compare the sizing with.

const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long answer that goes on and on about nothing in particular for a good while`).join("\n");
const ANSWERS = { free: "Free text", locked: "Fixed", off: "Dim", memo: LONG, notes: LONG, ticked: true, picked: "b" };

const wait = (t, ms) => t.page.waitForTimeout(ms);

/** The textareas' boxes: how much is scrolled away. */
const boxes = (t) =>
  t.page.evaluate(() => {
    const out = {};
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.localName === "textarea") out[el.closest("[data-value-path]").dataset.valuePath] = { scroll: el.scrollHeight, client: el.clientHeight, width: el.clientWidth };
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(window.fc.hostElement().shadowRoot);
    return out;
  });

/** What a script or an extension does: write a value and fire input + change, bypassing the control's own guard. */
function forceWrite(t, path, value) {
  return t.page.evaluate(
    ([p, v]) => {
      const find = (root) => {
        const hit = root.querySelector(`[data-value-path="${p}"] :is(input,select,textarea)`);
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
    [path, value]
  );
}

const hooks = (t, path) => t.facts(`[data-value-path="${path}"]`).then((f) => f?.attributes ?? {});

export const LOCK_SCENARIOS = [
  {
    id: "field-locks",
    title: "A read-only or disabled field in an interactive form behaves so; the others stay writable",
    features: ["RO-03"],
    async run(t) {
      await t.load("locks", { preset: ANSWERS });
      const before = await t.values();

      // Marks: read-only is not disabled, and the other way round.
      const locked = await hooks(t, "locked");
      t.check("RO-03: a read-only field's wrapper says so and not disabled", "data-readonly" in locked && !("data-disabled" in locked), locked);
      const off = await hooks(t, "off");
      t.check("RO-03: a disabled field's wrapper says so and not read-only", "data-disabled" in off && !("data-readonly" in off), off);
      const free = await hooks(t, "free");
      t.check("RO-03: a free field says neither", !("data-readonly" in free) && !("data-disabled" in free), free);
      const lockedBox = await t.facts(`[data-value-path="locked"] input`);
      t.check("RO-03: the read-only box is read-only, not disabled, and shows its answer", lockedBox.readOnly === true && lockedBox.disabled === false && lockedBox.value === "Fixed", lockedBox);
      const offBox = await t.facts(`[data-value-path="off"] input`);
      t.check("RO-03: the disabled box is disabled and shows its answer", offBox.disabled === true && offBox.value === "Dim", offBox);
      const tick = await t.facts(`[data-value-path="ticked"] input`);
      t.check("RO-03: a read-only checkbox is aria-readonly, checked and not disabled", tick.attributes["aria-readonly"] === "true" && tick.checked === true && tick.disabled === false, tick);
      const pick = await t.facts(`[data-value-path="picked"] select`);
      t.check("RO-03: a read-only select is aria-readonly, shows its choice and is not disabled", pick.attributes["aria-readonly"] === "true" && pick.value === "b" && pick.disabled === false, pick);

      // The keyboard meets the read-only fields and passes over the disabled one.
      await t.click({ path: "free" });
      await t.key("Tab");
      await t.expectFocus({ valuePath: "locked", tag: "input" }, "RO-03: Tab reaches the read-only box");
      await t.key("Tab");
      await t.expectFocus({ valuePath: "memo", tag: "textarea" }, "RO-03: Tab passes over the disabled box to the next field");

      // Nothing writes to a locked field: typing, clicks, Space, a select pick.
      await t.click({ path: "locked" });
      await t.page.keyboard.type("XYZ");
      await t.click({ path: "ticked" });
      await t.key("Space");
      await t.page.locator(`[data-value-path="picked"] select`).selectOption("a");
      await t.drawn();
      await forceWrite(t, "locked", "Forced");
      await forceWrite(t, "off", "Forced");
      await forceWrite(t, "ticked", "");
      await forceWrite(t, "picked", "a");
      await wait(t, 100);
      t.equal(await t.values(), before, "RO-03: typing, clicks, Space, a pick and forced events write nothing to a locked field");
      const after = await t.facts(`[data-value-path="picked"] select`);
      t.check("RO-03: the select shows its stored choice again after the attempt", after.value === "b", after.value);

      // The free field takes its writes as ever.
      await t.type({ path: "free" }, "!");
      t.equal((await t.values()).free, "Free text!", "RO-03: a free field in the same form is still writable");
      await t.shared("locks");
    }
  },
  {
    id: "readonly-sizing",
    title: "A read-only long answer is sized to show in full",
    features: ["RO-04"],
    async run(t) {
      await t.load("locks", { preset: ANSWERS });
      let sizes = await boxes(t);
      t.check("RO-04: a read-only textarea shows its whole answer (nothing scrolled away)", sizes.memo.scroll <= sizes.memo.client, sizes.memo);
      t.check("RO-04: an editable textarea keeps its own rows (the answer is longer than the box)", sizes.notes.scroll > sizes.notes.client, sizes.notes);
      t.check("RO-04: the read-only box is taller than the editable one", sizes.memo.client > sizes.notes.client, sizes);

      // A narrower page wraps the lines: the box follows.
      await t.page.setViewportSize({ width: 360, height: 900 });
      await wait(t, 300);
      sizes = await boxes(t);
      t.check("RO-04: after the page narrows the read-only box still shows its whole answer", sizes.memo.scroll <= sizes.memo.client, sizes.memo);
      await t.page.setViewportSize({ width: 1280, height: 900 });

      // The whole read-only form: every long answer shows.
      await t.load("locks", { mode: "readonly", preset: ANSWERS });
      sizes = await boxes(t);
      t.check("RO-04: in a read-only form the long answers show in full", sizes.memo.scroll <= sizes.memo.client && sizes.notes.scroll <= sizes.notes.client, sizes);

      // One long line that wraps at the width the form opens at: its line count says one row and
      // no width change follows, so only the measurement after the draw shows it whole.
      const paragraph = Array.from({ length: 40 }, (_, i) => `sentence ${i + 1} that wraps`).join(" ");
      await t.load("locks", { preset: { ...ANSWERS, memo: paragraph } });
      sizes = await boxes(t);
      t.check("RO-04: a read-only answer of one long wrapped line shows in full at the width the form opens at", sizes.memo.scroll <= sizes.memo.client, sizes.memo);
    }
  }
];
