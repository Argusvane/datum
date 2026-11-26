// Checks of the form-level hooks the tester's host does not mount (the language toggle, the host's
// receipt, a summary's echo, a journey page's heading level) and of what the adapters answer: each
// hook is called with a state, drawn by lit-html into jsdom, and read. The binding is the built bundle
// (dist/ontario.js: run `npm run build` first), given lit the way a host gives it.
//   node bindings/ontario/tests/hooks-check.mjs
// Exit 0 when every check passes, 1 when one fails.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const need = (from, name) => createRequire(join(repo, from, "package.json"))(name);
const { JSDOM } = need("packages/datum", "jsdom");
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "Element", "HTMLElement", "ShadowRoot", "CSSStyleSheet", "Comment", "Text", "DocumentFragment", "MutationObserver"]) {
  globalThis[key] = dom.window[key] ?? globalThis[key];
}
const engineRequire = createRequire(join(repo, "engine", "package.json"));
const importLit = async (name) => import(pathToFileURL(engineRequire.resolve(name)).href);
const litHtml = await importLit("lit-html");
const { ifDefined } = await importLit("lit-html/directives/if-defined.js");
const { live } = await importLit("lit-html/directives/live.js");
const { ref } = await importLit("lit-html/directives/ref.js");
const lit = { html: litHtml.html, svg: litHtml.svg, nothing: litHtml.nothing, live, repeat: () => undefined, ifDefined, ref, unsafeSVG: () => undefined };
const { createBinding, ontarioKinds, ontarioPlugin } = await import(pathToFileURL(join(here, "..", "dist", "ontario.js")).href);
// Datum's binding as far as these hooks reach it: its language switcher, which the Ontario one hands a form it cannot toggle.
const datumSwitcher = (state) => litHtml.html`<select data-datum-switcher>${state.locales.map((entry) => litHtml.html`<option value=${entry.code}>${entry.label}</option>`)}</select>`;
const binding = createBinding(lit, { components: {}, languageSwitcher: datumSwitcher });

const results = [];
function check(name, run) {
  try {
    run();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split("\n")[0]}`);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const draw = (template) => {
  const host = dom.window.document.createElement("div");
  litHtml.render(template, host);
  return host;
};
const words = Object.assign((key) => ({ required: "(required)", optional: "(optional)", noticeSuccess: "Success: ", noticeInfo: "Information: ", noticeWarning: "Warning: ", noticeError: "Error: ", fieldPending: "Checking this answer…", tooltipHelp: "Help", pageRedirected: "Redirected." })[key] ?? key, { plural: (key) => key });

const state = (extra = {}) => ({
  key: "f", componentId: "f", type: "text", base: "text", kind: "text", id: "f", name: "f", valuePath: "f", label: "City", labelId: "f__label", hideLabel: false,
  value: "", answer: "", required: false, readOnly: false, disabled: false, invalid: false, errors: [], notices: [], describedBy: [], pending: false, busy: undefined,
  overLimit: false, locale: "en", dir: "ltr", classNames: [], reveal: [], mode: "interactive", words, text: () => undefined, model: {}, ...extra
});
const on = { input: () => undefined, parts: () => undefined, commit: () => undefined };

check("capabilities: what each adapter draws is answered as data (notice, count and tooltip drawn; hint-folded ones degraded; affixes, placeholder and the hidden label none)", () => {
  const text = binding.components.text.capabilities;
  assert(text.notice === "drawn" && text.characterCount === "drawn" && text.pending === "degraded" && text.tooltip === "drawn" && text.workedOut === "degraded", JSON.stringify(text));
  for (const type of ["textarea", "number", "select", "radio", "checkboxes"]) assert(binding.components[type].capabilities.tooltip === "drawn", `${type}: the tooltip is the component's hint expander`);
  assert(binding.components.date.capabilities.tooltip === "degraded", "a date takes no expander: its tooltip is folded into the hint");
  assert(text.prefix === undefined && text.suffix === undefined && text.placeholder === undefined && text.hideLabel === undefined, "no affix, placeholder or hidden label is claimed");
  assert(binding.components.select.capabilities.placeholder === "drawn", "the select's empty option is its placeholder");
  assert(binding.components.date.capabilities.workedOut === "drawn", "the tier-2 date draws the worked-out line itself");
  assert(binding.components.dataGrid.capabilities.rowNumbers === "degraded", "a stacked grid always names its rows");
  assert(binding.components.steps.capabilities.hideLabel === "drawn" && binding.components.fieldset.capabilities.hideLabel === "none", "step headings can be hidden, a legend cannot");
});

check("pending: degraded; the renderer's word folded into the hint is what the component is told", () => {
  const busy = draw(binding.components.text.template(state({ pending: true, hint: "As on your passport. Checking this answer…", hintId: "f__description", describedBy: ["f__description"] }), on));
  const component = busy.querySelector("ontario-input");
  assert(JSON.parse(component.getAttribute("hint-text")).hint === "As on your passport. Checking this answer…", "the hint carries the word");
  assert(busy.querySelector("#f__description[hidden][data-describes]")?.textContent === "As on your passport. Checking this answer…", "the same words, once more, out of sight, for the box to be described by");
  assert(draw(binding.components.text.template(state(), on)).querySelector("[data-hint-copy]") === null, "no copy without a hint");
});

check("tooltip: the component's field-level hint expander, opened by the help word, and the same words out of sight under the drawn tooltip's id, after the hint", () => {
  for (const [type, tag, extra] of [["text", "ontario-input", { tooltip: "As printed on your card." }], ["textarea", "ontario-textarea", { tooltip: "As printed on your card." }], ["select", "ontario-dropdown-list", { options: [], emptyLabel: "Select", model: { tooltip: "As printed on your card." } }], ["radio", "ontario-radio-buttons", { options: [], model: { tooltip: "As printed on your card." } }], ["checkboxes", "ontario-checkboxes", { options: [], selected: [], model: { tooltip: "As printed on your card." } }]]) {
    const host = draw(binding.components[type].template(state({ type, hint: "Your card.", hintId: "f__description", ...extra }), on));
    const expander = JSON.parse(host.querySelector(tag).getAttribute("hint-expander") ?? "null");
    assert(expander?.hint === "Help" && expander.content === "As printed on your card." && expander.hintContentType === "string", `${type}: ${JSON.stringify(expander)}`);
    const copy = host.querySelector("#f__tooltip[hidden][data-describes]");
    assert(copy?.textContent === "As printed on your card.", `${type}: the copy the box is described by`);
    const order = [...host.querySelectorAll("[data-describes]")].map((el) => el.id);
    assert(order.join() === "f__description,f__tooltip", `${type}: described by the hint, then the tooltip (${order})`);
  }
  const plain = draw(binding.components.text.template(state(), on));
  assert(!plain.querySelector("ontario-input").hasAttribute("hint-expander") && plain.querySelector("[data-tooltip-copy]") === null, "no expander and no copy without a tooltip");
});

check("label and hint reach Ontario as JSON strings, so a label that is itself JSON stays a label", () => {
  const host = draw(binding.components.text.template(state({ label: "123", hint: "true" }), on)).querySelector("ontario-input");
  assert(JSON.parse(host.getAttribute("caption")).captionText === "123", "caption");
  assert(JSON.parse(host.getAttribute("hint-text")).hint === "true", "hint");
});

check("notices: one callout each (yellow for a warning, teal for information), the severity word first, under the id the state names", () => {
  const host = draw(binding.components.text.template(state({ noticeId: "f__notice", notices: [{ code: "a", severity: "warning", message: "Short." }, { code: "b", severity: "info", message: "Kept a year." }], describedBy: ["f__notice"] }), on));
  const block = host.querySelector("#f__notice[data-describes]");
  const callouts = [...block.querySelectorAll("ontario-callout")];
  assert(callouts.map((c) => c.getAttribute("highlight-colour")).join() === "yellow,teal", "colours");
  assert(callouts[0].textContent.trim() === "Warning: Short." && callouts[1].textContent.trim() === "Information: Kept a year.", `${callouts[0].textContent} / ${callouts[1].textContent}`);
  assert(block.querySelector("[role], [aria-live]") === null, "no alert role");
});

check("options: an option's help is the hint expander's content, worded by the form's help word", () => {
  const options = [{ id: "f__0", value: "a", label: "A", hint: "Within a day", checked: false }, { id: "f__1", value: "b", label: "B", checked: false }];
  const host = draw(binding.components.radio.template(state({ type: "radio", options }), on)).querySelector("ontario-radio-buttons");
  const drawn = JSON.parse(host.getAttribute("options"));
  assert(drawn[0].hintExpander.content === "Within a day" && drawn[0].hintExpander.hint === "Help" && drawn[1].hintExpander === undefined, JSON.stringify(drawn));
  assert(drawn[0].elementId === "f__0", "the option's id is its element id");
});

check("focus: a summary link to radios lands on the checked radio, else the first (the radios live in the component's shadow root)", () => {
  const field = dom.window.document.createElement("div");
  const component = dom.window.document.createElement("ontario-radio-buttons");
  field.append(component);
  const root = component.attachShadow({ mode: "open" });
  root.innerHTML = '<input type="radio" value="a"><input type="radio" value="b">';
  assert(binding.components.radio.focusTarget(field).value === "a", "the first radio when none is checked");
  root.querySelectorAll("input")[1].checked = true;
  assert(binding.components.radio.focusTarget(field).value === "b", "the checked radio");
});

check("button: Datum's variants map to primary, secondary and tertiary (no danger style); busy is aria-disabled on the host, never disabled", () => {
  const draws = (extra) => draw(binding.components.button.template(state({ type: "button", base: "button", kind: undefined, label: "Go", ...extra }), on)).querySelector("ontario-button");
  assert(draws({}).getAttribute("type") === "primary" && draws({ variant: "secondary" }).getAttribute("type") === "secondary", "primary and secondary");
  assert(draws({ variant: "danger" }).getAttribute("type") === "secondary" && draws({ variant: "link" }).getAttribute("type") === "tertiary", "danger is secondary, link tertiary");
  const busy = draws({ action: "submit", busy: "submitting" });
  assert(busy.getAttribute("aria-disabled") === "true" && !busy.hasAttribute("disabled"), "busy");
  assert(busy.getAttribute("data-button-action") === "submit", "the renderer hears the press by data-button-action");
});

check("summary: an error page alert holding a link per line, focusable and an alert; its echo hidden and never the place focus goes", () => {
  const moved = [];
  const entries = [{ href: "#name", text: "Name: This is a required field.", focus: () => moved.push("name") }];
  const host = draw(binding.summary(entries, { heading: "Errors were found on this page", headingId: "s", headingLevel: 2, formEntries: [{ message: "m", text: "The form could not be sent." }], locale: "en", words }));
  const box = host.querySelector(".datum-ontario-summary-box");
  const alert = host.querySelector('ontario-page-alert[type="error"]');
  assert(box.getAttribute("role") === "alert" && box.getAttribute("tabindex") === "-1" && alert.getAttribute("heading") === "Errors were found on this page", "box and alert");
  const links = [...alert.querySelectorAll("a")];
  assert(links.length === 1 && alert.querySelectorAll("li").length === 2, "one link, one text line");
  links[0].click();
  assert(moved.join() === "name", "a click moves focus through the entry");
  const echo = draw(binding.summary(entries, { heading: "x", headingId: "s2", headingLevel: 2, formEntries: [], echo: true, locale: "en", words }));
  assert(echo.querySelector("[aria-hidden=true]") !== null && echo.querySelector("[role=alert], [tabindex]") === null, "the echo is hidden and takes no focus");
  // Its links would still be tab stops inside aria-hidden (axe aria-hidden-focus): the echo is inert.
  assert(echo.querySelector(".datum-ontario-summary-box[aria-hidden=true]").hasAttribute("inert") && echo.querySelector("a") !== null, "the echo box is inert around its links");
});

check("receipt: a page alert by kind, the kind said once, an echo hidden from assistive technology", () => {
  const base = { kind: "success", title: "Sent", message: "Thank you.", details: [{ label: "Reference", value: "A1" }], echo: false, assertive: false, headingLevel: 2, kindWord: "Success: ", words };
  const host = draw(binding.notice(base));
  const alert = host.querySelector("ontario-page-alert");
  const region = host.querySelector(".datum-form__notice");
  assert(alert.getAttribute("type") === "success" && region.getAttribute("role") === "status" && region.getAttribute("tabindex") === "-1", "a focusable status region");
  assert(alert.getAttribute("heading") === "Success: Sent", `the kind word leads the title: ${alert.getAttribute("heading")}`);
  assert(alert.querySelector("dd")?.textContent === "A1", "the details");
  assert(draw(binding.notice({ ...base, kind: "info" })).querySelector("ontario-page-alert").getAttribute("type") === "informational", "info is informational");
  assert(draw(binding.notice({ ...base, kind: "error", assertive: true })).querySelector(".datum-form__notice").getAttribute("role") === "alert", "an error receipt is an alert");
  assert(draw(binding.notice({ ...base, echo: true })).querySelector(".datum-form__notice") === null, "the echo is not the region focus goes to");
  assert(draw(binding.notice({ ...base, echo: true })).querySelector(".datum-ontario-receipt[aria-hidden=true]").hasAttribute("inert"), "the echo is inert");
  const bare = draw(binding.notice({ ...base, title: undefined, message: undefined, details: [] })).querySelector("ontario-page-alert");
  assert(bare.getAttribute("heading") === "Success", `with no title the kind word heads it: ${bare.getAttribute("heading")}`);
});

check("page: the heading takes the form's level in Ontario's heading class, with the progress above it; Continue is primary, Back secondary, busy aria-disabled", () => {
  const p = { journeyId: "j", pageId: "p", title: "Your details", progress: "Page 1 of 2", headingId: "h", headingLevel: 1, next: () => undefined, back: () => undefined, backLabel: "Back", nextLabel: "Continue", final: false, busy: false, words };
  const one = draw(binding.page.heading(p));
  assert(one.querySelector("h1#h.ontario-h1")?.getAttribute("tabindex") === "-1" && one.querySelector("p")?.textContent === "Page 1 of 2", "an h1, focusable");
  assert(draw(binding.page.heading({ ...p, headingLevel: 3 })).querySelector("h3#h.ontario-h3") !== null, "an h3 under a form at level 3");
  const actions = draw(binding.page.actions({ ...p, busy: true }));
  const buttons = [...actions.querySelectorAll("ontario-button")];
  assert(buttons.map((b) => b.getAttribute("type")).join() === "primary,secondary", "Continue primary, Back secondary");
  assert(buttons.every((b) => b.getAttribute("aria-disabled") === "true" && !b.hasAttribute("disabled")), "busy is aria-disabled");
});

check("language: Ontario's toggle, given the current language; its own click is kept from it and switches the form in place", () => {
  const clicks = [];
  const host = draw(binding.languageSwitcher({ current: "en", locales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français" }], label: "Language", hideLabel: false, controlId: "l", switchTo: (code) => clicks.push(code), words }));
  const toggle = host.querySelector("ontario-language-toggle");
  assert(toggle.getAttribute("language") === "en" && toggle.getAttribute("size") === "small", "current language and size");
  const inner = dom.window.document.createElement("a");
  toggle.append(inner);
  let reached = false;
  inner.addEventListener("click", () => (reached = true));
  inner.click();
  assert(clicks.join() === "fr-CA" && !reached, `switchTo calls (${clicks}) and the click stopped before the component's own handler (${reached})`);
});

check("language: a form not in exactly one English and one French locale gets Datum's switcher, which lists every locale", () => {
  const base = { current: "en", label: "Language", hideLabel: false, controlId: "l", switchTo: () => true, words };
  for (const locales of [[{ code: "en", label: "English" }, { code: "es", label: "Español" }], [{ code: "en", label: "English" }, { code: "fr", label: "Français" }, { code: "es", label: "Español" }], [{ code: "en", label: "English" }, { code: "en-CA", label: "English (Canada)" }]]) {
    const host = draw(binding.languageSwitcher({ ...base, locales }));
    const codes = locales.map((entry) => entry.code).join();
    assert(host.querySelector("ontario-language-toggle") === null, `${codes}: no Ontario toggle`);
    assert([...host.querySelectorAll("[data-datum-switcher] option")].map((o) => o.value).join() === codes, `${codes}: Datum's switcher lists each locale`);
  }
  const pair = draw(binding.languageSwitcher({ ...base, current: "fr-CA", locales: [{ code: "en-CA", label: "English" }, { code: "fr-CA", label: "Français" }] }));
  assert(pair.querySelector("ontario-language-toggle")?.getAttribute("language") === "fr", "en-CA and fr-CA keep Ontario's toggle");
});

check("declares its side effects outside the form: <html lang> first, never as a selfCheck problem", () => {
  const effects = binding.designSystem.sideEffects;
  assert(Array.isArray(effects) && effects[0]?.target === "<html lang>" && /lang/.test(effects[0].effect), JSON.stringify(effects));
  assert(effects.every((e) => typeof e.target === "string" && typeof e.effect === "string" && e.effect.length > 20), "each names a target and says what");
});

check("kinds and plugin: the date type this package offers reads as a date, and its definition says so", () => {
  assert(JSON.stringify(ontarioKinds) === JSON.stringify({ "ontario-date": "date" }), JSON.stringify(ontarioKinds));
  const definition = ontarioPlugin.components.find((c) => c.type === "ontario-date");
  assert(definition?.base === "date" && definition.palette.binding === "ontario", "base date, offered under the ontario binding");
});

const failed = results.filter((r) => !r.ok);
console.log(`\nontario hook checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
