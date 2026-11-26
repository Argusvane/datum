/** A PDF from the server: the endpoint validates the envelope, renders the record with the PDF program and answers with the bytes. */
import { SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript } from "./page";
import { COUNTRIES, env, failed, json, pdfKernel, rejected, serverForm, validate, warningLines, type Envelope } from "./server-stand-in";
import type { ExampleSpec } from "./types";

const ENDPOINT = "/api/submissions/pdf";

export const SERVER_MESSAGES = {
  required: { default: "This field is required.", locales: { "fr-CA": "Ce champ est requis." } }
};

export interface PdfPageText {
  endpoint: string;
  /** What the link saves the file as. */
  fileName: string;
  /** The link's text. */
  save: string;
  /** Names the frame the PDF is shown in. */
  frameTitle: string;
  /** What the delivery comment says comes back. */
  answer: string[];
  /** Markup placed between the link and the frame. */
  between?: string[];
  /** Lines of the delivery that run once the PDF is shown. */
  after?: string[];
}

/** The page every PDF example's reader writes: the form, a place for the PDF, and the delivery. */
export function pdfPage(text: PdfPageText): string {
  const script = [
    `const form = document.getElementById("intake");`,
    `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
    ``,
    `// The endpoint validates before anything else; a 422 carries codes, which these word.`,
    `form.messages = ${jsLiteral(SERVER_MESSAGES)};`,
    ``,
    `form.addEventListener("datum-submit", ({ detail }) => {`,
    `  if (!detail.accepted) return; // the form shows its own validation errors`,
    `  detail.waitUntil(deliver(detail));`,
    `});`,
    ``,
    ...text.answer.map((line) => `// ${line}`),
    `async function deliver(detail) {`,
    `  try {`,
    `    const response = await fetch("${text.endpoint}", {`,
    `      method: "POST",`,
    `      headers: { "content-type": "application/json" },`,
    `      body: JSON.stringify(detail.submission)`,
    `    });`,
    `    if (response.status === 422) {`,
    `      // { errors: [{ field, code }] }: the server's verdict, worded by the messages above.`,
    `      const { errors } = await response.json();`,
    `      form.setErrors(errors.map((e) => ({ componentId: e.field ?? undefined, code: e.code })));`,
    `      return;`,
    `    }`,
    `    if (!response.ok) throw new Error(response.statusText);`,
    `    const pdf = await response.blob();`,
    `    // The bytes as an address the page can show and offer: an iframe draws a PDF in place.`,
    `    const url = URL.createObjectURL(pdf);`,
    `    Object.assign(document.getElementById("record"), { src: url, hidden: false });`,
    `    Object.assign(document.getElementById("save"), { href: url, hidden: false });`,
    ...(text.after ?? []).map((line) => `    ${line}`),
    `  } catch {`,
    `    form.setErrors([{ code: "delivery.failed", message: "The form could not be sent. Try again." }]);`,
    `  }`,
    `}`
  ];
  return htmlDocument(
    "Customer intake",
    [...bundleTags("form"), `<style>#record { width: 100%; height: 640px; border: 1px solid #c8ccd0; }</style>`],
    [
      `    <datum-form id="intake" src="${SAMPLE_DEFINITION_URL}" language-switcher></datum-form>`,
      ``,
      `    <!-- Where the PDF the server answers with lands: offered as a file and shown in the page. -->`,
      `    <p><a id="save" hidden download="${text.fileName}">${text.save}</a></p>`,
      ...(text.between ?? []).map((line) => `    ${line}`),
      `    <iframe id="record" title="${text.frameTitle}" hidden></iframe>`,
      ``,
      moduleScript(script)
    ]
  );
}

export const serverPdfExample: ExampleSpec = {
  title: "A page whose server renders the record as a PDF",
  options: [],
  page() {
    return pdfPage({
      endpoint: ENDPOINT,
      fileName: "customer-intake.pdf",
      save: "Save the PDF",
      frameTitle: "The submission as a PDF",
      answer: [
        `Deliver the envelope. What comes back is the PDF itself, application/pdf: the record as the`,
        `server rendered it, in the submission's language.`
      ]
    });
  },
  // main.py's POST /api/submissions/pdf, step for step.
  async serve(request) {
    if (request.method !== "POST" || request.path !== ENDPOINT) return undefined;
    const envelope = json<Envelope>(request.body);
    if (!envelope?.submission) return { status: 400, body: { errors: [{ field: null, code: "bad_document" }] } };
    const form = await serverForm(SAMPLE_DEFINITION_URL);
    // Validation first, so the PDF prints the sanitised values: what the form defines, nothing else.
    const outcome = await validate(form, envelope);
    if (outcome.errors.length > 0) return rejected(outcome);
    const locale = envelope.submission.locale ?? "en";
    const { provider, fonts } = await pdfKernel();
    try {
      const result = await provider.document({
        abi: provider.abiVersion,
        op: "document",
        form: form.root,
        ...(form.pdf ? { pdf: form.pdf } : {}),
        values: outcome.values ?? {},
        locale,
        optionSnapshot: { country: COUNTRIES },
        fonts,
        options: { compact: false },
        env: env()
      });
      return {
        status: 200,
        type: "application/pdf",
        body: result.bytes,
        log: [`rendered ${result.pageCount} page(s) in ${locale}`, ...warningLines(result.warnings)]
      };
    } catch (error) {
      return failed(error);
    }
  }
};
