package com.argusvane.datum.ui.builder;

import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.ArrayList;
import java.util.List;
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

/**
 * What the builder web tests plug in: the kernel stub as the sandbox, a writable repository in memory, and the
 * application's security (framework-first): a Spring Security chain per stack written with
 * datum-spring-web's matchers and JSON handlers, whose caller holds the authority {@code build} unless an
 * {@code X-Deny} header names it (the access policy's operation of before: the same requests, refused by the chain
 * with the same 403 {@code access.denied}). The forms module's own defaults (translation store, snapshot store,
 * definition service) stay the real ones.
 */
@Configuration(proxyBeanMethods = false)
public class BuilderTestBeans {

    @Bean
    KernelStub kernelStub() {
        return new KernelStub();
    }

    @Bean
    SandboxService testSandboxService(KernelStub kernel) {
        return kernel.service();
    }

    @Bean
    MemoryRepository testRepository() {
        return new MemoryRepository().seed(BuilderFixtures.base());
    }

    /** The caller of a request: {@code build} unless {@code X-Deny} names it. */
    static Authentication caller(String denied) {
        List<String> authorities = new ArrayList<>(List.of("build"));
        if (denied != null) {
            authorities.removeAll(List.of(denied.split(",")));
        }
        return new TestingAuthenticationToken("tester", "n/a", authorities.toArray(String[]::new));
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @EnableWebSecurity
    static class ServletSecurity {

        @Bean
        SecurityFilterChain testChain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
            return http
                .authorizeHttpRequests(requests -> requests
                    .requestMatchers(datum.builderWrites(), datum.builderReads()).hasAuthority("build")
                    .anyRequest().permitAll())
                .csrf(csrf -> csrf.disable())
                .addFilterBefore(new OncePerRequestFilter() {
                    @Override
                    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                        throws jakarta.servlet.ServletException, java.io.IOException {
                        SecurityContextHolder.setContext(new SecurityContextImpl(caller(request.getHeader("X-Deny"))));
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
                .contextWrite(ReactiveSecurityContextHolder.withAuthentication(caller(exchange.getRequest().getHeaders().getFirst("X-Deny"))));
            return http
                .authorizeExchange(exchanges -> exchanges
                    .matchers(datum.builderWrites(), datum.builderReads()).hasAuthority("build")
                    .anyExchange().permitAll())
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .addFilterAt(caller, SecurityWebFiltersOrder.AUTHENTICATION)
                .exceptionHandling(exceptions -> exceptions.accessDeniedHandler(responses.accessDeniedHandler()))
                .build();
        }
    }
}
