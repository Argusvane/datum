// Browser checks for what the binding-check tester does not assert yet and the Bootstrap binding does:
// notices drawn as Bootstrap's alerts (never as errors), the DS script left out of the form's
// way, focus targets, heading levels, a table that keeps its labels, the steps indicator (the
// form-level hooks that the tester's host does not mount are in hooks-check.mjs). Real headless Chromium over the tester's own Playwright driver, host page and
// build (packages/conformance-suite/binding-check).
//   node bindings/bootstrap/src/checks.mjs [--port 5360] [--shots <dir>]
// Exit 0 when every check passes, 1 when one fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, FIXTURES, form, openCase, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "5360"));
const shots = option("--shots", undefined);
if (shots) mkdirSync(shots, { recursive: true });

const assetsDoc = JSON.parse(readFileSync(join(repo, "bindings", "bootstrap", "binding-check.json"), "utf8"));
const source = (item) => (typeof item === "string" ? { url: item } : item);
const assets = { stylesheets: assetsDoc.stylesheets.map(source) };
// Bootstrap's own script, as a host that loads it would: it listens on the document for data-bs-* attributes.
const withScript = { ...assets, scripts: [{ url: "/node_modules/bootstrap-5.3.8/dist/js/bootstrap.bundle.min.js", classic: true }] };

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

const built = await buildRun({ binding: join(here, "index.ts"), name: "bootstrap-checks" });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "bootstrap")], builds: [built] });
const open = (extra = {}) => openCase(browser, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, assets, ...extra });
const mountDefinition = (c, definition, options = {}) =>
  c.page.evaluate(`bc.mount(${JSON.stringify({ definition, assets: options.assets, expectFailure: options.expectFailure, locale: options.locale })})`);
const shot = async (c, name) => {
  if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from(await c.shot(), "base64"));
};

try {
  // ── Notices: Bootstrap's alerts, never an error ─────────────────────────────────────────────
  await check("notices: a warning and an info message draw as alert-warning / alert-info, never as errors", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.runtimeCall("setErrors", [
      { code: "short", componentId: "name", path: "name", severity: "warning", message: "That is short." },
      { code: "kept", componentId: "name", path: "name", severity: "info", message: "We keep it for a year." }
    ])`);
    await c.settle(300);
    const read = await c.ev(`(() => {
      const w = bc.field("name");
      const input = w.querySelector("input");
      const notice = w.querySelector("#name__notice");
      const text = (el) => el?.textContent.replace(/\\s+/g, " ").trim() ?? null;
      return {
        warning: text(w.querySelector(".alert-warning")),
        info: text(w.querySelector(".alert-info")),
        feedback: !!w.querySelector(".invalid-feedback"),
        inputInvalid: input.classList.contains("is-invalid"),
        invalidHook: w.hasAttribute("data-invalid"),
        ariaInvalid: input.hasAttribute("aria-invalid"),
        describedBy: input.getAttribute("aria-describedby"),
        noticeResolves: !!notice && notice.contains(w.querySelector(".alert-warning")),
        alertRole: [...(notice?.querySelectorAll("[role]") ?? [])].length > 0 || !!notice?.hasAttribute("role"),
        summary: !!bc.root().querySelector(".datum-bs-summary")
      };
    })()`);
    assert(read.warning?.startsWith("Warning") && read.warning.includes("That is short."), `warning alert: "${read.warning}"`);
    assert(read.info?.startsWith("Information") && read.info.includes("We keep it for a year."), `info alert: "${read.info}"`);
    assert(!read.feedback && !read.inputInvalid, "a notice is drawn with the error styling");
    assert(!read.invalidHook && !read.ariaInvalid, "a notice marks the field invalid");
    assert((read.describedBy ?? "").split(" ").includes("name__notice") && read.noticeResolves, `the input is not described by the notice (${read.describedBy})`);
    assert(!read.alertRole, "a notice is announced as an alert");
    assert(!read.summary, "a notice reached the error summary");
    await shot(c, "notices");
    c.page.close();
  });

  await check("notices: a blocking error and a warning on one field stay apart (one error line, one summary link)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.runtimeCall("setErrors", [
      { code: "required", componentId: "name", path: "name", message: "Enter your name." },
      { code: "short", componentId: "name", path: "name", severity: "warning", message: "That is short." }
    ])`);
    await c.settle(300);
    const read = await c.ev(`(() => {
      const w = bc.field("name");
      return {
        errors: [...w.querySelectorAll(".invalid-feedback")].map((e) => e.textContent.replace(/\\s+/g, " ").trim()),
        warnings: w.querySelectorAll(".alert-warning").length,
        warningInError: !!w.querySelector(".invalid-feedback .alert"),
        links: [...bc.root().querySelectorAll(".alert-danger a")].length,
        ariaInvalid: w.querySelector("input").getAttribute("aria-invalid"),
        invalidBox: w.querySelector("input").classList.contains("is-invalid"),
        describedBy: w.querySelector("input").getAttribute("aria-describedby")
      };
    })()`);
    eq(read.errors, ["Enter your name."], "error lines");
    eq(read.warnings, 1, "warning alerts");
    assert(!read.warningInError, "the warning sits inside the error");
    eq(read.links, 1, "summary links (the warning is not one)");
    eq(read.ariaInvalid, "true", "aria-invalid");
    assert(read.invalidBox, "the box is not marked is-invalid");
    assert(read.describedBy.includes("name__notice") && read.describedBy.includes("name__error"), `describedBy is "${read.describedBy}"`);
    await shot(c, "error-and-warning");
    c.page.close();
  });

  await check("notices: groups (radios, date) carry the notice on the fieldset that describes them", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.runtimeCall("setErrors", [
      { code: "w1", componentId: "contact", path: "contact", severity: "warning", message: "Phone is slow." },
      { code: "w2", componentId: "start", path: "start", severity: "info", message: "Mind the weekend." }
    ])`);
    await c.settle(300);
    const read = await c.ev(`(() => {
      const out = {};
      for (const id of ["contact", "start"]) {
        const w = bc.field(id);
        const fs = w.querySelector("fieldset");
        const noticeId = id + "__notice";
        out[id] = { described: (fs.getAttribute("aria-describedby") ?? "").split(" ").includes(noticeId), resolves: !!w.querySelector("#" + noticeId), invalid: w.hasAttribute("data-invalid") || !!w.querySelector(".is-invalid") };
      }
      return out;
    })()`);
    for (const id of ["contact", "start"]) assert(read[id].described && read[id].resolves && !read[id].invalid, `${id}: ${JSON.stringify(read[id])}`);
    c.page.close();
  });

  // ── The DS script: none is started, and Bootstrap's own, loaded by the host, leaves the form alone ─
  await check("script: with Bootstrap's own script on the page the form draws as it does without it, and the form carries nothing for it to act on", async () => {
    const c = await open({ assets: withScript });
    await mountDefinition(
      c,
      form([
        { id: "bio", type: "textarea", configuration: { label: "About you", maxLength: 20, characterCount: true } },
        { id: "tip", type: "text", configuration: { label: "Tip", tooltip: "Some help" } },
        { id: "sections", type: "tabs", configuration: { label: "Sections", tabs: [{ id: "a", label: "First" }, { id: "b", label: "Second" }] }, children: { a: [{ id: "one", type: "text", configuration: { label: "One" } }], b: [{ id: "two", type: "text", configuration: { label: "Two" } }] } }
      ]),
      { assets: withScript }
    );
    await c.settle(400);
    assert(await c.ev("typeof window.bootstrap === 'object' && typeof window.bootstrap.Tab === 'function'"), "Bootstrap's script did not load (window.bootstrap)");
    eq(await c.ev(`(() => bc.root().querySelector("[data-count-status]")?.textContent.trim())()`), "20 characters left", "count status before typing");
    await c.typeInto("bio", "Hello");
    eq(await c.ev(`(() => bc.root().querySelector("[data-count-status]")?.textContent.trim())()`), "15 characters left", "count status after typing");
    // The tab strip is the renderer's: a click shows the other panel; Bootstrap's script (document-level, data-bs-toggle) has nothing to pick up.
    await c.click(`bc.root().querySelectorAll("[role=tab]")[1]`, "second tab");
    await c.settle(300);
    const tabs = await c.ev(`(() => ({ selected: [...bc.root().querySelectorAll("[role=tab]")].map((t) => t.getAttribute("aria-selected")), shown: [...bc.root().querySelectorAll("[role=tabpanel]")].map((p) => !p.hidden), active: [...bc.root().querySelectorAll(".nav-link.active")].length, panelsActive: [...bc.root().querySelectorAll(".tab-pane.active")].length }))()`);
    eq(tabs.selected, ["false", "true"], "tab selection");
    eq(tabs.shown, [false, true], "panels shown");
    eq(tabs.active, 1, "active nav links");
    eq(tabs.panelsActive, 1, "active panels");
    const markers = await c.ev(`({ bs: bc.root().querySelectorAll("[data-bs-toggle], [data-bs-target], [data-bs-dismiss], [data-bs-title]").length, popper: document.body.querySelectorAll(".tooltip, .popover, .modal-backdrop").length, bodyClass: document.body.className })`);
    eq(markers.bs, 0, "data-bs-* attributes drawn");
    eq(markers.popper, 0, "tooltip, popover or backdrop nodes added to the page");
    const errors = (await c.ev("bc.events()")).filter((e) => e.type === "datum-binding-error");
    assert(errors.length === 0, `datum-binding-error: ${JSON.stringify(errors[0]?.detail)}`);
    await shot(c, "with-script");
    c.page.close();
  });

  await check("script: the binding asks for no script (no connect hook, no data-bs-* drawn)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const info = await c.ev(`({ markers: bc.root().querySelectorAll("[data-bs-toggle], [data-bs-target], [data-bs-dismiss]").length, bootstrapGlobal: typeof window.bootstrap })`);
    eq(info, { markers: 0, bootstrapGlobal: "undefined" }, "script markers");
    c.page.close();
  });

  // ── Focus: a summary link goes to the first control ──────────────────────────────────────────
  await check("focus: a summary link to a radio group lands on its first radio; to an empty date, on the day", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const land = async (text) => {
      await c.click(`[...deepAll(bc.root().querySelector(".alert-danger"), "a[href]")].find((a) => textOf(a).includes(${JSON.stringify(text)}))`, `summary link "${text}"`);
      await c.sleep(300);
      return c.ev(`(() => { const a = deepActive(); return { tag: a?.localName, type: a?.type, part: a?.getAttribute("data-value-part"), first: a === bc.control("contact", 0, 0) }; })()`);
    };
    const radio = await land("Preferred contact method");
    assert(radio.type === "radio" && radio.first, `focus after the radio link: ${JSON.stringify(radio)}`);
    const date = await land("Start date");
    eq(date.part, "day", "date box focused");
    await shot(c, "errors");
    c.page.close();
  });

  await check("focus: a summary link to a date typed in part lands on the first box it lacks (month after the day)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.setControl("start", 0, "5", 0)`);
    await c.validate();
    await c.click(`[...deepAll(bc.root().querySelector(".alert-danger"), "a[href]")].find((a) => textOf(a).includes("Start date"))`, "date link");
    await c.sleep(300);
    const part = await c.ev(`deepActive()?.getAttribute("data-value-part")`);
    assert(part === "month" || part === "year", `a box the date still lacks is focused (${part})`);
    c.page.close();
  });

  // ── A table keeps its labels: the table layout and the stacked cards ─────────────────────────
  await check("grid: the table layout hides the cells' labels (the column heading names them), the stacked layout keeps them in cards", async () => {
    const c = await open();
    const grid = (layout) => form([{ id: "lines", type: "dataGrid", configuration: { label: "Items", layout, initialRows: 2, minRows: 1, maxRows: 3 }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }, { id: "qty", type: "text", configuration: { label: "Quantity" } }] } }]);
    await mountDefinition(c, grid("table"));
    const table = await c.ev(`(() => ({ heads: [...bc.root().querySelectorAll("thead th")].map((th) => th.textContent.trim()), wrapped: !!bc.root().querySelector(".table-responsive > table.table"), labels: [...bc.root().querySelectorAll(".datum-live-field[data-component-id=item] label")].map((l) => ({ text: l.textContent.trim(), hidden: l.classList.contains("visually-hidden") })) }))()`);
    assert(table.heads.includes("Item") && table.heads.includes("Quantity"), `column headings: ${JSON.stringify(table.heads)}`);
    assert(table.wrapped, "the table is not a table in table-responsive");
    assert(table.labels.length === 2 && table.labels.every((l) => l.hidden), `table labels: ${JSON.stringify(table.labels)}`);
    await shot(c, "grid-table");
    await mountDefinition(c, grid("stacked"));
    const stacked = await c.ev(`(() => ({ cards: bc.root().querySelectorAll("fieldset.card.card-body").length, labels: [...bc.root().querySelectorAll(".datum-live-field[data-component-id=item] label")].map((l) => ({ text: l.textContent.trim(), hidden: l.classList.contains("visually-hidden") })) }))()`);
    eq(stacked.cards, 2, "cards");
    assert(stacked.labels.length === 2 && stacked.labels.every((l) => !l.hidden), `stacked labels: ${JSON.stringify(stacked.labels)}`);
    await shot(c, "grid-stacked");
    c.page.close();
  });

  // ── Tabs: Bootstrap's nav-tabs ───────────────────────────────────────────────────────────────
  await check("tabs: the strip is a nav-tabs of role=tab nav-links, the shown one active; a tab with an error carries a badge", async () => {
    const c = await open();
    await c.mount("tabs");
    await c.validate();
    const read = await c.ev(`(() => ({
      strip: !!bc.root().querySelector("ul.nav.nav-tabs[role=tablist]"),
      tabs: [...bc.root().querySelectorAll("[role=tab]")].map((t) => ({ text: t.textContent.trim().replace(/\\s+/g, " "), selected: t.getAttribute("aria-selected"), active: t.classList.contains("active"), badge: !!t.querySelector(".badge.text-bg-danger") }))
    }))()`);
    assert(read.strip && read.tabs.length >= 2, `strip: ${JSON.stringify(read)}`);
    assert(read.tabs.every((t) => (t.selected === "true") === t.active), `active means selected: ${JSON.stringify(read.tabs)}`);
    assert(read.tabs.some((t) => t.badge), `a tab with an error carries the badge: ${JSON.stringify(read.tabs)}`);
    await shot(c, "tabs");
    c.page.close();
  });

  // ── Heading levels: the summary and a journey page follow the form's place in the page ──────
  await check("headings: the error summary heads at h2 and a journey page at h1 by default (the form's level)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    eq(await c.ev(`bc.root().querySelector(".alert-danger .alert-heading")?.localName`), "h2", "summary heading");
    await c.ev("bc.unmount()");
    await c.mount("journey");
    eq(await c.ev(`bc.root().querySelector("[data-journey-heading]")?.localName`), "h1", "journey page heading");
    await shot(c, "journey");
    c.page.close();
  });

  // ── The steps container: nav-pills ───────────────────────────────────────────────────────────
  await check("steps: a steps container draws nav-pills (the shown step active), one heading per panel, and Continue moves on", async () => {
    const c = await open();
    await mountDefinition(
      c,
      form([
        {
          id: "wiz",
          type: "steps",
          configuration: {},
          children: {
            content: [
              { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
              { id: "where", type: "step", configuration: { label: "Where" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } }
            ]
          }
        }
      ])
    );
    const probe = await c.ev(`(() => ({
      pills: bc.root().querySelectorAll("ol.nav-pills .nav-link").length,
      current: bc.root().querySelector("ol.nav-pills .nav-link.active")?.textContent.trim().replace(/\\s+/g, " ") ?? null,
      currentMark: bc.root().querySelector("ol.nav-pills .nav-link.active")?.getAttribute("aria-current"),
      shownPanels: [...bc.root().querySelectorAll("[data-step-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-step-panel"))
    }))()`);
    eq(probe.pills, 2, "pills");
    assert(/About you/.test(probe.current ?? ""), `current pill: ${probe.current}`);
    eq(probe.currentMark, "step", "aria-current");
    eq(probe.shownPanels, ["about"], "shown panels");
    await shot(c, "steps");
    await c.click(`bc.root().querySelector("[data-step-next]")`, "Continue");
    await c.settle(300);
    const after = await c.ev(`(() => ({ shown: [...bc.root().querySelectorAll("[data-step-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-step-panel")), current: bc.root().querySelector("ol.nav-pills .nav-link.active")?.textContent.trim().replace(/\\s+/g, " ") }))()`);
    eq(after.shown, ["where"], "shown panel after Continue");
    assert(/Where/.test(after.current ?? ""), `current pill after Continue: ${after.current}`);
    await shot(c, "steps-2");
    c.page.close();
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nbootstrap checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
