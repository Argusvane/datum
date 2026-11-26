package com.argusvane.datum.springweb.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;

import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityRecipes;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseCookie;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.SecurityWebFiltersOrder;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.userdetails.MapReactiveUserDetailsService;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.test.web.reactive.server.EntityExchangeResult;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;
import tools.jackson.databind.json.JsonMapper;

/** The WebFlux twin of {@link MvcSecurityRecipesTest}: {@link DatumServerSecurityRecipes} in a {@code SecurityWebFilterChain}. */
@SpringBootTest(classes = WebFluxSecurityRecipesTest.App.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive", "datum.web.csrf.cookie-name=MY-TOKEN", "datum.web.csrf.header-name=X-MY-TOKEN"})
class WebFluxSecurityRecipesTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    @LocalServerPort
    int port;

    WebTestClient client;

    @BeforeEach
    void client() {
        client = WebTestClient.bindToServer().baseUrl("http://localhost:" + port).build();
    }

    private EntityExchangeResult<byte[]> send(HttpMethod method, String path, String user, String cookie, String header) {
        WebTestClient.RequestBodySpec request = client.method(method).uri(path);
        if (user != null) {
            request.headers(headers -> headers.setBasicAuth(user, user));
        }
        if (cookie != null) {
            request.cookie("MY-TOKEN", cookie);
        }
        if (header != null) {
            request.header("X-MY-TOKEN", header);
        }
        if (method == HttpMethod.PUT) {
            request.header("Content-Type", "application/json").bodyValue("{}");
        }
        return request.exchange().expectBody().returnResult();
    }

    @Test
    void theFirstResponseCarriesTheTokenCookieUnderTheConfiguredName() {
        EntityExchangeResult<byte[]> first = send(HttpMethod.GET, "/api/forms/intake/definition", null, null, null);
        ResponseCookie cookie = first.getResponseCookies().getFirst("MY-TOKEN");
        assertThat(cookie).as("the deferred token is loaded, so the cookie is written").isNotNull();
        assertThat(cookie.isHttpOnly()).isFalse();
    }

    @Test
    void aBuilderWriteNeedsTheTokenAndAMissingOneIsAccessDeniedJson() {
        String token = send(HttpMethod.GET, "/api/forms/intake/definition", null, null, null).getResponseCookies().getFirst("MY-TOKEN").getValue();

        EntityExchangeResult<byte[]> refused = send(HttpMethod.PUT, "/api/forms/intake", "editor", null, null);
        assertThat(refused.getStatus().value()).isEqualTo(403);
        assertThat(JSON.readTree(refused.getResponseBody()).path("errors").path(0).path("code").asString()).isEqualTo("access.denied");

        assertThat(send(HttpMethod.PUT, "/api/forms/intake", "editor", token, token).getStatus().value()).isEqualTo(200);
        assertThat(send(HttpMethod.GET, "/own/page", null, null, null).getStatus().value()).as("not a CSRF-protected route").isEqualTo(200);
    }

    @Test
    void datumsRoutesRefuseInTheWireShapeAndOthersKeepSpringsAnswers() {
        EntityExchangeResult<byte[]> unauthorized = send(HttpMethod.GET, "/api/forms/intake/definition?public=false", null, null, null);
        WebFluxSecurityTest.assertUnauthorized(unauthorized);
        EntityExchangeResult<byte[]> elsewhere = send(HttpMethod.GET, "/own/secret", null, null, null);
        assertThat(elsewhere.getStatus().value()).isEqualTo(401);
        byte[] body = elsewhere.getResponseBody();
        assertThat(body == null || body.length == 0).as("Spring Security's own answer, not Datum's JSON").isTrue();
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    @EnableWebFluxSecurity
    static class App {

        @Bean
        SecurityWebFilterChain chain(ServerHttpSecurity http, DatumExchangeMatchers datum, DatumServerSecurityResponses responses) {
            DatumServerSecurityRecipes recipes = responses.recipes();
            return http
                .authorizeExchange(exchanges -> exchanges
                    .matchers(datum.builderWrites(), datum.builderReads()).hasRole("EDITOR")
                    .pathMatchers("/own/secret").authenticated()
                    .anyExchange().permitAll())
                .csrf(recipes.csrfForGlue(datum.builderWrites()))
                .addFilterAfter(recipes.csrfCookieFilter(), SecurityWebFiltersOrder.CSRF)
                .httpBasic(Customizer.withDefaults())
                .exceptionHandling(recipes.exceptionHandling(datum.all(), "Basic realm=\"forms\""))
                .build();
        }

        @Bean
        MapReactiveUserDetailsService users() {
            return new MapReactiveUserDetailsService(User.withUsername("editor").password("{noop}editor").roles("EDITOR").build());
        }

        @Bean
        RouterFunction<ServerResponse> routes() {
            return route().GET("/api/forms/{key}/definition", request -> ServerResponse.ok().bodyValue("ok"))
                .GET("/own/page", request -> ServerResponse.ok().bodyValue("ok"))
                .GET("/own/secret", request -> ServerResponse.ok().bodyValue("ok"))
                .PUT("/api/forms/{key}", request -> ServerResponse.ok().bodyValue("ok")).build();
        }
    }
}
