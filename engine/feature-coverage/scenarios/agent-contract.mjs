// AGT-01..AGT-05: the DOM and the calls the agent layer (packages/datum agent-host.ts)
// reads the form through. The renderer promises a wrapper per field with `data-component-id` and
// `data-value-path` (a grid row's field: its row path), a wrapper per container with
// `data-container-id`, state hooks on every field wrapper, `settleInput()` to commit what is being
// typed, and `focusField` to reveal and focus a field by id. Each scenario reads them the way the
// agent host does (`[data-component-id], [data-container-id]` queries and `focusedValuePath()`).
import { fcx, has, until } from "./behaviour-kit.mjs";

/** Every field wrapper in the form: its hooks, by data-value-path. */
const fieldWrappers = (t) =>
  t.page.evaluate(() => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.hasAttribute("data-component-id")) out.push(Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])));
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(window.fc.hostElement().shadowRoot);
    return out;
  });

const containers = (t) =>
  t.page.evaluate(() => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.hasAttribute("data-container-id")) out.push({ id: el.getAttribute("data-container-id"), kind: el.getAttribute("data-kind") });
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(window.fc.hostElement().shadowRoot);
    return out;
  });

/** What the agent host's `scrollTo` and highlight find for an id. */
const findById = (t, id) => t.query(`[data-component-id="${id}"], [data-container-id="${id}"]`);

/** Whether the field's wrapper takes room on the page (a hidden tab or step panel gives it none). */
const shown = (t, id) =>
  t.page.evaluate((componentId) => {
    const find = (root) => {
      const hit = root.querySelector(`[data-component-id="${componentId}"]`);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        const inner = el.shadowRoot && find(el.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const wrapper = find(window.fc.hostElement().shadowRoot);
    return wrapper !== null && wrapper.getClientRects().length > 0;
  }, id);

const SINGLE_PATHS = ["name", "age", "start", "has_other", "detail", "colour", "topics", "double", "grid[0].when", "grid[0].amount", "grid[0].category", "receipt", "tabbed", "blurb", "send"];

export const AGENT_SCENARIOS = [
  {
    id: "agent-dom-contract",
    title: "Fields carry their id and value path (a grid row's field its row path), containers their id",
    features: ["AGT-01", "AGT-02"],
    async run(t) {
      await t.load("single");
      let fields = await fieldWrappers(t);
      t.equal(fields.map((f) => f["data-value-path"]), SINGLE_PATHS, "AGT-01: every drawn field has a wrapper with its value path, in form order");
      t.check("AGT-01: and its component id (the definition's, never the row's)", fields.every((f) => typeof f["data-component-id"] === "string" && f["data-component-id"] !== ""), fields);
      t.equal(fields.find((f) => f["data-value-path"] === "grid[0].amount")?.["data-component-id"], "amount", "AGT-01: a grid row's field has the column's id and its row path");
      t.check("AGT-01: a hidden field (visibleWhen) has no wrapper", !fields.some((f) => f["data-component-id"] === "other"), fields.map((f) => f["data-component-id"]));

      // Rows added: each row's fields carry their own row path.
      await t.page.locator(`[data-container-id="grid"] button`, { hasText: /add/i }).first().click();
      await t.drawn();
      await t.page.locator(`[data-container-id="grid"] button`, { hasText: /add/i }).first().click();
      await t.drawn();
      fields = await fieldWrappers(t);
      const rowPaths = fields.map((f) => f["data-value-path"]).filter((p) => p.startsWith("grid["));
      t.equal(rowPaths, [0, 1, 2].flatMap((i) => ["when", "amount", "category"].map((c) => `grid[${i}].${c}`)), "AGT-01: three rows draw nine row fields, row by row");
      const amounts = fields.filter((f) => f["data-component-id"] === "amount").map((f) => f["data-value-path"]);
      t.equal(amounts, ["grid[0].amount", "grid[1].amount", "grid[2].amount"], "AGT-01: the same column in each row has its own row path");
      t.equal((await findById(t, "amount")).length, 3, "AGT-01: the agent's lookup by component id finds every row's field");

      // The agent host reads the focused field's path from the DOM.
      await t.click({ path: "grid[1].amount" });
      t.equal(await fcx(t, "focusedValuePath"), "grid[1].amount", "AGT-01: focus in a grid row's box reads as the row path");
      await t.click({ path: "name" });
      t.equal(await fcx(t, "focusedValuePath"), "name", "AGT-01: focus in a plain box reads as its path");
      await t.click({ path: "tabbed" });
      t.equal(await fcx(t, "focusedValuePath"), "tabbed", "AGT-01: and in a field inside a tab");
      await t.click({ path: "has_other" });
      t.equal(await fcx(t, "focusedValuePath"), undefined, "AGT-01: focus on a checkbox is not a caret control, so reads as nothing");
      await t.shared("rows added");

      // ── AGT-02 containers ─────────────────────────────────────────────────────────────────
      const boxes = await containers(t);
      t.equal(boxes.map((c) => c.id).sort(), ["dates", "form", "grid", "tab1", "tabs"], "AGT-02: the form, the fieldset, the grid, the tabs and the tab each carry their id once");
      t.equal(Object.fromEntries(boxes.map((c) => [c.id, c.kind])), { form: "form", dates: "fieldset", grid: "dataGrid", tabs: "tabs", tab1: "tab" }, "AGT-02: with their kind");
      for (const id of ["form", "dates", "grid", "tabs", "tab1"]) {
        t.equal((await findById(t, id)).length, 1, `AGT-02: the lookup by id finds the ${id} container once`);
      }
      const nested = await t.query(`[data-container-id="dates"] [data-component-id="start"]`);
      t.equal(nested.length, 1, "AGT-02: a field is inside its container's element");
      const marker = await t.page.evaluate(() => {
        const find = (root) => {
          const hit = root.querySelector('[data-component-id="name"]');
          if (hit) return hit;
          for (const el of root.querySelectorAll("*")) {
            const inner = el.shadowRoot && find(el.shadowRoot);
            if (inner) return inner;
          }
          return null;
        };
        const wrapper = find(window.fc.hostElement().shadowRoot);
        wrapper.setAttribute("data-agent-touched", "");
        return true;
      });
      await t.type({ path: "age" }, "40");
      t.check("AGT-01: the agent's own mark on a wrapper survives the redraws that follow", marker && (await t.facts(`[data-component-id="name"]`)).attributes["data-agent-touched"] === "", (await t.facts(`[data-component-id="name"]`)).attributes);
      await t.shared("containers");
    }
  },
  {
    id: "agent-settle",
    title: "Answers being typed can be committed at once (settleInput)",
    features: ["AGT-03"],
    async run(t) {
      await t.load("single");
      await fcx(t, "runtimeEvents");
      await t.click({ path: "name" });
      await t.page.keyboard.type("Ada");
      await t.drawn();
      let events = (await fcx(t, "runtimeEvents", ["COMPONENT_CHANGED", "COMPONENT_COMMITTED"])).map((e) => e.type);
      t.check("AGT-03: while typing the answer is interim and nothing is committed", events.length > 0 && !events.includes("COMPONENT_COMMITTED"), events);
      await fcx(t, "settleInput");
      events = (await fcx(t, "runtimeEvents", ["COMPONENT_COMMITTED"])).map((e) => e.type);
      t.equal(events, ["COMPONENT_COMMITTED"], "AGT-03: settling commits the typed answer, without the person leaving the field");
      await t.expectFocus({ valuePath: "name", tag: "input" }, "AGT-03: and leaves focus where it was");
      await fcx(t, "settleInput");
      t.equal(await fcx(t, "runtimeEvents", ["COMPONENT_COMMITTED"]), [], "AGT-03: settling again commits nothing (the answer is no longer interim)");
      await t.key("Tab");
      t.equal(await fcx(t, "runtimeEvents", ["COMPONENT_COMMITTED"]), [], "AGT-03: leaving the field afterwards reports no second commit");
      t.equal((await t.values()).name, "Ada", "AGT-03: the answer is as typed");
    }
  },
  {
    id: "agent-reveal",
    title: "A field can be revealed and focused by id; what hides it is opened first",
    features: ["AGT-04"],
    async run(t) {
      // A step that is not the current one.
      await t.load("steps");
      t.equal(await shown(t, "city"), false, "AGT-04: (before) the field in the second step is not on show");
      const opened = await fcx(t, "focusComponent", "city");
      await t.drawn();
      t.equal(opened, true, "AGT-04: a field in another step is revealed");
      t.equal(await shown(t, "city"), true, "AGT-04: it is on show now");
      await t.expectFocus({ componentId: "city", valuePath: "city", tag: "select" }, "AGT-04: and takes focus");
      t.equal(await t.query(`[data-step-status="active"]`).then((s) => s.length), 1, "AGT-04: the step holding it is the current one");
      t.equal(await fcx(t, "focusComponent", "name"), true, "AGT-04: a field back in the first step is revealed in turn");
      await t.drawn();
      await t.expectFocus({ componentId: "name", tag: "input" }, "AGT-04: and focused");
      await t.shared("steps revealed");

      // A tab that is not the selected one.
      await t.load("coverage-tabs");
      t.equal(await shown(t, "code"), false, "AGT-04: (before) the field in the last tab is not on show");
      t.equal(await fcx(t, "focusComponent", "code"), true, "AGT-04: a field in an unselected tab is revealed");
      await t.drawn();
      t.equal(await shown(t, "code"), true, "AGT-04: it is on show now");
      await t.expectFocus({ componentId: "code", tag: "input" }, "AGT-04: and takes focus");
      const selected = await t.page.evaluate(() => {
        const out = [];
        const walk = (root) => {
          for (const el of root.querySelectorAll('[role="tab"]')) out.push([el.textContent.trim(), el.getAttribute("aria-selected")]);
          for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
        };
        walk(window.fc.hostElement().shadowRoot);
        return out;
      });
      t.equal(selected.filter(([, s]) => s === "true").map(([name]) => name), ["Extra"], "AGT-04: the tab holding it is the selected one");

      // A field no draw includes cannot be focused.
      await t.load("single");
      t.equal(await fcx(t, "focusComponent", "other"), false, "AGT-04: a field hidden by a rule is not focused");
      t.equal(await fcx(t, "focusComponent", "nowhere"), false, "AGT-04: nor an id the form does not have");
      await t.shared("tabs revealed");
    }
  },
  {
    id: "state-hooks",
    title: "Every field wrapper carries its state hooks, present when the state holds and absent when it does not",
    features: ["AGT-05"],
    async run(t) {
      const byPath = async () => Object.fromEntries((await fieldWrappers(t)).map((f) => [f["data-value-path"], f]));
      const marked = (wrapper, hook) => hook in wrapper;

      // data-kind, data-required and the rest, on the form with every kind.
      await t.load("single");
      let fields = await byPath();
      const kinds = Object.fromEntries(Object.entries(fields).map(([path, f]) => [path, f["data-kind"]]));
      t.equal(
        kinds,
        { name: "text", age: "number", start: "date", has_other: "checkbox", detail: "text", colour: "select", topics: "checkboxes", double: "number", "grid[0].when": "date", "grid[0].amount": "number", "grid[0].category": "select", receipt: "file", tabbed: "text", blurb: "html", send: "button" },
        "AGT-05: data-kind names each field's kind"
      );
      t.equal(Object.entries(fields).filter(([, f]) => marked(f, "data-required")).map(([path]) => path), ["name", "grid[0].amount"], "AGT-05: data-required is on the required fields and only those");
      t.equal(Object.values(fields).filter((f) => marked(f, "data-invalid")).length, 0, "AGT-05: data-invalid is on no field before anything is wrong");

      // A rule makes a field required: the hook follows.
      await t.click({ path: "has_other" });
      fields = await byPath();
      t.check("AGT-05: a field a rule makes required gets data-required", marked(fields.detail, "data-required") && marked(fields.other ?? {}, "data-component-id"), { detail: fields.detail, other: fields.other });
      await t.click({ path: "has_other" });
      fields = await byPath();
      t.check("AGT-05: and loses it when the rule stops", !marked(fields.detail, "data-required"), fields.detail);

      // data-invalid after a check, and gone when fixed.
      await t.validate();
      fields = await byPath();
      t.equal(Object.entries(fields).filter(([, f]) => marked(f, "data-invalid")).map(([path]) => path), ["name", "grid[0].amount"], "AGT-05: data-invalid is on the fields in error and only those");
      await t.type({ path: "name" }, "Ada");
      await t.key("Tab");
      fields = await byPath();
      t.equal(Object.entries(fields).filter(([, f]) => marked(f, "data-invalid")).map(([path]) => path), ["grid[0].amount"], "AGT-05: it goes from a field once its answer fixes the error");
      t.equal(Object.entries(fields).filter(([, f]) => marked(f, "data-readonly")).map(([path]) => path), ["double"], "AGT-05: data-readonly is only on the calculated field, read-only by itself");
      for (const hook of ["data-disabled", "data-over-limit", "data-source", "data-pending"]) {
        t.check(`AGT-05: ${hook} is on no field of this form`, !Object.values(fields).some((f) => marked(f, hook)), hook);
      }
      await t.shared("hooks on the single form");

      // data-readonly, data-disabled: by the field's own configuration (the locks form) and by the form's mode.
      await t.load("locks", { preset: { locked: "x" } });
      fields = await byPath();
      t.equal(Object.entries(fields).filter(([, f]) => marked(f, "data-readonly")).map(([path]) => path), ["locked", "memo", "ticked", "picked"], "AGT-05: data-readonly is on the read-only fields");
      t.equal(Object.entries(fields).filter(([, f]) => marked(f, "data-disabled")).map(([path]) => path), ["off"], "AGT-05: data-disabled is on the disabled field");
      await t.load("locks", { mode: "readonly" });
      fields = await byPath();
      t.check("AGT-05: a read-only form marks every field read-only and none disabled", Object.values(fields).every((f) => marked(f, "data-readonly")) && !Object.values(fields).some((f) => marked(f, "data-disabled") && f["data-component-id"] !== "off"), fields);
      await t.load("locks", { mode: "disabled" });
      fields = await byPath();
      t.check("AGT-05: a disabled form marks every field disabled", Object.values(fields).every((f) => marked(f, "data-disabled")), fields);

      // data-over-limit.
      await t.load("counts");
      await t.type({ path: "bio" }, "0123456789");
      t.check("AGT-05: data-over-limit is absent at the limit", !marked((await byPath()).bio, "data-over-limit"), (await byPath()).bio);
      await t.page.keyboard.type("x");
      await t.drawn();
      let counts = await byPath();
      t.check("AGT-05: and present over it, on that field only", marked(counts.bio, "data-over-limit") && !marked(counts.other, "data-over-limit") && !marked(counts.notes, "data-over-limit"), counts);
      await t.key("Backspace");
      t.check("AGT-05: and gone when back at the limit", !marked((await byPath()).bio, "data-over-limit"), (await byPath()).bio);

      // data-source: loading, then none; error.
      const { mountHeld } = await import("./behaviour-kit.mjs");
      await mountHeld(t, "sources", { behaviours: { recipes: ["sources"] } });
      fields = await byPath();
      t.check("AGT-05: data-source=loading on a field whose source is out, none elsewhere", fields.city["data-source"] === "loading" && fields.town["data-source"] === "loading" && !marked(fields.name, "data-source"), fields);
      await fcx(t, "release", "cities", true);
      await fcx(t, "fail", "towns", "down", true);
      await t.drawn();
      fields = await byPath();
      t.check("AGT-05: data-source is gone once the source answers and error when it fails", !marked(fields.city, "data-source") && fields.town["data-source"] === "error", fields);

      // data-pending.
      await t.load("checks", { behaviours: { recipes: ["async-email"] } });
      await fcx(t, "beginValidate");
      await until(t, async () => marked((await byPath()).email, "data-pending"));
      fields = await byPath();
      t.check("AGT-05: data-pending is on the field being checked and on no other", marked(fields.email, "data-pending") && Object.entries(fields).every(([path, f]) => path === "email" || !marked(f, "data-pending")), fields);
      await fcx(t, "release", "email");
      await fcx(t, "endValidate");
      await t.drawn();
      t.check("AGT-05: and goes when the check ends", !marked((await byPath()).email, "data-pending"), (await byPath()).email);
    }
  }
];
