package com.argusvane.datum.web.openapi;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Predicate;
import tools.jackson.databind.JsonNode;

/**
 * Every Datum route as data: its method, path template,
 * capability, switch, tag and operation id, the statuses it answers with their wire codes and response headers, and
 * the shared components of every Datum document ({@code ErrorItem}, {@code ErrorsBody}, the RFC 9457
 * {@code ProblemDetail}, the shared headers, parameter and error responses, and which of those every operation
 * gets). Spring's {@code DatumOpenApiCustomizer} builds the shared components and the per-route statuses and
 * headers from it, a Quarkus {@code OASFilter} would build from the same data, and each binding's tests hold its document to
 * it through {@link #differences} and {@link #missing}.
 *
 * <p>The per-route descriptions, parameters and request bodies stay with each binding's own annotations; the catalog
 * owns what a client relies on: which routes exist, under which switch, and which statuses, codes and headers they
 * answer. A status listed here without codes answers a body whose codes are not fixed (the kernel's errors of a 422,
 * an RFC 3161 refusal).
 */
public final class DatumEndpointCatalog {

    /** Which configured base a route's path hangs from. */
    public enum Base {
        /** {@code datum.web.api.path}, {@code /api} by default. */
        API("/api"),
        /** {@code datum.tsa.path}, {@code /tsa} by default. */
        TSA("/tsa"),
        /** {@code datum.webauthn.path}, {@code /api/webauthn} by default. */
        WEBAUTHN("/api/webauthn");

        private final String defaultPath;

        Base(String defaultPath) {
            this.defaultPath = defaultPath;
        }

        public String defaultPath() {
            return defaultPath;
        }
    }

    /**
     * One status a route answers.
     *
     * @param status  the HTTP status
     * @param codes   the wire codes it carries, empty when none is fixed
     * @param headers the response headers it can carry ({@code ETag}, {@code Retry-After}, ...): what the document
     *                describes on this status
     * @param headerCodes of those headers, the ones only some of the status's codes send, header to codes: a
     *                    {@code 503}'s {@code Retry-After} is {@code ["server.busy"]}, so {@code server.unavailable} and
     *                    a failed run send none. A header of {@code headers} that is not a key here is sent with every
     *                    code of the status
     */
    public record Status(int status, List<String> codes, List<String> headers, Map<String, List<String>> headerCodes) {

        public Status {
            codes = List.copyOf(codes);
            headers = List.copyOf(headers);
            Map<String, List<String>> copy = new LinkedHashMap<>();
            headerCodes.forEach((header, only) -> copy.put(header, List.copyOf(only)));
            headerCodes = java.util.Collections.unmodifiableMap(copy);
        }

        public Status(int status, List<String> codes, List<String> headers) {
            this(status, codes, headers, Map.of());
        }

        /** Whether an answer of this status with this code sends the header. */
        public boolean sends(String header, String code) {
            if (headers.stream().noneMatch(header::equalsIgnoreCase)) {
                return false;
            }
            return headerCodes.entrySet().stream().filter(entry -> entry.getKey().equalsIgnoreCase(header))
                .findFirst().map(entry -> entry.getValue().contains(code)).orElse(true);
        }
    }

    /**
     * One route.
     *
     * @param capability  the capability module that serves it ({@code forms}, {@code ui}, {@code submissions}, ...)
     * @param groups      the OpenAPI groups that document it (without the {@code datum-} prefix)
     * @param tag         the OpenAPI tag
     * @param operationId the OpenAPI operation id, unique among Datum's routes
     * @param method      the HTTP method
     * @param base        which configured base the path hangs from
     * @param path        the path template under the base ({@code /forms/{key}/definition}; empty for the base itself)
     * @param switchKey   the property that turns it on ({@code datum.web.api.endpoints.definition})
     * @param body        whether it reads a request body
     * @param statuses    the statuses it answers itself, beside the {@link #defaultResponses} every route gets
     */
    public record Endpoint(String capability, List<String> groups, String tag, String operationId, String method, Base base, String path,
                           String switchKey, boolean body, List<Status> statuses) {

        public Endpoint {
            groups = List.copyOf(groups);
            statuses = List.copyOf(statuses);
        }

        /** The path under a configured base ({@code /api} + {@code /forms/{key}/definition}). */
        public String path(String basePath) {
            return basePath + path;
        }

        /** The status entry, if the route answers it itself. */
        public Optional<Status> status(int status) {
            return statuses.stream().filter(entry -> entry.status() == status).findFirst();
        }
    }

    /**
     * One property of a shared schema.
     *
     * @param name        the member name
     * @param type        {@code string}, {@code integer}, {@code boolean}, {@code ref:<Schema>} for an object of a shared schema,
     *                    {@code array:<Schema>} for an array of a shared schema, or {@code array:string}
     * @param description the text, or null
     * @param nullable    whether null is allowed
     * @param example     an example value, or null
     */
    public record Property(String name, String type, String description, boolean nullable, String example) {
    }

    /** One shared schema ({@code #/components/schemas/<name>}). */
    public record SchemaDef(String name, String description, List<Property> properties, List<String> required) {

        public SchemaDef {
            properties = List.copyOf(properties);
            required = List.copyOf(required);
        }
    }

    /**
     * One shared header ({@code #/components/headers/<component>}).
     *
     * @param component the component name
     * @param header    the HTTP header it describes
     * @param type      {@code string} or {@code integer}
     * @param minimum   the least value of an integer, or null
     */
    public record HeaderDef(String component, String header, String description, String type, Long minimum) {
    }

    /** One shared request header parameter ({@code #/components/parameters/<component>}). */
    public record ParameterDef(String component, String name, String description, String type) {
    }

    /**
     * One shared error response ({@code #/components/responses/<component>}).
     *
     * @param retryAfter      whether it can carry {@code Retry-After}
     * @param retryAfterCodes of its codes, the only ones that send it; empty when every code of the response does
     */
    public record SharedResponse(String component, int status, String description, List<String> codes, boolean retryAfter,
                                 List<String> retryAfterCodes) {

        public SharedResponse {
            codes = List.copyOf(codes);
            retryAfterCodes = List.copyOf(retryAfterCodes);
        }

        public SharedResponse(String component, int status, String description, List<String> codes, boolean retryAfter) {
            this(component, status, description, codes, retryAfter, List.of());
        }
    }

    public static final String ETAG = "ETag";
    public static final String RETRY_AFTER = "Retry-After";
    public static final String LOCATION = "Location";
    public static final String REMOVED_LOCALES = DatumMediaTypes.REMOVED_LOCALES_HEADER;
    public static final String PAGE_COUNT = DatumMediaTypes.PAGE_COUNT_HEADER;

    private static final String API_SWITCH = "datum.web.api.endpoints.";
    private static final String BUILDER_SWITCH = "datum.builder.enabled";
    private static final String TSA_SWITCH = "datum.tsa.enabled";
    private static final String WEBAUTHN_SWITCH = "datum.webauthn.enabled";

    private static final List<Endpoint> ENDPOINTS = List.of(
        // datum-forms: the definition reads and the data sources (a form list is the application's).
        get("forms", List.of("forms"), "datum-forms", "getFormDefinition", Base.API, "/forms/{key}/definition", API_SWITCH + "definition",
            s(200, List.of(), List.of(ETAG)), s(304, List.of(), List.of(ETAG)), s(400, "bad_request"), s(403, "access.denied"),
            s(404, "form.notFound")),
        get("forms", List.of("forms"), "datum-forms", "getFormTranslations", Base.API, "/forms/{key}/translations", API_SWITCH + "definition",
            s(200, List.of(), List.of(ETAG)), s(304, List.of(), List.of(ETAG)), s(403, "access.denied"), s(404, "form.notFound")),
        get("forms", List.of("forms"), "datum-forms", "getDataSourceItems", Base.API, "/data-sources/{id}", API_SWITCH + "data-sources",
            s(200), s(403, "access.denied"), s(404, "data_source.notFound"), unavailable("data_source.unavailable")),
        // datum-ui: the builder's writes (documented in the forms group too: they share its paths).
        withBody("ui", List.of("ui", "forms"), "datum-ui", "createForm", "POST", Base.API, "/forms", BUILDER_SWITCH,
            s(201, List.of(), List.of(ETAG, LOCATION)), s(403, "access.denied"), s(409, "form.exists"), s(422), s(501, "forms.readOnly")),
        withBody("ui", List.of("ui", "forms"), "datum-ui", "saveForm", "PUT", Base.API, "/forms/{key}", BUILDER_SWITCH,
            s(200, List.of(), List.of(ETAG, REMOVED_LOCALES)), s(403, "access.denied"), s(404, "form.notFound"),
            s(409, List.of("form.outdated"), List.of(ETAG)), s(422), s(501, "forms.readOnly")),
        withBody("ui", List.of("ui", "forms"), "datum-ui", "saveFormTranslations", "PUT", Base.API, "/forms/{key}/translations", BUILDER_SWITCH,
            s(200, List.of(), List.of(ETAG)), s(403, "access.denied"), s(404, "form.notFound"), s(409, List.of("form.outdated"), List.of(ETAG)),
            s(422, "catalog.invalid")),
        // datum-submissions: story one.
        withBody("submissions", List.of("submissions"), "datum-submissions", "submitSubmission", "POST", Base.API, "/submissions",
            API_SWITCH + "submissions", s(200), s(403, "access.denied"), s(404, "form.notFound"), s(409, "form.outdated", "submission.keyConflict"),
            unavailable("validator_unavailable", "data_source.unavailable", "wasm.execution_error", "outcome_too_large", "definition.tooDeep")),
        withBody("submissions", List.of("submissions"), "datum-submissions", "validateSubmission", "POST", Base.API, "/submissions/validate",
            API_SWITCH + "validate", s(200), s(403, "access.denied"), s(404, "form.notFound"), s(409, "form.outdated"),
            unavailable("validator_unavailable", "data_source.unavailable", "wasm.execution_error", "outcome_too_large", "definition.tooDeep")),
        withBody("submissions", List.of("submissions"), "datum-submissions", "testSubmission", "POST", Base.API, "/submissions/test",
            API_SWITCH + "test", s(200), s(403, "access.denied"), s(404, "form.notFound"),
            unavailable("validator_unavailable", "data_source.unavailable", "wasm.execution_error", "outcome_too_large", "definition.tooDeep")),
        withBody("submissions", List.of("submissions"), "datum-submissions", "inspectDefinition", "POST", Base.API, "/inspect",
            API_SWITCH + "inspect", s(200), s(403, "access.denied"), s(404, "form.notFound"),
            unavailable("wasm.execution_error", "outcome_too_large", "definition.tooDeep")),
        // datum-pdf: render, fill, sign, verify, the server's chain.
        withBody("pdf", List.of("pdf"), "datum-pdf", "renderPdf", "POST", Base.API, "/pdf", API_SWITCH + "pdf", pdfStatuses(false)),
        withBody("pdf", List.of("pdf"), "datum-pdf", "fillPdf", "POST", Base.API, "/pdf/fill", API_SWITCH + "fill", pdfStatuses(true)),
        withBody("pdf", List.of("pdf"), "datum-pdf", "signPdf", "POST", Base.API, "/pdf/sign", API_SWITCH + "sign", pdfStatuses(false)),
        withBody("pdf", List.of("pdf"), "datum-pdf", "verifyPdf", "POST", Base.API, "/pdf/verify", API_SWITCH + "verify",
            s(200), s(400, "pdf.notAPdf", "pdf.unreadable"), s(413, "bad_document"), s(415), s(429, List.of("flood"), List.of(RETRY_AFTER)),
            unavailable("wasm.execution_error", "outcome_too_large")),
        get("pdf", List.of("pdf"), "datum-pdf", "serverCertificate", Base.API, "/server/certificate", API_SWITCH + "certificate",
            s(200), s(404, "certificate.notFound")),
        // datum-timestamp: the RFC 3161 server (its refusals are TimeStampResp or text, not JSON codes).
        withBody("timestamp", List.of("tsa"), "datum-tsa", "issueTimestamp", "POST", Base.TSA, "", TSA_SWITCH,
            s(200), s(400), s(401), s(403), s(413), s(415), s(429, List.of(), List.of(RETRY_AFTER)), s(503, List.of(), List.of(RETRY_AFTER))),
        get("timestamp", List.of("tsa"), "datum-tsa", "getTimestampCertificate", Base.TSA, "/certificate", TSA_SWITCH, s(200), s(503)),
        get("timestamp", List.of("tsa"), "datum-tsa", "getTimestampCertificates", Base.TSA, "/certificates", TSA_SWITCH, s(200), s(503)),
        // datum-webauthn: the passkey ceremony and a person's passkeys.
        withBody("webauthn", List.of("webauthn"), "datum-webauthn", "passkeyChallenge", "POST", Base.WEBAUTHN, "/challenge", WEBAUTHN_SWITCH,
            s(200), s(403, "access.denied", "signing.sign_in", "signing.context", "signing.register_off"), s(404, "signing.off"),
            s(429, List.of("flood"), List.of(RETRY_AFTER)), s(503, "signing.not_set_up")),
        withBody("webauthn", List.of("webauthn"), "datum-webauthn", "passkeyRegister", "POST", Base.WEBAUTHN, "/register", WEBAUTHN_SWITCH,
            s(201), s(400, "passkey.bad_request", "passkey.challenge"), s(403), s(404), s(409, "passkey.exists"), s(422, "passkey.invalid"),
            s(429, List.of("flood"), List.of(RETRY_AFTER)), s(503, "signing.not_set_up")),
        get("webauthn", List.of("webauthn"), "datum-webauthn", "listPasskeys", Base.WEBAUTHN, "/passkeys", WEBAUTHN_SWITCH,
            s(200), s(403, "access.denied"), s(404)),
        new Endpoint("webauthn", List.of("webauthn"), "datum-webauthn", "removePasskey", "DELETE", Base.WEBAUTHN, "/passkeys/{id}", WEBAUTHN_SWITCH,
            false, List.of(s(200), s(404, "passkey.notFound"))),
        new Endpoint("webauthn", List.of("webauthn"), "datum-webauthn", "passkeyCheckChallenge", "POST", Base.WEBAUTHN, "/passkeys/{id}/check-challenge",
            WEBAUTHN_SWITCH, false, List.of(s(200), s(404), s(409, "passkey.revoked"), s(429, List.of("flood"), List.of(RETRY_AFTER)),
                s(503, "signing.not_set_up"))),
        withBody("webauthn", List.of("webauthn"), "datum-webauthn", "passkeyCheck", "POST", Base.WEBAUTHN, "/passkeys/{id}/check", WEBAUTHN_SWITCH,
            s(200), s(400), s(404), s(409), s(422), s(503, "signing.not_set_up")));

    private static final List<SchemaDef> SCHEMAS = List.of(
        new SchemaDef("ErrorItem", "One error: the component id it belongs to (left out when none), a stable code, and host-worded text for a person.",
            List.of(new Property("field", "string", "The component id; the member is left out when the error names none.", false, null),
                new Property("code", "string", "Stable machine code, for example form.outdated.", false, null),
                new Property("message", "string", "Optional text for a person: the form's own wording for a finding or a hook's; never a guest's stderr.", false, null)),
            List.of("code")),
        new SchemaDef("ErrorsBody", "An error answer: {errors:[{field?, code, message?}]}.",
            List.of(new Property("errors", "array:ErrorItem", null, false, null)), List.of("errors")),
        new SchemaDef("ProblemDetail", "RFC 9457 problem details with the same codes (datum.web.api.problem-details=true).",
            List.of(new Property("type", "string", null, false, "about:blank"), new Property("title", "string", null, false, null),
                new Property("status", "integer", null, false, null), new Property("detail", "string", null, false, null),
                new Property("code", "string", null, false, null),
                new Property("correlationId", "string", "Names the log entry of a 500.", false, null),
                new Property("errors", "array:ErrorItem", null, false, null)),
            List.of()),
        // The verify report (POST /pdf/verify, 200): the members a client reads; additive (trustPolicy, trustedAt).
        // The catalog is shared and describes the wire every host answers, so the two members this host adds
        // are optional: a report without them, as another host answers it, conforms.
        new SchemaDef("PdfTrustPolicySummary", "The trust policy a verify report placed its signers and timestamp authorities under "
            + "(an addition of this host, which other hosts need not send).",
            List.of(new Property("name", "string", "The policy's name; default for the configured anchors.", false, "default"),
                new Property("revocationChecking", "boolean", "Whether revocation was checked (the JDK's PKIX revocation checker).", false, null),
                new Property("validationTime", "string", "When chains were judged: now or signing-time.", false, "now")),
            List.of("name", "revocationChecking", "validationTime")),
        new SchemaDef("PdfSignatureVerdict", "One signature of a verify report, checked and placed; the members named here, among the others the report carries.",
            List.of(new Property("field", "string", "The signature field, or empty when no field links it any more.", false, null),
                new Property("value", "string", "valid, invalid or unchecked: the signature value under the signer's key.", false, "valid"),
                new Property("digestMatches", "boolean", "The file still hashes to what was signed.", false, null),
                new Property("certificateMatches", "boolean", "The signed attributes name the signer's certificate.", false, null),
                new Property("coversDocument", "boolean", "Nothing was appended after it.", false, null),
                new Property("intact", "boolean", "Digest, binding and value all hold.", false, null),
                new Property("trust", "string", "site, site_retired, trusted, self_signed or unknown.", false, "site"),
                new Property("signingTime", "string", "The signed revision's /M, ISO 8601: the signer's claim.", true, null),
                new Property("trustedAt", "string", "The instant (ISO 8601) the chain to an anchor was judged at; only for a trusted chain, "
                    + "and optional (an addition of this host, which other hosts need not send).",
                    true, null)),
            List.of("field", "value", "intact", "trust")),
        new SchemaDef("PdfVerifyReport", "A verify report (POST /pdf/verify): the file's hash and size, each signature, the document key, the program's warnings, "
            + "the embedded files (attachments) and, optionally, the trust policy (an addition of this host, which other hosts need not send).",
            List.of(new Property("sha256", "string", "The file's SHA-256, lowercase hex.", false, null),
                new Property("bytes", "integer", "The file's size.", false, null),
                new Property("signatures", "array:PdfSignatureVerdict", null, false, null),
                new Property("documentId", "string", "The document key an intact signature signed, else the file's current one.", true, null),
                new Property("documentIdSource", "string", "signed or current.", true, null),
                new Property("warnings", "array:string", "The program's warning messages.", false, null),
                new Property("trustPolicy", "ref:PdfTrustPolicySummary", null, false, null)),
            List.of("sha256", "bytes", "signatures")));

    private static final List<HeaderDef> HEADERS = List.of(
        new HeaderDef("RetryAfter", RETRY_AFTER, "Seconds to wait before trying again. On a 503 only server.busy sends it.", "integer", 0L),
        new HeaderDef("ETag", ETAG, "The sha256 of the definition or catalog the answer carries; send it back as If-Match on a write.", "string", null),
        new HeaderDef("XDatumRemovedLocales", REMOVED_LOCALES, "The locales a save removed, comma separated.", "string", null),
        new HeaderDef("XPageCount", PAGE_COUNT, "The number of pages of the PDF.", "integer", null),
        new HeaderDef("Location", LOCATION, "Where the created form's full definition is read.", "string", null));

    private static final List<ParameterDef> PARAMETERS = List.of(
        new ParameterDef("IfMatch", "If-Match", "The ETag of the version being replaced; a stale one answers 409.", "string"));

    private static final List<SharedResponse> RESPONSES = List.of(
        new SharedResponse("BadRequest", 400, "The body is not usable JSON (bad_document).", List.of("bad_document"), false),
        new SharedResponse("PayloadTooLarge", 413, "The body is larger than datum.web.api.max-body-size (bad_document).", List.of("bad_document"), false),
        new SharedResponse("UnsupportedMediaType", 415, "The Content-Type is not JSON (unsupported_media_type).", List.of("unsupported_media_type"), false),
        new SharedResponse("Unprocessable", 422, "Rejected: the errors name the codes and fields.", List.of(), false),
        new SharedResponse("TooManyRequests", 429, "Throttled (flood); wait Retry-After seconds.", List.of("flood"), true),
        new SharedResponse("Unavailable", 503, "The sandbox is busy or unavailable (server.busy with Retry-After, server.unavailable without); "
            + "try again.", List.of("server.busy", "server.unavailable"), true, List.of("server.busy")),
        new SharedResponse("InternalError", 500, "An unexpected failure (internal); the correlation id is in the log.", List.of("internal"), false));

    private DatumEndpointCatalog() {
    }

    private static Status s(int status, String... codes) {
        return new Status(status, List.of(codes), List.of());
    }

    private static Status s(int status, List<String> codes, List<String> headers) {
        return new Status(status, codes, headers);
    }

    private static Endpoint get(String capability, List<String> groups, String tag, String operationId, Base base, String path, String switchKey,
                                Status... statuses) {
        return new Endpoint(capability, groups, tag, operationId, "GET", base, path, switchKey, false, List.of(statuses));
    }

    private static Endpoint withBody(String capability, List<String> groups, String tag, String operationId, String method, Base base, String path,
                                     String switchKey, Status... statuses) {
        return new Endpoint(capability, groups, tag, operationId, method, base, path, switchKey, true, List.of(statuses));
    }

    /**
     * A 503 that names the shared codes (the sandbox is busy or unavailable) and the ones this route can add: a
     * validator or data source the application owns that could not answer, and where a run can fail ({@code submit},
     * {@code validate}, {@code test}, {@code inspect} and the PDF routes) the run's own codes
     * ({@code wasm.execution_error}, {@code outcome_too_large}, and {@code definition.tooDeep} for a registered form):
     * a failed run is no judgement of what the caller sent, so it is never a 422. The {@code 422} rows keep only a
     * caller's own refusals (a posted definition nested too deep, the builder's {@code definition.tooDeep} and
     * {@code definition.tooCostly}). Only {@code server.busy} carries {@code Retry-After}: it is the one code
     * whose retry can succeed ({@link Status#headerCodes()}). (The kernel verdicts
     * {@code pdf_unavailable} and {@code keys_unavailable} and the timestamp client's {@code timestamp.unavailable} and
     * {@code timestamp.key} are 503s of the libraries too, but no route answers them: a seal's timestamp that fails is a
     * {@code sealing.unavailable} warning, never a failed request.)
     */
    private static Status unavailable(String... more) {
        List<String> codes = new ArrayList<>(List.of("server.unavailable", "server.busy"));
        codes.addAll(List.of(more));
        return new Status(503, codes, List.of(RETRY_AFTER), Map.of(RETRY_AFTER, List.of("server.busy")));
    }

    private static Status[] pdfStatuses(boolean fill) {
        List<String> bad = fill ? List.of("bad_request", "bad_document", "layout.notTemplate") : List.of("bad_request", "bad_document");
        return new Status[] {s(200, List.of(), List.of(PAGE_COUNT)), s(400, bad, List.of()), s(403, "access.denied"),
            s(404, "form.notFound", "layout.notFound"), s(413, "bad_document"), s(415), s(422), s(429, List.of("flood"), List.of(RETRY_AFTER)),
            unavailable("wasm.execution_error", "outcome_too_large", "definition.tooDeep")};
    }

    /** Every Datum route. */
    public static List<Endpoint> endpoints() {
        return ENDPOINTS;
    }

    /** The route with this operation id. */
    public static Optional<Endpoint> endpoint(String operationId) {
        return ENDPOINTS.stream().filter(endpoint -> endpoint.operationId().equals(operationId)).findFirst();
    }

    /** The routes an OpenAPI group documents ({@code forms}, {@code ui}, ...; with or without {@code datum-}). */
    public static List<Endpoint> group(String group) {
        String name = group.startsWith("datum-") ? group.substring("datum-".length()) : group;
        return ENDPOINTS.stream().filter(endpoint -> endpoint.groups().contains(name)).toList();
    }

    public static List<SchemaDef> schemas() {
        return SCHEMAS;
    }

    public static List<HeaderDef> headers() {
        return HEADERS;
    }

    /** The header component of an HTTP header, if there is one. */
    public static Optional<HeaderDef> header(String name) {
        return HEADERS.stream().filter(header -> header.header().equalsIgnoreCase(name)).findFirst();
    }

    public static List<ParameterDef> parameters() {
        return PARAMETERS;
    }

    public static List<SharedResponse> sharedResponses() {
        return RESPONSES;
    }

    /**
     * The shared error responses every operation gets unless it declares the status itself, status to component: 400,
     * 413, 415 and 422 when it reads a body; 429 for a POST; 500 and 503 always.
     */
    public static Map<Integer, String> defaultResponses(boolean body, String method) {
        Map<Integer, String> out = new LinkedHashMap<>();
        if (body) {
            out.put(400, "BadRequest");
            out.put(413, "PayloadTooLarge");
            out.put(415, "UnsupportedMediaType");
            out.put(422, "Unprocessable");
        }
        if ("POST".equalsIgnoreCase(method)) {
            out.put(429, "TooManyRequests");
        }
        out.put(500, "InternalError");
        out.put(503, "Unavailable");
        return out;
    }

    /** The statuses a route's operation documents: its own and the defaults it does not declare. */
    public static Set<Integer> documentedStatuses(Endpoint endpoint) {
        Set<Integer> out = new TreeSet<>();
        endpoint.statuses().forEach(status -> out.add(status.status()));
        out.addAll(defaultResponses(endpoint.body(), endpoint.method()).keySet());
        return out;
    }

    /**
     * What an OpenAPI document says that the catalog does not: an operation the catalog has no route for, or one whose
     * method, path, tag or statuses differ from its route's, a code of the route missing from its response's text, or a
     * header of the route missing from its response. Empty when the document holds to the catalog.
     *
     * @param document the OpenAPI document (one Datum group's)
     * @param bases    the configured base paths, the context path included ({@link Base#defaultPath()} for a base not
     *                 given)
     */
    public static List<String> differences(JsonNode document, Map<Base, String> bases) {
        List<String> found = new ArrayList<>();
        JsonNode paths = document.path("paths");
        for (String path : paths.propertyNames()) {
            JsonNode item = paths.path(path);
            for (String method : item.propertyNames()) {
                if (!Set.of("get", "put", "post", "delete", "patch", "head", "options").contains(method)) {
                    continue;
                }
                JsonNode operation = item.path(method);
                String at = method.toUpperCase(Locale.ROOT) + " " + path;
                String operationId = operation.path("operationId").asString("");
                Optional<Endpoint> known = endpoint(operationId);
                if (known.isEmpty()) {
                    found.add(at + ": operation " + operationId + " is not in the catalog");
                    continue;
                }
                Endpoint endpoint = known.get();
                if (!endpoint.method().equalsIgnoreCase(method)) {
                    found.add(at + ": the catalog's method is " + endpoint.method());
                }
                String expected = endpoint.path(base(bases, endpoint.base()));
                if (!expected.equals(path)) {
                    found.add(at + ": the catalog's path is " + expected);
                }
                if (!operation.path("tags").path(0).asString("").equals(endpoint.tag())) {
                    found.add(at + ": the catalog's tag is " + endpoint.tag());
                }
                JsonNode responses = operation.path("responses");
                Set<Integer> documented = new TreeSet<>();
                responses.propertyNames().forEach(status -> documented.add(Integer.parseInt(status)));
                if (!documented.equals(documentedStatuses(endpoint))) {
                    found.add(at + ": documents " + documented + ", the catalog " + documentedStatuses(endpoint));
                }
                for (Status status : endpoint.statuses()) {
                    JsonNode response = responses.path(String.valueOf(status.status()));
                    if (response.isMissingNode() || response.has("$ref")) {
                        continue;
                    }
                    String description = response.path("description").asString("");
                    for (String code : status.codes()) {
                        if (!description.contains(code)) {
                            found.add(at + " " + status.status() + ": the description does not name " + code);
                        }
                    }
                    for (String header : status.headers()) {
                        if (!hasHeader(response.path("headers"), header)) {
                            found.add(at + " " + status.status() + ": no " + header + " header");
                        }
                    }
                }
            }
        }
        return found;
    }

    /**
     * The routes of a group the configuration turned on that the document does not list.
     *
     * @param on which routes this configuration serves (by its switch, or by the route itself)
     */
    public static List<String> missing(JsonNode document, String group, Map<Base, String> bases, Predicate<Endpoint> on) {
        List<String> out = new ArrayList<>();
        Set<String> documented = new LinkedHashSet<>();
        JsonNode paths = document.path("paths");
        for (String path : paths.propertyNames()) {
            for (String method : paths.path(path).propertyNames()) {
                documented.add(method.toUpperCase(Locale.ROOT) + " " + path);
            }
        }
        for (Endpoint endpoint : group(group)) {
            String at = endpoint.method() + " " + endpoint.path(base(bases, endpoint.base()));
            if (on.test(endpoint) && !documented.contains(at)) {
                out.add(at + " (" + endpoint.operationId() + ") is on but not documented");
            }
        }
        return out;
    }

    private static String base(Map<Base, String> bases, Base base) {
        String configured = bases == null ? null : bases.get(base);
        return configured != null ? configured : base.defaultPath();
    }

    private static boolean hasHeader(JsonNode headers, String name) {
        for (String present : headers.propertyNames()) {
            if (present.equalsIgnoreCase(name)) {
                return true;
            }
        }
        return false;
    }

    /**
     * A check of the catalog itself: operation ids unique, every shared response named by the default rule exists, every
     * schema a property names ({@code ref:}, {@code array:}) is a shared schema and every property type is one the writers know.
     */
    static List<String> selfCheck() {
        List<String> out = new ArrayList<>();
        Set<String> ids = new LinkedHashSet<>();
        Set<String> routes = new LinkedHashSet<>();
        for (Endpoint endpoint : ENDPOINTS) {
            if (!ids.add(endpoint.operationId())) {
                out.add("operation id " + endpoint.operationId() + " twice");
            }
            if (!routes.add(endpoint.method() + " " + endpoint.base() + endpoint.path())) {
                out.add("route " + endpoint.method() + " " + endpoint.base() + endpoint.path() + " twice");
            }
            for (Status status : endpoint.statuses()) {
                for (String header : status.headers()) {
                    if (header(header).isEmpty()) {
                        out.add(endpoint.operationId() + " names the header " + header + " which has no component");
                    }
                }
                status.headerCodes().forEach((header, only) -> {
                    if (status.headers().stream().noneMatch(header::equalsIgnoreCase)) {
                        out.add(endpoint.operationId() + " " + status.status() + " limits the header " + header + " which the status does not list");
                    }
                    if (only.isEmpty() || !status.codes().containsAll(only)) {
                        out.add(endpoint.operationId() + " " + status.status() + " limits " + header + " to codes it does not carry: " + only);
                    }
                });
            }
        }
        Set<String> schemaNames = new LinkedHashSet<>();
        SCHEMAS.forEach(schema -> schemaNames.add(schema.name()));
        for (SchemaDef schema : SCHEMAS) {
            for (Property property : schema.properties()) {
                String type = property.type();
                String named = type.startsWith("ref:") ? type.substring("ref:".length())
                    : type.startsWith("array:") && !type.equals("array:string") ? type.substring("array:".length()) : null;
                if (named != null && !schemaNames.contains(named)) {
                    out.add(schema.name() + "." + property.name() + " names the schema " + named + " which is not shared");
                } else if (named == null && !Set.of("string", "integer", "boolean", "array:string").contains(type)) {
                    out.add(schema.name() + "." + property.name() + " has the type " + type + " no writer knows");
                }
            }
        }
        Set<String> shared = new LinkedHashSet<>();
        RESPONSES.forEach(response -> shared.add(response.component()));
        for (String component : defaultResponses(true, "POST").values()) {
            if (!shared.contains(component)) {
                out.add("default response " + component + " is not a shared response");
            }
        }
        return out;
    }
}
