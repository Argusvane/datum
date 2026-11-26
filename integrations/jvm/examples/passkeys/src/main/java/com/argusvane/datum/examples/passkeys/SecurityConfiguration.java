package com.argusvane.datum.examples.passkeys;

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
 * Spring Security for the example: a form login, the cookie CSRF recipe the Datum glue reads
 * ({@code CookieCsrfTokenRepository.withHttpOnlyFalse()} writes {@code XSRF-TOKEN}, the page sends it back in
 * {@code X-XSRF-TOKEN}), and who may do what (framework-first: Datum ships no access policy).
 * The rules name Datum's routes through {@link DatumRequestMatchers}: anyone may read the form, submit,
 * check a page and reach the passkey endpoints, whose own rules then apply (only signed-in people sign here,
 * {@code signing.sign_in} while {@code datum.webauthn.anonymous} is off; nobody uses a form's Test context, since
 * {@code datum.webauthn.test-roles} names no role); nobody builds, reads a form's author copy, dry-runs or inspects.
 * On Datum's routes a refusal answers in the wire's JSON through {@link DatumSecurityResponses}, never a login page.
 * Only the account page asks for a sign-in. The principal Spring Security gives is the passkey's owner
 * ({@code SecurityPrincipalSubjectResolver}). Users are in memory: ada / ada and grace / grace.
 */
@Configuration(proxyBeanMethods = false)
public class SecurityConfiguration {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
        DatumSecurityRecipes recipes = responses.recipes();
        http
            .authorizeHttpRequests(requests -> requests
                .requestMatchers("/account.html").authenticated()
                .requestMatchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).denyAll()
                .requestMatchers(datum.formsRead(), datum.dataSources(), datum.submissions(), datum.validate(), datum.passkeys(),
                    datum.assets()).permitAll()
                .anyRequest().permitAll())
            // The cookie CSRF recipe the glue reads and the token cookie on every response: one line each.
            .csrf(recipes.csrfForGlue())
            .addFilterAfter(recipes.csrfCookieFilter(), CsrfFilter.class)
            .formLogin(login -> login.defaultSuccessUrl("/", false))
            .httpBasic(Customizer.withDefaults())
            .exceptionHandling(recipes.exceptionHandling(datum.all(), "Basic realm=\"Petition\""));
        return http.build();
    }

    @Bean
    UserDetailsService users() {
        return new InMemoryUserDetailsManager(
            User.withUsername("ada").password("{noop}ada").roles("USER").build(),
            User.withUsername("grace").password("{noop}grace").roles("USER").build());
    }
}
