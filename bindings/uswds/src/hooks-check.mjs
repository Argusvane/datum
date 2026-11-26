// Checks of the form-level hooks the tester's host does not mount (the language selector, the
// host's receipt, the required note, a summary's echo, a journey page's heading level): each hook
// is called with a state, drawn by lit-html into jsdom, and read. The binding is the built bundle
// (dist/uswds.js: run `npm run build` first), given lit the way a host gives it.
//   node bindings/uswds/src/hooks-check.mjs
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
const { createBinding } = await import(pathToFileURL(join(here, "..", "dist", "uswds.js")).href);
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

check("language: two languages draw USWDS's one button, naming the other language in itself", () => {
  const clicks = [];
  const host = draw(binding.languageSwitcher({ current: "en", locales: [{ code: "en", label: "English" }, { code: "es", label: "Spanish" }], label: "Language", hideLabel: false, controlId: "l", switchTo: (code) => clicks.push(code), words }));
  const button = host.querySelector(".usa-language-container > button.usa-button");
  assert(button !== null, "no usa-language-container > button.usa-button");
  assert(button.textContent.trim() === "Español" && button.querySelector("[lang]").getAttribute("lang") === "es", `button: ${button.textContent}`);
  button.click();
  assert(clicks.join() === "es", `switchTo calls: ${clicks}`);
});

check("language: three languages draw a list of unstyled buttons, the current one as text", () => {
  const host = draw(binding.languageSwitcher({ current: "en", locales: [{ code: "en", label: "English" }, { code: "es", label: "Spanish" }, { code: "fr", label: "French" }], label: "Language", hideLabel: false, controlId: "l", switchTo: () => true, words }));
  assert(host.querySelectorAll("button.usa-button--unstyled").length === 2, "two buttons for the other two languages");
  assert(host.querySelector('[aria-current="true"]')?.textContent.trim() === "English", "the current language is text");
  assert(host.querySelector('[role="group"]')?.getAttribute("aria-label") === "Language", "the group is named");
});

check("receipt: a usa-alert by kind, the kind said once, an echo hidden from assistive technology", () => {
  const state = { kind: "success", title: "Sent", message: "Thank you.", details: [{ label: "Reference", value: "A1" }], echo: false, assertive: false, headingLevel: 2, kindWord: "Success:", words };
  const host = draw(binding.notice(state));
  const alert = host.querySelector(".usa-alert--success");
  assert(alert !== null && alert.getAttribute("role") === "status" && alert.getAttribute("tabindex") === "-1", "a focusable status alert");
  assert(alert.querySelector("h2.usa-alert__heading")?.textContent === "Sent", "the title is the alert heading at the receipt's level");
  assert(alert.textContent.replace(/\s+/g, " ").includes("Success: Sent"), `the kind word leads the title: ${alert.textContent}`);
  assert(alert.querySelector("dt")?.textContent === "Reference" && alert.querySelector("dd")?.textContent === "A1", "the details are drawn");
  const echo = draw(binding.notice({ ...state, echo: true })).querySelector(".usa-alert");
  assert(echo.getAttribute("aria-hidden") === "true" && !echo.hasAttribute("role"), "the echo is aria-hidden with no role");
  const failed = draw(binding.notice({ ...state, kind: "error", assertive: true })).querySelector(".usa-alert--error");
  assert(failed?.getAttribute("role") === "alert", "an error receipt is an alert");
});

check("required note: the asterisk in the sentence is USWDS's abbr", () => {
  const host = draw(binding.requiredNote({ note: "Required fields are marked with an asterisk (*).", words }));
  const mark = host.querySelector("p abbr.usa-hint--required");
  assert(mark?.textContent === "*" && mark.getAttribute("title") === "required", "the asterisk is abbr[title=required]");
  assert(host.textContent === "Required fields are marked with an asterisk (*).", `the sentence is whole: ${host.textContent}`);
});

check("summary: the heading takes the summary's level; the echo is hidden and takes no focus", () => {
  const entries = [{ href: "#a", targetPath: "a", componentId: "a", label: "A", message: "Bad", text: "A: Bad", authored: false, focus: () => undefined }];
  const state = { heading: "1 error", formEntries: [], headingId: "h", headingLevel: 3, locale: "en", words };
  const host = draw(binding.summary(entries, state));
  assert(host.querySelector("h3.usa-alert__heading#h") !== null, "h3 with the id the renderer gave");
  assert(host.querySelector(".usa-alert--error")?.getAttribute("role") === "alert", "the alert role");
  const echo = draw(binding.summary(entries, { ...state, echo: true })).querySelector(".usa-alert");
  assert(echo.getAttribute("aria-hidden") === "true" && !echo.hasAttribute("role") && !echo.hasAttribute("tabindex"), "the echo is aria-hidden, no role, no tabindex");
});

check("page: the heading is at the form's level, with the progress caption; a redirected page says so; busy is aria-disabled", () => {
  const page = { journeyId: "j", pageId: "p", title: "Your name", description: "Tell us.", progress: "Page 1 of 3", headingId: "ph", headingLevel: 2, next: () => undefined, back: () => undefined, backLabel: "Back", nextLabel: "Continue", final: false, busy: true, redirected: true, words };
  const heading = draw(binding.page.heading(page));
  assert(heading.querySelector("h2#ph[data-journey-heading][tabindex='-1']") !== null, "h2 with the heading hook");
  assert(heading.querySelector("[data-journey-progress]")?.textContent.startsWith("Page 1 of 3"), "the progress caption");
  assert(heading.querySelector("[role=status]")?.textContent === "Redirected.", "the redirect line");
  const actions = draw(binding.page.actions(page));
  assert(actions.querySelector("[data-journey-continue]")?.getAttribute("aria-disabled") === "true" && !actions.querySelector("[data-journey-continue]").hasAttribute("disabled"), "busy Continue is aria-disabled, never disabled");
  assert(actions.querySelector(".usa-button--outline[data-journey-back]") !== null, "Back is the outline button");
});

const failed = results.filter((r) => !r.ok);
console.log(`\nuswds hook checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
