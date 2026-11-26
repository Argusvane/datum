// Checks of the form-level hooks the tester's host does not mount (the language links, the host's
// receipt, the required note, a summary's echo, a journey page's heading level): each hook is
// called with a state, drawn by lit-html into jsdom, and read. The binding is the built bundle
// (dist/nova-scotia.js: run `npm run build` first), given lit the way a host gives it.
//   node bindings/nova-scotia/tests/hooks.mjs
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
const litHtml = await import(pathToFileURL(engineRequire.resolve("lit-html")).href);
const { ifDefined } = await import(pathToFileURL(engineRequire.resolve("lit-html/directives/if-defined.js")).href);
const { live } = await import(pathToFileURL(engineRequire.resolve("lit-html/directives/live.js")).href);
const lit = { html: litHtml.html, svg: litHtml.svg, nothing: litHtml.nothing, live, repeat: () => undefined, ifDefined, ref: () => undefined, unsafeSVG: () => undefined };
const { createBinding } = await import(pathToFileURL(join(here, "..", "dist", "nova-scotia.js")).href);
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

check("language: the current language is text, the others are links that switch the form", () => {
  const clicks = [];
  const host = draw(binding.languageSwitcher({ current: "en", locales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }], label: "Language", hideLabel: false, controlId: "l", switchTo: (code) => clicks.push(code), words }));
  assert(host.querySelector("nav")?.getAttribute("aria-label") === "Language", "the nav is named");
  assert(host.querySelector('[aria-current="true"]')?.textContent === "English", "the current language is text");
  const link = host.querySelector("a[hreflang=fr]");
  assert(link?.textContent === "Français" && link.getAttribute("lang") === "fr", "the other language is a link in its own language");
  link.click();
  assert(clicks.join() === "fr", `switchTo calls: ${clicks}`);
});

check("receipt: the alert block with the glyph of its kind, the kind said once, an echo hidden from assistive technology", () => {
  const state = { kind: "success", title: "Sent", message: "Thank you.", details: [{ label: "Reference", value: "A1" }], echo: false, assertive: false, headingLevel: 2, kindWord: "Success:", words };
  const host = draw(binding.notice(state));
  const block = host.querySelector(".alert-block");
  assert(block !== null && block.getAttribute("role") === "status" && block.getAttribute("tabindex") === "-1", "a focusable status block");
  assert(block.querySelector("i.fa-check-circle") !== null, "the success glyph");
  assert(block.querySelector("h2")?.textContent.replace(/\s+/g, " ").trim() === "Success: Sent", `the title is a heading at the receipt's level with the kind word first: ${block.querySelector("h2")?.textContent}`);
  assert(block.querySelector("dt")?.textContent === "Reference" && block.querySelector("dd")?.textContent === "A1", "the details are drawn");
  const echo = draw(binding.notice({ ...state, echo: true })).querySelector(".alert-block");
  assert(echo.getAttribute("aria-hidden") === "true" && !echo.hasAttribute("role"), "the echo is aria-hidden with no role");
  const failed = draw(binding.notice({ ...state, kind: "error", assertive: true })).querySelector(".alert-block");
  assert(failed.getAttribute("role") === "alert" && failed.querySelector("i.fa-exclamation-circle") !== null, "an error receipt is an alert with the error glyph");
  const warning = draw(binding.notice({ ...state, kind: "warning" })).querySelector("i.fa-exclamation-triangle");
  assert(warning !== null, "the warning glyph");
});

check("required note: the asterisk in the sentence is an abbr with the form's title", () => {
  const host = draw(binding.requiredNote({ note: "Fields marked with * are required.", words }));
  const mark = host.querySelector("p abbr");
  assert(mark?.textContent === "*" && mark.getAttribute("title") === "required", "the asterisk is abbr[title=required]");
  assert(host.textContent === "Fields marked with * are required.", `the sentence is whole: ${host.textContent}`);
});

check("summary: the heading takes the summary's level; the echo is hidden and takes no focus", () => {
  const entries = [{ href: "#a", targetPath: "a", componentId: "a", label: "A", message: "Bad", text: "A: Bad", authored: false, focus: () => undefined }];
  const state = { heading: "1 error", formEntries: [{ message: "Form", text: "The form is wrong" }], headingId: "h", headingLevel: 3, locale: "en", words };
  const host = draw(binding.summary(entries, state));
  assert(host.querySelector("h3#h strong")?.textContent === "1 error", "h3 with the id the renderer gave, its words bold as the library's alert writes them");
  assert(host.querySelector(".alert-block")?.getAttribute("role") === "alert", "the alert role");
  assert([...host.querySelectorAll("li")].map((li) => li.textContent.trim()).join("|") === "The form is wrong|A: Bad", "form-level text first, then one link per field error");
  assert(host.querySelectorAll("li a").length === 1, "the form-level error is text, not a link");
  const echo = draw(binding.summary(entries, { ...state, echo: true })).querySelector(".alert-block");
  assert(echo.getAttribute("aria-hidden") === "true" && !echo.hasAttribute("role") && !echo.hasAttribute("tabindex"), "the echo is aria-hidden, no role, no tabindex");
});

check("page: the heading is at the form's level, with the progress caption; a redirected page says so; busy is aria-disabled; the last page's button is the green submit", () => {
  const page = { journeyId: "j", pageId: "p", title: "Your name", description: "Tell us.", progress: "Page 1 of 3", headingId: "ph", headingLevel: 2, next: () => undefined, back: () => undefined, backLabel: "Back", nextLabel: "Continue", final: false, busy: true, redirected: true, words };
  const heading = draw(binding.page.heading(page));
  assert(heading.querySelector("h2#ph[data-journey-heading][tabindex='-1']") !== null, "h2 with the heading hook");
  assert(heading.querySelector("[data-journey-progress]")?.textContent.startsWith("Page 1 of 3"), "the progress caption");
  assert(heading.querySelector("[role=status]")?.textContent === "Redirected.", "the redirect line");
  const actions = draw(binding.page.actions(page));
  const next = actions.querySelector("[data-journey-continue]");
  assert(next?.getAttribute("aria-disabled") === "true" && !next.hasAttribute("disabled"), "busy Continue is aria-disabled, never disabled");
  assert(next.classList.contains("btn-default") && actions.querySelector(".btn-clear[data-journey-back]") !== null, "Continue is the default button, Back the clear one");
  const last = draw(binding.page.actions({ ...page, final: true, busy: false })).querySelector("[data-journey-continue]");
  assert(last.classList.contains("btn-success"), "the last page's button is btn-success");
});

const failed = results.filter((r) => !r.ok);
console.log(`\nnova-scotia hook checks: ${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
