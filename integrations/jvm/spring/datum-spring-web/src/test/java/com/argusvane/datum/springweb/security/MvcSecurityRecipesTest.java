package com.argusvane.datum.springweb.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityRecipes;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import jakarta.servlet.http.Cookie;
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
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The chain lines as recipes: the CSRF repository, handler and cookie filter the page glue
 * reads, and Datum's refusals on Datum's routes only, from {@link DatumSecurityRecipes}. The cookie and header names are
 * the configured {@code datum.web.csrf.*} ones, so a recipe cannot drift from what host.json tells the glue.
 */
@SpringBootTest(classes = MvcSecurityRecipesTest.App.class, properties = {"spring.main.web-application-type=servlet",
    "datum.web.csrf.cookie-name=MY-TOKEN", "datum.web.csrf.header-name=X-MY-TOKEN"})
@AutoConfigureMockMvc
class MvcSecurityRecipesTest {

    @Autowired
    MockMvc mvc;

    private MockHttpServletResponse send(org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request, String user) throws Exception {
        if (user != null) {
            request.header("Authorization", "Basic " + Base64.getEncoder().encodeToString((user + ":" + user).getBytes(StandardCharsets.UTF_8)));
        }
        return mvc.perform(request).andReturn().getResponse();
    }

    @Test
    void theFirstResponseCarriesTheTokenCookieUnderTheConfiguredName() throws Exception {
        MockHttpServletResponse first = send(MockMvcRequestBuilders.get("/api/forms/intake/definition"), null);
        assertThat(first.getStatus()).isEqualTo(200);
        Cookie token = first.getCookie("MY-TOKEN");
        assertThat(token).as("the deferred token is loaded, so the cookie is written").isNotNull();
        assertThat(token.isHttpOnly()).as("a script must read it").isFalse();
    }

    @Test
    void aWriteNeedsTheTokenInTheConfiguredHeaderAndAMissingOneIsAccessDeniedJson() throws Exception {
        String token = send(MockMvcRequestBuilders.get("/api/forms/intake/definition"), null).getCookie("MY-TOKEN").getValue();

        MockHttpServletResponse refused = send(MockMvcRequestBuilders.put("/api/forms/intake").contentType("application/json").content("{}"), "editor");
        assertThat(refused.getStatus()).isEqualTo(403);
        assertThat(MvcSecurityTest.code(refused)).isEqualTo("access.denied");

        MockHttpServletResponse allowed = send(MockMvcRequestBuilders.put("/api/forms/intake").contentType("application/json").content("{}")
            .cookie(new Cookie("MY-TOKEN", token)).header("X-MY-TOKEN", token), "editor");
        assertThat(allowed.getStatus()).isEqualTo(200);

        MockHttpServletResponse wrongHeader = send(MockMvcRequestBuilders.put("/api/forms/intake").contentType("application/json").content("{}")
            .cookie(new Cookie("MY-TOKEN", token)).header("X-XSRF-TOKEN", token), "editor");
        assertThat(wrongHeader.getStatus()).as("the default header name is not the configured one").isEqualTo(403);
    }

    @Test
    void datumsRoutesRefuseInTheWireShapeAndOthersKeepSpringsAnswers() throws Exception {
        MockHttpServletResponse unauthorized = send(MockMvcRequestBuilders.get("/api/forms/intake/definition?public=false"), null);
        MvcSecurityTest.assertUnauthorized(unauthorized);
        MockHttpServletResponse elsewhere = send(MockMvcRequestBuilders.get("/own/page"), null);
        assertThat(elsewhere.getStatus()).isEqualTo(401);
        assertThat(elsewhere.getContentAsByteArray()).as("Spring Security's own answer, not Datum's JSON").isEmpty();
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    @EnableWebSecurity
    @Import(App.Routes.class)
    static class App {

        @Bean
        SecurityFilterChain chain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
            DatumSecurityRecipes recipes = responses.recipes();
            http
                .authorizeHttpRequests(requests -> requests
                    .requestMatchers(datum.builderWrites(), datum.builderReads()).hasRole("EDITOR")
                    .requestMatchers("/own/**").authenticated()
                    .anyRequest().permitAll())
                .csrf(recipes.csrfForGlue())
                .addFilterAfter(recipes.csrfCookieFilter(), CsrfFilter.class)
                .httpBasic(Customizer.withDefaults())
                .exceptionHandling(recipes.exceptionHandling(datum.all(), "Basic realm=\"forms\""));
            return http.build();
        }

        @Bean
        UserDetailsService users() {
            return new InMemoryUserDetailsManager(User.withUsername("editor").password("{noop}editor").roles("EDITOR").build());
        }

        @RestController
        static class Routes {

            @GetMapping({"/api/forms/{key}/definition", "/own/page"})
            String read() {
                return "ok";
            }

            @PutMapping("/api/forms/{key}")
            String write() {
                return "ok";
            }

            @PostMapping("/api/forms")
            String create() {
                return "ok";
            }
        }
    }
}
