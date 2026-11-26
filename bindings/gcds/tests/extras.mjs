#!/usr/bin/env node
// Probes the tester's cases do not reach, against the GCDS binding in a real
// browser: the tier-2 `gcds-date` type (kinds map), notices, pending, the grid's table layout,
// busy buttons, read-only marks on a component's inner controls, the date's drawn order, the
// binding's language pack, and the cross-boundary description. Prints PASS / FAIL / NOTE lines;
// FAIL lines are findings (a binding bug, or a contract gap, said in the message).
//   node extras.mjs [--port 4670]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 4670);

// The tester's host page, build and Playwright driver (packages/conformance-suite/binding-check), with this
// folder's own host module (host.ts: mountProbe) built beside the GCDS binding.
const built = await buildRun({ binding: join(here, "..", "src", "binding.ts"), name: "gcds-extras", extraEntries: { probe: join(here, "host.ts") } });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "gcds")], builds: [built] });
const results = [];
// Findings that are contract gaps, not binding bugs: printed GAP, not FAIL. The four
// Gaps an earlier run found were closed by the contract and are asserted as passes.
const GAPS = new Set([]);
const say = (status, id, message) => { if (status === "FAIL" && GAPS.has(id)) status = "GAP"; results.push({ status, id, message }); console.log(`${status.padEnd(5)} ${id.padEnd(10)} ${message}`); };
const assets = { stylesheets: [{ url: "/node_modules/gcds-components-1.7.0/dist/gcds/gcds.css" }], scripts: [{ url: "/node_modules/gcds-components-1.7.0/dist/gcds/gcds.esm.js" }] };

const form = (content, extra = {}) => ({ id: "x" + Math.random().toString(36).slice(2, 6), version: "1.0.0", schemaVersion: "1", localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français" }] }, root: { id: "root", type: "form", configuration: {}, children: { content } }, ...extra });

async function open() {
  const page = await browser.open("/binding-check.html");
  await page.waitForFunction("window.bindingCheckReady === true", undefined, { timeout: 30000 });
  await page.evaluate(`(async () => { window.__host = await import(${JSON.stringify(built.urlOf("probe"))}); window.__binding = (await import(${JSON.stringify(built.bindingUrl)})); })()`);
  const api = {
    page,
    ev: (expr) => page.evaluate(expr),
    async mount(options) {
      const payload = JSON.stringify({ ...options, assets: options.assets === false ? undefined : assets });
      await page.evaluate(`(async () => { const o = ${payload}; o.binding = window.__binding.createBinding(window.__host.lit, window.__host.datum); await window.__host.mountProbe(o); })()`);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    close: () => page.close()
  };
  return api;
}
const wrap = (id) => `__probe.root.querySelector('.datum-live-field[data-component-id="${id}"]')`;
const deep = `(root, sel, out = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) out.push(el); if (el.shadowRoot) arguments.callee(el.shadowRoot, sel, out); } return out; }`;

async function probe(id, run) {
  let p;
  try { p = await open(); await run(p); } catch (error) { say("FAIL", id, `probe error: ${String(error.message ?? error).split("\n")[0]}`); } finally { try { p?.close(); } catch {} }
}

try {
  // ── 1. gcds-date: the official component under its own type, read as `date` through the kinds map ──
  await probe("GD", async (p) => {
    const def = form([{ id: "start", type: "gcds-date", configuration: { label: "Start date", required: true, description: "For example 14 5 2026." } }], { kinds: { "gcds-date": "date" } });
    await p.mount({ definition: def, binding: null });
    const tag = await p.ev(`!!${wrap("start")}?.querySelector('gcds-date-input')`);
    say(tag ? "PASS" : "FAIL", "GD-01", tag ? "gcds-date draws the official <gcds-date-input>" : "gcds-date did not draw <gcds-date-input>");
    const kind = await p.ev(`${wrap("start")}?.getAttribute('data-kind')`);
    say(kind === "date" ? "PASS" : "FAIL", "GD-02", `data-kind of a gcds-date is "${kind}" (the base type)`);
    // Type part of a date through the component's inner controls.
    await p.ev(`(async () => { const host = ${wrap("start")}.querySelector('gcds-date-input'); await new Promise(r => setTimeout(r, 300)); const inputs = [...host.shadowRoot.querySelectorAll('gcds-input')]; const set = (el, v) => { const box = el.shadowRoot.querySelector('input'); box.focus(); box.value = v; box.dispatchEvent(new Event('input', { bubbles: true, composed: true })); box.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }; set(inputs[0], '14'); })()`);
    await p.sleep(300);
    let values = await p.ev(`JSON.stringify(__probe.runtime.state().values)`);
    say(!JSON.parse(values).start ? "PASS" : "FAIL", "GD-03", `a date typed in part stores nothing (${values})`);
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(300);
    const errors = JSON.parse(await p.ev(`JSON.stringify(__probe.runtime.errors().map(e => e.code))`));
    say(errors.some((c) => /date|required/i.test(c)) ? "PASS" : "FAIL", "GD-04", `an incomplete gcds-date is invalid in the browser (${errors.join(",")})`);
    // Complete it.
    await p.ev(`(async () => { const host = ${wrap("start")}.querySelector('gcds-date-input'); const inputs = [...host.shadowRoot.querySelectorAll('gcds-input')]; const set = (el, v) => { const box = el.shadowRoot.querySelector('input'); box.value = v; box.dispatchEvent(new Event('input', { bubbles: true, composed: true })); box.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }; const select = host.shadowRoot.querySelector('gcds-select'); const sel = select.shadowRoot.querySelector('select'); sel.value = '05'; sel.dispatchEvent(new Event('change', { bubbles: true, composed: true })); set(inputs[1], '2026'); })()`);
    await p.sleep(500);
    values = await p.ev(`JSON.stringify(__probe.runtime.state().values)`);
    say(JSON.parse(values).start === "2026-05-14" ? "PASS" : "FAIL", "GD-05", `completed, it composes (${values})`);
  });

  // ── 1b. gcds-date under the Datum binding falls back to date; and without a kinds entry it is unknown ──
  await probe("GK", async (p) => {
    const def = form([{ id: "start", type: "gcds-date", configuration: { label: "Start date" } }]);
    await p.mount({ definition: def, binding: null });
    const note = await p.ev(`__probe.form.unsupported()`);
    const kind = await p.ev(`${wrap("start")}?.getAttribute('data-kind')`);
    // The binding's own kinds stand under the definition's map in the drawing; the missing entry is reported (validation still reads the definition's map alone).
    say(note.includes('start: component "gcds-date" has no kinds entry') && kind === "date" ? "PASS" : "FAIL", "GK-01", `a gcds-date form WITHOUT the kinds entry: unsupported() = ${JSON.stringify(note)}; drawn kind=${kind}`);
  });

  // ── 1c. gcds-date typed without kinds: what is stored? ──
  await probe("GK2", async (p) => {
    const def = form([{ id: "start", type: "gcds-date", configuration: { label: "Start date", required: true } }]);
    await p.mount({ definition: def, binding: null });
    await p.ev(`(async () => { const host = ${wrap("start")}.querySelector('gcds-date-input'); await new Promise(r => setTimeout(r, 300)); const inputs = [...host.shadowRoot.querySelectorAll('gcds-input')]; const set = (el, v) => { const box = el.shadowRoot.querySelector('input'); box.value = v; box.dispatchEvent(new Event('input', { bubbles: true, composed: true })); box.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }; const sel = host.shadowRoot.querySelector('gcds-select').shadowRoot.querySelector('select'); sel.value = '05'; sel.dispatchEvent(new Event('change', { bubbles: true, composed: true })); set(inputs[0], '14'); set(inputs[1], '2026'); })()`);
    await p.sleep(500);
    const values = await p.ev(`JSON.stringify(__probe.runtime.state().values)`);
    const errs = await p.ev(`JSON.stringify(__probe.runtime.errors().map(e => e.code))`);
    say("NOTE", "GK-02", `gcds-date with no kinds entry, a full date typed: values=${values} errors=${errs}`);
  });

  // ── 2. notices (warning), described, never an error ──
  await probe("NT", async (p) => {
    const def = form([
      { id: "nick", type: "text", configuration: { label: "Nickname", description: "What friends call you" } },
      { id: "area", type: "textarea", configuration: { label: "Area" } },
      { id: "pick", type: "select", configuration: { label: "Pick", options: [{ value: "a", label: "A" }] } },
      { id: "way", type: "radio", configuration: { label: "Way", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
      { id: "boxes", type: "checkboxes", configuration: { label: "Boxes", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
      { id: "when", type: "date", configuration: { label: "When" } },
      { id: "gwhen", type: "gcds-date", configuration: { label: "GWhen" } }
    ], { kinds: { "gcds-date": "date" } });
    await p.mount({ definition: def, binding: null, stages: ["advice:warning:nick", "advice:info:area", "advice:warning:pick", "advice:warning:way", "advice:warning:boxes", "advice:warning:when", "advice:warning:gwhen"] });
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(600);
    for (const id of ["nick", "area", "pick", "way", "boxes", "when", "gwhen"]) {
      const info = JSON.parse(await p.ev(`(() => { const w = ${wrap(id)}; const n = w.querySelector('[data-notices], .datum-gcds-notices'); const block = w.querySelector('.datum-gcds-notices'); const invalid = w.hasAttribute('data-invalid'); const text = block?.textContent.trim() ?? null; const box = [...w.querySelectorAll('*')].flatMap(el => el.shadowRoot ? [...el.shadowRoot.querySelectorAll('input,textarea,select,fieldset')] : []).concat([...w.querySelectorAll('input,textarea,select,fieldset')]).find(el => el.ariaDescribedByElements?.length || el.getAttribute('aria-describedby')); const reflects = !!block && [...(box?.ariaDescribedByElements ?? [])].includes(block); const direct = !!block && (box?.getAttribute('aria-describedby') ?? '').split(' ').includes(block.id); return JSON.stringify({ text, invalid, reflects, direct, id: block?.id ?? null, box: box ? box.localName : null }); })()`));
      const ok = info.text && !info.invalid;
      say(ok ? "PASS" : "FAIL", `NT-${id}`, `${JSON.stringify(info)}`);
    }
  });

  // ── 3. pending: degraded, a word in the hint while the async check runs ──
  await probe("PD", async (p) => {
    const def = form([{ id: "nick", type: "text", configuration: { label: "Nickname" } }, { id: "when", type: "date", configuration: { label: "When" } }]);
    await p.mount({ definition: def, binding: null, stages: ["remote:nick"] });
    await p.ev(`void __probe.runtime.validate()`);
    await p.sleep(500);
    const wrapState = JSON.parse(await p.ev(`JSON.stringify({ pending: ${wrap("nick")}.hasAttribute('data-pending'), busy: ${wrap("nick")}.getAttribute('aria-busy'), hint: ${wrap("nick")}.querySelector('gcds-input').getAttribute('hint') })`));
    say(wrapState.pending && wrapState.busy === "true" && /Checking/.test(wrapState.hint ?? "") ? "PASS" : "FAIL", "PD-01", `pending field: ${JSON.stringify(wrapState)}`);
    await p.ev(`window.__host.answerPending()`);
    await p.sleep(500);
    const after = JSON.parse(await p.ev(`JSON.stringify({ pending: ${wrap("nick")}.hasAttribute('data-pending'), hint: ${wrap("nick")}.querySelector('gcds-input').getAttribute('hint') })`));
    say(!after.pending && !after.hint ? "PASS" : "FAIL", "PD-02", `answered: ${JSON.stringify(after)}`);
  });

  // ── 4. the grid with an explicit table layout: labels hidden for column headings the adapter does not draw ──
  await probe("GT", async (p) => {
    const def = form([{ id: "lines", type: "dataGrid", configuration: { label: "Items", initialRows: 1, layout: "table" }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }] } }]);
    await p.mount({ definition: def, binding: null });
    const r = JSON.parse(await p.ev(`(() => { const w = ${wrap("item")}; const gi = w.querySelector('gcds-input'); return JSON.stringify({ hideLabel: gi?.hasAttribute('hide-label'), headings: __probe.root.querySelectorAll('th, [role=columnheader]').length }); })()`));
    say(r.hideLabel && r.headings === 0 ? "FAIL" : "PASS", "GT-01", `explicit table layout under a stacked-only adapter: cell label hidden=${r.hideLabel}, column headings drawn=${r.headings} (the grid state asks for table, labels are hidden for headings the binding cannot draw)`);
  });

  // ── 5. buttons: the form's own button and a press ──
  await probe("BT", async (p) => {
    const def = form([{ id: "go", type: "button", configuration: { label: "Send", action: "submit", variant: "primary" } }]);
    await p.mount({ definition: def, binding: null });
    await p.ev(`${wrap("go")}.querySelector('gcds-button').shadowRoot.querySelector('button').click()`);
    await p.sleep(200);
    const events = JSON.parse(await p.ev(`JSON.stringify(__probe.events)`));
    const ev = events.find((e) => e.type === "datum-form-action");
    say(ev?.detail?.action === "submit" ? "PASS" : "FAIL", "BT-01", `press on a gcds-button reports ${JSON.stringify(ev?.detail)}`);
  });

  // ── 6. read-only: the inner controls of a component carry aria-readonly where the guards cannot reach ──
  await probe("RO", async (p) => {
    const def = form([
      { id: "pick", type: "select", configuration: { label: "Pick", readOnly: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
      { id: "way", type: "radio", configuration: { label: "Way", readOnly: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
      { id: "boxes", type: "checkboxes", configuration: { label: "Boxes", readOnly: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
      { id: "gwhen", type: "gcds-date", configuration: { label: "When", readOnly: true } }
    ], { kinds: { "gcds-date": "date" } });
    await p.mount({ definition: def, binding: null });
    for (const [id, sel] of [["pick", "select"], ["way", "[role=radiogroup]"], ["boxes", "input[type=checkbox]"], ["gwhen", "select"]]) {
      const r = JSON.parse(await p.ev(`(() => { const w = ${wrap(id)}; const all = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.matches(${JSON.stringify(sel)})) all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(w); return JSON.stringify({ n: all.length, marked: all.filter(el => el.getAttribute('aria-readonly') === 'true').length, outer: w.hasAttribute('data-readonly') }); })()`));
      // gcds-radios' plain fieldset takes the radiogroup role from the renderer while read-only, to carry aria-readonly.
      say(r.n > 0 && r.marked === r.n ? "PASS" : "FAIL", `RO-${id}`, `${JSON.stringify(r)} (aria-readonly on the controls inside the component, marked by the renderer)`);
    }
  });

  // ── 7. the date's drawn order: the state's missingParts against the order the adapter draws ──
  await probe("DO", async (p) => {
    const def = form([{ id: "when", type: "date", configuration: { label: "When", required: true } }]);
    await p.mount({ definition: def, binding: null, locale: "en", spyDate: true });
    // Type only the year, validate, and ask where a summary link sends focus: the first missing part in the order drawn (month, day, year).
    await p.ev(`(() => { const w = ${wrap("when")}; const y = w.querySelector('[data-value-part=year]'); y.value = '2026'; y.dispatchEvent(new Event('input', { bubbles: true })); y.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await p.sleep(200);
    const order = JSON.parse(await p.ev(`JSON.stringify([...${wrap("when")}.querySelectorAll('[data-value-part]')].map(e => e.dataset.valuePart))`));
    say(order.join() === "month,day,year" ? "PASS" : "FAIL", "DO-01", `en order drawn: ${order}`);
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(300);
    const seen = await p.ev(`JSON.stringify(window.__seen)`);
    say(seen === '["month","day"]' ? "PASS" : "FAIL", "DO-03", `the date state's missingParts (documented "in drawn order") for a year-only date drawn month, day, year: ${seen} (the renderer's date state builder is configured by the host's features with Datum's order, not the binding's)`);
    const link = await p.ev(`(() => { const a = [...__probe.root.querySelectorAll('.datum-live-summary a, .datum-live-summary gcds-error-summary')]; return a.length; })()`);
    // The state the adapter receives: read through a throwaway adapter is not possible from here; ask the focus target instead.
    const dbg = await p.ev(`JSON.stringify({ has: !!__probe.root.querySelector('gcds-error-summary'), links: __probe.root.querySelector('gcds-error-summary')?.getAttribute('error-links'), anchors: __probe.root.querySelector('gcds-error-summary')?.shadowRoot?.querySelectorAll('a').length })`);
    await p.ev(`(() => { const find = (root) => { for (const e of root.querySelectorAll('*')) { if (e.localName === 'a') return e; const f = e.shadowRoot && find(e.shadowRoot); if (f) return f; } return null; }; const sum = __probe.root.querySelector('gcds-error-summary'); (find(sum) ?? find(sum.shadowRoot))?.click(); })()`);
    await p.sleep(300);
    const active = await p.ev(`(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a ? (a.dataset?.valuePart ?? a.localName) : null; })()`);
    say(active === "month" ? "PASS" : "FAIL", "DO-02", `a summary link for a date with only the year goes to "${active}" (first missing in drawn order is month) ${dbg}`);
  });

  // ── 8. words: GC Design System's own English and French wording reaches summary, labels and per-type messages ──
  await probe("TX", async (p) => {
    const def = form([
      { id: "name", type: "text", configuration: { label: "Name", required: true } },
      { id: "way", type: "radio", configuration: { label: "Way", required: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } },
      { id: "when", type: "date", configuration: { label: "When", required: true } }
    ]);
    await p.mount({ definition: def, binding: null });
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(500);
    const r = JSON.parse(await p.ev(`JSON.stringify({ heading: __probe.root.querySelector('gcds-error-summary')?.getAttribute('heading'), links: JSON.parse(__probe.root.querySelector('gcds-error-summary')?.getAttribute('error-links') ?? '{}'), required: ${wrap("when")}.querySelector('legend').textContent.trim(), name: ${wrap("name")}.querySelector('gcds-input').getAttribute('error-message'), way: ${wrap("way")}.querySelector('gcds-radios').getAttribute('error-message') })`));
    say(r.heading === "There was a problem" ? "PASS" : "FAIL", "TX-01", `summary heading "${r.heading}"`);
    say(Object.values(r.links).every((t) => / - /.test(t)) ? "PASS" : "FAIL", "TX-02", `summary lines ${JSON.stringify(Object.values(r.links))}`);
    say(r.name === "Enter information to continue." && r.way === "Choose an option to continue." ? "PASS" : "FAIL", "TX-03", `messages name="${r.name}" way="${r.way}"`);
    say(/\(required\)/.test(r.required) ? "PASS" : "FAIL", "TX-04", `date legend marker "${r.required}"`);
    await p.ev(`__probe.runtime.setLocale('fr-CA')`);
    await p.sleep(700);
    const f = JSON.parse(await p.ev(`JSON.stringify({ heading: __probe.root.querySelector('gcds-error-summary')?.getAttribute('heading'), way: ${wrap("way")}.querySelector('gcds-radios').getAttribute('error-message'), month: ${wrap("when")}.querySelector('[data-value-part=month] option')?.textContent, order: [...${wrap("when")}.querySelectorAll('[data-value-part]')].map(e => e.dataset.valuePart).join() })`));
    say(f.heading === "Un problème est survenu" && /Choisissez/.test(f.way ?? "") && f.order === "day,month,year" ? "PASS" : "FAIL", "TX-05", `French: ${JSON.stringify(f)}`);
  });

  // ── 9. hideLabel on every adapter ──
  await probe("HL", async (p) => {
    const def = form([
      { id: "a", type: "text", configuration: { label: "A", hideLabel: true } },
      { id: "b", type: "textarea", configuration: { label: "B", hideLabel: true } },
      { id: "c", type: "select", configuration: { label: "C", hideLabel: true, options: [{ value: "a", label: "A" }] } },
      { id: "d", type: "date", configuration: { label: "D", hideLabel: true } }
    ]);
    await p.mount({ definition: def, binding: null });
    const r = JSON.parse(await p.ev(`JSON.stringify({ a: ${wrap("a")}.querySelector('gcds-input').hasAttribute('hide-label'), b: ${wrap("b")}.querySelector('gcds-textarea').hasAttribute('hide-label'), c: ${wrap("c")}.querySelector('gcds-select').hasAttribute('hide-label'), d: (() => { const l = ${wrap("d")}.querySelector('legend'); const r = l.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })() })`));
    say(Object.values(r).every(Boolean) ? "PASS" : "FAIL", "HL-01", JSON.stringify(r));
  });

  // ── 10. a group with a hidden legend: the capability is not answerable for a container ──
  await probe("HG", async (p) => {
    const def = form([{ id: "g", type: "fieldset", configuration: { label: "Hidden legend group", hideLabel: true }, children: { content: [{ id: "inner", type: "text", configuration: { label: "Inner" } }] } }]);
    await p.mount({ definition: def, binding: null });
    const r = JSON.parse(await p.ev(`JSON.stringify({ legend: __probe.root.querySelector('gcds-fieldset')?.getAttribute('legend'), unsupported: __probe.form.unsupported() })`));
    say(r.unsupported.some((u) => /g.*hide/i.test(u)) ? "PASS" : "FAIL", "HG-01", `fieldset with hideLabel under an adapter that cannot hide its legend: legend drawn "${r.legend}", unsupported()=${JSON.stringify(r.unsupported)} (the renderer reports a capability only for fields)`);
  });

  // ── 10b. number: gcds-input type=number, kept as typed while it stands for the stored number; bounds ──
  await probe("NUM", async (p) => {
    const def = form([
      { id: "age", type: "number", configuration: { label: "Age", min: 1, max: 120 } },
      { id: "cost", type: "number", configuration: { label: "Cost", prefix: "$", description: "Affixed number" } }
    ]);
    await p.mount({ definition: def, binding: null });
    const drawn = await p.ev(`(async () => { const host = ${wrap("age")}.querySelector('gcds-input'); await host.componentOnReady(); return host.getAttribute('type') + '/' + host.shadowRoot.querySelector('input').type; })()`);
    say(drawn === "number/number" ? "PASS" : "FAIL", "NUM-01", `number draws <gcds-input type="number"> (${drawn})`);
    await p.ev(`(async () => { const host = ${wrap("age")}.querySelector('gcds-input'); const box = host.shadowRoot.querySelector('input'); box.focus(); box.value = '0042'; box.dispatchEvent(new Event('input', { bubbles: true, composed: true })); box.dispatchEvent(new Event('change', { bubbles: true, composed: true })); })()`);
    await p.sleep(400);
    const stored = JSON.parse(await p.ev(`JSON.stringify({ values: __probe.runtime.state().values, box: ${wrap("age")}.querySelector('gcds-input').shadowRoot.querySelector('input').value })`));
    say(stored.values.age === 42 && stored.box === "0042" ? "PASS" : "FAIL", "NUM-02", `typed 0042: stored ${JSON.stringify(stored.values.age)} (a number), the box keeps "${stored.box}"`);
    await p.ev(`__probe.runtime.setValue('age', 7)`);
    await p.sleep(300);
    const written = await p.ev(`${wrap("age")}.querySelector('gcds-input').shadowRoot.querySelector('input').value`);
    say(written === "7" ? "PASS" : "FAIL", "NUM-03", `a value written by a rule shows in the box ("${written}")`);
    await p.ev(`(async () => { const box = ${wrap("age")}.querySelector('gcds-input').shadowRoot.querySelector('input'); box.value = '200'; box.dispatchEvent(new Event('input', { bubbles: true, composed: true })); box.dispatchEvent(new Event('change', { bubbles: true, composed: true })); await __probe.runtime.validate(); await __probe.form.updated(); })()`);
    await p.sleep(400);
    const codes = JSON.parse(await p.ev(`JSON.stringify(__probe.runtime.errors().map((e) => e.code))`));
    say(codes.some((c) => /max/i.test(c)) ? "PASS" : "FAIL", "NUM-04", `200 against max 120 is an error (${codes.join(",")})`);
    await p.ev(`(() => { const box = ${wrap("cost")}.querySelector('.datum-gcds-affix > input'); box.value = '12.5'; box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await p.sleep(300);
    const cost = JSON.parse(await p.ev(`JSON.stringify({ v: __probe.runtime.state().values.cost, type: ${wrap("cost")}.querySelector('.datum-gcds-affix > input').type })`));
    say(cost.v === 12.5 && cost.type === "number" ? "PASS" : "FAIL", "NUM-05", `an affixed number is a number box and stores 12.5 (${JSON.stringify(cost)})`);
  });

  // ── 10c. steps: gcds-stepper heads each panel; Continue is checked by the renderer; focus lands on the new heading ──
  await probe("STP", async (p) => {
    const def = form([
      { id: "wiz", type: "steps", configuration: { label: "Application" }, children: { content: [
        { id: "s1", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] } },
        { id: "s2", type: "step", configuration: { label: "Where" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } }
      ] } }
    ]);
    await p.mount({ definition: def, binding: null });
    const first = JSON.parse(await p.ev(`JSON.stringify({ steppers: __probe.root.querySelectorAll('gcds-stepper').length, hidden: [...__probe.root.querySelectorAll('[data-step-panel]')].map((el) => el.hidden), tag: __probe.root.querySelector('gcds-stepper').getAttribute('tag'), buttons: [...__probe.root.querySelectorAll('gcds-button')].map((b) => b.textContent.trim()) })`));
    say(first.steppers === 2 && first.hidden.join() === "false,true" && first.buttons.join() === "Continue" ? "PASS" : "FAIL", "STP-01", `a gcds-stepper per step, the second hidden, Continue only on the first: ${JSON.stringify(first)}`);
    await p.ev(`__probe.root.querySelector('[data-step-next]').click()`);
    await p.sleep(500);
    const stay = JSON.parse(await p.ev(`JSON.stringify({ hidden: [...__probe.root.querySelectorAll('[data-step-panel]')].map((el) => el.hidden), errors: __probe.runtime.errors().length })`));
    say(stay.hidden.join() === "false,true" && stay.errors > 0 ? "PASS" : "FAIL", "STP-02", `Continue with the required name empty stays and raises the error (${JSON.stringify(stay)})`);
    await p.ev(`(async () => { const box = ${wrap("name")}.querySelector('gcds-input').shadowRoot.querySelector('input'); box.value = 'Ada'; box.dispatchEvent(new Event('input', { bubbles: true, composed: true })); box.dispatchEvent(new Event('change', { bubbles: true, composed: true })); })()`);
    await p.sleep(300);
    await p.ev(`__probe.root.querySelector('[data-step-next]').click()`);
    await p.sleep(600);
    const moved = JSON.parse(await p.ev(`JSON.stringify({ hidden: [...__probe.root.querySelectorAll('[data-step-panel]')].map((el) => el.hidden), active: __probe.root.activeElement?.id ?? null, label: __probe.root.activeElement?.textContent ?? null, buttons: [...__probe.root.querySelectorAll('gcds-button')].map((b) => b.textContent.trim()) })`));
    say(moved.hidden.join() === "true,false" && moved.label === "Where" ? "PASS" : "FAIL", "STP-03", `a valid Continue opens step two and focus lands on its heading (${JSON.stringify(moved)})`);
  });

  // ── 10d. the host's receipt is a gcds-notice in a region focus can land on; the journey page heading follows the form's level ──
  await probe("RCP", async (p) => {
    const def = form([{ id: "name", type: "text", configuration: { label: "Name" } }]);
    await p.mount({ definition: def, binding: null, locale: "fr-CA", headingLevel: 2, notice: { kind: "success", title: "Reçu", message: "Merci.", details: [{ label: "Numéro", value: "GC-1" }], placement: ["top", "bottom"] } });
    await p.sleep(500);
    const r = JSON.parse(await p.ev(`JSON.stringify({ n: __probe.root.querySelectorAll('gcds-notice').length, role: __probe.root.querySelector('gcds-notice').getAttribute('notice-role'), tag: __probe.root.querySelector('gcds-notice').getAttribute('notice-title-tag'), title: __probe.root.querySelector('gcds-notice').getAttribute('notice-title'), region: __probe.root.querySelector('.datum-form__notice[tabindex]')?.getAttribute('role') ?? null, echoHidden: [...__probe.root.querySelectorAll('.datum-gcds-receipt')].filter((el) => el.getAttribute('aria-hidden') === 'true').length })`));
    say(r.n === 2 && r.role === "success" && r.tag === "h3" && r.title === "Succès : Reçu" && r.region === "status" && r.echoHidden === 1 ? "PASS" : "FAIL", "RCP-01", `receipt at both ends: ${JSON.stringify(r)}`);
  });

  // ── 10e. the package's plugin: content types drawn with the real elements, words through state.text, bases on the definition ──
  await probe("PLG", async (p) => {
    const def = form([
      { id: "c1", type: "gcds-card", configuration: { title: "Apply", description: "Start here.", href: "/apply", badge: "New" } },
      { id: "l1", type: "gcds-link", configuration: { text: "Help", href: "/help" } },
      { id: "d1", type: "gcds-details", configuration: { title: "More", body: "Details." } },
      { id: "n1", type: "gcds-notice", configuration: { role: "warning", title: "Heads up", body: "Read this." } },
      { id: "i1", type: "gcds-icon", configuration: { name: "info-circle" } },
      { id: "h1", type: "gcds-header", configuration: { langHref: "/fr" } }
    ], { translations: { "fr-CA": { components: { c1: { title: { text: "Postuler", source: "stale" } }, n1: { title: { text: "Attention", source: "stale" } } } } } });
    await p.mount({ definition: def, binding: null, locale: "fr-CA" });
    await p.sleep(600);
    const r = JSON.parse(await p.ev(`JSON.stringify({ tags: ['gcds-card', 'gcds-link', 'gcds-details', 'gcds-notice', 'gcds-icon', 'gcds-header'].map((tag) => __probe.root.querySelectorAll(tag).length), card: __probe.root.querySelector('gcds-card').getAttribute('card-title'), notice: __probe.root.querySelector('gcds-notice').getAttribute('notice-title'), role: __probe.root.querySelector('gcds-notice').getAttribute('notice-role'), unsupported: __probe.form.unsupported() })`));
    say(r.tags.every((n) => n === 1) && r.card === "Postuler" && r.notice === "Attention" && r.role === "warning" ? "PASS" : "FAIL", "PLG-01", `each content type draws its element, titles worded through the form's translations: ${JSON.stringify(r)}`);
  });

  // ── 10f. fewer than two choices, row button names, busy steps, a field's errors, markers, the lone checkbox ──
  await probe("ONE", async (p) => {
    const def = form([
      { id: "r1", type: "radio", configuration: { label: "Radio question", required: true, options: [{ value: "a", label: "Only answer" }] } },
      { id: "c1", type: "checkboxes", configuration: { label: "Checkbox question", required: true, options: [{ value: "a", label: "Only box" }] } },
      { id: "r0", type: "radio", configuration: { label: "Empty radio question", options: [] } },
      { id: "r2", type: "radio", configuration: { label: "Two answers", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }
    ]);
    await p.mount({ definition: def });
    await p.sleep(500);
    const r = JSON.parse(await p.ev(`JSON.stringify({ fields: ["r1", "c1", "r0", "r2"].map((id) => { const w = __probe.root.querySelector('.datum-live-field[data-component-id="' + id + '"]'); return { id, fallback: w.hasAttribute("data-fallback"), legend: (w.querySelector("legend")?.textContent ?? "").replace(/\\s+/g, " ").trim(), gcds: !!w.querySelector("gcds-radios, gcds-checkboxes") }; }), unsupported: __probe.form.unsupported() })`));
    const [r1, c1, r0, r2] = r.fields;
    const ok = r1.fallback && /Radio question/.test(r1.legend) && c1.fallback && /Checkbox question/.test(c1.legend) && r0.fallback && /Empty radio question/.test(r0.legend) && !r2.fallback && r2.gcds && ["r1", "c1", "r0"].every((id) => r.unsupported.some((u) => u.startsWith(`${id}:`)));
    say(ok ? "PASS" : "FAIL", "ONE-01", `radios with fewer than two options and checkboxes with one fall to Datum's adapter with their question, reported; two options stay gcds-radios: ${JSON.stringify(r)}`);
  });
  await probe("GRN", async (p) => {
    const def = form([{ id: "lines", type: "dataGrid", configuration: { label: "Items", initialRows: 2, minRows: 1, maxRows: 3, canReorder: true }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }] } }]);
    await p.mount({ definition: def });
    await p.sleep(400);
    const names = `JSON.stringify([...__probe.root.querySelectorAll("gcds-fieldset[legend^='Row']")].map((row) => ({ row: row.getAttribute("legend"), buttons: [...row.querySelectorAll("gcds-button[data-row-action]")].map((b) => ({ text: b.textContent.replace(/\\s+/g, " ").trim(), host: b.getAttribute("aria-label"), inner: b.shadowRoot?.querySelector("button")?.getAttribute("aria-label") ?? null })) })))`;
    await p.ev(`[...__probe.root.querySelectorAll('[data-row-action="down"]')][0].click()`);
    await p.sleep(600);
    const after = JSON.parse(await p.ev(names));
    const ok = after.length === 2 && after.every((row) => row.buttons.length === 3 && row.buttons.every((b) => b.text.endsWith(`, ${row.row}`) && b.host === null && b.inner === null));
    say(ok ? "PASS" : "FAIL", "GRN-01", `after Move down each row's buttons name their own row in slotted text, no aria-label to go stale: ${JSON.stringify(after)}`);
  });
  await probe("BSY", async (p) => {
    const def = form([{ id: "wiz", type: "steps", configuration: { label: "Application" }, children: { content: [
      { id: "s1", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
      { id: "s2", type: "step", configuration: { label: "Where" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } }
    ] } }]);
    await p.mount({ definition: def, stages: ["remote:name"] });
    await p.sleep(400);
    const inner = `__probe.root.querySelector("[data-step-next]")?.shadowRoot?.querySelector("button")?.getAttribute("aria-disabled") ?? null`;
    const idle = await p.ev(inner);
    await p.ev(`void __probe.runtime.validate()`);
    await p.sleep(600);
    const busy = await p.ev(inner);
    await p.ev(`window.__host.answerPending()`);
    await p.sleep(600);
    const done = await p.ev(inner);
    say(idle === null && busy === "true" && done === null ? "PASS" : "FAIL", "BSY-01", `Continue's own button is aria-disabled while the form is busy, and not before or after (idle ${idle}, busy ${busy}, done ${done})`);
  });
  await probe("DUP", async (p) => {
    const def = form([{ id: "nick", type: "text", configuration: { label: "Nickname", required: true } }, { id: "other", type: "text", configuration: { label: "Other", required: true } }]);
    await p.mount({ definition: def, stages: ["advice:error:nick"] });
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(800);
    const r = JSON.parse(await p.ev(`JSON.stringify({ errors: __probe.runtime.errors().filter((e) => (e.severity ?? "error") === "error").map((e) => e.componentId), links: JSON.parse(__probe.root.querySelector("gcds-error-summary")?.getAttribute("error-links") ?? "{}") })`));
    const nick = r.links["#nick"] ?? "";
    const ok = r.errors.filter((id) => id === "nick").length === 2 && nick.split("; ").length === 2 && /^Nickname - /.test(nick) && Object.keys(r.links).length === 2;
    say(ok ? "PASS" : "FAIL", "DUP-01", `two errors on one field share its summary link and both are said: ${JSON.stringify(r)}`);
  });
  await probe("OPT", async (p) => {
    const def = form([{ id: "d", type: "date", configuration: { label: "Date optional" } }, { id: "dr", type: "date", configuration: { label: "Date required", required: true } }]);
    await p.mount({ definition: def });
    await p.sleep(400);
    const legends = JSON.parse(await p.ev(`JSON.stringify(["d", "dr"].map((id) => (__probe.root.querySelector('.datum-live-field[data-component-id="' + id + '"] legend')?.textContent ?? "").replace(/\\s+/g, " ").trim()))`));
    say(legends[0] === "Date optional" && legends[1] === "Date required (required)" ? "PASS" : "FAIL", "OPT-01", `the tier-2 date marks required only, as GC Design System does: ${JSON.stringify(legends)}`);
  });
  await probe("CHK", async (p) => {
    const def = form([{ id: "agree", type: "checkbox", configuration: { label: "I agree", required: true, description: "Read the terms first." } }]);
    await p.mount({ definition: def });
    await p.sleep(500);
    const box = `${wrap("agree")}.querySelector("gcds-checkboxes")?.shadowRoot?.querySelector('input[type="checkbox"]')`;
    const drawn = JSON.parse(await p.ev(`JSON.stringify({ gcds: !!${wrap("agree")}.querySelector("gcds-checkboxes"), fallback: ${wrap("agree")}.hasAttribute("data-fallback"), id: ${box}?.id ?? null, label: ((l) => (l ? (l.shadowRoot ?? l).textContent.replace(/\\s+/g, " ").trim() : null))(${wrap("agree")}.querySelector("gcds-checkboxes")?.shadowRoot?.querySelector("gcds-label")), described: ${box}?.getAttribute("aria-describedby") ?? null, unsupported: __probe.form.unsupported() })`));
    await p.ev(`${box}.click()`);
    await p.sleep(300);
    const on = await p.ev(`__probe.runtime.state().values.agree ?? null`);
    await p.ev(`${box}.click()`);
    await p.sleep(300);
    const off = await p.ev(`__probe.runtime.state().values.agree ?? null`);
    await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
    await p.sleep(500);
    const invalid = await p.ev(`${box}?.getAttribute("aria-invalid") ?? null`);
    const ok = drawn.gcds && !drawn.fallback && drawn.id === "agree" && /^I agree/.test(drawn.label ?? "") && drawn.described && drawn.unsupported.length === 0 && on === true && off === false && invalid === "true";
    say(ok ? "PASS" : "FAIL", "CHK-01", `a lone checkbox is gcds-checkboxes with one option, stores a boolean, shows its required error: ${JSON.stringify({ ...drawn, on, off, invalid })}`);
  });

  // ── 11. a picture of everything, for the eye ──
  if (process.argv.includes("--shots")) {
    const dir = process.argv[process.argv.indexOf("--shots") + 1];
    mkdirSync(dir, { recursive: true });
    await probe("SHOT", async (p) => {
      const def = form([
        { id: "name", type: "text", configuration: { label: "Full name", description: "As on your passport.", required: true } },
        { id: "price", type: "text", configuration: { label: "Amount", prefix: "$", suffix: "CAD", description: "Affixed" } },
        { id: "bio", type: "textarea", configuration: { label: "About you", maxLength: 80, characterCount: true } },
        { id: "province", type: "select", configuration: { label: "Province", required: true, options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }] } },
        { id: "way", type: "radio", configuration: { label: "Preferred contact", required: true, options: [{ value: "email", label: "Email", description: "Within a day" }, { value: "phone", label: "Phone" }] } },
        { id: "chan", type: "checkboxes", configuration: { label: "Channels", options: [{ value: "email", label: "Email" }, { value: "post", label: "Post" }] } },
        { id: "start", type: "date", configuration: { label: "Start date (tier 2, Datum behaviour)", required: true, description: "For example 14 5 2026." } },
        { id: "end", type: "gcds-date", configuration: { label: "End date (tier 2, official component)", required: true } },
        { id: "grid", type: "dataGrid", configuration: { label: "Items", initialRows: 2, canReorder: true }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }] } },
        { id: "go", type: "button", configuration: { label: "Submit", action: "submit", variant: "primary" } }
      ], { kinds: { "gcds-date": "date" } });
      await p.mount({ definition: def, binding: null, stages: ["advice:warning:name"] });
      await p.ev(`__probe.runtime.validate().then(() => __probe.form.updated())`);
      await p.sleep(900);
      const shot = await p.page.screenshot({ type: "png", fullPage: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "gcds-all.png"), shot);
      say("NOTE", "SHOT", `wrote ${join(dir, "gcds-all.png")}`);
    });
  }
} finally {
  await browser.close();
  built.dispose();
}
const failed = results.filter((r) => r.status === "FAIL");
console.log(`${results.filter((r) => r.status === "GAP").length} contract gap(s) shown`);
console.log(`\n${results.filter((r) => r.status === "PASS").length} pass, ${failed.length} fail, ${results.filter((r) => r.status === "NOTE").length} note`);
process.exit(failed.length ? 1 : 0);
