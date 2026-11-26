#!/usr/bin/env node
// Probes the tester's cases do not reach, against the Québec binding in a real browser: the package's
// tier-2 type (`qc-select`, read as `select` through the kinds map), notices (qc-notice, never an error,
// named in the description), pending (a word in the description), the count's limit sentence, the
// summary and the receipt (qc-notice, the heading level and the kind word), a summary link to a date, a
// grid stacked, the French pack, and read-only on the official listbox. Prints PASS / FAIL lines; a FAIL
// is a binding bug or a contract gap, said in the message.
//   node tests/extras.mjs [--port 5430]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const at = process.argv.indexOf("--port");
const port = at >= 0 ? Number(process.argv[at + 1]) : 5430;

const built = await buildRun({ binding: join(here, "..", "src", "index.ts"), name: "quebec-extras", extraEntries: { probe: join(here, "host.ts") } });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "quebec")], builds: [built] });
const results = [];
const say = (status, id, message) => {
  results.push({ status, id, message });
  console.log(`${status.padEnd(5)} ${id.padEnd(8)} ${message}`);
};
const SHEET = "/node_modules/qc-trousse-sdg-1.6.1/dist/css/qc-sdg-rfz100.min.css";
const assets = {
  stylesheets: [{ url: SHEET }],
  scripts: [{ url: "/node_modules/qc-trousse-sdg-1.6.1/dist/js/qc-sdg.min.js", classic: true, attributes: { "sdg-css-path": SHEET, "sdg-assets-base-path": "/node_modules/qc-trousse-sdg-1.6.1/dist" } }]
};

const form = (content, extra = {}) => ({ id: "x" + Math.random().toString(36).slice(2, 6), version: "1.0.0", schemaVersion: "1", localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }, root: { id: "root", type: "form", configuration: {}, children: { content } }, ...extra });

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
    validate: async () => {
      await page.evaluate(`__probe.runtime.validate().then(() => __probe.form.updated())`);
      await new Promise((resolve) => setTimeout(resolve, 700));
    },
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
  // ── 1. qc-select: the official listbox under its own type, read as `select` ─────────────
  await probe("PL-01", async (p) => {
    const options = [{ value: "qc", label: "Québec" }, { value: "on", label: "Ontario" }];
    const def = form([{ id: "prov", type: "qc-select", configuration: { label: "Province", options } }], { kinds: { "qc-select": "select" } });
    await p.mount({ definition: def, binding: null });
    const drawn = await p.ev(`!!${wrap("prov")}?.querySelector('qc-select')`);
    say(drawn ? "PASS" : "FAIL", "PL-01a", drawn ? "qc-select draws the official <qc-select>" : "qc-select did not draw");
    await p.ev(`(() => { const s = ${wrap("prov")}.querySelector("qc-select > select"); s.value = "on"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await p.sleep(400);
    const values = await p.ev(`JSON.stringify(__probe.runtime.state().values)`);
    say(values.includes('"on"') ? "PASS" : "FAIL", "PL-01b", `a choice reaches the answer: ${values}`);
    await p.ev(`__probe.runtime.setValue("prov", "qc")`);
    await p.sleep(500);
    const shown = await p.ev(`${wrap("prov")}.querySelector("qc-select > select").value`);
    say(shown === "qc" ? "PASS" : "FAIL", "PL-01c", `a written answer shows in the select: ${shown}`);
    const focus = await p.ev(`(() => { const w = ${wrap("prov")}; const t = w.querySelector("qc-select").shadowRoot.querySelector("button"); return !!t; })()`);
    say(focus ? "PASS" : "FAIL", "PL-01d", "the component's button (the focus target) is drawn");
  });

  // ── 2. read-only on the official listbox: the guard refuses the pointer and the keys ────
  await probe("RO-01", async (p) => {
    const options = [{ value: "qc", label: "Québec" }, { value: "on", label: "Ontario" }];
    const def = form([{ id: "prov", type: "qc-select", configuration: { label: "Province", options, readOnly: true } }], { kinds: { "qc-select": "select" } });
    await p.mount({ definition: def, binding: null });
    await p.ev(`${wrap("prov")}.querySelector("qc-select").shadowRoot.querySelector("button").click()`);
    await p.sleep(300);
    const expanded = await p.ev(`${wrap("prov")}.querySelector("qc-select").hasAttribute("expanded")`);
    say(!expanded ? "PASS" : "FAIL", "RO-01", `a read-only qc-select does not open (expanded=${expanded})`);
  });

  // ── 3. notices: qc-notice, never an error, named in the description ───────────────────
  await probe("NT", async (p) => {
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    const def = form([
      { id: "nick", type: "text", configuration: { label: "Nickname", characterCount: true, maxLength: 20 } },
      { id: "way", type: "radio", configuration: { label: "Way", options } },
      { id: "pick", type: "select", configuration: { label: "Pick", options } }
    ]);
    await p.mount({ definition: def, binding: null, stages: ["advice:warning:nick", "advice:info:pick", "advice:warning:way"] });
    await p.validate();
    for (const [id, type] of [["nick", "warning"], ["pick", "information"], ["way", "warning"]]) {
      const info = JSON.parse(await p.ev(`(() => {
        const w = ${wrap(id)};
        const block = w.querySelector("[data-notices]");
        const notice = block?.querySelector("qc-notice");
        const deep = (root, sel, out = []) => { for (const el of root.querySelectorAll("*")) { if (el.matches(sel)) out.push(el); if (el.shadowRoot) deep(el.shadowRoot, sel, out); } return out; };
        const controls = deep(w, "input, textarea, select, fieldset");
        const described = controls.some((c) => [...(c.ariaDescribedByElements ?? [])].includes(block) || (c.getAttribute("aria-describedby") ?? "").split(" ").includes(block?.id) || (c.getAttribute("aria-description") ?? "").includes(block?.textContent.trim().slice(0, 12)));
        return JSON.stringify({ type: notice?.getAttribute("type") ?? null, word: block?.querySelector(".qc-sr-only")?.textContent ?? null, invalid: w.hasAttribute("data-invalid"), described });
      })()`));
      const ok = info.type === type && /^(Warning|Information)/.test(info.word ?? "") && !info.invalid && info.described;
      say(ok ? "PASS" : "FAIL", `NT-${id}`, JSON.stringify(info));
    }
    const count = JSON.parse(await p.ev(`(() => { const w = ${wrap("nick")}; const limit = w.querySelector(".qc-sr-only[id]"); const box = w.querySelector("qc-textfield > input"); return JSON.stringify({ id: limit?.id ?? null, described: (box.getAttribute("aria-describedby") ?? "").split(" ").includes(limit?.id ?? "-") }); })()`));
    say(count.described ? "PASS" : "FAIL", "NT-count", `the count's limit sentence and the notice describe the box: ${JSON.stringify(count)}`);
    // The toolkit rewrites aria-describedby when its own state changes: the ids Datum added stay.
    await p.ev(`${wrap("nick")}.querySelector("qc-textfield").invalid = true`);
    await p.sleep(400);
    const kept = await p.ev(`(() => { const w = ${wrap("nick")}; const box = w.querySelector("qc-textfield > input"); const ids = (box.getAttribute("aria-describedby") ?? "").split(" "); return ids.includes(w.querySelector("[data-notices]").id); })()`);
    say(kept ? "PASS" : "FAIL", "NT-keep", "the notice stays in the description after the toolkit rewrites it");
  });

  // ── 3b. a lone checkbox: notice and error describe the box (the binding's own aria-description; the suite's NTC-08 covers the notice too) ──
  await probe("CB", async (p) => {
    const def = form([{ id: "agree", type: "checkbox", configuration: { label: "I agree", required: true } }]);
    await p.mount({ definition: def, binding: null, stages: ["advice:warning:agree"] });
    await p.validate();
    const info = JSON.parse(await p.ev(`(() => { const w = ${wrap("agree")}; const box = w.querySelector("qc-checkbox input"); return JSON.stringify({ description: box.getAttribute("aria-description"), notice: w.querySelector("qc-notice")?.getAttribute("type") ?? null, invalid: w.hasAttribute("data-invalid") }); })()`));
    say(/required/.test(info.description ?? "") && /short/.test(info.description ?? "") && info.notice === "warning" && info.invalid ? "PASS" : "FAIL", "CB-01", JSON.stringify(info));
  });

  // ── 3c. a lone checkbox's hint: drawn as the toolkit's .qc-description under the label, and named by the checkbox ──
  await probe("CB-02", async (p) => {
    const def = form([{ id: "terms", type: "checkbox", configuration: { label: "I agree to the terms", description: "You can withdraw at any time.", required: true } }]);
    await p.mount({ definition: def, binding: null });
    const info = JSON.parse(await p.ev(`(() => {
      const w = ${wrap("terms")};
      const box = w.querySelector("qc-checkbox input");
      const hint = w.querySelector("qc-checkbox > .qc-description");
      const ids = (box.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      const shown = !!hint && hint.getBoundingClientRect().height > 0 && getComputedStyle(hint).visibility !== "hidden";
      const text = w.querySelector("qc-checkbox > label > span");
      const aligned = !!hint && !!text && Math.abs(hint.getBoundingClientRect().left - text.getBoundingClientRect().left) <= 2 && hint.getBoundingClientRect().top >= text.getBoundingClientRect().bottom - 1;
      return JSON.stringify({ hint: hint?.textContent.trim() ?? null, shown, aligned, named: !!hint?.id && ids.includes(hint.id), description: box.getAttribute("aria-description") });
    })()`));
    const ok = info.hint === "You can withdraw at any time." && info.shown && info.aligned && info.named && !(info.description ?? "").includes("withdraw");
    say(ok ? "PASS" : "FAIL", "CB-02", `the hint is drawn under the label, lined up with its text, and describes the checkbox by id, once: ${JSON.stringify(info)}`);
  });

  // ── 4. pending: degraded, a word in the description while the async check runs ───────
  await probe("PD", async (p) => {
    const def = form([{ id: "nick", type: "text", configuration: { label: "Nickname" } }]);
    await p.mount({ definition: def, binding: null, stages: ["remote:nick"] });
    await p.ev(`void __probe.runtime.validate()`);
    await p.sleep(600);
    const state = JSON.parse(await p.ev(`JSON.stringify({ pending: ${wrap("nick")}.hasAttribute("data-pending"), busy: ${wrap("nick")}.getAttribute("aria-busy"), help: ${wrap("nick")}.querySelector("qc-textfield").getAttribute("description") })`));
    say(state.pending && state.busy === "true" && /Checking/.test(state.help ?? "") ? "PASS" : "FAIL", "PD-01", `pending field: ${JSON.stringify(state)}`);
    await p.ev(`window.__host.answerPending()`);
    await p.sleep(600);
    const after = JSON.parse(await p.ev(`JSON.stringify({ pending: ${wrap("nick")}.hasAttribute("data-pending"), help: ${wrap("nick")}.querySelector("qc-textfield").getAttribute("description") })`));
    say(!after.pending && !after.help ? "PASS" : "FAIL", "PD-02", `answered: ${JSON.stringify(after)}`);
  });

  // ── 5. the summary and the receipt: qc-notice, the heading level, the kind said once ────
  await probe("RC", async (p) => {
    const def = form([{ id: "name", type: "text", configuration: { label: "Name", required: true } }]);
    await p.mount({ definition: def, binding: null, headingLevel: 2, notice: { kind: "success", title: "Thanks", message: "We have your answers.", details: [{ label: "Reference", value: "A-123" }] } });
    const read = JSON.parse(await p.ev(`(() => { const r = __probe.root.querySelector(".datum-qc-receipt"); const n = r?.querySelector("qc-notice"); return JSON.stringify({ type: n?.getAttribute("type") ?? null, heading: n?.querySelector("h3")?.textContent.trim() ?? null, word: r?.querySelector(".qc-sr-only")?.textContent.trim() ?? null, role: r?.getAttribute("role") ?? null, details: r?.querySelector("dd")?.textContent ?? null }); })()`));
    say(read.type === "success" && /Thanks/.test(read.heading ?? "") && /Success/.test(read.word ?? "") && read.role === "status" && read.details === "A-123" ? "PASS" : "FAIL", "RC-01", `receipt: ${JSON.stringify(read)}`);
    await p.validate();
    const summary = JSON.parse(await p.ev(`(() => { const n = __probe.root.querySelector(".datum-qc-summary > qc-notice"); return JSON.stringify({ type: n?.getAttribute("type") ?? null, level: n?.querySelector("h1,h2,h3,h4")?.localName ?? null, links: n?.querySelectorAll("a").length ?? 0, box: n?.shadowRoot?.querySelector("[tabindex]")?.className ?? null }); })()`));
    say(summary.type === "error" && summary.level === "h2" && summary.links === 1 && /qc-notice/.test(summary.box ?? "") ? "PASS" : "FAIL", "RC-02", `summary: ${JSON.stringify(summary)} (the summary is a level under the form's, and the toolkit's box carries the tabindex the renderer focuses)`);
  });

  // ── 6. a summary link to a date with only a year goes to the first part lacking ──────────
  await probe("DO", async (p) => {
    const def = form([{ id: "when", type: "date", configuration: { label: "When", required: true } }]);
    await p.mount({ definition: def, binding: null });
    await p.page.locator('[data-component-id=when] qc-textfield input[data-value-part=year]').fill("2027");
    await p.sleep(300);
    await p.validate();
    await p.ev(`__probe.root.querySelector(".datum-qc-summary a").click()`);
    await p.sleep(300);
    const active = await p.ev(`(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a?.dataset?.valuePart ?? null; })()`);
    say(active === "day" ? "PASS" : "FAIL", "DO-01", `a summary link for a date with only the year goes to the part lacking, first in the order drawn (${active})`);
  });

  // ── 7. a grid is drawn stacked whatever the author chose, cells keeping their labels ─────
  await probe("GT", async (p) => {
    const def = form([{ id: "fixed", type: "dataGrid", configuration: { label: "Fixed", initialRows: 1, layout: "table" }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }] } }]);
    await p.mount({ definition: def, binding: null });
    const r = JSON.parse(await p.ev(`(() => { const root = __probe.root; return JSON.stringify({ tables: root.querySelectorAll("table").length, rows: root.querySelectorAll(".datum-qc-row").length, label: root.querySelector('.datum-live-field[data-component-id="item"] qc-textfield')?.getAttribute("label") }); })()`));
    say(r.tables === 0 && r.rows === 1 && r.label === "Item" ? "PASS" : "FAIL", "GT-01", JSON.stringify(r));
  });

  // ── 8. the French pack: the toolkit's own words, with the form's language and not the page's ─
  await probe("FR", async (p) => {
    const def = form([{ id: "name", type: "text", configuration: { label: "Nom", characterCount: true, maxLength: 10 } }, { id: "ville", type: "text", configuration: { label: "Ville", required: true } }]);
    await p.mount({ definition: def, binding: null, locale: "fr", preset: { name: "Ada" } });
    await p.validate();
    const read = JSON.parse(await p.ev(`(() => { const r = __probe.root; return JSON.stringify({ heading: r.querySelector(".datum-qc-summary h3, .datum-qc-summary h2")?.textContent ?? null, count: r.querySelector("[data-count-status]")?.textContent ?? null }); })()`));
    say(/Des erreurs sont présentes/.test(read.heading ?? "") && /caractères restants/.test(read.count ?? "") ? "PASS" : "FAIL", "FR-01", JSON.stringify(read));
  });

  // ── 9. the toolkit's language follows the page, the binding hands it the form's words ───
  await probe("LG", async (p) => {
    const def = form([{ id: "name", type: "text", configuration: { label: "Name", required: true, messages: { required: "Enter a name." } } }]);
    await p.mount({ definition: def, binding: null });
    await p.validate();
    const text = await p.ev(`__probe.root.querySelector('.datum-live-field[data-component-id="name"] .qc-form-error')?.textContent.trim() ?? null`);
    say(/Enter a name\./.test(text ?? "") ? "PASS" : "FAIL", "LG-01", `the error is the form's words, not the toolkit's default: ${JSON.stringify(text)}`);
  });
} finally {
  await browser.close();
  built.dispose();
}

const failed = results.filter((r) => r.status === "FAIL");
console.log(`\nquebec extras: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exitCode = failed.length === 0 ? 0 : 1;
