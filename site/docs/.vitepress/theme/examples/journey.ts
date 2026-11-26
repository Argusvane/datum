/** One form, several journeys: a picker from journeys(), moves the page hears, jumps, a deep link and a draft. */
import { bundleTags, htmlDocument, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

export const JOURNEY_DEFINITION_URL = "/forms/household-support.json";

/** Apply's pages, as the page's own links name them. */
const APPLY_PAGES = [
  { id: "you", title: "About you" },
  { id: "income", title: "Your income" },
  { id: "check", title: "Check and apply" }
];

export const journeyExample: ExampleSpec = {
  title: "A form run as a journey",
  options: [
    {
      key: "page",
      label: "Open on page",
      default: "",
      choices: [{ value: "", label: "The journey's first" }, ...APPLY_PAGES.map((page) => ({ value: page.id, label: `${page.title} (page="${page.id}")` }))]
    }
  ],
  page(options) {
    const attributes = [`id="apply"`, `src="${JOURNEY_DEFINITION_URL}"`, `draft="household-support"`];
    // A deep link: the page opens once the person may reach it, so a later one needs a draft that got there.
    if (options.page) attributes.push(`page="${options.page}"`);
    const script = [
      `const form = document.getElementById("apply");`,
      `const picker = document.getElementById("journeys");`,
      ``,
      `form.messages = { number: "Enter an amount in numbers, like 2500." };`,
      ``,
      `// Every journey the form declares, for the page's own picker. The form is built again`,
      `// when the journey changes, so the picker keeps the choice.`,
      `form.addEventListener("datum-ready", () => {`,
      `  picker.replaceChildren(`,
      `    new Option("The form's choice", ""),`,
      `    new Option("The whole form", "form"),`,
      `    ...form.journeys().map((journey) => new Option(journey.label, journey.id))`,
      `  );`,
      `  picker.value = form.getAttribute("journey") ?? "";`,
      `});`,
      ``,
      `// On load, a draft names its journey and the page reached, and holds the journey's own answers.`,
      `form.addEventListener("datum-ready", async () => {`,
      `  if (await form.hasDraft()) await form.restoreDraft();`,
      `}, { once: true });`,
      ``,
      `// Starts that journey over the answers already given; "" leaves the choice to the form.`,
      `picker.addEventListener("change", () => {`,
      `  if (picker.value) form.setAttribute("journey", picker.value);`,
      `  else form.removeAttribute("journey");`,
      `});`,
      ``,
      `// A jump reaches only the pages up to the first one not yet completed.`,
      `document.getElementById("pages").addEventListener("click", async (event) => {`,
      `  const button = event.target.closest("button[data-page]");`,
      `  if (button) console.log("goToPage", await form.goToPage(button.dataset.page));`,
      `});`,
      ``,
      `// Every move: Continue, Back, a jump, a resumed draft, the page an error opened.`,
      `form.addEventListener("datum-page-change", ({ detail }) => {`,
      `  document.getElementById("where").textContent =`,
      `    \`\${detail.title}: page \${detail.index + 1} of \${detail.total} (\${detail.direction})\`;`,
      `});`,
      ``,
      `form.addEventListener("datum-submit", async ({ detail }) => {`,
      `  if (!detail.accepted) return;`,
      `  // The envelope names the journey and carries the form's answers alone.`,
      `  console.log(detail.submission.submission.journey, detail.submission.submission.values);`,
      `  form.setNotice({ kind: "success", title: "Application received" });`,
      `  await form.clearDraft();`,
      `});`
    ];
    return htmlDocument("Household support", bundleTags("form"), [
      `    <label>Fill it as <select id="journeys"></select></label>`,
      `    <nav id="pages" aria-label="Apply's pages">`,
      ...APPLY_PAGES.map((page) => `      <button type="button" data-page="${page.id}">${page.title}</button>`),
      `    </nav>`,
      `    <p id="where" aria-live="polite"></p>`,
      `    <!-- draft: answers, the journey's page and its own fields kept in the browser under this key. -->`,
      `${openTag("datum-form", attributes)}</datum-form>`,
      ``,
      moduleScript(script)
    ]);
  }
};
