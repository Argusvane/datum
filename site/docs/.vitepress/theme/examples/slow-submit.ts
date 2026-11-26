/** A form delivering to a slow server: it locks and says so until the page's promise settles. */
import { SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

/** How long the page waits for the server before it gives up. */
const TIMEOUT_MS = 5000;
const CONFIRMATION = "GC-48213";
const DELAYS: Record<string, number> = { instant: 0, "2s": 2000, never: 15000 };
const PLACES: Record<string, string[]> = { top: ["top"], bottom: ["bottom"], both: ["top", "bottom"] };

const TEXTS = { submitting: { default: "Sending your answers…", locales: { "fr-CA": "Envoi de vos réponses…" } } };

const PLACEMENTS = [
  { value: "top", label: "Top of the form" },
  { value: "bottom", label: "Bottom, beside the button" },
  { value: "both", label: "Both ends" }
];

export const slowSubmitExample: ExampleSpec = {
  title: "A form delivering to a slow server",
  options: [
    { key: "delay", label: "Server delay", default: "2s", choices: [{ value: "instant", label: "Answers at once" }, { value: "2s", label: "Takes 2 seconds" }, { value: "never", label: "Never answers" }] },
    { key: "reply", label: "Server reply", default: "accepted", choices: [{ value: "accepted", label: "Accepted (200)" }, { value: "rejected", label: "Rejects a field (422)" }] },
    { key: "wording", label: "The page's own wording", default: true },
    { key: "statusPlacement", label: "Submitting line", default: "top", choices: PLACEMENTS },
    { key: "after", label: "After acceptance", default: "receipt", choices: [{ value: "receipt", label: "Show the receipt" }, { value: "lock", label: "Show the receipt and lock the answers" }] },
    { key: "placement", label: "Receipt placement", default: "top", choices: PLACEMENTS }
  ],
  page(options) {
    const attributes = [`id="intake"`, `src="${SAMPLE_DEFINITION_URL}"`, "language-switcher"];
    if (options.statusPlacement !== "top") attributes.push(`submitting-placement="${PLACES[String(options.statusPlacement)]!.join(" ")}"`);

    const notice = jsLiteral(
      {
        kind: "success",
        placement: PLACES[String(options.placement)],
        title: "Application received",
        details: [{ label: "Confirmation number", value: "__number__" }]
      },
      "      "
    ).replace(`"__number__"`, "reference");

    const script = [
      `const form = document.getElementById("intake");`,
      `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
      ``
    ];
    if (options.wording) {
      script.push(`// What the form says while the delivery is in flight, per language. Left out, it says "Submitting…".`, `form.texts = ${jsLiteral(TEXTS)};`, ``);
    }
    script.push(
      `// The form locks the moment Submit is pressed and stays locked until the promise handed to`,
      `// waitUntil settles. It has no timeout of its own: the signal on the fetch is the timeout.`,
      `form.addEventListener("datum-submit", ({ detail }) => {`,
      `  if (!detail.accepted) return;`,
      `  detail.waitUntil(deliver(detail.submission, detail.submissionKey));`,
      `});`,
      ``,
      `async function deliver(submission, submissionKey) {`,
      `  try {`,
      `    const response = await fetch("/api/submissions", {`,
      `      method: "POST",`,
      `      headers: { "content-type": "application/json" },`,
      `      body: JSON.stringify({ document: submission, submissionKey }),`,
      `      signal: AbortSignal.timeout(${TIMEOUT_MS})`,
      `    });`,
      `    if (response.ok) {`,
      `      const { reference } = await response.json();`,
      `      form.setNotice(${notice});`
    );
    if (options.after === "lock") script.push(`      // The answers stay as sent: read-only, the Submit button disabled.`, `      form.mode = "readonly";`);
    script.push(
      `      return;`,
      `    }`,
      `    const { errors } = await response.json();`,
      `    form.setErrors(errors.map((e) => ({ componentId: e.field, code: e.code, message: e.message })));`,
      `  } catch (error) {`,
      `    // The server did not answer in time, or could not be reached.`,
      `    console.log("gave up:", error.name);`,
      `    form.setErrors([{ code: "delivery.failed", message: "The form could not be sent. Try again." }]);`,
      `  }`,
      `}`
    );
    return htmlDocument("Customer intake", bundleTags("form"), [`${openTag("datum-form", attributes)}</datum-form>`, ``, moduleScript(script)]);
  },
  serve(request, options) {
    if (request.method !== "POST" || request.path !== "/api/submissions") return undefined;
    const delay = DELAYS[String(options.delay)] ?? 0;
    if (options.reply === "rejected") {
      return { delay, status: 422, body: { errors: [{ field: "fullName", code: "taken", message: "A record with this name already exists." }] } };
    }
    return { delay, status: 200, body: { id: "sub_7f3a", reference: CONFIRMATION, status: "accepted", digest: "sha256:9c1e4b", handled: false } };
  }
};
