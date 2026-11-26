package com.argusvane.datum.pdf.api;

import com.argusvane.datum.core.CountedAddress;
import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.pdf.PdfException;
import com.argusvane.datum.pdf.PdfFonts;
import com.argusvane.datum.pdf.PdfOptions;
import com.argusvane.datum.pdf.PdfResult;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.PdfSigner;
import com.argusvane.datum.pdf.verify.PdfVerification;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.receiver.SubmissionRejectedException;
import com.argusvane.datum.submissions.receiver.ThrottledException;
import com.argusvane.datum.submissions.service.HostContexts;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.submissions.spi.HostContextRequest;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.error.UnsupportedMediaTypeException;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.json.JsonBodies;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The PDF endpoints, written once for both web stacks: every decision is here, and
 * the MVC and WebFlux adapters only move bytes and the request view in and the {@link PdfReply} out.
 * Every method blocks (a render takes seconds): a WebFlux adapter calls them off the event loop.
 *
 * <ul>
 *   <li>{@link #pdf} ({@code POST /pdf}): posted answers judged by the receiver's dry run, then the form's PDF of
 *       the sanitized values ({@link PdfService#renderSubmission}), sealed as the preset says.</li>
 *   <li>{@link #fill} ({@code POST /pdf/fill}): the same into a template layout's PDF.</li>
 *   <li>{@link #sign} ({@code POST /pdf/sign}): the same, always sealed with the server's key.</li>
 *   <li>{@link #verify} ({@code POST /pdf/verify}): a posted PDF's signatures checked (the report).</li>
 *   <li>{@link #certificate} ({@code GET /server/certificate}): the server's signing chain, PEM.</li>
 * </ul>
 *
 * <p>The three that print answers take {@code {document, layoutId?, locale?, options?, template?}}: {@code document}
 * is the submission envelope (or a signed wrapper) as the receiver takes it; {@code options} is
 * {@code {fonts: default|standard|all, compact, tagged, pdfa}}; {@code template} ({@code {data: base64}}) is for
 * {@link #fill} only. Their order: 415, the address limit (429 {@code flood}: {@link #admitJson}, which an adapter calls
 * before it reads the body, so a body that never parses is counted too), 413, 400 (not JSON, then the shape, a fill's
 * missing {@code layoutId} included), 429 (the per-form throttle, kind {@code pdf}), 503 when the server cannot make PDFs now (bytecode runner, no PDF
 * program), then the receiver's dry run in PDF mode with its own order (it adds no count), 422 when it does not
 * accept the answers, then the render. Who may print is the application's security in front of the routes
 * (framework-first: on Spring, {@code DatumRequestMatchers.pdf()}), so a refused caller learns nothing of the
 * server's state; a rule that depends on the form the document names is the receiver's
 * {@code SubmissionPreCheck}, which the PDF mode's dry run asks too. No sandbox run is spent on a request the server would refuse anyway. The PDF
 * answers carry {@code X-Page-Count}, {@code X-Datum-Layout}, {@code X-Datum-Pdf-Theme} (the PDF theme the form's binding suggests) and, when sealed, {@code X-Signed-By},
 * {@code X-Signature-Field}, {@code X-Timestamped} (the Java sign sample's headers), every value printable ASCII.
 *
 * <p>Whose key seals: the answers these endpoints print were never submitted (they passed the receiver's dry run,
 * nothing stored them), so by default they are sealed as the dry run's PDFs are, with a throwaway
 * {@link com.argusvane.datum.pdf.TestSeal} certificate and never the server's key
 * ({@link PdfService.SealMode#TEST}; {@link #sign} {@link PdfService.SealMode#TEST_FORCE}): a seal of the server's
 * says "this server issued this", and anyone allowed to post answers could otherwise collect PDFs certified by the
 * server's key. {@link Builder#serverKeySealsPostedAnswers(boolean)} turns the server's key on for an application
 * that accepts that, and records what it issues itself: {@code PdfRenderedEvent} is published after the PDF is made and
 * a listener's failure never holds the PDF back, so a record that must exist before the PDF leaves is the
 * application's own write in a {@code PdfResultValidator}, not a listener.
 * Application code that prints a stored submission calls {@link PdfService#renderSubmission} itself.
 */
public final class PdfApi {

    /** The members a print request may carry. */
    private static final Set<String> MEMBERS = Set.of("document", "layoutId", "locale", "options", "template");

    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(PdfApi.class);

    /** The members of {@code options}. */
    private static final Set<String> OPTIONS = Set.of("fonts", "compact", "tagged", "pdfa");

    /** The content types {@link #verify} reads. */
    private static final Set<String> PDF_TYPES = Set.of("application/pdf", "application/octet-stream");

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private final PdfService pdf;
    private final AnswerCheck check;
    private final Function<String, ObjectNode> definitions;
    private final SubmissionThrottle throttle;
    private final DatumJsonMapper json;
    private final long maxBodyBytes;
    private final PdfDocumentSources sources;
    private final PdfTemplateSource templates;
    private final boolean serverKey;
    private final HostContextProvider hostContext;

    private PdfApi(Builder b) {
        this.pdf = Objects.requireNonNull(b.pdf, "pdf");
        this.check = Objects.requireNonNull(b.check, "check");
        this.definitions = Objects.requireNonNull(b.definitions, "definitions");
        this.throttle = b.throttle;
        this.json = Objects.requireNonNull(b.json, "json");
        if (b.maxBodyBytes <= 0) {
            throw new IllegalArgumentException("The body cap is above zero.");
        }
        this.maxBodyBytes = b.maxBodyBytes;
        this.sources = b.sources == null ? PdfDocumentSources.NONE : b.sources;
        this.templates = b.templates == null ? PdfTemplateSource.NONE : b.templates;
        this.serverKey = b.serverKey;
        this.hostContext = b.hostContext;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** The cap a web adapter reads a JSON body under ({@code datum.web.api.max-body-size}). */
    public long maxBodyBytes() {
        return maxBodyBytes;
    }

    /** The cap a web adapter reads a posted PDF under ({@code datum.runtime.verify-max-bytes}). */
    public long maxPdfBytes() {
        return pdf.verifyMaxBytes();
    }

    /** {@code POST /pdf}: the form's PDF of the posted answers, once the server accepts them. */
    public PdfReply pdf(byte[] body, SubmissionRequest request) {
        Printed printed = judge(body, request, false);
        PdfResult result = pdf.renderSubmission(printed.definition(), printed.values(), printed.locale(), printed.layoutId(), printed.options(),
            serverKey ? PdfService.SealMode.PRESET : PdfService.SealMode.TEST);
        return pdfReply(result, printed.formKey(), printed.layoutId(), "", pdf.pdfThemeId(printed.formKey()));
    }

    /**
     * {@code POST /pdf/fill}: the answers written into a template layout's PDF. The template is the host's
     * ({@link PdfTemplateSource}) when it has one for the layout, else the posted {@code template.data}, else the
     * layout's inline source; a posted template is never sealed with the server's key. The layout must be a template
     * layout: for a generated one the program would print that layout and ignore the posted bytes, and a posted
     * template would then have decided that a server-made PDF goes out unsealed (400 {@code layout.notTemplate}).
     */
    public PdfReply fill(byte[] body, SubmissionRequest request) {
        Printed printed = judge(body, request, true);
        ObjectNode layout = layoutOf(printed.definition(), printed.layoutId());
        if (layout == null) {
            throw PdfException.layoutNotFound();
        }
        if (!PdfService.isTemplateLayout(printed.definition(), printed.layoutId())) {
            throw PdfException.layoutNotTemplate();
        }
        byte[] own = templates.template(printed.formKey(), printed.layoutId(), layout);
        byte[] template = own != null ? own : printed.template();
        PdfResult result = pdf.fillSubmission(printed.definition(), printed.values(), printed.locale(), printed.layoutId(), template,
            own == null && printed.template() != null, printed.options(), serverKey ? PdfService.SealMode.PRESET : PdfService.SealMode.TEST);
        return pdfReply(result, printed.formKey(), printed.layoutId(), "-filled", pdf.pdfThemeId(printed.formKey()));
    }

    /**
     * {@code POST /pdf/sign}: the form's PDF of the posted answers, always sealed: with a throwaway test certificate
     * by default, with the server's key when {@link Builder#serverKeySealsPostedAnswers(boolean)} says so. Offered
     * only on a server that signs PDFs (503 otherwise: a server that signs nothing makes no test seal either).
     */
    public PdfReply sign(byte[] body, SubmissionRequest request) {
        if (pdf.signer() == null) {
            // Before the body is judged: no sandbox run for a request this server cannot answer.
            throw new com.argusvane.datum.pdf.PdfUnavailableException("This server has no PDF signing key (datum.pdf.signing.*).");
        }
        Printed printed = judge(body, request, false);
        PdfResult result = pdf.renderSubmission(printed.definition(), printed.values(), printed.locale(), printed.layoutId(), printed.options(),
            serverKey ? PdfService.SealMode.FORCE : PdfService.SealMode.TEST_FORCE);
        return pdfReply(result, printed.formKey(), printed.layoutId(), "-signed", pdf.pdfThemeId(printed.formKey()));
    }

    /**
     * {@code POST /pdf/verify}: a posted PDF ({@code application/pdf}) checked: 415 and the address limit
     * ({@link #admitPdf}, before the adapter reads the file), 413 past {@link #maxPdfBytes()}, the throttle (kind
     * {@code pdf}), 400 for a file that is not a PDF, then the report.
     * Who may verify is the application's security in front of the route ({@code DatumRequestMatchers.pdfVerify()} on
     * Spring).
     */
    public PdfReply verify(byte[] body, SubmissionRequest request) {
        requirePdfContent(request.contentType());
        if (body.length > pdf.verifyMaxBytes()) {
            throw fileTooLarge();
        }
        throttle(request, null);
        PdfVerification report = pdf.verify(body);
        return new PdfReply(200, "application/json", Map.of("Cache-Control", "no-store"), json.mapper().writeValueAsBytes(report));
    }

    /**
     * What an adapter asks before it reads the body of {@link #pdf}, {@link #fill} or {@link #sign}: 415 for a body
     * that is not JSON by its Content-Type, then the address limit ({@link SubmissionThrottle#admitAddress}: 429
     * {@code flood} with {@code Retry-After}, the per-form refusal's answer). The per-form count needs the form the
     * document names, so it runs after the parse; this one counts every request first, whether or not its body parses.
     */
    public void admitJson(SubmissionRequest request) {
        JsonBodies.requireJson(request.contentType());
        admitAddress(request);
    }

    /** As {@link #admitJson} for {@link #verify}: 415 unless the body is a PDF by its Content-Type, then the address limit. */
    public void admitPdf(SubmissionRequest request) {
        requirePdfContent(request.contentType());
        admitAddress(request);
    }

    /** The address limit: as the per-form refusal on these routes, a 429 with no event. */
    private void admitAddress(SubmissionRequest request) {
        ThrottleDecision.Deny deny = SubmissionThrottle.admitAddress(throttle, request.remoteAddress());
        if (deny != null) {
            throw new ThrottledException(deny.retryAfter());
        }
    }

    /**
     * The 415 for a verify body that is not {@code application/pdf} (or {@code application/octet-stream}). The web
     * adapters call it before they read a byte ({@link #admitPdf}), so the order stays 415, then 413.
     */
    public void requirePdfContent(String contentType) {
        String type = mediaType(contentType);
        if (type == null || !PDF_TYPES.contains(type)) {
            throw new UnsupportedMediaTypeException();
        }
    }

    /** The 413 for a posted PDF past {@link #maxPdfBytes()}. */
    public RequestTooLargeException fileTooLarge() {
        return new RequestTooLargeException(pdf.verifyMaxBytes(), "The file is larger than " + pdf.verifyMaxBytes() + " bytes.");
    }

    /**
     * {@code GET /server/certificate}: the server's PDF signing chain, PEM, leaf first, so a verifier can trust it.
     *
     * @throws DatumException 404 {@code certificate.notFound} when the server has no signing key
     */
    public PdfReply certificate(SubmissionRequest request) {
        PdfSigner signer = pdf.signer();
        if (signer == null) {
            throw new DatumException("certificate.notFound", 404, "This server has no PDF signing certificate.");
        }
        StringBuilder pem = new StringBuilder();
        for (X509Certificate certificate : signer.chain()) {
            pem.append(TsaKey.pem(certificate));
        }
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Disposition", "attachment; filename=\"server-certificate.pem\"");
        headers.put("Cache-Control", "no-cache");
        return new PdfReply(200, "application/x-pem-file", headers, pem.toString().getBytes(StandardCharsets.US_ASCII));
    }

    // ------------------------------------------------------------------------------------------------- judging

    /** A print request after its checks: the form, the sanitized answers, the layout, the locale, the options. */
    record Printed(String formKey, ObjectNode definition, ObjectNode values, String locale, String layoutId, PdfOptions options,
                   byte[] template) {
    }

    /** The checks every print endpoint makes, in order, then the receiver's dry run. */
    private Printed judge(byte[] body, SubmissionRequest request, boolean allowTemplate) {
        Objects.requireNonNull(body, "body");
        Objects.requireNonNull(request, "request");
        // 415, then the cap, then JSON (the adapters read under the same rules; this is the backstop).
        JsonBodies.requireJson(request.contentType());
        if (body.length > maxBodyBytes) {
            throw JsonBodies.tooLarge(maxBodyBytes);
        }
        JsonNode parsed = JsonBodies.parse(json, body);
        if (!parsed.isObject()) {
            throw new BadRequestException("bad_request", "The request is an object with a document.");
        }
        for (String name : parsed.propertyNames()) {
            if (!MEMBERS.contains(name) || (name.equals("template") && !allowTemplate)) {
                // Fixed words: a 4xx body never repeats what the caller sent; the name is for the log.
                LOG.debug("Datum PDF: a print request had the member {}.", name);
                throw new BadRequestException("bad_request", "The request has a member it does not take.");
            }
        }
        JsonNode document = parsed.get("document");
        if (document == null || !document.isObject()) {
            throw new BadRequestException("bad_request", "The request carries the submission as document.");
        }
        // The dry run judges a re-serialised copy, and Jackson writes 1e999 back as the string "Infinity": refuse a number
        // JSON cannot write back here, with the receiver's own 400, before the copy hides it.
        if (SubmissionReceiver.hasNonFiniteNumber(document)) {
            throw new BadRequestException("bad_request", "The submission holds a number outside the range of a number.");
        }
        String layoutId = optionalText(parsed, "layoutId");
        if (allowTemplate && layoutId == null) {
            // The shape, before the throttle or any sandbox run.
            throw new BadRequestException("bad_request", "Name the template layout to fill (layoutId).");
        }
        String locale = optionalText(parsed, "locale");
        PdfOptions options = options(parsed.get("options"));
        byte[] template = allowTemplate ? template(parsed.get("template")) : null;
        // A signed wrapper carries the envelope as its payload: read as the receiver reads it (any payload
        // member makes a wrapper), so the form checked here is the form the dry run judges.
        JsonNode envelope = document.has("payload") ? document.get("payload") : document;
        JsonNode formId = envelope.path("versionContext").path("form").path("id");
        String formKey = formId.isString() && FormKeys.isValid(formId.stringValue()) ? formId.stringValue() : null;
        // A form the document does not name, or names wrongly, is the receiver's to refuse (400, 404).
        throttle(request, formKey);
        // 503 before the dry run: a server that cannot print now spends no validation run on the request.
        pdf.requireAvailable();
        ObjectNode dryRun = NODES.objectNode();
        dryRun.set("document", document);
        CheckedAnswers checked = check.check(request, json.mapper().writeValueAsBytes(dryRun));
        if (!checked.accepted() || checked.values() == null) {
            // Only answers the server accepts are rendered; the browser maps the 422's errors as a delivery's.
            // Every finding listed, warnings included, as the receiver's own 422 lists them.
            throw new SubmissionRejectedException(checked.stage() == null ? "sandbox" : checked.stage(), checked.errors());
        }
        if (formKey == null) {
            throw new BadRequestException("bad_request", "The document names no form.");
        }
        ObjectNode definition = definitions.apply(formKey);
        String chosenLocale = locale != null ? locale : envelopeLocale(envelope);
        JsonNode translations = sources.translations(formKey);
        ObjectNode snapshot = sources.optionSnapshot(formKey, definition, checked.values(), chosenLocale, request.principal());
        PdfOptions full = options.withFormKey(formKey).withTranslations(translations).withOptionSnapshot(snapshot)
            .withHostContext(hostContextOf(formKey, definition, request));
        return new Printed(formKey, definition, checked.values(), chosenLocale, layoutId, full, template);
    }

    /**
     * The host context the PDF is drawn under: the provider asked again with the facts the dry run gave it, so
     * a provider that decides from the request gives the print the values the answers were judged under. Never the
     * browser's: nothing of the body is read for it. A provider that fails refuses the print (503
     * {@code server.unavailable}), as it refused the check.
     */
    private ObjectNode hostContextOf(String formKey, ObjectNode definition, SubmissionRequest request) {
        if (hostContext == null) {
            return null;
        }
        JsonNode version = definition.path("version");
        try {
            return HostContexts.ask(hostContext, new HostContextRequest(formKey, version.isString() ? version.stringValue() : "",
                SubmissionMode.PDF, request.toContext(null)));
        } catch (HostContexts.Failed e) {
            LOG.error("{}", e.getMessage(), e.getCause());
            throw new ProgramUnavailableException("The host context provider failed.", e);
        }
    }

    private void throttle(SubmissionRequest request, String formKey) {
        if (throttle == null) {
            return;
        }
        // Counted as the submission routes count an address (an IPv6 client by its /64), under the PDF kind.
        ThrottleKey key = new ThrottleKey(CountedAddress.of(request.remoteAddress()), formKey, request.principalName(), ThrottleKey.Kind.PDF);
        ThrottleDecision decision = throttle.check(key);
        if (decision instanceof ThrottleDecision.Deny deny) {
            throw new ThrottledException(deny.retryAfter());
        }
        throttle.record(key);
    }

    /** The envelope's locale when it is a language tag, else "en" (the receiver's reading). */
    private static String envelopeLocale(JsonNode envelope) {
        JsonNode locale = envelope.path("submission").path("locale");
        return locale.isString() && locale.stringValue().matches("^[A-Za-z0-9-]{1,32}$") ? locale.stringValue() : "en";
    }

    private static String optionalText(JsonNode parsed, String name) {
        JsonNode value = parsed.get(name);
        if (value == null || value.isNull()) {
            return null;
        }
        if (!value.isString() || value.stringValue().isEmpty() || value.stringValue().length() > 128) {
            throw new BadRequestException("bad_request", name + " is a non-empty string.");
        }
        if (name.equals("locale") && !value.stringValue().matches("^[A-Za-z0-9-]{1,32}$")) {
            throw new BadRequestException("bad_request", "locale is a language tag.");
        }
        return value.stringValue();
    }

    private static PdfOptions options(JsonNode node) {
        PdfOptions options = PdfOptions.defaults();
        if (node == null || node.isNull()) {
            return options;
        }
        if (!node.isObject()) {
            throw new BadRequestException("bad_request", "options is an object.");
        }
        for (String name : node.propertyNames()) {
            if (!OPTIONS.contains(name)) {
                LOG.debug("Datum PDF: a print request's options had the member {}.", name);
                throw new BadRequestException("bad_request", "options has a member it does not take.");
            }
        }
        JsonNode fonts = node.get("fonts");
        if (fonts != null && !fonts.isNull()) {
            PdfFonts.Pack pack = fonts.isString() ? PdfFonts.Pack.parse(fonts.stringValue()) : null;
            if (pack == null) {
                throw new BadRequestException("bad_request", "options.fonts is default, standard or all.");
            }
            options = options.withFonts(pack);
        }
        Boolean compact = flag(node, "compact");
        Boolean tagged = flag(node, "tagged");
        JsonNode pdfa = node.get("pdfa");
        if (pdfa != null && !pdfa.isNull() && !pdfa.isObject() && !(pdfa.isBoolean() && !pdfa.booleanValue())) {
            throw new BadRequestException("bad_request", "options.pdfa is a PDF/A claim or false.");
        }
        return options.withRenderOptions(compact, tagged, pdfa == null || pdfa.isNull() ? null : pdfa.deepCopy());
    }

    private static Boolean flag(JsonNode node, String name) {
        JsonNode value = node.get(name);
        if (value == null || value.isNull()) {
            return null;
        }
        if (!value.isBoolean()) {
            throw new BadRequestException("bad_request", "options." + name + " is true or false.");
        }
        return value.booleanValue();
    }

    private static byte[] template(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isObject() || !node.path("data").isString()) {
            throw new BadRequestException("bad_request", "template is {data: base64}.");
        }
        try {
            byte[] bytes = Base64.getDecoder().decode(node.path("data").stringValue());
            if (bytes.length == 0) {
                throw new BadRequestException("bad_request", "template.data is empty.");
            }
            return bytes;
        } catch (IllegalArgumentException e) {
            throw new BadRequestException("bad_request", "template.data is not base64.");
        }
    }

    private static ObjectNode layoutOf(ObjectNode definition, String layoutId) {
        JsonNode layouts = definition.path("pdf").path("layouts");
        for (JsonNode layout : layouts.isArray() ? layouts.values() : List.<JsonNode>of()) {
            if (layout.isObject() && layout.path("id").isString() && layout.path("id").stringValue().equals(layoutId)) {
                return (ObjectNode) layout;
            }
        }
        return null;
    }

    private static String mediaType(String contentType) {
        if (contentType == null || contentType.isBlank()) {
            return null;
        }
        return contentType.split(";")[0].strip().toLowerCase(Locale.ROOT);
    }

    // ------------------------------------------------------------------------------------------------- replies

    /**
     * A PDF answer: the file, its name ({@code <form>-<layout><suffix>.pdf}, letters, digits, "." "_" and "-" only, so
     * the name is safe in a Content-Disposition header) and the headers.
     */
    static PdfReply pdfReply(PdfResult result, String formKey, String asked, String suffix) {
        return pdfReply(result, formKey, asked, suffix, null);
    }

    /**
     * {@link #pdfReply(PdfResult, String, String, String)} naming the PDF theme the form's binding suggests
     * ({@code X-Datum-Pdf-Theme}, the host catalog's id for it; none when the binding suggests none).
     */
    static PdfReply pdfReply(PdfResult result, String formKey, String asked, String suffix, String pdfThemeId) {
        Map<String, String> headers = new LinkedHashMap<>();
        String layout = !result.layoutId().isEmpty() ? result.layoutId() : (asked != null ? asked : PdfService.DEFAULT_LAYOUT);
        headers.put("Content-Disposition", "attachment; filename=\"" + filename(formKey + "-" + layout + suffix) + "\"");
        headers.put("Cache-Control", "no-store");
        headers.put("X-Page-Count", String.valueOf(result.pageCount()));
        // The layout id comes from the definition: printable ASCII only, so both web stacks can write it as given.
        headers.put("X-Datum-Layout", headerSafe(result.layoutId()));
        if (pdfThemeId != null) {
            headers.put("X-Datum-Pdf-Theme", headerSafe(pdfThemeId));
        }
        if (result.seal() != null) {
            headers.put("X-Signed-By", headerSafe(result.seal().subject()));
            headers.put("X-Signature-Field", headerSafe(result.seal().field()));
            headers.put("X-Timestamped", String.valueOf(result.seal().timestamped()));
        }
        for (JsonNode warning : result.warnings()) {
            if ("sealing.unavailable".equals(warning.path("code").asString(""))) {
                headers.put("X-Datum-Seal-Note", java.net.URLEncoder.encode(warning.path("message").asString(""), StandardCharsets.UTF_8));
            }
        }
        return new PdfReply(200, "application/pdf", headers, result.bytes());
    }

    static String filename(String name) {
        String safe = name.replaceAll("[^A-Za-z0-9._-]+", "-");
        safe = safe.replaceAll("^[-.]+|[-.]+$", "");
        return (safe.isEmpty() ? "submission" : safe) + ".pdf";
    }

    /** A header value of printable ASCII: anything else percent-encoded, so a certificate's name cannot split headers. */
    private static String headerSafe(String text) {
        StringBuilder out = new StringBuilder();
        for (byte b : (text == null ? "" : text).getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if (c >= 0x20 && c < 0x7f && c != '%') {
                out.append((char) c);
            } else {
                out.append('%').append(String.format("%02X", c));
            }
        }
        return out.toString();
    }

    // ------------------------------------------------------------------------------------------------- builder

    /** Builds a {@link PdfApi}. */
    public static final class Builder {

        private PdfService pdf;
        private AnswerCheck check;
        private Function<String, ObjectNode> definitions;
        private SubmissionThrottle throttle;
        private DatumJsonMapper json;
        private long maxBodyBytes;
        private PdfDocumentSources sources;
        private PdfTemplateSource templates;
        private boolean serverKey;
        private HostContextProvider hostContext;

        private Builder() {
        }

        public Builder pdf(PdfService pdf) {
            this.pdf = pdf;
            return this;
        }

        /** How posted answers are judged ({@link AnswerCheck#of} over the receiver). */
        public Builder check(AnswerCheck check) {
            this.check = check;
            return this;
        }

        /** The current full definition of a form key ({@code FormNotFoundException} when there is none). */
        public Builder definitions(Function<String, ObjectNode> definitions) {
            this.definitions = definitions;
            return this;
        }

        /** datum-forms' definitions: the current full definition. */
        public Builder definitions(DefinitionService service) {
            Objects.requireNonNull(service, "service");
            this.definitions = key -> service.current(key).definition();
            return this;
        }

        /** The throttle, or null for none. */
        public Builder throttle(SubmissionThrottle throttle) {
            this.throttle = throttle;
            return this;
        }

        public Builder json(DatumJsonMapper json) {
            this.json = json;
            return this;
        }

        public Builder maxBodyBytes(long maxBodyBytes) {
            this.maxBodyBytes = maxBodyBytes;
            return this;
        }

        public Builder sources(PdfDocumentSources sources) {
            this.sources = sources;
            return this;
        }

        public Builder templates(PdfTemplateSource templates) {
            this.templates = templates;
            return this;
        }

        /**
         * Whether the server's key seals the PDFs of posted answers (POST /pdf and /pdf/fill under the preset, and
         * /pdf/sign always). Off by default: those answers were never submitted, so they get a throwaway test
         * certificate ({@link PdfService.SealMode#TEST}). Turn it on only where anyone allowed
         * to post answers may have them certified by this server.
         */
        public Builder serverKeySealsPostedAnswers(boolean serverKey) {
            this.serverKey = serverKey;
            return this;
        }

        /**
         * Where the print's {@code hostContext} comes from: the same {@link HostContextProvider} the submission service
         * judges with (null, the default: none).
         */
        public Builder hostContext(HostContextProvider hostContext) {
            this.hostContext = hostContext;
            return this;
        }

        public PdfApi build() {
            return new PdfApi(this);
        }
    }
}
