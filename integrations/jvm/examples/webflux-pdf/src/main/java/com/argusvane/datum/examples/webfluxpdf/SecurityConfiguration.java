package com.argusvane.datum.examples.webfluxpdf;

import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityRecipes;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authorization.AuthorizationResult;
import org.springframework.security.authorization.ReactiveAuthorizationManager;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.SecurityWebFiltersOrder;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.userdetails.MapReactiveUserDetailsService;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.web.server.DelegatingServerAuthenticationEntryPoint;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.security.web.server.authorization.AuthorizationContext;
import org.springframework.security.web.server.authorization.IpAddressReactiveAuthorizationManager;
import org.springframework.security.web.server.util.matcher.OrServerWebExchangeMatcher;
import org.springframework.security.web.server.util.matcher.ServerWebExchangeMatchers;
import reactor.core.publisher.Mono;

/**
 * Spring Security for the example, WebFlux flavour of ui-builder-jpa's, and with it who may build (framework-first:
 * Datum ships no access policy). HTTP Basic identifies the author; the rules
 * name Datum's routes through {@link DatumExchangeMatchers}: the builder's writes, the author's copy of a definition,
 * the dry run and the kernel's inspection need {@code ROLE_FORM_ADMIN}. Datum's own default
 * would leave the builder open to everyone (and the start says so); an example that turns the builder on must not
 * teach that, so the rules are spelled out here. The timestamp server ({@code datum.tsa.access=open}, no client key to hand
 * out) answers loopback callers only, a rule of this chain like the others.
 *
 * <p>The public paths (the form, submissions, PDFs, receipts) are open. A refusal on a Datum route answers in the
 * wire's JSON through {@link DatumServerSecurityResponses}: 401 {@code unauthorized} with the Basic challenge for a
 * visitor, 403 {@code access.denied} for someone without the role or without the CSRF token, never a login page or
 * a plain-text page. CSRF is required only for the
 * builder's writes, the one place a browser's remembered Basic credentials could be replayed by another site; it
 * follows the recipe the Datum glue reads ({@code XSRF-TOKEN} cookie, {@code X-XSRF-TOKEN} header, plain handler so
 * the cookie's value is accepted as sent). Users are in memory: author / author is a form admin, viewer / viewer is not.
 */
@Configuration(proxyBeanMethods = false)
@EnableWebFluxSecurity
class SecurityConfiguration {

    private static final String CHALLENGE = "Basic realm=\"Datum forms\"";

    @Bean
    SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http, DatumExchangeMatchers datum, DatumServerSecurityResponses responses) {
        DatumServerSecurityRecipes recipes = responses.recipes();
        // CSRF on the builder's writes (POST /api/forms, PUT /api/forms/{key} and its translations), and on a DELETE
        // under /api/forms should the application add one.
        OrServerWebExchangeMatcher builderWrites = new OrServerWebExchangeMatcher(datum.builderWrites(),
            ServerWebExchangeMatchers.pathMatchers(HttpMethod.DELETE, "/api/forms/**"));
        return http
            .authorizeExchange(exchanges -> exchanges
                // The timestamp server answers callers on this machine only: access is the
                // chain's, the matcher follows datum.tsa.path, and the rule reads the socket's peer address.
                .matchers(datum.tsa()).access(loopbackOnly())
                .matchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole("FORM_ADMIN")
                .anyExchange().permitAll())
            // The glue's cookie CSRF recipe, required on the builder's writes only; WebFlux's CsrfSpec keeps its own
            // plain-text 403 unless it is given Datum's denied handler too, which the recipe does.
            .csrf(recipes.csrfForGlue(builderWrites))
            .addFilterAfter(recipes.csrfCookieFilter(), SecurityWebFiltersOrder.CSRF)
            .httpBasic(Customizer.withDefaults())
            .exceptionHandling(exceptions -> {
                recipes.exceptionHandling(datum.all(), CHALLENGE).customize(exceptions);
                // A remote caller of /tsa is anonymous, and Spring Security sends an anonymous refusal to the entry point (a
                // 401 asking for credentials that would not help): answer it as the 403 access.denied it is.
                exceptions.authenticationEntryPoint(new DelegatingServerAuthenticationEntryPoint(List.of(
                    new DelegatingServerAuthenticationEntryPoint.DelegateEntry(datum.tsa(),
                        (exchange, failure) -> responses.accessDeniedHandler().handle(exchange, new AccessDeniedException("This timestamp server answers callers on this machine only."))),
                    new DelegatingServerAuthenticationEntryPoint.DelegateEntry(datum.all(), responses.authenticationEntryPoint(CHALLENGE)))));
            })
            .build();
    }

    /**
     * Loopback callers only: Spring Security's own address managers for IPv4 and IPv6 loopback, either granting. The check
     * reads the socket's peer address, not {@code X-Forwarded-For}: behind a reverse proxy on the same host every request
     * looks local, so a deployment that sits behind one sets {@code datum.tsa.access=clients} instead and drops this rule.
     */
    static ReactiveAuthorizationManager<AuthorizationContext> loopbackOnly() {
        ReactiveAuthorizationManager<AuthorizationContext> ipv4 = IpAddressReactiveAuthorizationManager.hasIpAddress("127.0.0.0/8");
        ReactiveAuthorizationManager<AuthorizationContext> ipv6 = IpAddressReactiveAuthorizationManager.hasIpAddress("::1");
        return (authentication, context) -> ipv4.authorize(authentication, context).filter(AuthorizationResult::isGranted)
            .switchIfEmpty(Mono.defer(() -> ipv6.authorize(authentication, context)));
    }

    @Bean
    MapReactiveUserDetailsService users() {
        return new MapReactiveUserDetailsService(
            User.withUsername("author").password("{noop}author").roles("FORM_ADMIN").build(),
            User.withUsername("viewer").password("{noop}viewer").roles("USER").build());
    }
}
