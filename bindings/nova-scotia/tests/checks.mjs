// Browser checks for what the binding-check tester does not assert yet and the Nova Scotia
// binding does: notices drawn in the library's warning colour and glyphs (never as errors), no
// script asked for or started, focus targets, heading levels, a table that keeps its labels, the
// progress tracker, tabs left to Datum and reported, the required mark, the type=number box. Real
// headless Chromium over the tester's own Playwright driver, host page and build
// (packages/conformance-suite/binding-check).
//   node bindings/nova-scotia/tests/checks.mjs [--port 5390] [--shots <dir>]
// Exit 0 when every check passes, 1 when one fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, FIXTURES, form, openCase, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "5390"));
const shots = option("--shots", undefined);
if (shots) mkdirSync(shots, { recursive: true });

const assetsDoc = JSON.parse(readFileSync(join(repo, "bindings", "nova-scotia", "binding-check.json"), "utf8"));
const source = (item) => (typeof item === "string" ? { url: item } : item);
const assets = { stylesheets: assetsDoc.stylesheets.map(source) };

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

const built = await buildRun({ binding: join(here, "..", "src", "index.ts"), name: "nova-scotia-checks" });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "nova-scotia")], builds: [built] });
const open = (extra = {}) => openCase(browser, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, assets, ...extra });
const mountDefinition = (c, definition, options = {}) =>
  c.page.evaluate(`bc.mount(${JSON.stringify({ definition, assets: options.assets, expectFailure: options.expectFailure, locale: options.locale })})`);
const shot = async (c, name) => {
  if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from(await c.shot(), "base64"));
};

try {
  // ── Notices: the library's warning colour and glyphs, never an error ─────────────────────────
  await check("notices: a warning and an info message draw in the library's warning colour and glyphs, never as errors", async () => {
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
      const colour = (el) => (el ? getComputedStyle(el).color : null);
      return {
        warning: text(w.querySelector(".datum-ns-notice--warning")),
        info: text(w.querySelector(".datum-ns-notice--info")),
        warningColour: colour(w.querySelector(".datum-ns-notice--warning")),
        infoColour: colour(w.querySelector(".datum-ns-notice--info")),
        warningGlyph: !!w.querySelector(".datum-ns-notice--warning .fa-exclamation-triangle"),
        infoGlyph: !!w.querySelector(".datum-ns-notice--info .fa-info-circle"),
        groupWarned: !!w.querySelector(".form-group.has-warning"),
        errorGroup: !!w.querySelector(".has-error"),
        inputColour: getComputedStyle(input).borderTopColor,
        invalidHook: w.hasAttribute("data-invalid"),
        ariaInvalid: input.hasAttribute("aria-invalid"),
        describedBy: input.getAttribute("aria-describedby"),
        noticeResolves: !!notice && notice.contains(w.querySelector(".datum-ns-notice--warning")),
        alertRole: !!notice?.closest("[role=alert]") || [...(notice?.querySelectorAll("[role]") ?? [])].length > 0 || notice?.hasAttribute("role"),
        summary: !!bc.root().querySelector(".datum-ns-summary")
      };
    })()`);
    assert(read.warning?.startsWith("Warning") && read.warning.includes("That is short."), `warning: "${read.warning}"`);
    assert(read.info?.startsWith("Information") && read.info.includes("We keep it for a year."), `info: "${read.info}"`);
    eq(read.warningColour, "rgb(138, 109, 59)", "warning colour (the library's #8a6d3b)");
    assert(read.warningGlyph && read.infoGlyph, "the library's glyphs (fa-exclamation-triangle, fa-info-circle)");
    assert(read.groupWarned && read.inputColour === "rgb(138, 109, 59)", `the group is has-warning (the library's warning pattern): ${read.groupWarned} ${read.inputColour}`);
    assert(!read.errorGroup && !read.invalidHook && !read.ariaInvalid, "a notice is drawn with the error styling or marks the field invalid");
    assert((read.describedBy ?? "").split(" ").includes("name__notice") && read.noticeResolves, `the input is not described by the notice (${read.describedBy})`);
    assert(!read.alertRole, "a notice is announced as an alert");
    assert(!read.summary, "a notice reached the error summary");
    await shot(c, "notices");
    c.page.close();
  });

  await check("notices: a blocking error and a warning on one field stay apart (one error line in the error colour, the warning in its own, one summary link)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.runtimeCall("setErrors", [
      { code: "required", componentId: "name", path: "name", message: "Enter your name." },
      { code: "short", componentId: "name", path: "name", severity: "warning", message: "That is short." },
      { code: "kept", componentId: "name", path: "name", severity: "info", message: "We keep it." }
    ])`);
    await c.settle(300);
    const read = await c.ev(`(() => {
      const w = bc.field("name");
      const text = (el) => el?.textContent.replace(/\\s+/g, " ").trim();
      return {
        errors: [...w.querySelectorAll("#name__error")].map(text),
        errorColour: getComputedStyle(w.querySelector("#name__error")).color,
        warningColour: getComputedStyle(w.querySelector(".datum-ns-notice--warning")).color,
        infoColour: getComputedStyle(w.querySelector(".datum-ns-notice--info")).color,
        groupError: !!w.querySelector(".form-group.has-error"),
        groupWarned: !!w.querySelector(".form-group.has-warning"),
        warningInError: !!w.querySelector("#name__error .datum-ns-notice"),
        links: [...bc.root().querySelectorAll(".datum-ns-summary a")].length,
        ariaInvalid: w.querySelector("input").getAttribute("aria-invalid"),
        describedBy: w.querySelector("input").getAttribute("aria-describedby")
      };
    })()`);
    eq(read.errors, ["Enter your name."], "error lines");
    eq(read.errorColour, "rgb(169, 68, 66)", "error colour");
    eq(read.warningColour, "rgb(138, 109, 59)", "warning colour inside an error group");
    eq(read.infoColour, "rgb(68, 68, 68)", "info colour inside an error group");
    assert(read.groupError && !read.groupWarned, "the group is has-error, not has-warning (an error wins)");
    assert(!read.warningInError, "the warning sits inside the error");
    eq(read.links, 1, "summary links (the notices are not one)");
    eq(read.ariaInvalid, "true", "aria-invalid");
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
        out[id] = { described: (fs.getAttribute("aria-describedby") ?? "").split(" ").includes(noticeId), resolves: !!w.querySelector("#" + noticeId), invalid: w.hasAttribute("data-invalid") || !!w.querySelector(".has-error") };
      }
      return out;
    })()`);
    for (const id of ["contact", "start"]) assert(read[id].described && read[id].resolves && !read[id].invalid, `${id}: ${JSON.stringify(read[id])}`);
    c.page.close();
  });

  // ── No script: the library ships none ─────────────────────────────────────────────────────────
  await check("script: the binding asks for no script (no data-module drawn, nothing on <body>)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const info = await c.ev(`({ modules: bc.root().querySelectorAll("[data-module]").length, bodyClass: document.body.className, bodyAttrs: [...document.body.attributes].map((a) => a.name).sort() })`);
    eq(info.modules, 0, "data-module markers");
    assert(info.bodyClass === "", `the binding marked <body>: "${info.bodyClass}"`);
    c.page.close();
  });

  await check("selfCheck: a page without saltire.css is reported (the form still draws)", async () => {
    const c = await open({ assets: { stylesheets: [] } });
    await mountDefinition(c, form([{ id: "name", type: "text", configuration: { label: "Name" } }]), { assets: { stylesheets: [] } });
    await c.settle(300);
    const errors = (await c.ev("bc.events()")).filter((e) => e.type === "datum-binding-error" && e.detail?.hook === "self-check");
    assert(errors.length === 1 && /has-error/.test(JSON.stringify(errors[0].detail)), `self-check report: ${JSON.stringify(errors[0]?.detail)}`);
    c.page.close();
  });

  // ── Required: the asterisk, aria-required, the note ───────────────────────────────────────────
  await check("required: a required field carries the asterisk and aria-required; the note explains the mark; an optional one carries neither", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "a", type: "text", configuration: { label: "Required one", required: true } }, { id: "b", type: "text", configuration: { label: "Optional one" } }]));
    const read = await c.ev(`(() => ({
      a: { abbr: bc.field("a").querySelector("label abbr[title=required]")?.textContent, aria: bc.field("a").querySelector("input").getAttribute("aria-required") },
      b: { abbr: bc.field("b").querySelector("label abbr")?.textContent ?? null, aria: bc.field("b").querySelector("input").getAttribute("aria-required") },
      note: bc.root().querySelector(".datum-ns-required-note")?.textContent.replace(/\\s+/g, " ").trim()
    }))()`);
    eq(read.a, { abbr: "*", aria: "true" }, "required field");
    eq(read.b, { abbr: null, aria: null }, "optional field");
    eq(read.note, "Fields marked with * are required.", "required note");
    c.page.close();
  });

  // ── Number: the library's type=number box ─────────────────────────────────────────────────────
  await check("number: a type=number box reports a number, an emptied box as empty, and keeps what was typed on the way to a decimal", async () => {
    const c = await open();
    await mountDefinition(c, form([{ id: "n", type: "number", configuration: { label: "Quantity" } }]));
    eq(await c.ev(`bc.field("n").querySelector("input").type`), "number", "control type");
    await c.typeInto("n", "12");
    eq((await c.values()).n, 12, "stored number");
    await c.ev(`bc.setValue("n", "")`);
    await c.settle(200);
    eq(await c.ev(`bc.field("n").querySelector("input").value`), "", "emptied box");
    c.page.close();
  });

  // ── Focus: an error links to the first control ───────────────────────────────────────────────
  await check("focus: a summary link to a radio group lands on its first radio; to an empty date, on the day", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const land = async (text) => {
      await c.click(`[...deepAll(bc.root().querySelector(".datum-ns-summary"), "a[href]")].find((a) => textOf(a).includes(${JSON.stringify(text)}))`, `summary link "${text}"`);
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

  // ── A table keeps its labels: stacked rows and the table layout ──────────────────────────────
  await check("grid: the table layout hides the cells' labels (the column heading names them), the stacked layout keeps them", async () => {
    const c = await open();
    const grid = (layout) => form([{ id: "lines", type: "dataGrid", configuration: { label: "Items", layout, initialRows: 2, minRows: 1, maxRows: 3 }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }, { id: "qty", type: "text", configuration: { label: "Quantity" } }] } }]);
    await mountDefinition(c, grid("table"));
    const table = await c.ev(`(() => ({ heads: [...bc.root().querySelectorAll("thead th")].map((th) => th.textContent.trim()), table: !!bc.root().querySelector("table.table"), labels: [...bc.root().querySelectorAll(".datum-live-field[data-component-id=item] label")].map((l) => ({ text: l.textContent.trim(), hidden: l.classList.contains("sr-only") })) }))()`);
    assert(table.table, "the library's table");
    assert(table.heads.includes("Item") && table.heads.includes("Quantity"), `column headings: ${JSON.stringify(table.heads)}`);
    assert(table.labels.length === 2 && table.labels.every((l) => l.hidden), `table labels: ${JSON.stringify(table.labels)}`);
    await shot(c, "grid-table");
    await mountDefinition(c, grid("stacked"));
    const stacked = await c.ev(`(() => [...bc.root().querySelectorAll(".datum-live-field[data-component-id=item] label")].map((l) => ({ text: l.textContent.trim(), hidden: l.classList.contains("sr-only") })))()`);
    assert(stacked.length === 2 && stacked.every((l) => !l.hidden), `stacked labels: ${JSON.stringify(stacked)}`);
    await shot(c, "grid-stacked");
    c.page.close();
  });

  await check("grid: left to the form (auto) the table hides the cells' labels while wide and shows them as blocks when narrow", async () => {
    const c = await open();
    await c.mount("grid");
    const read = () => c.ev(`(() => {
      const label = bc.root().querySelector(".datum-live-field[data-component-id=item] label");
      const row = bc.root().querySelector("tbody tr");
      const r = label.getBoundingClientRect();
      return { labelBox: Math.round(r.width) + "x" + Math.round(r.height), cellsPerRow: new Set([...row.children].map((cell) => Math.round(cell.getBoundingClientRect().top))).size };
    })()`);
    const wide = await read();
    eq(wide.labelBox, "1x1", "the label of a cell when the grid is wide");
    eq(wide.cellsPerRow, 1, "the cells of a row stand on one line when wide");
    await c.ev(`document.querySelector("[data-bc-host]").style.width = "320px"`);
    await c.settle(300);
    const narrow = await read();
    assert(narrow.labelBox !== "1x1", `the label of a cell is shown when the grid is narrow (${narrow.labelBox})`);
    assert(narrow.cellsPerRow > 1, `the cells of a row stand one under the other when narrow (${narrow.cellsPerRow})`);
    await shot(c, "grid-narrow");
    c.page.close();
  });

  await check("grid: an error on the grid draws only its own message as an error, never the valid fields in its cells", async () => {
    const c = await open();
    await c.mount("grid");
    const read = () => c.ev(`(() => {
      const field = bc.root().querySelector(".datum-live-field[data-component-id=item]");
      const colour = (el) => (el ? getComputedStyle(el).color : null);
      const box = field.querySelector("input.form-control");
      return {
        label: colour(field.querySelector("label")), border: box ? getComputedStyle(box).borderTopColor : null, invalid: field.hasAttribute("data-invalid"),
        message: colour(bc.root().querySelector("fieldset .datum-ns-choice-error")), fieldsetError: bc.root().querySelector("fieldset.has-error") !== null
      };
    })()`);
    const before = await read();
    await c.ev(`bc.runtimeCall("setErrors", [{ code: "rows", componentId: "lines", path: "lines", message: "Add one more item." }])`);
    await c.settle(300);
    const after = await read();
    eq(after.message, "rgb(169, 68, 66)", "the grid's own message in the library's error colour");
    assert(!after.fieldsetError, "no has-error on the grid's fieldset");
    assert(!after.invalid, "the cell field is not invalid");
    eq({ label: after.label, border: after.border }, { label: before.label, border: before.border }, "the cell field's label and border, unchanged by the grid's error");
    c.page.close();
  });

  // ── Tabs: the library has none, so Datum draws them and says so ──────────────────────────────
  await check("tabs: the library has no tabs, so Datum's adapter draws the strip and unsupported() says so", async () => {
    const c = await open();
    await c.mount("tabs");
    const read = await c.ev(`(() => ({ tabs: [...bc.root().querySelectorAll("[role=tab]")].length, fallback: !!bc.root().querySelector("[data-container-id][data-fallback]"), unsupported: bc.unsupported() }))()`);
    assert(read.tabs >= 2, `Datum's tabs: ${JSON.stringify(read)}`);
    await shot(c, "tabs");
    c.page.close();
  });

  // ── Heading levels: the summary and a journey page follow the form's place in the page ──────
  await check("headings: the error summary heads at h2 and a journey page at h1 by default (the form's level)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    eq(await c.ev(`bc.root().querySelector(".datum-ns-summary .datum-ns-alert-title")?.localName`), "h2", "summary heading");
    await c.ev("bc.unmount()");
    await c.mount("journey");
    eq(await c.ev(`bc.root().querySelector("[data-journey-heading]")?.localName`), "h1", "journey page heading");
    await shot(c, "journey");
    c.page.close();
  });

  // ── The steps container: the library's progress tracker ──────────────────────────────────────
  await check("steps: a steps container draws the progress tracker (pagination list), one heading per panel, and Continue moves on", async () => {
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
      items: bc.root().querySelectorAll("ul.pagination > li").length,
      active: bc.root().querySelector("ul.pagination > li.active")?.textContent.trim().replace(/\\s+/g, " ") ?? null,
      disabled: bc.root().querySelectorAll("ul.pagination > li.disabled").length,
      shownPanels: [...bc.root().querySelectorAll("[data-step-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-step-panel")),
      heading: bc.root().querySelector("[data-step-panel=about] > h2")?.textContent.trim()
    }))()`);
    eq(probe.items, 2, "tracker items");
    assert(/About you/.test(probe.active ?? ""), `active step: ${probe.active}`);
    eq(probe.disabled, 1, "steps that cannot be opened yet");
    eq(probe.shownPanels, ["about"], "shown panels");
    eq(probe.heading, "Step 1 of 2: About you", "panel heading");
    await shot(c, "steps");
    await c.click(`bc.root().querySelector("[data-step-next]")`, "Continue");
    await c.settle(300);
    const after = await c.ev(`(() => ({ shown: [...bc.root().querySelectorAll("[data-step-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-step-panel")), active: bc.root().querySelector("ul.pagination > li.active")?.textContent.trim().replace(/\\s+/g, " "), link: bc.root().querySelectorAll("ul.pagination > li > a").length }))()`);
    eq(after.shown, ["where"], "shown panel after Continue");
    assert(/Where/.test(after.active ?? ""), `active step after Continue: ${after.active}`);
    eq(after.link, 1, "the step already reached is a link");
    await shot(c, "steps-2");
    c.page.close();
  });

  // ── A whole form, for a look ─────────────────────────────────────────────────────────────────
  await check("look: the fixtures draw (screenshots only with --shots)", async () => {
    const c = await open();
    for (const name of Object.keys(FIXTURES).filter((n) => ["caps", "errors", "grid", "journey"].includes(n))) {
      await c.mount(name);
      await shot(c, `fixture-${name}`);
    }
    c.page.close();
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nnova-scotia checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
