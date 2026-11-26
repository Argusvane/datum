// Checks of the form-level hooks the tester's host does not mount (the language selector, the
// host's receipt, the required note, a summary's echo, a journey page's heading level): each hook
// is called with a state, drawn by lit-html into jsdom, and read. The binding is the built bundle
// (dist/bootstrap.js: run `npm run build` first), given lit the way a host gives it.
//   node bindings/bootstrap/src/hooks-check.mjs
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
const litHtml = await import(pathToFileURL(createRequire(join(repo, "engine", "package.json")).resolve("lit-html")).href);
const ifDefined = (await import(pathToFileURL(createRequire(join(repo, "engine", "package.json")).resolve("lit-html/directives/if-defined.js")).href)).ifDefined;
const live = (await import(pathToFileURL(createRequire(join(repo, "engine", "package.json")).resolve("lit-html/directives/live.js")).href)).live;
const lit = { html: litHtml.html, svg: litHtml.svg, nothing: litHtml.nothing, live, repeat: () => undefined, ifDefined, ref: () => undefined, unsafeSVG: () => undefined };
const { createBinding } = await import(pathToFileURL(join(here, "..", "dist", "bootstrap.js")).href);
const binding = createBinding(lit, { components: {} });

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
const words = Object.assign((key) => ({ required: "*", requiredTitle: "required", noticeSuccess: "Success: ", pageRedirected: "Redirected." })[key] ?? key, { plural: (key) => key });

const state = (extra = {}) => ({
  key: "f", componentId: "f", type: "text", base: "text", kind: "text", id: "f", name: "f", valuePath: "f", label: "City", labelId: "f__label", hideLabel: false,
  value: "", answer: "", required: false, readOnly: false, disabled: false, invalid: false, errors: [], notices: [], describedBy: [], pending: false, busy: undefined,
  overLimit: false, locale: "en", dir: "ltr", classNames: [], reveal: [], mode: "interactive", words, text: () => undefined, model: {}, ...extra
});
const on = { input: () => undefined, parts: () => undefined, commit: () => undefined };

check("pending: degraded; the renderer's word in the hint describes the control, Bootstrap's spinner beside it hidden; none when it is not", () => {
  assert(Object.values(binding.components).every((adapter) => adapter.capabilities?.pending === undefined || adapter.capabilities.pending === "degraded"), "every adapter answers pending degraded");
  // The state as the renderer hands it for a degraded pending: the word folded into the hint, the hint id in describedBy.
  const busy = draw(binding.components.text.template(state({ pending: true, hint: "Checking this answer…", hintId: "f__description", describedBy: ["f__description"] }), on));
  const hint = busy.querySelector("#f__description.form-text");
  assert(hint?.textContent.trim() === "Checking this answer…", `the word is the hint: ${hint?.textContent}`);
  assert(busy.querySelector("input").getAttribute("aria-describedby") === "f__description", "the hint describes the control");
  const spin = hint.querySelector(".spinner-border.spinner-border-sm");
  assert(spin?.getAttribute("aria-hidden") === "true", "a hidden spinner-border in the hint line");
  assert(busy.querySelector("[role=status]") === null, "no status line of its own (its word would describe nothing)");
  assert(draw(binding.components.text.template(state(), on)).querySelector(".spinner-border") === null, "no spinner when nothing is pending");
});

check("worked out: a journey page's line is form text under its own id", () => {
  const host = draw(binding.components.text.template(state({ workedOut: "Worked out from your answers.", workedOutId: "f__worked-out", describedBy: ["f__worked-out"] }), on));
  const line = host.querySelector("#f__worked-out.form-text");
  assert(line?.textContent === "Worked out from your answers." && host.querySelector("input").getAttribute("aria-describedby") === "f__worked-out", "the line is form text and describes the control");
});

check("required: the mark is text-danger and hidden from assistive technology; the control says it itself", () => {
  const host = draw(binding.components.text.template(state({ required: true }), on));
  const mark = host.querySelector("label .text-danger");
  assert(mark?.textContent === "*" && mark.getAttribute("aria-hidden") === "true", "the asterisk");
  assert(host.querySelector("input").required, "the control is required");
});

const options = [{ value: "a", label: "A", id: "f__0", checked: false }, { value: "b", label: "B", id: "f__1", checked: true }];
check("required: each radio carries required (Bootstrap's validation page) and the legend's mark is hidden; a checkbox group's and a date's legend read the mark out", () => {
  const radios = draw(binding.components.radio.template(state({ type: "radio", required: true, options }), on));
  assert([...radios.querySelectorAll("input[type=radio]")].every((input) => input.required), "every radio is required");
  assert(radios.querySelector("legend .text-danger")?.getAttribute("aria-hidden") === "true", "the radio legend's mark is hidden");
  const boxes = draw(binding.components.checkboxes.template(state({ type: "checkboxes", required: true, options, selected: ["b"] }), on));
  const boxMark = boxes.querySelector("legend .text-danger");
  assert(boxMark?.textContent === "*" && !boxMark.hasAttribute("aria-hidden"), "the checkbox group's mark is read out");
  const date = draw(binding.components.date.template(state({ type: "date", required: true, parts: { year: "", month: "", day: "" }, missingParts: [] }), on));
  const dateMark = date.querySelector("legend .text-danger");
  assert(dateMark?.textContent === "*" && !dateMark.hasAttribute("aria-hidden"), "the date's mark is read out");
});

check("date: the part boxes write no maxlength (the contract: an over-long part is raised by validation, never cut off)", () => {
  const date = draw(binding.components.date.template(state({ type: "date", parts: { year: "", month: "", day: "" }, missingParts: [] }), on));
  assert(date.querySelectorAll("[data-value-part]").length === 3, "three part boxes");
  assert(date.querySelector("[maxlength]") === null, "no maxlength");
});

check("focus: a summary link to radios lands on the checked radio, else the first", () => {
  const checked = draw(binding.components.radio.template(state({ type: "radio", options }), on));
  for (const input of checked.querySelectorAll("input")) input.checked = input.value === "b";
  assert(binding.components.radio.focusTarget(checked)?.value === "b", "the checked radio");
  const none = draw(binding.components.radio.template(state({ type: "radio", options: options.map((o) => ({ ...o, checked: false })) }), on));
  for (const input of none.querySelectorAll("input")) input.checked = false;
  assert(binding.components.radio.focusTarget(none)?.value === "a", "the first radio when none is checked");
});

check("input group: has-validation only while a feedback sits in it (its corners need it only then)", () => {
  const plain = draw(binding.components.text.template(state({ prefix: "$" }), on));
  assert(plain.querySelector(".input-group") !== null && plain.querySelector(".input-group.has-validation") === null, "no has-validation without an error");
  const bad = draw(binding.components.text.template(state({ prefix: "$", invalid: true, errors: ["Enter it."], errorId: "f__error", describedBy: ["f__error"] }), on));
  assert(bad.querySelector(".input-group.has-validation > .invalid-feedback#f__error") !== null && bad.querySelector("input.is-invalid") !== null, "the feedback sits in the group after an is-invalid input");
});

check("radios: the feedback is the last option's, after the last is-invalid input, as Bootstrap's validation examples write it", () => {
  const options = [{ id: "r-a", value: "a", label: "A", checked: false }, { id: "r-b", value: "b", label: "B", checked: false }];
  const host = draw(binding.components.radio.template(state({ type: "radio", base: "radio", kind: "choice", options, invalid: true, errors: ["Choose one."], errorId: "f__error", describedBy: ["f__error"] }), on));
  const last = host.querySelectorAll(".form-check")[1];
  assert(last.querySelector("input.is-invalid") !== null && last.querySelector(".invalid-feedback#f__error")?.textContent === "Choose one.", "the feedback follows the last option's input");
  assert(host.querySelectorAll(".invalid-feedback").length === 1, "one feedback line");
  assert(host.querySelector("fieldset").getAttribute("aria-describedby") === "f__error", "the fieldset is described by it");
});

check("button: Datum's variants are Bootstrap's contextual buttons; busy is aria-disabled with the disabled look, never disabled", () => {
  const draws = (extra) => draw(binding.components.button.template(state({ type: "button", base: "button", kind: undefined, label: "Go", ...extra }), on)).querySelector("button");
  assert(draws({}).className === "btn btn-primary", `default: ${draws({}).className}`);
  assert(draws({ variant: "danger" }).className === "btn btn-danger" && draws({ variant: "unknown" }).className === "btn btn-primary", "variants");
  const busy = draws({ action: "submit", busy: "submitting" });
  assert(busy.getAttribute("aria-disabled") === "true" && busy.classList.contains("disabled") && !busy.hasAttribute("disabled"), "busy");
});

check("language: a btn-group of one button per language, the current one active and not a switch; each names itself in its own language", () => {
  const clicks = [];
  const host = draw(binding.languageSwitcher({ current: "en", locales: [{ code: "en", label: "English" }, { code: "es", label: "Spanish" }, { code: "fr", label: "French" }], label: "Language", hideLabel: false, controlId: "l", switchTo: (code) => clicks.push(code), words }));
  const buttons = [...host.querySelectorAll(".btn-group > button.btn")];
  assert(buttons.length === 3 && host.querySelector('[role="group"]')?.getAttribute("aria-label") === "Language", "three buttons in a named group");
  assert(buttons[0].classList.contains("active") && buttons[0].getAttribute("aria-current") === "true", "the current language is active");
  assert(buttons[1].querySelector("[lang]").getAttribute("lang") === "es" && buttons[1].textContent.trim() === "Español", `the second names itself: ${buttons[1].textContent}`);
  buttons[0].click();
  buttons[1].click();
  assert(clicks.join() === "es", `switchTo calls (the current one is not a switch): ${clicks}`);
});

check("receipt: an alert by kind (error is danger), the kind said once, an echo hidden from assistive technology", () => {
  const state = { kind: "success", title: "Sent", message: "Thank you.", details: [{ label: "Reference", value: "A1" }], echo: false, assertive: false, headingLevel: 2, kindWord: "Success:", words };
  const host = draw(binding.notice(state));
  const alert = host.querySelector(".alert-success");
  assert(alert !== null && alert.getAttribute("role") === "status" && alert.getAttribute("tabindex") === "-1", "a focusable status alert");
  assert(alert.querySelector("h2.alert-heading")?.textContent.includes("Sent"), "the title is the alert heading at the receipt's level");
  assert(alert.textContent.replace(/\s+/g, " ").includes("Success: Sent"), `the kind word leads the title: ${alert.textContent}`);
  assert(alert.querySelector("dt")?.textContent === "Reference" && alert.querySelector("dd")?.textContent === "A1", "the details are drawn");
  const echo = draw(binding.notice({ ...state, echo: true })).querySelector(".alert");
  assert(echo.getAttribute("aria-hidden") === "true" && !echo.hasAttribute("role"), "the echo is aria-hidden with no role");
  const failed = draw(binding.notice({ ...state, kind: "error", assertive: true })).querySelector(".alert-danger");
  assert(failed?.getAttribute("role") === "alert", "an error receipt is an alert-danger with the alert role");
});

check("required note: the asterisk in the sentence is set apart as the fields carry it", () => {
  const host = draw(binding.requiredNote({ note: "Required fields are marked with an asterisk (*).", words }));
  const mark = host.querySelector("p.form-text .text-danger");
  assert(mark?.textContent === "*", "the asterisk is text-danger");
  assert(host.textContent === "Required fields are marked with an asterisk (*).", `the sentence is whole: ${host.textContent}`);
});

check("summary: the heading takes the summary's level; the echo is hidden and takes no focus", () => {
  const entries = [{ href: "#a", targetPath: "a", componentId: "a", label: "A", message: "Bad", text: "A: Bad", authored: false, focus: () => undefined }];
  const state = { heading: "1 error", formEntries: [], headingId: "h", headingLevel: 3, locale: "en", words };
  const host = draw(binding.summary(entries, state));
  assert(host.querySelector("h3.alert-heading#h") !== null, "h3 with the id the renderer gave");
  assert(host.querySelector(".alert-danger")?.getAttribute("role") === "alert" && host.querySelector("a.alert-link") !== null, "the alert role and alert-links");
  const echo = draw(binding.summary(entries, { ...state, echo: true })).querySelector(".alert");
  assert(echo.getAttribute("aria-hidden") === "true" && !echo.hasAttribute("role") && !echo.hasAttribute("tabindex"), "the echo is aria-hidden, no role, no tabindex");
});

check("page: the heading is at the form's level, with the progress caption; a redirected page says so; busy is aria-disabled", () => {
  const page = { journeyId: "j", pageId: "p", title: "Your name", description: "Tell us.", progress: "Page 1 of 3", headingId: "ph", headingLevel: 2, next: () => undefined, back: () => undefined, backLabel: "Back", nextLabel: "Continue", final: false, busy: true, redirected: true, words };
  const heading = draw(binding.page.heading(page));
  assert(heading.querySelector("h2#ph[data-journey-heading][tabindex='-1']") !== null, "h2 with the heading hook");
  assert(heading.querySelector("[data-journey-progress]")?.textContent.startsWith("Page 1 of 3"), "the progress caption");
  assert(heading.querySelector("[role=status]")?.textContent === "Redirected.", "the redirect line");
  const actions = draw(binding.page.actions(page));
  const next = actions.querySelector("[data-journey-continue]");
  assert(next?.getAttribute("aria-disabled") === "true" && next.classList.contains("disabled") && !next.hasAttribute("disabled"), "busy Continue is aria-disabled with the disabled look, never disabled");
  assert(actions.querySelector(".btn-outline-secondary[data-journey-back]") !== null, "Back is the outline button");
});

const failed = results.filter((r) => !r.ok);
console.log(`\nbootstrap hook checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
