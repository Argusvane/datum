/** An existing PDF filled on the server: the endpoint writes the answers into an AcroForm it keeps and answers with the filled file. */
import { pdfPage } from "./server-pdf";
import { COUNTRIES, env, failed, json, pdfKernel, rejected, serverBytes, serverForm, toBase64, validate, warningLines, type Envelope } from "./server-stand-in";
import type { ExampleSpec } from "./types";

const ENDPOINT = "/api/submissions/fill";
/** The server's copy of the form: the sample with its template layout. */
export const TEMPLATE_FORM_PATH = "/forms/customer-intake-template.json";
/** The AcroForm the server fills, kept beside its definitions. */
export const TEMPLATE_PDF_PATH = "/templates/customer-intake.pdf";
const LAYOUT_ID = "intake-template";

export const serverFillExample: ExampleSpec = {
  title: "A page whose server fills an existing PDF",
  options: [],
  page() {
    return pdfPage({
      endpoint: ENDPOINT,
      fileName: "customer-intake-filled.pdf",
      save: "Save the filled PDF",
      frameTitle: "The existing form, filled in",
      answer: [
        `Deliver the envelope. What comes back is the PDF the server already had, its fields filled`,
        `with the answers and left editable: the server's say, not the page's.`
      ]
    });
  },
  // main.py's POST /api/submissions/fill, step for step.
  async serve(request) {
    if (request.method !== "POST" || request.path !== ENDPOINT) return undefined;
    const envelope = json<Envelope>(request.body);
    if (!envelope?.submission) return { status: 400, body: { errors: [{ field: null, code: "bad_document" }] } };
    const form = await serverForm(TEMPLATE_FORM_PATH);
    const outcome = await validate(form, envelope);
    if (outcome.errors.length > 0) return rejected(outcome);
    const layout = form.pdf?.layouts.find((candidate) => candidate.id === LAYOUT_ID);
    if (!layout) return failed(new Error(`The server's form has no layout ${LAYOUT_ID}`));
    const [{ provider, fonts }, template] = await Promise.all([pdfKernel(), serverBytes(TEMPLATE_PDF_PATH)]);
    try {
      const result = await provider.document({
        abi: provider.abiVersion,
        op: "document",
        form: form.root,
        // The template layout, inline, with this server's fill options: the fields left editable.
        layout: { ...layout, options: { flatten: false, readOnly: false, appearances: "regenerate" } },
        // The PDF to fill: the bytes the layout's source names, resolved by the server.
        template: { data: toBase64(template) },
        values: outcome.values ?? {},
        locale: envelope.submission.locale ?? "en",
        optionSnapshot: { country: COUNTRIES },
        fonts,
        env: env()
      });
      // The fill report, one line per mapped field, as main.py logs it.
      const report = (result.fields ?? []).map((field) => `${field.status} ${field.pdfField} (${field.kind ?? "-"})`);
      return {
        status: 200,
        type: "application/pdf",
        body: result.bytes,
        log: [`filled ${result.pageCount} page(s) of the template`, ...report, ...warningLines(result.warnings)]
      };
    } catch (error) {
      return failed(error);
    }
  }
};
