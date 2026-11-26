package com.argusvane.datum.submissions.receiver;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.DefinitionDepth;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.submissions.service.FormRef;
import com.argusvane.datum.submissions.service.JourneyCheck;
import com.argusvane.datum.submissions.service.SubmissionOutcome;
import com.argusvane.datum.submissions.service.SubmissionService;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.submissions.spi.HostOptionsCustomizer;
import com.argusvane.datum.submissions.spi.PreCheckDecision;
import com.argusvane.datum.sandbox.protocol.RunSettings;
import com.argusvane.datum.submissions.spi.SandboxContextContributor;
import com.argusvane.datum.submissions.spi.SandboxRulesProvider;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionPreCheck;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.SubmissionValidator;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.json.JsonBodies;
import java.security.MessageDigest;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The HTTP side of a submission, a journey's check or a dry run: the admission of the
 * request and the mapping of the {@link SubmissionOutcome} to the wire of {@code packages/submissions/src/http-mapping.ts}
 * (the endpoint catalog), over the transport-neutral {@link SubmissionService},
 * which judges. Other callers (a queue, a batch, a sync) call the service themselves.
 *
 * <p>The admission, in order, each refusal before anything costlier:
 * <ol>
 *   <li>415 for a body that is not JSON by its Content-Type;</li>
 *   <li>the address limit, 429 {@code flood} with {@code Retry-After} ({@link #admit}, which a web adapter calls before
 *       it reads the body: every request from one client address counts, whether or not its body parses);</li>
 *   <li>413 past the body cap ({@code datum.web.api.max-body-size}, clamped by {@code ProgramLimits});</li>
 *   <li>the parse (Datum's mapper), then what strict JSON also refuses and Jackson reads (an unpaired UTF-16 surrogate
 *       in a string or a key, REC-02): 400 {@code bad_document};</li>
 *   <li>the body around the document: an object; a check is {@code {document, scope, pageId?}} with scope
 *       {@code page} or {@code journey}; the document nested at most {@value #DOCUMENT_DEPTH} deep; no number
 *       outside the range of a double anywhere in the body; the document an object; no check members ({@code scope},
 *       {@code pageId}) on a delivery or a dry run, in the document or beside it; a dry run's {@code logLevel}; a
 *       delivery's {@code submissionKey} beside the document ({@link SubmissionContext#SUBMISSION_KEY}): 400
 *       {@code bad_document};</li>
 *   <li>the client facts ({@link SubmissionRequest#toContext}: channel {@code http}, the address, the User-Agent, the
 *       headers, the throttle key from the address and the principal's name, the SHA-256 of the raw body).</li>
 * </ol>
 * Then the service's own steps (the document's rules, the per-form throttle, the pre-checks, the version, the journey, the option
 * snapshot, the sandbox, the signature, the validators, the idempotency store, the handler, the events: see
 * {@link SubmissionService}), so the throttle and the pre-checks still refuse before any run, and the outcome's answer:
 * <ul>
 *   <li>{@code Accepted}: 200 {@code {id, reference, status: "accepted", digest, handled: false, receipt?, warnings?}};</li>
 *   <li>{@code Redelivered}: 200, the first receipt with {@code handled: true} (a retry of the same submit attempt);</li>
 *   <li>{@code KeyConflict}: 409 {@code submission.keyConflict} (the attempt's key was accepted with another document);</li>
 *   <li>{@code Rejected}: 422 {@code {errors: [{field, code, message?}]}} ({@link SubmissionRejectedException});</li>
 *   <li>{@code Checked}: 200 {@code {accepted, errors: [{field?, code, message?}], notes?: [{field?, code, severity, message?}]}}:
 *       {@code errors} holds only what blocks, {@code notes} (left out when empty) the warnings and info that ride along,
 *       and {@code field} is left out when a finding names none;</li>
 *   <li>{@code DryRun}: 200 with its report, whether accepted or rejected;</li>
 *   <li>{@code Outdated}: 409 {@code form.outdated}, no hash ({@link SubmissionOutdatedException});</li>
 *   <li>{@code NotFound}: 404 {@code form.notFound}, never repeating the id ({@link UnknownFormException}): the form comes
 *       from the document, not the route;</li>
 *   <li>{@code Malformed}: 400 {@code bad_document};</li>
 *   <li>{@code Refused}: the pre-check's own code, with the status {@link PreCheckStatuses} names for it;</li>
 *   <li>{@code Throttled}: 429 {@code flood} with {@code Retry-After} ({@link ThrottledException});</li>
 *   <li>{@code Unavailable}: the run's own exception as it was thrown, every one a 503 ({@code server.busy} with
 *       {@code Retry-After}, {@code server.unavailable}, and a run that failed: {@code wasm.execution_error},
 *       {@code outcome_too_large}, {@code definition.tooDeep} of the registered form; never a 422, which would read as a
 *       judgement of the answers), or 503
 *       {@code validator_unavailable} ({@link ValidatorUnavailableException}); a journey's check answers a failed run the
 *       same way a delivery does, never as a 200 verdict.</li>
 * </ul>
 * A dry run's refusals before the verdict (400 to 409, 413, 415, 429, 503) are answered as refusals, not inside a 200
 * report; its verdict, accepted or rejected, is the 200 report. What a hook throws on its own (a {@code DatumException}
 * with its code, any other exception, an {@link Error}) reaches the error mapper unchanged: a 500 for anything that is
 * not a {@code DatumException}, which still fails closed.
 *
 * <p>Wire bodies: a delivery is posted as {@code {document, submissionKey}} (the security suite's {@code submissions}
 * profile, {@code @argusvane/datum-submissions}' {@code ReceiveInput}, what the {@code datum-host.js} glue posts): the key the
 * browser minted for the submit attempt, the same on a retry. A bare document, or one without a key, is refused. A check
 * is always {@code {document, scope, pageId?}}; a dry run {@code {document, logLevel?}} or the bare document.
 */
public final class SubmissionReceiver {

    /** The deepest document accepted: {@link SubmissionService#DOCUMENT_DEPTH}. */
    public static final int DOCUMENT_DEPTH = SubmissionService.DOCUMENT_DEPTH;

    /** The code a delivery is refused with when its submission key was accepted before with another document (409). */
    public static final String KEY_CONFLICT = "submission.keyConflict";

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private final SubmissionService service;
    private final DatumJsonMapper json;
    private final long maxBodyBytes;
    private final PreCheckStatuses preCheckStatuses;

    /**
     * The status of a pre-check's refusal, by the mapping. One that throws, or answers a status that is no refusal, fails
     * the request (500), as any hook that fails does: a refusal answered 200 would read as accepted.
     */
    private int statusOf(String code) {
        int status = preCheckStatuses.statusOf(code);
        if (status < 400 || status > 599) {
            throw new IllegalStateException("PreCheckStatuses answered " + status + " for " + code + "; a refusal is 400 to 599.");
        }
        return status;
    }

    private SubmissionReceiver(SubmissionService service, DatumJsonMapper json, long maxBodyBytes, PreCheckStatuses preCheckStatuses) {
        this.preCheckStatuses = preCheckStatuses == null ? PreCheckStatuses.standard() : preCheckStatuses;
        this.service = Objects.requireNonNull(service, "service");
        this.json = Objects.requireNonNull(json, "json");
        if (maxBodyBytes <= 0) {
            throw new IllegalArgumentException("The body cap is above zero.");
        }
        this.maxBodyBytes = maxBodyBytes;
    }

    /** A builder: the service, or the parts to build one from, and the parse settings. */
    public static Builder builder() {
        return new Builder();
    }

    /** The service this receiver hands every request to: the one other callers use too. */
    public SubmissionService service() {
        return service;
    }

    /**
     * What a web adapter asks before it reads the body: 415 for a body that is not JSON by its Content-Type, then the
     * address limit ({@link SubmissionService#admitAddress}). The per-form throttle needs the form the document names, so
     * it runs after the parse; this count runs first, so an anonymous flood of bodies that never parse is counted and
     * refused before the body is read. {@link #receive} does not ask it again: a caller that already holds the bytes (an
     * application's own controller) calls this first when it read them from a client.
     *
     * @param request the request view (Content-Type, address)
     * @param mode which route
     * @throws DatumException 415 {@code unsupported_media_type}, or {@link ThrottledException} (429 {@code flood})
     */
    public void admit(SubmissionRequest request, SubmissionMode mode) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(mode, "mode");
        JsonBodies.requireJson(request.contentType());
        SubmissionOutcome.Throttled refused = service.admitAddress(request.remoteAddress(), mode, SubmissionContext.HTTP);
        if (refused != null) {
            throw new ThrottledException(refused.retryAfter());
        }
    }

    /** {@link #receive} for a delivery. */
    public ReceiverAnswer submit(SubmissionRequest request, byte[] body) {
        return receive(request, body, SubmissionMode.SUBMIT);
    }

    /** {@link #receive} for a journey's check. */
    public ReceiverAnswer validate(SubmissionRequest request, byte[] body) {
        return receive(request, body, SubmissionMode.VALIDATE);
    }

    /** {@link #receive} for a dry run. */
    public ReceiverAnswer test(SubmissionRequest request, byte[] body) {
        return receive(request, body, SubmissionMode.TEST);
    }

    /**
     * Receives one request.
     *
     * @param request the request view (Content-Type, headers, address, principal)
     * @param body the raw body as read; a web adapter caps its read at the same limit, this is the backstop
     * @param mode which route
     * @return the 200 answer
     * @throws DatumException every refusal, with its wire code and status
     */
    public ReceiverAnswer receive(SubmissionRequest request, byte[] body, SubmissionMode mode) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(body, "body");
        Objects.requireNonNull(mode, "mode");

        // 1. 415, before a byte is read as JSON. The address limit came before the read, in admit.
        JsonBodies.requireJson(request.contentType());
        // 2. The cap, measured on the bytes before they are parsed.
        if (body.length > maxBodyBytes) {
            throw JsonBodies.tooLarge(maxBodyBytes);
        }
        // 3. The parse and what strict JSON refuses that Jackson reads (the run's context could not
        // be written for it anyway).
        JsonNode parsed = JsonBodies.parse(json, body);
        if (SubmissionService.holdsUnpairedSurrogate(parsed)) {
            throw new BadRequestException("The submission is not JSON.");
        }
        // 4. The body around the document.
        Body read = body(parsed, mode);
        // 5. The client facts, then the service.
        var context = request.toContext(sha256(body)).withSubmissionKey(read.submissionKey());
        FormRef form = FormRef.fromDocument();
        SubmissionOutcome outcome = switch (mode) {
            case SUBMIT -> service.submit(form, read.document(), context);
            case VALIDATE -> service.validate(form, read.document(), new JourneyCheck(read.scope(), read.pageId()), context);
            case TEST -> service.test(form, read.document(), read.logLevel(), context);
            case PDF -> service.pdfCheck(form, read.document(), context);
        };
        return answer(outcome);
    }

    // ------------------------------------------------------------------------------------------ the body

    /** The body read around the document: the document, a check's scope and page, a dry run's log level. */
    private record Body(JsonNode document, String scope, String pageId, String logLevel, String submissionKey) {
    }

    private static Body body(JsonNode parsed, SubmissionMode mode) {
        if (!parsed.isObject()) {
            throw new BadRequestException(mode == SubmissionMode.VALIDATE
                ? "A check is a JSON object: {document, scope, pageId?}." : "The submission is not a JSON object.");
        }
        ObjectNode body = (ObjectNode) parsed;
        boolean wrapped = body.has("document");
        if (mode == SubmissionMode.VALIDATE && !wrapped) {
            throw new BadRequestException("A check carries the document it checks: {document, scope, pageId?}.");
        }
        // A delivery belongs to a submit attempt: the key the browser minted for it, the same on a retry. Without one a
        // retry could not be told from another person's identical answers.
        String submissionKey = null;
        if (mode == SubmissionMode.SUBMIT) {
            JsonNode key = wrapped ? body.get("submissionKey") : null;
            if (key == null || !key.isString() || !SubmissionContext.SUBMISSION_KEY.matcher(key.stringValue()).matches()) {
                throw new BadRequestException(key == null
                    ? "A delivery carries the submission key of its submit attempt: {document, submissionKey}."
                    : "The submission key is 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit.");
            }
            submissionKey = key.stringValue();
        }
        JsonNode document = wrapped ? body.get("document") : body;
        // The nesting is the delivered document's; the number rule covers the whole body.
        if (DefinitionDepth.jsonDepth(document) > DOCUMENT_DEPTH) {
            throw new BadRequestException("The submission nests more than " + DOCUMENT_DEPTH + " levels deep.");
        }
        // 1e999 and an integer too long for a double could not be written into the run's context,
        // wherever in the body they are.
        if (SubmissionService.hasNonFiniteNumber(parsed)) {
            throw new BadRequestException("The submission holds a number outside the range of a number.");
        }
        if (!document.isObject()) {
            throw new BadRequestException("The submission is not a JSON object.");
        }
        ObjectNode doc = (ObjectNode) document;

        String scope = null;
        String pageId = null;
        String level = null;
        if (mode == SubmissionMode.VALIDATE) {
            JsonNode scoped = body.get("scope");
            if (scoped == null || !scoped.isString() || !(JourneyCheck.PAGE.equals(scoped.stringValue())
                || JourneyCheck.JOURNEY.equals(scoped.stringValue()))) {
                throw new BadRequestException("A check's scope is \"page\" or \"journey\".");
            }
            scope = scoped.stringValue();
            // An id that is not a string names no page: the service answers that page check as naming none.
            JsonNode page = body.get("pageId");
            pageId = page != null && page.isString() ? page.stringValue() : null;
            // A page names a page check: beside a whole-journey check it would be silently ignored, so it is refused.
            if (JourneyCheck.JOURNEY.equals(scope) && page != null && !page.isNull()) {
                throw new BadRequestException("A check of the whole journey names no page: leave pageId out, or ask for scope \"page\".");
            }
        } else {
            // A journey's check sent here by mistake: checks go to /validate, which keeps nothing.
            if (isSet(doc, "scope") || isSet(doc, "pageId") || (wrapped && (isSet(body, "scope") || isSet(body, "pageId")))) {
                throw new BadRequestException("This is a check, not a submission.");
            }
            if (mode == SubmissionMode.TEST && wrapped) {
                JsonNode asked = body.get("logLevel");
                level = asked != null && asked.isString() && RunSettings.LOG_LEVELS.contains(asked.stringValue()) ? asked.stringValue() : null;
            }
        }
        return new Body(document, scope, pageId, level, submissionKey);
    }

    /** Present and not null. */
    private static boolean isSet(ObjectNode node, String name) {
        JsonNode value = node.get(name);
        return value != null && !value.isNull();
    }

    /**
     * Whether a parsed body holds a number JSON cannot write back: {@link SubmissionService#hasNonFiniteNumber} (the PDF
     * facade asks it of a print request's document before it re-serialises the document for the dry run).
     */
    public static boolean hasNonFiniteNumber(JsonNode value) {
        return SubmissionService.hasNonFiniteNumber(value);
    }

    // ------------------------------------------------------------------------------------------ the answer

    /** The outcome on the wire: a 200 answer, or the refusal's exception for the error mapper. */
    private ReceiverAnswer answer(SubmissionOutcome outcome) {
        // Java 17: no pattern switch, so one instanceof per record of the sealed interface.
        if (outcome instanceof SubmissionOutcome.Accepted accepted) {
            return ReceiverAnswer.ok(receiptBody(accepted.receipt(), accepted.submission().digest(), accepted.warnings(), false));
        }
        if (outcome instanceof SubmissionOutcome.Redelivered again) {
            return ReceiverAnswer.ok(receiptBody(again.receipt(), again.digest(), List.of(), true));
        }
        if (outcome instanceof SubmissionOutcome.Checked checked) {
            ObjectNode body = NODES.objectNode();
            body.put("accepted", checked.accepted());
            body.set("errors", wireErrors(checked.errors()));
            // Warnings and info ride in notes, left out when empty (the same body every host answers).
            if (!checked.notes().isEmpty()) {
                body.set("notes", wireNotes(checked.notes()));
            }
            return ReceiverAnswer.ok(body);
        }
        if (outcome instanceof SubmissionOutcome.DryRun dryRun) {
            return ReceiverAnswer.ok(dryRun.report());
        }
        throw refusal(outcome);
    }

    /** The exception the error mapper answers a refusal with: code for code what the service's outcome says. */
    private DatumException refusal(SubmissionOutcome outcome) {
        if (outcome instanceof SubmissionOutcome.Rejected rejected) {
            return new SubmissionRejectedException(rejected.stage(), rejected.errors());
        }
        if (outcome instanceof SubmissionOutcome.Outdated outdated) {
            return new SubmissionOutdatedException(outdated.currentSha256());
        }
        if (outcome instanceof SubmissionOutcome.NotFound) {
            return new UnknownFormException();
        }
        if (outcome instanceof SubmissionOutcome.Malformed malformed) {
            return new BadRequestException(malformed.reason());
        }
        if (outcome instanceof SubmissionOutcome.KeyConflict) {
            return new DatumException(KEY_CONFLICT, 409, "This submission key was already used for a different submission: a new submit attempt carries a new key.");
        }
        if (outcome instanceof SubmissionOutcome.TooLarge tooLarge) {
            // Only when the service's cap is below this receiver's (an application's own service bean): the binding gives
            // both the same cap, and a body under it always measures under it as a tree.
            return JsonBodies.tooLarge(tooLarge.maxBytes());
        }
        if (outcome instanceof SubmissionOutcome.Refused refused) {
            PreCheckDecision.Reject reject = refused.decision();
            return new DatumException(reject.code(), statusOf(reject.code()), reject.message());
        }
        if (outcome instanceof SubmissionOutcome.Throttled throttled) {
            return new ThrottledException(throttled.retryAfter());
        }
        if (outcome instanceof SubmissionOutcome.Unavailable unavailable) {
            if (SubmissionService.VALIDATOR_UNAVAILABLE.equals(unavailable.code())) {
                return unavailable.cause() == null ? new ValidatorUnavailableException(unavailable.reason())
                    : new ValidatorUnavailableException(unavailable.reason(), unavailable.cause());
            }
            if (unavailable.cause() instanceof DatumException own && own.code().equals(unavailable.code())) {
                return own;
            }
            return new ProgramUnavailableException(unavailable.reason(), unavailable.cause());
        }
        throw new IllegalStateException("An outcome the receiver does not answer: " + outcome.getClass().getName());
    }

    /**
     * The 200 body of a delivery: the receipt body plus {@code handled} as packages/submissions {@code http-mapping.ts}
     * shapes it (false on a first delivery, true when the first receipt is answered again).
     */
    private static ObjectNode receiptBody(SubmissionReceipt receipt, String digest, List<SubmissionError> warnings, boolean handled) {
        ObjectNode answer = NODES.objectNode();
        answer.put("id", receipt.id());
        answer.put("reference", receipt.reference());
        answer.put("status", "accepted");
        answer.put("digest", digest);
        answer.put("handled", handled);
        if (receipt.receipt() != null && !receipt.receipt().isNull()) {
            answer.set("receipt", receipt.receipt().deepCopy());
        }
        if (!warnings.isEmpty()) {
            answer.set("warnings", wireErrors(warnings));
        }
        return answer;
    }

    /** The wire form of findings: field when the finding names one, code, and a message when a host gave one. */
    private static ArrayNode wireErrors(List<SubmissionError> errors) {
        ArrayNode list = NODES.arrayNode();
        for (SubmissionError error : errors) {
            ObjectNode entry = list.addObject();
            if (error.field() != null) {
                entry.put("field", error.field());
            }
            entry.put("code", error.code());
            if (error.message() != null) {
                entry.put("message", error.message());
            }
        }
        return list;
    }

    /** A check's notes: field when named, code, the severity that kept them from blocking, and a message when given. */
    private static ArrayNode wireNotes(List<SubmissionError> notes) {
        ArrayNode list = NODES.arrayNode();
        for (SubmissionError note : notes) {
            ObjectNode entry = list.addObject();
            if (note.field() != null) {
                entry.put("field", note.field());
            }
            entry.put("code", note.code());
            entry.put("severity", note.severity() == null ? "info" : note.severity());
            if (note.message() != null) {
                entry.put("message", note.message());
            }
        }
        return list;
    }

    private static String sha256(byte[] body) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }

    /**
     * Builds a receiver: over a {@link SubmissionService} ({@link #service}), or over the parts it is built from (the
     * setters below), never both.
     */
    public static final class Builder {

        private final SubmissionService.Builder parts = SubmissionService.builder();
        private boolean partsSet;
        private SubmissionService service;
        private DatumJsonMapper json;
        private long maxBodyBytes;
        private PreCheckStatuses preCheckStatuses;

        private Builder() {
        }

        /** The status of each pre-check refusal's code ({@link PreCheckStatuses#standard()} unless given). */
        public Builder preCheckStatuses(PreCheckStatuses preCheckStatuses) { this.preCheckStatuses = preCheckStatuses; return this; }

        /** The service the receiver hands every request to (the binding's bean, shared with other callers). */
        public Builder service(SubmissionService service) { this.service = service; return this; }
        public Builder json(DatumJsonMapper json) { this.json = json; return this; }
        /** The body cap in bytes, already clamped ({@code ProgramLimits.maxBodyBytes()}). */
        public Builder maxBodyBytes(long maxBodyBytes) { this.maxBodyBytes = maxBodyBytes; return this; }

        /** The sandbox service, asked once per request (it throws 503 while the runtime is down). */
        public Builder sandbox(Supplier<? extends Sandbox> sandbox) { parts.sandbox(sandbox); return part(); }
        /**
         * Where the current definition comes from: datum-forms' service, never the repository itself, so every
         * version a record names is snapshotted when first seen.
         */
        public Builder definitions(DefinitionService definitions) { parts.definitions(definitions); return part(); }
        public Builder dataSources(DataSourceOptions dataSources) { parts.dataSources(dataSources); return part(); }
        /** The host's translation catalogs, so a run carries them beside the definition's map (null: the host keeps none). */
        public Builder catalogs(TranslationCatalogStore catalogs) { parts.catalogs(catalogs); return part(); }
        /** {@code datum.host.unknown-fields}. */
        public Builder unknownFields(String unknownFields) { parts.unknownFields(unknownFields); return part(); }
        /** {@code datum.host.log-level}. */
        public Builder logLevel(String logLevel) { parts.logLevel(logLevel); return part(); }
        public Builder handler(SubmissionHandler handler) { parts.handler(handler); return part(); }
        /** The throttle, or null for none. */
        public Builder throttle(SubmissionThrottle throttle) { parts.throttle(throttle); return part(); }
        public Builder preChecks(List<SubmissionPreCheck> preChecks) { parts.preChecks(preChecks); return part(); }
        public Builder validators(List<SubmissionValidator> validators) { parts.validators(validators); return part(); }
        public Builder rulesProviders(List<SandboxRulesProvider> rulesProviders) { parts.rulesProviders(rulesProviders); return part(); }
        public Builder contributors(List<SandboxContextContributor> contributors) { parts.contributors(contributors); return part(); }
        public Builder customizers(List<HostOptionsCustomizer> customizers) { parts.customizers(customizers); return part(); }
        /** Where each run's {@code hostContext} comes from, or null (the default) for none. */
        public Builder hostContext(HostContextProvider hostContext) { parts.hostContext(hostContext); return part(); }
        /** The signature check, or null for none. */
        public Builder signatureCheck(SubmissionSignatureCheck signatureCheck) { parts.signatureCheck(signatureCheck); return part(); }
        /** The store of accepted documents; null (the default here) answers every delivery as a first one. */
        public Builder idempotency(SubmissionIdempotencyStore idempotency) { parts.idempotency(idempotency); return part(); }
        public Builder events(DatumEventPublisher events) { parts.events(events); return part(); }

        private Builder part() {
            partsSet = true;
            return this;
        }

        public SubmissionReceiver build() {
            if (service != null && partsSet) {
                // A part set beside a service would be silently unused: refuse rather than run without a hook.
                throw new IllegalStateException("Give the receiver a SubmissionService or the parts of one, not both.");
            }
            if (service == null && maxBodyBytes > 0) {
                // A service built of the parts holds a caller with no bytes to the same cap as the route's bytes.
                parts.maxDocumentBytes(maxBodyBytes);
            }
            return new SubmissionReceiver(service != null ? service : parts.build(), json, maxBodyBytes, preCheckStatuses);
        }
    }
}
