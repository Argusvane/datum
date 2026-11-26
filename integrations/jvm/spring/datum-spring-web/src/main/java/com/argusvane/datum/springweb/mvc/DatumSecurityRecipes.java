package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.web.WebSettings;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Objects;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.CsrfConfigurer;
import org.springframework.security.config.annotation.web.configurers.ExceptionHandlingConfigurer;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The lines every application with a servlet security chain writes the same way, as opt-in factories the application
 * calls from its own chain. They are not beans and Datum publishes no
 * {@code Customizer<HttpSecurity>}: Spring Security applies every such bean to every {@code HttpSecurity}, which would
 * take the chain away from the application (framework-first). Get one from
 * {@link DatumSecurityResponses#recipes()}:
 *
 * <pre>{@code
 * DatumSecurityRecipes recipes = responses.recipes();
 * http
 *     .csrf(recipes.csrfForGlue())
 *     .addFilterAfter(recipes.csrfCookieFilter(), CsrfFilter.class)
 *     .exceptionHandling(recipes.exceptionHandling(datum.all(), "Basic realm=\"Datum forms\""));
 * }</pre>
 *
 * <p>The CSRF recipe is the one the page glue reads: the token in a cookie a script can read, sent back in a header, with
 * the plain request handler (Security's masking handler would expect a masked token the page cannot compute), and a filter
 * that loads the deferred token so the cookie is written on every response, the first save of a page included. Security's
 * {@code CsrfConfigurer.spa()} sets the first two but does not load the deferred token, so the filter stays. The cookie and
 * header names follow {@code datum.web.csrf.*}, the same settings host.json tells the glue.
 */
public final class DatumSecurityRecipes {

    private final DatumSecurityResponses responses;
    private final WebSettings.Csrf csrf;

    DatumSecurityRecipes(DatumSecurityResponses responses, WebSettings.Csrf csrf) {
        this.responses = Objects.requireNonNull(responses, "responses");
        this.csrf = Objects.requireNonNull(csrf, "csrf");
    }

    /**
     * Datum's refusals on Datum's routes only: 401 {@code unauthorized} with {@code challenge} where the chain wants a
     * sign-in, 403 {@code access.denied} where it refuses a signed-in caller (a missing CSRF token included), both in the
     * wire's JSON. Elsewhere Spring Security's own answers stand (a login page redirect, for one).
     *
     * @param routes usually {@code DatumRequestMatchers#all()}
     * @param challenge the {@code WWW-Authenticate} value the application's sign-in uses, or null for none
     */
    public Customizer<ExceptionHandlingConfigurer<HttpSecurity>> exceptionHandling(RequestMatcher routes, String challenge) {
        Objects.requireNonNull(routes, "routes");
        return exceptions -> exceptions
            .defaultAuthenticationEntryPointFor(responses.authenticationEntryPoint(challenge), routes)
            .defaultAccessDeniedHandlerFor(responses.accessDeniedHandler(), routes);
    }

    /** The CSRF token repository and request handler the page glue reads, named by {@code datum.web.csrf.*}. */
    public Customizer<CsrfConfigurer<HttpSecurity>> csrfForGlue() {
        return configurer -> {
            CookieCsrfTokenRepository repository = CookieCsrfTokenRepository.withHttpOnlyFalse();
            repository.setCookieName(csrf.cookieName());
            repository.setHeaderName(csrf.headerName());
            configurer.csrfTokenRepository(repository).csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler());
        };
    }

    /** Add it after {@code CsrfFilter}: it loads the deferred token so the repository writes its cookie on this response. */
    public OncePerRequestFilter csrfCookieFilter() {
        return new CsrfCookieFilter();
    }

    /** Loads the deferred CSRF token so the repository writes its cookie on this response. */
    static final class CsrfCookieFilter extends OncePerRequestFilter {

        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
            CsrfToken token = (CsrfToken) request.getAttribute(CsrfToken.class.getName());
            if (token != null) {
                token.getToken();
            }
            chain.doFilter(request, response);
        }
    }
}
