package com.argusvane.datum.web.error;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The one place an exception becomes an HTTP answer, for both web stacks, with the codes the endpoint catalog lists
 * and {@code packages/submissions/src/http-mapping.ts} sends.
 *
 * <p>A {@link DatumException} answers with its own {@code code} and {@code httpStatus} (the sandbox reasons,
 * unavailable, too deep, too large already carry the wire values: {@code server.busy} 503 with
 * {@code Retry-After}, {@code server.unavailable} 503, and a run that gave no answer 503 too: {@code wasm.execution_error},
 * {@code outcome_too_large}, a registered form's {@code definition.tooDeep} (a caller's own definition too deep is
 * its 422), with no {@code Retry-After}, which only
 * {@code server.busy} carries; {@code bad_document} 413, ...). The web framework's own request errors map to
 * the same body shape by status ({@link #forStatus}: {@code unsupported_media_type} 415, {@code method_not_allowed}
 * 405 with {@code Allow}, ...), through the {@link FrameworkErrors} the binding passes in. Anything else is a 500
 * {@code internal}: the cause is logged with a correlation id, which the answer carries in
 * {@code X-Datum-Correlation-Id}, and the message never leaves the server.
 *
 * <p>Framework-free (integrations/jvm/README.md "Libraries and bindings"): no binding
 * picks a code, each only tells the mapper which of its exceptions is which status.
 *
 * <p>A hook's refusal ({@link HookRefusedException}) answers its kind's status (403, 409, 422) with one
 * entry per problem the hook named.
 *
 * <p>The body is {@code {errors:[{field, code, message?}]}}; with {@code datum.web.api.problem-details} it is an
 * RFC 9457 object carrying the same codes in {@code code} and {@code errors}.
 */
public final class ErrorMapper {

    /** The header a 500 names its log entry in. */
    public static final String CORRELATION_HEADER = "X-Datum-Correlation-Id";

    private static final Logger LOG = LoggerFactory.getLogger("datum.web");

    /** The {@code Retry-After} of a busy answer when none is configured: 5 seconds ({@code datum.web.api.busy-retry-after}). */
    private static final long DEFAULT_BUSY_RETRY_SECONDS = 5;

    private static final String RETRY_AFTER = "Retry-After";
    private static final String CACHE_CONTROL = "Cache-Control";
    private static final String WWW_AUTHENTICATE = "WWW-Authenticate";

    /** The application's security refused a signed-in caller. */
    public static final String ACCESS_DENIED = "access.denied";

    /** The application's security wants a sign-in first (also {@link #forStatus}'s code for a 401). */
    public static final String UNAUTHORIZED = "unauthorized";

    /** The framework headers a status answer keeps: {@code Allow} of a 405, {@code Accept} of a 415, {@code Retry-After}. */
    private static final List<String> FRAMEWORK_HEADERS = List.of("Allow", "Accept", RETRY_AFTER);

    /**
     * How a web binding tells its framework's own failures apart (a wrong method, an unsupported content type, an
     * unreadable body): it answers them through {@link ErrorMapper#forStatus} or {@link ErrorMapper#badDocument}, or
     * leaves the failure alone (empty) to become a 500.
     */
    @FunctionalInterface
    public interface FrameworkErrors {

        /** The framework's failure as an answer of {@code mapper}, or empty when it is not one of the framework's. */
        Optional<ErrorResponse> map(Throwable failure, ErrorMapper mapper);

        /** No framework: every non-Datum failure is a 500. */
        FrameworkErrors NONE = (failure, mapper) -> Optional.empty();
    }

    private final boolean problemDetails;
    private final List<ErrorTranslator> translators;
    private final FrameworkErrors framework;
    private final String busyRetryAfter;

    /** A mapper that knows no framework exception (each one is a 500). */
    public ErrorMapper(boolean problemDetails, List<ErrorTranslator> translators) {
        this(problemDetails, translators, FrameworkErrors.NONE);
    }

    /**
     * @param translators asked first, in order
     * @param framework   asked after the Datum exceptions, before a failure becomes a 500
     */
    public ErrorMapper(boolean problemDetails, List<ErrorTranslator> translators, FrameworkErrors framework) {
        this(problemDetails, translators, framework, null);
    }

    /**
     * @param busyRetryAfter the {@code Retry-After} of a {@code server.busy} answer (whole seconds, at least 1); null: 5 s
     *                       ({@code datum.web.api.busy-retry-after})
     */
    public ErrorMapper(boolean problemDetails, List<ErrorTranslator> translators, FrameworkErrors framework, java.time.@Nullable Duration busyRetryAfter) {
        long seconds = busyRetryAfter == null ? DEFAULT_BUSY_RETRY_SECONDS : busyRetryAfter.toSeconds();
        if (seconds < 1) {
            throw new IllegalArgumentException("The busy Retry-After must be at least one second, not " + busyRetryAfter + ".");
        }
        this.busyRetryAfter = Long.toString(seconds);
        this.problemDetails = problemDetails;
        this.translators = translators == null ? List.of() : List.copyOf(translators);
        this.framework = framework == null ? FrameworkErrors.NONE : framework;
    }

    /** The answer for {@code failure}. Never throws. */
    public ErrorResponse map(Throwable failure) {
        try {
            for (ErrorTranslator translator : translators) {
                Optional<ErrorResponse> answer = translator.translate(failure);
                if (answer.isPresent()) {
                    return answer.get();
                }
            }
            if (failure instanceof DatumException datum) {
                return fromDatum(datum);
            }
            Optional<ErrorResponse> known = framework.map(failure, this);
            if (known.isPresent()) {
                return known.get();
            }
            return internal(failure);
        } catch (RuntimeException broken) {
            LOG.error("The Datum error mapper itself failed.", broken);
            return internal(failure);
        }
    }

    private ErrorResponse fromDatum(DatumException failure) {
        int status = failure.httpStatus();
        Map<String, String> headers = new LinkedHashMap<>();
        List<ErrorItem> items = new ArrayList<>();
        Map<String, Object> extra = Map.of();
        if (failure instanceof ErrorDetails details) {
            items.addAll(details.errorItems());
            headers.putAll(details.responseHeaders());
            extra = details.extraBody();
        } else if (failure instanceof HookRefusedException refused) {
            // An application hook's refusal: one entry per problem it named, in its order, field included.
            for (HookProblem problem : refused.problems()) {
                items.add(new ErrorItem(problem.field(), problem.code(), problem.message()));
            }
        }
        if (items.isEmpty()) {
            items.add(new ErrorItem(null, failure.code(), messageOf(failure)));
        }
        if ("server.busy".equals(failure.code())) {
            headers.putIfAbsent(RETRY_AFTER, busyRetryAfter);
        }
        if (status >= 500) {
            // The answer says nothing about the cause; the log does. A sandbox's stderr is the runtime's to log.
            LOG.atWarn().addKeyValue("status", status).addKeyValue("code", failure.code())
                .log("Datum answered {} {}: {}", status, failure.code(), failure.getMessage(), failure.getCause());
        } else if (LOG.isDebugEnabled()) {
            LOG.debug("Datum answered {} {}: {}", status, failure.code(), failure.getMessage());
        }
        String detail = items.get(0).message() != null ? items.get(0).message() : items.get(0).code();
        return build(status, failure.code(), detail, items, headers, extra);
    }

    /** The text of the answer: host-worded for a client mistake, fixed for "try later", none for a guest's failure. */
    private static String messageOf(DatumException failure) {
        if (failure instanceof SandboxException) {
            return switch (failure.code()) {
                case "server.busy" -> "The site is busy checking other submissions. Try again in a moment.";
                case "server.unavailable" -> "Submissions cannot be checked right now. Try again later.";
                default -> null;
            };
        }
        return switch (failure.code()) {
            case "server.busy" -> "The site is busy checking other submissions. Try again in a moment.";
            case "server.unavailable" -> "Submissions cannot be checked right now. Try again later.";
            default -> failure.httpStatus() < 500 ? failure.getMessage() : null;
        };
    }

    /**
     * The answer for a request error the web framework raised itself, by its status: 415
     * {@code unsupported_media_type} (with the 415 text), 406 {@code not_acceptable}, 405
     * {@code method_not_allowed}, 400 {@code bad_request}, 404 {@code not_found}, 403 {@code forbidden}, 401
     * {@code unauthorized}, any other {@code http.<status>}. Of {@code headers}, {@code Allow}, {@code Accept} and
     * {@code Retry-After} are kept.
     *
     * @param headers the framework's response headers for the failure (names as written; may be empty)
     */
    public ErrorResponse forStatus(int status, @Nullable Map<String, String> headers) {
        return forStatus(status, headers, null);
    }

    /** As {@link #forStatus(int, Map)}, with the cause a 5xx is logged with. */
    public ErrorResponse forStatus(int status, @Nullable Map<String, String> headers, @Nullable Throwable cause) {
        String errorCode = switch (status) {
            case 415 -> UnsupportedMediaTypeException.CODE;
            case 406 -> "not_acceptable";
            case 405 -> "method_not_allowed";
            case 400 -> "bad_request";
            case 404 -> "not_found";
            case 403 -> "forbidden";
            case 401 -> UNAUTHORIZED;
            default -> "http." + status;
        };
        String message = status == 415 ? new UnsupportedMediaTypeException().getMessage() : null;
        Map<String, String> kept = new LinkedHashMap<>();
        if (headers != null) {
            for (String name : FRAMEWORK_HEADERS) {
                headers.forEach((key, value) -> {
                    if (key != null && value != null && key.equalsIgnoreCase(name) && !kept.containsKey(name)) {
                        kept.put(name, value);
                    }
                });
            }
        }
        if (status >= 500) {
            LOG.atWarn().addKeyValue("status", status).addKeyValue("code", errorCode).log("Datum answered {} {}", status, errorCode, cause);
        }
        List<ErrorItem> items = List.of(new ErrorItem(null, errorCode, message));
        return build(status, errorCode, message != null ? message : errorCode, items, kept, Map.of());
    }

    /**
     * The 403 {@code access.denied} the application's security answers on a Datum route (framework-first:
     * who may use a route is the framework's security, not Datum's; a binding's access-denied handler writes this so a
     * refusal keeps the wire's shape). The words are fixed: the handler never learns which rule refused.
     */
    public ErrorResponse accessDenied() {
        String message = "You may not do this.";
        return build(403, ACCESS_DENIED, message, List.of(new ErrorItem(null, ACCESS_DENIED, message)), Map.of(), Map.of());
    }

    /**
     * The 401 {@code unauthorized} the application's security answers on a Datum route when it needs a sign-in first,
     * with the challenge the application configured as {@code WWW-Authenticate} (RFC 9110 section 11.6.1; none when it
     * gave none or a blank one).
     *
     * @param challenge the {@code WWW-Authenticate} value ({@code Basic realm="forms"}, {@code Bearer}), or null
     * @throws IllegalArgumentException for a challenge holding a control character (it could split the header)
     */
    public ErrorResponse unauthorized(@Nullable String challenge) {
        Map<String, String> headers = new LinkedHashMap<>();
        if (challenge != null && !challenge.isBlank()) {
            if (challenge.chars().anyMatch(c -> c < 0x20 || c == 0x7f)) {
                throw new IllegalArgumentException("A WWW-Authenticate challenge holds no control character.");
            }
            headers.put(WWW_AUTHENTICATE, challenge.strip());
        }
        String message = "Sign in to do this.";
        return build(401, UNAUTHORIZED, message, List.of(new ErrorItem(null, UNAUTHORIZED, message)), headers, Map.of());
    }

    /** The 400 {@code bad_document} for a body the framework could not read as JSON. */
    public ErrorResponse badDocument(@Nullable String message) {
        return build(400, BadRequestException.BAD_DOCUMENT, message, List.of(), Map.of(), Map.of());
    }

    private ErrorResponse internal(Throwable failure) {
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        // The id the client gets in X-Datum-Correlation-Id is a field too, so support finds the entry from what a user reports.
        LOG.atError().addKeyValue("correlationId", id).log("Unhandled failure on a Datum route (correlation id {}).", id, failure);
        Map<String, String> headers = Map.of(CORRELATION_HEADER, id);
        Map<String, Object> extra = problemDetails ? Map.of("correlationId", id) : Map.of();
        return build(500, "internal", "internal", List.of(ErrorItem.of("internal")), headers, extra);
    }

    private ErrorResponse build(int status, String code, String detail, List<ErrorItem> items,
                                Map<String, String> headers, Map<String, Object> extra) {
        List<ErrorItem> entries = items.isEmpty() ? List.of(new ErrorItem(null, code, null)) : items;
        Map<String, String> sent = new LinkedHashMap<>(headers);
        sent.putIfAbsent(CACHE_CONTROL, "no-store");
        Map<String, Object> body = new LinkedHashMap<>();
        if (problemDetails) {
            String known = HttpReasons.of(status);
            body.put("type", "about:blank");
            body.put("title", known != null ? known : "Error");
            body.put("status", status);
            body.put("detail", detail);
            body.put("code", code);
        }
        body.put("errors", entries);
        for (Map.Entry<String, Object> member : extra.entrySet()) {
            body.putIfAbsent(member.getKey(), member.getValue());
        }
        return new ErrorResponse(status, sent, problemDetails ? ErrorResponse.PROBLEM_JSON : ErrorResponse.JSON, body);
    }
}
