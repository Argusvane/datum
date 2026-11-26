package com.argusvane.datum.springweb.webflux;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/**
 * The route registry and the method rules are Spring's own {@code PathPattern}s over the request's path (framework-first): what these tests hold is Datum's use of
 * them, the scope of the WebFlux exception handler and the {@code Allow} value of a 405.
 */
class DatumRouteScopeTest {

    @Test
    void theRegistryScopesTheHandlerToRegisteredPatterns() {
        DatumRouteRegistry routes = new DatumRouteRegistry().register("/api/forms/**", "/datum/assets/**", "/api/forms/{key}/definition");
        assertThat(routes.matches("/api/forms/x/definition")).isTrue();
        assertThat(routes.matches("/datum/assets/abc/datum-form.js")).isTrue();
        assertThat(routes.matches("/datum/assets")).as("** also matches the base itself").isTrue();
        assertThat(routes.matches("/api/other")).isFalse();
        assertThat(routes.matches("/api/formsx/a")).isFalse();
        assertThat(routes.matches("/app/boom")).as("the application's own routes are not Datum's").isFalse();
        assertThat(routes.patterns()).containsExactly("/api/forms/**", "/datum/assets/**", "/api/forms/{key}/definition");
    }

    @Test
    void aTrailingSlashIsSignificant() {
        DatumRouteRegistry routes = new DatumRouteRegistry().register("/api/forms/{key}/definition", "/api/pdf");
        assertThat(routes.matches("/api/pdf")).isTrue();
        assertThat(routes.matches("/api/pdf/")).isFalse();
        assertThat(routes.matches("/api/forms/x/definition/")).isFalse();
    }

    @Test
    void anUnsupportedPatternIsRefusedWhenRegistered() {
        assertThatThrownBy(() -> new DatumRouteRegistry().register("/api/**/x")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theRulesGiveTheUnionOfMethodsInAFixedOrder() {
        DatumMethodRules rules = new DatumMethodRules().allow("/api/forms/{key}", "PUT").allow("/api/forms/{key}", "GET", "HEAD", "OPTIONS");
        assertThat(rules.knows("/api/forms/intake")).isTrue();
        assertThat(rules.allowed("/api/forms/intake")).containsExactly("GET", "HEAD", "PUT", "OPTIONS");
        assertThat(rules.allowed("/api/forms/")).isEmpty();
        assertThat(rules.knows("/api/other")).isFalse();
    }
}
