package com.argusvane.datum.springweb.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Access is the application's security (framework-first): an MVC application secures Datum's routes with
 * {@link DatumRequestMatchers} and installs {@link DatumSecurityResponses}, and the refusals keep the wire's shape
 * (401 {@code unauthorized} with the configured challenge, 403 {@code access.denied}, both no-store JSON). The routes
 * here are stand-ins that answer 200, so every refusal seen is the filter chain's. The API lives at a configured
 * path, so the matchers are shown to follow it; the per-form recipe reads the {@code key} path variable through
 * {@code RequestAuthorizationContext}.
 */
@SpringBootTest(classes = MvcSecurityTest.SecuredApp.class, properties = {"spring.main.web-application-type=servlet",
    "datum.web.api.path=/forms-api"})
@AutoConfigureMockMvc
class MvcSecurityTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Autowired
    MockMvc mvc;

    @Test
    void thePublicCopyIsOpenAndTheAuthorsCopyIsTheBuilders() {
        assertThat(send(get("/forms-api/forms/intake/definition"), null).getStatus()).isEqualTo(200);
        assertThat(send(get("/forms-api/forms/intake/definition?public=true"), null).getStatus()).isEqualTo(200);
        assertThat(send(get("/forms-api/forms/intake/translations"), null).getStatus()).isEqualTo(200);

        MockHttpServletResponse anonymous = send(get("/forms-api/forms/intake/definition?public=false"), null);
        assertUnauthorized(anonymous);
        assertDenied(send(get("/forms-api/forms/intake/definition?public=false"), "viewer"));
        assertDenied(send(get("/forms-api/forms/intake/definition?public=true&public=false"), "viewer"));
        assertDenied(send(get("/forms-api/forms/intake/definition?public=%66alse"), "viewer"));
        assertThat(send(get("/forms-api/forms/intake/definition?public=false"), "editor").getStatus()).isEqualTo(200);
        assertUnauthorizedHead(send(MockMvcRequestBuilders.head(URI.create("/forms-api/forms/intake/definition?public=false")), null));
    }

    @Test
    void theBuildersWritesNeedTheRole() {
        assertUnauthorized(send(put("/forms-api/forms/intake"), null));
        assertDenied(send(put("/forms-api/forms/intake"), "viewer"));
        assertDenied(send(MockMvcRequestBuilders.post(URI.create("/forms-api/forms")).contentType("application/json").content("{}"), "viewer"));
        assertThat(send(put("/forms-api/forms/intake"), "editor").getStatus()).isEqualTo(200);
        assertThat(send(put("/forms-api/forms/intake/translations"), "editor").getStatus()).isEqualTo(200);
    }

    @Test
    void thePerFormRecipeReadsTheKeyPathVariable() {
        assertThat(send(get("/forms-api/data-sources/countries"), "viewer").getStatus()).isEqualTo(200);
        assertDenied(send(get("/forms-api/data-sources/salaries"), "viewer"));
        assertThat(send(get("/forms-api/data-sources/salaries"), "editor").getStatus()).isEqualTo(200);
    }

    @Test
    void theOldPathsAreNotDatumsAnyMore() {
        // datum.web.api.path moved the API: /api/... is the application's own (anyRequest().permitAll() here).
        assertThat(send(put("/api/forms/intake"), null).getStatus()).isNotIn(401, 403);
    }

    private static MockHttpServletRequestBuilder get(String path) {
        return MockMvcRequestBuilders.request(HttpMethod.GET, URI.create(path));
    }

    private static MockHttpServletRequestBuilder put(String path) {
        return MockMvcRequestBuilders.put(URI.create(path)).contentType("application/json").content("{}");
    }

    private MockHttpServletResponse send(MockHttpServletRequestBuilder request, String user) {
        if (user != null) {
            request.header("Authorization", "Basic " + Base64.getEncoder().encodeToString((user + ":" + user).getBytes(StandardCharsets.UTF_8)));
        }
        try {
            return mvc.perform(request).andReturn().getResponse();
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    /** The 401 with its JSON body, which every method but {@code HEAD} must carry. */
    static void assertUnauthorized(MockHttpServletResponse response) {
        assertUnauthorizedHead(response);
        assertThat(response.getContentAsByteArray()).as("the 401's JSON body").isNotEmpty();
        assertThat(response.getContentType()).startsWith("application/json");
        assertThat(code(response)).isEqualTo("unauthorized");
    }

    /** The 401's status and headers: a {@code HEAD} answer may carry no body. */
    static void assertUnauthorizedHead(MockHttpServletResponse response) {
        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(response.getHeader("WWW-Authenticate")).isEqualTo("Basic realm=\"forms\"");
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
    }

    static void assertDenied(MockHttpServletResponse response) {
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(response.getContentType()).startsWith("application/json");
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertThat(code(response)).isEqualTo("access.denied");
    }

    static String code(MockHttpServletResponse response) {
        JsonNode body = JSON.readTree(response.getContentAsByteArray());
        return body.path("errors").path(0).path("code").asString();
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    @EnableWebSecurity
    @Import(SecuredApp.Routes.class)
    static class SecuredApp {

        /** The recommended recipe: one rule per capability, the JSON handlers on Datum's routes only. */
        @Bean
        SecurityFilterChain chain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
            http
                .authorizeHttpRequests(requests -> requests
                    .requestMatchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole("EDITOR")
                    .requestMatchers(datum.dataSources()).access((authentication, context) -> new AuthorizationDecision(
                        !"salaries".equals(context.getVariables().get("id"))
                            || authentication.get().getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_EDITOR"))))
                    .requestMatchers(datum.formsRead(), datum.submissions(), datum.validate()).permitAll()
                    .anyRequest().permitAll())
                .csrf(csrf -> csrf.disable())
                .httpBasic(Customizer.withDefaults())
                .exceptionHandling(exceptions -> exceptions
                    .defaultAuthenticationEntryPointFor(responses.authenticationEntryPoint("Basic realm=\"forms\""), datum.all())
                    .defaultAccessDeniedHandlerFor(responses.accessDeniedHandler(), datum.all()));
            return http.build();
        }

        @Bean
        UserDetailsService users() {
            return new InMemoryUserDetailsManager(User.withUsername("editor").password("{noop}editor").roles("EDITOR").build(),
                User.withUsername("viewer").password("{noop}viewer").roles("USER").build());
        }

        /** Stand-ins for Datum's routes under /forms-api, answering 200. */
        @RestController
        static class Routes {

            @GetMapping({"/forms-api/forms/{key}/definition", "/forms-api/forms/{key}/translations", "/forms-api/data-sources/{id}"})
            String read(@PathVariable(required = false) String key) {
                return "ok";
            }

            @PutMapping({"/forms-api/forms/{key}", "/forms-api/forms/{key}/translations", "/api/forms/{key}"})
            String write() {
                return "ok";
            }

            @PostMapping("/forms-api/forms")
            String create() {
                return "ok";
            }
        }
    }
}
