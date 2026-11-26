#!/usr/bin/env node
// Probes the tester's cases do not reach, against the Alberta binding in a real browser: the
// package's tier-2 types (`goa-date-picker`, `goa-dropdown`, read as `date` and `select` through the
// kinds map), notices (Alberta's callout, never an error), pending (a word in the help text),
// the count and the notices named in the control's description, busy and pressed buttons, the
// receipt, the summary and a journey page's heading level, the date's drawn order and a grid left to
// the form. Prints PASS / FAIL lines; a FAIL is a binding bug or a contract gap, said in the message.
//   node tests/extras.mjs [--port 5410]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const at = process.argv.indexOf("--port");
const port = at >= 0 ? Number(process.argv[at + 1]) : 5410;

const built = await buildRun({ binding: join(here, "..", "src", "index.ts"), name: "alberta-extras", extraEntries: { probe: join(here, "host.ts") } });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "alberta")], builds: [built] });
const results = [];
const say = (status, id, message) => {
  results.push({ status, id, message });
  console.log(`${status.padEnd(5)} ${id.padEnd(8)} ${message}`);
};
const assets = { stylesheets: [{ url: "/node_modules/abgov-web-components-3.2.0/index.css" }], scripts: [{ url: "/node_modules/abgov-web-components-3.2.0/index.js" }] };

const form = (content, extra = {}) => ({ id: "x" + Math.random().toString(36).slice(2, 6), version: "1.0.0", schemaVersion: "1", localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] }, root: { id: "root", type: "form", configuration: {}, children: { content } }, ...extra });

async function open() {
  const page = await browser.open("/binding-check.html");
  await page.waitForFunction("window.bindingCheckReady === true", undefined, { timeout: 30000 });
  await page.evaluate(`(async () => { window.__host = await import(${JSON.stringify(built.urlOf("probe"))}); window.__binding = (await import(${JSON.stringify(built.bindingUrl)})); })()`);
  return {
    page,
    ev: (expr) => page.evaluate(expr),
    async mount(options) {
      const payload = JSON.stringify({ ...options, assets: options.assets === false ? undefined : assets });
      await page.evaluate(`(async () => { const o = ${payload}; o.binding = window.__binding.createBinding(window.__host.lit, window.__host.datum); await window.__host.mountProbe(o); })()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    close: () => page.close()
  };
}
const wrap = (id) => `__probe.root.querySelector('.datum-live-field[data-component-id="${id}"]')`;

async function probe(id, run) {
  let p;
  try {
    p = await open();
    await run(p);
  } catch (error) {
    say("FAIL", id, `probe error: ${String(error.message ?? error).split("\n")[0]}`);
  } finally {
    try {
      await p?.close();
    } catch {}
  }
}

try {
  // ── 1. goa-date-picker: the official component under its own type, read as `date` ─────────
  await probe("PL-01", async (p) => {
    const def = form([{ id: "start", type: "goa-date-picker", configuration: { label: "Start date", required: true } }], { kinds: { "goa-date-picker": "date" } });
    await p.mount({ definition: def, binding: null });
    const drawn = await p.ev(`!!${wrap("start")}?.querySelector('goa-date-picker')`);
    say(drawn ? "PASS" : "FAIL", "PL-01a", drawn ? "goa-date-picker draws the official <goa-date-picker type=input>" : "goa-date-picker did not draw");
    await p.ev(`__probe.runtime.setValue("start", "2026-05-14")`);
    await p.sleep(500);
    const shown = await p.ev(`(() => { const dp = ${wrap("start")}.querySelector("goa-date-picker"); return dp.value ?? null; })()`);
    say(shown === "2026-05-14" ? "PASS" : "FAIL", "PL-01b", `a written date shows in the picker (value ${JSON.stringify(shown)})`);
    // The picker's inner controls say their parts with `_change`: the adapter hears them in capture and reports the three parts.
    await p.ev(`__probe.runtime.setValue("start", "")`);
    await p.sleep(400);
    await p.ev(`(() => {
      const dp = ${wrap("start")}.querySelector("goa-date-picker");
      const root = dp.shadowRoot;
      const part = (tag, name) => [...root.querySelectorAll(tag)].find((e) => e.name === name);
      const say = (el, name, value) => el.dispatchEvent(new CustomEvent("_change", { bubbles: true, composed: true, detail: { name, value } }));
      const inputOf = (el, value) => { const box = el.shadowRoot.querySelector("input"); box.value = value; };
      inputOf(part("goa-input", "day"), "14"); say(part("goa-input", "day"), "day", "14");
      inputOf(part("goa-input", "year"), "2026"); say(part("goa-input", "year"), "year", "2026");
      part("goa-dropdown", "month").value = "5"; say(part("goa-dropdown", "month"), "month", "5");
    })()`);
    await p.sleep(500);
    const values = await p.ev(`JSON.stringify(__probe.runtime.state().values)`);
    say(values.includes("2026-05-14") ? "PASS" : "FAIL", "PL-01c", `the three parts compose the answer: ${values}`);
  });

  // ── 2. goa-dropdown: the component's own listbox under its own type, read as `select` ─────
  await probe("PL-02", async (p) => {
    const def = form([{ id: "prov", type: "goa-dropdown", configuration: { label: "Province", options: [{ value: "AB", label: "Alberta" }, { value: "BC", label: "BC" }] } }], { kinds: { "goa-dropdown": "select" } });
    await p.mount({ definition: def, binding: null });
    const native = await p.ev(`${wrap("prov")}?.querySelector('goa-dropdown')?.getAttribute('native')`);
    const hasSelect = await p.ev(`!!${wrap("prov")}?.querySelector('goa-dropdown')?.shadowRoot?.querySelector('select')`);
    say(native === "false" && !hasSelect ? "PASS" : "FAIL", "PL-02a", `goa-dropdown draws its own listbox (native=${native}, a <select> inside: ${hasSelect})`);
    await p.ev(`${wrap("prov")}.querySelector('goa-dropdown').dispatchEvent(new CustomEvent("_change", { bubbles: true, composed: true, detail: { name: "x", value: "BC" } }))`);
    await p.sleep(300);
    const values = await p.ev(`JSON.stringify(__probe.runtime.state().values)`);
    say(values.includes('"BC"') ? "PASS" : "FAIL", "PL-02b", `a choice reaches the answer: ${values}`);
  });

  // ── 3. notices: a callout, never an error, named in the control's description ──────────
  await probe("NT", async (p) => {
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    const def = form([
      { id: "nick", type: "text", configuration: { label: "Nickname", description: "What friends call you", characterCount: true, maxLength: 20 } },
      { id: "age", type: "number", configuration: { label: "Age" } },
      { id: "area", type: "textarea", configuration: { label: "Area" } },
      { id: "pick", type: "select", configuration: { label: "Pick", options } },
      { id: "way", type: "radio", configuration: { label: "Way", options } },
      { id: "boxes", type: "checkboxes", configuration: { label: "Boxes", options } },
      { id: "when", type: "date", configuration: { label: "When" } },
      { id: "agree", type: "checkbox", configuration: { label: "I agree" } }
    ]);
    await p.mount({ definition: def, binding: null, stages: ["advice:warning:nick", "advice:info:age", "advice:warning:area", "advice:info:pick", "advice:warning:way", "advice:warning:boxes", "advice:warning:when", "advice:warning:agree"] });
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(700);
    for (const id of ["nick", "age", "area", "pick", "way", "boxes", "when", "agree"]) {
      const info = JSON.parse(await p.ev(`(() => {
        const w = ${wrap(id)};
        const block = w.querySelector("[data-notices]");
        const callout = block?.querySelector("goa-callout");
        const deep = (root, sel, out = []) => { for (const el of root.querySelectorAll("*")) { if (el.matches(sel)) out.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, out); } return out; };
        const controls = [...deep(w, "input, textarea, select, fieldset, [role=radiogroup], [role=group]")];
        const described = controls.find((c) => [...(c.ariaDescribedByElements ?? [])].includes(block) || (c.getAttribute("aria-describedby") ?? "").split(" ").includes(block?.id));
        return JSON.stringify({ callout: callout?.getAttribute("type") ?? null, text: callout?.textContent.trim() ?? null, invalid: w.hasAttribute("data-invalid"), described: !!described, error: callout?.getAttribute("type") === "emergency" });
      })()`));
      const warning = id === "age" || id === "pick" ? "information" : "important";
      const ok = info.callout === warning && /^(Warning|Information|Info)/i.test(info.text ?? "") && !info.invalid && !info.error && info.described;
      say(ok ? "PASS" : "FAIL", `NT-${id}`, JSON.stringify(info));
    }
    const count = JSON.parse(await p.ev(`(() => { const w = ${wrap("nick")}; const count = w.querySelector(".datum-goa-count [id]"); const box = w.querySelector("goa-input").shadowRoot.querySelector("input"); return JSON.stringify({ id: count?.id ?? null, described: [...(box.ariaDescribedByElements ?? [])].includes(count) }); })()`));
    say(count.described ? "PASS" : "FAIL", "NT-count", `the count's limit sentence describes the box: ${JSON.stringify(count)}`);
  });

  // ── 3b. a choice settles the answer: a required group's error goes on the click, before focus leaves ──
  await probe("CM", async (p) => {
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    const def = form([
      { id: "way", type: "radio", configuration: { label: "Way", required: true, options } },
      { id: "boxes", type: "checkboxes", configuration: { label: "Boxes", required: true, options } }
    ]);
    await p.mount({ definition: def, binding: null });
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(500);
    for (const [id, item] of [["way", "goa-radio-item"], ["boxes", "goa-checkbox"]]) {
      const before = await p.ev(`${wrap(id)}.hasAttribute("data-invalid")`);
      await p.ev(`${wrap(id)}.querySelectorAll("${item}")[1].shadowRoot.querySelector("input").click()`);
      await p.sleep(500);
      const after = JSON.parse(await p.ev(`JSON.stringify({ value: __probe.runtime.state().values[${JSON.stringify(id)}] ?? null, invalid: ${wrap(id)}.hasAttribute("data-invalid") })`));
      say(before && !after.invalid ? "PASS" : "FAIL", `CM-${id}`, `invalid before the click ${before}; after a valid click, focus still on the option: ${JSON.stringify(after)}`);
    }
  });

  // ── 4. pending: degraded, a word in the help text while the async check runs ───────────
  await probe("PD", async (p) => {
    const def = form([{ id: "nick", type: "text", configuration: { label: "Nickname" } }]);
    await p.mount({ definition: def, binding: null, stages: ["remote:nick"] });
    await p.ev(`void __probe.runtime.validate()`);
    await p.sleep(500);
    const state = JSON.parse(await p.ev(`JSON.stringify({ pending: ${wrap("nick")}.hasAttribute("data-pending"), busy: ${wrap("nick")}.getAttribute("aria-busy"), help: ${wrap("nick")}.querySelector("goa-form-item").getAttribute("helptext") })`));
    say(state.pending && state.busy === "true" && /Checking/.test(state.help ?? "") ? "PASS" : "FAIL", "PD-01", `pending field: ${JSON.stringify(state)}`);
    await p.ev(`window.__host.answerPending()`);
    await p.sleep(500);
    const after = JSON.parse(await p.ev(`JSON.stringify({ pending: ${wrap("nick")}.hasAttribute("data-pending"), help: ${wrap("nick")}.querySelector("goa-form-item").getAttribute("helptext") })`));
    say(!after.pending && !after.help ? "PASS" : "FAIL", "PD-02", `answered: ${JSON.stringify(after)}`);
  });

  // ── 5. buttons: a press, and a busy form ────────────────────────────────────────────────
  await probe("BT", async (p) => {
    const def = form([{ id: "go", type: "button", configuration: { label: "Send", action: "submit", variant: "primary" } }]);
    await p.mount({ definition: def, binding: null });
    await p.ev(`${wrap("go")}.querySelector("goa-button").shadowRoot.querySelector("button").click()`);
    await p.sleep(200);
    const events = JSON.parse(await p.ev(`JSON.stringify(__probe.events)`));
    const ev = events.find((e) => e.type === "datum-form-action");
    say(ev?.detail?.action === "submit" ? "PASS" : "FAIL", "BT-01", `a press on a goa-button reports ${JSON.stringify(ev?.detail)}`);
  });

  // ── 6. the date's drawn order, and a summary link to a date with only a year ───────────────
  await probe("DO", async (p) => {
    const def = form([{ id: "when", type: "date", configuration: { label: "When", required: true } }]);
    await p.mount({ definition: def, binding: null });
    const order = JSON.parse(await p.ev(`JSON.stringify([...${wrap("when")}.querySelectorAll("[data-value-part]")].map((e) => e.dataset.valuePart))`));
    say(order.join() === "month,day,year" ? "PASS" : "FAIL", "DO-01", `order drawn: ${order}`);
    await p.page.locator('[data-component-id=when] goa-input[data-value-part=year] input').fill("2026");
    await p.sleep(300);
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(500);
    await p.ev(`__probe.root.querySelector("goa-callout a").click()`);
    await p.sleep(300);
    const active = await p.ev(`(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; const host = a?.getRootNode().host; return JSON.stringify({ tag: a?.localName, part: host?.dataset?.valuePart ?? null }); })()`);
    say(JSON.parse(active).part === "month" ? "PASS" : "FAIL", "DO-02", `a summary link for a date with only the year goes to ${active} (the first part lacking in the order drawn is the month)`);
  });

  // ── 7. the receipt and the summary: goa-callout, the kind said once ───────────────────────
  await probe("RC", async (p) => {
    const def = form([{ id: "name", type: "text", configuration: { label: "Name", required: true } }]);
    await p.mount({ definition: def, binding: null, notice: { kind: "success", title: "Thanks", message: "We have your answers.", details: [{ label: "Reference", value: "A-123" }] } });
    const read = JSON.parse(await p.ev(`(() => { const r = __probe.root.querySelector(".datum-goa-receipt"); const c = r?.querySelector("goa-callout"); return JSON.stringify({ type: c?.getAttribute("type") ?? null, heading: c?.getAttribute("heading") ?? null, word: r?.querySelector(".datum-goa-sr-only")?.textContent.trim() ?? null, role: r?.getAttribute("role") ?? null, details: r?.querySelector("dd")?.textContent ?? null }); })()`));
    say(read.type === "success" && read.heading === "Thanks" && /Success/.test(read.word ?? "") && read.role === "status" && read.details === "A-123" ? "PASS" : "FAIL", "RC-01", `receipt: ${JSON.stringify(read)}`);
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(500);
    const summary = JSON.parse(await p.ev(`(() => { const c = __probe.root.querySelector("goa-callout[role=alert]"); return JSON.stringify({ type: c?.getAttribute("type") ?? null, heading: c?.getAttribute("heading") ?? null, label: c?.getAttribute("aria-label") ?? null, links: c?.querySelectorAll("a").length ?? 0 }); })()`));
    say(summary.type === "emergency" && summary.heading === "There is a problem" && summary.label === "There is a problem" && summary.links === 1 ? "PASS" : "FAIL", "RC-02", `summary: ${JSON.stringify(summary)}`);
  });

  // ── 8. a grid left to the form is drawn stacked (cells keep their labels); an explicit table is goa-table ─────
  await probe("GT", async (p) => {
    const cell = [{ id: "item", type: "text", configuration: { label: "Item" } }];
    const def = form([
      { id: "auto", type: "dataGrid", configuration: { label: "Auto", initialRows: 1 }, children: { content: cell } },
      { id: "fixed", type: "dataGrid", configuration: { label: "Fixed", initialRows: 1, layout: "table" }, children: { content: [{ id: "item2", type: "text", configuration: { label: "Item two" } }] } }
    ]);
    await p.mount({ definition: def, binding: null });
    const r = JSON.parse(await p.ev(`(() => { const root = __probe.root; const cellOf = (id) => root.querySelector('.datum-live-field[data-component-id="' + id + '"] goa-form-item'); return JSON.stringify({ tables: root.querySelectorAll("goa-table").length, autoLabel: cellOf("item")?.getAttribute("label"), fixedLabel: cellOf("item2")?.getAttribute("label") }); })()`));
    say(r.tables === 1 && r.autoLabel === "Item" && r.fixedLabel === "" ? "PASS" : "FAIL", "GT-01", JSON.stringify(r));
  });

  // ── 9. read-only: the dropdown, radios and checkboxes refuse a change; the date's controls are read-only ───────
  await probe("RO", async (p) => {
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    const def = form([
      { id: "pick", type: "goa-dropdown", configuration: { label: "Pick", readOnly: true, options } },
      { id: "way", type: "radio", configuration: { label: "Way", readOnly: true, options } },
      { id: "when", type: "date", configuration: { label: "When", readOnly: true } }
    ], { kinds: { "goa-dropdown": "select" } });
    await p.mount({ definition: def, binding: null });
    await p.ev(`${wrap("pick")}.querySelector("goa-dropdown").dispatchEvent(new CustomEvent("_change", { bubbles: true, composed: true, detail: { name: "x", value: "b" } }))`);
    await p.ev(`${wrap("way")}.querySelector("goa-radio-item").shadowRoot.querySelector("input").click()`);
    await p.sleep(300);
    const values = await p.ev(`JSON.stringify(__probe.runtime.state().values)`);
    const dayReadonly = await p.ev(`${wrap("when")}.querySelector("goa-input[data-value-part=day]").getAttribute("readonly")`);
    say(!values.includes('"b"') && dayReadonly === "true" ? "PASS" : "FAIL", "RO-01", `values after a refused change: ${values}; the day box readonly=${dayReadonly}`);
  });
} finally {
  await browser.close();
  built.dispose();
}

const failed = results.filter((r) => r.status === "FAIL");
console.log(`\nalberta extras: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exitCode = failed.length === 0 ? 0 : 1;
