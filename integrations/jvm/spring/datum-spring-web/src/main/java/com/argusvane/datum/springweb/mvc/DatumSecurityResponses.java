package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import com.argusvane.datum.web.json.DatumJsonMapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Objects;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;

/**
 * Spring Security's two refusal hooks answering in the wire's shape on Datum's routes (framework-first):
 * an {@link AccessDeniedHandler} that writes 403 {@code access.denied} and an {@link AuthenticationEntryPoint} that
 * writes 401 {@code unauthorized} with the challenge the application names, both {@code no-store} JSON (or RFC 9457
 * problem details under {@code datum.web.api.problem-details}), the bodies {@link ErrorMapper} decides. The
 * application installs them in its own chain, for Datum's routes only, so its login page and its own routes keep
 * their behaviour:
 *
 * <pre>{@code
 * http.exceptionHandling(exceptions -> exceptions
 *     .defaultAuthenticationEntryPointFor(responses.authenticationEntryPoint("Basic realm=\"forms\""), datum.all())
 *     .defaultAccessDeniedHandlerFor(responses.accessDeniedHandler(), datum.all()));
 * }</pre>
 *
 * or, in one line, with {@link #recipes()}: {@code http.exceptionHandling(responses.recipes().exceptionHandling(datum.all(), "Basic realm=\"forms\""))}.
 *
 * Without them the refusals are Spring Security's own (a 401 or 403 with no body), which the wire allows too: the
 * kits accept either. A bean of this type exists when Spring Security is on the classpath of a servlet application.
 */
public final class DatumSecurityResponses {

    private final ErrorMapper errors;
    private final DatumJsonMapper json;
    private final WebSettings.Csrf csrf;

    /** With the default CSRF names, {@code XSRF-TOKEN} and {@code X-XSRF-TOKEN}. */
    public DatumSecurityResponses(ErrorMapper errors, DatumJsonMapper json) {
        this(errors, json, WebSettings.Csrf.defaults());
    }

    /** @param csrf the cookie and header names of {@code datum.web.csrf.*}, which {@link #recipes()} follows */
    public DatumSecurityResponses(ErrorMapper errors, DatumJsonMapper json, WebSettings.Csrf csrf) {
        this.errors = Objects.requireNonNull(errors, "errors");
        this.json = Objects.requireNonNull(json, "json");
        this.csrf = Objects.requireNonNull(csrf, "csrf");
    }

    /**
     * The chain lines every application writes the same way, as factories it calls from its own chain. Needs
     * spring-security-config on the class path, which any application with a {@code SecurityFilterChain} has; a new object
     * on each call, never a bean.
     */
    public DatumSecurityRecipes recipes() {
        return new DatumSecurityRecipes(this, csrf);
    }

    /** The 403 {@code access.denied} for a signed-in caller the chain refused (a CSRF refusal included). */
    public AccessDeniedHandler accessDeniedHandler() {
        return (request, response, denied) -> write(response, errors.accessDenied());
    }

    /**
     * The 401 {@code unauthorized} for a caller the chain wants signed in first.
     *
     * @param challenge the {@code WWW-Authenticate} value the application's sign-in uses ({@code Basic realm="forms"},
     *                  {@code Bearer}), or null for none
     */
    public AuthenticationEntryPoint authenticationEntryPoint(String challenge) {
        ErrorResponse answer = errors.unauthorized(challenge);
        return (request, response, failure) -> write(response, answer);
    }

    private void write(HttpServletResponse response, ErrorResponse answer) throws IOException {
        if (response.isCommitted()) {
            return;
        }
        response.setStatus(answer.status());
        answer.headers().forEach(response::setHeader);
        response.setContentType(answer.contentType());
        byte[] body = answer.bodyBytes(json.mapper());
        response.setContentLength(body.length);
        response.getOutputStream().write(body);
        response.flushBuffer();
    }
}
