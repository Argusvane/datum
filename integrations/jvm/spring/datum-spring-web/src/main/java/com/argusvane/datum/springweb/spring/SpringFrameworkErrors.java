package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.http.HttpHeaders;
import org.springframework.http.converter.HttpMessageNotReadableException;

/**
 * Spring's own request errors for {@link ErrorMapper}, by status: an {@code ErrorResponse}
 * exception (a wrong method, an unsupported or unacceptable media type, a missing route) is answered with
 * {@link ErrorMapper#forStatus} and the {@code Allow}, {@code Accept} and {@code Retry-After} it carries; a body
 * the message converters could not read is 400 {@code bad_document}. The mapper picks every code; this class only
 * says which Spring exception is which status.
 */
public final class SpringFrameworkErrors implements ErrorMapper.FrameworkErrors {

    /** The one instance. */
    public static final SpringFrameworkErrors INSTANCE = new SpringFrameworkErrors();

    private static final List<String> CARRIED = List.of(HttpHeaders.ALLOW, HttpHeaders.ACCEPT, HttpHeaders.RETRY_AFTER);

    private SpringFrameworkErrors() {
    }

    @Override
    public Optional<ErrorResponse> map(Throwable failure, ErrorMapper mapper) {
        if (failure instanceof org.springframework.web.ErrorResponse framework) {
            Map<String, String> headers = new LinkedHashMap<>();
            HttpHeaders carried = framework.getHeaders();
            for (String name : CARRIED) {
                String value = carried.getFirst(name);
                if (value != null) {
                    headers.put(name, value);
                }
            }
            return Optional.of(mapper.forStatus(framework.getStatusCode().value(), headers, failure));
        }
        if (failure instanceof HttpMessageNotReadableException) {
            return Optional.of(mapper.badDocument("The submission is not JSON."));
        }
        return Optional.empty();
    }
}
