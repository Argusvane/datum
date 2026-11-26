package com.argusvane.datum.examples.builderjpa;

import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityRecipes;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CsrfFilter;

/**
 * Spring Security for the example, and with it who may build (framework-first: Datum ships no access
 * policy). The rules name Datum's routes through {@link DatumRequestMatchers}, which follow the
 * configured paths: the builder's writes, the author's copy of a definition ({@code ?public=false}, server-secret
 * rules included), the dry run and the kernel's inspection need {@code ROLE_FORM_ADMIN}; filling,
 * checking and reading the public copy are open, as is everything else of this application but the builder page,
 * which asks for a sign-in.
 *
 * <p>On Datum's routes the refusals answer in the wire's shape through {@link DatumSecurityResponses}: a visitor gets
 * 401 {@code unauthorized} with the Basic challenge, a signed-in person without the role 403 {@code access.denied}
 * (a missing CSRF token is that 403 too), both JSON, never a login page. Elsewhere Spring Security's own answers
 * stand (the builder page redirects to the form login).
 *
 * <p>CSRF follows the recipe the Datum glue reads: {@code CookieCsrfTokenRepository.withHttpOnlyFalse()}
 * writes the token to the {@code XSRF-TOKEN} cookie, the page's script sends it back in {@code X-XSRF-TOKEN}
 * ({@code datum.web.csrf.*} names both, and host.json tells the glue). The plain request handler accepts the cookie's
 * value as sent (the masking handler would expect a masked token the page cannot compute), and a small filter makes
 * the deferred token write its cookie on every response, so the very first save of a page has one. Users are in
 * memory for the example: author / author is a form admin, viewer / viewer is not. HTTP Basic is on as well, for
 * scripts and the integration test.
 */
@Configuration(proxyBeanMethods = false)
public class SecurityConfiguration {

    static final String FORM_ADMIN = "FORM_ADMIN";

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
        DatumSecurityRecipes recipes = responses.recipes();
        http
            .authorizeHttpRequests(requests -> requests
                .requestMatchers("/builder", "/builder/**").authenticated()
                .requestMatchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole(FORM_ADMIN)
                .requestMatchers(datum.formsRead(), datum.dataSources(), datum.submissions(), datum.validate(), datum.assets()).permitAll()
                .anyRequest().permitAll())
            // The cookie CSRF recipe the glue reads and the token cookie on every response: one line each.
            .csrf(recipes.csrfForGlue())
            .addFilterAfter(recipes.csrfCookieFilter(), CsrfFilter.class)
            .formLogin(Customizer.withDefaults())
            .httpBasic(Customizer.withDefaults())
            .exceptionHandling(recipes.exceptionHandling(datum.all(), "Basic realm=\"Datum builder\""));
        return http.build();
    }

    @Bean
    UserDetailsService users() {
        return new InMemoryUserDetailsManager(
            User.withUsername("author").password("{noop}author").roles(FORM_ADMIN).build(),
            User.withUsername("viewer").password("{noop}viewer").roles("USER").build());
    }
}
