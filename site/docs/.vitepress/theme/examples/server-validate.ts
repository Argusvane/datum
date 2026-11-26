/** Validation on the server: the page delivers the envelope, the endpoint runs the sandbox program and answers with codes. */
import RULES from "../../../snippets/server/validate/intake-rules.js?raw";

import { SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import { json, logLine, rejected, serverForm, validate, type Envelope } from "./server-stand-in";
import type { ExampleSpec } from "./types";

const RULES_PATH = "/rules/intake-rules.js";
// What the rules read beside the values, as the endpoint sets it: the page's copy is the page's, the server's has the say.
const PHONE_COUNTRIES = ["CA", "US"];

/** Words for the codes the server answers with, and for the one a run that could not finish gives. */
const MESSAGES = {
  required: { default: "This field is required.", locales: { "fr-CA": "Ce champ est requis." } },
  "custom.fullNameIncomplete": { default: "Enter your first and last name.", locales: { "fr-CA": "Entrez votre prénom et votre nom." } },
  "custom.phoneNotOffered": {
    default: "Phone contact is not offered in that country yet.",
    locales: { "fr-CA": "Le contact par téléphone n'est pas encore offert dans ce pays." }
  },
  "wasm.execution_error": { default: "Validation could not run. Try again.", locales: { "fr-CA": "La validation n'a pas pu s'exécuter. Réessayez." } }
};

export const serverValidateExample: ExampleSpec = {
  title: "A page whose server validates the answers",
  options: [{ key: "browser", label: "Run the same rules in the browser too", default: false }],
  page(options) {
    const attributes = [`id="intake"`, `src="${SAMPLE_DEFINITION_URL}"`];
    if (options.browser) attributes.push(`wasm="auto"`);
    const script = [
      `const form = document.getElementById("intake");`,
      `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
      ``,
      `// The server answers with codes, as the browser's sandbox does; these word them per language.`,
      `form.messages = ${jsLiteral(MESSAGES)};`,
      ``
    ];
    if (options.browser) {
      script.push(
        `// The same rules the server runs, from the one file both read: refused here first, confirmed there.`,
        `fetch("${RULES_PATH}").then((response) => response.text()).then((source) => {`,
        `  form.wasmPlugins = [{ id: "intake-rules", version: "1.0.0", source }];`,
        `});`,
        `form.wasmExternalData = () => ({ phoneCountries: ${jsLiteral(PHONE_COUNTRIES)} });`,
        ``
      );
    }
    script.push(
      `form.addEventListener("datum-submit", ({ detail }) => {`,
      `  if (!detail.accepted) return; // the form shows its own validation errors`,
      `  detail.waitUntil(deliver(detail));`,
      `});`,
      ``,
      `// The server runs the same program over its own copy of the form and answers 422 with the`,
      `// same error contract, or accepts. What comes back goes into the form through setErrors.`,
      `async function deliver(detail) {`,
      `  try {`,
      `    const response = await fetch("/api/submissions", {`,
      `      method: "POST",`,
      `      headers: { "content-type": "application/json" },`,
      `      body: JSON.stringify({ document: detail.submission, submissionKey: detail.submissionKey })`,
      `    });`,
      `    if (response.ok) {`,
      `      form.setNotice({ kind: "success", title: "Received" });`,
      `      return;`,
      `    }`,
      `    // { errors: [{ field, code }] }: codes and fields, never text. The messages above word them.`,
      `    const { errors } = await response.json();`,
      `    form.setErrors(errors.map((e) => ({ componentId: e.field ?? undefined, code: e.code })));`,
      `  } catch {`,
      `    form.setErrors([{ code: "delivery.failed", message: "The form could not be sent. Try again." }]);`,
      `  }`,
      `}`
    );
    const comment = options.browser
      ? `    <!-- wasm="auto": the browser runs the same program too, so a bad submission never leaves the page. -->`
      : `    <!-- No sandbox on the page: field constraints validate in the bundle, the rules run on the server. -->`;
    return htmlDocument("Customer intake", bundleTags("form"), [comment, `${openTag("datum-form", attributes)}</datum-form>`, ``, moduleScript(script)]);
  },
  files() {
    return [{ title: "rules/intake-rules.js", lang: "javascript", path: RULES_PATH, code: RULES }];
  },
  // main.py's POST /api/submissions, step for step.
  async serve(request) {
    if (request.method !== "POST" || request.path !== "/api/submissions") return undefined;
    const body = json<{ document?: Envelope; submissionKey?: unknown }>(request.body);
    if (!body?.document?.submission || typeof body.submissionKey !== "string" || body.submissionKey === "") {
      return { status: 400, body: { errors: [{ field: null, code: "bad_document" }] } };
    }
    const form = await serverForm(SAMPLE_DEFINITION_URL);
    const outcome = await validate(form, body.document, { rules: RULES, externalData: { phoneCountries: PHONE_COUNTRIES }, logLevel: "debug" });
    // The run log comes back inside the outcome; the endpoint forwards it to its own logger.
    const log = (outcome.logs ?? []).map(logLine);
    if (outcome.errors.length > 0) return rejected(outcome, log);
    return { status: 200, body: { ok: true }, log: [...log, `stored the sanitised values under ${body.submissionKey}: ${JSON.stringify(outcome.values ?? {})}`] };
  }
};
