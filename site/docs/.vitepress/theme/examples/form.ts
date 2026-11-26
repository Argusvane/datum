/** `<datum-form>` on a page of its own: what the page sets, what it hears and what it answers. */
import { SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

const MESSAGES = {
  required: { default: "This field is required.", locales: { "fr-CA": "Ce champ est requis." } }
};

const CONFIRMATION = "GC-48213";
const PLACES: Record<string, string[]> = { top: ["top"], bottom: ["bottom"], both: ["top", "bottom"] };

/** The receipt as the page's script spells it, its value the variable the reply was read into. */
function receipt(placement: string, indent: string): string {
  const notice = {
    kind: "success",
    placement: PLACES[placement],
    title: { default: "Application received", locales: { "fr-CA": "Demande reçue" } },
    message: { default: "Keep this number for your records.", locales: { "fr-CA": "Conservez ce numéro pour vos dossiers." } },
    details: [{ label: { default: "Confirmation number", locales: { "fr-CA": "Numéro de confirmation" } }, value: "__number__" }]
  };
  return jsLiteral(notice, indent).replace(`"__number__"`, "reference");
}

export const formExample: ExampleSpec = {
  title: "A page with a form",
  options: [
    { key: "locale", label: "Locale", default: "en", choices: [{ value: "en", label: "English" }, { value: "fr-CA", label: "Français" }] },
    { key: "mode", label: "Mode", default: "interactive", choices: [{ value: "interactive", label: "Interactive" }, { value: "readonly", label: "Read-only" }] },
    { key: "frame", label: "Frame", default: "none", choices: [{ value: "none", label: "The page sets none" }, { value: "seamless", label: "Seamless" }, { value: "outlined", label: "Outlined" }, { value: "paper", label: "Paper" }] },
    { key: "languageSwitcher", label: "Language switcher", default: true },
    { key: "draft", label: "Draft autosave", default: false },
    { key: "reply", label: "Server reply", default: "accepted", choices: [{ value: "accepted", label: "Accepted (200)" }, { value: "rejected", label: "Rejects a field (422)" }, { value: "unreachable", label: "Unreachable" }] },
    { key: "placement", label: "Receipt placement", default: "top", choices: [{ value: "top", label: "Top of the form" }, { value: "bottom", label: "Bottom, beside the button" }, { value: "both", label: "Both ends" }] }
  ],
  page(options) {
    const attributes = [`id="intake"`, `src="${SAMPLE_DEFINITION_URL}"`];
    if (options.mode !== "interactive") attributes.push(`mode="${options.mode}"`);
    if (options.locale !== "en") attributes.push(`locale="${options.locale}"`);
    if (options.languageSwitcher) attributes.push("language-switcher");
    // The page's default frame; frame-fixed would make it win over the author's.
    if (options.frame !== "none") attributes.push(`frame="${options.frame}"`);
    if (options.draft) attributes.push(`draft="customer-intake"`);

    const script = [
      `const form = document.getElementById("intake");`,
      ``,
      `// Data sources are plain lists, keyed by the id a select names in its settings.`,
      `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
      ``,
      `// The page's validation text per error code and language. These win over the form's own`,
      `// messages for every code they name; the form's words stand for the codes left out.`,
      `form.messages = ${jsLiteral(MESSAGES)};`,
      ``,
      `form.addEventListener("datum-submit", async ({ detail }) => {`,
      `  if (!detail.accepted) return; // the form shows its own validation errors`,
      `  try {`,
      `    const response = await fetch("/api/submissions", {`,
      `      method: "POST",`,
      `      headers: { "content-type": "application/json" },`,
      `      body: JSON.stringify({ document: detail.submission, submissionKey: detail.submissionKey })`,
      `    });`,
      `    if (response.ok) {`,
      `      // The server's receipt, shown at the ends of the form that placement lists.`,
      `      const { reference } = await response.json();`,
      `      form.setNotice(${receipt(String(options.placement), "      ")});`,
      `      return;`,
      `    }`,
      `    // The server's verdict, back into the form: one entry per field it rejected.`,
      `    const { errors } = await response.json();`,
      `    form.setErrors(errors.map((e) => ({ componentId: e.field, code: e.code, message: e.message })));`,
      `  } catch {`,
      `    // Out of reach: an error of the form's own, listed at the top of the form.`,
      `    form.setErrors([{ code: "delivery.failed", message: "The form could not be sent. Try again." }]);`,
      `  }`,
      `});`
    ];
    if (options.draft) {
      script.push(
        ``,
        `// With a draft key, every change is saved to the browser's storage under it.`,
        `form.addEventListener("datum-ready", async () => {`,
        `  if (await form.hasDraft()) await form.restoreDraft();`,
        `});`
      );
    }
    return htmlDocument("Customer intake", bundleTags("form"), [`${openTag("datum-form", attributes)}</datum-form>`, ``, moduleScript(script)]);
  },
  serve(request, options) {
    if (request.method !== "POST" || request.path !== "/api/submissions") return undefined;
    if (options.reply === "unreachable") return { fail: true };
    if (options.reply === "rejected") {
      return { status: 422, body: { errors: [{ field: "fullName", code: "taken", message: "A record with this name already exists." }] } };
    }
    return { status: 200, body: { id: "sub_7f3a", reference: CONFIRMATION, status: "accepted", digest: "sha256:9c1e4b", handled: false } };
  }
};
