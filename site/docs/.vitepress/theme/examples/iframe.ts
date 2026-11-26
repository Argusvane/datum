/** A form on a page of its own, framed by another page: the two talk through postMessage. */
import { SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript } from "./page";
import type { ExampleSpec } from "./types";

const FRAMED_PATH = "/embed/intake.html";

function framedPage(): string {
  return htmlDocument(
    "Customer intake",
    [...bundleTags("form"), `<style>body { margin: 0; }</style>`],
    [
      `    <datum-form id="intake" src="${SAMPLE_DEFINITION_URL}" language-switcher></datum-form>`,
      ``,
      moduleScript([
        `// The origin of the page that frames this one. Here both pages are on one site;`,
        `// for a form framed by another site, name that site's origin instead.`,
        `const host = location.origin;`,
        `const tell = (message) => window.parent.postMessage(message, host);`,
        ``,
        `const form = document.getElementById("intake");`,
        `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
        ``,
        `// The frame cannot size itself: report the page's height whenever it changes.`,
        `new ResizeObserver(() => tell({ type: "intake:height", height: document.body.offsetHeight })).observe(document.body);`,
        ``,
        `// This page delivers the answers itself, then tells the host only what it needs to know.`,
        `form.addEventListener("datum-submit", async ({ detail }) => {`,
        `  if (!detail.accepted) return;`,
        `  const response = await fetch("/api/submissions", {`,
        `    method: "POST",`,
        `    headers: { "content-type": "application/json" },`,
        `    body: JSON.stringify({ document: detail.submission, submissionKey: detail.submissionKey })`,
        `  });`,
        `  if (!response.ok) {`,
        `    form.setErrors([{ code: "delivery.failed", message: "The form could not be sent. Try again." }]);`,
        `    return;`,
        `  }`,
        `  const { reference } = await response.json();`,
        `  form.setNotice({ kind: "success", title: "Application received", details: [{ label: "Confirmation number", value: reference }] });`,
        `  tell({ type: "intake:submitted", reference });`,
        `});`
      ])
    ]
  );
}

export const iframeExample: ExampleSpec = {
  title: "A page that frames a form",
  options: [
    { key: "reply", label: "Server reply", default: "accepted", choices: [{ value: "accepted", label: "Accepted (200)" }, { value: "refused", label: "Refused (500)" }] }
  ],
  page() {
    return htmlDocument(
      "Apply",
      [`<style>#intake { display: block; width: 100%; border: 0; }</style>`],
      [
        `    <h1>Apply</h1>`,
        `    <p id="status">Not sent yet.</p>`,
        `    <iframe id="intake" src="${FRAMED_PATH}" title="Customer intake"></iframe>`,
        ``,
        moduleScript([
          `const frame = document.getElementById("intake");`,
          ``,
          `window.addEventListener("message", (event) => {`,
          `  // Only the framed page, and only from the origin it is served on.`,
          `  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;`,
          `  if (event.data.type === "intake:height") {`,
          `    frame.style.height = event.data.height + "px";`,
          `  }`,
          `  if (event.data.type === "intake:submitted") {`,
          `    document.getElementById("status").textContent = "Sent. Confirmation " + event.data.reference + ".";`,
          `  }`,
          `});`
        ])
      ]
    );
  },
  files() {
    return [{ title: "embed/intake.html", lang: "html", path: FRAMED_PATH, code: framedPage() }];
  },
  serve(request, options) {
    if (request.method !== "POST" || request.path !== "/api/submissions") return undefined;
    return options.reply === "refused" ? { status: 500, body: { errors: [{ code: "internal" }] } } : { status: 200, body: { id: "sub_7f3a", reference: "GC-48213", status: "accepted", digest: "sha256:9c1e4b", handled: false } };
  }
};
