package com.argusvane.datum.web.error;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The error mapper as any host binding builds it, without a framework (so a build of this library proves its own codes): Datum's exceptions keep their wire codes, guest
 * text never leaks, and {@link ErrorMapper#forStatus} picks the code for a framework's own request failures. The
 * Spring binding keeps only the checks that Spring's exceptions reach the same answers.
 */
class ErrorMapperTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** The library's mapper: no framework errors told apart (a binding adds its own). */
    private final ErrorMapper mapper = new ErrorMapper(false, List.of());

    /** One exception per kind name (datum-spring-web's test Failures without its Spring kinds). */
    static RuntimeException failure(String kind) {
        return switch (kind) {
            case "tooLarge" -> new RequestTooLargeException(10, "The request body is larger than 10 bytes.");
            case "unavailable" -> new ProgramUnavailableException("internal runtime detail: /app/secret");
            case "tooDeep" -> new DefinitionTooDeepException(32, "The definition nests deeper than 32 levels.");
            case "busy" -> new SandboxException(Reason.BUSY, "all slots taken");
            case "interrupted" -> new SandboxException(Reason.INTERRUPTED, "cancelled");
            case "budget" -> new SandboxException(Reason.BUDGET, "ran too long", "SECRET GUEST STDERR");
            case "outcomeTooLarge" -> new SandboxException(Reason.OUTCOME_TOO_LARGE, "outcome");
            case "tooCostly" -> SandboxException.checkTooCostly(new SandboxException(Reason.BUDGET, "ran too long", "SECRET"));
            case "rejected" -> new Rejected();
            case "unknown" -> new IllegalStateException("secret detail the client must not see");
            default -> new IllegalArgumentException(kind);
        };
    }

    /** A capability-style exception: a 422 with field errors, a header and an extra body member. */
    static final class Rejected extends DatumException implements ErrorDetails {

        private static final long serialVersionUID = 1L;

        Rejected() {
            super("submission.rejected", 422, "rejected");
        }

        @Override
        public List<ErrorItem> errorItems() {
            return List.of(new ErrorItem("email", "required", null), new ErrorItem(null, "form.outdated", "Reload."));
        }

        @Override
        public Map<String, String> responseHeaders() {
            return Map.of("X-Test", "yes");
        }

        @Override
        public Map<String, Object> extraBody() {
            return Map.of("currentSha256", "abc");
        }
    }

    private JsonNode body(ErrorResponse response) {
        return JSON.readTree(response.bodyBytes(JSON));
    }

    private String code(ErrorResponse response) {
        return body(response).get("errors").get(0).get("code").asString();
    }

    /** A hook's refusal: its kind's status, one entry per problem with its field, no-store, and the code in problem details. */
    @Test
    void aHookRefusalAnswersItsKindWithEveryProblem() {
        ErrorResponse forbidden = mapper.map(com.argusvane.datum.core.hooks.HookRefusedException.forbidden("tenant.closed", "Closed."));
        assertThat(forbidden.status()).isEqualTo(403);
        assertThat(forbidden.headers()).containsEntry("Cache-Control", "no-store");
        assertThat(body(forbidden).toString()).isEqualTo("{\"errors\":[{\"code\":\"tenant.closed\",\"message\":\"Closed.\"}]}");

        ErrorResponse invalid = new ErrorMapper(true, List.of()).map(com.argusvane.datum.core.hooks.HookRefusedException.invalid(List.of(
            com.argusvane.datum.core.hooks.HookProblem.at("pages", "pdf.pages", "At most 2 pages."),
            com.argusvane.datum.core.hooks.HookProblem.of("pdf.size", null))));
        assertThat(invalid.status()).isEqualTo(422);
        JsonNode problem = body(invalid);
        assertThat(problem.get("code").asString()).isEqualTo("pdf.pages");
        assertThat(problem.get("errors").toString())
            .isEqualTo("[{\"field\":\"pages\",\"code\":\"pdf.pages\",\"message\":\"At most 2 pages.\"},{\"code\":\"pdf.size\"}]");
        assertThat(mapper.map(com.argusvane.datum.core.hooks.HookRefusedException.conflict("tenant.moved", null)).status()).isEqualTo(409);
    }

    /** One rule for every error body, problem details included: {@code field} is present only when the error names one. */
    @Test
    void fieldIsLeftOutOfEveryErrorEntryThatNamesNone() {
        ErrorMapper details = new ErrorMapper(true, List.of());
        for (ErrorMapper each : List.of(mapper, details)) {
            for (ErrorResponse answer : List.of(each.map(failure("busy")), each.map(failure("unknown")), each.map(failure("budget")),
                each.map(failure("tooDeep")), each.forStatus(404, Map.of()), each.accessDenied(), each.unauthorized(null), each.badDocument("no"))) {
                String text = new String(answer.bodyBytes(JSON));
                assertThat(text).as(text).doesNotContain("\"field\"");
            }
            JsonNode named = body(each.map(failure("rejected"))).get("errors");
            assertThat(named.get(0).get("field").asString()).isEqualTo("email");
            assertThat(named.get(1).has("field")).isFalse();
        }
    }

    /** {@code datum.web.api.busy-retry-after}: the busy answer's Retry-After is the configured whole seconds. */
    @Test
    void theBusyRetryAfterIsConfigurable() {
        ErrorMapper slow = new ErrorMapper(false, List.of(), ErrorMapper.FrameworkErrors.NONE, java.time.Duration.ofSeconds(30));
        assertThat(slow.map(failure("busy")).headers()).containsEntry("Retry-After", "30");
        assertThat(new ErrorMapper(false, List.of(), ErrorMapper.FrameworkErrors.NONE, null).map(failure("busy")).headers())
            .as("unset: 5 s").containsEntry("Retry-After", "5");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new ErrorMapper(false, List.of(), ErrorMapper.FrameworkErrors.NONE,
            java.time.Duration.ofMillis(400))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void sandboxBusyIs503WithRetryAfter() {
        ErrorResponse answer = mapper.map(failure("busy"));
        assertThat(answer.status()).isEqualTo(503);
        assertThat(answer.headers()).containsEntry("Retry-After", "5").containsEntry("Cache-Control", "no-store");
        JsonNode first = body(answer).get("errors").get(0);
        assertThat(first.get("code").asString()).isEqualTo("server.busy");
        assertThat(first.has("field")).as("a form-level error names no field, so the member is left out").isFalse();
        assertThat(first.get("message").asString()).contains("busy");
    }

    @Test
    void unavailableAndInterruptedAre503ServerUnavailable() {
        for (String kind : List.of("unavailable", "interrupted")) {
            ErrorResponse answer = mapper.map(failure(kind));
            assertThat(answer.status()).as(kind).isEqualTo(503);
            assertThat(code(answer)).isEqualTo("server.unavailable");
            // The runtime's own words stay in the log.
            assertThat(new String(answer.bodyBytes(JSON))).doesNotContain("secret").doesNotContain("cancelled");
        }
    }

    @Test
    void aFailedRunIs503WithoutAnyGuestTextOrRetryAfter() {
        // A run that gave no answer is the server's failure, never a judgement of the answers: 503, and only server.busy
        // carries Retry-After.
        ErrorResponse budget = mapper.map(failure("budget"));
        assertThat(budget.status()).isEqualTo(503);
        assertThat(budget.headers()).doesNotContainKey("Retry-After");
        assertThat(code(budget)).isEqualTo("wasm.execution_error");
        assertThat(body(budget).get("errors").get(0).has("message")).isFalse();
        assertThat(new String(budget.bodyBytes(JSON))).doesNotContain("SECRET");
        assertThat(code(mapper.map(failure("outcomeTooLarge")))).isEqualTo("outcome_too_large");
        assertThat(mapper.map(failure("outcomeTooLarge")).status()).isEqualTo(503);
        assertThat(mapper.map(failure("outcomeTooLarge")).headers()).doesNotContainKey("Retry-After");
        // The check's own verdict on the author's definition stays a 422.
        ErrorResponse costly = mapper.map(failure("tooCostly"));
        assertThat(costly.status()).isEqualTo(422);
        assertThat(code(costly)).isEqualTo("definition.tooCostly");
    }

    @Test
    void coreExceptionsKeepTheirWireCodes() {
        assertThat(mapper.map(failure("tooLarge")).status()).isEqualTo(413);
        assertThat(code(mapper.map(failure("tooLarge")))).isEqualTo("bad_document");
        assertThat(mapper.map(failure("tooDeep")).status()).isEqualTo(422);
        // A registered form too deep is the server's fault: 503, no Retry-After.
        ErrorResponse registered = mapper.map(DefinitionTooDeepException.registered(
            new DefinitionTooDeepException(32, "deep")));
        assertThat(registered.status()).isEqualTo(503);
        assertThat(code(registered)).isEqualTo("definition.tooDeep");
        assertThat(registered.headers()).doesNotContainKey("Retry-After");
        assertThat(code(mapper.map(failure("tooDeep")))).isEqualTo("definition.tooDeep");
        assertThat(mapper.map(new UnsupportedMediaTypeException()).status()).isEqualTo(415);
        assertThat(code(mapper.map(new UnsupportedMediaTypeException()))).isEqualTo("unsupported_media_type");
        assertThat(mapper.map(new BadRequestException("no")).status()).isEqualTo(400);
        assertThat(code(mapper.map(new BadRequestException("no")))).isEqualTo("bad_document");
    }

    @Test
    void errorDetailsCarryItemsHeadersAndExtraMembers() {
        ErrorResponse answer = mapper.map(failure("rejected"));
        assertThat(answer.status()).isEqualTo(422);
        assertThat(answer.headers()).containsEntry("X-Test", "yes");
        JsonNode body = body(answer);
        assertThat(body.get("errors")).hasSize(2);
        assertThat(body.get("errors").get(0).get("field").asString()).isEqualTo("email");
        assertThat(body.get("errors").get(1).get("message").asString()).isEqualTo("Reload.");
        assertThat(body.get("currentSha256").asString()).isEqualTo("abc");
    }

    /** The library alone knows no framework: a host binding names its exceptions' statuses, and forStatus picks the code. */
    @Test
    void forStatusPicksTheCodesAFrameworksOwnFailuresGet() {
        ErrorResponse method = mapper.forStatus(405, Map.of("allow", "GET, HEAD", "X-Other", "dropped"));
        assertThat(method.status()).isEqualTo(405);
        assertThat(code(method)).isEqualTo("method_not_allowed");
        assertThat(method.headers()).containsEntry("Allow", "GET, HEAD").doesNotContainKey("X-Other").containsEntry("Cache-Control", "no-store");
        ErrorResponse media = mapper.forStatus(415, Map.of("Accept", "application/json"));
        assertThat(code(media)).isEqualTo("unsupported_media_type");
        assertThat(body(media).get("errors").get(0).get("message").asString()).isEqualTo(new UnsupportedMediaTypeException().getMessage());
        assertThat(media.headers()).containsEntry("Accept", "application/json");
        assertThat(code(mapper.forStatus(406, Map.of()))).isEqualTo("not_acceptable");
        assertThat(code(mapper.forStatus(400, null))).isEqualTo("bad_request");
        assertThat(code(mapper.forStatus(401, Map.of()))).isEqualTo("unauthorized");
        assertThat(code(mapper.forStatus(403, Map.of()))).isEqualTo("forbidden");
        assertThat(code(mapper.forStatus(404, Map.of()))).isEqualTo("not_found");
        assertThat(code(mapper.forStatus(409, Map.of()))).isEqualTo("http.409");
        ErrorResponse unreadable = mapper.badDocument("The submission is not JSON.");
        assertThat(unreadable.status()).isEqualTo(400);
        assertThat(code(unreadable)).isEqualTo("bad_document");
    }

    /**
     * Access is the application's security (framework-first): a binding's AccessDeniedHandler and
     * AuthenticationEntryPoint answer the wire's two refusals through these, with no-store, and the 401 carries the
     * challenge the application configured (none when it gave none; a value that could split the header is refused).
     */
    @Test
    void theSecurityRefusalsAnswerTheWiresTwoShapes() {
        ErrorResponse denied = mapper.accessDenied();
        assertThat(denied.status()).isEqualTo(403);
        assertThat(code(denied)).isEqualTo("access.denied");
        assertThat(body(denied).get("errors").get(0).get("message").asString()).isNotBlank();
        assertThat(denied.headers()).containsEntry("Cache-Control", "no-store").doesNotContainKey("WWW-Authenticate");
        assertThat(denied.contentType()).isEqualTo(ErrorResponse.JSON);

        ErrorResponse unauthorized = mapper.unauthorized("Basic realm=\"datum\"");
        assertThat(unauthorized.status()).isEqualTo(401);
        assertThat(code(unauthorized)).isEqualTo("unauthorized");
        assertThat(unauthorized.headers()).containsEntry("WWW-Authenticate", "Basic realm=\"datum\"").containsEntry("Cache-Control", "no-store");
        assertThat(mapper.unauthorized(null).headers()).doesNotContainKey("WWW-Authenticate");
        assertThat(mapper.unauthorized("  ").headers()).doesNotContainKey("WWW-Authenticate");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> mapper.unauthorized("Basic\r\nSet-Cookie: x=1"))
            .isInstanceOf(IllegalArgumentException.class);

        ErrorMapper problems = new ErrorMapper(true, List.of());
        ErrorResponse problem = problems.accessDenied();
        assertThat(problem.contentType()).isEqualTo(ErrorResponse.PROBLEM_JSON);
        assertThat(body(problem).get("code").asString()).isEqualTo("access.denied");
        assertThat(body(problem).get("status").asInt()).isEqualTo(403);
        assertThat(body(problems.unauthorized("Bearer")).get("code").asString()).isEqualTo("unauthorized");
    }

    @Test
    void unknownExceptionsAre500InternalWithACorrelationIdAndNoMessage() {
        ErrorResponse answer = mapper.map(failure("unknown"));
        assertThat(answer.status()).isEqualTo(500);
        assertThat(code(answer)).isEqualTo("internal");
        assertThat(answer.headers().get(ErrorMapper.CORRELATION_HEADER)).hasSize(12);
        assertThat(new String(answer.bodyBytes(JSON))).doesNotContain("secret");
    }

    @Test
    void problemDetailsVariantCarriesTheSameCodes() {
        ErrorMapper problems = new ErrorMapper(true, List.of());
        ErrorResponse answer = problems.map(failure("busy"));
        assertThat(answer.contentType()).isEqualTo("application/problem+json");
        JsonNode body = body(answer);
        assertThat(body.get("type").asString()).isEqualTo("about:blank");
        assertThat(body.get("title").asString()).isEqualTo("Service Unavailable");
        assertThat(body.get("status").asInt()).isEqualTo(503);
        assertThat(body.get("code").asString()).isEqualTo("server.busy");
        assertThat(body.get("errors").get(0).get("code").asString()).isEqualTo("server.busy");
        assertThat(problems.map(failure("unknown")).headers()).containsKey(ErrorMapper.CORRELATION_HEADER);
        assertThat(body(problems.map(failure("unknown"))).has("correlationId")).isTrue();
    }

    @Test
    void translatorsAreAskedFirstAndABrokenOneFallsBackToInternal() {
        ErrorTranslator teapot = failure -> failure instanceof IllegalArgumentException
            ? Optional.of(new ErrorResponse(418, null, ErrorResponse.JSON, Map.of("errors", List.of())))
            : Optional.empty();
        assertThat(new ErrorMapper(false, List.of(teapot)).map(failure("other")).status()).isEqualTo(418);
        ErrorTranslator broken = failure -> {
            throw new IllegalStateException("translator bug");
        };
        assertThat(new ErrorMapper(false, List.of(broken)).map(failure("busy")).status()).isEqualTo(500);
    }
}
