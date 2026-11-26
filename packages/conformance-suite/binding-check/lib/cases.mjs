// The case catalogue. Every case checks Datum's integration only: what Datum or the binding
// writes, passes in or reads back. The design system's own quality (its contrast, its
// semantics, its keyboard model beyond what Datum asks of it) is never judged here.
// A case: { id, group, title, needs?, cap?, pending?, run(c) }. `needs` is a list of component
// types the binding must draw; `cap` is [type, capability] that must not be answered "none".
// `pending` is the reason a case is listed but cannot run yet.
//
// The cases run against the engine renderer (render/live mountLive). They read what it writes:
// the DOM contract (`data-component-id`, `data-container-id`, `data-value-path`), the state hooks
// (`data-kind`, `data-required`, `data-invalid`, `data-readonly`, `data-disabled`,
// `data-over-limit`), the roles and ids of the drawn form, and the renderer's events
// (`datum-binding-error`, `datum-form-action`). A capability answer is `drawn`, `degraded` or `none`.
// A field's controls are found by native tag (input, textarea, select) or by role (`role` radio,
// checkbox or combobox, or a form-associated custom element with a `checked` property; page.js
// controlsOf), and a button by `button` or `[role=button]`: a design system that draws its own
// controls as custom elements is driven and read the way a native one is.

import { FIXTURES } from "../fixtures/index.mjs";

export const GROUPS = {
  MNT: "mount, assets, selfCheck, unmount",
  VAL: "value round trip",
  ERR: "errors drawn",
  NTC: "notices and pending checks",
  SUM: "error summary",
  ANN: "count announcer",
  RO: "read-only and disabled",
  DAT: "date parts",
  GRD: "data grid",
  TAB: "tabs",
  JNY: "journey",
  I18N: "languages",
  HK: "state hooks and references",
  CAP: "capability answers",
  KIND: "tier-2 kinds fall back to their base",
  CNV: "builder canvas mode",
  PRT: "print theme",
  PDF: "PDF suggestion"
};

const cases = [];
const def = (id, title, options, run) => cases.push({ id, group: id.split("-")[0], title, ...options, run });

const ROOT = `bc.root()`;
const summaryEl = `(${ROOT}.querySelector(".datum-live-summary") ?? document.createElement("i"))`;
const SUMMARY_LINKS = `bc.summaryLinks()`;
const added = (after, before) => {
  const rest = [...before];
  const out = [];
  for (const text of after) {
    const index = rest.indexOf(text);
    if (index >= 0) rest.splice(index, 1);
    else out.push(text);
  }
  return out;
};
const firstDuplicate = (list) => list.find((text, index) => list.indexOf(text) !== index);

// ── MNT ───────────────────────────────────────────────────────────────────────────────────
def("MNT-01", "mounts, draws every field and reports ready", { needs: ["text"] }, async (c) => {
  // mount() resolves once the renderer's `ready` has: it rejects when the form could not be drawn.
  await c.mount("text");
  const error = (await c.ev("bc.events()")).find((e) => e.type === "datum-binding-error");
  c.assert(!error, `datum-binding-error ${error?.detail?.hook}: ${error?.detail?.message}`);
  const ready = await c.ev("bc.readiness()");
  c.eq(ready.forms, 1, "forms drawn in the root");
  c.assert(!ready.settling, "the first draw is still hidden (data-settling) after ready");
  c.assert(ready.alert === null, `the renderer drew an alert: "${ready.alert}"`);
  for (const [id, label] of [["fullName", "Full name"], ["nickname", "Nickname"], ["amount", "Amount requested"], ["notes", "Notes"], ["city", "City"]]) {
    const text = await c.ev(`bc.fieldText(${JSON.stringify(id)})`);
    c.assert(text !== null, `no field wrapper for "${id}"`);
    c.assert(text.includes(label), `the field "${id}" does not show its label "${label}"`);
  }
});
def("MNT-02", "design-system stylesheets stay in the form's shadow root", { needs: ["text"] }, async (c) => {
  await c.mount("text");
  const leak = await c.ev("bc.docLeak()");
  c.eq(leak.now.links, leak.before.links, "stylesheet links added to the page");
  c.eq(leak.now.styles, leak.before.styles, "style elements added to the page");
  c.eq(leak.now.adopted, leak.before.adopted, "stylesheets adopted by the document");
  const wanted = (c.assets.stylesheets ?? []).length;
  c.assert(leak.shadowSheets >= wanted, `the shadow root adopted ${leak.shadowSheets} stylesheets, the host gave ${wanted}`);
});
def("MNT-04", "the binding's selfCheck finds what it relies on", { needs: ["text"] }, async (c) => {
  if (!c.info.designSystem.selfCheck) c.skip("the binding declares no selfCheck()");
  await c.mount("text");
  const bad = (await c.ev("bc.events()")).filter((e) => e.type === "datum-binding-error" && e.detail?.hook === "self-check");
  c.assert(bad.length === 0, bad.map((e) => e.detail.message).join(" | "));
});
def("MNT-05", "unmount leaves nothing drawn, focused or listening", { needs: ["text"] }, async (c) => {
  await c.mount("text");
  await c.focus("fullName");
  const body = (await c.ev("bc.docSnapshot()")).bodyChildren;
  await c.ev("bc.unmount()");
  const draws = await c.ev("bc.draws()");
  const events = (await c.ev("bc.events()")).length;
  await c.ev(`bc.setValue("fullName", "after unmount")`);
  await c.sleep(400);
  c.eq(await c.ev("bc.rootChildren()"), 0, "children left in the shadow root");
  c.eq(await c.ev("bc.draws()"), draws, "draws after unmount");
  c.eq((await c.ev("bc.events()")).length, events, "events after unmount");
  c.eq((await c.ev("bc.docSnapshot()")).bodyChildren, body, "elements added to the page's body");
  c.assert(await c.ev("document.activeElement === document.body || !bc.root().contains(document.activeElement)"), "focus is still inside the unmounted form");
  const leak = await c.ev("bc.docLeak()");
  c.eq(leak.shadowSheets, 0, "stylesheets still adopted by the shadow root");
});
def("MNT-06", "mount logs no console errors", { needs: ["text"] }, async (c) => {
  await c.mount("text", { keepConsole: true });
  const log = await c.takeConsole();
  const errors = log.filter((l) => l.type !== "warn");
  c.assert(errors.length === 0, errors.map((l) => l.text.slice(0, 160)).join(" | "));
});

def("MNT-07", "an asset that cannot be fetched draws a failure in place of the form", { needs: ["text"] }, async (c) => {
  const outcome = await c.mount("text", { assets: { stylesheets: [{ url: "/checks/binding-check/no-such-stylesheet.css" }] }, expectFailure: true });
  c.assert(outcome?.failed, "ready resolved although a stylesheet could not be fetched");
  const ready = await c.ev("bc.readiness()");
  c.assert(ready.alert, "no alert is drawn where the form should be");
  c.eq(await c.ev(`bc.fieldCount("fullName")`), 0, "fields drawn beside the failure");
  const error = (await c.ev("bc.events()")).find((e) => e.type === "datum-binding-error" && e.detail?.hook === "assets");
  c.assert(error, "no datum-binding-error with hook \"assets\" was dispatched");
});

// ── VAL ───────────────────────────────────────────────────────────────────────────────────
def("VAL-01", "text: typing is stored once the field is left", { needs: ["text"] }, async (c) => {
  await c.mount("text");
  await c.typeInto("fullName", "Ada Lovelace");
  c.eq((await c.values()).fullName, "Ada Lovelace", "stored fullName");
});
def("VAL-02", "text: a value written by a rule shows in the control", { needs: ["text"] }, async (c) => {
  await c.mount("text");
  await c.ev(`bc.setValue("fullName", "Grace Hopper")`);
  await c.settle();
  const info = await c.ev(`bc.controlInfo("fullName")`);
  c.assert(info.length > 0, "no control under the field");
  c.eq(info[0].value, "Grace Hopper", "control value");
});
def("VAL-03", "text: a value being typed survives another field's redraw", { needs: ["text"] }, async (c) => {
  await c.mount("text");
  await c.typeInto("nickname", "abc", { commit: false });
  await c.ev(`bc.setValue("fullName", "Someone")`);
  await c.settle();
  c.eq((await c.ev(`bc.controlInfo("nickname")`))[0]?.value, "abc", "nickname control after the redraw");
  c.eq((await c.active()).field?.id, "nickname", "field holding focus after the redraw");
});
def("VAL-04", "textarea: typing is stored, a written value shows", { needs: ["textarea"] }, async (c) => {
  await c.mount("textarea");
  await c.typeInto("bio", "Line one");
  c.eq((await c.values()).bio, "Line one", "stored bio");
  await c.ev(`bc.setValue("bio", "Written by a rule")`);
  await c.settle();
  c.eq((await c.ev(`bc.controlInfo("bio")`))[0]?.value, "Written by a rule", "textarea value");
});
def("VAL-05", "select: a choice is stored, a written value is selected", { needs: ["select"] }, async (c) => {
  await c.mount("select");
  const info = await c.ev(`bc.controlInfo("province")`);
  if (!info.some((i) => i.tag === "select")) c.skip("no native <select> under the field: a custom listbox the generic driver cannot operate");
  c.assert(await c.ev(`bc.setControl("province", ${info.findIndex((i) => i.tag === "select")}, "QC")`), "no option QC");
  await c.settle();
  c.eq((await c.values()).province, "QC", "stored province");
  await c.ev(`bc.setValue("province", "BC")`);
  await c.settle();
  c.eq((await c.ev(`bc.controlInfo("province")`)).find((i) => i.tag === "select")?.value, "BC", "select value");
});
def("VAL-06", "radio: a choice is stored, a written value is checked", { needs: ["radio"] }, async (c) => {
  await c.mount("radio");
  const radio = (value) => `bc.optionControl("contact", ${JSON.stringify(value)})`;
  await c.clickEl(radio("phone"), 'radio "phone"');
  await c.settle();
  c.eq((await c.values()).contact, "phone", "stored contact");
  await c.ev(`bc.setValue("contact", "mail")`);
  await c.settle();
  const checked = (await c.ev(`bc.controlInfo("contact")`)).filter((i) => i.checked).map((i) => i.value);
  c.eq(checked, ["mail"], "checked radios");
});
def("VAL-07", "checkboxes: choices are stored as booleans, written ones are checked", { needs: ["checkboxes"] }, async (c) => {
  await c.mount("checkboxes");
  const box = (value) => `bc.optionControl("channels", ${JSON.stringify(value)})`;
  await c.clickEl(box("phone"), 'checkbox "phone"');
  await c.settle();
  await c.clickEl(box("email"), 'checkbox "email"');
  await c.settle();
  const stored = (await c.values()).channels;
  c.assert(stored?.phone === true && stored?.email === true, `stored channels ${JSON.stringify(stored)}`);
  await c.ev(`bc.setValue("channels", { email: false, phone: false, post: true })`);
  await c.settle();
  const checked = (await c.ev(`bc.controlInfo("channels")`)).filter((i) => i.checked).map((i) => i.value);
  c.eq(checked, ["post"], "checked boxes");
});

// ── ERR ───────────────────────────────────────────────────────────────────────────────────
const errorCase = (id, type, fieldId, label) =>
  def(id, `${label}: a required error is drawn once in its field`, { needs: [type] }, async (c) => {
    await c.mount("errors");
    const before = await c.ev(`bc.fieldTextNodes(${JSON.stringify(fieldId)}, 0, true)`);
    await c.validate();
    const raised = (await c.errors()).filter((e) => e.componentId === fieldId);
    c.assert(raised.length > 0, "Datum raised no error for the field (fixture or runtime problem)");
    const after = await c.ev(`bc.fieldTextNodes(${JSON.stringify(fieldId)}, 0, true)`);
    const fresh = added(after, before);
    c.assert(fresh.length > 0, `no visible error text appeared in the field (Datum raised "${raised[0].code}")`);
    const twice = firstDuplicate(fresh);
    c.assert(!twice, `the same error text is drawn twice in the field: "${twice}"`);
    // The error describes the control or its group: a screen reader on the control hears it.
    const described = (await c.ev(`bc.descriptions(${JSON.stringify(fieldId)})`)) ?? [];
    const unsaid = fresh.filter((text) => !described.some((d) => d.text.includes(text)));
    c.assert(unsaid.length === 0, `error text that describes neither the control nor its group: ${JSON.stringify(unsaid)} (descriptions: ${JSON.stringify(described.map((d) => d.id ?? d.text.slice(0, 40)))})`);
  });
errorCase("ERR-01", "text", "name", "text");
errorCase("ERR-02", "textarea", "bio", "textarea");
errorCase("ERR-03", "select", "province", "select");
errorCase("ERR-04", "radio", "contact", "radio");
errorCase("ERR-05", "checkboxes", "channels", "checkboxes");
errorCase("ERR-06", "date", "start", "date");
def("ERR-07", "text: the error is withdrawn when the answer is corrected and the form validated again", { needs: ["text"] }, async (c) => {
  await c.mount("errors");
  const before = await c.ev(`bc.fieldTextNodes("name", 0, true)`);
  await c.validate();
  const fresh = added(await c.ev(`bc.fieldTextNodes("name", 0, true)`), before);
  c.assert(fresh.length > 0, "no error text appeared (see ERR-01)");
  await c.typeInto("name", "Ada");
  await c.validate();
  const now = await c.ev(`bc.fieldTextNodes("name", 0, true)`);
  const left = fresh.filter((t) => now.includes(t));
  c.assert(left.length === 0, `the error text is still drawn after a valid answer and a new validation: "${left[0]}"`);
});

// ── NTC ───────────────────────────────────────────────────────────────────────────────────
// A warning or an info is advice, never an error: drawn in the field, describing the control or its
// group, with no invalid mark, no alert and no summary entry (the fixture's own stages raise them).
const noticeCase = (id, type, fieldId) =>
  def(id, `${type}: a notice describes the control and is drawn as no error`, { needs: [type], cap: [type, "notice"] }, async (c) => {
    await c.mount("advice");
    await c.validate();
    const needle = `NOTICE ${fieldId}`;
    const raised = (await c.errors()).filter((e) => e.componentId === fieldId);
    c.assert(raised.length > 0, "Datum raised no notice for the field (fixture or runtime problem)");
    const held = await c.ev(`bc.textHolders(${JSON.stringify(fieldId)}, ${JSON.stringify(needle)})`);
    c.assert(held && held.count > 0, `the notice "${needle} ..." is not drawn in the field`);
    c.assert(!held.alert, "the notice is drawn inside an alert (role=alert or aria-live=assertive)");
    const described = (await c.ev(`bc.descriptions(${JSON.stringify(fieldId)})`)) ?? [];
    c.assert(described.some((d) => d.text.includes(needle)), `the notice describes neither the control nor its group (descriptions: ${JSON.stringify(described.map((d) => d.id ?? d.text.slice(0, 40)))})`);
    const marks = await c.ev(`bc.invalidMarks(${JSON.stringify(fieldId)})`);
    c.assert(marks.length === 0, `a notice marks the field invalid: ${marks.join(", ")}`);
    c.assert(!(await c.ev(`textOf(${summaryEl})`)).includes(needle), "the notice is listed in the error summary");
  });
noticeCase("NTC-01", "text", "name");
noticeCase("NTC-02", "textarea", "bio");
noticeCase("NTC-03", "select", "province");
noticeCase("NTC-04", "radio", "contact");
noticeCase("NTC-05", "checkboxes", "channels");
noticeCase("NTC-06", "date", "start");
noticeCase("NTC-08", "checkbox", "agree");
def("NTC-07", "text: a pending check marks the field and its word describes the control", { needs: ["text"], cap: ["text", "pending"] }, async (c) => {
  await c.mount("advice", { stages: ["remote:name"] });
  const pendingOf = `bc.field("name")?.hasAttribute("data-pending") ?? null`;
  const before = ((await c.ev(`bc.descriptions("name")`)) ?? []).map((d) => d.text);
  await c.ev("bc.startValidation()");
  await c.settle(400);
  c.eq(await c.ev(pendingOf), true, "data-pending on the field while its check runs");
  const now = ((await c.ev(`bc.descriptions("name")`)) ?? []).map((d) => d.text);
  const fresh = now.filter((text) => text && !before.includes(text));
  c.assert(fresh.length > 0, `nothing new describes the control while its check runs (before ${JSON.stringify(before)}, now ${JSON.stringify(now)})`);
  c.assert((await c.ev("bc.answerPending()")) > 0, "no check was pending (fixture or runtime problem)");
  await c.settle(400);
  c.eq(await c.ev(pendingOf), false, "data-pending once the check answered");
});

// A field's own check: an async stage that declares the field's path runs as the answer is committed
// (once the field shows an error), the runtime holds the path pending, and the field draws that: the
// renderer's busy mark on the field and its word in the control's description (the adapter draws the
// word itself when it answers `drawn`, the renderer folds it into the hint when it answers `degraded`).
def("NTC-09", "text: a path-declared async check draws the field's pending state and clears it", { needs: ["text"], cap: ["text", "pending"] }, async (c) => {
  await c.mount("pending");
  const busy = `bc.field("name")?.getAttribute("aria-busy") ?? null`;
  const marked = `bc.field("name")?.hasAttribute("data-pending") ?? null`;
  const words = async () => ((await c.ev(`bc.descriptions("name")`)) ?? []).map((d) => d.text);
  // The whole-form check refuses the empty answer (its async stage is answered at once).
  await c.ev("bc.startValidation()");
  await c.settle(300);
  await c.ev("bc.answerPending()");
  await c.settle(300);
  c.assert((await c.errors()).some((e) => e.componentId === "name"), "the empty required answer raised no error (fixture or runtime problem)");
  c.eq(await c.ev("bc.pendingPaths()"), [], "paths pending before the field is committed");
  c.eq(await c.ev(marked), false, "data-pending before the field is committed");
  const before = await words();
  await c.typeInto("name", "Ada");
  await c.settle(300);
  const paths = await c.ev("bc.pendingPaths()");
  c.assert(paths.includes("name"), `the runtime holds no pending check on "name" (pending: ${JSON.stringify(paths)}; the commit did not start the path check)`);
  c.eq(await c.ev(marked), true, "data-pending on the field while its own check runs");
  c.eq(await c.ev(busy), "true", "aria-busy on the field while its own check runs");
  const now = await words();
  c.assert(now.some((text) => text && !before.includes(text)), `nothing new describes the control while its check runs (before ${JSON.stringify(before)}, now ${JSON.stringify(now)})`);
  c.assert((await c.ev("bc.answerPending()")) > 0, "no check was pending (fixture or runtime problem)");
  await c.settle(400);
  c.eq(await c.ev("bc.pendingPaths()"), [], "paths pending once the check answered");
  c.eq(await c.ev(marked), false, "data-pending once the check answered");
  c.assert((await c.ev(busy)) !== "true", "aria-busy stays on the field once the check answered");
  const after = await words();
  c.assert(after.every((text) => !now.includes(text) || before.includes(text)), `the pending word still describes the control once the check answered (now ${JSON.stringify(after)})`);
  c.assert(!(await c.errors()).some((e) => e.componentId === "name"), "the refusal of the empty answer stands after a valid, checked answer");
});

// ── SUM ───────────────────────────────────────────────────────────────────────────────────
def("SUM-01", "the summary lists one linked entry per field error", { needs: ["text"] }, async (c) => {
  await c.mount("errors");
  await c.validate();
  const errors = (await c.errors()).filter((e) => e.componentId);
  const links = await c.ev(`${SUMMARY_LINKS}.map((a) => textOf(a))`);
  c.assert(links.length > 0, "no summary links drawn");
  c.eq(links.length, errors.length, "summary entries versus field errors");
  c.assert(links.every((t) => t.length > 0), "an entry has no words");
  c.assert(new Set(links).size === links.length, `two entries say the same: ${JSON.stringify(links)}`);
});
def("SUM-02", "a summary link sends focus into its field", { needs: ["text"] }, async (c) => {
  await c.mount("errors");
  await c.validate();
  const errors = (await c.errors()).filter((e) => e.componentId);
  const n = await c.ev(`${SUMMARY_LINKS}.length`);
  c.assert(n > 0, "no summary links drawn");
  for (const i of [0, n - 1]) {
    await c.click(`${SUMMARY_LINKS}[${i}]`, `summary link ${i + 1}`);
    await c.sleep(350);
    const active = await c.active();
    c.eq(active.field?.id ?? active.desc, errors[i]?.componentId, `field holding focus after link ${i + 1} (active ${active.desc})`);
  }
});
def("SUM-03", "after a refused validation focus goes where errorFocus says", { needs: ["text"] }, async (c) => {
  await c.mount("errors");
  await c.validate();
  await c.sleep(300);
  const active = await c.active();
  const first = (await c.errors()).find((e) => e.componentId)?.componentId;
  if (c.info.errorFocus === "field") c.eq(active.field?.id, first, "field holding focus");
  else c.assert(active.inSummary, `focus is on ${active.desc}, not in the summary`);
});
def("SUM-04", "an error with no field is listed as text, not a link", { needs: ["text"] }, async (c) => {
  await c.mount("errors");
  await c.ev(`bc.runtimeCall("setErrors", [{ code: "host.unreachable", message: "The form could not be sent." }])`);
  await c.settle(300);
  const nodes = await c.ev(`textNodes(${summaryEl})`);
  c.assert(nodes.some((t) => t.includes("The form could not be sent.")), "the form-level message is not in the summary");
  const links = await c.ev(`${SUMMARY_LINKS}.map((a) => textOf(a))`);
  c.assert(!links.some((t) => t.includes("The form could not be sent.")), "the form-level message is drawn as a link");
});
def("SUM-05", "the summary is gone once every error is fixed", { needs: ["text"] }, async (c) => {
  await c.mount("errors");
  c.assert(await c.ev(`!${ROOT}.querySelector(".datum-live-summary")`), "a summary is drawn before any validation");
  await c.validate();
  c.assert(await c.ev(`!!${ROOT}.querySelector(".datum-live-summary")`), "no summary after a failed validation");
  for (const [p, v] of [["name", "Ada"], ["bio", "x"], ["province", "ON"], ["contact", "email"], ["channels", { email: true, post: false }], ["start", "2026-05-14"]]) await c.ev(`bc.setValue(${JSON.stringify(p)}, ${JSON.stringify(v)})`);
  await c.validate();
  c.assert(await c.ev(`!${ROOT}.querySelector(".datum-live-summary")`), "the summary is still drawn after every answer is valid");
});

// ── ANN ───────────────────────────────────────────────────────────────────────────────────
def("ANN-01", "the character count is announced once, after typing pauses", { needs: ["text"], cap: ["text", "characterCount"] }, async (c) => {
  await c.mount("text");
  await c.ev("bc.watchRegions()");
  await c.sleep(1200);
  const nonEmpty = async () => (await c.ev("bc.regionWrites()")).filter((w) => w.text);
  c.eq((await nonEmpty()).length, 0, "announcements after mount");
  await c.ev(`bc.setValue("notes", "set by a rule")`);
  await c.sleep(1500);
  c.eq((await nonEmpty()).length, 0, "announcements for a value written by a rule");
  await c.focus("notes");
  await c.ev("bc.clearWrites()");
  await c.type("abcde", 150);
  await c.sleep(500);
  c.eq((await nonEmpty()).length, 0, "announcements while still typing");
  await c.sleep(1200);
  const spoken = await nonEmpty();
  c.assert(spoken.length >= 1, "nothing was announced after typing paused");
  c.assert(new Set(spoken.map((w) => w.text)).size === 1, `announced more than once: ${JSON.stringify(spoken.map((w) => w.text))}`);
  c.assert(/\d/.test(spoken[0].text), `the announcement has no figure: "${spoken[0].text}"`);
});

// ── RO ────────────────────────────────────────────────────────────────────────────────────
const PRESET = { name: "Ada Lovelace", bio: "Fixed", province: "ON", contact: "email", channels: { email: true, post: false }, start: "2026-05-14" };
def("RO-01", "read-only: typing in a text box and a textarea writes nothing", { needs: ["text"] }, async (c) => {
  await c.mount("modes", { mode: "readonly" });
  for (const id of ["name", "bio"]) {
    if (!c.has(id === "name" ? "text" : "textarea")) continue;
    await c.focus(id);
    await c.type("Z");
    await c.sleep(150);
  }
  await c.settle();
  const v = await c.values();
  c.eq(v.name, PRESET.name, "stored name");
  if (c.has("textarea")) c.eq(v.bio, PRESET.bio, "stored bio");
  c.eq((await c.ev(`bc.controlInfo("name")`))[0]?.value, PRESET.name, "text box shows");
});
def("RO-02", "read-only: a select, radios and checkboxes change nothing", { needs: ["select", "radio", "checkboxes"] }, async (c) => {
  await c.mount("modes", { mode: "readonly" });
  const sel = (await c.ev(`bc.controlInfo("province")`)).findIndex((i) => i.tag === "select");
  if (sel >= 0) await c.ev(`bc.setControl("province", ${sel}, "QC")`);
  await c.clickEl(`bc.optionControl("contact", "phone")`, "radio phone");
  await c.clickEl(`bc.optionControl("channels", "post")`, "checkbox post");
  await c.settle();
  const v = await c.values();
  c.eq(v.province, PRESET.province, "stored province");
  c.eq(v.contact, PRESET.contact, "stored contact");
  c.eq(v.channels, PRESET.channels, "stored channels");
  const shown = await c.ev(`bc.controlInfo("contact").filter((i) => i.checked).map((i) => i.value)`);
  c.eq(shown, ["email"], "radio shown checked");
});
def("RO-03", "read-only: a date typed into writes nothing", { needs: ["date"] }, async (c) => {
  await c.mount("modes", { mode: "readonly" });
  const boxes = await c.ev(`bc.dateBoxes("start")`);
  if (boxes.year === undefined) c.skip("no separate day, month and year boxes: the date is one design-system control");
  await c.focus("start", 0, boxes.year);
  await c.type("9");
  await c.settle();
  c.eq((await c.values()).start, PRESET.start, "stored start");
});
def("RO-04", "read-only: no error summary is drawn", { needs: ["text"] }, async (c) => {
  await c.mount("modes", { mode: "readonly" });
  await c.ev(`bc.runtimeCall("setErrors", [{ code: "required", componentId: "name" }])`);
  await c.settle(300);
  c.assert(await c.ev(`!${ROOT}.querySelector(".datum-live-summary")`), "a summary is drawn in read-only mode");
});
def("RO-05", "disabled: every control is disabled and nothing can be written", { needs: ["text"] }, async (c) => {
  await c.mount("modes", { mode: "disabled" });
  const open = await c.ev(`(() => { const out = []; for (const id of ["name", "bio", "province", "contact", "channels", "start"]) { for (const el of bc.controlsOf(id)) { let off = el.disabled || el.getAttribute("aria-disabled") === "true"; for (let n = el; n && !off; n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode) { if (n.nodeType === 1 && (n.hasAttribute("disabled") || n.getAttribute("aria-disabled") === "true")) off = true; if (n.classList?.contains("datum-live-field")) break; } if (!off) out.push(id + ":" + (el.type || el.localName) + (el.value ? "=" + el.value : "")); } } return out; })()`);
  c.assert(open.length === 0, `controls still enabled: ${open.join(", ")}`);
  await c.ev(`bc.setValue("name", "rule")`);
  await c.settle();
  c.eq((await c.values()).name, "rule", "a rule can still write");
});

// ── DAT ───────────────────────────────────────────────────────────────────────────────────
def("DAT-01", "a written date shows in the control(s)", { needs: ["date"] }, async (c) => {
  await c.mount("date");
  await c.ev(`bc.setValue("start", "2026-05-14")`);
  await c.settle();
  const info = await c.ev(`bc.controlInfo("start")`);
  c.assert(info.length > 0, "no native control under the date field");
  const shown = info.map((i) => i.value).join(" ") + " " + (await c.ev(`bc.controlsOf("start").map((e) => e.localName === "select" ? e.options[e.selectedIndex]?.textContent : "").join(" ")`));
  c.assert(/2026/.test(shown) && /14/.test(shown), `the control(s) show "${shown.trim()}" for 2026-05-14`);
});
def("DAT-02", "a date typed in part is not stored; completed, it composes", { needs: ["date"] }, async (c) => {
  await c.mount("date");
  const boxes = await c.ev(`bc.dateBoxes("start")`);
  if (boxes.year === undefined || boxes.day === undefined || boxes.month === undefined) c.skip("no separate day, month and year boxes: the date is one design-system control");
  await c.focus("start", 0, boxes.year);
  await c.ev(`bc.selectAll("start", 0, ${boxes.year})`);
  await c.type("2026");
  await c.ev("bc.blur()");
  await c.settle();
  const partial = (await c.values()).start;
  c.assert(!partial, `a year alone is stored as ${JSON.stringify(partial)}`);
  await c.focus("start", 0, boxes.day);
  await c.ev(`bc.selectAll("start", 0, ${boxes.day})`);
  await c.type("14");
  await c.ev("bc.blur()");
  const monthInfo = (await c.ev(`bc.controlInfo("start")`))[boxes.month];
  if (monthInfo.readOnly) c.skip("the month is a design-system dropdown (a read-only text box): the generic driver cannot operate it");
  const monthTag = monthInfo.tag;
  if (monthTag === "select") c.assert(await c.ev(`bc.setControl("start", ${boxes.month}, "5") || bc.setControl("start", ${boxes.month}, "05") || bc.setControl("start", ${boxes.month}, "May") || bc.setControl("start", ${boxes.month}, "mai")`), "no option for May in the month select");
  else { await c.focus("start", 0, boxes.month); await c.ev(`bc.selectAll("start", 0, ${boxes.month})`); await c.type("5"); await c.ev("bc.blur()"); }
  await c.settle();
  c.eq((await c.values()).start, "2026-05-14", "stored start");
});
def("DAT-03", "an incomplete date is reported when the form is validated", { needs: ["date"] }, async (c) => {
  await c.mount("date");
  const boxes = await c.ev(`bc.dateBoxes("start")`);
  if (boxes.year === undefined) c.skip("no separate day, month and year boxes: the date is one design-system control");
  const before = await c.ev(`bc.fieldTextNodes("start", 0, true)`);
  await c.focus("start", 0, boxes.year);
  await c.ev(`bc.selectAll("start", 0, ${boxes.year})`);
  await c.type("2026");
  await c.ev("bc.blur()");
  await c.validate();
  const fresh = added(await c.ev(`bc.fieldTextNodes("start", 0, true)`), before);
  c.assert(fresh.length > 0, "no error is drawn for a date with only a year");
});

// ── GRD ───────────────────────────────────────────────────────────────────────────────────
/** The answers of one column of a grid, in row order, from the flat values (\`lines[0].item\`). */
const column = (values, grid, id) =>
  Object.entries(values)
    .map(([k, v]) => [new RegExp(`^${grid}\\[(\\d+)\\]\\.${id}$`).exec(k), v])
    .filter(([m]) => m)
    .sort((a, b) => Number(a[0][1]) - Number(b[0][1]))
    .map(([, v]) => v);
const GRID_LABEL = (re) => `(el) => (el.getAttribute("aria-label") || textOf(el)).trim().match(${re})`;
const gridButtons = (re) => `(() => { const all = deepAll(${ROOT}, "button,[role=button],a").filter(${GRID_LABEL(re)}); return all.filter((el) => !all.some((o) => o !== el && contains(o, el))); })()`;
const ADD = `(deepAll(${ROOT}, "[id='lines__add']")[0] ?? ${gridButtons("/^add\\b/i")}[0])`;
const off = `(el) => !el || el.disabled || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || deepAll(el, "button").some((b) => b.disabled)`;
def("GRD-01", "the grid draws its initial rows with their fields", { needs: ["dataGrid", "text"] }, async (c) => {
  await c.mount("grid");
  c.eq(await c.ev(`bc.fieldCount("item")`), 2, "rows (item fields)");
  c.eq(await c.ev(`bc.fieldCount("quantity")`), 2, "rows (quantity fields)");
  const text = await c.ev(`textOf(${ROOT})`);
  c.assert(text.includes("Items requested"), "the grid's name is not drawn");
});
def("GRD-02", "Add appends a row, focuses its first field and stops at the maximum", { needs: ["dataGrid", "text"] }, async (c) => {
  await c.mount("grid");
  await c.click(ADD, "the Add button (#lines__add)");
  await c.settle(300);
  c.eq(await c.ev(`bc.fieldCount("item")`), 3, "rows after Add");
  c.eq(await c.ev(`bc.fieldCount("quantity")`), 3, "rows (quantity fields)");
  const active = await c.active();
  c.assert(active.field?.id === "item" && active.field?.instance === (await c.ev(`bc.field("item", 2).dataset.instance ?? null`)), `focus is on ${active.desc} (${active.field?.id}), not the new row's first field`);
  c.assert(await c.ev(`(${off})(${ADD})`), "Add is still offered at the maximum of three rows");
});
def("GRD-03", "typing in a row stores it at the row and keeps the row's nodes", { needs: ["dataGrid", "text"] }, async (c) => {
  await c.mount("grid");
  await c.ev(`window.__rows = [bc.field("item", 0), bc.field("item", 1)]`);
  await c.typeInto("item", "Paper", { index: 0 });
  await c.typeInto("item", "Pens", { index: 1 });
  c.eq(column(await c.values(), "lines", "item"), ["Paper", "Pens"], "stored items");
  await c.click(ADD, "the Add button");
  await c.settle(300);
  c.assert(await c.ev(`window.__rows[0] === bc.field("item", 0) && window.__rows[1] === bc.field("item", 1)`), "a row's field nodes were replaced when a row was added");
});
def("GRD-04", "Move down swaps the answers of two rows", { needs: ["dataGrid", "text"] }, async (c) => {
  await c.mount("grid");
  await c.typeInto("item", "Paper", { index: 0 });
  await c.typeInto("item", "Pens", { index: 1 });
  await c.click(`${gridButtons("/^move down/i")}[0]`, "the first Move down button");
  await c.settle(300);
  c.eq(column(await c.values(), "lines", "item"), ["Pens", "Paper"], "stored items after the move");
  c.eq((await c.ev(`bc.controlInfo("item", 0)`))[0]?.value, "Pens", "row 1 control after the move");
});
def("GRD-05", "Remove drops its row", { needs: ["dataGrid", "text"] }, async (c) => {
  await c.mount("grid");
  await c.typeInto("item", "Paper", { index: 0 });
  await c.typeInto("item", "Pens", { index: 1 });
  await c.click(`${gridButtons("/^remove\\b/i")}[0]`, "the first Remove button");
  await c.settle(300);
  c.eq(await c.ev(`bc.fieldCount("item")`), 1, "rows after Remove");
  c.eq(column(await c.values(), "lines", "item"), ["Pens"], "stored items after Remove");
});

// ── TAB ───────────────────────────────────────────────────────────────────────────────────
const TABS = `deepAll(${ROOT}, "[role=tab]")`;
const selectedTabs = `${TABS}.map((t) => t.getAttribute("aria-selected") === "true")`;
def("TAB-01", "tabs: a strip of named tabs, one selected, each controlling a panel", { needs: ["tabs"] }, async (c) => {
  await c.mount("tabs");
  const names = await c.ev(`${TABS}.map((t) => textOf(t))`);
  c.eq(names.map((n) => n.replace(/\s+/g, " ").trim()), ["Applicant", "Items"], "tab names");
  c.eq(await c.ev(selectedTabs), [true, false], "selected tabs");
  const resolved = await c.ev(`${TABS}.map((t) => { const id = t.getAttribute("aria-controls"); const p = id && t.getRootNode().getElementById(id); return !!p && p.getAttribute("role") === "tabpanel"; })`);
  c.assert(resolved.every(Boolean), `a tab's aria-controls does not resolve to a tabpanel: ${JSON.stringify(resolved)}`);
});
def("TAB-02", "tabs: a click shows that tab's panel and hides the other", { needs: ["tabs"] }, async (c) => {
  await c.mount("tabs");
  await c.click(`${TABS}[1]`, "the second tab");
  await c.settle();
  c.eq(await c.ev(selectedTabs), [false, true], "selected tabs after the click");
  const shown = await c.ev(`deepAll(${ROOT}, "[role=tabpanel]").map((p) => !p.hidden && getComputedStyle(p).display !== "none")`);
  c.eq(shown, [false, true], "panels shown");
});
def("TAB-03", "tabs: arrow keys, Home and End move between tabs", { needs: ["tabs"] }, async (c) => {
  await c.mount("tabs");
  await c.ev(`${TABS}[0].focus()`);
  await c.key("ArrowRight");
  await c.settle();
  c.eq(await c.ev(selectedTabs), [false, true], "after ArrowRight");
  await c.key("Home");
  await c.settle();
  c.eq(await c.ev(selectedTabs), [true, false], "after Home");
  await c.key("End");
  await c.settle();
  c.eq(await c.ev(selectedTabs), [false, true], "after End");
  c.assert(await c.ev(`deepActive() === ${TABS}[1]`), "focus did not follow the selection");
});
def("TAB-04", "tabs: a tab holding an error is marked", { needs: ["tabs"] }, async (c) => {
  await c.mount("tabs");
  const sig = `${TABS}.map((t) => textNodes(t).join("|") + "#" + t.className + "#" + deepAll(t, "*").map((e) => e.className).join(","))`;
  const before = await c.ev(sig);
  await c.validate();
  const after = await c.ev(sig);
  c.assert(JSON.stringify(before[1]) !== JSON.stringify(after[1]), "the strip's second tab looks the same before and after its panel got an error");
});
def("TAB-05", "tabs: a summary link to a field in a shut tab opens it and focuses the field", { needs: ["tabs"] }, async (c) => {
  await c.mount("tabs");
  await c.validate();
  c.assert(await c.ev(`${SUMMARY_LINKS}.length > 0`), "no summary link for the error in the Items tab");
  await c.click(`${SUMMARY_LINKS}[0]`, "the summary link");
  await c.sleep(400);
  c.eq(await c.ev(selectedTabs), [false, true], "selected tabs after the link");
  c.eq((await c.active()).field?.id, "email", "field holding focus");
});

// ── JNY ───────────────────────────────────────────────────────────────────────────────────
// The page buttons are the buttons (`button`, or `[role=button]`: a design system's own button element) that belong to
// no field, the summary or the language list (bc.pageButtons).
const ACTIONS = `bc.pageButtons()`;
// The renderer finds the page heading by its id (the page's id, then __page-heading) and falls back to the element it marks data-journey-page-focus: the binding must put the id on the heading.
const HEADING_EL = `(${ROOT}.querySelector("[id$='__page-heading']") ?? ${ROOT}.querySelector("[data-journey-page-focus]"))`;
const HEADING = `(() => { const h = ${HEADING_EL}; return h ? textOf(h) : ""; })()`;
const buttonLabels = `${ACTIONS}.map((b) => textOf(b).trim())`;
const BACKISH = `/^(back|previous|retour|précédent)/i`;
const FORWARD = `${ACTIONS}.filter((b) => !${BACKISH}.test(textOf(b).trim())).at(-1)`;
const BACK = `${ACTIONS}.filter((b) => ${BACKISH}.test(textOf(b).trim()))[0]`;
const pressLast = async (c) => { await c.click(FORWARD, "the Continue or Submit button"); await c.sleep(600); await c.settle(300); };
const pressFirstOf2 = async (c) => { await c.click(BACK, "the Back button"); await c.sleep(600); await c.settle(300); };
def("JNY-01", "the first page shows its own fields, a heading, progress and only Continue", { needs: ["text"] }, async (c) => {
  await c.mount("journey");
  c.assert(await c.ev(`bc.fieldCount("fullName") === 1 && bc.fieldCount("email") === 1`), "page one's fields are not both drawn");
  c.eq(await c.ev(`bc.fieldCount("contact")`, 0), 0, "page two's field drawn on page one");
  const heading = await c.ev(HEADING);
  c.assert(heading.includes("About you"), `page heading is "${heading.trim()}"`);
  const all = await c.ev(`textOf(${ROOT})`);
  c.assert(/\b1\b\s*(of|de|sur|\/)\s*\b2\b/i.test(all), "no progress words like '1 of 2' (progress: count)");
  c.eq((await c.ev(buttonLabels)).length, 1, `page buttons ${JSON.stringify(await c.ev(buttonLabels))}`);
});
def("JNY-02", "Continue with a page's errors stays, lists them and moves focus", { needs: ["text"] }, async (c) => {
  await c.mount("journey");
  await c.click(FORWARD, "Continue");
  await c.sleep(600);
  await c.settle(300);
  c.eq(await c.ev(`bc.fieldCount("contact")`), 0, "page two drawn despite errors");
  c.assert(await c.ev(`!!${ROOT}.querySelector(".datum-live-summary")`), "no summary after a refused Continue");
  const active = await c.active();
  const first = (await c.errors()).find((e) => e.componentId)?.componentId;
  if (c.info.errorFocus === "field") c.eq(active.field?.id, first, "field holding focus");
  else c.assert(active.inSummary, `focus is on ${active.desc}, not in the summary`);
});
def("JNY-03", "Continue with valid answers draws page two and focuses its heading", { needs: ["text", "radio"] }, async (c) => {
  await c.mount("journey");
  await c.ev(`bc.setValue("fullName", "Ada Lovelace"); bc.setValue("email", "ada@example.ca")`);
  await c.settle();
  await pressLast(c);
  c.assert(await c.ev(`bc.fieldCount("contact") === 1 && bc.fieldCount("fullName") === 0`), "page two is not what is drawn");
  const heading = await c.ev(HEADING);
  c.assert(heading.includes("How to reach you"), `page heading is "${heading.trim()}"`);
  c.assert(await c.ev(`(() => { const t = ${HEADING_EL}; return !!t && contains(t, deepActive()); })()`), `focus did not reach the page heading (active ${(await c.active()).desc})`);
});
def("JNY-04", "Back draws page one again with its answers", { needs: ["text", "radio"] }, async (c) => {
  await c.mount("journey");
  await c.ev(`bc.setValue("fullName", "Ada Lovelace"); bc.setValue("email", "ada@example.ca")`);
  await c.settle();
  await pressLast(c);
  const labels = await c.ev(buttonLabels);
  c.assert(labels.length === 2, `page two buttons ${JSON.stringify(labels)}`);
  await pressFirstOf2(c);
  c.assert(await c.ev(`bc.fieldCount("fullName") === 1`), "page one is not drawn after Back");
  c.eq((await c.ev(`bc.controlInfo("fullName")`))[0]?.value, "Ada Lovelace", "answer kept");
});
def("JNY-05", "the last page's button reports the host's submit action", { needs: ["text", "radio"] }, async (c) => {
  await c.mount("journey");
  await c.ev(`bc.setValue("fullName", "Ada Lovelace"); bc.setValue("email", "ada@example.ca"); bc.setValue("contact", "email")`);
  await c.settle();
  await pressLast(c);
  await c.ev(`bc.setValue("contact", "email")`);
  await c.settle();
  await pressLast(c);
  const action = (await c.ev("bc.events()")).filter((e) => e.type === "datum-form-action").at(-1);
  c.assert(action, "no datum-form-action after the last page's button");
  c.eq(action.detail.action, "submit", "action");
});
def("JNY-06", "an exit page draws no Continue or Submit", { needs: ["text", "radio"] }, async (c) => {
  await c.mount("journey");
  await c.ev(`bc.setValue("fullName", "Ada Lovelace"); bc.setValue("email", "ada@example.ca")`);
  await c.settle();
  await pressLast(c);
  await c.ev(`bc.setValue("contact", "phone")`);
  await c.settle();
  await pressLast(c);
  c.assert(await c.ev(`bc.fieldCount("sorry") === 1`), "the exit page is not drawn after answering phone");
  const labels = await c.ev(buttonLabels);
  c.assert(labels.length <= 1, `exit page buttons ${JSON.stringify(labels)}`);
});

// ── I18N ──────────────────────────────────────────────────────────────────────────────────
const FRENCH = async (c) => {
  const name = await c.ev(`bc.fieldText("fullName")`);
  c.assert(name?.includes("Nom complet"), `label is "${name}"`);
  c.assert(name.includes("Tel qu'il apparaît"), "the hint is not in French");
  const contact = await c.ev(`bc.fieldText("contact")`);
  c.assert(contact.includes("Courriel") && contact.includes("Téléphone"), `radio options are "${contact}"`);
  c.assert((await c.ev(`bc.fieldText("nickname")`)).includes("Surnom"), "the optional field's label is not in French");
};
def("I18N-01", "a form opened in French draws its labels, hints and options in French", { needs: ["text", "radio"] }, async (c) => {
  await c.mount("i18n", { locale: "fr-CA" });
  await FRENCH(c);
});
def("I18N-02", "switching to French after mount re-words the drawn form", { needs: ["text", "radio"] }, async (c) => {
  await c.mount("i18n");
  c.assert((await c.ev(`bc.fieldText("fullName")`)).includes("Full name"), "the form did not start in English");
  await c.ev(`bc.runtimeCall("setLocale", "fr-CA")`);
  await c.settle(300);
  await FRENCH(c);
});
def("I18N-03", "validation words differ by language and the design system's own words follow", { needs: ["text"] }, async (c) => {
  await c.ev(`document.documentElement.lang = "en"`);
  const words = {};
  for (const [name, locale] of [["en", undefined], ["fr", "fr-CA"]]) {
    await c.mount("i18n", { locale });
    const before = await c.ev(`bc.fieldTextNodes("fullName", 0, true)`);
    await c.validate();
    words[name] = added(await c.ev(`bc.fieldTextNodes("fullName", 0, true)`), before).join(" | ");
    if (name === "en") await c.ev("bc.unmount()");
  }
  c.assert(words.en && words.fr, `an error text is missing (en "${words.en}", fr "${words.fr}")`);
  c.assert(words.en !== words.fr, `the error reads the same in both languages: "${words.fr}"`);
});
def("I18N-04", "a French form on an English page marks its language", { needs: ["text"] }, async (c) => {
  await c.ev(`document.documentElement.lang = "en"`);
  await c.mount("i18n", { locale: "fr-CA" });
  const marked = await c.ev(`(() => { const hits = [bc.root().host, ...deepAll(bc.root(), "[lang]")].filter((e) => /^fr/i.test(e.getAttribute("lang") || "")); return hits.length; })()`);
  c.assert(marked > 0, "no element carries lang=fr: assistive technology reads French text with the English page's voice");
});

// ── HK ────────────────────────────────────────────────────────────────────────────────────
const wrapperAttrs = (id, index = 0) => `(() => { const w = bc.field(${JSON.stringify(id)}, ${index}); return w ? Object.fromEntries([...w.attributes].map((a) => [a.name, a.value])) : null; })()`;
def("HK-01", "state hooks: the renderer writes data-kind, data-required, data-invalid and data-over-limit on each field wrapper", { needs: ["text"] }, async (c) => {
  await c.mount("hooks");
  const hooks = async (id) => (await c.ev(wrapperAttrs(id))) ?? c.assert(false, `no field wrapper for "${id}"`);
  const present = (attrs, name) => name in attrs;
  const kinds = { hReq: "text", hOpt: "text", hLimit: "text", hChoice: "radio", hDate: "date", hInner: "text" };
  for (const [id, kind] of Object.entries(kinds)) c.eq((await hooks(id))["data-kind"], kind, `data-kind of ${id}`);
  c.assert(present(await hooks("hReq"), "data-required"), "data-required is missing on a required field");
  c.assert(!present(await hooks("hOpt"), "data-required"), "data-required is on an optional field");
  c.assert(!present(await hooks("hReq"), "data-invalid"), "data-invalid before any validation");
  // Over the limit: only a field with a limit and a count, and only while the answer is longer.
  c.assert(!present(await hooks("hLimit"), "data-over-limit"), "data-over-limit on an empty limited field");
  await c.ev(`bc.setValue("hLimit", "much longer than ten")`);
  await c.settle();
  c.assert(present(await hooks("hLimit"), "data-over-limit"), "data-over-limit is missing on an answer over its limit");
  await c.ev(`bc.setValue("hLimit", "short")`);
  await c.settle();
  c.assert(!present(await hooks("hLimit"), "data-over-limit"), "data-over-limit stays on once the answer is back under the limit");
  // Invalid: blocking errors only; set on the field in error, withdrawn when it is corrected.
  await c.validate();
  c.assert(present(await hooks("hReq"), "data-invalid"), "data-invalid is missing on the field in error");
  c.assert(!present(await hooks("hOpt"), "data-invalid"), "data-invalid is on a field without an error");
  await c.typeInto("hReq", "Ada");
  await c.validate();
  c.assert(!present(await hooks("hReq"), "data-invalid"), "data-invalid stays on after the answer is corrected");
  // Nothing in the interactive form is read-only or disabled.
  for (const id of ["hReq", "hChoice", "hDate"]) {
    const attrs = await hooks(id);
    c.assert(!present(attrs, "data-readonly") && !present(attrs, "data-disabled"), `${id} carries a mode hook in an interactive form`);
  }
});
def("HK-02", "ids the form's own markup references resolve (for, aria-describedby, aria-labelledby, aria-controls)", { needs: ["text"] }, async (c) => {
  await c.mount("errors");
  await c.validate();
  const bad = await c.ev(`(() => { const out = []; const root = bc.root(); for (const el of root.querySelectorAll("*")) { for (const attr of ["for", "aria-describedby", "aria-labelledby", "aria-controls", "aria-errormessage"]) { const v = el.getAttribute(attr); if (!v) continue; for (const token of v.split(/\\s+/)) if (token && !root.getElementById(token)) out.push(el.localName + "[" + attr + "=" + token + "]"); } } return out; })()`);
  c.assert(bad.length === 0, `references that resolve to nothing in the form's own tree: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` (+${bad.length - 5})` : ""}`);
});
def("HK-03", "radio and checkbox groups carry a name", { needs: ["radio", "checkboxes"] }, async (c) => {
  await c.mount("errors");
  const unnamed = await c.ev(`(() => { const out = []; for (const id of ["contact", "channels"]) { const w = bc.field(id); const names = []; const nameOf = (el) => { const l = el.getAttribute("aria-label"); if (l) return l; const by = el.getAttribute("aria-labelledby"); if (by) { const t = el.getRootNode().getElementById(by.split(/\\s+/)[0]); if (t) return textOf(t); } const reflected = el.ariaLabelledByElements ?? []; if (reflected.length) return reflected.map((t) => textOf(t)).join(" "); if (el.localName === "fieldset") return textOf(el.querySelector("legend") ?? document.createElement("i")); return el.getAttribute("legend") || el.getAttribute("label") || el.getAttribute("hint-text") || ""; }; for (const el of [w, ...deepAll(w, "fieldset,[role=group],[role=radiogroup],[legend],[label]")]) { const n = nameOf(el).trim(); if (n && el !== w) names.push(n); else if (n && (el.getAttribute("legend") || el.getAttribute("label"))) names.push(n); } if (names.length === 0) out.push(id); } return out; })()`);
  c.assert(unnamed.length === 0, `no group name found for: ${unnamed.join(", ")}`);
});

def("HK-04", "DOM contract: data-component-id, data-container-id and data-value-path (a grid row's own path)", { needs: ["text"] }, async (c) => {
  await c.mount("hooks");
  const info = await c.ev(`(() => {
    const root = bc.root();
    const fields = [...root.querySelectorAll(".datum-live-field")].map((w) => ({ id: w.dataset.componentId, path: w.dataset.valuePath, instance: w.dataset.instance ?? null }));
    const containers = [...root.querySelectorAll("[data-container-id]")].map((w) => ({ id: w.dataset.containerId, kind: w.dataset.kind, fields: [...w.querySelectorAll(".datum-live-field")].map((f) => f.dataset.componentId) }));
    return { fields, containers };
  })()`);
  c.assert(info.fields.every((f) => f.id), "a field wrapper has no data-component-id");
  c.assert(info.fields.every((f) => f.path), `a field wrapper has no data-value-path: ${JSON.stringify(info.fields.filter((f) => !f.path))}`);
  for (const id of ["hReq", "hOpt", "hLimit", "hChoice", "hDate"]) c.eq(info.fields.find((f) => f.id === id)?.path, id, `data-value-path of ${id}`);
  const cells = info.fields.filter((f) => f.id === "cell");
  c.eq(cells.length, 2, "grid rows drawn");
  c.eq(cells.map((f) => f.path), ["hGrid[0].cell", "hGrid[1].cell"], "data-value-path of the grid row fields");
  c.assert(new Set(cells.map((f) => f.instance)).size === 2, "the rows' fields share one instance key");
  const box = info.containers.find((x) => x.id === "hBox");
  c.assert(box, "the group has no data-container-id wrapper");
  c.eq(box.kind, "fieldset", "data-kind of the group's wrapper");
  c.assert(box.fields.includes("hInner"), "the group's field is not inside its wrapper");
  // The second row's field stores at the row's own path.
  await c.typeInto("cell", "Third", { index: 1 });
  c.eq((await c.values())["hGrid[1].cell"], "Third", "answer stored at the row's data-value-path");
});
def("HK-05", "state hooks: read-only and disabled forms mark every field", { needs: ["text"] }, async (c) => {
  for (const [mode, hook, other] of [["readonly", "data-readonly", "data-disabled"], ["disabled", "data-disabled", "data-readonly"]]) {
    if (mode === "disabled") await c.ev("bc.unmount()");
    await c.mount("modes", { mode });
    for (const id of ["name", "bio", "province", "contact", "channels", "start"]) {
      const attrs = await c.ev(wrapperAttrs(id));
      c.assert(attrs, `no field wrapper for "${id}"`);
      c.assert(hook in attrs, `${hook} is missing on ${id} in ${mode} mode`);
      c.assert(!(other in attrs), `${other} is on ${id} in ${mode} mode`);
    }
  }
});

// ── CAP ───────────────────────────────────────────────────────────────────────────────────
// Capabilities a text adapter answers (drawing-capabilities.ts), and what no capability covers: every
// text adapter draws these (the hint, the input attributes), so they are asserted whatever it answers.
const TEXT_CAPS = [["placeholder", "c_placeholder"], ["prefix", "c_prefix"], ["suffix", "c_suffix"], ["tooltip", "c_tooltip"], ["characterCount", "c_count"]];
const TEXT_ALWAYS = [["hint", "c_hint"], ["autocomplete", "c_autocomplete"], ["inputMode", "c_inputmode"], ["spellcheck", "c_spellcheck"]];
def("CAP-01", "capabilities: a binding's declared answers have a known value", { needs: ["text"] }, async (c) => {
  const bad = [];
  for (const [type, adapters] of Object.entries(c.info.types)) for (const a of adapters) for (const [key, v] of Object.entries(a.capabilities)) if (!["drawn", "degraded", "none"].includes(v)) bad.push(`${type}.${key}=${v}`);
  c.assert(bad.length === 0, `unknown answers: ${bad.join(", ")}`);
});
def("CAP-02", "capabilities: what the form uses and the binding answers none for is reported unsupported", { needs: ["text"] }, async (c) => {
  await c.mount("caps");
  const listed = new Set(await c.ev("bc.unsupported()"));
  const expectedDefinitely = [];
  const possible = new Set();
  const consider = (type, key, id) => {
    const answers = (c.info.types[type] ?? []).map((a) => a.capabilities[key] ?? "none");
    if (answers.length === 0) return;
    if (answers.every((a) => a === "none")) expectedDefinitely.push(`${id}: ${key}`);
    if (answers.some((a) => a === "none")) possible.add(`${id}: ${key}`);
  };
  for (const [key, id] of TEXT_CAPS) consider("text", key, id);
  const missing = expectedDefinitely.filter((e) => !listed.has(e));
  c.assert(missing.length === 0, `answered none but not reported: ${missing.join(", ")}`);
  const extra = [...listed].filter((e) => e.includes(": ") && !e.includes('component "') && !possible.has(e));
  c.assert(extra.length === 0, `reported unsupported but the binding does not answer none: ${extra.join(", ")}`);
});
def("CAP-03", "capabilities: text features answered drawn or degraded are drawn", { needs: ["text"] }, async (c) => {
  await c.mount("caps");
  const checks = {
    hint: (t) => t.includes("HINTWORDS"),
    prefix: (t) => t.includes("PFX"),
    suffix: (t) => t.includes("SFX"),
    tooltip: (t) => t.includes("TOOLTIPWORDS"),
    characterCount: (t) => /73/.test(t)
  };
  const attrs = { placeholder: ["placeholder", "PLACEHOLDERWORDS"], autocomplete: ["autocomplete", "email"], inputMode: ["inputmode", "numeric"] };
  const problems = [];
  let asserted = 0;
  const entries = [...TEXT_CAPS.map(([key, id]) => [key, id, c.cap("text", key)]), ...TEXT_ALWAYS.map(([key, id]) => [key, id, "always"])];
  for (const [key, id, answer] of entries) {
    if (answer === undefined || answer === "none") continue;
    asserted += 1;
    if (checks[key]) {
      const text = await c.ev(`bc.fieldText(${JSON.stringify(id)})`);
      if (!checks[key](text ?? "")) problems.push(`${key} (${answer}) not in the field's text`);
    } else if (attrs[key]) {
      const info = (await c.ev(`bc.controlInfo(${JSON.stringify(id)})`))[0];
      const [prop, want] = attrs[key];
      if (info?.[prop] !== want) problems.push(`${key} (${answer}): control ${prop}=${JSON.stringify(info?.[prop])}`);
    } else if (key === "spellcheck") {
      const info = (await c.ev(`bc.controlInfo("c_spellcheck")`))[0];
      if (info?.spellcheck !== false) problems.push(`spellcheck (${answer}): control spellcheck=${info?.spellcheck}`);
    }
  }
  if (asserted === 0) c.skip("the binding answers none for every text feature");
  c.assert(problems.length === 0, problems.join("; "));
});

// ── KIND ──────────────────────────────────────────────────────────────────────────────────
def("KIND-01", "every tier-2 kind falls back to its base under the binding (Datum draws and validates it as the base)", { needs: [] }, async (c) => {
  await c.mount("kinds");
  // A mapped type is reported unsupported only when the binding draws no adapter for its base (Datum draws it then, as it does the base).
  const mapped = { "kx-text": "text", "kx-textarea": "textarea", "kx-select": "select", "kx-radio": "radio", "kx-checkboxes": "checkboxes", "kx-date": "date", "kx-fieldset": "fieldset", "kx-tabs": "tabs" };
  const unknown = (await c.ev("bc.unsupported()")).filter((u) => Object.entries(mapped).some(([type, base]) => u.includes(`component "${type}"`) && c.has(base)));
  c.assert(unknown.length === 0, `types the kinds map names are reported as unsupported although the binding draws their base: ${unknown.join(", ")}`);
  c.assert(await c.ev(`!bc.root().querySelector(".datum-live-unknown")`), "the renderer drew its unknown-component note for a mapped type");
  const bases = { kxText: "text", kxArea: "textarea", kxSelect: "select", kxRadio: "radio", kxChecks: "checkboxes", kxDate: "date" };
  for (const [id, base] of Object.entries(bases)) {
    const attrs = await c.ev(`(() => { const w = bc.field(${JSON.stringify(id)}); return w ? { kind: w.dataset.kind, controls: bc.controlsOf(${JSON.stringify(id)}).length, fallback: w.hasAttribute("data-fallback") } : null; })()`);
    c.assert(attrs, `no field wrapper for the mapped field "${id}"`);
    c.eq(attrs.kind, base, `data-kind of ${id}`);
    // A control is a native one or one found by role (bc.controlsOf), as for the base type.
    c.assert(attrs.controls > 0, `the mapped field "${id}" draws no control (native or by role)`);
  }
  // The containers: drawn as their base, content kept inside.
  const groups = await c.ev(`(() => ({ group: [...bc.root().querySelectorAll('[data-container-id="kxGroup"]')].map((w) => ({ kind: w.dataset.kind, inner: !!w.querySelector('.datum-live-field[data-component-id="kxInner"]') })), tabs: [...bc.root().querySelectorAll('[data-container-id="kxTabs"]')].map((w) => w.dataset.kind), tabNames: deepAll(bc.root(), "[role=tab]").map((t) => textOf(t)) }))()`);
  c.eq(groups.group, [{ kind: "fieldset", inner: true }], "the mapped group's wrapper");
  c.eq(groups.tabs, ["tabs"], "the mapped tabs' wrapper");
  c.eq(groups.tabNames.map((n) => n.trim()), ["One", "Two"], "the mapped tabs' strip");
  // Read as the base everywhere else: a typed answer is stored, a required one is checked.
  await c.typeInto("kxText", "Ada");
  c.eq((await c.values()).kxText, "Ada", "stored kxText");
  await c.ev(`bc.setValue("kxText", "")`);
  await c.validate();
  const raised = (await c.errors()).map((e) => e.componentId);
  c.assert(raised.includes("kxText"), `no error for the empty required mapped text (errors on ${JSON.stringify(raised)})`);
  c.assert(raised.includes("kxDate"), `no error for the empty required mapped date (errors on ${JSON.stringify(raised)})`);
  c.assert((await c.ev(`bc.fieldTextNodes("kxDate", 0, true)`)).some((t) => /required|obligatoire|enter|date/i.test(t)), "no error text is drawn in the mapped date's field");
});

// ── PRT ───────────────────────────────────────────────────────────────────────────────────
// The package's print theme (the assets file's "print"): every fixture through the renderer's print
// path, its self-check quiet with the host's own stylesheets, no drawer refused, no word lost against
// the basic theme. A binding with no print theme prints under the basic one: nothing of its own to check.
const PRESET_OF = { errors: PRESET };
const PRINTED = ["text", "textarea", "select", "radio", "checkboxes", "date", "fieldset", "grid", "tabs", "errors", "hooks"];
def("PRT-01", "the print theme prints every fixture: self-check quiet with the host's files, no drawer refused, nothing lost", { needs: [] }, async (c) => {
  if (!c.modules?.print) c.skip('the assets file names no print theme module ("print"): the binding prints under the basic theme');
  const problems = [];
  for (const name of PRINTED) {
    const fixture = FIXTURES[name];
    const r = await c.ev(`bc.printFixture(${JSON.stringify(c.modules.print)}, ${JSON.stringify(fixture.definition)}, ${JSON.stringify(fixture.preset ?? PRESET_OF[name] ?? {})}, ${JSON.stringify(c.assets ?? {})})`);
    if (r.error) c.assert(false, r.error);
    if (r.fellBack) problems.push(`${name}: a drawer was refused (${JSON.stringify(r.fellBack)})`);
    if (r.used !== r.theme) problems.push(`${name}: printed under "${r.used}", not the theme "${r.theme}"`);
    if (r.selfCheck.length) problems.push(`${name}: self-check: ${r.selfCheck.slice(0, 3).join("; ")}`);
    if (r.lost.length) problems.push(`${name}: words the basic theme prints and this one does not: ${r.lost.slice(0, 8).join(", ")}`);
  }
  c.assert(problems.length === 0, problems.join(" | "));
});

// ── PDF ───────────────────────────────────────────────────────────────────────────────────
// The binding's `pdfTheme` suggestion: the PDF theme it names (from the assets file's "pdf" module)
// is what the engine's ladder picks on the binding rung, and it resolves; unregistered, the ladder
// falls to the engine's default with theme.notFound.
def("PDF-01", "the PDF suggestion resolves: the binding rung picks the theme it names", { needs: [] }, async (c) => {
  const r = await c.ev(`bc.pdfSuggestion(${JSON.stringify(c.modules?.pdf ?? null)})`);
  if (r.none) c.skip("the binding suggests no PDF theme (pdfTheme): documents print under the host's or the engine's");
  c.assert(!r.error, r.error);
  c.eq(r.source, "binding", "the rung that answered");
  c.eq(r.id, r.wanted, "the theme picked");
  c.eq(r.warnings, [], "warnings with the theme registered");
  c.assert(r.body?.family && r.body?.size > 0, `the theme resolves no body type: ${JSON.stringify(r.body)}`);
  if (!r.objectSuggestion) c.assert(r.unregistered.source === "default" && r.unregistered.warnings.includes("theme.notFound"), `unregistered, the ladder answered ${r.unregistered.source} (${r.unregistered.warnings.join(", ")}), not the default with theme.notFound`);
});

// ── CNV ───────────────────────────────────────────────────────────────────────────────────
// The builder canvas draws the form with the binding and lays its hooks over the drawing (the builder's
// canvas-hooks): every component in a node of its own, a field's leaf under `inert` so a click on a control
// selects the field and never types into it, a group's node never inert, an empty group a drop zone. The
// binding's leaf markup is never touched; this checks that what the binding draws takes the hooks: the click
// lands on the node of the component it aims at, nothing in the leaf takes focus or an answer, and the
// same form is live again the moment the hooks come off (Try it, Preview). The tester lays the engine's
// hooks over the fixture; the selection rule it applies is the builder's (the nearest node on the click's path).
const CANVAS_LEAVES = ["name", "bio", "province", "contact", "channels", "start", "detail"];
def("CNV-01", "builder canvas mode: selection, inert leaf controls, drop", { needs: [] }, async (c) => {
  const definition = c.fixture("canvas");
  await c.mount("canvas");
  await c.ev(`bc.canvas(true, ${JSON.stringify(definition)})`);
  const problems = [];
  // 1. A node per component: fields with an inert leaf, groups as containers that are not inert, the empty group's drop zone.
  for (const id of CANVAS_LEAVES) {
    const n = await c.ev(`bc.canvasNode(${JSON.stringify(id)})`);
    if (n.count !== 1) { problems.push(`${id}: ${n.count} canvas nodes, not one`); continue; }
    if (!n.leaf) problems.push(`${id}: the node holds no leaf`);
    else if (!n.inert) problems.push(`${id}: the leaf is not inert`);
    if (n.container) problems.push(`${id}: a field's node is drawn as a container`);
  }
  for (const id of ["more", "spare"]) {
    const n = await c.ev(`bc.canvasNode(${JSON.stringify(id)})`);
    if (n.count !== 1) { problems.push(`${id}: ${n.count} canvas nodes, not one`); continue; }
    if (!n.container) problems.push(`${id}: a group's node is not drawn as a container`);
    if (n.nodeInert || n.inert) problems.push(`${id}: a group's node is inert (it holds nodes and drop zones of its own)`);
  }
  c.assert((await c.ev(`bc.canvasNode("spare")`)).zone, "the empty group draws no drop zone");
  c.assert(!(await c.ev(`bc.canvasNode("more")`)).zone, "a group that holds a component draws an empty drop zone");
  c.assert(problems.length === 0, problems.join(" | "));
  // 2. A real click on the control selects its component: the node on the click's path is the field's own, and the control
  //    neither takes focus nor an answer.
  const before = await c.values();
  for (const id of CANVAS_LEAVES) {
    await c.ev("bc.canvasClicks()");
    const aim = await c.ev(`bc.canvasAim(${JSON.stringify(id)})`);
    if (!aim) { problems.push(`${id}: nothing of the leaf has a box to click`); continue; }
    await c.mouse(aim.x, aim.y);
    await c.sleep(80);
    const clicks = await c.ev("bc.canvasClicks()");
    const last = clicks[clicks.length - 1];
    if (!last) { problems.push(`${id}: the click (on ${aim.control}) reached nothing under the canvas`); continue; }
    if (last.node !== id) problems.push(`${id}: a click on ${aim.control} selects ${JSON.stringify(last.node)} (it landed on ${last.target})`);
    const active = await c.active();
    if (active.field?.id === id) problems.push(`${id}: the click focused the control (${active.desc})`);
    if (await c.ev(`bc.canvasFocusReaches(${JSON.stringify(id)})`)) problems.push(`${id}: a control in the inert leaf takes focus`);
  }
  await c.type("zz");
  c.eq(await c.values(), before, "answers after clicking every control and typing on the canvas");
  c.assert(problems.length === 0, problems.join(" | "));
  // 3. A real click on a group's own heading (the legend the binding drew, wherever it lives) selects the group itself.
  const groupLabel = definition.root.children.content.find((node) => node.id === "more").configuration.label;
  const group = await c.ev(`bc.canvasHeadingAim("more", ${JSON.stringify(groupLabel)})`);
  c.assert(group !== null, `the group's heading ${JSON.stringify(groupLabel)} has no box to click in its canvas node`);
  await c.ev("bc.canvasClicks()");
  await c.mouse(group.x, group.y);
  await c.sleep(80);
  const groupClicks = await c.ev("bc.canvasClicks()");
  const groupHit = groupClicks[groupClicks.length - 1];
  c.assert(groupHit?.node === "more", `a click on the group's heading (${group.control}) selects ${JSON.stringify(groupHit?.node ?? null)}${groupHit ? ` (it landed on ${groupHit.target})` : ""}, not the group`);
  // 4. The hooks off (Try it, Preview): the same drawn form takes typing at once, and the leaf is no longer inert.
  await c.ev(`bc.canvas(false, ${JSON.stringify(definition)})`);
  c.eq(await c.ev(`bc.root().querySelectorAll(".db-node, .db-leaf, [inert]").length`), 0, "canvas nodes or inert elements left after the hooks came off");
  await c.typeInto("name", "Ada");
  c.eq((await c.values()).name, "Ada", "an answer typed once the hooks are off");
});

export const CASES = cases;
