package com.argusvane.datum.submissions.web;

import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.submissions.receiver.ReceiverAnswer;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.receiver.UnknownFormException;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.json.JsonBodies;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The four submissions endpoints, written once for both web stacks (the MVC and
 * WebFlux classes only move bytes; a binding for another web stack would reuse this class).
 *
 * <p>The adapters read the body with the stack's reader ({@code MvcBodies}/{@code WebFluxBodies}: 415, then the
 * cap counted on the raw stream) and hand the bytes here with the request view. Every method blocks (the
 * sandbox runs for hundreds of milliseconds, a data source may take its timeout), so the WebFlux adapter calls
 * them on the elastic scheduler, never on the event loop. Failures are Datum exceptions; the adapters'
 * exception handlers turn them into the {@code errors} body.
 *
 * <p>{@link #submit}, {@link #validate} and {@link #test} are the receiver's own order of steps (415, the address
 * limit, cap, parse, per-form throttle, ...: see {@link SubmissionReceiver}); this class adds nothing before them, so the
 * order is the receiver's. An adapter calls {@link #admit} before it reads the body (415, then the address limit) and
 * the route's method after. {@link #inspect} is the operator's kernel inspection (endpoint catalog
 * {@code inspectDefinition}): the body is {@code {form}} (a form key; the current full definition is inspected) or
 * {@code {definition}} (an object), with {@code op} {@code inspect} (default) or {@code public}. A refused request
 * is parameter 400, then existence 404, the order datum-forms' read endpoints use. Who may call any of the four is
 * the application's security in front of the route (framework-first: {@code DatumRequestMatchers} on
 * Spring names {@code inspect()} apart, for operators only).
 */
public final class SubmissionsApi {

    private static final Set<String> INSPECT_OPS = Set.of("inspect", "public");
    private static final Map<String, String> JSON_HEADERS = Map.of("Cache-Control", "no-store");

    private final SubmissionReceiver receiver;
    private final Supplier<? extends Sandbox> sandbox;
    private final DefinitionService definitions;
    private final DatumJsonMapper json;
    private final long maxBodyBytes;

    public SubmissionsApi(SubmissionReceiver receiver, Supplier<? extends Sandbox> sandbox, DefinitionService definitions,
                          DatumJsonMapper json, long maxBodyBytes) {
        this.receiver = Objects.requireNonNull(receiver, "receiver");
        this.sandbox = Objects.requireNonNull(sandbox, "sandbox");
        this.definitions = Objects.requireNonNull(definitions, "definitions");
        this.json = Objects.requireNonNull(json, "json");
        this.maxBodyBytes = maxBodyBytes;
    }

    /** The cap an adapter reads the body under ({@code datum.web.api.max-body-size}, clamped). */
    public long maxBodyBytes() {
        return maxBodyBytes;
    }

    /**
     * What an adapter asks before it reads the body of {@link #submit}, {@link #validate} or {@link #test}: 415, then the
     * address limit (429 {@code flood}), so a body that never parses is still counted ({@link SubmissionReceiver#admit}).
     * {@link #inspect} is not counted by the throttle and has none.
     */
    public void admit(SubmissionMode mode, SubmissionRequest request) {
        receiver.admit(request, mode);
    }

    /** {@code POST /submissions}: a delivery; 200 {@code {id, reference, status, digest, receipt?, warnings?}}. */
    public SubmissionsReply submit(byte[] body, SubmissionRequest request) {
        return reply(receiver.submit(request, body));
    }

    /** {@code POST /submissions/validate}: a journey page's or journey's check; 200 {@code {accepted, errors, notes?}} (errors block, notes do not). */
    public SubmissionsReply validate(byte[] body, SubmissionRequest request) {
        return reply(receiver.validate(request, body));
    }

    /** {@code POST /submissions/test}: a dry run; 200 with the report, nothing stored or published. */
    public SubmissionsReply test(byte[] body, SubmissionRequest request) {
        return reply(receiver.test(request, body));
    }

    /**
     * {@code POST /inspect}: the kernel's {@code __datum_inspect} answer for a definition ({@code {ok: true, op,
     * ...}}); for operators (the application's security keeps everyone else off the route). A run that gives no
     * answer is a 503 ({@code wasm.execution_error}, {@code outcome_too_large}, {@code server.busy},
     * {@code server.unavailable}); a posted definition nested too deep is 422 {@code definition.tooDeep}, and a
     * registered form nested too deep is the same code as a 503.
     */
    public SubmissionsReply inspect(byte[] body, SubmissionRequest request) {
        JsonBodies.requireJson(request.contentType());
        if (body.length > maxBodyBytes) {
            throw JsonBodies.tooLarge(maxBodyBytes);
        }
        JsonNode parsed = JsonBodies.parse(json, body);
        if (!parsed.isObject()) {
            throw new BadRequestException("bad_request", "The request is an object with a form or a definition.");
        }
        JsonNode form = parsed.get("form");
        JsonNode definition = parsed.get("definition");
        if ((form == null) == (definition == null) || (form != null && !form.isString())
            || (definition != null && !definition.isObject())) {
            throw new BadRequestException("bad_request", "Name one form by key, or give one definition object.");
        }
        JsonNode opNode = parsed.get("op");
        if (opNode != null && (!opNode.isString() || !INSPECT_OPS.contains(opNode.stringValue()))) {
            throw new BadRequestException("bad_request", "The op is inspect or public.");
        }
        String op = opNode == null ? "inspect" : opNode.stringValue();
        String key = form == null ? null : form.stringValue();
        ObjectNode subject;
        if (key != null) {
            if (!FormKeys.isValid(key)) {
                throw new UnknownFormException();
            }
            subject = definitions.current(key).definition().deepCopy();
        } else {
            subject = ((ObjectNode) definition).deepCopy();
        }
        ObjectNode answer;
        try {
            answer = sandbox.get().inspect(op, subject);
        } catch (DefinitionTooDeepException deep) {
            // A definition the operator posted is theirs to flatten (422); a registered form is the server's own, so the
            // run that cannot start on it is the server's failure and no judgement of the caller's request (503).
            throw key != null ? DefinitionTooDeepException.registered(deep) : deep;
        }
        return new SubmissionsReply(200, JSON_HEADERS, json.mapper().writeValueAsBytes(answer));
    }

    private SubmissionsReply reply(ReceiverAnswer answer) {
        return new SubmissionsReply(answer.status(), JSON_HEADERS, json.mapper().writeValueAsBytes(answer.body()));
    }

    /** The media type every body is written with. */
    public static String contentType() {
        return "application/json";
    }
}
