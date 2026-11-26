/**
 * A journey page the service checks on Continue (validate-url), and a delivery the service judges
 * by the same journey. The stand-in runs the real sandbox program, the same one a server runs.
 */
import { bundleTags, htmlDocument, moduleScript, openTag } from "./page";
import { runSandbox, siteFile, type SandboxOutcome } from "./sandbox";
import type { ExampleReply, ExampleSpec } from "./types";

const DEFINITION_URL = "/forms/household-support-checked.json";
const CHECK_URL = "/api/submissions/validate";

interface Definition {
  id: string;
  root: unknown;
  journey?: { journeys?: Array<{ id: string }> };
}

let definition: Promise<Definition> | undefined;

/** The service's own copy of the form: it never takes the definition or the path from the page. */
function serviceDefinition(): Promise<Definition> {
  definition ??= siteFile(DEFINITION_URL).then((text) => JSON.parse(text) as Definition);
  definition.catch(() => (definition = undefined));
  return definition;
}

type Field = { field: string | null; code: string };

/**
 * One verdict: the sandbox run over the answers with the journey, and with the page for a page's
 * check, then what only the service knows. A page's check keeps the errors of the page's fields.
 */
async function judge(values: Record<string, unknown>, locale: string, journeyId: string | undefined, page: string | undefined, refuseEmail: boolean): Promise<{ errors: Field[]; outcome?: SandboxOutcome; log: string[] }> {
  const form = await serviceDefinition();
  const journey = form.journey?.journeys?.find((entry) => entry.id === journeyId);
  if (journeyId !== undefined && !journey) return { errors: [{ field: null, code: "journey.unknown" }], log: [`no journey "${journeyId}" in the service's copy of the form`] };
  const outcome = await runSandbox({ formId: form.id, form: form.root, values, locale, ...(journey ? { journey } : {}), ...(page ? { page } : {}) });
  let errors: Field[] = outcome.errors.map((error) => ({ field: error.componentId ?? null, code: error.code }));
  const log = [`the sandbox ran${page ? ` for page "${page}"` : ""}: ${errors.length === 0 ? "no errors" : errors.map((error) => `${error.field ?? "form"} ${error.code}`).join(", ")}`];
  if (refuseEmail && typeof values.email === "string" && values.email !== "") {
    errors.push({ field: "email", code: "taken" });
    log.push(`an application under ${values.email} is already open: email taken`);
  }
  if (page && outcome.pageComponentIds) {
    const onPage = new Set(outcome.pageComponentIds);
    errors = errors.filter((error) => (error.field !== null ? onPage.has(error.field) : error.code !== "journey.exit"));
    log.push(`the page's fields, as the sandbox placed them: ${outcome.pageComponentIds.join(", ")}`);
  }
  return { errors, outcome, log };
}

export const journeyServerCheckExample: ExampleSpec = {
  title: "A journey page the service checks",
  options: [
    {
      key: "reply",
      label: "The service",
      default: "sandbox",
      choices: [
        { value: "sandbox", label: "Answers with the sandbox's verdict" },
        { value: "taken", label: "Also refuses the email (already open)" },
        { value: "unreachable", label: "Cannot be reached" }
      ]
    }
  ],
  page() {
    const attributes = [`id="apply"`, `src="${DEFINITION_URL}"`, `validate-url="${CHECK_URL}"`];
    const script = [
      `const form = document.getElementById("apply");`,
      ``,
      `// The service's own code, worded by the page.`,
      `form.messages = {`,
      `  taken: "An application under this email is already open. Use another email, or call us.",`,
      `  number: "Enter an amount in numbers, like 2500."`,
      `};`,
      ``,
      `// The envelope names the journey; the service works the path out again from the answers.`,
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
      `      body: JSON.stringify({ document: submission, submissionKey })`,
      `    });`,
      `    if (response.ok) {`,
      `      const { reference } = await response.json();`,
      `      form.setNotice({ kind: "success", title: "Application received", details: [{ label: "Reference", value: reference }] });`,
      `      return;`,
      `    }`,
      `    // A field on another page: the journey opens the page that holds it.`,
      `    const { errors } = await response.json();`,
      `    form.setErrors(errors.map((e) => ({ componentId: e.field ?? undefined, code: e.code })));`,
      `  } catch {`,
      `    form.setErrors([{ code: "delivery.failed", message: "The form could not be sent. Try again." }]);`,
      `  }`,
      `}`
    ];
    return htmlDocument("Household support", bundleTags("form"), [
      `    <!-- validate-url: where Continue asks the service to check a page whose validation says server. -->`,
      `${openTag("datum-form", attributes)}</datum-form>`,
      ``,
      moduleScript(script)
    ]);
  },
  async serve(request, options): Promise<ExampleReply | undefined> {
    if (request.method !== "POST") return undefined;
    if (request.path !== CHECK_URL && request.path !== "/api/submissions") return undefined;
    if (options.reply === "unreachable") return { fail: true };
    const refuseEmail = options.reply === "taken";
    // Both routes take the delivery: { document, submissionKey } on submit, { document, scope, pageId? } on validate.
    const delivery = JSON.parse(request.body) as { document: { submission: { values: Record<string, unknown>; locale?: string; journey?: { id: string } } }; scope?: string; pageId?: string };
    const submission = delivery.document.submission;
    const page = request.path === CHECK_URL && delivery.scope === "page" ? delivery.pageId : undefined;
    const { errors, log } = await judge(submission.values, submission.locale ?? "en", submission.journey?.id, page, refuseEmail);
    if (request.path === CHECK_URL) return { status: 200, body: { accepted: errors.length === 0, errors }, log };
    return errors.length === 0 ? { status: 200, body: { id: "sub_7f3a", reference: "HS-20417", status: "accepted", digest: "sha256:9c1e4b", handled: false }, log } : { status: 422, body: { errors }, log };
  }
};
