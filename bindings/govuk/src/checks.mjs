// Browser checks for what the binding-check tester does not assert yet and the GOV.UK
// binding does (notices, the scoped script start and its cleanup, focus targets, grid labels).
// Real headless Chromium over the tester's own Playwright driver, host page and build (packages/conformance-suite/binding-check).
//   node bindings/govuk/src/checks.mjs [--port 5320] [--shots <dir>]
// Exit 0 when every check passes, 1 when one fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, FIXTURES, form, openCase, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "5320"));
const shots = option("--shots", undefined);
if (shots) mkdirSync(shots, { recursive: true });

const assetsDoc = JSON.parse(readFileSync(join(repo, "bindings", "govuk", "binding-check.json"), "utf8"));
const source = (item) => (typeof item === "string" ? { url: item } : item);
const assets = { stylesheets: assetsDoc.stylesheets.map(source), scripts: assetsDoc.scripts.map(source) };
const styleOnly = { stylesheets: assets.stylesheets };

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

const built = await buildRun({ binding: join(here, "index.ts"), name: "govuk-checks" });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "govuk")], builds: [built] });
const open = (extra = {}) => openCase(browser, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, assets, bodyClass: assetsDoc.bodyClass, ...extra });
const mountDefinition = (c, definition, options = {}) =>
  c.page.evaluate(`bc.mount(${JSON.stringify({ definition, assets: options.assets, expectFailure: options.expectFailure })})`);

try {
  // ── Notices: GOV.UK's warning text and inset text, never an error ────────────────────────────
  await check("notices: a warning and an info message draw as GOV.UK warning text and inset text, never as errors", async () => {
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
      return {
        warning: w.querySelector(".govuk-warning-text")?.textContent.replace(/\\s+/g, " ").trim() ?? null,
        inset: w.querySelector(".govuk-inset-text")?.textContent.replace(/\\s+/g, " ").trim() ?? null,
        errorMessage: !!w.querySelector(".govuk-error-message"),
        errorGroup: !!w.querySelector(".govuk-form-group--error"),
        inputError: input.classList.contains("govuk-input--error"),
        invalidHook: w.hasAttribute("data-invalid"),
        ariaInvalid: input.hasAttribute("aria-invalid"),
        describedBy: input.getAttribute("aria-describedby"),
        noticeResolves: !!notice && notice.contains(w.querySelector(".govuk-warning-text")),
        alertRole: !!notice?.closest("[role=alert]") || notice?.hasAttribute("role"),
        summary: !!bc.root().querySelector(".datum-live-summary")
      };
    })()`);
    assert(read.warning?.includes("That is short."), `no GOV.UK warning text (${read.warning})`);
    assert(read.warning.replace(/^!\s*/, "").startsWith("Warning"), `the warning is not led by its severity word: "${read.warning}"`);
    assert(read.inset?.includes("We keep it for a year."), `no GOV.UK inset text for the info message (${read.inset})`);
    assert(!read.errorMessage && !read.errorGroup && !read.inputError, "a notice is drawn with the error styling");
    assert(!read.invalidHook && !read.ariaInvalid, "a notice marks the field invalid");
    assert((read.describedBy ?? "").split(" ").includes("name__notice") && read.noticeResolves, `the input is not described by the notice (${read.describedBy})`);
    assert(!read.alertRole, "a notice is announced as an alert");
    assert(!read.summary, "a notice reached the error summary");
    if (shots) writeFileSync(join(shots, "notices.png"), Buffer.from(await c.shot(), "base64"));
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
        errors: [...w.querySelectorAll(".govuk-error-message")].map((e) => e.textContent.replace(/\\s+/g, " ").trim()),
        warnings: w.querySelectorAll(".govuk-warning-text").length,
        warningInError: !!w.querySelector(".govuk-error-message .govuk-warning-text, .govuk-warning-text.govuk-error-message"),
        links: [...bc.root().querySelectorAll(".datum-live-summary a")].map((a) => a.textContent.trim()),
        ariaInvalid: w.querySelector("input").hasAttribute("aria-invalid"),
        describedBy: w.querySelector("input").getAttribute("aria-describedby")
      };
    })()`);
    eq(read.errors.length, 1, "error lines");
    assert(read.errors[0].includes("Enter your name."), `error line is "${read.errors[0]}"`);
    eq(read.warnings, 1, "warning text blocks");
    assert(!read.warningInError, "the warning sits inside the error");
    eq(read.links.length, 1, "summary links (the warning is not one)");
    assert(read.describedBy.includes("name__notice") && read.describedBy.includes("name__error"), `describedBy is "${read.describedBy}"`);
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
        out[id] = { described: (fs.getAttribute("aria-describedby") ?? "").split(" ").includes(noticeId), resolves: !!w.querySelector("#" + noticeId), invalid: w.hasAttribute("data-invalid") || !!w.querySelector(".govuk-form-group--error") };
      }
      return out;
    })()`);
    for (const id of ["contact", "start"]) assert(read[id].described && read[id].resolves && !read[id].invalid, `${id}: ${JSON.stringify(read[id])}`);
    c.page.close();
  });

  // ── The scoped script start ───────────────────────────────────────────────────────────────────
  await check("scripts: initAll runs once per mount, scoped to the form element inside the shadow root, never on a redraw, and not after unmount", async () => {
    const c = await open();
    await c.mount("errors"); // loads the host's classic script
    await c.ev("bc.unmount()");
    await c.ev(`(() => {
      window.__init = [];
      const real = GOVUKFrontend.initAll;
      GOVUKFrontend.initAll = function (config) {
        window.__init.push({ element: config?.scope instanceof Element, shadow: config?.scope?.getRootNode() instanceof ShadowRoot, tag: config?.scope?.localName, root: config?.scope?.getRootNode()?.host?.dataset?.bcHost !== undefined });
        return real.call(this, config);
      };
    })()`);
    await c.mount("errors");
    eq(await c.ev("window.__init"), [{ element: true, shadow: true, tag: "form", root: true }], "initAll calls after mount");
    await c.ev(`bc.setValue("name", "Ada")`);
    await c.validate();
    await c.ev(`bc.setValue("bio", "A few words")`);
    await c.settle(300);
    eq(await c.ev("window.__init.length"), 1, "initAll calls after a redraw and a validation");
    const errors = (await c.ev("bc.events()")).filter((e) => e.type === "datum-binding-error");
    assert(errors.length === 0, `datum-binding-error: ${JSON.stringify(errors[0]?.detail)}`);
    await c.ev("bc.unmount()");
    await c.mount("errors");
    eq(await c.ev("window.__init.length"), 2, "initAll calls after a second mount");
    c.page.close();
  });

  await check("scripts: the cleanup removes every window and document listener GOV.UK's start added (accordion, password input), best effort", async () => {
    const c = await open();
    await c.mount("errors");
    const read = await c.page.evaluate(`(async () => {
      const mod = await import(${JSON.stringify(built.bindingUrl)});
      const fetchText = async (name) => (await fetch("/node_modules/govuk-frontend-6.6.0/dist/govuk/components/" + name + "/template-default.html")).text();
      const live = new Map();
      let id = 0;
      const ids = new WeakMap();
      const key = (target, type, fn) => (target === window ? "window" : "document") + ":" + type + ":" + (ids.get(fn) ?? (ids.set(fn, ++id), id));
      const patch = (target) => {
        const add = target.addEventListener, remove = target.removeEventListener;
        target.addEventListener = function (type, fn, opts) { live.set(key(target, type, fn), type); return add.call(this, type, fn, opts); };
        target.removeEventListener = function (type, fn, opts) { live.delete(key(target, type, fn)); return remove.call(this, type, fn, opts); };
        return () => { delete target.addEventListener; delete target.removeEventListener; };
      };
      const unpatch = [patch(window), patch(document)];
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const wrapper = document.createElement("form");
      wrapper.innerHTML = (await fetchText("accordion")) + (await fetchText("password-input"));
      shadow.append(wrapper);
      const started = mod.startScripts(wrapper, window.GOVUKFrontend);
      const during = [...live.values()].sort();
      const button = wrapper.querySelector(".govuk-accordion__section-button");
      const before = button.getAttribute("aria-expanded");
      button.click();
      const after = button.getAttribute("aria-expanded");
      started.cleanup();
      const left = [...live.values()].sort();
      unpatch.forEach((undo) => undo());
      host.remove();
      return { errors: started.errors, during, left, before, after, patched: Object.getOwnPropertyNames(window).includes("addEventListener") };
    })()`);
    eq(read.errors, [], "start errors");
    assert(read.during.length >= 2, `the start added ${read.during.length} global listeners; the test learns nothing`);
    eq(read.left, [], `global listeners left after cleanup (it added ${JSON.stringify(read.during)})`);
    assert(read.before !== read.after, `the accordion did not respond inside the shadow root (aria-expanded ${read.before} -> ${read.after})`);
    assert(!read.patched, "window.addEventListener is still shadowed after the start");
    c.page.close();
  });

  await check("scripts: without GOV.UK's body class nothing starts and selfCheck says why; the form still draws", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev("bc.unmount()");
    await c.ev(`(() => { window.__init = 0; const real = GOVUKFrontend.initAll; GOVUKFrontend.initAll = function (config) { window.__init += 1; return real.call(this, config); }; document.body.className = ""; })()`);
    await c.mount("errors", { keepConsole: true });
    eq(await c.ev("window.__init"), 0, "initAll calls");
    const problems = (await c.ev("bc.events()")).filter((e) => e.type === "datum-binding-error" && e.detail?.hook === "self-check");
    assert(problems.length === 1 && /govuk-frontend-supported/.test(JSON.stringify(problems[0].detail)), `self-check reports: ${JSON.stringify(problems.map((p) => p.detail))}`);
    assert((await c.ev(`bc.fieldCount("name")`)) === 1, "the form is not drawn");
    c.page.close();
  });

  await check("scripts: without the host's script file the baseline stands, with no error", async () => {
    const c = await open({ assets: styleOnly });
    await c.mount("errors", { assets: styleOnly, keepConsole: true });
    eq(await c.ev("typeof window.GOVUKFrontend"), "undefined", "GOVUKFrontend");
    const errors = (await c.ev("bc.events()")).filter((e) => e.type === "datum-binding-error");
    assert(errors.length === 0, `datum-binding-error: ${JSON.stringify(errors[0]?.detail)}`);
    assert((await c.ev(`bc.fieldCount("name")`)) === 1, "the form is not drawn");
    c.page.close();
  });

  await check("scripts: only the root-only component is opted in by markup (govuk-button); every scripted component that looks up through document stays unmarked", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const modules = await c.ev(`[...new Set([...bc.root().querySelectorAll("[data-module]")].map((e) => e.getAttribute("data-module")))]`);
    assert(modules.every((m) => m === "govuk-button"), `data-module values drawn: ${JSON.stringify(modules)}`);
    c.page.close();
  });

  // ── Focus: GOV.UK links an error to the first control ────────────────────────────────────────
  await check("focus: a summary link to a radio group lands on its first radio; to an empty date, on the day", async () => {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    const land = async (text) => {
      await c.click(`[...deepAll(bc.root().querySelector(".datum-live-summary"), "a[href]")].find((a) => textOf(a).includes(${JSON.stringify(text)}))`, `summary link "${text}"`);
      await c.sleep(300);
      return c.ev(`(() => { const a = deepActive(); return { tag: a?.localName, type: a?.type, part: a?.getAttribute("data-value-part"), first: a === bc.control("contact", 0, 0) }; })()`);
    };
    const radio = await land("Preferred contact method");
    assert(radio.type === "radio" && radio.first, `focus after the radio link: ${JSON.stringify(radio)}`);
    const date = await land("Start date");
    eq(date.part, "day", "date box focused");
    c.page.close();
  });

  await check("focus: a summary link to a date typed in part lands on the first box it lacks", async () => {
    const c = await open();
    await c.mount("errors");
    await c.ev(`bc.setControl("start", 0, "5")`);
    await c.validate();
    await c.click(`[...deepAll(bc.root().querySelector(".datum-live-summary"), "a[href]")].find((a) => textOf(a).includes("Start date"))`, "date link");
    await c.sleep(300);
    eq(await c.ev(`deepActive()?.getAttribute("data-value-part")`), "month", "date box focused");
    c.page.close();
  });

  // ── A data grid in GOV.UK has no table: a cell's label must stay ─────────────────────────────
  await check("grid: a grid the author set to the table layout still labels each cell (GOV.UK stacks rows)", async () => {
    const c = await open();
    await mountDefinition(
      c,
      form([{ id: "lines", type: "dataGrid", configuration: { label: "Items", layout: "table", initialRows: 2, minRows: 1, maxRows: 3 }, children: { content: [{ id: "item", type: "text", configuration: { label: "Item" } }, { id: "qty", type: "text", configuration: { label: "Quantity" } }] } }])
    );
    const read = await c.ev(`(() => [...bc.root().querySelectorAll(".datum-live-field[data-component-id=item] label")].map((l) => ({ text: l.textContent.trim(), hidden: l.classList.contains("govuk-visually-hidden") })))()`);
    eq(read.length, 2, "item labels");
    assert(read.every((l) => l.text.startsWith("Item") && !l.hidden), `labels: ${JSON.stringify(read)}`);
    if (shots) writeFileSync(join(shots, "grid.png"), Buffer.from(await c.shot(), "base64"));
    c.page.close();
  });

  // ── Read-only radios: GOV.UK's plain fieldset, the renderer's radiogroup while read-only ─────
  await check("read-only: GOV.UK's plain radios fieldset takes the radiogroup role and aria-readonly from the renderer while read-only, and only then", async () => {
    const c = await open();
    const options = [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }];
    await mountDefinition(c, form([{ id: "locked", type: "radio", configuration: { label: "Locked", readOnly: true, options } }, { id: "open", type: "radio", configuration: { label: "Open", options } }]));
    const read = await c.ev(`(() => Object.fromEntries(["locked", "open"].map((id) => { const f = bc.field(id).querySelector("fieldset"); return [id, { role: f.getAttribute("role"), readonly: f.getAttribute("aria-readonly"), name: f.querySelector("legend")?.textContent.trim() }]; })))()`);
    eq(read.locked, { role: "radiogroup", readonly: "true", name: "Locked (optional)" }, "read-only radios fieldset");
    eq(read.open, { role: null, readonly: null, name: "Open (optional)" }, "live radios fieldset");
    c.page.close();
  });

  // ── The summary: a message written for the error alone, a default one with its label ────────
  await check("summary: a message written for the error is listed alone, a default one with its field's label (entry.authored)", async () => {
    const c = await open();
    await mountDefinition(
      c,
      form([
        { id: "full", type: "text", configuration: { label: "Full name", required: true, messages: { required: "Enter your full name" } } },
        { id: "town", type: "text", configuration: { label: "Town", required: true } }
      ])
    );
    await c.validate();
    const links = await c.ev(`[...deepAll(bc.root().querySelector(".datum-live-summary"), "a[href]")].map((a) => textOf(a))`);
    eq(links, ["Enter your full name", "Town: This field is required"], "summary links");
    c.page.close();
  });

  // ── Heading levels: the summary and the journey page follow the form's place in the page ────
  await check("headings: the error summary's heading and a journey page's heading take the form's level (state.headingLevel), h1 by default for the page and h2 for the summary", async () => {
    const c = await open();
    const read = await c.page.evaluate(async ({ hostUrl, bindingUrl, journey, plain, level }) => {
      const dm = await import(hostUrl);
      const module = await import(bindingUrl);
      const binding = module.createBinding(dm.lit, dm.createDatumBinding());
      const drawn = async (definition, headingLevel) => {
        const journeys = definition.journey ? await dm.loadJourneyEngine() : undefined;
        const runtime = dm.createFormRuntime(definition, journeys ? { journeyEngine: journeys.engine } : undefined);
        if (definition.journey) runtime.startJourney(definition.journey.journeys[0].id);
        const host = document.createElement("div");
        document.body.append(host);
        const root = host.attachShadow({ mode: "open" });
        const form = dm.mountLive(root, {
          runtime, binding, datum: dm.createDatumBinding(),
          ...(headingLevel !== undefined ? { headingLevel } : {}),
          ...(journeys ? { journeyKit: journeys.renderKit } : {}),
          features: [...dm.createDatumFeatures({}, { summary: { headingLevel: () => headingLevel ?? 1 } }), ...(journeys ? [dm.createJourneyPageFeature()] : [])]
        });
        await form.ready;
        await form.updated();
        return { runtime, form, root, host };
      };
      const out = {};
      for (const [name, headingLevel] of [["default", undefined], ["level", level]]) {
        const a = await drawn(plain, headingLevel);
        await a.runtime.validate();
        await a.form.updated();
        out[`summary-${name}`] = a.root.querySelector(".govuk-error-summary__title")?.tagName ?? null;
        a.form.unmount();
        a.host.remove();
        const b = await drawn(journey, headingLevel);
        out[`page-${name}`] = b.root.querySelector("[data-journey-heading]")?.tagName ?? null;
        out[`page-${name}-focusable`] = b.root.querySelector("[data-journey-heading]")?.getAttribute("tabindex") ?? null;
        b.form.unmount();
        b.host.remove();
      }
      return out;
    }, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, journey: FIXTURES.journey.definition, plain: FIXTURES.errors.definition, level: 3 });
    eq(read["summary-default"], "H2", "default summary heading");
    eq(read["page-default"], "H1", "default page heading");
    eq(read["summary-level"], "H4", "summary heading under a form at level 3");
    eq(read["page-level"], "H3", "page heading under a form at level 3");
    eq(read["page-level-focusable"], "-1", "the page heading stays focusable by script");
    c.page.close();
  });

  // ── The worked-out line: GOV.UK hint text under the id the control is described by ──────────
  await check("worked out: a journey page's worked-out line is drawn as a hint, named by aria-describedby after the field's own hint", async () => {
    const c = await open();
    const path = (name) => ({ kind: "path", path: name });
    const definition = form(
      [{ id: "annual_income", type: "number", configuration: { label: "Annual income", description: "Before tax" } }],
      {
        journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "income", title: "Income", components: [
          { id: "m1", type: "number", configuration: { label: "Month one" } },
          { id: "m2", type: "number", configuration: { label: "Month two" } },
          { id: "income_total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "call", name: "sum", args: [path("m1"), path("m2")] }, label: "Annual income" } }
        ] }] }] }
      }
    );
    const read = await c.page.evaluate(async ({ hostUrl, bindingUrl, definition }) => {
      const dm = await import(hostUrl);
      const module = await import(bindingUrl);
      const binding = module.createBinding(dm.lit, dm.createDatumBinding());
      const journeys = await dm.loadJourneyEngine();
      const runtime = dm.createFormRuntime(definition, { journeyEngine: journeys.engine });
      runtime.startJourney("apply");
      runtime.setValue("@apply.m1", 1000);
      runtime.setValue("@apply.m2", 2500);
      const host = document.createElement("div");
      document.body.append(host);
      const root = host.attachShadow({ mode: "open" });
      const form = dm.mountLive(root, { runtime, binding, datum: dm.createDatumBinding(), journeyKit: journeys.renderKit, features: [...dm.createDatumFeatures(), dm.createJourneyPageFeature()] });
      await form.ready;
      await form.updated();
      const line = root.querySelector("[data-worked-out]");
      const wrapper = line?.closest(".datum-live-field");
      const input = wrapper?.querySelector("input");
      const result = {
        drawn: line !== null,
        hint: line?.classList.contains("govuk-hint") ?? false,
        insideAdapter: !!line && !!line.closest(".govuk-form-group"),
        describedBy: input?.getAttribute("aria-describedby") ?? null,
        id: line?.id ?? null,
        hintId: wrapper?.querySelector(".govuk-hint:not([data-worked-out])")?.id ?? null
      };
      form.unmount();
      host.remove();
      return result;
    }, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, definition });
    assert(read.drawn, "no worked-out line drawn");
    assert(read.hint && read.insideAdapter, `the line is not GOV.UK hint text inside the field's form group (${JSON.stringify(read)})`);
    const ids = (read.describedBy ?? "").split(" ");
    assert(ids.includes(read.id), `aria-describedby does not name the line (${read.describedBy})`);
    if (read.hintId !== null) assert(ids.indexOf(read.hintId) < ids.indexOf(read.id), `the hint does not come before the line (${read.describedBy})`);
    c.page.close();
  });

  // ── Check answers: GOV.UK's summary list and summary card, Change links through the renderer ──
  await check("review: a Check answers page is a govuk-summary-list per step (Change named in visually hidden text, a missing answer's Enter link, its row no-actions), a grid row a govuk-summary-card; Change opens the step and Continue comes back to the row; a row in error describes its link", async () => {
    const c = await open();
    const definition = form(
      [
        { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
        { id: "town", type: "text", configuration: { label: "Town" } },
        { id: "landlord", type: "text", configuration: { label: "Landlord's name", required: true } },
        { id: "people", type: "dataGrid", configuration: { label: "People", initialRows: 0, rowLabel: "Person {{n}}" }, collection: { collectionPath: "people" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
      ],
      { journey: { journeys: [{ id: "apply", name: "Apply", pages: [
        { id: "about", title: "About you", components: ["fullName", "town", "landlord", "people"] },
        { id: "check", kind: "review", title: "Check your answers" }
      ] }] } }
    );
    const read = await c.page.evaluate(async ({ hostUrl, bindingUrl, definition }) => {
      const dm = await import(hostUrl);
      const module = await import(bindingUrl);
      const binding = module.createBinding(dm.lit, dm.createDatumBinding());
      const journeys = await dm.loadJourneyEngine();
      const runtime = dm.createFormRuntime(definition, { journeyEngine: journeys.engine });
      runtime.startJourney("apply");
      runtime.setValue("fullName", "Ana Silva");
      runtime.setValue("people[0].name", "Leo Silva");
      await runtime.nextPage();
      const host = document.createElement("div");
      document.body.append(host);
      const root = host.attachShadow({ mode: "open" });
      const form = dm.mountLive(root, { runtime, binding, datum: dm.createDatumBinding(), journeyKit: journeys.renderKit, features: [...dm.createDatumFeatures(), dm.createJourneyPageFeature()] });
      await form.ready;
      await form.updated();
      const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      const rows = [...root.querySelectorAll(".govuk-summary-list > .govuk-summary-list__row")];
      const card = root.querySelector(".govuk-summary-card");
      const out = {
        datum: root.querySelector("[data-journey-review]") !== null,
        sectionHeading: (() => { const h = root.querySelector("h2.govuk-heading-m"); return h ? [h.tagName, text(h)] : null; })(),
        rows: rows.filter((row) => !row.closest(".govuk-summary-card")).map((row) => ({
          key: text(row.querySelector("dt.govuk-summary-list__key")),
          value: text(row.querySelector("dd.govuk-summary-list__value")),
          noActions: row.classList.contains("govuk-summary-list__row--no-actions"),
          link: text(row.querySelector("dd.govuk-summary-list__actions a.govuk-link")),
          hidden: text(row.querySelector("dd.govuk-summary-list__actions a .govuk-visually-hidden")),
          enter: text(row.querySelector("dd.govuk-summary-list__value a.govuk-link"))
        })),
        card: card ? {
          title: [card.querySelector(".govuk-summary-card__title-wrapper > .govuk-summary-card__title")?.tagName ?? null, text(card.querySelector(".govuk-summary-card__title"))],
          action: text(card.querySelector(".govuk-summary-card__actions > a.govuk-link")),
          hidden: text(card.querySelector(".govuk-summary-card__actions .govuk-visually-hidden")),
          rows: [...card.querySelectorAll(".govuk-summary-card__content .govuk-summary-list__row")].map((row) => text(row.querySelector("dt")) + "=" + text(row.querySelector("dd")))
        } : null,
        unsupported: form.unsupported().filter((u) => /review/.test(u))
      };
      // Change on the town row: its step opens, focus on its heading; Continue comes back to the row's link.
      rows[1].querySelector("dd.govuk-summary-list__actions a").click();
      await new Promise((r) => setTimeout(r, 50));
      await form.updated();
      await new Promise((r) => setTimeout(r, 50));
      out.changed = runtime.journeyView()?.pageId;
      out.headingFocused = root.activeElement?.hasAttribute("data-journey-heading") ?? false;
      root.querySelector("[data-journey-continue]").click();
      await new Promise((r) => setTimeout(r, 50));
      await form.updated();
      await new Promise((r) => setTimeout(r, 50));
      out.back = runtime.journeyView()?.pageId;
      out.focusOnRow = text(root.activeElement?.closest(".govuk-summary-list__row")?.querySelector("dt"));
      // An error on the missing answer (as a refused send leaves): its Enter link is described by the message.
      runtime.setErrors([{ code: "required", componentId: "landlord", path: "landlord", message: "Enter your landlord's name" }]);
      await new Promise((r) => setTimeout(r, 50));
      await form.updated();
      const enter = root.querySelector("#check__review-landlord dd.govuk-summary-list__value a.govuk-link");
      const describedBy = enter?.getAttribute("aria-describedby") ?? null;
      out.describedBy = [describedBy, describedBy ? root.getElementById(describedBy)?.className ?? null : null, root.querySelector("#check__review-fullName a")?.hasAttribute("aria-describedby") ?? null];
      form.unmount();
      host.remove();
      return out;
    }, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, definition });
    eq(read.datum, false, "Datum's own list drawn under the binding");
    eq(read.sectionHeading, ["H2", "About you"], "the step's heading");
    eq(read.rows, [
      { key: "Full name", value: "Ana Silva", noActions: false, link: "Change Full name", hidden: "Full name", enter: "" },
      { key: "Town", value: "Not provided", noActions: false, link: "Change Town", hidden: "Town", enter: "" },
      { key: "Landlord's name", value: "Enter Landlord's name", noActions: true, link: "", hidden: "", enter: "Enter Landlord's name" }
    ], "summary list rows");
    eq(read.card, { title: ["H3", "Person 1"], action: "Change (Person 1)", hidden: "(Person 1)", rows: ["Name=Leo Silva"] }, "summary card");
    eq(read.unsupported, [], "unsupported() entries for the review");
    eq([read.changed, read.headingFocused, read.back, read.focusOnRow], ["about", true, "check", "Town"], "Change and the way back");
    eq(read.describedBy, ["check__review-landlord__error", "govuk-error-message", false], "a row in error describes its link");
    c.page.close();
  });

  // ── The host's receipt: GOV.UK's notification banner, success variant, where focusNotice finds it ──
  await check("receipt: the host's receipt is a govuk-notification-banner (success: role alert, the kind's word as its title), focusable by the renderer, its echo hidden with no id", async () => {
    const c = await open();
    const read = await c.page.evaluate(async ({ hostUrl, bindingUrl, definition }) => {
      const dm = await import(hostUrl);
      const module = await import(bindingUrl);
      const binding = module.createBinding(dm.lit, dm.createDatumBinding());
      const out = {};
      for (const kind of ["success", "error"]) {
        const runtime = dm.createFormRuntime(definition);
        const host = document.createElement("div");
        document.body.append(host);
        const root = host.attachShadow({ mode: "open" });
        const notice = { kind, title: "Application sent", message: "We have sent you a confirmation email.", details: [{ label: "Reference", value: "HDJ2123F" }], placement: ["top", "bottom"] };
        const form = dm.mountLive(root, { runtime, binding, datum: dm.createDatumBinding(), features: [...dm.createDatumFeatures({}, { formNotices: { notice: () => notice, headingLevel: () => 1 } })] });
        await form.ready;
        await form.updated();
        const banners = [...root.querySelectorAll(".govuk-notification-banner")];
        const live = banners.find((b) => b.getAttribute("aria-hidden") !== "true");
        const echo = banners.find((b) => b.getAttribute("aria-hidden") === "true");
        const title = live?.querySelector(".govuk-notification-banner__title");
        out[kind] = {
          count: banners.length,
          success: live?.classList.contains("govuk-notification-banner--success") ?? null,
          role: live?.getAttribute("role") ?? null,
          tabindex: live?.getAttribute("tabindex") ?? null,
          region: live?.matches(".datum-form__notice[tabindex]") ?? false,
          labelled: !!title && live?.getAttribute("aria-labelledby") === title.id,
          title: title?.textContent.trim() ?? null,
          titleTag: title?.tagName ?? null,
          heading: live?.querySelector(".govuk-notification-banner__heading")?.textContent.trim() ?? null,
          details: live?.querySelectorAll(".govuk-summary-list__row").length ?? 0,
          echoIds: echo ? [echo, ...echo.querySelectorAll("[id]")].filter((el) => el.id).length : null,
          echoRole: echo?.getAttribute("role") ?? null,
          dataModule: banners.some((b) => b.hasAttribute("data-module")),
          unsupported: form.unsupported().filter((u) => /notice|receipt/.test(u))
        };
        form.unmount();
        host.remove();
      }
      return out;
    }, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, definition: FIXTURES.text.definition });
    const s = read.success;
    eq([s.count, s.success, s.role, s.tabindex, s.region, s.labelled, s.title, s.titleTag, s.heading, s.details, s.echoIds, s.echoRole, s.dataModule], [2, true, "alert", "-1", true, true, "Success", "H2", "Application sent", 1, 0, null, false], `success receipt ${JSON.stringify(s)}`);
    const e = read.error;
    assert(e.count === 2 && e.success === false && e.region && (e.role === "alert" || e.role === "region"), `error receipt ${JSON.stringify(e)}`);
    eq(s.unsupported, [], "unsupported() entries for the receipt");
    c.page.close();
  });

  // ── Looks: pictures for a human to read ──────────────────────────────────────────────────────
  if (shots) {
    const c = await open();
    await c.mount("errors");
    await c.validate();
    writeFileSync(join(shots, "errors.png"), Buffer.from(await c.shot(), "base64"));
    await c.page.close();
    for (const name of ["tabs", "grid", "journey", "text"]) {
      const d = await open();
      await d.mount(name);
      await d.settle(300);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(await d.shot(), "base64"));
      await d.page.close();
    }
    void FIXTURES;
  }
} finally {
  await browser.close();
  built.dispose();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length > 0 ? 1 : 0);
