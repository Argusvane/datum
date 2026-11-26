import { hostCase, type CapabilityModule, type CaseContext, type Probe, type ProbeContext, type ProbeOutcome } from "../case.js";
import { CaseFailure, assume, check, expectCode, expectContains, expectEqual, expectHeader, expectMatches, expectStatus } from "../expect.js";
import { FORM, FORM_B, PDF_THEME_ID, PDF_THEME_TEXT, controlValues, envelope, envelopeFor, VERSION, wrapped } from "../fixtures.js";
import { TransportError, type Reply } from "../http.js";
import { asBoolean, asString, isRecord, path } from "../json.js";
import { setsFillColour } from "../pdf-colours.js";
import { CSRF_TOKEN, FIXTURE_FORM, REACHABLE } from "../preflight.js";

/**
 * PDF: the server PDF routes over the fixture form with the real PDF program (the Java kit's
 * PdfContract, @Order 1401-1405): posted answers print, refused answers do not, sign seals and the
 * server's chain is public, the refusals come in order (404 layout.notFound, 415, 400 pdf.notAPdf),
 * and posted answers are sealed with a test certificate, never the server's key. The two signing
 * cases are assumptions on --pdf-signing: without it they are SKIPPED, never passed. The Java
 * kit reads a PDF as text (the %PDF- header, the media type, the verify route's report); so does
 * this one, and a pdf-lib parse is not needed to hold the host to the same bytes.
 */
const post = (context: CaseContext, route: string, body: string): Promise<Reply> => context.http.send("POST", context.api(route), { contentType: "application/json", body, jsonRoute: false });

/** URLDecoder.decode(value, UTF_8): "+" is a space, "%XX" a byte. */
function decoded(reply: Reply, header: string): string | undefined {
  const value = reply.header(header);
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // URLDecoder throws on a malformed escape and the Java case fails; so does this one.
    throw new CaseFailure(`${header} ${JSON.stringify(value)} has a malformed percent escape`);
  }
}

const PDF_ROUTE: Probe = {
  id: "pdf-route",
  checks: "POST <api>/pdf with Content-Type text/plain answers 415 (the PDF routes are on), not 404",
  async run(context: ProbeContext): Promise<ProbeOutcome> {
    let reply;
    try {
      reply = await context.probe("POST", context.api("/pdf"), { contentType: "text/plain", body: "{}" });
    } catch (error) {
      if (error instanceof TransportError) return { status: "missing", message: `cannot reach ${context.target.baseUrl}: ${error.message}` };
      throw error;
    }
    const code = reply.isJson() ? String(path(reply.json(), "errors", 0, "code") ?? "") : "";
    if (reply.status === 404 && code === "") {
      return { status: "missing", message: `the PDF routes are off (POST ${reply.path} -> 404): switch them on for this test deployment (Spring Boot: datum.web.api.endpoints.pdf=true, with datum.web.api.endpoints.verify=true) or leave pdf out of --capabilities` };
    }
    if (reply.status === 415) return { status: "ok", message: "the PDF routes are on" };
    return { status: "unknown", message: `POST ${reply.path} as text/plain -> ${reply.status}${code !== "" ? ` ${code}` : ""}, not 415; the cases will tell` };
  }
};

const NEEDS_KEY = "the host holds no signing key (--pdf-signing)";
const NEEDS_ROUTES = `the host routes ${FORM_B} to a binding whose PDF theme is the kit's ${PDF_THEME_ID} and ${FORM} to one with another (--pdf-bindings)`;

/** The PDF theme `host.json`'s `bindings` gives a form route: the route's binding's catalog entry (else the default's). */
function pdfThemeOf(bindings: unknown, formKey: string): string | undefined {
  const routes = path(bindings, "routes");
  const routed = isRecord(routes) && Object.hasOwn(routes, formKey) ? routes[formKey] : undefined;
  const binding = typeof routed === "string" ? routed : asString(path(bindings, "default"));
  const catalog = path(bindings, "catalog");
  const entry = Array.isArray(catalog) ? catalog.find((candidate) => path(candidate, "id") === binding) : undefined;
  const theme = path(entry, "pdfTheme");
  return typeof theme === "string" ? theme : undefined;
}

export const PDF: CapabilityModule = {
  capability: "pdf",
  probes: [REACHABLE, CSRF_TOKEN, PDF_ROUTE, FIXTURE_FORM],
  cases: [
    hostCase({
      id: "PDF-01",
      capability: "pdf",
      order: 1401,
      oracle: "PdfContract#postedAnswersPrintAsAPdf",
      expects: "POST <api>/pdf {document: CTL-01} -> 200 application/pdf starting %PDF-, X-Page-Count >= 1; POST <api>/pdf/verify with those bytes (application/pdf) -> 200 JSON with a signatures array",
      async run(context) {
        const reply = await post(context, "/pdf", wrapped(envelope("CTL-01")));
        expectStatus(reply, 200);
        check(reply.bytesAsText().startsWith("%PDF-"), () => `the body does not start with %PDF-: ${reply.describe()}`);
        expectEqual(reply.mediaType(), "application/pdf", "the media type");
        const rawCount = expectHeader(reply, "X-Page-Count");
        // Integer.parseInt is strict, so "2 pages" fails here as it does in the Java kit.
        expectMatches(rawCount, /^[+-]?\d+$/, "X-Page-Count");
        const count = Number.parseInt(rawCount, 10);
        check(Number.isInteger(count) && count >= 1, () => `X-Page-Count ${JSON.stringify(reply.header("X-Page-Count"))} is not a page count of 1 or more`);
        const report = await context.http.send("POST", context.api("/pdf/verify"), { contentType: "application/pdf", body: reply.body });
        expectStatus(report, 200, "verify");
        check(Array.isArray(path(report.json(), "signatures")), () => `verify: no signatures array in ${report.describe()}`);
      }
    }),
    hostCase({
      id: "PDF-02",
      capability: "pdf",
      order: 1402,
      oracle: "PdfContract#answersTheServerRefusesAreNotPrinted",
      expects: "POST <api>/pdf {document: CTL-02} -> 422 required",
      async run(context) {
        const reply = await post(context, "/pdf", wrapped(envelope("CTL-02")));
        expectStatus(reply, 422);
        expectCode(reply, "required");
      }
    }),
    hostCase({
      id: "PDF-03",
      capability: "pdf",
      order: 1403,
      oracle: "PdfContract#signSealsAndTheServersChainIsPublic",
      expects: "(needs --pdf-signing) POST <api>/pdf/sign {document: CTL-01} -> 200, a non-blank X-Signed-By, %PDF- bytes; GET <api>/server/certificate -> 200 with a PEM CERTIFICATE block",
      async run(context) {
        assume(context.target.pdfSigning, NEEDS_KEY);
        const signed = await post(context, "/pdf/sign", wrapped(envelope("CTL-01")));
        expectStatus(signed, 200, "sign");
        check((decoded(signed, "X-Signed-By") ?? "").trim() !== "", () => `X-Signed-By is blank on ${signed.describe()}`);
        check(signed.bytesAsText().startsWith("%PDF-"), () => `the signed body does not start with %PDF-: ${signed.describe()}`);
        const chain = await context.http.send("GET", context.api("/server/certificate"), { jsonRoute: false });
        expectStatus(chain, 200, "the server's chain");
        expectContains(chain.text(), "-----BEGIN CERTIFICATE-----", "the server's chain");
      }
    }),
    hostCase({
      id: "PDF-04",
      capability: "pdf",
      order: 1404,
      oracle: "PdfContract#fillNeedsATemplateLayoutAndTheRefusalsComeInOrder",
      expects: "POST <api>/pdf/fill with an unknown layoutId -> 404 layout.notFound; POST <api>/pdf as text/plain -> 415; POST <api>/pdf/verify as application/json -> 415; POST <api>/pdf/verify with 'hello' as application/pdf -> 400 pdf.notAPdf",
      async run(context) {
        const document = JSON.stringify(envelope("CTL-01"));
        const noLayout = await post(context, "/pdf/fill", `{"document":${document},"layoutId":"datum-tck-no-such-layout"}`);
        expectStatus(noLayout, 404, "an unknown layout");
        expectCode(noLayout, "layout.notFound", "an unknown layout");
        expectStatus(await context.http.post(context.api("/pdf"), "text/plain", "{}"), 415, "text/plain to /pdf");
        expectStatus(await context.http.post(context.api("/pdf/verify"), "application/json", "{}"), 415, "application/json to /pdf/verify");
        const notPdf = await context.http.post(context.api("/pdf/verify"), "application/pdf", "hello");
        expectStatus(notPdf, 400, "bytes that are not a PDF");
        expectCode(notPdf, "pdf.notAPdf", "bytes that are not a PDF");
      }
    }),
    hostCase({
      id: "PDF-05",
      capability: "pdf",
      order: 1405,
      oracle: "PdfContract#postedAnswersAreSealedWithATestCertificateNeverTheServersKey",
      expects: "(needs --pdf-signing) POST <api>/pdf {document: CTL-01} -> 200, X-Signed-By holds 'Datum test seal', a non-blank X-Signature-Field; POST <api>/pdf/verify -> 200 with exactly one signature, intact",
      async run(context) {
        assume(context.target.pdfSigning, NEEDS_KEY);
        const reply = await post(context, "/pdf", wrapped(envelope("CTL-01")));
        expectStatus(reply, 200);
        // The answers were posted, not submitted: the server's key does not vouch for them.
        expectContains(decoded(reply, "X-Signed-By") ?? "", "Datum test seal", "X-Signed-By");
        check((decoded(reply, "X-Signature-Field") ?? "").trim() !== "", () => `X-Signature-Field is blank on ${reply.describe()}`);
        const report = await context.http.send("POST", context.api("/pdf/verify"), { contentType: "application/pdf", body: reply.body });
        expectStatus(report, 200, "verify");
        const signatures = path(report.json(), "signatures");
        check(Array.isArray(signatures) && signatures.length === 1, () => `verify: expected one signature in ${report.describe()}`);
        check(asBoolean(path(signatures, 0, "intact")), () => `the signature is not intact: ${JSON.stringify(signatures)}`);
      }
    }),
    hostCase({
      id: "PDF-06",
      capability: "pdf",
      order: 1406,
      oracle: "PdfContract#twoRoutesOnOneHostGetEachRoutesCatalogPdfTheme",
      expects:
        `(needs --pdf-bindings) GET <assets>/host.json -> a bindings table whose catalog gives ${FORM_B} the kit's PDF theme ${PDF_THEME_ID} (fixture-pdf-theme.json) and ${FORM} another; POST <api>/pdf {document: CTL-01} for each form -> 200 with X-Datum-Pdf-Theme equal to that route's catalog theme, and the PDF of ${FORM_B}, only that one, drawn with the theme's text colour ${PDF_THEME_TEXT} (a fill colour in its content streams)`,
      async run(context) {
        assume(context.target.pdfBindings, NEEDS_ROUTES);
        const host = await context.http.send("GET", `${context.target.baseUrl}${context.target.assetsPath}/host.json`, {});
        expectStatus(host, 200, "host.json");
        const bindings = path(host.json(), "bindings");
        check(isRecord(bindings), () => `host.json publishes no bindings table: ${host.describe()}`);
        const wanted = [FORM, FORM_B].map((form) => ({ form, theme: pdfThemeOf(bindings, form) }));
        for (const { form, theme } of wanted) {
          check(theme !== undefined, () => `the catalog gives the route ${form} no PDF theme: ${JSON.stringify(bindings)}`);
        }
        check(wanted[0]?.theme !== wanted[1]?.theme, () => `both routes resolve to the PDF theme ${String(wanted[0]?.theme)}: configure one fixture form with another binding`);
        check(
          wanted[1]?.theme === PDF_THEME_ID,
          () => `the route ${FORM_B} resolves to the PDF theme ${String(wanted[1]?.theme)}, not the kit's ${PDF_THEME_ID}: route it to a binding whose PDF theme is ${PDF_THEME_ID}, supplied from the kit's fixture-pdf-theme.json (datum-host-check fixtures --out)`
        );
        for (const { form, theme } of wanted) {
          const reply = await post(context, "/pdf", wrapped(envelopeFor(form, VERSION, controlValues("CTL-01"))));
          expectStatus(reply, 200, `the PDF of ${form}`);
          check(reply.bytesAsText().startsWith("%PDF-"), () => `the body does not start with %PDF-: ${reply.describe()}`);
          expectEqual(decoded(reply, "X-Datum-Pdf-Theme"), theme, `X-Datum-Pdf-Theme of ${form}`);
          // What the PDF was drawn under, not what the header says: the kit's theme draws its text in PDF_THEME_TEXT.
          const drawn = setsFillColour(reply.body, PDF_THEME_TEXT);
          if (theme === PDF_THEME_ID) {
            check(drawn, () => `the PDF of ${form} is not drawn under ${PDF_THEME_ID}: no fill colour ${PDF_THEME_TEXT} in its content streams, although the reply names the theme (the host does not carry the route's PDF theme into the request)`);
          } else {
            check(!drawn, () => `the PDF of ${form} is drawn with ${PDF_THEME_ID}'s text colour ${PDF_THEME_TEXT}, but its route's PDF theme is ${String(theme)}`);
          }
        }
      }
    })
  ]
};
