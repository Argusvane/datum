// Browser checks for what the binding-check tester does not assert and the Ontario binding does:
// notices drawn as Ontario's callout (never as errors), what describes a box (the hint, the notices,
// the count, the error: Ontario's components cannot name them, the binding does it by element
// reflection), aria-invalid (no Ontario component writes it), the number's text box, an option's
// help and a field's tooltip as Ontario's hint expander, a group's hint and a grid's error describing the
// fieldset inside ontario-fieldset, focus kept on a row button and sent to Add (the ontario-button host
// forwards focus()), Datum's date in Ontario's HTML and the official date under its own type, steps
// driven by ontario-button and the stepper. Real headless Chromium over the tester's own
// Playwright driver, host page and build (packages/conformance-suite/binding-check).
//   node bindings/ontario/tests/checks.mjs [--port 5440] [--shots <dir>]
// Exit 0 when every check passes, 1 when one fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, form, openCase, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "5440"));
const shots = option("--shots", undefined);
if (shots) mkdirSync(shots, { recursive: true });

const assetsDoc = JSON.parse(readFileSync(join(repo, "bindings", "ontario", "binding-check.json"), "utf8"));
const source = (item) => (typeof item === "string" ? { url: item } : item);
const assets = { stylesheets: assetsDoc.stylesheets.map(source), scripts: assetsDoc.scripts.map(source) };

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, message: String(error.message ?? error) });
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split("\n")[0]}`);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const eq = (actual, expected, what) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const built = await buildRun({ binding: join(here, "..", "src", "binding.ts"), name: "ontario-checks" });
// The official date lives in the package's plugin: the same binding with the plugin's adapter laid over it, as a host that registered the plugin has.
const withPlugin = await buildRun({ binding: join(here, "official-date", "plugin-binding.ts"), name: "ontario-plugin-checks" });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "ontario")], builds: [built, withPlugin] });
const open = (extra = {}) => openCase(browser, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, assets, ...extra });
const openPlugin = () => openCase(browser, { hostUrl: withPlugin.hostUrl, bindingUrl: withPlugin.bindingUrl, assets });
const mountDefinition = (c, definition, options = {}) => c.page.evaluate(`bc.mount(${JSON.stringify({ definition, assets: options.assets, locale: options.locale })})`);
const shot = async (c, name) => {
  if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from(await c.shot(), "base64"));
};

try {
  // ── Notices: Ontario's callout, never an error ──────────────────────────────────────────────
  await check("notices: a warning and an info message draw as callouts (yellow, teal) with the severity word, never as errors", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.runtimeCall("setErrors", [
      { code: "short", componentId: "name", path: "name", severity: "warning", message: "That is short." },
      { code: "kept", componentId: "name", path: "name", severity: "info", message: "We keep it for a year." }
    ])`);
    await c.settle(300);
    const read = await c.ev(`(() => {
      const w = bc.field("name");
      const text = (el) => el?.textContent.replace(/\\s+/g, " ").trim() ?? null;
      const box = bc.controlsOf("name")[0];
      return {
        callouts: [...w.querySelectorAll("ontario-callout")].map((el) => [el.getAttribute("highlight-colour"), text(el)]),
        errorLine: !!w.querySelector("ontario-input")?.shadowRoot?.querySelector(".ontario-error-messaging:not(.ontario-error__hidden)"),
        ariaInvalid: box.hasAttribute("aria-invalid"),
        invalidHook: w.hasAttribute("data-invalid"),
        described: bc.descriptions("name").map((d) => d.text),
        alert: bc.descriptions("name").some((d) => d.alert),
        summary: !!bc.root().querySelector("ontario-page-alert")
      };
    })()`);
    eq(read.callouts.map(([colour]) => colour), ["yellow", "teal"], "callout colours");
    assert(read.callouts[0][1].startsWith("Warning") && read.callouts[0][1].includes("That is short."), `warning: "${read.callouts[0][1]}"`);
    assert(read.callouts[1][1].startsWith("Information") && read.callouts[1][1].includes("We keep it for a year."), `info: "${read.callouts[1][1]}"`);
    assert(!read.errorLine && !read.ariaInvalid && !read.invalidHook, "a notice is drawn or marked as an error");
    assert(read.described.some((t) => t.includes("That is short.")) && read.described.some((t) => t.includes("We keep it for a year.")), `the box is not described by the notices (${JSON.stringify(read.described)})`);
    assert(!read.alert, "a notice is announced as an alert");
    assert(!read.summary, "a notice reached the error summary");
    await shot(c, "notices");
    c.page.close();
  });

  await check("errors: the box is aria-invalid and described by the error line; both go when the answer is right", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    await c.settle(300);
    const wrong = await c.ev(`(() => ({ invalid: bc.controlsOf("name")[0].getAttribute("aria-invalid"), described: bc.descriptions("name").map((d) => d.text) }))()`);
    eq(wrong.invalid, "true", "aria-invalid on the box");
    assert(wrong.described.some((t) => t.includes("This is a required field.")), `the error does not describe the box: ${JSON.stringify(wrong.described)}`);
    await c.typeInto("name", "Ada");
    await c.validate();
    await c.settle(300);
    const right = await c.ev(`(() => ({ invalid: bc.controlsOf("name")[0].hasAttribute("aria-invalid"), described: bc.descriptions("name").map((d) => d.text) }))()`);
    assert(!right.invalid, "aria-invalid is still on the box");
    assert(!right.described.some((t) => t.includes("required field")), `the error still describes the box: ${JSON.stringify(right.described)}`);
    c.page.close();
  });

  await check("hint: the visible hint is Ontario's, and the box is described by the same words (the hint's own id names nothing across shadow roots)", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "n", type: "text", configuration: { label: "Name", description: "As on your passport." } }, { id: "r", type: "radio", configuration: { label: "Pick", description: "Choose one.", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }]));
    await c.settle(400);
    const read = await c.ev(`(() => ({
      drawn: bc.field("n").querySelector("ontario-input").shadowRoot.querySelector("ontario-hint-text").shadowRoot.textContent.trim(),
      text: bc.descriptions("n").map((d) => d.text),
      group: bc.descriptions("r").map((d) => d.text)
    }))()`);
    eq(read.drawn, "As on your passport.", "Ontario's hint");
    assert(read.text.includes("As on your passport."), `the text box is not described by its hint: ${JSON.stringify(read.text)}`);
    assert(read.group.includes("Choose one."), `the radio group is not described by its hint: ${JSON.stringify(read.group)}`);
    c.page.close();
  });

  await check("tooltip: the component's own hint expander opens the help, and the box is described by its words after the hint", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "n", type: "text", configuration: { label: "Name", description: "As on your passport.", tooltip: "Your full legal name." } }, { id: "r", type: "radio", configuration: { label: "Pick", tooltip: "Any will do.", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }]));
    await c.settle(500);
    const read = await c.ev(`(() => {
      const expander = (id, tag) => bc.field(id).querySelector(tag).shadowRoot.querySelector("ontario-hint-expander");
      const e = expander("n", "ontario-input");
      return {
        content: e?.shadowRoot?.querySelector(".ontario-hint-expander__content")?.textContent.trim() ?? null,
        opener: e?.shadowRoot?.querySelector("button")?.textContent.trim() ?? null,
        radio: expander("r", "ontario-radio-buttons")?.shadowRoot?.querySelector(".ontario-hint-expander__content")?.textContent.trim() ?? null,
        text: bc.descriptions("n").map((d) => d.text),
        group: bc.descriptions("r").map((d) => d.text),
        unsupported: bc.unsupported()
      };
    })()`);
    eq(read.content, "Your full legal name.", "the expander's content");
    eq(read.opener, "Help", "the expander opens by the help word");
    eq(read.radio, "Any will do.", "the radio group's expander");
    assert(read.text.indexOf("As on your passport.") >= 0 && read.text.indexOf("Your full legal name.") > read.text.indexOf("As on your passport."), `the box is described by the hint, then the tooltip: ${JSON.stringify(read.text)}`);
    assert(read.group.includes("Any will do."), `the radio group is described by its tooltip: ${JSON.stringify(read.group)}`);
    assert(!read.unsupported.some((u) => u.endsWith(": tooltip")), `a drawn tooltip is not unsupported: ${JSON.stringify(read.unsupported)}`);
    await shot(c, "tooltip-expander");
    c.page.close();
  });

  await check("group: a fieldset's hint and a grid's error describe the fieldset inside ontario-fieldset (its shadow root), by element reflection", async () => {
    const c = await open();
    await mountDefinition(c, form([
      { id: "address", type: "fieldset", configuration: { label: "Address", description: "Where you live." }, children: { content: [{ id: "street", type: "text", configuration: { label: "Street" } }] } },
      { id: "lines", type: "dataGrid", configuration: { label: "Items", description: "At least one.", required: true, initialRows: 0 }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }] } }
    ]));
    await c.settle(500);
    await c.ev(`bc.startValidation()`);
    await c.settle(700);
    const read = await c.ev(`(() => {
      const describedBy = (legend) => {
        const host = [...bc.root().querySelectorAll("ontario-fieldset")].find((el) => el.getAttribute("legend") === legend);
        const box = host?.shadowRoot?.querySelector("fieldset");
        return [...(box?.ariaDescribedByElements ?? [])].map((el) => el.textContent.replace(/\\s+/g, " ").trim());
      };
      return { group: describedBy("Address"), grid: describedBy("Items") };
    })()`);
    eq(read.group, ["Where you live."], "the group's fieldset is described by its hint");
    assert(read.grid[0] === "At least one." && read.grid.length === 2 && read.grid[1].length > 0, `the grid's fieldset is described by its hint, then its error: ${JSON.stringify(read.grid)}`);
    c.page.close();
  });

  await check("grid focus: Remove on the last row leaves focus on Add, and Move keeps it on the moved row's button (the ontario-button host sends focus() inside)", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "lines", type: "dataGrid", configuration: { label: "Items", initialRows: 3, minRows: 0, maxRows: 3, canReorder: true }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }] } }]));
    await c.settle(600);
    const focused = `(() => { const a = bc.root().activeElement; return a ? { tag: a.localName, id: a.id || null, action: a.getAttribute("data-row-action"), label: a.getAttribute("aria-label-text"), inner: a.shadowRoot?.activeElement?.localName ?? null } : null; })()`;
    const button = (action, index) => `[...bc.root().querySelectorAll('ontario-button[data-row-action="${action}"]')][${index}]`;
    await c.click(button("down", 0), "the first Move down");
    await c.settle(500);
    const moved = await c.ev(focused);
    assert(moved?.tag === "ontario-button" && moved.action === "down" && moved.inner === "button", `after Move down, focus is not on a row's Move button: ${JSON.stringify(moved)}`);
    assert(/2$/.test(moved.label ?? ""), `focus stays with the moved row (now row 2): ${JSON.stringify(moved)}`);
    for (const left of [2, 1]) {
      await c.click(button("remove", left), `Remove on row ${left + 1}`);
      await c.settle(500);
    }
    await c.click(button("remove", 0), "the last Remove");
    await c.settle(600);
    const after = await c.ev(focused);
    assert(after?.tag === "ontario-button" && after.id === "lines__add" && after.inner === "button", `after removing the last row, focus is not on Add: ${JSON.stringify(after)}`);
    eq(await c.ev(`document.activeElement === document.body`), false, "focus fell to the body");
    c.page.close();
  });

  await check("count: the figure is Ontario's hint, the limit sentence describes the box, over the limit the figure is the error colour", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "bio", type: "textarea", configuration: { label: "About you", maxLength: 10, characterCount: true } }]));
    await c.settle(300);
    await c.typeInto("bio", "twelve chars");
    await c.settle(300);
    const read = await c.ev(`(() => {
      const w = bc.field("bio");
      const count = w.querySelector(".datum-ontario-count");
      return {
        figure: count?.querySelector("ontario-hint-text")?.getAttribute("hint"),
        over: count?.classList.contains("datum-ontario-count--over"),
        color: getComputedStyle(count.querySelector("ontario-hint-text").shadowRoot.querySelector("p")).color,
        described: bc.descriptions("bio").map((d) => d.text)
      };
    })()`);
    assert(/over limit/.test(read.figure ?? ""), `figure: "${read.figure}"`);
    assert(read.over, "the over-limit mark is missing");
    assert(read.color === "rgb(216, 26, 33)", `over-limit colour ${read.color}`);
    assert(read.described.some((t) => /up to 10 characters/.test(t)), `the limit sentence does not describe the box: ${JSON.stringify(read.described)}`);
    c.page.close();
  });

  // ── Number ───────────────────────────────────────────────────────────────────────────────────
  await check("number: a text box with a numeric keyboard that stores a number and keeps what was typed", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "age", type: "number", configuration: { label: "Age", step: 1 } }]));
    await c.settle(300);
    await c.typeInto("age", "0042");
    await c.settle(300);
    const read = await c.ev(`(() => { const box = bc.controlsOf("age")[0]; return { type: box.type, mode: box.getAttribute("inputmode"), shown: box.value }; })()`);
    eq(read.type, "text", "box type");
    eq(read.mode, "numeric", "inputmode");
    eq(read.shown, "0042", "what was typed stays");
    eq((await c.values()).age, 42, "stored number");
    c.page.close();
  });

  // ── Choices ──────────────────────────────────────────────────────────────────────────────────
  await check("radios: an option's help is Ontario's hint expander on the option, and a one-option group still draws", async () => {
    const c = await open();
    await mountDefinition(c, form([
      { id: "r", type: "radio", configuration: { label: "Contact", options: [{ value: "e", label: "Email", description: "Within a day" }, { value: "p", label: "Phone" }] } },
      { id: "one", type: "checkboxes", configuration: { label: "Agree", options: [{ value: "y", label: "Yes" }] } }
    ]));
    await c.settle(500);
    const read = await c.ev(`(() => {
      const expanders = [...bc.field("r").querySelector("ontario-radio-buttons").shadowRoot.querySelectorAll("ontario-hint-expander")];
      return { expanders: expanders.length, content: expanders[0]?.content, inputs: bc.field("one").querySelector("ontario-checkboxes").shadowRoot.querySelectorAll("input[type=checkbox]").length };
    })()`);
    eq(read.expanders, 1, "hint expanders");
    eq(read.content, "Within a day", "expander content");
    eq(read.inputs, 1, "checkboxes drawn for one option");
    c.page.close();
  });

  // ── Dates ────────────────────────────────────────────────────────────────────────────────────
  await check("date (tier 2): Datum's date in Ontario's markup, year / month / day, parts typed compose, an error marks the boxes", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    await c.settle(300);
    const order = await c.ev(`[...bc.field("start").querySelectorAll("[data-value-part]")].map((b) => b.dataset.valuePart)`);
    eq(order, ["year", "month", "day"], "part order");
    const marked = await c.ev(`[...bc.field("start").querySelectorAll("[data-value-part]")].map((b) => b.getAttribute("aria-invalid"))`);
    eq(marked, ["true", "true", "true"], "aria-invalid on the parts");
    assert(!(await c.ev(`!!bc.field("start").querySelector("ontario-date-input")`)), "the official component draws the main date type");
    await c.typeInto("start", "2026", { which: 0 });
    await c.typeInto("start", "5", { which: 1 });
    await c.typeInto("start", "14", { which: 2 });
    await c.settle(300);
    eq((await c.values()).start, "2026-05-14", "composed date");
    c.page.close();
  });

  await check("ontario-date (plugin type, base date): the official component draws it, its own checks are off, Datum's error shows beside it", async () => {
    const c = await openPlugin();
    await mountDefinition(c, form([{ id: "start", type: "ontario-date", configuration: { label: "Start date", required: true } }], { kinds: { "ontario-date": "date" } }));
    await c.settle(500);
    assert(await c.ev(`!!bc.field("start").querySelector("ontario-date-input")`), "ontario-date-input is not drawn");
    await c.ev(`bc.validate()`);
    await c.settle(400);
    const read = await c.ev(`(() => {
      const w = bc.field("start");
      const host = w.querySelector("ontario-date-input");
      return {
        own: !!host.shadowRoot.querySelector(".ontario-error-messaging:not(.ontario-error__hidden)"),
        beside: w.querySelector(".datum-ontario-error__content")?.textContent.trim() ?? null,
        invalid: [...host.shadowRoot.querySelectorAll("input")].every((i) => i.getAttribute("aria-invalid") === "true" && i.classList.contains("datum-ontario-invalid"))
      };
    })()`);
    assert(!read.own, "the component raised an error of its own");
    eq(read.beside, "This is a required field.", "Datum's error beside the component");
    assert(read.invalid, "the parts are not marked invalid");
    await c.typeInto("start", "2026", { which: 0 });
    await c.typeInto("start", "5", { which: 1 });
    await c.typeInto("start", "14", { which: 2 });
    await c.settle(400);
    eq((await c.values()).start, "2026-05-14", "composed date");
    c.page.close();
  });

  // ── Steps ────────────────────────────────────────────────────────────────────────────────────
  await check("steps: the stepper and a heading lead each panel, Continue and Back are ontario-buttons that move between them", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "wiz", type: "steps", configuration: { label: "Application" }, children: { content: [
      { id: "s1", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
      { id: "s2", type: "step", configuration: { label: "Where" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } }
    ] } }]));
    await c.settle(500);
    const first = await c.ev(`(() => {
      const shown = [...bc.root().querySelectorAll("[data-step-panel]")].find((p) => !p.hidden);
      return { current: shown.querySelector("ontario-step-indicator").getAttribute("current-step"), heading: shown.querySelector("h2, h3")?.textContent.trim(), buttons: [...bc.root().querySelectorAll("ontario-button")].map((b) => b.getAttribute("label")) };
    })()`);
    eq(first.current, "1", "step shown first");
    eq(first.heading, "About you", "heading");
    eq(first.buttons, ["Continue"], "buttons on the first step");
    await shot(c, "steps-first");
    await c.click(`bc.root().querySelector("ontario-button[data-step-next]")`, "Continue");
    await c.settle(500);
    const second = await c.ev(`(() => {
      const shown = [...bc.root().querySelectorAll("[data-step-panel]")].find((p) => !p.hidden);
      return { current: shown.querySelector("ontario-step-indicator").getAttribute("current-step"), heading: shown.querySelector("h2, h3")?.textContent.trim(), focused: bc.active().desc, buttons: [...bc.root().querySelectorAll("ontario-button")].map((b) => b.getAttribute("label")) };
    })()`);
    eq(second.current, "2", "step shown second");
    eq(second.heading, "Where", "heading");
    assert(second.buttons.includes("Back"), `no Back on the second step: ${JSON.stringify(second.buttons)}`);
    await c.click(`bc.root().querySelector("ontario-button[data-step-prev]")`, "Back");
    await c.settle(400);
    eq(await c.ev(`[...bc.root().querySelectorAll("[data-step-panel]")].find((p) => !p.hidden).querySelector("ontario-step-indicator").getAttribute("current-step")`), "1", "back to step one");
    c.page.close();
  });
} finally {
  await browser.close?.();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nontario checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
