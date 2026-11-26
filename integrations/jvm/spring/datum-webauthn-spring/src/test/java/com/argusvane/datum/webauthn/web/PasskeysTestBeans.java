package com.argusvane.datum.webauthn.web;

import com.argusvane.datum.webauthn.events.PasskeyRegisteredEvent;
import com.argusvane.datum.webauthn.events.PasskeyRevokedEvent;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.Principal;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * What every web test adds to the application: a principal read from the {@code X-Test-User} header (no Spring
 * Security filter chain in these tests: the principal is a Spring Security authentication, as a chain would hand it
 * over, with {@code ROLE_TESTER} for {@code tester} and {@code admin}, which {@code datum.webauthn.test-roles=TESTER}
 * lets use the Test context), a throttle the tests switch, and the events. Who may reach the routes at all is the
 * application's security, not a policy here.
 */
@Configuration(proxyBeanMethods = false)
public class PasskeysTestBeans {

    /** The principal named by a header: an authenticated Spring Security token, the testers with ROLE_TESTER. */
    static Principal named(String name) {
        String role = name.equals("tester") || name.equals("admin") ? "ROLE_TESTER" : "ROLE_USER";
        return new TestingAuthenticationToken(name, "n/a", role);
    }

    /** The throttle tests switch on. */
    static final class SwitchedThrottle implements PasskeyThrottle {
        final AtomicReference<Duration> wait = new AtomicReference<>();
        final List<String> seen = new CopyOnWriteArrayList<>();
        /** The address limit closed for this long, or null while it is open; the addresses it counted. */
        final AtomicReference<Duration> addressWait = new AtomicReference<>();
        final List<String> addresses = new CopyOnWriteArrayList<>();

        @Override
        public Decision check(String ip, String formKey, String principal) {
            seen.add(formKey + "|" + principal);
            Duration refused = wait.get();
            return refused == null ? Decision.ALLOW : new Decision.Deny(refused);
        }

        @Override
        public Decision checkAddress(String ip) {
            Duration refused = addressWait.get();
            if (refused != null) {
                return new Decision.Deny(refused);
            }
            addresses.add(ip);
            return Decision.ALLOW;
        }
    }

    /** The events the module published. */
    static final class Events {
        final List<Object> all = new CopyOnWriteArrayList<>();

        @EventListener
        void registered(PasskeyRegisteredEvent event) {
            all.add(event);
        }

        @EventListener
        void revoked(PasskeyRevokedEvent event) {
            all.add(event);
        }
    }

    /**
     * The application's registration hooks, inert unless a test names them: the customizer refuses the user
     * {@code closed} at the challenge (403), fails for the user {@code hook-down} (500) and answers a conflict for the label
     * {@code tenant-conflict} at the registration (409); the validator refuses the label {@code policy-refuses} (422) and
     * fails for {@code policy-down} (500).
     */
    @Bean
    com.argusvane.datum.webauthn.RegistrationCustomizer tenantRegistrationPolicy() {
        return draft -> {
            String name = draft.asking().name();
            if ("closed".equals(name) && draft.step() == com.argusvane.datum.webauthn.RegistrationDraft.Step.CHALLENGE) {
                throw com.argusvane.datum.core.hooks.HookRefusedException.forbidden("tenant.closed", "Passkeys are closed for your organization.");
            }
            if ("hook-down".equals(name)) {
                throw new IllegalStateException("the tenant directory is down /secret/path");
            }
            if ("tenant-conflict".equals(draft.label()) && draft.step() == com.argusvane.datum.webauthn.RegistrationDraft.Step.REGISTER) {
                throw com.argusvane.datum.core.hooks.HookRefusedException.conflict("tenant.limit", "Your organization has its passkeys already.");
            }
        };
    }

    @Bean
    com.argusvane.datum.webauthn.RegistrationValidator authenticatorPolicy() {
        return (context, asking, passkey) -> {
            if ("policy-down".equals(passkey.label())) {
                throw new IllegalStateException("the AAGUID registry is down /secret/path");
            }
            return "policy-refuses".equals(passkey.label())
                ? List.of(com.argusvane.datum.core.hooks.HookProblem.at("aaguid", "passkey.aaguid", "This authenticator is not on the allow-list."),
                    com.argusvane.datum.core.hooks.HookProblem.of("passkey.attestation", "This attestation format is not accepted."))
                : List.of();
        };
    }

    @Bean
    SwitchedThrottle switchedThrottle() {
        return new SwitchedThrottle();
    }

    @Bean
    Events events() {
        return new Events();
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    static class Servlet {

        @Bean
        org.springframework.boot.web.servlet.FilterRegistrationBean<OncePerRequestFilter> testUserFilter() {
            org.springframework.boot.web.servlet.FilterRegistrationBean<OncePerRequestFilter> registration =
                new org.springframework.boot.web.servlet.FilterRegistrationBean<>(new OncePerRequestFilter() {
                    @Override
                    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                        throws ServletException, IOException {
                        String user = request.getHeader("X-Test-User");
                        chain.doFilter(user == null ? request : new HttpServletRequestWrapper(request) {
                            @Override
                            public Principal getUserPrincipal() {
                                return named(user);
                            }
                        }, response);
                    }
                });
            registration.setOrder(Integer.MIN_VALUE);
            return registration;
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    static class Reactive {

        @Bean
        WebFilter testUserFilter() {
            return new WebFilter() {
                @Override
                public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
                    String user = exchange.getRequest().getHeaders().getFirst("X-Test-User");
                    return chain.filter(user == null ? exchange : exchange.mutate().principal(Mono.just(named(user))).build());
                }
            };
        }
    }
}
