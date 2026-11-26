package com.argusvane.datum.submissions.web;

import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.protocol.Frame;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.sandbox.runtime.TestRuntime;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.PreCheckDecision;
import com.argusvane.datum.submissions.spi.SubmissionPreCheck;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import com.argusvane.datum.sandbox.wasi.GuestRun;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.ArrayList;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.SecurityWebFiltersOrder;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.context.SecurityContextImpl;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.WebFilter;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the web tests plug into the submissions module: a test runtime that also answers the kernel's inspect
 * ops, a handler that records, a throttle a test can close, and the application's security (framework-first):
 * a Spring Security chain per stack written with datum-spring-web's matchers and JSON handlers,
 * whose caller holds the authorities {@code submit}, {@code validate}, {@code test} and {@code build} less those
 * named in an {@code X-Deny} request header (the chain refuses them with a 403 {@code access.denied}). The caller is {@code tester}, or the name an
 * {@code X-User} header gives; a pre-check refuses the form {@code contact} to {@code outsider}, the per-form rule
 * (the form key is in the body). The forms come from {@code datum-test-forms/}
 * (set on the application).
 */
@Configuration(proxyBeanMethods = false)
public class WebTestBeans {

    /** The state a test reads and sets. */
    public static final class Probe {

        public final TestRuntime runtime = new TestRuntime();
        public final com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore remembered =
            new com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore(100);
        public final List<AcceptedSubmission> handled = new CopyOnWriteArrayList<>();
        public volatile Duration throttled;
        /** The address limit closed for this long, or null while it is open. */
        public volatile Duration addressThrottled;
        /** The addresses the address limit counted, and the per-form keys the throttle checked, in order. */
        public final List<String> addressesCounted = new CopyOnWriteArrayList<>();
        public final List<ThrottleKey> formsChecked = new CopyOnWriteArrayList<>();
        /** What the host context provider does: nothing (no context), the principal's role, or throw. */
        public volatile String hostContext = "off";
        /** The requests the host context provider was asked about. */
        public final List<com.argusvane.datum.submissions.spi.HostContextRequest> hostContextAsked = new CopyOnWriteArrayList<>();

        public void reset() {
            hostContext = "off";
            hostContextAsked.clear();
            runtime.outcome = TestRuntime::accepting;
            runtime.terminate = null;
            handled.clear();
            remembered.clear();
            throttled = null;
            addressThrottled = null;
            addressesCounted.clear();
            formsChecked.clear();
        }
    }

    /** Delegates to {@link TestRuntime} except for the inspect ops of the endpoint, which it answers itself. */
    static final class InspectingRuntime implements GuestRuntime {

        private final TestRuntime delegate;

        InspectingRuntime(TestRuntime delegate) {
            this.delegate = delegate;
        }

        /** The engine the delegate reports (read through GuestRuntime, never reflectively). */
        @Override
        public com.argusvane.datum.sandbox.wasi.EngineInfo engineInfo() {
            return delegate.engineInfo();
        }

        @Override
        public RunOutput run(GuestRun run) {
            byte[] stdin = run.stdinBytes();
            if (Program.Kind.of(run) == Program.Kind.SANDBOX) {
                String text = new String(stdin, StandardCharsets.UTF_8);
                try {
                    JsonNode body = StrictJson.decode(text.substring(33));
                    String op = body.path("op").asString("");
                    String id = body.path("definition").path("id").asString("");
                    if (("inspect".equals(op) || "public".equals(op)) && !"datum-abi-probe".equals(id)) {
                        if (delegate.terminate != null) {
                            // The host cancelled the run: the same cut-short run the delegate gives a validation.
                            String started = Frame.marker(text.substring(0, 32), "started") + "\n";
                            return new RunOutput(delegate.terminate, -1, started.getBytes(StandardCharsets.UTF_8), null, null);
                        }
                        if ("inspect-throws".equals(id)) {
                            // A kernel that refuses: a non-zero exit with a reason on stderr.
                            return RunOutput.exited(1, new byte[0], "abi_mismatch".getBytes(StandardCharsets.UTF_8));
                        }
                        ObjectNode answer = JsonNodeFactory.instance.objectNode();
                        answer.put("ok", true);
                        answer.put("op", op);
                        answer.put("inspected", id);
                        String nonce = text.substring(0, 32);
                        String framed = Frame.marker(nonce, "started") + "\n" + Frame.marker(nonce, "begin") + "\n"
                            + StrictJson.encode(answer) + "\n" + Frame.marker(nonce, "end") + "\n";
                        return RunOutput.exited(0, framed.getBytes(StandardCharsets.UTF_8), null);
                    }
                } catch (StrictJson.NotJsonException e) {
                    throw new AssertionError(e);
                }
            }
            return delegate.run(run);
        }
    }

    @Bean
    Probe probe() {
        return new Probe();
    }

    @Bean
    GuestRuntime testGuestRuntime(Probe probe) {
        return new InspectingRuntime(probe.runtime);
    }

    @Bean
    SubmissionHandler recordingHandler(Probe probe) {
        return submission -> {
            probe.handled.add(submission);
            return new SubmissionReceipt("id-" + probe.handled.size(), "CONTACT-" + probe.handled.size(),
                JsonNodeFactory.instance.objectNode().put("title", "Thanks"));
        };
    }

    /** The same documents across tests must be first deliveries again: the probe forgets them on reset. */
    @Bean
    com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore resettableIdempotency(Probe probe) {
        return probe.remembered;
    }

    @Bean
    SubmissionThrottle closableThrottle(Probe probe) {
        return new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(ThrottleKey key) {
                probe.formsChecked.add(key);
                Duration closed = probe.throttled;
                return closed == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(closed);
            }

            @Override
            public void record(ThrottleKey key) {
            }

            @Override
            public ThrottleDecision checkAddress(String address) {
                Duration closed = probe.addressThrottled;
                return closed == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(closed);
            }

            @Override
            public void recordAddress(String address) {
                probe.addressesCounted.add(address);
            }
        };
    }

    /**
     * One person may not use one form, whatever the route: the rule a {@code canSubmit(form, request)}
     * policy would answer, written as a pre-check reading the principal the route's security admitted.
     */
    @Bean
    SubmissionPreCheck outsiderMayNotUseContact() {
        return incoming -> incoming.principal() != null && "outsider".equals(incoming.principal().getName())
            && "contact".equals(incoming.formKey()) ? PreCheckDecision.Reject.of("access.denied")
            : incoming.principal() != null && "spammer".equals(incoming.principal().getName())
                ? new PreCheckDecision.Reject("spam.honeypot", "No.") : PreCheckDecision.ALLOW;
    }

    /**
     * The application's host context, worked out from the Spring Security principal the route's security
     * admitted, never from the body: {@code {"role": <the caller's name>}} while a test turns it on.
     */
    @Bean
    com.argusvane.datum.submissions.spi.HostContextProvider roleFromThePrincipal(Probe probe) {
        return request -> {
            probe.hostContextAsked.add(request);
            switch (probe.hostContext) {
                case "principal" -> {
                    if (request.submission().principal() instanceof Authentication auth) {
                        return java.util.Optional.of(java.util.Map.of("role", auth.getName()));
                    }
                    return java.util.Optional.empty();
                }
                case "throws" -> throw new IllegalStateException("the directory is down");
                default -> {
                    return java.util.Optional.empty();
                }
            }
        };
    }

    /** The application's status for its own refusal code: the binding hands it to the receiver. */
    @Bean
    com.argusvane.datum.submissions.receiver.PreCheckStatuses honeypotIs451() {
        return code -> code.equals("spam.honeypot") ? 451 : com.argusvane.datum.submissions.receiver.PreCheckStatuses.standard().statusOf(code);
    }

    /** The caller of a request: {@code X-User} (or {@code tester}) with every authority less the ones {@code X-Deny} names. */
    static Authentication caller(String user, String denied) {
        List<String> authorities = new ArrayList<>(List.of("submit", "validate", "test", "build"));
        if (denied != null) {
            authorities.removeAll(List.of(denied.split(",")));
        }
        return new TestingAuthenticationToken(user == null ? "tester" : user, "n/a", authorities.toArray(String[]::new));
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @EnableWebSecurity
    static class ServletSecurity {

        @Bean
        SecurityFilterChain testChain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
            return http
                .authorizeHttpRequests(requests -> requests
                    .requestMatchers(datum.submissions()).hasAuthority("submit")
                    .requestMatchers(datum.validate()).hasAuthority("validate")
                    .requestMatchers(datum.dryRun()).hasAuthority("test")
                    .requestMatchers(datum.inspect()).hasAuthority("build")
                    .anyRequest().permitAll())
                .csrf(csrf -> csrf.disable())
                .addFilterBefore(new OncePerRequestFilter() {
                    @Override
                    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                        throws jakarta.servlet.ServletException, java.io.IOException {
                        SecurityContextHolder.setContext(new SecurityContextImpl(caller(request.getHeader("X-User"), request.getHeader("X-Deny"))));
                        chain.doFilter(request, response);
                    }
                }, AuthorizationFilter.class)
                .exceptionHandling(exceptions -> exceptions.accessDeniedHandler(responses.accessDeniedHandler()))
                .build();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @EnableWebFluxSecurity
    static class ReactiveSecurity {

        @Bean
        SecurityWebFilterChain testChain(ServerHttpSecurity http, DatumExchangeMatchers datum, DatumServerSecurityResponses responses) {
            WebFilter caller = (exchange, chain) -> chain.filter(exchange)
                .contextWrite(ReactiveSecurityContextHolder.withAuthentication(caller(
                    exchange.getRequest().getHeaders().getFirst("X-User"), exchange.getRequest().getHeaders().getFirst("X-Deny"))));
            return http
                .authorizeExchange(exchanges -> exchanges
                    .matchers(datum.submissions()).hasAuthority("submit")
                    .matchers(datum.validate()).hasAuthority("validate")
                    .matchers(datum.dryRun()).hasAuthority("test")
                    .matchers(datum.inspect()).hasAuthority("build")
                    .anyExchange().permitAll())
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .addFilterAt(caller, SecurityWebFiltersOrder.AUTHENTICATION)
                .exceptionHandling(exceptions -> exceptions.accessDeniedHandler(responses.accessDeniedHandler()))
                .build();
        }
    }
}
