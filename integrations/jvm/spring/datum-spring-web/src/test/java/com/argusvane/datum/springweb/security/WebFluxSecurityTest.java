package com.argusvane.datum.springweb.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;

import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpMethod;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationResult;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.userdetails.MapReactiveUserDetailsService;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;
import tools.jackson.databind.json.JsonMapper;

/**
 * The WebFlux twin of {@link MvcSecurityTest}: {@link DatumExchangeMatchers} in a {@code SecurityWebFilterChain} with
 * {@link DatumServerSecurityResponses}, on a real server, the API at a configured path.
 */
@SpringBootTest(classes = WebFluxSecurityTest.SecuredApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive", "datum.web.api.path=/forms-api"})
class WebFluxSecurityTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    @LocalServerPort
    int port;

    WebTestClient client;

    @BeforeEach
    void client() {
        client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build();
    }

    @Test
    void thePublicCopyIsOpenAndTheAuthorsCopyIsTheBuilders() {
        assertThat(send(HttpMethod.GET, "/forms-api/forms/intake/definition", null).getStatus().value()).isEqualTo(200);
        assertThat(send(HttpMethod.GET, "/forms-api/forms/intake/definition?public=true", null).getStatus().value()).isEqualTo(200);
        assertUnauthorized(send(HttpMethod.GET, "/forms-api/forms/intake/definition?public=false", null));
        assertDenied(send(HttpMethod.GET, "/forms-api/forms/intake/definition?public=false", "viewer"));
        assertDenied(send(HttpMethod.GET, "/forms-api/forms/intake/definition?public=true&public=false", "viewer"));
        assertThat(send(HttpMethod.GET, "/forms-api/forms/intake/definition?public=false", "editor").getStatus().value()).isEqualTo(200);
        assertUnauthorizedHead(send(HttpMethod.HEAD, "/forms-api/forms/intake/definition?public=false", null));
    }

    @Test
    void theBuildersWritesNeedTheRole() {
        assertUnauthorized(send(HttpMethod.PUT, "/forms-api/forms/intake", null));
        assertDenied(send(HttpMethod.PUT, "/forms-api/forms/intake", "viewer"));
        assertDenied(send(HttpMethod.POST, "/forms-api/forms", "viewer"));
        assertThat(send(HttpMethod.PUT, "/forms-api/forms/intake", "editor").getStatus().value()).isEqualTo(200);
    }

    @Test
    void thePerFormRecipeReadsTheIdPathVariable() {
        assertThat(send(HttpMethod.GET, "/forms-api/data-sources/countries", "viewer").getStatus().value()).isEqualTo(200);
        assertDenied(send(HttpMethod.GET, "/forms-api/data-sources/salaries", "viewer"));
        assertThat(send(HttpMethod.GET, "/forms-api/data-sources/salaries", "editor").getStatus().value()).isEqualTo(200);
    }

    private EntityExchangeResult<byte[]> send(HttpMethod method, String path, String user) {
        WebTestClient.RequestBodySpec request = client.method(method).uri(path);
        if (user != null) {
            request.headers(headers -> headers.setBasicAuth(user, user));
        }
        if (method == HttpMethod.PUT || method == HttpMethod.POST) {
            request.header("Content-Type", "application/json").bodyValue("{}");
        }
        return request.exchange().expectBody().returnResult();
    }

    /** The 401 with its JSON body, which every method but {@code HEAD} must carry. */
    static void assertUnauthorized(EntityExchangeResult<byte[]> result) {
        assertUnauthorizedHead(result);
        byte[] body = result.getResponseBody();
        assertThat(body).as("the 401's JSON body").isNotNull().isNotEmpty();
        assertThat(result.getResponseHeaders().getContentType().toString()).startsWith("application/json");
        assertThat(JSON.readTree(body).path("errors").path(0).path("code").asString()).isEqualTo("unauthorized");
    }

    /** The 401's status and headers: a {@code HEAD} answer carries no body. */
    static void assertUnauthorizedHead(EntityExchangeResult<byte[]> result) {
        assertThat(result.getStatus().value()).isEqualTo(401);
        assertThat(result.getResponseHeaders().getFirst("WWW-Authenticate")).isEqualTo("Basic realm=\"forms\"");
        assertThat(result.getResponseHeaders().getFirst("Cache-Control")).contains("no-store");
    }

    static void assertDenied(EntityExchangeResult<byte[]> result) {
        assertThat(result.getStatus().value()).isEqualTo(403);
        assertThat(result.getResponseHeaders().getContentType().toString()).startsWith("application/json");
        assertThat(result.getResponseHeaders().getFirst("Cache-Control")).contains("no-store");
        assertThat(JSON.readTree(result.getResponseBody()).path("errors").path(0).path("code").asString()).isEqualTo("access.denied");
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    @EnableWebFluxSecurity
    static class SecuredApp {

        @Bean
        SecurityWebFilterChain chain(ServerHttpSecurity http, DatumExchangeMatchers datum, DatumServerSecurityResponses responses) {
            return http
                .authorizeExchange(exchanges -> exchanges
                    .matchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole("EDITOR")
                    .matchers(datum.dataSources()).access((authentication, context) -> authentication
                        .<AuthorizationResult>map(auth -> new AuthorizationDecision(!"salaries".equals(context.getVariables().get("id"))
                            || auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_EDITOR"))))
                        .defaultIfEmpty(new AuthorizationDecision(false)))
                    .matchers(datum.formsRead(), datum.submissions(), datum.validate()).permitAll()
                    .anyExchange().permitAll())
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .httpBasic(Customizer.withDefaults())
                .exceptionHandling(exceptions -> exceptions
                    .authenticationEntryPoint(responses.authenticationEntryPoint("Basic realm=\"forms\""))
                    .accessDeniedHandler(responses.accessDeniedHandler()))
                .build();
        }

        @Bean
        MapReactiveUserDetailsService users() {
            return new MapReactiveUserDetailsService(User.withUsername("editor").password("{noop}editor").roles("EDITOR").build(),
                User.withUsername("viewer").password("{noop}viewer").roles("USER").build());
        }

        /** Stand-ins for Datum's routes under /forms-api, answering 200. */
        @Bean
        RouterFunction<ServerResponse> routes() {
            return route()
                .GET("/forms-api/forms/{key}/definition", request -> ServerResponse.ok().bodyValue("ok"))
                .GET("/forms-api/data-sources/{id}", request -> ServerResponse.ok().bodyValue("ok"))
                .PUT("/forms-api/forms/{key}", request -> ServerResponse.ok().bodyValue("ok"))
                .POST("/forms-api/forms", request -> ServerResponse.ok().bodyValue("ok"))
                .build();
        }
    }
}
