// Browser checks for what the binding-check tester does not assert yet and the USWDS binding does:
// notices drawn as USWDS's slim alerts (never as errors), the DS script left out of the form's
// way, focus targets, heading levels, a table that keeps its labels, the steps indicator (the
// form-level hooks that the tester's host does not mount are in hooks-check.mjs). Real headless Chromium over the tester's own Playwright driver, host page and
// build (packages/conformance-suite/binding-check).
//   node bindings/uswds/src/checks.mjs [--port 5350] [--shots <dir>]
// Exit 0 when every check passes, 1 when one fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, FIXTURES, form, openCase, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "5350"));
const shots = option("--shots", undefined);
if (shots) mkdirSync(shots, { recursive: true });

const assetsDoc = JSON.parse(readFileSync(join(repo, "bindings", "uswds", "binding-check.json"), "utf8"));
const source = (item) => (typeof item === "string" ? { url: item } : item);
const assets = { stylesheets: assetsDoc.stylesheets.map(source) };
// USWDS's own script, as a host that loads it would: it starts itself on document.body.
const withScript = { ...assets, scripts: [{ url: "/node_modules/uswds-3.14.0/dist/js/uswds.min.js", classic: true }] };

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

const built = await buildRun({ binding: join(here, "index.ts"), name: "uswds-checks" });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "uswds")], builds: [built] });
const open = (extra = {}) => openCase(browser, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, assets, ...extra });
const mountDefinition = (c, definition, options = {}) =>
  c.page.evaluate(`bc.mount(${JSON.stringify({ definition, assets: options.assets, expectFailure: options.expectFailure, locale: options.locale })})`);
const shot = async (c, name) => {
  if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from(await c.shot(), "base64"));
};

try {
  // ── Notices: USWDS's slim alerts, never an error ─────────────────────────────────────────────
  await check("notices: a warning and an info message draw as slim usa-alerts, never as errors", async () => {
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
        warning: text(w.querySelector(".usa-alert--warning.usa-alert--slim")),
        info: text(w.querySelector(".usa-alert--info.usa-alert--slim")),
        errorMessage: !!w.querySelector(".usa-error-message"),
        errorGroup: !!w.querySelector(".usa-form-group--error"),
        inputError: input.classList.contains("usa-input--error"),
        invalidHook: w.hasAttribute("data-invalid"),
        ariaInvalid: input.hasAttribute("aria-invalid"),
        describedBy: input.getAttribute("aria-describedby"),
        noticeResolves: !!notice && notice.contains(w.querySelector(".usa-alert--warning")),
        alertRole: !!notice?.closest("[role=alert]") || [...(notice?.querySelectorAll("[role]") ?? [])].length > 0 || notice?.hasAttribute("role"),
        summary: !!bc.root().querySelector(".datum-live-summary, .datum-usa-summary")
      };
    })()`);
    assert(read.warning?.startsWith("Warning") && read.warning.includes("That is short."), `warning alert: "${read.warning}"`);
    assert(read.info?.startsWith("Information") && read.info.includes("We keep it for a year."), `info alert: "${read.info}"`);
    assert(!read.errorMessage && !read.errorGroup && !read.inputError, "a notice is drawn with the error styling");
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
        errors: [...w.querySelectorAll(".usa-error-message")].map((e) => e.textContent.replace(/\\s+/g, " ").trim()),
        warnings: w.querySelectorAll(".usa-alert--warning").length,
        warningInError: !!w.querySelector(".usa-error-message .usa-alert"),
        links: [...bc.root().querySelectorAll(".usa-alert--error a")].length,
        ariaInvalid: w.querySelector("input").getAttribute("aria-invalid"),
        describedBy: w.querySelector("input").getAttribute("aria-describedby")
      };
    })()`);
    eq(read.errors, ["Enter your name."], "error lines");
    eq(read.warnings, 1, "warning alerts");
    assert(!read.warningInError, "the warning sits inside the error");
    eq(read.links, 1, "summary links (the warning is not one)");
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
        out[id] = { described: (fs.getAttribute("aria-describedby") ?? "").split(" ").includes(noticeId), resolves: !!w.querySelector("#" + noticeId), invalid: w.hasAttribute("data-invalid") || !!w.querySelector(".usa-form-group--error") };
      }
      return out;
    })()`);
    for (const id of ["contact", "start"]) assert(read[id].described && read[id].resolves && !read[id].invalid, `${id}: ${JSON.stringify(read[id])}`);
    c.page.close();
  });

  // ── The DS script: none is started, and USWDS's own, loaded by the host, leaves the form alone ─
  await check("script: with USWDS's own script on the page the form draws as it does without it; the script finds nothing in the shadow root to enhance", async () => {
    const c = await open({ assets: withScript });
    await mountDefinition(
      c,
      form([{ id: "bio", type: "textarea", configuration: { label: "About you", maxLength: 20, characterCount: true } }, { id: "tip", type: "text", configuration: { label: "Tip", tooltip: "Some help" } }]),
      { assets: withScript }
    );
    await c.settle(400);
    const before = await c.ev(`(() => { const w = bc.field("bio"); return { status: w.querySelector(".usa-character-count__status")?.textContent.trim(), enhanced: w.querySelector("textarea").hasAttribute("data-enhanced"), srStatus: !!w.querySelector(".usa-character-count__sr-status") }; })()`);
    assert(await c.ev("window.uswdsPresent === true"), "USWDS's script did not load (window.uswdsPresent)");
    eq(before.status, "20 characters allowed", "count status before typing");
    await c.typeInto("bio", "Hello");
    const after = await c.ev(`(() => { const w = bc.field("bio"); return { status: w.querySelector(".usa-character-count__status")?.textContent.trim(), enhanced: w.querySelector("textarea").hasAttribute("data-enhanced"), srStatus: !!w.querySelector(".usa-character-count__sr-status"), body: document.body.querySelectorAll(".usa-tooltip__body").length }; })()`);
    eq(after.status, "15 characters left", "count status after typing");
    assert(!before.enhanced && !after.enhanced && !after.srStatus, "USWDS's script enhanced the character count inside the shadow root");
    eq(after.body, 0, "tooltip bodies added to the page");
    const errors = (await c.ev("bc.events()")).filter((e) => e.type === "datum-binding-error");
    assert(errors.length === 0, `datum-binding-error: ${JSON.stringify(errors[0]?.detail)}`);
    c.page.close();
  });

  await check("script: the binding asks for no script (no connect hook, no data-module drawn)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const info = await c.ev(`({ modules: bc.root().querySelectorAll("[data-module]").length, usaGlobal: typeof window.uswdsPresent })`);
    eq(info, { modules: 0, usaGlobal: "undefined" }, "script markers");
    c.page.close();
  });

  // ── Focus: USWDS links an error to the first control ─────────────────────────────────────────
  await check("focus: a summary link to a radio group lands on its first radio; to an empty date, on the month", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const land = async (text) => {
      await c.click(`[...deepAll(bc.root().querySelector(".usa-alert--error"), "a[href]")].find((a) => textOf(a).includes(${JSON.stringify(text)}))`, `summary link "${text}"`);
      await c.sleep(300);
      return c.ev(`(() => { const a = deepActive(); return { tag: a?.localName, type: a?.type, part: a?.getAttribute("data-value-part"), first: a === bc.control("contact", 0, 0) }; })()`);
    };
    const radio = await land("Preferred contact method");
    assert(radio.type === "radio" && radio.first, `focus after the radio link: ${JSON.stringify(radio)}`);
    const date = await land("Start date");
    eq(date.part, "month", "date box focused");
    await shot(c, "errors");
    c.page.close();
  });

  await check("focus: a summary link to a radio group with a checked radio lands on the checked one", async () => {
    const c = await open();
    await c.mount("errors", { preset: { contact: "phone" }, stages: ["advice:error:contact"] });
    await c.validate();
    await c.click(`[...deepAll(bc.root().querySelector(".usa-alert--error"), "a[href]")].find((a) => textOf(a).includes("Preferred contact method"))`, "summary link to the radios");
    await c.sleep(300);
    const landed = await c.ev(`(() => { const a = deepActive(); return { type: a?.type ?? null, value: a?.value ?? null, checked: a?.checked ?? null }; })()`);
    eq(landed, { type: "radio", value: "phone", checked: true }, "radio focused after the link");
    c.page.close();
  });

  await check("date: the memorable date's boxes write no maxlength (the contract: an over-long part is raised by validation, never cut off)", async () => {
    const c = await open();
    await c.mount("errors");
    const capped = await c.ev(`[...bc.field("start").querySelectorAll("[data-value-part]")].filter((box) => box.hasAttribute("maxlength")).map((box) => box.getAttribute("data-value-part"))`);
    eq(capped, [], "date part boxes with a maxlength");
    c.page.close();
  });

  await check("errors: every field's usa-error-message carries role=alert, as USWDS's templates write it", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const read = await c.ev(`(() => ["name", "bio", "province", "contact", "channels", "start"].map((id) => { const m = bc.field(id)?.querySelector(".usa-error-message"); return id + ":" + (m ? m.getAttribute("role") : "none"); }))()`);
    eq(read, ["name:alert", "bio:alert", "province:alert", "contact:alert", "channels:alert", "start:alert"], "role of each field's error message");
    c.page.close();
  });

  await check("focus: a summary link to a date typed in part lands on the first box it lacks (day after the month)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.setControl("start", 0, "5", 0)`);
    await c.validate();
    await c.click(`[...deepAll(bc.root().querySelector(".usa-alert--error"), "a[href]")].find((a) => textOf(a).includes("Start date"))`, "date link");
    await c.sleep(300);
    const part = await c.ev(`deepActive()?.getAttribute("data-value-part")`);
    assert(part === "day" || part === "year", `a box the date still lacks is focused (${part})`);
    c.page.close();
  });

  // ── A table keeps its labels: stacked rows and the table layout ──────────────────────────────
  await check("grid: the table layout hides the cells' labels (the column heading names them), the stacked layout keeps them", async () => {
    const c = await open();
    const grid = (layout) => form([{ id: "lines", type: "dataGrid", configuration: { label: "Items", layout, initialRows: 2, minRows: 1, maxRows: 3 }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }, { id: "qty", type: "text", configuration: { label: "Quantity" } }] } }]);
    await mountDefinition(c, grid("table"));
    const table = await c.ev(`(() => ({ heads: [...bc.root().querySelectorAll("thead th")].map((th) => th.textContent.trim()), labels: [...bc.root().querySelectorAll(".datum-live-field[data-component-id=item] label")].map((l) => ({ text: l.textContent.trim(), hidden: l.classList.contains("usa-sr-only") })) }))()`);
    assert(table.heads.includes("Item") && table.heads.includes("Quantity"), `column headings: ${JSON.stringify(table.heads)}`);
    assert(table.labels.length === 2 && table.labels.every((l) => l.hidden), `table labels: ${JSON.stringify(table.labels)}`);
    await shot(c, "grid-table");
    await mountDefinition(c, grid("stacked"));
    const stacked = await c.ev(`(() => [...bc.root().querySelectorAll(".datum-live-field[data-component-id=item] label")].map((l) => ({ text: l.textContent.trim(), hidden: l.classList.contains("usa-sr-only") })))()`);
    assert(stacked.length === 2 && stacked.every((l) => !l.hidden), `stacked labels: ${JSON.stringify(stacked)}`);
    await shot(c, "grid-stacked");
    c.page.close();
  });

  // ── Tabs: USWDS has none, so the strip is its segmented button group ─────────────────────────
  await check("tabs: the strip is a usa-button-group--segmented of role=tab buttons, the shown one filled, the others outlined; a tab with an error says so", async () => {
    const c = await open();
    await c.mount("tabs");
    const read = await c.ev(`(() => ({
      group: !!bc.root().querySelector("ul.usa-button-group--segmented[role=tablist]"),
      tabs: [...bc.root().querySelectorAll("[role=tab]")].map((t) => ({ text: t.textContent.trim(), selected: t.getAttribute("aria-selected"), outline: t.classList.contains("usa-button--outline") }))
    }))()`);
    assert(read.group && read.tabs.length >= 2, `strip: ${JSON.stringify(read)}`);
    assert(read.tabs.every((t) => (t.selected === "true") === !t.outline), `filled means selected: ${JSON.stringify(read.tabs)}`);
    await shot(c, "tabs");
    c.page.close();
  });

  // ── Heading levels: the summary and a journey page follow the form's place in the page ──────
  await check("headings: the error summary heads at h2 and a journey page at h1 by default (the form's level)", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    eq(await c.ev(`bc.root().querySelector(".usa-alert--error .usa-alert__heading")?.localName`), "h2", "summary heading");
    await c.ev("bc.unmount()");
    await c.mount("journey");
    eq(await c.ev(`bc.root().querySelector("[data-journey-heading]")?.localName`), "h1", "journey page heading");
    await shot(c, "journey");
    c.page.close();
  });

  // ── The steps container: usa-step-indicator ──────────────────────────────────────────────────
  await check("steps: a steps container draws usa-step-indicator (segments, counter), one heading per panel, and Continue moves on", async () => {
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
      segments: bc.root().querySelectorAll(".usa-step-indicator__segment").length,
      current: bc.root().querySelector(".usa-step-indicator__segment--current")?.textContent.trim().replace(/\\s+/g, " ") ?? null,
      counter: bc.root().querySelector(".usa-step-indicator__heading-counter")?.textContent.replace(/\\s+/g, " ").trim() ?? null,
      shownPanels: [...bc.root().querySelectorAll("[data-step-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-step-panel"))
    }))()`);
    eq(probe.segments, 2, "segments");
    assert(/About you/.test(probe.current ?? ""), `current segment: ${probe.current}`);
    assert(/1/.test(probe.counter ?? "") && /2/.test(probe.counter ?? ""), `counter: ${probe.counter}`);
    eq(probe.shownPanels, ["about"], "shown panels");
    await shot(c, "steps");
    await c.click(`bc.root().querySelector("[data-step-next]")`, "Continue");
    await c.settle(300);
    const after = await c.ev(`(() => ({ shown: [...bc.root().querySelectorAll("[data-step-panel]")].filter((p) => !p.hidden).map((p) => p.getAttribute("data-step-panel")), current: bc.root().querySelector(".usa-step-indicator__segment--current")?.textContent.trim().replace(/\\s+/g, " "), focused: deepActive()?.id }))()`);
    eq(after.shown, ["where"], "shown panel after Continue");
    assert(/Where/.test(after.current ?? ""), `current segment after Continue: ${after.current}`);
    await shot(c, "steps-2");
    c.page.close();
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nuswds checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
