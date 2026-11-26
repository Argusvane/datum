package com.argusvane.datum.forms.web;

import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.forms.DataSourceNotFoundException;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FakeGuestRuntime;
import com.argusvane.datum.forms.Fixtures;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormStoreReadOnlyException;
import com.argusvane.datum.forms.SavedForm;
import com.argusvane.datum.forms.datasource.DataSourceProvider;
import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.ArrayList;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationResult;
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
 * What the web tests plug into the forms module: a fake sandbox runtime, an in-memory repository holding the
 * security suite's endpoint fixture (it has a server-secret rule) and a plain form, a data-source provider with a
 * good, a slow and a broken source, and the application's security (framework-first): a Spring Security
 * chain per stack written with datum-spring-web's matchers and JSON handlers, whose caller holds the authorities
 * {@code read}, {@code build} and {@code source} less those named in an {@code X-Deny} request header (the access
 * policy's operations of before, so the contract's refusals are the same requests and answers, now the chain's).
 */
@Configuration(proxyBeanMethods = false)
public class FormsTestBeans {

    public static final String SECRET_FORM = "endpoint";
    public static final String PLAIN_FORM = "plain";

    @Bean
    FakeGuestRuntime fakeGuestRuntime() {
        return new FakeGuestRuntime();
    }

    @Bean
    SandboxService testSandboxService(FakeGuestRuntime runtime) {
        return runtime.service();
    }

    /**
     * Stands in for the builder's auto-configuration, which this module's tests do not load: the author's copy is served
     * unless a test sets {@code forms-test.builder=false} to see the forms module on its own.
     */
    @Bean
    @org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty(name = "forms-test.builder", matchIfMissing = true)
    AuthorCopy testAuthorCopy() {
        return AuthorCopy.SERVED;
    }

    @Bean
    FormDefinitionRepository testRepository() {
        Map<String, ObjectNode> forms = new TreeMap<>();
        forms.put(SECRET_FORM, Fixtures.endpointFixture());
        ObjectNode plain = JsonNodeFactory.instance.objectNode();
        plain.put("id", PLAIN_FORM);
        plain.put("title", "A plain form");
        plain.putObject("root").put("id", "form").put("type", "form");
        forms.put(PLAIN_FORM, plain);
        return new FormDefinitionRepository() {
            @Override
            public Optional<ObjectNode> find(String key) {
                ObjectNode found = forms.get(key);
                return found == null ? Optional.empty() : Optional.of(found.deepCopy());
            }

            @Override
            public SavedForm save(ObjectNode definition) {
                throw new FormStoreReadOnlyException();
            }

            @Override
            public SavedForm save(ObjectNode definition, String expectedSha256) {
                throw new FormStoreReadOnlyException();
            }
        };
    }

    /** The caller of a request: every authority less the ones {@code X-Deny} names. */
    static Authentication caller(String denied) {
        List<String> authorities = new ArrayList<>(List.of("read", "build", "source"));
        if (denied != null) {
            authorities.removeAll(List.of(denied.split(",")));
        }
        return new TestingAuthenticationToken("tester", "n/a", authorities.toArray(String[]::new));
    }

    /** The per-form recipe: a data source's read reaches the form being filled through the request ({@code ?form=}). */
    static boolean mayReadSources(Authentication authentication, String form) {
        return !"locked".equals(form) && authentication.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("source"));
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @EnableWebSecurity
    static class ServletSecurity {

        @Bean
        SecurityFilterChain testChain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
            return http
                .authorizeHttpRequests(requests -> requests
                    .requestMatchers(datum.formsRead()).hasAuthority("read")
                    .requestMatchers(datum.builderReads()).hasAuthority("build")
                    .requestMatchers(datum.dataSources()).access((authentication, context) ->
                        new AuthorizationDecision(mayReadSources(authentication.get(), context.getRequest().getParameter("form"))))
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
                    .matchers(datum.formsRead()).hasAuthority("read")
                    .matchers(datum.builderReads()).hasAuthority("build")
                    .matchers(datum.dataSources()).access((authentication, context) -> authentication
                        .<AuthorizationResult>map(auth -> new AuthorizationDecision(
                            mayReadSources(auth, context.getExchange().getRequest().getQueryParams().getFirst("form"))))
                        .defaultIfEmpty(new AuthorizationDecision(false)))
                    .anyExchange().permitAll())
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .addFilterAt(caller, SecurityWebFiltersOrder.AUTHENTICATION)
                .exceptionHandling(exceptions -> exceptions.accessDeniedHandler(responses.accessDeniedHandler()))
                .build();
        }
    }

    @Bean
    DataSourceProvider testDataSources() {
        return new DataSourceProvider() {
            @Override
            public boolean exists(String id) {
                return List.of("colours", "slow", "broken").contains(id);
            }

            @Override
            public List<OptionItem> items(String id, String locale, Principal principal) {
                switch (id) {
                    case "slow" -> sleep();
                    case "broken" -> throw new IllegalStateException("the provider's own SECRET failure");
                    case "colours" -> {
                        return List.of(item("red", "Red [" + locale + "]"), item("blue", "Blue"));
                    }
                    default -> throw new DataSourceNotFoundException(id);
                }
                return List.of();
            }

            private void sleep() {
                try {
                    Thread.sleep(5_000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }

            private OptionItem item(String value, String label) {
                JsonNode text = JsonNodeFactory.instance.stringNode(label);
                return new OptionItem(value, text, null, null, null);
            }
        };
    }
}
