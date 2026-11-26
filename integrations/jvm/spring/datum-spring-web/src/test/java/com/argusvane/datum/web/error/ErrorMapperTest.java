package com.argusvane.datum.web.error;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.spring.SpringFrameworkErrors;
import com.argusvane.datum.springweb.support.Failures;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.mock.http.MockHttpInputMessage;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The Spring half of the error mapper's tests: Spring's own request failures reach the codes
 * {@link ErrorMapper#forStatus} gives through {@link SpringFrameworkErrors}, and without the binding they are an
 * unknown failure. Datum's own codes, guest-text hiding, problem details and translators are tested without a
 * framework in datum-web-core's ErrorMapperTest.
 */
class ErrorMapperTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    /** The mapper as the Spring binding builds it: Spring's own request errors told apart by status. */
    private final ErrorMapper mapper = new ErrorMapper(false, List.of(), SpringFrameworkErrors.INSTANCE);

    private String code(ErrorResponse response) {
        JsonNode body = JSON.readTree(response.bodyBytes(JSON));
        return body.get("errors").get(0).get("code").asString();
    }

    @Test
    void springRequestErrorsUseTheSameShape() {
        ErrorResponse media = mapper.map(new HttpMediaTypeNotSupportedException(MediaType.TEXT_PLAIN, List.of(MediaType.APPLICATION_JSON)));
        assertThat(media.status()).isEqualTo(415);
        assertThat(code(media)).isEqualTo("unsupported_media_type");
        ErrorResponse method = mapper.map(new HttpRequestMethodNotSupportedException("PUT", List.of("GET")));
        assertThat(method.status()).isEqualTo(405);
        assertThat(code(method)).isEqualTo("method_not_allowed");
        assertThat(method.headers()).containsKey("Allow");
        assertThat(code(mapper.map(Failures.of("notFound")))).isEqualTo("not_found");
        assertThat(code(mapper.map(new HttpMessageNotReadableException("x", new MockHttpInputMessage(new byte[0]))))).isEqualTo("bad_document");
        // The binding's answers are the library's forStatus answers.
        assertThat(code(media)).isEqualTo(code(mapper.forStatus(415, java.util.Map.of())));
        assertThat(code(method)).isEqualTo(code(mapper.forStatus(405, java.util.Map.of())));
    }

    @Test
    void withoutTheBindingASpringExceptionIsInternal() {
        ErrorMapper library = new ErrorMapper(false, List.of());
        assertThat(library.map(new HttpRequestMethodNotSupportedException("PUT", List.of("GET"))).status()).isEqualTo(500);
    }

    /**
     * The correlation id the client gets in {@code X-Datum-Correlation-Id} is a field of the log entry too, so under a
     * structured log format (ecs, gelf, logstash) support finds the entry from what a user reports.
     */
    @Test
    void anUnhandledFailureLogsItsCorrelationIdAsAKeyValuePair() {
        ch.qos.logback.classic.Logger log = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger("datum.web");
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> events = new ch.qos.logback.core.read.ListAppender<>();
        events.start();
        log.addAppender(events);
        try {
            ErrorResponse response = mapper.map(new IllegalStateException("boom"));
            String id = response.headers().get("X-Datum-Correlation-Id");
            assertThat(id).isNotBlank();
            assertThat(events.list).anySatisfy(event -> {
                assertThat(event.getFormattedMessage()).contains("correlation id " + id);
                assertThat(event.getKeyValuePairs()).anySatisfy(pair -> {
                    assertThat(pair.key).isEqualTo("correlationId");
                    assertThat(pair.value).isEqualTo(id);
                });
            });
        } finally {
            log.detachAppender(events);
        }
    }
}
